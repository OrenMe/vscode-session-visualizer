# Plan: Streamable Nested Graph Data Structure for Chat Session Visualizer

## TL;DR

Redesign the data pipeline in `vscode-session-visualizer` to introduce a **streamable intermediate representation (IR)** — a normalized tree of typed session nodes — that sits between JSONL mutation replay and React Flow rendering. This IR supports incremental per-turn updates (for live tailing) and progressive rendering (for replay), and cleanly maps to React Flow's node/edge model with expandable nesting. The current two-pass approach (full replay → full graph build) becomes a single streaming pipeline: mutation → IR patch → visible graph diff.

## Context

- **Source format**: VS Code internal `workspaceStorage/<hash>/chatSessions/*.jsonl` — a mutation log (kind 0=Initial, 1=Set, 2=Push, 3=Delete) replayed to reconstruct an `ISerializableChatData` object
- **Current implementation**: Full replay via `parseJsonlSessionAsync()` → `sessionToGraphData()` → `buildVisibleGraph()` → React Flow render
- **Current nesting**: Spine (user→agent) + 1 level expand (tools/thinking/subAgents) + 1 more level for subAgent tools = max 3 levels
- **Goal**: Support per-turn streaming, keep 1-level sub-agent nesting, and create a well-typed tree structure that React Flow can incrementally render

## Steps

### Phase 1: Define the Intermediate Representation (IR)

1. **Create `src/sessionIR.ts`** — the normalized tree data structure:
   - `SessionGraph` — root container: `{ sessionId, title, creationDate, turns: TurnNode[] }`
   - `TurnNode` — one request/response pair: `{ turnIndex, request: RequestNode, response: ResponseNode | null }`
   - `RequestNode` — user side: `{ id, text, timestamp, modelId, variables, waitTime }`
   - `ResponseNode` — agent side: `{ id, agent, state, modelId, timestamp, duration, ttft, tokens, vote, error, children: ResponseChildNode[] }`
   - `ResponseChildNode` — discriminated union (`type` field):
     - `ToolNode`: `{ type: 'tool', toolId, toolCallId, message, pastTense, isComplete, isConfirmed, source, isMcp, uris, specificData, resultDetails }`
     - `ThinkingNode`: `{ type: 'thinking', text, wordCount, charCount, lineCount }`
     - `SubAgentNode`: `{ type: 'subAgent', agentName, description, prompt, result, parentToolId, children: ToolNode[] }`
     - `EditGroupNode`: `{ type: 'editGroup', uri, editCount, edits }`
     - `ElicitationNode`: `{ type: 'elicitation', title, message, state }`
   - `MarkdownSummary` — extracted prose: `{ preview, fullText, length }`
   - Use `readonly` throughout; new objects on mutation (immutable updates for React diffing)
   - Each node gets a stable `id` string for React Flow identity

2. **Create `src/sessionIR.spec.ts`** — unit tests for the IR builder functions

*depends on nothing*

### Phase 2: Streaming JSONL Replay with Turn-Boundary Events

3. **Create `src/streamingReplay.ts`** — a streaming mutation replay that emits `SessionGraph` patches at turn boundaries:
   - `StreamingSessionReplay` class wrapping a `readline` interface or `fs.watch` tail
   - Maintains the mutable `ISerializableChatData` state (same replay logic as `jsonlReplay.ts`)
   - Detects turn boundaries by watching for mutations at path `['requests', N, 'modelState']` with `value` containing `completedAt` or state change — this signals a completed turn
   - Also detects new turn additions via Push at `['requests']` path
   - On each turn boundary, calls `buildTurnNode(requestIndex)` to produce the IR for that turn
   - Emits events: `onTurnAdded(turnNode)`, `onTurnUpdated(turnIndex, turnNode)`, `onSessionMeta(title, sessionId)`
   - For file-watch mode: uses `fs.watch` + read new bytes from last offset (tail -f style)
   - For batch mode: replays all mutations, emitting turn events as they complete (for progressive rendering)

4. **Update `src/sessionLoader.ts`** — add `loadSessionStreaming()` that returns a `StreamingSessionReplay` instead of awaiting full parse

*depends on step 1*

### Phase 3: IR → React Flow Graph Mapping

5. **Create `webview/irToGraphData.ts`** — replace `sessionToGraphData.ts` with a function that maps `SessionGraph` → React Flow nodes/edges:
   - `sessionGraphToSpine(graph: SessionGraph): { nodes: Node[], edges: Edge[] }` — builds the vertical spine
   - Each `TurnNode` → 1 `userRequest` node + 1 `agentResponse` node (if response exists)
   - `ResponseNode.children` stored as `childNodes` on the agent node data (same expand pattern)
   - `SubAgentNode.children` stored as nested `childNodes` on the subAgent data
   - Much simpler than current `sessionToGraphData.ts` because deduplication and classification already happened in IR builder
   - Supports incremental updates: `appendTurnToSpine(existing, newTurn)` adds nodes/edges without rebuilding

