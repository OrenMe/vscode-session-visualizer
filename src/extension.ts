import * as vscode from 'vscode';
import { ChatSessionTreeDataProvider } from './treeView';
import { showMetadataPanel } from './metadataPanel';
import { openDiagramPanel } from './diagramPanel';
import { getSessionStoragePath } from './sessionDiscovery';

function setContextKey(key: string, value: unknown): void {
  void vscode.commands.executeCommand('setContext', key, value);
}

export function activate(context: vscode.ExtensionContext) {
  const treeDataProvider = new ChatSessionTreeDataProvider(context);

  const treeView = vscode.window.createTreeView('chatSessionList', {
    treeDataProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  // Set initial context keys so toolbar buttons render correctly on startup
  setContextKey('chatWorkflow.sessionScope', treeDataProvider.scope);
  setContextKey('chatWorkflow.hasWorkspace', treeDataProvider.hasWorkspace);
  setContextKey('chatWorkflow.searchActive', false);
  setContextKey('chatWorkflow.showEmptySessions', treeDataProvider.showEmptySessions);

  // Refresh
  context.subscriptions.push(
    vscode.commands.registerCommand('chatWorkflow.refresh', () => {
      treeDataProvider.refresh();
      vscode.window.setStatusBarMessage('Chat sessions refreshed', 2000);
    })
  );

  // Filter: switch to current workspace only
  context.subscriptions.push(
    vscode.commands.registerCommand('chatWorkflow.filterCurrentWorkspace', () => {
      treeDataProvider.setScope('current');
      setContextKey('chatWorkflow.sessionScope', 'current');
    })
  );

  // Filter: switch to all sessions across all workspaces
  context.subscriptions.push(
    vscode.commands.registerCommand('chatWorkflow.filterAllSessions', () => {
      treeDataProvider.setScope('all');
      setContextKey('chatWorkflow.sessionScope', 'all');
    })
  );

  // Filter: toggle showing empty sessions
  context.subscriptions.push(
    vscode.commands.registerCommand('chatWorkflow.toggleShowEmpty', () => {
      const newState = !treeDataProvider.showEmptySessions;
      treeDataProvider.setShowEmptySessions(newState);
      setContextKey('chatWorkflow.showEmptySessions', newState);
    })
  );

  // Filter: reset filters
  context.subscriptions.push(
    vscode.commands.registerCommand('chatWorkflow.resetFilters', () => {
      const defaultScope = treeDataProvider.hasWorkspace ? 'current' : 'all';
      treeDataProvider.setScope(defaultScope);
      setContextKey('chatWorkflow.sessionScope', defaultScope);
      
      treeDataProvider.setShowEmptySessions(false);
      setContextKey('chatWorkflow.showEmptySessions', false);
    })
  );

  // Search: prompt for a query string, filter the list
  context.subscriptions.push(
    vscode.commands.registerCommand('chatWorkflow.search', async () => {
      const query = await vscode.window.showInputBox({
        placeHolder: 'Search sessions by title or message…',
        prompt: 'Filter sessions — leave blank to clear',
        value: treeDataProvider.searchQuery,
      });
      if (query === undefined) { return; } // user pressed Escape
      treeDataProvider.setSearch(query);
      setContextKey('chatWorkflow.searchActive', query.trim().length > 0);
    })
  );

  // Clear search (toolbar button shown while search is active)
  context.subscriptions.push(
    vscode.commands.registerCommand('chatWorkflow.clearSearch', () => {
      treeDataProvider.clearSearch();
      setContextKey('chatWorkflow.searchActive', false);
    })
  );

  // Show metadata panel — full parse happens lazily inside the panel
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'chatWorkflow.showMetadata',
      async (sessionItem) => {
        if (sessionItem?.metadata) {
          await showMetadataPanel(context, sessionItem);
        }
      }
    )
  );

  // Open diagram — full parse happens lazily inside the panel
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'chatWorkflow.openDiagram',
      async (sessionItem) => {
        if (sessionItem?.metadata) {
          await openDiagramPanel(context, sessionItem);
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'chatWorkflow.openRawFile',
      async (sessionItem) => {
        if (sessionItem?.metadata?.fileUri) {
          const uri = vscode.Uri.parse(sessionItem.metadata.fileUri);
          await vscode.window.showTextDocument(uri, {
            preview: false,
            viewColumn: vscode.ViewColumn.Active,
          });
        }
      }
    )
  );

  // File watcher — watch the current workspace's chatSessions dir
  const storageUri = getSessionStoragePath(context);
  if (
    storageUri &&
    vscode.workspace.getConfiguration('chatWorkflow').get<boolean>('autoRefresh', true)
  ) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(storageUri, '*.{json,jsonl}'),
      false, false, false
    );
    watcher.onDidChange((uri) => treeDataProvider.invalidateFile(uri.toString()));
    watcher.onDidCreate(() => treeDataProvider.refresh());
    watcher.onDidDelete(() => treeDataProvider.refresh());
    context.subscriptions.push(watcher);
  }
}

export function deactivate() {}

