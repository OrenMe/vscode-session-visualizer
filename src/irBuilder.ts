// irBuilder.ts — Transforms ISerializableChatData → SessionGraph IR.
// Single source of truth for data transformation; both streaming and batch paths use this.

import {
  ISerializableChatData,
  ISerializableChatRequestData,
  IChatToolInvocationSerialized,
  IChatSubagentToolInvocationData,
  IChatTerminalToolInvocationData,
  IChatTodoListToolInvocationData,
  IChatInputToolInvocationData,
  SerializedChatResponsePart,
  SelectedModelMetadata,
} from './types';
import {
  SessionGraph,
  TurnNode,
  RequestNode,
  ResponseNode,
  ResponseChildNode,
  ToolNode,
  ThinkingNode,
  SubAgentNode,
  EditGroupNode,
  ElicitationNode,
  MarkdownSummary,
  TokenUsage,
  PromptTokenDetail,
  ToolSpecificData,
  ResultDetails,
} from './sessionIR';

// ---------------------------------------------------------------------------
// Helpers (ported from sessionToGraphData.ts)
// ---------------------------------------------------------------------------

function getMessageText(
  message: string | { text: string; parts?: Array<{ text: string }> },
): string {
  if (typeof message === 'string') { return message; }
  return message.text || '';
}

function stripMarkdownLinks(text: string): string {
  return text.replace(/\[([^\]]*)\]\(([^)]*)\)/g, (_, label, url) => {
    if (label.trim()) { return label; }
    try {
      const decoded = decodeURIComponent(url);
      const parts = decoded.replace(/^[a-z]+:\/\//, '').split('/').filter(Boolean);
      return parts[parts.length - 1] || url;
    } catch {
      return url;
    }
  });
}

function getStringValue(
  value: string | { value: string; uris?: Record<string, unknown> } | undefined,
): string {
  if (!value) { return ''; }
  if (typeof value === 'string') { return stripMarkdownLinks(value); }
  return stripMarkdownLinks(value.value || '');
}

function getUris(
  value: string | { value: string; uris?: Record<string, unknown> } | undefined,
): string[] {
  if (!value || typeof value === 'string') { return []; }
  return Object.keys(value.uris || {});
}

function renderMessagePartsToString(message: unknown): string | undefined {
  if (!message) { return undefined; }
  if (typeof message === 'string') { return message; }
  if (Array.isArray(message)) {
    return message.map(part => {
      if (typeof part === 'string') { return part; }
      if (part && typeof part === 'object') {
        if ('text' in part && typeof part.text === 'string') { return part.text; }
        if ('imageUrl' in part) { return '[Image]'; }
        if ('cacheType' in part) { return ''; }
      }
      return JSON.stringify(part);
    }).join('');
  }
  return JSON.stringify(message);
}

function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) { return text; }
  return text.slice(0, maxLength - 1) + '…';
}

