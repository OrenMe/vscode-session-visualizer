import * as vscode from 'vscode';
import * as path from 'path';
import { ChatSessionItem } from './treeView';
import { loadFullSession, loadSessionAsGraph } from './sessionLoader';
import { SessionGraph, TurnNode } from './sessionIR';
import { buildSessionGraph } from './irBuilder';

export async function openDiagramPanel(
  context: vscode.ExtensionContext,
  sessionItem: ChatSessionItem
): Promise<void> {
  const session = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Loading session…', cancellable: false },
    (progress) => loadFullSession(sessionItem, (msg, increment) => {
      progress.report({ message: msg, increment });
    }),
  );
  if (!session) {
    vscode.window.showErrorMessage('Failed to load session data.');
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'chatWorkflowDiagram',
    `Workflow: ${sessionItem.metadata.title}`,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(context.extensionPath, 'dist')),
      ],
    }
  );

  const distUri = vscode.Uri.file(path.join(context.extensionPath, 'dist'));
  const webviewJsUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(distUri, 'webview.js')
  );
  const webviewCssUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(distUri, 'webview.css')
  );

  const nonce = getNonce();

  panel.webview.html = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${panel.webview.cspSource};">
  <title>Workflow Diagram</title>
  <link rel="stylesheet" href="${webviewCssUri}">
  <style>
    html, body, #root {
      width: 100%;
      height: 100vh;
      margin: 0;
      padding: 0;
      overflow: hidden;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family);
    }
  </style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${webviewJsUri}"></script>
</body>
</html>`;

  // Send session data to the webview once it's ready
  // Build the IR SessionGraph and send it (new pipeline)
  const sessionGraph = buildSessionGraph(session);

  // Use a small delay to ensure the webview script has loaded
  setTimeout(() => {
    panel.webview.postMessage({
      type: 'setSessionGraph',
      data: sessionGraph,
    });
  }, 500);

  panel.webview.onDidReceiveMessage(
    async (message) => {
      if (message.type === 'ready') {
        panel.webview.postMessage({
          type: 'setSessionGraph',
          data: sessionGraph,
        });
      } else if (message.command === 'showDiff') {
        const uri = message.uri || 'Unknown File';
        const edits = message.edits || [];
        
        let content = `# Edits for ${uri}\n\n`;
        
        // Flatten edits if it's an array of arrays
        const flatEdits = edits.flat();
        
        flatEdits.forEach((edit: any, index: number) => {
          content += `## Edit ${index + 1}\n`;
          content += `**Range:** Lines ${edit.range?.startLineNumber}-${edit.range?.endLineNumber}\n\n`;
          content += `\`\`\`\n${edit.text}\n\`\`\`\n\n`;
        });

        const doc = await vscode.workspace.openTextDocument({
          content,
          language: 'markdown'
        });
        await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
      }
    },
    undefined,
    context.subscriptions
  );
}

function getNonce(): string {
  let text = '';
  const possible =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
