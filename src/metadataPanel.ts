import * as vscode from 'vscode';
import {
  ISerializableChatData,
  IChatToolInvocationSerialized,
  IChatSubagentToolInvocationData,
} from './types';
import { ChatSessionItem } from './treeView';
import { loadFullSession } from './sessionLoader';
import { getMessageText, getStringValue, formatDuration } from './utils';

interface DetailedMetadata {
  sessionId: string;
  creationDate: number;
  customTitle?: string;
  responderUsername: string;
  turnCount: number;
  models: Record<string, number>;
  agents: Record<string, number>;
  tools: Record<string, number>;
  subAgents: Record<string, number>;
  thinkingBlockCount: number;
  thinkingTextTotal: number;
  responseStates: { complete: number; failed: number; cancelled: number };
  totalDuration: number;
  contentReferencesTotal: number;
  codeCitationsTotal: number;
}

function computeDetailedMetadata(
  session: ISerializableChatData
): DetailedMetadata {
  const models: Record<string, number> = {};
  const agents: Record<string, number> = {};
  const tools: Record<string, number> = {};
  const subAgents: Record<string, number> = {};
  let thinkingBlockCount = 0;
  let thinkingTextTotal = 0;
  const responseStates = { complete: 0, failed: 0, cancelled: 0 };
  let contentReferencesTotal = 0;
  let codeCitationsTotal = 0;

  let firstTimestamp: number | undefined;
  let lastTimestamp: number | undefined;

  for (const req of session.requests) {
    if (req.timestamp) {
      if (firstTimestamp === undefined || req.timestamp < firstTimestamp) {
        firstTimestamp = req.timestamp;
      }
      if (lastTimestamp === undefined || req.timestamp > lastTimestamp) {
        lastTimestamp = req.timestamp;
      }
    }

    if (req.modelId) {
      models[req.modelId] = (models[req.modelId] || 0) + 1;
    }

    const agentName =
      req.agent?.name || req.agent?.agentId || req.agent?.id || 'unknown';
    agents[agentName] = (agents[agentName] || 0) + 1;

    if (req.modelState?.value) {
      const raw = req.modelState.value;
      // Normalize numeric values (VS Code serializes as 1/2/3)
      const state = typeof raw === 'number'
        ? (raw === 1 ? 'complete' : raw === 2 ? 'failed' : raw === 3 ? 'cancelled' : String(raw))
        : raw;
      if (state === 'complete') { responseStates.complete++; }
      else if (state === 'failed') { responseStates.failed++; }
      else if (state === 'cancelled') { responseStates.cancelled++; }
    }

    contentReferencesTotal += req.contentReferences?.length ?? 0;
    codeCitationsTotal += req.codeCitations?.length ?? 0;

    if (req.response) {
      for (const part of req.response) {
        if (part.kind === 'thinking') {
          thinkingBlockCount++;
          const thinkPart = part as { kind: 'thinking'; value: string | string[] };
          const text = Array.isArray(thinkPart.value)
            ? thinkPart.value.join('')
            : thinkPart.value;
          thinkingTextTotal += text.length;
        }
        if (part.kind === 'toolInvocationSerialized') {
          const tool = part as IChatToolInvocationSerialized;
          tools[tool.toolId] = (tools[tool.toolId] || 0) + 1;
          const specificData =
            tool.toolSpecificData as IChatSubagentToolInvocationData | undefined;
          if (specificData?.kind === 'subagent') {
            const name = specificData.agentName || 'unknown';
            subAgents[name] = (subAgents[name] || 0) + 1;
          }
        }
      }
    }
  }

  const totalDuration =
    firstTimestamp && lastTimestamp ? lastTimestamp - firstTimestamp : 0;

  return {
    sessionId: session.sessionId,
    creationDate: session.creationDate,
    customTitle: session.customTitle,
    responderUsername: session.responderUsername,
    turnCount: session.requests.length,
    models,
    agents,
    tools,
    subAgents,
    thinkingBlockCount,
    thinkingTextTotal,
    responseStates,
    totalDuration,
    contentReferencesTotal,
    codeCitationsTotal,
  };
}

function formatRecord(rec: Record<string, number>): string {
  return Object.entries(rec)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ') || 'none';
}

export async function showMetadataPanel(
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

  const meta = computeDetailedMetadata(session);
  const title = meta.customTitle || sessionItem.metadata.title;

  const panel = vscode.window.createWebviewPanel(
    'chatWorkflowMetadata',
    `Metadata: ${title}`,
    vscode.ViewColumn.Active,
    { enableScripts: true }
  );

  const createdDate = new Date(meta.creationDate).toLocaleString();
  const duration = formatDuration(meta.totalDuration);

  panel.webview.html = /* html */ `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: var(--vscode-font-family, sans-serif);
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      padding: 16px;
      margin: 0;
    }
    h2 { margin-top: 0; }
    dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; }
    dt { font-weight: bold; white-space: nowrap; }
    dd { margin: 0; word-break: break-word; }
    .section { margin-bottom: 16px; }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 12px;
      margin-right: 4px;
    }
    .badge-success { background: #2ea04370; }
    .badge-error { background: #f8514970; }
    .badge-warning { background: #d2992270; }
  </style>
</head>
<body>
  <h2>${escapeHtml(title)}</h2>
  <div class="section">
    <dl>
      <dt>Session ID</dt>
      <dd>${escapeHtml(meta.sessionId)}</dd>
      <dt>Created</dt>
      <dd>${escapeHtml(createdDate)}</dd>
      <dt>Duration</dt>
      <dd>${escapeHtml(duration)}</dd>
      <dt>Turns</dt>
      <dd>${meta.turnCount}</dd>
      <dt>Responder</dt>
      <dd>${escapeHtml(meta.responderUsername)}</dd>
    </dl>
  </div>
  <div class="section">
    <h3>Models</h3>
    <dd>${escapeHtml(formatRecord(meta.models))}</dd>
  </div>
  <div class="section">
    <h3>Agents</h3>
    <dd>${escapeHtml(formatRecord(meta.agents))}</dd>
  </div>
  <div class="section">
    <h3>Tools Called</h3>
    <dd>${escapeHtml(formatRecord(meta.tools))}</dd>
  </div>
  <div class="section">
    <h3>Sub-Agents</h3>
    <dd>${escapeHtml(formatRecord(meta.subAgents))}</dd>
  </div>
  <div class="section">
    <h3>Thinking</h3>
    <dd>${meta.thinkingBlockCount} blocks (${meta.thinkingTextTotal.toLocaleString()} chars)</dd>
  </div>
  <div class="section">
    <h3>Response States</h3>
    <dd>
      <span class="badge badge-success">✓ ${meta.responseStates.complete}</span>
      <span class="badge badge-error">✗ ${meta.responseStates.failed}</span>
      <span class="badge badge-warning">⊘ ${meta.responseStates.cancelled}</span>
    </dd>
  </div>
  <div class="section">
    <h3>References</h3>
    <dd>${meta.contentReferencesTotal} references · ${meta.codeCitationsTotal} citations</dd>
  </div>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
