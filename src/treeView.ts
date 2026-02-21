import * as vscode from 'vscode';
import * as fs from 'fs';
import { SessionMetadata } from './types';
import { discoverCurrentWorkspaceSessions, discoverAllSessionFiles } from './sessionDiscovery';
import { extractQuickMetadata, extractMetadata } from './sessionMetadata';
import { parseJsonSession } from './sessionParser';
import { formatRelativeDate, formatDuration, truncate } from './utils';

export type SessionScope = 'current' | 'all';

export interface ChatSessionItem {
  type: 'session';
  id: string;
  metadata: SessionMetadata;
}

export interface WorkspaceGroupItem {
  type: 'workspaceGroup';
  id: string;
  label: string;
  storageType: SessionMetadata['storageType'];
  workspacePath?: string;
  sessions: ChatSessionItem[];
}

export type AnyTreeItem = ChatSessionItem | WorkspaceGroupItem;

// ─── File reading helpers ────────────────────────────────────────────────────

/**
 * Read the first line and a tail chunk of a JSONL file without loading the whole file.
 * The first 64 KB captures the kind=0 initial snapshot.
 * The last 8 KB captures recent mutations such as a customTitle rename.
 */
async function readFirstAndTail(uri: vscode.Uri): Promise<{ firstLine: string; tail: string }> {
  const FIRST_CHUNK = 262144; // 256 KB
  const TAIL_SIZE = 8192;    // 8 KB
  const fd = await fs.promises.open(uri.fsPath, 'r');
  try {
    const buf = Buffer.alloc(FIRST_CHUNK);
    const { bytesRead } = await fd.read(buf, 0, FIRST_CHUNK, 0);
    const firstChunk = buf.slice(0, bytesRead).toString('utf-8');
    const nlIdx = firstChunk.indexOf('\n');
    const firstLine = nlIdx >= 0 ? firstChunk.slice(0, nlIdx) : firstChunk;
    const { size } = await fd.stat();
    let tail: string;
    if (size <= FIRST_CHUNK) {
      tail = nlIdx >= 0 ? firstChunk.slice(nlIdx + 1) : '';
    } else {
      const tailOffset = size - TAIL_SIZE;
      const tailBuf = Buffer.alloc(TAIL_SIZE);
      const tailResult = await fd.read(tailBuf, 0, TAIL_SIZE, tailOffset);
      const restOfFirstChunk = nlIdx >= 0 ? firstChunk.slice(nlIdx + 1) : '';
      tail = restOfFirstChunk + '\n' + tailBuf.slice(0, tailResult.bytesRead).toString('utf-8');
    }
    return { firstLine, tail };
  } finally {
    await fd.close();
  }
}

// ─── Workspace group helpers ─────────────────────────────────────────────────

function workspaceGroupLabel(
  storageType: SessionMetadata['storageType'],
  workspacePath?: string
): string {
  if (storageType === 'workspace' && workspacePath) {
    const parts = workspacePath.replace(/\\/g, '/').split('/').filter(Boolean);
    return parts[parts.length - 1] || workspacePath;
  }
  if (storageType === 'global') { return 'Empty Window'; }
  if (storageType === 'transferred') { return 'Transferred'; }
  return 'Unknown';
}

function buildWorkspaceGroups(sessions: ChatSessionItem[]): WorkspaceGroupItem[] {
  const groupMap = new Map<string, WorkspaceGroupItem>();
  for (const session of sessions) {
    const { storageType, workspacePath } = session.metadata;
    const key = `${storageType}:${workspacePath ?? ''}`;
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        type: 'workspaceGroup',
        id: key,
        label: workspaceGroupLabel(storageType, workspacePath),
        storageType,
        workspacePath,
        sessions: [],
      });
    }
    groupMap.get(key)!.sessions.push(session);
  }
  const storageOrder: Record<string, number> = { workspace: 0, global: 1, transferred: 2, unknown: 3 };
  return Array.from(groupMap.values()).sort((a, b) => {
    const diff = (storageOrder[a.storageType] ?? 3) - (storageOrder[b.storageType] ?? 3);
    return diff !== 0 ? diff : a.label.localeCompare(b.label);
  });
}

// ─── Tree data provider ──────────────────────────────────────────────────────

