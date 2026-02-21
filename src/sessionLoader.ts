import * as vscode from 'vscode';
import * as fs from 'fs';
import { ISerializableChatData } from './types';
import { parseJsonlSessionAsync } from './jsonlReplay';
import { parseJsonSession } from './sessionParser';
import { extractMetadata } from './sessionMetadata';
import { ChatSessionItem } from './treeView';
import { SessionGraph } from './sessionIR';
import { buildSessionGraph } from './irBuilder';
import { StreamingSessionReplay, LiveSessionTail, StreamingSessionEvents } from './streamingReplay';

/**
 * Ensure the full session data is loaded for the given tree item.
 *
 * If `parsedFull` is already cached on the item's metadata, it is returned directly
 * (no I/O). Otherwise, the file is read, fully parsed (JSONL mutation replay or flat JSON),
 * and the richer field values (toolCount, modelIds, parsedFull, …) are merged back into
 * the item's metadata object so the shared cache entry is upgraded in-place.
 */
export async function loadFullSession(
  item: ChatSessionItem,
  progressCallback?: (msg: string, increment?: number) => void
): Promise<ISerializableChatData | undefined> {
  if (item.metadata.parsedFull) {
    return item.metadata.parsedFull;
  }

  try {
    const filePath = vscode.Uri.parse(item.metadata.fileUri).fsPath;
    let session: ISerializableChatData;
    
    if (item.metadata.filename.endsWith('.jsonl')) {
      session = await parseJsonlSessionAsync(filePath, progressCallback);
    } else {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      session = parseJsonSession(content);
    }

    // Upgrade the cached metadata with full details (preserves the same object reference
    // so the tree view cache is updated without a separate cache-write).
    const fullMeta = extractMetadata(
      session,
      item.metadata.filename,
      item.metadata.fileUri,
      item.metadata.storageType,
      item.metadata.workspacePath,
    );
    Object.assign(item.metadata, fullMeta);
    return session;
  } catch (err) {
    console.error(`[ChatWorkflow] Failed to load session ${item.metadata.fileUri}:`, err);
    return undefined;
  }
}

/**
 * Load a session and return its IR SessionGraph (batch mode).
 * Fully replays the JSONL/JSON and builds the graph in one go.
 */
export async function loadSessionAsGraph(
  item: ChatSessionItem,
  progressCallback?: (msg: string, increment?: number) => void,
): Promise<SessionGraph | undefined> {
  const session = await loadFullSession(item, progressCallback);
  if (!session) { return undefined; }
  return buildSessionGraph(session);
}

/**
 * Load a JSONL session in streaming mode, emitting turn events as they are found.
 * Returns a StreamingSessionReplay that can be used for progressive rendering.
 * For JSON files, falls back to batch mode.
 */
export async function loadSessionStreaming(
  item: ChatSessionItem,
  events: StreamingSessionEvents,
): Promise<SessionGraph | undefined> {
  try {
    const filePath = vscode.Uri.parse(item.metadata.fileUri).fsPath;

    if (item.metadata.filename.endsWith('.jsonl')) {
      const replay = new StreamingSessionReplay(events);
      const graph = await replay.replayFile(filePath);

      // Upgrade the cached metadata
      const fullMeta = extractMetadata(
        graph as unknown as ISerializableChatData,
        item.metadata.filename,
        item.metadata.fileUri,
        item.metadata.storageType,
        item.metadata.workspacePath,
      );
      Object.assign(item.metadata, fullMeta);
      return graph;
    } else {
      // JSON files: batch load → emit complete graph
      const session = await loadFullSession(item);
      if (!session) { return undefined; }
      const graph = buildSessionGraph(session);
      events.onComplete?.(graph);
      return graph;
    }
  } catch (err) {
    events.onError?.(err instanceof Error ? err : new Error(String(err)));
    return undefined;
  }
}

/**
 * Start a live tail on a JSONL session file for real-time streaming.
 * Returns the LiveSessionTail instance (call `.stop()` to end watching)
 * and the initial SessionGraph.
 */
export async function loadSessionLiveTail(
  item: ChatSessionItem,
  events: StreamingSessionEvents,
): Promise<{ tail: LiveSessionTail; graph: SessionGraph } | undefined> {
  try {
    const filePath = vscode.Uri.parse(item.metadata.fileUri).fsPath;
    if (!item.metadata.filename.endsWith('.jsonl')) { return undefined; }

    const tail = new LiveSessionTail(filePath, events);
    const graph = await tail.start();
    return { tail, graph };
  } catch (err) {
    events.onError?.(err instanceof Error ? err : new Error(String(err)));
    return undefined;
  }
}
