import * as fs from 'fs';
import * as readline from 'readline';
import { ISerializableChatData, MutationLogEntry } from './types';

/**
 * Navigate to a nested property in an object using a key path.
 * Returns the parent and the last key for mutation.
 */
function navigateTo(
  obj: Record<string, unknown>,
  keys: (string | number)[]
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

/**
 * Set a value at a nested path.
 */
function setIn(
  obj: Record<string, unknown>,
  keys: (string | number)[],
  value: unknown
): void {
  if (keys.length === 0) {
    return;
  }
  const { parent, lastKey } = navigateTo(obj, keys);
  if (Array.isArray(parent)) {
    parent[lastKey as number] = value;
  } else {
    (parent as Record<string, unknown>)[String(lastKey)] = value;
  }
}

/**
 * Append (and optionally splice) items into an array at a nested path.
 * If `spliceIndex` is provided, the array is first truncated to that length.
 */
function appendAt(
  obj: Record<string, unknown>,
  keys: (string | number)[],
  items: unknown[],
  spliceIndex?: number,
): void {
  if (keys.length === 0) {
    return;
  }
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
    throw new Error(`Cannot push: target at path is not an array`);
  }
  if (typeof spliceIndex === 'number') {
    target.splice(spliceIndex);
  }
  target.push(...items);
}

/**
 * Delete a key at a nested path.
 */
function deleteAt(
  obj: Record<string, unknown>,
  keys: (string | number)[]
): void {
  if (keys.length === 0) {
    return;
  }
  const { parent, lastKey } = navigateTo(obj, keys);
  if (Array.isArray(parent)) {
    parent.splice(lastKey as number, 1);
  } else {
    delete (parent as Record<string, unknown>)[String(lastKey)];
  }
}

/**
 * Parse a .jsonl chat session file using the ObjectMutationLog replay algorithm asynchronously.
 */
export async function parseJsonlSessionAsync(
  filePath: string,
  progressCallback?: (msg: string, increment?: number) => void
): Promise<ISerializableChatData> {
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let base: Record<string, unknown> | null = null;
  let lineCount = 0;

  for await (let line of rl) {
    line = line.trim();
    if (line.length === 0) {
      continue;
    }

    lineCount++;

    if (lineCount % 1000 === 0) {
      if (progressCallback) {
        progressCallback(`Parsing line ${lineCount.toLocaleString()}...`);
      }
      // Yield to the event loop to keep the extension host responsive
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    let entry: MutationLogEntry;
    try {
      entry = JSON.parse(line) as MutationLogEntry;
    } catch {
      // Skip malformed lines
      continue;
    }

    if (base === null) {
      if (entry.kind !== 0) {
        throw new Error(`Expected kind=0 (Initial) on first line, got kind=${entry.kind}`);
      }
      base = JSON.parse(JSON.stringify(entry.v)) as Record<string, unknown>;
      continue;
    }

    const keys = entry.k;

    switch (entry.kind) {
      case 0:
        // Secondary snapshot (log compaction) — replace all state contents
        if (typeof entry.v === 'object' && entry.v !== null) {
          for (const key of Object.keys(base)) {
            delete base[key];
          }
          Object.assign(base, entry.v as Record<string, unknown>);
        }
        break;
      case 1: // Set
        if (keys) {
          setIn(base, keys, entry.v);
        }
        break;
      case 2: // Push / splice-then-push
        if (keys) {
          const items = Array.isArray(entry.v) ? entry.v : (entry.v !== undefined ? [entry.v] : []);
          if (items.length > 0 || typeof entry.i === 'number') {
            appendAt(base, keys, items, entry.i);
          }
        }
        break;
      case 3: // Delete
        if (keys) {
          deleteAt(base, keys);
        }
        break;
    }
  }

  if (base === null) {
    throw new Error('Empty JSONL file');
  }

  return base as unknown as ISerializableChatData;
}
