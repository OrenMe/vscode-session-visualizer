import * as vscode from 'vscode';
import * as fs from 'fs';
import { ISerializableChatData } from './types';
import { parseJsonlSessionAsync } from './jsonlReplay';
import { parseJsonSession } from './sessionParser';
import { extractMetadata } from './sessionMetadata';
import { ChatSessionItem } from './treeView';

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
