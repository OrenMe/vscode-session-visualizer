import * as vscode from 'vscode';
import * as path from 'path';
import { SessionFileInfo, SessionMetadata } from './types';

export interface DiscoveredSessionFile extends SessionFileInfo {
  fileUri: vscode.Uri;
  storageType: SessionMetadata['storageType'];
  workspacePath?: string;
}

/**
 * Discover all chat session JSONL/JSON files across all VS Code storage locations:
 *  - workspaceStorage/<hash>/chatSessions/   (per-workspace)
 *  - globalStorage/emptyWindowChatSessions/  (no-folder windows)
 *  - globalStorage/transferredChatSessions/  (migrated sessions)
 *
 * Also respects a manual override setting for the storage path.
 */
export async function discoverAllSessionFiles(
  context: vscode.ExtensionContext
): Promise<DiscoveredSessionFile[]> {
  // Manual override takes precedence — single path, storageType 'unknown'
  const manualPath = vscode.workspace
    .getConfiguration('chatWorkflow')
    .get<string>('sessionStoragePath');
  if (manualPath) {
    const uri = vscode.Uri.file(manualPath);
    const files = await listSessionsInDir(uri);
    return files.map(f => ({ ...f, storageType: 'unknown' as const }));
  }

  // globalStorageUri: .../User/globalStorage/<extensionId>
  const globalStorageDir = vscode.Uri.joinPath(context.globalStorageUri, '..');
  const userDir = vscode.Uri.joinPath(globalStorageDir, '..');

  const results: DiscoveredSessionFile[] = [];

  // 1. Global: emptyWindow + transferred
  const globalPaths: { rel: string; type: SessionMetadata['storageType'] }[] = [
    { rel: 'globalStorage/emptyWindowChatSessions', type: 'global' },
    { rel: 'globalStorage/transferredChatSessions', type: 'transferred' },
  ];
  for (const { rel, type } of globalPaths) {
    const dir = vscode.Uri.joinPath(userDir, rel);
    const files = await listSessionsInDir(dir);
    results.push(...files.map(f => ({ ...f, storageType: type })));
  }

  // 2. Workspace storage: enumerate all workspace hashes
  const workspaceStorageUri = vscode.Uri.joinPath(userDir, 'workspaceStorage');
  try {
    const entries = await vscode.workspace.fs.readDirectory(workspaceStorageUri);
    await Promise.all(
      entries
        .filter(([, type]) => type === vscode.FileType.Directory)
        .map(async ([name]) => {
          const chatDir = vscode.Uri.joinPath(workspaceStorageUri, name, 'chatSessions');
          const files = await listSessionsInDir(chatDir);
          if (files.length === 0) { return; }
          const workspacePath = await resolveWorkspacePath(
            vscode.Uri.joinPath(workspaceStorageUri, name)
          );
          results.push(
            ...files.map(f => ({
              ...f,
              storageType: 'workspace' as const,
              workspacePath,
            }))
          );
        })
    );
  } catch {
    // workspaceStorage dir inaccessible
  }

  // Always include the current workspace's own chatSessions dir if it exists
  if (context.storageUri) {
    const workspaceHashDir = vscode.Uri.joinPath(context.storageUri, '..');
    const chatDir = vscode.Uri.joinPath(workspaceHashDir, 'chatSessions');
    const files = await listSessionsInDir(chatDir);
    if (files.length > 0) {
      const workspacePath = await resolveWorkspacePath(workspaceHashDir);
      for (const f of files) {
        // Avoid duplicates from workspace enumeration above
        if (!results.some(r => r.fileUri.toString() === f.fileUri.toString())) {
          results.push({ ...f, storageType: 'workspace', workspacePath });
        }
      }
    }
  }

  return results;
}

/**
 * Discover sessions from only the current workspace's chatSessions/ directory.
 * Much faster than full discovery — doesn't enumerate all workspace storage hashes.
 * Returns an empty array when no workspace is open.
 */
export async function discoverCurrentWorkspaceSessions(
  context: vscode.ExtensionContext
): Promise<DiscoveredSessionFile[]> {
  const manualPath = vscode.workspace
    .getConfiguration('chatWorkflow')
    .get<string>('sessionStoragePath');
  if (manualPath) {
    const uri = vscode.Uri.file(manualPath);
    const files = await listSessionsInDir(uri);
    return files.map(f => ({ ...f, storageType: 'unknown' as const }));
  }

  if (!context.storageUri) {
    return []; // No workspace open — caller should fall back to 'all'
  }

  const workspaceHashDir = vscode.Uri.joinPath(context.storageUri, '..');
  const chatDir = vscode.Uri.joinPath(workspaceHashDir, 'chatSessions');
  const files = await listSessionsInDir(chatDir);
  if (files.length === 0) { return []; }
  const workspacePath = await resolveWorkspacePath(workspaceHashDir);
  return files.map(f => ({ ...f, storageType: 'workspace' as const, workspacePath }));
}

/**
 * Legacy: return only files from the single path (used when caller provides path explicitly).
 */
export async function discoverSessionFiles(
  storageUri: vscode.Uri
): Promise<SessionFileInfo[]> {
  return listSessionsInDir(storageUri);
}

/** List all .jsonl/.json files in a single directory. */
async function listSessionsInDir(dir: vscode.Uri): Promise<DiscoveredSessionFile[]> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(dir);
    return entries
      .filter(([name, type]) => type === vscode.FileType.File && (name.endsWith('.jsonl') || name.endsWith('.json')))
      .map(([name]) => ({
        filename: name,
        type: (name.endsWith('.jsonl') ? 'jsonl' : 'json') as 'json' | 'jsonl',
        fileUri: vscode.Uri.joinPath(dir, name),
        storageType: 'unknown' as SessionMetadata['storageType'],
      }));
  } catch {
    return [];
  }
}

/** Read workspace.json next to chatSessions/ to get the folder name. */
async function resolveWorkspacePath(workspaceHashDir: vscode.Uri): Promise<string | undefined> {
  try {
    const workspaceJson = vscode.Uri.joinPath(workspaceHashDir, 'workspace.json');
    const raw = Buffer.from(await vscode.workspace.fs.readFile(workspaceJson)).toString('utf-8');
    const data = JSON.parse(raw);
    if (data.folder && typeof data.folder === 'string') {
      return path.basename(new URL(data.folder).pathname);
    }
  } catch {
    // Not present or unreadable
  }
  return undefined;
}

/**
 * Compute the path to the current workspace's chatSessions/ directory.
 * @deprecated Use discoverAllSessionFiles(context) instead.
 */
export function getSessionStoragePath(
  context: vscode.ExtensionContext
): vscode.Uri | undefined {
  const manualPath = vscode.workspace
    .getConfiguration('chatWorkflow')
    .get<string>('sessionStoragePath');
  if (manualPath) {
    return vscode.Uri.file(manualPath);
  }

  if (context.storageUri) {
    const workspaceDir = path.dirname(context.storageUri.fsPath);
    return vscode.Uri.file(path.join(workspaceDir, 'chatSessions'));
  }

  if (context.globalStorageUri) {
    const globalStorageDir = path.dirname(context.globalStorageUri.fsPath);
    const userDir = path.dirname(globalStorageDir);
    return vscode.Uri.file(path.join(userDir, 'emptyWindowChatSessions'));
  }

  return undefined;
}