function normalizeState(value: string | number | undefined): 'complete' | 'failed' | 'cancelled' | 'unknown' {
  if (value === 1 || value === 'complete') { return 'complete'; }
  if (value === 2 || value === 'failed') { return 'failed'; }
  if (value === 3 || value === 'cancelled') { return 'cancelled'; }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Tool-specific data normalization
// ---------------------------------------------------------------------------

function normalizeToolSpecificData(raw: unknown): ToolSpecificData | undefined {
  if (!raw || typeof raw !== 'object') { return undefined; }
  const obj = raw as Record<string, unknown>;
  const kind = obj.kind as string | undefined;

  if (kind === 'terminal') {
    const tsd = raw as IChatTerminalToolInvocationData;
    // cwd may be a VS Code URI object; normalize to string
    let cwd: string | undefined;
    if (tsd.cwd && typeof tsd.cwd === 'object') {
      cwd = (tsd.cwd as any).fsPath || (tsd.cwd as any).path || String(tsd.cwd);
    } else {
      cwd = tsd.cwd;
    }
    return {
      kind: 'terminal',
      commandLine: tsd.commandLine?.original || tsd.commandLine?.toolEdited,
      exitCode: tsd.terminalCommandState?.exitCode,
      duration: tsd.terminalCommandState?.duration,
      output: tsd.terminalCommandOutput?.text,
      cwd,
      autoApproveInfo: (tsd as any).autoApproveInfo?.value,
    };
  }
  if (kind === 'todoList') {
    const tsd = raw as IChatTodoListToolInvocationData;
    return {
      kind: 'todoList',
      items: (tsd.todoList || []).map(t => ({ id: t.id, title: t.title, status: t.status })),
    };
  }
  if (kind === 'input') {
    const tsd = raw as IChatInputToolInvocationData;
    return { kind: 'input', rawInput: tsd.rawInput || {} };
  }
  if (kind === 'subagent') {
    const tsd = raw as IChatSubagentToolInvocationData;
    return {
      kind: 'subagent',
      agentName: tsd.agentName,
      description: tsd.description,
      prompt: tsd.prompt,
      result: tsd.result,
    };
  }
  return { kind: 'unknown', raw };
}

function normalizeResultDetails(raw: unknown): ResultDetails | undefined {
  if (!raw || typeof raw !== 'object') { return undefined; }
  const obj = raw as Record<string, unknown>;
  const rawInput = obj.input;
  const input = rawInput == null ? undefined
    : typeof rawInput === 'string' ? rawInput
    : JSON.stringify(rawInput);
  return {
    input,
    output: Array.isArray(obj.output) ? obj.output.map((o: any) => ({
      value: o?.value == null ? undefined
        : typeof o.value === 'string' ? o.value
        : JSON.stringify(o.value),
    })) : undefined,
    isError: obj.isError as boolean | undefined,
  };
}

// ---------------------------------------------------------------------------
// Core: build a single ToolNode from a canonical IChatToolInvocationSerialized
// ---------------------------------------------------------------------------

function buildToolNode(
  canonical: IChatToolInvocationSerialized,
  id: string,
): ToolNode {
  return {
    type: 'tool',
    id,
    toolId: canonical.toolId || 'unknown',
    toolCallId: canonical.toolCallId || '',
    message: getStringValue(canonical.invocationMessage as any),
    pastTenseMessage: getStringValue(canonical.pastTenseMessage as any) || undefined,
    isComplete: canonical.isComplete,
    isConfirmed: canonical.isConfirmed,
    source: {
      type: canonical.source?.type || 'unknown',
      label: canonical.source?.label || '',
    },
    isMcp: canonical.source?.type === 'mcp',
    uris: getUris(canonical.invocationMessage as any),
    specificData: normalizeToolSpecificData(canonical.toolSpecificData),
    resultDetails: normalizeResultDetails(canonical.resultDetails),
    generatedTitle: canonical.generatedTitle,
    presentation: canonical.presentation,
  };
}

// ---------------------------------------------------------------------------
// Build a TurnNode from a single ISerializableChatRequestData
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Build enriched TokenUsage from raw request data + optional model limits
// ---------------------------------------------------------------------------

function buildTokenUsage(
  request: ISerializableChatRequestData,
  modelLimits?: SelectedModelMetadata,
): TokenUsage | undefined {
  const rawUsage = request.result?.usage || request.usage;
  const details = request.result?.details;

  // Return undefined only if there's truly nothing to show
  if (!rawUsage && !modelLimits && !details) { return undefined; }

  const promptDetails = rawUsage?.promptTokenDetails as
    | Array<{ category: string; label: string; percentageOfPrompt: number }>
    | undefined;

  return {
    totalTokens: rawUsage?.totalTokens,
    promptTokens: rawUsage?.promptTokens,
    completionTokens: rawUsage?.completionTokens,
    promptTokenDetails: promptDetails?.map(d => ({
      category: d.category,
      label: d.label,
      percentageOfPrompt: d.percentageOfPrompt,
    })),
    maxInputTokens: modelLimits?.maxInputTokens,
    maxOutputTokens: modelLimits?.maxOutputTokens,
    multiplier: parseMultiplierFromDetails(details) ?? modelLimits?.multiplier,
    details,
  };
}

/** Extract multiplier from a details string like "Claude Haiku 4.5 • 0.33x" */
function parseMultiplierFromDetails(details: string | undefined): string | undefined {
  if (!details) { return undefined; }
  const match = details.match(/(\d+(?:\.\d+)?x)\s*$/);
  return match ? match[1] : undefined;
}

export function buildTurnNode(
  request: ISerializableChatRequestData,
  turnIndex: number,
  modelLimits?: SelectedModelMetadata,
): TurnNode {
  const messageText = getMessageText(request.message);

  const variableNames = (request.variableData?.variables || [])
    .map(v => ({ name: v.name || v.id || 'var', id: v.id }))
    .filter(v => v.name);

  const requestNode: RequestNode = {
    id: `user_${turnIndex}`,
    text: truncate(messageText, 300),
    fullText: messageText,
    timestamp: request.timestamp,
    modelId: request.modelId,
    requestId: request.requestId,
    variables: variableNames,
    waitTime: request.timeSpentWaiting,
  };

  if (!request.response || request.response.length === 0) {
    return { turnIndex, request: requestNode, response: null };
  }

  // Agent info
  const agentName =
    request.agent?.name || request.agent?.agentId || request.agent?.id || 'copilot';
  const state = normalizeState(request.modelState?.value);

  // Phase 1: build canonical map (last version of each toolCallId wins)
  const toolCallCanonical = new Map<string, IChatToolInvocationSerialized>();
  for (const part of request.response) {
    if (part.kind === 'toolInvocationSerialized') {
      const tool = part as IChatToolInvocationSerialized;
      if (tool.toolCallId) {
        toolCallCanonical.set(tool.toolCallId, tool);
      }
    }
  }

  // Group tool calls owned by a subagent
  const subagentOwnedTools = new Map<string, IChatToolInvocationSerialized[]>();
  for (const [, tcPart] of toolCallCanonical) {
    if (tcPart.subAgentInvocationId) {
      const arr = subagentOwnedTools.get(tcPart.subAgentInvocationId) || [];
      arr.push(tcPart);
      subagentOwnedTools.set(tcPart.subAgentInvocationId, arr);
    }
  }

  // Phase 2: process parts in order with deduplication
  const children: ResponseChildNode[] = [];
  let markdownLength = 0;
  let responsePreview = '';
  let fullResponsePreview = '';
  let mcpServerCount = 0;
  let editGroupCount = 0;
  const partKindCounts: Record<string, number> = {};
  const seenToolCallIds = new Set<string>();

  for (const part of request.response) {
    const kindKey = part.kind ?? 'markdownContent';
    partKindCounts[kindKey] = (partKindCounts[kindKey] || 0) + 1;

    // Markdown content (null/undefined kind or explicit markdownContent)
    if (part.kind === null || part.kind === undefined || part.kind === 'markdownContent') {
      const text = getStringValue((part as any).value);
      markdownLength += text.length;
      const trimmed = text.trim();
      if (trimmed && trimmed !== '```') {
        if (responsePreview.length < 150) { responsePreview += text; }
        if (fullResponsePreview.length < 5000) { fullResponsePreview += text; }
      }
      continue;
    }

    if ((part as any).kind === 'mcpServersStarting') {
      mcpServerCount += ((part as any).didStartServerIds?.length || 1);
      continue;
    }

    if (part.kind === 'textEditGroup') {
      editGroupCount++;
      const uriPath = (part as any).uri?.fsPath || (part as any).uri?.path || 'unknown file';
      const edits = (part as any).edits || [];
      const editCount = edits.length;
      const childId = `edit_${turnIndex}_${children.length}`;
      children.push({
        type: 'editGroup',
        id: childId,
        uri: uriPath,
        editCount,
        edits,
      } as EditGroupNode);
      continue;
    }

    if (part.kind === 'elicitationSerialized') {
      const elPart = part as any;
      const title = elPart.title?.value || 'Elicitation';
      const msg = elPart.message?.value || '';
      children.push({
        type: 'elicitation',
        id: `elicitation_${turnIndex}_${children.length}`,
        title,
        message: msg,
        state: elPart.state,
      } as ElicitationNode);
      continue;
    }

    if (part.kind === 'thinking') {
      const thinkingPart = part as any;
      const text = Array.isArray(thinkingPart.value)
        ? (thinkingPart.value as string[]).join('')
        : String(thinkingPart.value || '');

      if (!text.trim()) { continue; }

      const wc = wordCount(text);
      const lineCount = text.split('\n').filter((l: string) => l.trim()).length;
      children.push({
        type: 'thinking',
        id: `thinking_${turnIndex}_${children.length}`,
        text: truncate(text, 500),
        fullText: text,
        wordCount: wc,
        charCount: text.length,
        lineCount,
        readingTimeSec: Math.ceil((wc / 200) * 60),
      } as ThinkingNode);
      continue;
    }

    if (part.kind === 'toolInvocationSerialized') {
      const tool = part as IChatToolInvocationSerialized;
      const toolCallId = tool.toolCallId;
      if (!toolCallId || seenToolCallIds.has(toolCallId)) { continue; }
      seenToolCallIds.add(toolCallId);
      const canonical = toolCallCanonical.get(toolCallId) || tool;

      // Skip tool calls owned by a subagent — nested inside their SubAgent node
      if (canonical.subAgentInvocationId) { continue; }

      const specificData = canonical.toolSpecificData as IChatSubagentToolInvocationData | undefined;
      if (specificData?.kind === 'subagent') {
        // Build subAgent child with its own nested tool call children
        const innerParts = subagentOwnedTools.get(toolCallId) || [];
        const childToolNodes: ToolNode[] = innerParts.map((t, si) =>
          buildToolNode(t, `subagent_tool_${turnIndex}_${toolCallId}_${si}`),
        );
        children.push({
          type: 'subAgent',
          id: `subagent_${turnIndex}_${children.length}`,
          agentName: specificData.agentName || 'sub-agent',
          description: specificData.description || '',
          prompt: specificData.prompt || '',
          result: specificData.result || '',
          parentToolId: canonical.toolId,
          children: childToolNodes,
          toolCount: childToolNodes.length,
        } as SubAgentNode);
      } else {
        children.push(
          buildToolNode(canonical, `tool_${turnIndex}_${children.length}`),
        );
      }
    }
  }

  const toolCount = children.filter(c => c.type === 'tool' || c.type === 'editGroup').length;
  const thinkingCount = children.filter(c => c.type === 'thinking').length;
  const subAgentCount = children.filter(c => c.type === 'subAgent').length;

  const completedAt = request.modelState?.completedAt;
  const duration = request.result?.timings?.totalElapsed ||
    ((completedAt && request.timestamp) ? Math.round(completedAt - request.timestamp) : undefined);
  const ttft = request.result?.timings?.firstProgress;

  const markdown: MarkdownSummary = {
    preview: truncate(responsePreview, 150),
    fullText: fullResponsePreview.length < 5000 ? fullResponsePreview : fullResponsePreview.slice(0, 5000) + '…',
    length: markdownLength,
  };

  const responseNode: ResponseNode = {
    id: `agent_${turnIndex}`,
    agent: agentName,
    state,
    modelId: request.modelId,
    responseId: request.responseId,
    timestamp: request.timestamp,
    completedAt,
    duration,
    ttft,
    tokens: buildTokenUsage(request, modelLimits),
    vote: request.vote,
    voteDownReason: request.voteDownReason,
    error: request.result?.errorDetails?.message,
    markdown,
    partKindCounts,
    mcpServerCount,
    children,
    toolCount,
    thinkingCount,
    subAgentCount,
    editGroupCount,
    responsePartCount: request.response.length,
    contentReferencesCount: (request as any).contentReferences?.length ?? 0,
    contentReferences: ((request as any).contentReferences || []).slice(0, 20),
    codeCitationsCount: (request as any).codeCitations?.length ?? 0,
    editedFileCount: (request as any).editedFileEvents?.length ?? 0,
    followupCount: (request as any).followups?.length ?? 0,
    renderedUserMessage: renderMessagePartsToString(request.result?.metadata?.renderedUserMessage),
    renderedGlobalContext: renderMessagePartsToString(request.result?.metadata?.renderedGlobalContext),
  };

  return { turnIndex, request: requestNode, response: responseNode };
}

// ---------------------------------------------------------------------------
// Build a full SessionGraph from a complete ISerializableChatData
// ---------------------------------------------------------------------------

export function buildSessionGraph(session: ISerializableChatData): SessionGraph {
  const firstMessage = session.requests[0]
    ? getMessageText(session.requests[0].message)
    : 'Empty session';
  const title = session.customTitle || firstMessage;

  // Extract model limits from session-level inputState (last known model after replay)
  const modelLimits = (session.inputState?.selectedModel?.metadata) as SelectedModelMetadata | undefined;

  const turns: TurnNode[] = session.requests.map((req, i) => buildTurnNode(req, i, modelLimits));

  return {
    sessionId: session.sessionId,
    title,
    creationDate: session.creationDate,
    responderUsername: session.responderUsername,
    turns,
  };
}