6. **Update `webview/App.tsx`** — wire streaming:
   - Listen for `addTurn` / `updateTurn` messages from extension host (in addition to current `setSessionData`)
   - Maintain `SessionGraph` state, incrementally update spine nodes
   - For batch load: receive all turns at once (backward compat)

*depends on steps 1, 3*

### Phase 4: IR Builder (replaces `sessionToGraphData.ts` logic)

7. **Create `src/irBuilder.ts`** — the core transformation from `ISerializableChatRequestData` → `TurnNode`:
   - `buildTurnNode(request, turnIndex): TurnNode` — single turn conversion
   - `buildSessionGraph(session: ISerializableChatData): SessionGraph` — full session conversion (calls `buildTurnNode` per request)
   - Encapsulates all current logic from `sessionToGraphData.ts`: tool call deduplication by `toolCallId`, subagent grouping by `subAgentInvocationId`, markdown extraction, thinking block assembly, edit group handling
   - This is the **single source of truth** for data transformation — both streaming and batch paths use it

8. **Create `src/irBuilder.spec.ts`** — unit tests with fixture data from `examples/` directory

*depends on step 1*

### Phase 5: Wire Everything Together

9. **Update `src/diagramPanel.ts`** — support both batch and streaming modes:
   - Batch: `loadFullSession` → `buildSessionGraph` → `postMessage('setSessionData', graph)`
   - Streaming: `loadSessionStreaming` → forward turn events as `postMessage('addTurn', turnNode)`

10. **Update `webview/WorkflowDiagram.tsx`** — no structural changes needed, `buildVisibleGraph` works the same since `childNodes` shape is preserved

11. **Deprecate `webview/sessionToGraphData.ts`** — replaced by `irBuilder.ts` (host side) + `irToGraphData.ts` (webview side)

*depends on steps 3, 4, 5, 6*

## Proposed IR Type Definitions

```typescript
// sessionIR.ts — All types are readonly for immutable React diffing

interface SessionGraph {
  readonly sessionId: string;
  readonly title: string;
  readonly creationDate: number;
  readonly responderUsername: string;
  readonly turns: readonly TurnNode[];
}

interface TurnNode {
  readonly turnIndex: number;
  readonly request: RequestNode;
  readonly response: ResponseNode | null;
}

interface RequestNode {
  readonly id: string;           // `user_${turnIndex}`
  readonly text: string;
  readonly fullText: string;
  readonly timestamp?: number;
  readonly modelId?: string;
  readonly requestId: string;
  readonly variables: readonly VariableRef[];
  readonly waitTime?: number;
}

interface VariableRef {
  readonly name: string;
  readonly id?: string;
}

interface ResponseNode {
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
  // Counts derived from children for badges
  readonly toolCount: number;
  readonly thinkingCount: number;
  readonly subAgentCount: number;
  readonly editGroupCount: number;
}

type ResponseChildNode = ToolNode | ThinkingNode | SubAgentNode | EditGroupNode | ElicitationNode;

interface ToolNode {
  readonly type: 'tool';
  readonly id: string;
  readonly toolId: string;
  readonly toolCallId: string;
  readonly message: string;
  readonly pastTenseMessage?: string;
  readonly isComplete: boolean;
  readonly isConfirmed?: boolean | string | { type: number; reason?: string };
  readonly source: { type: string; label: string };
  readonly isMcp: boolean;
  readonly uris: readonly string[];
  readonly specificData?: ToolSpecificData;
  readonly resultDetails?: ResultDetails;
  readonly generatedTitle?: string;
  readonly presentation?: string;
}

interface ThinkingNode {
  readonly type: 'thinking';
  readonly id: string;
  readonly text: string;
  readonly fullText: string;
  readonly wordCount: number;
  readonly charCount: number;
  readonly lineCount: number;
  readonly readingTimeSec: number;
}

interface SubAgentNode {
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

interface EditGroupNode {
  readonly type: 'editGroup';
  readonly id: string;
  readonly uri: string;
  readonly editCount: number;
  readonly edits: readonly unknown[];
}

interface ElicitationNode {
  readonly type: 'elicitation';
  readonly id: string;
  readonly title: string;
  readonly message: string;
  readonly state?: string;
}

interface MarkdownSummary {
  readonly preview: string;      // truncated to ~150 chars
  readonly fullText: string;     // up to 5000 chars
  readonly length: number;       // total char count
}

interface TokenUsage {
  readonly totalTokens?: number;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
}

type ToolSpecificData =
  | { readonly kind: 'terminal'; commandLine?: string; exitCode?: number; duration?: number; output?: string; cwd?: string }
  | { readonly kind: 'todoList'; items: readonly { id: string; title: string; status: string }[] }
  | { readonly kind: 'input'; rawInput: Record<string, unknown> }
  | { readonly kind: 'subagent'; agentName?: string; description?: string; prompt?: string; result?: string }
  | { readonly kind: 'unknown'; raw: unknown };

interface ResultDetails {
  readonly input?: string;
  readonly output?: readonly { value?: string }[];
  readonly isError?: boolean;
}
```

