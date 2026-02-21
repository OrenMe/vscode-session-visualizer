import * as vscode from 'vscode';
import {
  ISerializableChatData,
  IChatToolInvocationSerialized,
  IChatSubagentToolInvocationData,
  PromptTokenDetailRaw,
} from './types';
import { ChatSessionItem } from './treeView';
import { loadFullSession } from './sessionLoader';
import { getMessageText, getStringValue, formatDuration } from './utils';

interface TurnTokenUsage {
  turn: number;
  message: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  promptTokenDetails?: PromptTokenDetailRaw[];
  multiplier?: string;
  contextWindowPct?: number;
}

interface PromptBreakdownCategory {
  category: string;
  label: string;
  avgPercentage: number;
  turnCount: number;
}

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
  turnUsage: TurnTokenUsage[];
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  promptBreakdown: PromptBreakdownCategory[];
  maxInputTokens?: number;
  maxOutputTokens?: number;
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

  const turnUsage: TurnTokenUsage[] = [];
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalTokensAll = 0;
  let firstTimestamp: number | undefined;
  let lastTimestamp: number | undefined;

  for (let i = 0; i < session.requests.length; i++) {
    const req = session.requests[i];
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

    // Token usage — prefer result.usage, fall back to req.usage
    const usage = req.result?.usage || req.usage;
    const prompt = usage?.promptTokens ?? 0;
    const completion = usage?.completionTokens ?? 0;
    const total = usage?.totalTokens ?? (prompt + completion);
    if (prompt || completion || total) {
      totalPromptTokens += prompt;
      totalCompletionTokens += completion;
      totalTokensAll += total;
    }

    // Extract prompt breakdown details and multiplier
    const promptTokenDetails = usage?.promptTokenDetails as PromptTokenDetailRaw[] | undefined;
    const details = req.result?.details;
    let multiplier: string | undefined;
    if (details) {
      const match = details.match(/(\d+(?:\.\d+)?x)\s*$/);
      if (match) { multiplier = match[1]; }
    }

    // Context window utilization
    const modelMeta = (session as any).inputState?.selectedModel?.metadata;
    const maxIn = modelMeta?.maxInputTokens as number | undefined;
    const ctxPct = (prompt && maxIn) ? Math.round((prompt / maxIn) * 1000) / 10 : undefined;

    turnUsage.push({
      turn: i + 1,
      message: getMessageText(req.message).substring(0, 80),
      model: req.modelId,
      promptTokens: prompt || undefined,
      completionTokens: completion || undefined,
      totalTokens: total || undefined,
      promptTokenDetails,
      multiplier,
      contextWindowPct: ctxPct,
    });

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

  // Aggregate prompt breakdown categories across all turns
  const categoryAccum = new Map<string, { label: string; totalPct: number; count: number }>();
  for (const tu of turnUsage) {
    if (tu.promptTokenDetails) {
      for (const d of tu.promptTokenDetails) {
        const key = `${d.category}::${d.label}`;
        const existing = categoryAccum.get(key);
        if (existing) {
          existing.totalPct += d.percentageOfPrompt;
          existing.count++;
        } else {
          categoryAccum.set(key, { label: d.label, totalPct: d.percentageOfPrompt, count: 1 });
        }
      }
    }
  }
  const turnsWithDetails = turnUsage.filter(t => t.promptTokenDetails && t.promptTokenDetails.length > 0).length;
  const promptBreakdown: PromptBreakdownCategory[] = Array.from(categoryAccum.entries())
    .map(([key, val]) => ({
      category: key.split('::')[0],
      label: val.label,
      avgPercentage: turnsWithDetails > 0 ? Math.round((val.totalPct / turnsWithDetails) * 10) / 10 : 0,
      turnCount: val.count,
    }))
    .sort((a, b) => b.avgPercentage - a.avgPercentage);

  const modelMeta = (session as any).inputState?.selectedModel?.metadata;

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
    turnUsage,
    totalPromptTokens,
    totalCompletionTokens,
    totalTokens: totalTokensAll,
    promptBreakdown,
    maxInputTokens: modelMeta?.maxInputTokens as number | undefined,
    maxOutputTokens: modelMeta?.maxOutputTokens as number | undefined,
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

  // Prompt/completion ratio
  const promptPct = meta.totalTokens > 0 ? ((meta.totalPromptTokens / meta.totalTokens) * 100).toFixed(1) : '0';
  const completionPct = meta.totalTokens > 0 ? ((meta.totalCompletionTokens / meta.totalTokens) * 100).toFixed(1) : '0';

  // Prompt breakdown bar colors
  const breakdownColors: Record<string, string> = {
    'System Instructions': '#8b5cf6',
    'Tool Definitions': '#d29922',
    'Messages': '#2ea043',
    'Tool Results': '#508cdc',
  };
  const defaultColor = '#8b949e';

  // Context window bar helper
  function ctxBarClass(pct: number): string {
    if (pct > 90) { return 'ctx-bar-red'; }
    if (pct > 70) { return 'ctx-bar-yellow'; }
    return 'ctx-bar-green';
  }

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
    .token-summary { margin-bottom: 10px; }
    .token-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 6px; }
    .token-table th, .token-table td { padding: 4px 8px; border-bottom: 1px solid rgba(255,255,255,0.08); text-align: left; }
    .token-table th { opacity: 0.7; font-weight: 600; }
    .token-table .num { text-align: right; font-variant-numeric: tabular-nums; }
    .token-table .msg-cell { max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ratio-bar { display: flex; height: 14px; border-radius: 3px; overflow: hidden; margin: 4px 0; }
    .ratio-bar .prompt-seg { background: #2ea04390; }
    .ratio-bar .completion-seg { background: rgba(80,140,220,0.65); }
    .breakdown-bar { display: flex; height: 18px; border-radius: 3px; overflow: hidden; margin: 6px 0; }
    .breakdown-bar .seg { display: flex; align-items: center; justify-content: center; font-size: 9px; color: #fff; min-width: 2px; }
    .breakdown-legend { display: flex; flex-wrap: wrap; gap: 8px; font-size: 11px; margin-top: 4px; }
    .breakdown-legend span { display: flex; align-items: center; gap: 4px; }
    .breakdown-legend .dot { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
    .ctx-bar { height: 10px; border-radius: 3px; overflow: hidden; background: rgba(255,255,255,0.08); margin: 2px 0; }
    .ctx-bar-fill { height: 100%; border-radius: 3px; transition: width 0.3s; }
    .ctx-bar-green { background: #2ea043; }
    .ctx-bar-yellow { background: #d29922; }
    .ctx-bar-red { background: #f85149; }
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
  <div class="section">
    <h3>Token Usage</h3>
    <div class="token-summary">
      <span class="badge badge-success">Prompt: ${meta.totalPromptTokens.toLocaleString()} (${promptPct}%)</span>
      <span class="badge" style="background: rgba(80,140,220,0.45)">Completion: ${meta.totalCompletionTokens.toLocaleString()} (${completionPct}%)</span>
      <span class="badge" style="background: rgba(200,200,200,0.2)">Total: ${meta.totalTokens.toLocaleString()}</span>
    </div>
    ${meta.totalTokens > 0 ? `<div class="ratio-bar">
      <div class="prompt-seg" style="width: ${promptPct}%"></div>
      <div class="completion-seg" style="width: ${completionPct}%"></div>
    </div>` : ''}
    ${meta.promptBreakdown.length > 0 ? `
    <h4 style="margin: 12px 0 4px; font-size: 12px; opacity: 0.8;">Prompt Breakdown (avg across turns)</h4>
    <div class="breakdown-bar">
      ${meta.promptBreakdown.map(b => {
        const color = breakdownColors[b.label] || defaultColor;
        return `<div class="seg" style="width: ${b.avgPercentage}%; background: ${color};" title="${escapeHtml(b.label)}: ${b.avgPercentage}%">${b.avgPercentage >= 10 ? b.avgPercentage + '%' : ''}</div>`;
      }).join('')}
    </div>
    <div class="breakdown-legend">
      ${meta.promptBreakdown.map(b => {
        const color = breakdownColors[b.label] || defaultColor;
        return `<span><span class="dot" style="background: ${color}"></span>${escapeHtml(b.label)}: ${b.avgPercentage}%</span>`;
      }).join('')}
    </div>` : ''}
    ${meta.maxInputTokens ? `
    <h4 style="margin: 12px 0 4px; font-size: 12px; opacity: 0.8;">Context Window</h4>
    <div style="font-size: 11px; opacity: 0.7; margin-bottom: 4px;">Model limit: ${meta.maxInputTokens.toLocaleString()} input · ${(meta.maxOutputTokens || 0).toLocaleString()} output</div>` : ''}
    <table class="token-table">
      <thead>
        <tr><th>#</th><th>Message</th><th>Model</th><th>Prompt</th><th>Completion</th><th>Total</th>${meta.promptBreakdown.length > 0 ? '<th>Ctx%</th>' : ''}${meta.turnUsage.some(t => t.multiplier) ? '<th>Rate</th>' : ''}</tr>
      </thead>
      <tbody>
        ${meta.turnUsage.map(t => `<tr>
          <td>${t.turn}</td>
          <td class="msg-cell">${escapeHtml(t.message)}${t.message.length >= 80 ? '…' : ''}</td>
          <td>${escapeHtml(t.model || '—')}</td>
          <td class="num">${t.promptTokens?.toLocaleString() ?? '—'}</td>
          <td class="num">${t.completionTokens?.toLocaleString() ?? '—'}</td>
          <td class="num">${t.totalTokens?.toLocaleString() ?? '—'}</td>
          ${meta.promptBreakdown.length > 0 ? `<td class="num">${t.contextWindowPct !== undefined ? `<div style="display:flex;align-items:center;gap:4px;justify-content:flex-end"><span>${t.contextWindowPct}%</span><div class="ctx-bar" style="width:40px"><div class="ctx-bar-fill ${ctxBarClass(t.contextWindowPct)}" style="width:${Math.min(t.contextWindowPct, 100)}%"></div></div></div>` : '—'}</td>` : ''}
          ${meta.turnUsage.some(t2 => t2.multiplier) ? `<td class="num">${t.multiplier ? `<span class="badge" style="background:rgba(200,200,200,0.15);font-size:10px;padding:1px 4px">${escapeHtml(t.multiplier)}</span>` : '—'}</td>` : ''}
        </tr>`).join('')}
      </tbody>
    </table>
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
