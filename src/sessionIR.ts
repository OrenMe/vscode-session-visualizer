// sessionIR.ts — Intermediate Representation for chat session visualization.
// All types are readonly for immutable React diffing.

export interface SessionGraph {
  readonly sessionId: string;
  readonly title: string;
  readonly creationDate: number;
  readonly responderUsername: string;
  readonly turns: readonly TurnNode[];
}

export interface TurnNode {
  readonly turnIndex: number;
  readonly request: RequestNode;
  readonly response: ResponseNode | null;
}

export interface RequestNode {
  readonly id: string;           // `user_${turnIndex}`
  readonly text: string;
  readonly fullText: string;
  readonly timestamp?: number;
  readonly modelId?: string;
  readonly requestId: string;
  readonly variables: readonly VariableRef[];
  readonly waitTime?: number;
}

export interface VariableRef {
  readonly name: string;
  readonly id?: string;
}

export interface ResponseNode {
  readonly id: string;           // `agent_${turnIndex}`
  readonly agent: string;
  readonly state: 'complete' | 'failed' | 'cancelled' | 'unknown';
  readonly modelId?: string;
  readonly responseId?: string;
  readonly timestamp?: number;
  readonly completedAt?: number;
  readonly duration?: number;
  readonly ttft?: number;
  readonly tokens?: TokenUsage;
  readonly vote?: number;
  readonly voteDownReason?: string;
  readonly error?: string;
  readonly markdown: MarkdownSummary;
  readonly partKindCounts: Readonly<Record<string, number>>;
  readonly mcpServerCount: number;
  readonly children: readonly ResponseChildNode[];
  readonly toolCount: number;
  readonly thinkingCount: number;
  readonly subAgentCount: number;
  readonly editGroupCount: number;
  // Extra fields carried for the details modal
  readonly responsePartCount: number;
  readonly contentReferencesCount: number;
  readonly contentReferences: readonly unknown[];
  readonly codeCitationsCount: number;
  readonly editedFileCount: number;
  readonly followupCount: number;
  readonly renderedUserMessage?: string;
  readonly renderedGlobalContext?: string;
}

export type ResponseChildNode = ToolNode | ThinkingNode | SubAgentNode | EditGroupNode | ElicitationNode;

export interface ToolNode {
  readonly type: 'tool';
  readonly id: string;
  readonly toolId: string;
  readonly toolCallId: string;
  readonly message: string;
  readonly pastTenseMessage?: string;
  readonly isComplete: boolean;
  readonly isConfirmed?: boolean | string | { type: number; reason?: string };
  readonly source: { readonly type: string; readonly label: string };
  readonly isMcp: boolean;
  readonly uris: readonly string[];
  readonly specificData?: ToolSpecificData;
  readonly resultDetails?: ResultDetails;
  readonly generatedTitle?: string;
  readonly presentation?: string;
}

export interface ThinkingNode {
  readonly type: 'thinking';
  readonly id: string;
  readonly text: string;
  readonly fullText: string;
  readonly wordCount: number;
  readonly charCount: number;
  readonly lineCount: number;
  readonly readingTimeSec: number;
}

export interface SubAgentNode {
  readonly type: 'subAgent';
  readonly id: string;
  readonly agentName: string;
  readonly description: string;
  readonly prompt: string;
  readonly result: string;
  readonly parentToolId: string;
  readonly children: readonly ToolNode[];
  readonly toolCount: number;
}

export interface EditGroupNode {
  readonly type: 'editGroup';
  readonly id: string;
  readonly uri: string;
  readonly editCount: number;
  readonly edits: readonly unknown[];
}

export interface ElicitationNode {
  readonly type: 'elicitation';
  readonly id: string;
  readonly title: string;
  readonly message: string;
  readonly state?: string;
}

export interface MarkdownSummary {
  readonly preview: string;      // truncated to ~150 chars
  readonly fullText: string;     // up to 5000 chars
  readonly length: number;       // total char count
}

export interface PromptTokenDetail {
  readonly category: string;
  readonly label: string;
  readonly percentageOfPrompt: number;
}

export interface TokenUsage {
  readonly totalTokens?: number;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly promptTokenDetails?: readonly PromptTokenDetail[];
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
  readonly multiplier?: string;
  readonly details?: string;
}

export type ToolSpecificData =
  | { readonly kind: 'terminal'; commandLine?: string; exitCode?: number; duration?: number; output?: string; cwd?: string; autoApproveInfo?: string }
  | { readonly kind: 'todoList'; items: readonly { id: string; title: string; status: string }[] }
  | { readonly kind: 'input'; rawInput: Record<string, unknown> }
  | { readonly kind: 'subagent'; agentName?: string; description?: string; prompt?: string; result?: string }
  | { readonly kind: 'unknown'; raw: unknown };

export interface ResultDetails {
  readonly input?: string;
  readonly output?: readonly { value?: string }[];
  readonly isError?: boolean;
}