## Streaming Protocol (Extension Host ↔ Webview)

Messages sent via `postMessage`:

| Direction | Message | Payload | When |
|---|---|---|---|
| Host → Webview | `setSessionGraph` | `SessionGraph` | Full batch load |
| Host → Webview | `addTurn` | `TurnNode` | New turn detected (streaming) |
| Host → Webview | `updateTurn` | `{ turnIndex: number, turn: TurnNode }` | Turn state changed (e.g., response completed) |
| Host → Webview | `updateMeta` | `{ title?, sessionId? }` | Session title changed |
| Webview → Host | `showDiff` | `{ edits, uri }` | User clicks "View Edits" |

## Relevant Files

### Files to create
- `src/sessionIR.ts` — IR type definitions (the core data structure)
- `src/irBuilder.ts` — `ISerializableChatRequestData` → `TurnNode` transformation (replaces logic from `sessionToGraphData.ts`)
- `src/streamingReplay.ts` — streaming mutation replay with turn-boundary detection
- `webview/irToGraphData.ts` — `SessionGraph` → React Flow nodes/edges mapping
- `src/irBuilder.spec.ts` — tests for IR builder

### Files to modify
- `src/diagramPanel.ts` — support streaming mode alongside batch
- `src/sessionLoader.ts` — add streaming load entry point
- `webview/App.tsx` — handle streaming messages, maintain incremental state
- `webview/WorkflowDiagram.tsx` — minimal changes (childNodes shape preserved)

### Files to deprecate
- `webview/sessionToGraphData.ts` — replaced by `irBuilder.ts` + `irToGraphData.ts`

### Reference files (existing logic to extract and reuse)
- `webview/sessionToGraphData.ts` — current deduplication, subagent grouping, markdown extraction logic → move to `irBuilder.ts`
- `src/jsonlReplay.ts` — mutation replay functions (`navigateTo`, `setIn`, `appendAt`, `deleteAt`) → reuse in `streamingReplay.ts`
- `src/types.ts` — `ISerializableChatData`, `SerializedChatResponsePart`, `IChatToolInvocationSerialized` types → IR maps from these
- `src/sessionMetadata.ts` — `extractMetadata` logic for deduplication/counting → some logic moves to IR builder

## Verification

1. **Unit tests**: `irBuilder.spec.ts` — feed example `ISerializableChatRequestData` fixtures (from the 16 JSONL files in `examples/`), assert correct `TurnNode` structure, tool deduplication, subagent grouping
2. **Batch mode parity**: Load existing sessions via new pipeline (`buildSessionGraph` → `irToGraphData`), visually compare output with current `sessionToGraphData` output — same node count, same children, same data
3. **Streaming smoke test**: Open a live Copilot Chat session, watch the visualizer update per-turn as responses complete
4. **Edge cases**: Empty sessions, sessions with only user turns (no response), sessions with 100+ tool calls, sessions with subagents containing nested tools
5. **Performance**: Measure time for large JSONL files (10K+ mutations) — streaming should show first turn faster than batch
6. **Compilation**: `npm run build` (or esbuild watch) in the visualizer repo must pass with zero errors

## Decisions

- **1-level sub-agent nesting only** — confirmed by user; `SubAgentNode.children` is `ToolNode[]`, not recursive
- **Per-turn streaming granularity** — graph updates when a turn completes (modelState set), not per-mutation
- **Immutable IR** — all `readonly` for React reconciliation; new objects on each update
- **IR lives on extension host side** — transformation happens in Node.js, serialized to webview via `postMessage`. This keeps the webview simple and allows future features like search/filter on the IR
- **Backward compatible** — `setSessionData` message still supported for batch mode; streaming is additive
- **`sessionToGraphData.ts` deprecated but not deleted** — marked with deprecation comment, removed once streaming is stable
