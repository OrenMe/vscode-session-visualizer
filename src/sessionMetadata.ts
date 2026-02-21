import {
  ISerializableChatData,
  SessionMetadata,
  IChatToolInvocationSerialized,
  IChatSubagentToolInvocationData,
} from './types';
import { getMessageText } from './utils';

function normalizeModelState(value: string | number | undefined): string | undefined {
  if (value === undefined || value === null) { return undefined; }
  if (typeof value === 'string') { return value; }
  // VS Code serializes as numeric: 1=complete, 2=failed, 3=cancelled
  if (value === 1) { return 'complete'; }
  if (value === 2) { return 'failed'; }
  if (value === 3) { return 'cancelled'; }
  return String(value);
}

/**
 * Extract metadata from a parsed session without storing the full parsed data.
 * Tool calls are deduplicated by toolCallId (pre/post completion pairs share the same ID).
 */
export function extractMetadata(
  session: ISerializableChatData,
  filename: string,
  fileUri: string,
  storageType: SessionMetadata['storageType'] = 'unknown',
  workspacePath?: string,
): SessionMetadata {
  const modelIds = new Set<string>();
  const agents = new Set<string>();
  const seenToolCallIds = new Set<string>();
  let toolCount = 0;
  let mcpToolCount = 0;
  let subAgentCount = 0;
  let thinkingBlockCount = 0;
  let lastResponseState: string | undefined;
  let hasVotes = false;
  let lastMessage: string | undefined;
  let totalTokens = 0;
  let sessionStart: number | undefined;
  let sessionEnd: number | undefined;

  for (const req of session.requests) {
    if (req.modelId) {
      modelIds.add(req.modelId);
    }

    const agentName = req.agent?.name || req.agent?.agentId || req.agent?.id;
    if (agentName) {
      agents.add(agentName);
    }

    const state = normalizeModelState(req.modelState?.value);
    if (state) {
      lastResponseState = state;
    }

    if (req.vote) {
      hasVotes = true;
    }

    const msg = getMessageText(req.message);
    if (msg) {
      lastMessage = msg;
    }

    if (req.usage?.totalTokens) {
      totalTokens += req.usage.totalTokens;
    }

    if (req.timestamp) {
      if (sessionStart === undefined || req.timestamp < sessionStart) {
        sessionStart = req.timestamp;
      }
    }
    if (req.modelState?.completedAt) {
      if (sessionEnd === undefined || req.modelState.completedAt > sessionEnd) {
        sessionEnd = req.modelState.completedAt;
      }
    }

    if (req.response) {
      for (const part of req.response) {
        if (part.kind === 'thinking') {
          thinkingBlockCount++;
        }
        if (part.kind === 'toolInvocationSerialized') {
          const tool = part as IChatToolInvocationSerialized;
          // Deduplicate: each tool call appears pre- and post-completion with same toolCallId
          if (seenToolCallIds.has(tool.toolCallId)) {
            continue;
          }
          seenToolCallIds.add(tool.toolCallId);
          toolCount++;
          if (tool.source?.type === 'mcp') {
            mcpToolCount++;
          }
          const specificData = tool.toolSpecificData as IChatSubagentToolInvocationData | undefined;
          if (specificData?.kind === 'subagent') {
            subAgentCount++;
          }
        }
      }
    }
  }

  const firstMessage = session.requests[0]
    ? getMessageText(session.requests[0].message)
    : 'Empty session';
  const title = session.customTitle || firstMessage;

  const duration =
    sessionStart !== undefined && sessionEnd !== undefined
      ? Math.round(sessionEnd - sessionStart)
      : undefined;

  return {
    sessionId: session.sessionId,
    filename,
    fileUri,
    title,
    creationDate: session.creationDate,
    turnCount: session.requests.length,
    lastResponseState,
    modelIds: [...modelIds],
    agents: [...agents],
    toolCount,
    subAgentCount,
    thinkingBlockCount,
    mcpToolCount,
    hasVotes,
    lastMessage: lastMessage?.substring(0, 120),
    totalTokens,
    duration,
    storageType,
    workspacePath,
    parsedFull: session,
  };
}

/**
 * Scan raw JSONL content (e.g. a tail chunk) for the most recent customTitle mutation.
 * Parses lines in reverse so the latest rename wins.
 */
function extractCustomTitleFromMutations(content: string): string | undefined {
  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) { continue; }
    try {
      const entry = JSON.parse(line);
      if (
        entry.kind === 1 &&
        Array.isArray(entry.k) &&
        entry.k.length === 1 &&
        entry.k[0] === 'customTitle' &&
        typeof entry.v === 'string'
      ) {
        return entry.v;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Extract minimal metadata from only the first line of a JSONL file (the kind=0 snapshot).
 * No mutation replay — fast for tree list display.
 * parsedFull, toolCount, mcpToolCount, etc. are not populated.
 * Pass tailContent (last few KB) to also pick up customTitle rename mutations.
 * Call extractMetadata (full) when opening the diagram or metadata panel.
 */
export function extractQuickMetadata(
  firstLineJson: string,
  filename: string,
  fileUri: string,
  storageType: SessionMetadata['storageType'],
  workspacePath?: string,
  tailContent?: string,
): SessionMetadata | undefined {
  try {
    const entry = JSON.parse(firstLineJson);
    if (!entry) { return undefined; }
    // Support both operation-log format { kind: 0, v: {...} } and legacy flat format
    const v = (entry.kind === 0 && entry.v)
      ? entry.v
      : ('sessionId' in entry ? entry : null);
    if (!v?.sessionId) { return undefined; }
    const session = v as ISerializableChatData;

    const firstMessage = session.requests?.[0]
      ? getMessageText(session.requests[0].message)
      : '';
    // Prefer a customTitle mutation from later in the file (e.g. user renamed the session)
    // over the snapshot value, which may be stale or missing.
    const mutationTitle = tailContent ? extractCustomTitleFromMutations(tailContent) : undefined;
    const title = mutationTitle || session.customTitle || firstMessage || `Session ${session.sessionId.slice(0, 8)}`;
    // Best-effort last state from the initial snapshot (may be stale vs. final mutations)
    const lastReq = session.requests?.[session.requests.length - 1];
    const lastResponseState = normalizeModelState(lastReq?.modelState?.value);

    return {
      sessionId: session.sessionId,
      filename,
      fileUri,
      title,
      creationDate: session.creationDate || 0,
      turnCount: session.requests?.length ?? 0,
      lastResponseState,
      modelIds: [],
      agents: [],
      toolCount: 0,
      subAgentCount: 0,
      thinkingBlockCount: 0,
      mcpToolCount: 0,
      hasVotes: false,
      totalTokens: 0,
      storageType,
      workspacePath,
      parsedFull: undefined,
    };
  } catch {
    return undefined;
  }
}
