// Graph data model: main spine of user→agent nodes, with expandable children

export interface ChildNodeData {
  id: string;
  type: 'toolInvocation' | 'thinking' | 'subAgent';
  data: Record<string, unknown>;
}

interface ResponsePart {
  kind: string | null;
  value?: unknown;
  thought?: string;
  toolId?: string;
  toolCallId?: string;
  invocationMessage?: string | { value: string; uris?: Record<string, unknown> };
  pastTenseMessage?: string | { value: string; uris?: Record<string, unknown> };
  isComplete?: boolean;
  isConfirmed?: boolean | string | { type: number };
  subAgentInvocationId?: string;
  didStartServerIds?: string[];
  source?: { type?: string; label?: string };
  toolSpecificData?: {
    kind?: string;
    agentName?: string;
    description?: string;
    prompt?: string;
    result?: string;
    terminalCommandState?: { exitCode?: number; duration?: number };
    commandLine?: { original?: string; toolEdited?: string };
    terminalCommandOutput?: { text?: string; lineCount?: number };
    cwd?: string;
    autoApproveInfo?: { value?: string };
    todoList?: Array<{ id: string; title: string; status: string }>;
    rawInput?: Record<string, unknown>;
  };
  resultDetails?: { input?: string; output?: Array<{ value?: string }>; isError?: boolean };
  uri?: { fsPath?: string; path?: string };
  edits?: Array<any>;
  title?: { value: string };
  message?: { value: string };
  state?: string;
  generatedTitle?: string;
  presentation?: string;
}

interface RequestData {
  requestId: string;
  message: string | { text: string; parts?: Array<{ text: string }> };
  variableData?: { variables?: Array<{ id?: string; name?: string; value?: unknown }> };
  response?: ResponsePart[];
  agent?: { id?: string; name?: string; agentId?: string };
  timestamp?: number;
  modelId?: string;
  responseId?: string;
  modelState?: { value?: string | number; completedAt?: number };
  result?: { 
    errorDetails?: { message?: string }; 
    metadata?: { renderedUserMessage?: string; renderedGlobalContext?: string; usage?: { totalTokens?: number; promptTokens?: number; completionTokens?: number }; [key: string]: unknown };
    timings?: { firstProgress?: number; totalElapsed?: number };
  };
  vote?: number;
  voteDownReason?: string;
  contentReferences?: unknown[];
  codeCitations?: unknown[];
  editedFileEvents?: unknown[];
  followups?: unknown[];
  timeSpentWaiting?: number;
  usage?: { totalTokens?: number; promptTokens?: number; completionTokens?: number };
}

export interface SessionData {
  sessionId: string;
  customTitle?: string;
  creationDate: number;
  responderUsername: string;
  requests: RequestData[];
}

export interface GraphNode {
  id: string;
  type: string;
  data: Record<string, unknown>;
  position: { x: number; y: number };
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type?: string;
  label?: string;
  animated?: boolean;
  style?: Record<string, unknown>;
}

function getMessageText(
  message: string | { text: string; parts?: Array<{ text: string }> }
): string {
  if (typeof message === 'string') { return message; }
  return message.text || '';
}

function stripMarkdownLinks(text: string): string {
  // Replace [label](url) with label if label is non-empty, else with the last path segment of url
  return text.replace(/\[([^\]]*)\]\(([^)]*)\)/g, (_, label, url) => {
    if (label.trim()) { return label; }
    // Empty label: extract a readable name from the url (last non-empty path segment)
    try {
      const decoded = decodeURIComponent(url);
      const parts = decoded.replace(/^[a-z]+:\/\//, '').split('/').filter(Boolean);
      return parts[parts.length - 1] || url;
    } catch {
      return url;
    }
  });
}

function getStringValue(value: string | { value: string; uris?: Record<string, unknown> } | undefined): string {
  if (!value) { return ''; }
  if (typeof value === 'string') { return stripMarkdownLinks(value); }
  return stripMarkdownLinks(value.value || '');
}

function getUris(value: string | { value: string; uris?: Record<string, unknown> } | undefined): string[] {
  if (!value || typeof value === 'string') { return []; }
  return Object.keys(value.uris || {});
}

