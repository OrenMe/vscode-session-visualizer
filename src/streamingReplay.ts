// streamingReplay.ts — Streaming mutation replay with turn-boundary detection.
// Emits SessionGraph patches as turns complete, enabling incremental rendering.

import * as fs from 'fs';
import * as readline from 'readline';
import { ISerializableChatData, MutationLogEntry } from './types';
import { SessionGraph, TurnNode } from './sessionIR';
import { buildTurnNode, buildSessionGraph } from './irBuilder';

// ---------------------------------------------------------------------------
// Mutation replay helpers (reused from jsonlReplay.ts inline to avoid
// circular dependencies; these are small pure functions)
// ---------------------------------------------------------------------------

function navigateTo(
  obj: Record<string, unknown>,
  keys: (string | number)[],
): { parent: Record<string, unknown> | unknown[]; lastKey: string | number } {
  let current: unknown = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (current === null || current === undefined) {
      throw new Error(`Cannot navigate path: null at key "${key}"`);
    }
    if (Array.isArray(current)) {
      current = current[key as number];
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[String(key)];
    } else {
      throw new Error(`Cannot navigate path: non-object at key "${key}"`);
    }
  }
  return {
    parent: current as Record<string, unknown> | unknown[],
    lastKey: keys[keys.length - 1],
  };
}

function setIn(obj: Record<string, unknown>, keys: (string | number)[], value: unknown): void {
  if (keys.length === 0) { return; }
  const { parent, lastKey } = navigateTo(obj, keys);
  if (Array.isArray(parent)) {
    parent[lastKey as number] = value;
  } else {
    (parent as Record<string, unknown>)[String(lastKey)] = value;
  }
}

function appendAt(
  obj: Record<string, unknown>,
  keys: (string | number)[],
  items: unknown[],
  spliceIndex?: number,
): void {
  if (keys.length === 0) { return; }
  let target: unknown;
  if (keys.length === 1) {
    target = Array.isArray(obj)
      ? obj[keys[0] as number]
      : obj[String(keys[0])];
  } else {
    const { parent, lastKey } = navigateTo(obj, keys);
    if (Array.isArray(parent)) {
      target = parent[lastKey as number];
    } else {
      target = (parent as Record<string, unknown>)[String(lastKey)];
    }
  }
  if (!Array.isArray(target)) {
    throw new Error('Cannot push: target at path is not an array');
  }
  if (typeof spliceIndex === 'number') {
    target.splice(spliceIndex);
  }
  target.push(...items);
}

function deleteAt(obj: Record<string, unknown>, keys: (string | number)[]): void {
  if (keys.length === 0) { return; }
  const { parent, lastKey } = navigateTo(obj, keys);
  if (Array.isArray(parent)) {
    parent.splice(lastKey as number, 1);
  } else {
    delete (parent as Record<string, unknown>)[String(lastKey)];
  }
}

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export interface StreamingSessionEvents {
  onTurnAdded?: (turn: TurnNode) => void;
  onTurnUpdated?: (turnIndex: number, turn: TurnNode) => void;
  onSessionMeta?: (graph: SessionGraph) => void;
  onComplete?: (graph: SessionGraph) => void;
  onError?: (error: Error) => void;
}

// ---------------------------------------------------------------------------
// StreamingSessionReplay
// ---------------------------------------------------------------------------

export class StreamingSessionReplay {
  private state: Record<string, unknown> | null = null;
  private emittedTurnCount = 0;
  private readonly events: StreamingSessionEvents;

  constructor(events: StreamingSessionEvents) {
    this.events = events;
  }

  /**
   * Replay a JSONL file in batch mode, emitting turn events as turns complete.
   * This enables progressive rendering even for existing files.
   */
  async replayFile(filePath: string): Promise<SessionGraph> {
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    let lineCount = 0;

    for await (let line of rl) {
      line = line.trim();
      if (line.length === 0) { continue; }
      lineCount++;

      if (lineCount % 1000 === 0) {
        // Yield to the event loop to keep the extension host responsive
        await new Promise(resolve => setTimeout(resolve, 0));
      }

      this.applyMutation(line);
    }

    // Final: emit any remaining turns that haven't been emitted yet
    this.flushRemainingTurns();

    const session = this.state as unknown as ISerializableChatData;
    const graph = buildSessionGraph(session);
    this.events.onComplete?.(graph);
    return graph;
  }

  /**
   * Apply a single JSONL mutation line and detect turn boundaries.
   */
  private applyMutation(line: string): void {
    let entry: MutationLogEntry;
    try {
      entry = JSON.parse(line) as MutationLogEntry;
    } catch {
      return; // Skip malformed lines
    }

    if (this.state === null) {
      if (entry.kind !== 0) {
        throw new Error(`Expected kind=0 (Initial) on first line, got kind=${entry.kind}`);
      }
      this.state = JSON.parse(JSON.stringify(entry.v)) as Record<string, unknown>;
      // Emit initial session meta
      this.emitSessionMeta();
      // Emit any turns already present in the initial snapshot
      this.emitNewTurns();
      return;
    }

    const keys = entry.k;

    switch (entry.kind) {
      case 0:
        // Secondary snapshot (log compaction)
        if (typeof entry.v === 'object' && entry.v !== null) {
          for (const key of Object.keys(this.state)) {
            delete this.state[key];
          }
          Object.assign(this.state, entry.v as Record<string, unknown>);
        }
        this.emitSessionMeta();
        this.emitNewTurns();
        break;
      case 1: // Set
        if (keys) {
          setIn(this.state, keys, entry.v);
          this.checkTurnBoundary(keys, entry.v);
        }
        break;
      case 2: // Push
        if (keys) {
          const items = Array.isArray(entry.v) ? entry.v : (entry.v !== undefined ? [entry.v] : []);
          if (items.length > 0 || typeof entry.i === 'number') {
            appendAt(this.state, keys, items, entry.i);
          }
          this.checkNewTurnPush(keys);
        }
        break;
      case 3: // Delete
        if (keys) {
          deleteAt(this.state, keys);
        }
        break;
    }
  }