export class ChatSessionTreeDataProvider
  implements vscode.TreeDataProvider<AnyTreeItem>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<AnyTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** File URI → quick (or upgraded-to-full) metadata */
  private cache = new Map<string, SessionMetadata>();
  private _scope: SessionScope;
  private _searchQuery = '';
  private _showEmptySessions: boolean;

  /** True when a workspace folder is open; when false, 'current' scope is unavailable. */
  readonly hasWorkspace: boolean;

  constructor(private context: vscode.ExtensionContext) {
    this.hasWorkspace = !!context.storageUri;
    // Persist scope choice across restarts
    const stored = context.globalState.get<SessionScope>('chatWorkflow.sessionScope');
    // Default: 'current' if a workspace is open, 'all' for empty window
    this._scope = stored ?? (this.hasWorkspace ? 'current' : 'all');
    
    const storedShowEmpty = context.globalState.get<boolean>('chatWorkflow.showEmptySessions');
    this._showEmptySessions = storedShowEmpty ?? false;
  }

  get scope(): SessionScope { return this._scope; }
  get searchQuery(): string { return this._searchQuery; }
  get showEmptySessions(): boolean { return this._showEmptySessions; }

  setScope(scope: SessionScope): void {
    if (this._scope === scope) { return; }
    this._scope = scope;
    void this.context.globalState.update('chatWorkflow.sessionScope', scope);
    this.cache.clear();
    this._onDidChangeTreeData.fire(undefined);
  }

  setShowEmptySessions(show: boolean): void {
    if (this._showEmptySessions === show) { return; }
    this._showEmptySessions = show;
    void this.context.globalState.update('chatWorkflow.showEmptySessions', show);
    this._onDidChangeTreeData.fire(undefined);
  }

  setSearch(query: string): void {
    this._searchQuery = query;
    this._onDidChangeTreeData.fire(undefined);
  }

  clearSearch(): void {
    if (!this._searchQuery) { return; }
    this._searchQuery = '';
    this._onDidChangeTreeData.fire(undefined);
  }

  refresh(): void {
    this.cache.clear();
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Selectively invalidate a single file on change (used by file watcher). */
  invalidateFile(fileUri: string): void {
    this.cache.delete(fileUri);
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: AnyTreeItem): vscode.TreeItem {
    // ── Workspace group header ───────────────────────────────────────────────
    if (element.type === 'workspaceGroup') {
      const item = new vscode.TreeItem(
        element.label,
        vscode.TreeItemCollapsibleState.Expanded
      );
      const n = element.sessions.length;
      item.description = `${n} session${n !== 1 ? 's' : ''}`;
      item.contextValue = 'workspaceGroup';
      item.iconPath = new vscode.ThemeIcon(
        element.storageType === 'workspace' ? 'folder' : 'globe'
      );
      return item;
    }

    // ── Session item ─────────────────────────────────────────────────────────
    const meta = element.metadata;
    const item = new vscode.TreeItem(
      truncate(meta.title, 60),
      vscode.TreeItemCollapsibleState.None
    );

    // Description: date (always) + turns only when known + duration when available.
    // Omit storage label — in 'current' scope it's obvious; in 'all' scope the group header shows it.
    const descParts: string[] = [formatRelativeDate(meta.creationDate)];
    if (meta.turnCount > 0) {
      descParts.push(`${meta.turnCount} turn${meta.turnCount !== 1 ? 's' : ''}`);
    }
    if (meta.duration !== undefined) {
      descParts.push(formatDuration(meta.duration));
    }
    item.description = descParts.join(' · ');
    item.contextValue = 'chatSession';

    const tooltip = new vscode.MarkdownString();
    tooltip.supportThemeIcons = true;
    tooltip.appendMarkdown(`### $(comment-discussion) ${meta.title}\n\n`);
    tooltip.appendMarkdown(`| | |\n|---|---|\n`);
    tooltip.appendMarkdown(`| **Created** | ${new Date(meta.creationDate).toLocaleString()} |\n`);
    if (meta.turnCount > 0) {
      tooltip.appendMarkdown(`| **Turns** | ${meta.turnCount} |\n`);
    }
    tooltip.appendMarkdown(`| **State** | ${meta.lastResponseState || 'unknown'} |\n`);
    tooltip.appendMarkdown(`| **Models** | ${meta.modelIds.join(', ') || 'unknown'} |\n`);
    tooltip.appendMarkdown(`| **Agents** | ${meta.agents.join(', ') || 'none'} |\n`);
    tooltip.appendMarkdown(`| **Tools called** | ${meta.toolCount} |\n`);
    if (meta.mcpToolCount > 0) {
      tooltip.appendMarkdown(`| **MCP tools** | ${meta.mcpToolCount} |\n`);
    }
    tooltip.appendMarkdown(`| **Sub-agents** | ${meta.subAgentCount} |\n`);
    tooltip.appendMarkdown(`| **Thinking blocks** | ${meta.thinkingBlockCount} |\n`);
    if (meta.totalTokens > 0) {
      tooltip.appendMarkdown(`| **Tokens** | ${meta.totalTokens.toLocaleString()} |\n`);
    }
    if (meta.duration !== undefined) {
      tooltip.appendMarkdown(`| **Duration** | ${formatDuration(meta.duration)} |\n`);
    }
    if (meta.hasVotes) {
      tooltip.appendMarkdown(`| **Voted** | yes |\n`);
    }
    if (meta.storageType !== 'unknown') {
      tooltip.appendMarkdown(`| **Storage** | ${meta.storageType}${meta.workspacePath ? ` (${meta.workspacePath})` : ''} |\n`);
    }
    if (meta.lastMessage) {
      tooltip.appendMarkdown(`\n---\n*Last message: ${meta.lastMessage}*\n`);
    }
    tooltip.appendMarkdown(`\n---\n*Session ID: ${meta.sessionId}*`);
    item.tooltip = tooltip;

    // Icon based on last response state
    switch (meta.lastResponseState) {
      case 'complete':
        item.iconPath = new vscode.ThemeIcon(
          'check',
          new vscode.ThemeColor('testing.iconPassed')
        );
        break;
      case 'failed':
        item.iconPath = new vscode.ThemeIcon(
          'error',
          new vscode.ThemeColor('testing.iconFailed')
        );
        break;
      case 'cancelled':
        item.iconPath = new vscode.ThemeIcon(
          'circle-slash',
          new vscode.ThemeColor('testing.iconSkipped')
        );
        break;
      default:
        item.iconPath = new vscode.ThemeIcon('comment-discussion');
        break;
    }

    item.command = {
      command: 'chatWorkflow.openDiagram',
      title: 'Open Workflow Diagram',
      arguments: [element],
    };

    return item;
  }

  async getChildren(element?: AnyTreeItem): Promise<AnyTreeItem[]> {
    if (element?.type === 'session') { return []; }
    // Workspace group expansion: return its pre-built session list
    if (element?.type === 'workspaceGroup') { return element.sessions; }

    // Root: discover files and build metadata
    const files = (this._scope === 'current' && this.hasWorkspace)
      ? await discoverCurrentWorkspaceSessions(this.context)
      : await discoverAllSessionFiles(this.context);

    const rawItems: ChatSessionItem[] = [];

    for (const file of files) {
      const cacheKey = file.fileUri.toString();
      let meta = this.cache.get(cacheKey);

      if (!meta) {
        meta = await this._loadQuickMetadata(file);
        if (meta) {
          this.cache.set(cacheKey, meta);
        }
      }

      if (meta) {
        rawItems.push({ type: 'session', id: meta.sessionId, metadata: meta });
      }
    }

    // Deduplicate by sessionId (same session can appear under multiple discovered paths)
    const seen = new Set<string>();
    let unique = rawItems.filter(item => {
      if (seen.has(item.metadata.sessionId)) { return false; }
      seen.add(item.metadata.sessionId);
      return true;
    });

    if (!this._showEmptySessions) {
      unique = unique.filter(item => item.metadata.turnCount > 0);
    }

    // Apply search filter
    const query = this._searchQuery.trim().toLowerCase();
    const filtered = query
      ? unique.filter(item =>
          item.metadata.title.toLowerCase().includes(query) ||
          item.metadata.sessionId.toLowerCase().startsWith(query) ||
          (item.metadata.lastMessage?.toLowerCase().includes(query) ?? false)
        )
      : unique;

    const sortBy = vscode.workspace
      .getConfiguration('chatWorkflow')
      .get<string>('sortBy', 'date');
    if (sortBy === 'title') {
      filtered.sort((a, b) => a.metadata.title.localeCompare(b.metadata.title));
    } else {
      filtered.sort((a, b) => b.metadata.creationDate - a.metadata.creationDate);
    }

    // Current workspace scope: flat list (no group headers — storage is implicit)
    if (this._scope === 'current') {
      return filtered;
    }

    // All sessions scope: group by workspace / storage type
    return buildWorkspaceGroups(filtered);
  }

  /** Load quick (first-line-only) metadata for a discovered file — no full JSONL replay. */
  private async _loadQuickMetadata(
    file: { fileUri: vscode.Uri; filename: string; type: 'json' | 'jsonl'; storageType: SessionMetadata['storageType']; workspacePath?: string }
  ): Promise<SessionMetadata | undefined> {
    try {
      if (file.type === 'jsonl') {
        // Fast path: read first line (kind=0 snapshot) + tail (for customTitle mutations)
        const { firstLine, tail } = await readFirstAndTail(file.fileUri);
        const quick = extractQuickMetadata(
          firstLine, file.filename, file.fileUri.toString(),
          file.storageType, file.workspacePath, tail,
        );
        if (quick) { return quick; }
        // First-line parse failed — fall back to fresh full read
        const content = await fs.promises.readFile(file.fileUri.fsPath, 'utf-8');
        const fl = content.split('\n')[0] ?? '';
        return extractQuickMetadata(
          fl, file.filename, file.fileUri.toString(),
          file.storageType, file.workspacePath, content,
        );
      }

      // .json files: flat format, no mutations — parse fully but cheaply
      const content = await fs.promises.readFile(file.fileUri.fsPath, 'utf-8');
      const session = parseJsonSession(content);
      return extractMetadata(
        session, file.filename, file.fileUri.toString(),
        file.storageType, file.workspacePath,
      );
    } catch {
      return undefined;
    }
  }
}
