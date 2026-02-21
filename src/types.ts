// Mirrored from VS Code internal chat types

export interface SelectedModelMetadata {
  maxInputTokens?: number;
  maxOutputTokens?: number;
  multiplier?: string;
  name?: string;
  id?: string;
  family?: string;
}

export interface ISerializableChatData {
  version: number;
  sessionId: string;
  creationDate: number;
  customTitle?: string;
  responderUsername: string;
  initialLocation?: number;
  requests: ISerializableChatRequestData[];
  hasPendingEdits?: boolean;
  repoData?: unknown;
  pendingRequests?: unknown[];
  inputState?: {
    selectedModel?: {
      identifier?: string;
      metadata?: SelectedModelMetadata;
    };
    [key: string]: unknown;
  };
}

export interface ISerializableChatRequestData {
  requestId: string;
  message: string | { text: string; parts?: Array<{ text: string }> };
  variableData: IChatRequestVariableData;
  response?: SerializedChatResponsePart[];
  shouldBeRemovedOnSend?: unknown;
  agent?: ISerializableChatAgentData;
  timestamp?: number;
  confirmation?: string;
  editedFileEvents?: unknown[];
  modelId?: string;
  responseId?: string;
  result?: IChatAgentResult;
  followups?: unknown[];
  modelState?: ResponseModelState;
  vote?: number;
  voteDownReason?: string;
  slashCommand?: unknown;
  usedContext?: unknown;
  contentReferences?: unknown[];
  codeCitations?: unknown[];
  timeSpentWaiting?: number;
  usage?: { totalTokens?: number; promptTokens?: number; completionTokens?: number; promptTokenDetails?: PromptTokenDetailRaw[] };
}

export interface IChatRequestVariableData {
  variables: Array<{ id?: string; name?: string; value?: unknown }>;
}

export interface ISerializableChatAgentData {
  id?: string;
  name?: string;
  agentId?: string;
}

export interface PromptTokenDetailRaw {
  category: string;
  label: string;
  percentageOfPrompt: number;
}

export interface IChatAgentResult {
  errorDetails?: { message?: string };
  // usage and details live directly on result (not under metadata)
  usage?: {
    totalTokens?: number;
    promptTokens?: number;
    completionTokens?: number;
    promptTokenDetails?: PromptTokenDetailRaw[];
  };
  details?: string;
  metadata?: {
    renderedUserMessage?: string;
    renderedGlobalContext?: string;
    [key: string]: unknown;
  };
  timings?: { firstProgress?: number; totalElapsed?: number };
}

export interface ResponseModelState {
  value?: string | number; // 'complete'|'failed'|'cancelled' or numeric 1|2|3
  completedAt?: number;
}

export type TextEdit = { text: string; range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number } };

export type SerializedChatResponsePart =
  | { kind: 'markdownContent'; value: string | { value: string } }
  | { kind: 'thinking'; value: string | string[]; thought?: string }
  | { kind: 'toolInvocationSerialized' } & IChatToolInvocationSerialized
  | { kind: 'progressMessage'; value: string | { value: string } }
  | { kind: 'codeblockUri'; value: unknown }
  | { kind: 'inlineReference'; value: unknown }
  | { kind: 'treeData'; value: unknown }
  | { kind: 'commandButton'; value: unknown }
  | { kind: 'textEditGroup'; value: unknown; uri?: { fsPath?: string; path?: string }; edits?: Array<TextEdit | TextEdit[]> }
  | { kind: 'confirmation'; value: unknown }
  | { kind: 'warning'; value: unknown }
  | { kind: 'elicitationSerialized'; title?: { value: string }; message?: { value: string }; state?: string };

export interface IChatToolInvocationSerialized {
  kind: 'toolInvocationSerialized';
  toolId: string;
  toolCallId: string;
  invocationMessage: string | { value: string; uris?: Record<string, unknown> };
  pastTenseMessage?: string | { value: string; uris?: Record<string, unknown> };
  isComplete: boolean;
  isConfirmed?: boolean | string | { type: number; reason?: string };
  subAgentInvocationId?: string;
  source?: { type?: string; label?: string };
  toolSpecificData?: IChatSubagentToolInvocationData | IChatTerminalToolInvocationData | IChatTodoListToolInvocationData | IChatInputToolInvocationData | unknown;
  resultDetails?: { input?: string; output?: Array<{ value?: string }>; isError?: boolean };
  generatedTitle?: string;
  presentation?: string;
}

export interface IChatSubagentToolInvocationData {
  kind: 'subagent';
  agentName?: string;
  description?: string;
  prompt?: string;
  result?: string;
}

export interface IChatTerminalToolInvocationData {
  kind: 'terminal';
  terminalCommandState?: { exitCode?: number; duration?: number };
  commandLine?: { original?: string; toolEdited?: string };
  terminalCommandOutput?: { text?: string; lineCount?: number };
  cwd?: string;
  autoApproveInfo?: { value?: string };
}

export interface IChatTodoListToolInvocationData {
  kind: 'todoList';
  todoList?: Array<{ id: string; title: string; status: string }>;
}

export interface IChatInputToolInvocationData {
  kind: 'input';
  rawInput?: Record<string, unknown>;
}

// JSONL mutation log types
export const enum MutationKind {
  Initial = 0,
  Set = 1,
  Push = 2,
  Delete = 3,
}

export interface MutationLogEntry {
  kind: number;
  v?: unknown;
  k?: (string | number)[];
  /** Splice index for kind=2: truncate array to this length before pushing */
  i?: number;
}

// Session metadata
export interface SessionMetadata {
  sessionId: string;
  filename: string;
  fileUri: string;
  title: string;
  creationDate: number;
  turnCount: number;
  lastResponseState?: string;
  modelIds: string[];
  agents: string[];
  toolCount: number;
  subAgentCount: number;
  thinkingBlockCount: number;
  mcpToolCount: number;
  hasVotes: boolean;
  lastMessage?: string;
  totalTokens: number;
  duration?: number;
  storageType: 'workspace' | 'global' | 'transferred' | 'unknown';
  workspacePath?: string;
  parsedFull?: ISerializableChatData;
}

export interface SessionFileInfo {
  filename: string;
  type: 'json' | 'jsonl';
}