function renderMessagePartsToString(message: unknown): string | undefined {
  if (!message) return undefined;
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) {
    return message.map(part => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object') {
        if ('text' in part && typeof part.text === 'string') return part.text;
        if ('imageUrl' in part) return '[Image]';
        if ('cacheType' in part) return ''; // Ignore cache markers
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

/**
 * Build the main vertical spine only: user→agent→user→agent...
 * Tool calls, thinking blocks, and sub-agents are stored as childNodes
 * on the agent node and expanded on click.
 */
export function sessionToGraphData(session: SessionData): {
  nodes: GraphNode[];
  edges: GraphEdge[];
} {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let prevNodeId: string | undefined;

  for (let i = 0; i < session.requests.length; i++) {
    const request = session.requests[i];
    const turnNumber = i + 1;
    const messageText = getMessageText(request.message);
    const userNodeId = `user_${i}`;

    const variableNames = (request.variableData?.variables || [])
      .map(v => v.name || v.id || 'var')
      .filter(Boolean);

    nodes.push({
      id: userNodeId,
      type: 'userRequest',
      data: {
        text: truncate(messageText, 300),
        fullText: messageText,
        timestamp: request.timestamp,
        turnNumber,
        modelId: request.modelId,
        variableCount: variableNames.length,
        variableNames,
        timeSpentWaiting: request.timeSpentWaiting,
        requestId: request.requestId,
      },
      position: { x: 0, y: 0 },
    });

    if (prevNodeId) {
      edges.push({
        id: `${prevNodeId}->${userNodeId}`,
        source: prevNodeId,
        target: userNodeId,
        type: 'smoothstep',
      });
    }

    if (request.response && request.response.length > 0) {
      const agentName =
        request.agent?.name || request.agent?.agentId || request.agent?.id || 'copilot';
      // Normalize numeric modelState values (1=complete, 2=failed, 3=cancelled)
      const rawState = request.modelState?.value;
      const state = rawState === 1 ? 'complete' :
                    rawState === 2 ? 'failed' :
                    rawState === 3 ? 'cancelled' :
                    typeof rawState === 'string' ? rawState : 'unknown';
      const agentNodeId = `agent_${i}`;

      // Phase 1: build canonical map (last version of each toolCallId wins)
      const toolCallCanonical = new Map<string, ResponsePart>();
      for (const part of request.response) {
        if (part.kind === 'toolInvocationSerialized' && part.toolCallId) {
          toolCallCanonical.set(part.toolCallId, part);
        }
      }

      // Group tool calls owned by a subagent (have subAgentInvocationId)
      const subagentOwnedTools = new Map<string, ResponsePart[]>();
      for (const [, tcPart] of toolCallCanonical) {
        if (tcPart.subAgentInvocationId) {
          const arr = subagentOwnedTools.get(tcPart.subAgentInvocationId) || [];
          arr.push(tcPart);
          subagentOwnedTools.set(tcPart.subAgentInvocationId, arr);
        }
      }

      // Phase 2: process parts in order with deduplication
      const children: ChildNodeData[] = [];
      let markdownLength = 0;
      let responsePreview = '';
      let fullResponsePreview = '';
      let mcpServerCount = 0;
      let textEditGroupCount = 0;
      const partKindCounts: Record<string, number> = {};
      const seenToolCallIds = new Set<string>();

      for (const part of request.response) {
        const kindKey = part.kind ?? 'markdownContent';
        partKindCounts[kindKey] = (partKindCounts[kindKey] || 0) + 1;

        // null-kind parts are markdown content in some VS Code serializations
        if (part.kind === null || part.kind === undefined || part.kind === 'markdownContent') {
          const text = getStringValue(part.value as string | { value: string });
          markdownLength += text.length;
          // Skip pure code-fence delimiters (```\n) that appear between tool calls
          const trimmed = text.trim();
          if (trimmed && trimmed !== '```') {
            if (responsePreview.length < 150) { responsePreview += text; }
            if (fullResponsePreview.length < 5000) { fullResponsePreview += text; }
          }
          continue;
        }

        if (part.kind === 'mcpServersStarting') {
          mcpServerCount += (part.didStartServerIds?.length || 1);
          continue;
        }

        if (part.kind === 'textEditGroup') {
          textEditGroupCount++;
          const uriPath = part.uri?.fsPath || part.uri?.path || 'unknown file';
          const editCount = part.edits?.length || 0;
          children.push({
            id: `edit_${i}_${children.length}`,
            type: 'toolInvocation',
            data: {
              toolId: 'textEditGroup',
              toolCallId: `edit_${i}_${children.length}`,
              invocationMessage: `Edited ${uriPath} (${editCount} edits)`,
              isComplete: true,
              sourceType: 'internal',
              sourceLabel: 'Built-In',
              uris: [uriPath],
              edits: part.edits,
            },
          });
          continue;
        }

        if (part.kind === 'elicitationSerialized') {
          const title = part.title?.value || 'Elicitation';
          const msg = part.message?.value || '';
          children.push({
            id: `elicitation_${i}_${children.length}`,
            type: 'toolInvocation',
            data: {
              toolId: 'elicitation',
              toolCallId: `elicitation_${i}_${children.length}`,
              invocationMessage: `${title}: ${msg}`,
              isComplete: true,
              isConfirmed: part.state,
              sourceType: 'internal',
              sourceLabel: 'Built-In',
            },
          });
          continue;
        }

        if (part.kind === 'thinking') {
          const text = Array.isArray(part.value)
            ? (part.value as string[]).join('')
            : String(part.value || '');
          
          // Skip empty thinking blocks
          if (!text.trim()) {
            continue;
          }

          const wc = wordCount(text);
          const lineCount = text.split('\n').filter(l => l.trim()).length;
          children.push({
            id: `thinking_${i}_${children.length}`,
            type: 'thinking',
            data: {
              text: truncate(text, 500),
              fullText: text,
              charCount: text.length,
              wordCount: wc,
              lineCount,
              readingTimeSec: Math.ceil((wc / 200) * 60),
            },
          });
          continue;
        }

        if (part.kind === 'toolInvocationSerialized') {
          const toolCallId = part.toolCallId;
          // Deduplicate: only process each toolCallId once (keep canonical/last version)
          if (!toolCallId || seenToolCallIds.has(toolCallId)) { continue; }
          seenToolCallIds.add(toolCallId);
          const canonical = toolCallCanonical.get(toolCallId) || part;

          // Skip tool calls owned by a subagent — they'll be nested inside their SubAgent node
          if (canonical.subAgentInvocationId) { continue; }

          if (canonical.toolSpecificData?.kind === 'subagent') {
            // Build subAgent child with its own nested tool call children
            const innerParts = subagentOwnedTools.get(toolCallId) || [];
            const childToolNodes: ChildNodeData[] = innerParts.map((t, si) => ({
              id: `subagent_tool_${i}_${toolCallId}_${si}`,
              type: 'toolInvocation' as const,
              data: {
                toolId: t.toolId || 'unknown',
                toolCallId: t.toolCallId || '',
                invocationMessage: getStringValue(t.invocationMessage),
                pastTenseMessage: getStringValue(t.pastTenseMessage),
                isComplete: t.isComplete,
                isConfirmed: t.isConfirmed,
                sourceType: t.source?.type || 'unknown',
                sourceLabel: t.source?.label || '',
                isMcp: t.source?.type === 'mcp',
                uris: getUris(t.invocationMessage),
              },
            }));
            children.push({
              id: `subagent_${i}_${children.length}`,
              type: 'subAgent',
              data: {
                agentName: canonical.toolSpecificData.agentName || 'sub-agent',
                description: canonical.toolSpecificData.description || '',
                prompt: canonical.toolSpecificData.prompt || '',
                result: canonical.toolSpecificData.result || '',
                parentToolId: canonical.toolId,
                toolCount: childToolNodes.length,
                childNodes: childToolNodes,
              },
            });
          } else {
            children.push({
              id: `tool_${i}_${children.length}`,
              type: 'toolInvocation',
              data: {
                toolId: canonical.toolId || 'unknown',
                toolCallId: canonical.toolCallId || '',
                invocationMessage: getStringValue(canonical.invocationMessage),
                pastTenseMessage: getStringValue(canonical.pastTenseMessage),
                isComplete: canonical.isComplete,
                isConfirmed: canonical.isConfirmed,
                sourceType: canonical.source?.type || 'unknown',
                sourceLabel: canonical.source?.label || '',
                isMcp: canonical.source?.type === 'mcp',
                uris: getUris(canonical.invocationMessage),
                toolSpecificData: canonical.toolSpecificData,
                resultDetails: canonical.resultDetails,
                generatedTitle: canonical.generatedTitle,
                presentation: canonical.presentation,
              },
            });
          }
        }
      }

      const toolCount = children.filter(c => c.type === 'toolInvocation').length;
      const thinkingCount = children.filter(c => c.type === 'thinking').length;
      const subAgentCount = children.filter(c => c.type === 'subAgent').length;

      const completedAt = request.modelState?.completedAt;
      const duration = request.result?.timings?.totalElapsed || ((completedAt && request.timestamp)
        ? Math.round(completedAt - request.timestamp)
        : undefined);
      const ttft = request.result?.timings?.firstProgress;

      nodes.push({
        id: agentNodeId,
        type: 'agentResponse',
        data: {
          agent: agentName,
          state,
          turnNumber,
          modelId: request.modelId,
          responsePreview: truncate(responsePreview, 150),
          fullResponsePreview: fullResponsePreview.length < 5000 ? fullResponsePreview : fullResponsePreview.slice(0, 5000) + '…',
          markdownLength,
          responsePartCount: request.response.length,
          partKindCounts,
          toolCount,
          thinkingCount,
          subAgentCount,
          mcpServerCount,
          textEditGroupCount,
          duration,
          ttft,
          childNodes: children,
          responseId: request.responseId,
          vote: request.vote,
          voteDownReason: request.voteDownReason,
          contentReferencesCount: request.contentReferences?.length ?? 0,
          contentReferences: (request.contentReferences || []).slice(0, 20),
          codeCitationsCount: request.codeCitations?.length ?? 0,
          editedFileCount: request.editedFileEvents?.length ?? 0,
          followupCount: request.followups?.length ?? 0,
          errorMessage: request.result?.errorDetails?.message,
          renderedUserMessage: renderMessagePartsToString(request.result?.metadata?.renderedUserMessage),
          renderedGlobalContext: renderMessagePartsToString(request.result?.metadata?.renderedGlobalContext),
          usage: request.result?.metadata?.usage || request.usage,
        },
        position: { x: 0, y: 0 },
      });

      edges.push({
        id: `${userNodeId}->${agentNodeId}`,
        source: userNodeId,
        target: agentNodeId,
        type: 'smoothstep',
      });

      prevNodeId = agentNodeId;
    } else {
      prevNodeId = userNodeId;
    }
  }

  return { nodes, edges };
}