  /**
   * Check if a Set mutation represents a turn completion boundary.
   * Turn completion is signaled by setting modelState on a request.
   */
  private checkTurnBoundary(
    keys: (string | number)[],
    value: unknown,
  ): void {
    // Look for mutations like ['requests', N, 'modelState'] or
    // ['requests', N, 'modelState', 'completedAt'] or ['requests', N, 'modelState', 'value']
    if (keys.length >= 3 && keys[0] === 'requests' && keys[2] === 'modelState') {
      const turnIndex = keys[1] as number;
      this.emitTurnUpdate(turnIndex);
    }
    // Also detect response array being set directly
    if (keys.length === 3 && keys[0] === 'requests' && keys[2] === 'response') {
      const turnIndex = keys[1] as number;
      this.emitTurnUpdate(turnIndex);
    }
  }

  /**
   * Check if a Push mutation adds a new turn (push to 'requests' array).
   */
  private checkNewTurnPush(keys: (string | number)[]): void {
    if (keys.length === 1 && keys[0] === 'requests') {
      this.emitNewTurns();
    }
    // Also check for response parts being pushed
    if (keys.length === 3 && keys[0] === 'requests' && keys[2] === 'response') {
      // A new response part was added; if the turn was previously emitted,
      // re-emit as update
      const turnIndex = keys[1] as number;
      if (turnIndex < this.emittedTurnCount) {
        this.emitTurnUpdate(turnIndex);
      }
    }
  }

  /**
   * Emit events for any new turns beyond what we've already emitted.
   */
  private emitNewTurns(): void {
    const session = this.state as unknown as ISerializableChatData;
    if (!session.requests) { return; }
    while (this.emittedTurnCount < session.requests.length) {
      const idx = this.emittedTurnCount;
      const turn = buildTurnNode(session.requests[idx], idx);
      this.events.onTurnAdded?.(turn);
      this.emittedTurnCount++;
    }
  }

  /**
   * Emit an update event for a previously-emitted turn.
   */
  private emitTurnUpdate(turnIndex: number): void {
    const session = this.state as unknown as ISerializableChatData;
    if (!session.requests || turnIndex >= session.requests.length) { return; }
    const turn = buildTurnNode(session.requests[turnIndex], turnIndex);
    if (turnIndex >= this.emittedTurnCount) {
      // Not yet emitted — emit as new
      this.emitNewTurns();
    } else {
      this.events.onTurnUpdated?.(turnIndex, turn);
    }
  }

  /**
   * Emit session metadata (title, sessionId).
   */
  private emitSessionMeta(): void {
    if (!this.state) { return; }
    const session = this.state as unknown as ISerializableChatData;
    const graph = buildSessionGraph(session);
    this.events.onSessionMeta?.(graph);
  }

  /**
   * Flush any remaining turns that haven't been emitted yet (end of replay).
   */
  private flushRemainingTurns(): void {
    this.emitNewTurns();
  }
}

// ---------------------------------------------------------------------------
// File watching for live tailing
// ---------------------------------------------------------------------------

export class LiveSessionTail {
  private watcher: fs.FSWatcher | null = null;
  private lastOffset = 0;
  private readonly filePath: string;
  private readonly replay: StreamingSessionReplay;
  private processing = false;

  constructor(filePath: string, events: StreamingSessionEvents) {
    this.filePath = filePath;
    this.replay = new StreamingSessionReplay(events);
  }

  /**
   * Start watching the file for new mutations.
   * First does a full replay of existing content, then watches for appended lines.
   */
  async start(): Promise<SessionGraph> {
    // Full replay first
    const graph = await this.replay.replayFile(this.filePath);

    // Record current file size as the offset
    const stat = await fs.promises.stat(this.filePath);
    this.lastOffset = stat.size;

    // Watch for changes
    this.watcher = fs.watch(this.filePath, { persistent: false }, (_eventType) => {
      this.onFileChange();
    });

    return graph;
  }

  /**
   * Stop watching the file.
   */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  private async onFileChange(): Promise<void> {
    if (this.processing) { return; }
    this.processing = true;
    try {
      const stat = await fs.promises.stat(this.filePath);
      if (stat.size <= this.lastOffset) { return; }

      // Read new bytes from the last offset
      const fd = await fs.promises.open(this.filePath, 'r');
      try {
        const buffer = Buffer.alloc(stat.size - this.lastOffset);
        await fd.read(buffer, 0, buffer.length, this.lastOffset);
        this.lastOffset = stat.size;

        const newContent = buffer.toString('utf-8');
        const lines = newContent.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.length > 0) {
            // We need to apply the mutation through the replay instance.
            // Since applyMutation is private, we use the file replay approach
            // by calling the internal method via a workaround.
            (this.replay as any).applyMutation(trimmed);
          }
        }
      } finally {
        await fd.close();
      }
    } catch {
      // File may have been deleted or become inaccessible — ignore
    } finally {
      this.processing = false;
    }
  }
}
