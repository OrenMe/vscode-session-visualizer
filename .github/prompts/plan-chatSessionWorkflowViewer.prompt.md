# Plan: Chat Session Workflow Viewer Extension

## TL;DR

Build a standalone VS Code extension that reads chat session files from VS Code's internal storage, lists them in a sidebar tree view, shows session metadata on click, and renders an interactive agent workflow diagram using React Flow + dagre in a webview editor panel.

## Architecture Overview

The extension has three main components:

1. **Session Tree View** — sidebar panel listing sessions from the current workspace's `chatSessions/` directory
2. **Metadata Panel** — webview shown on session click with stats, timing, model info, tool usage summary
3. **Workflow Diagram Editor** — webview panel rendering a React Flow graph of the agent workflow (user prompts → LLM responses → tool calls → sub-agents → thinking blocks)

---

## Implementation Steps

### Phase 1: Project Scaffolding

#### Step 1: Initialize extension project

Target VS Code `^1.96.0` (for modern webview and fs APIs).

**Project structure:**
- TypeScript extension with `esbuild` bundler
- Two separate esbuild entry points:
  - Extension host (`src/extension.ts` → `dist/extension.js`)
  - Webview React app (`webview/index.tsx` → `dist/webview.js`)
- Dependencies:
  - Core: `@xyflow/react`, `dagre`, `react@18`, `react-dom@18`
  - Dev: `esbuild`, `typescript`, `@types/node`, `@types/react`, `@types/react-dom`

**Directory structure:**
```
chat-workflow-viewer/
├── package.json
├── tsconfig.json
├── esbuild.mjs
├── src/
│   └── (extension TypeScript files)
├── webview/
│   └── (React app TypeScript files)
├── dist/
│   ├── extension.js
│   └── webview.js
```

#### Step 2: Define package.json contribution points

**Contributions to declare:**

1. **Views & View Containers:**
   - New activity bar icon (e.g., a flow/diagram icon)
   - View container ID: `chatWorkflowExplorer`
   - View ID: `chatSessionList`
   - Place: sidebar in the new container

2. **Commands:**
   - `chatWorkflow.openDiagram` — open workflow diagram for a session
   - `chatWorkflow.refresh` — refresh session list
   - `chatWorkflow.showMetadata` — show metadata panel for a session

3. **Menus:**
   - Context menu on tree view items with group: `1_modification`
     - `chatWorkflow.openDiagram`
     - `chatWorkflow.showMetadata`
   - When condition: `view == chatSessionList`

4. **Configuration (optional):**
   - `chatWorkflow.sessionStoragePath` — optional manual override for storage path discovery
   - `chatWorkflow.sortBy` — "date" or "title" (default: "date")
   - `chatWorkflow.autoRefresh` — enable auto-refresh on file changes (default: true)

---

### Phase 2: Session Discovery & Parsing

#### Step 3: Session storage path discovery

**Objective:** Compute the path to the current workspace's `chatSessions/` directory.

**Algorithm:**

```
From context.storageUri (e.g., file:///Users/.../User/workspaceStorage/WORKSPACE_ID/EXTENSION_ID):
  Navigate up to workspaceStorage/WORKSPACE_ID/:
    chatStoragePath = {workspaceStorageParent}/{workspaceId}/chatSessions

For empty windows (context.storageUri is undefined):
  Use context.globalStorageUri (e.g., file:///Users/.../User/globalStorage/EXTENSION_ID)
  Navigate up to globalStorage/ (go up 2 levels)
  Then append: /emptyWindowChatSessions
```

**Implement:**
- Function `getSessionStoragePath(context: ExtensionContext): Uri`
- Use `vscode.Uri.file()` and `path.dirname()` / `path.join()` for path manipulation
- Add error handling for unexpected directory structures

#### Step 4: Session file discovery

**Objective:** List all chat session files in the storage directory.

**Implementation:**
- Use `vscode.workspace.fs.readDirectory(storageUri)`
- Filter for `.json` and `.jsonl` files
- Return array of `{ filename: string, type: 'json' | 'jsonl' }`
- Handle case where directory doesn't exist yet (return empty array)

**Implement:**
- Function `discoverSessionFiles(storageUri: Uri): Promise<SessionFileInfo[]>`

#### Step 5: Session file parser (`.json`)

**Objective:** Parse `.json` format files into `ISerializableChatData` v3.

**Implementation:**
- Simple `JSON.parse()` + TypeScript interface validation
- Define local interfaces (`types.ts`):
  ```typescript
  interface ISerializableChatData {
    version: 3;
    sessionId: string;
    creationDate: number;
    customTitle?: string;
    responderUsername: string;
    initialLocation?: ChatAgentLocation;
    requests: ISerializableChatRequestData[];
    hasPendingEdits?: boolean;
    repoData?: IExportableRepoData;
    pendingRequests?: unknown[];
    inputState?: unknown;
  }

  interface ISerializableChatRequestData {
    requestId: string;
    message: string | { text: string; parts: Array<{ text: string }> };
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
    modelState?: ResponseModelStateT;
    vote?: ChatAgentVoteDirection;
    voteDownReason?: string;
    slashCommand?: unknown;
    usedContext?: unknown;
    contentReferences?: unknown[];
    codeCitations?: unknown[];
    timeSpentWaiting?: number;
  }

  type SerializedChatResponsePart = 
    | { kind: 'markdownContent'; value: string }
    | { kind: 'thinking'; value: string | string[] }
    | { kind: 'toolInvocationSerialized'; ... }
    | { kind: 'progressMessage'; ... }
    | ... etc

  interface IChatToolInvocationSerialized {
    kind: 'toolInvocationSerialized';
    toolId: string;
    toolCallId: string;
    invocationMessage: string | { value: string };
    pastTenseMessage?: string | { value: string };
    isComplete: boolean;
    isConfirmed?: boolean | string;
    subAgentInvocationId?: string;
    toolSpecificData?: unknown; // IChatSubagentToolInvocationData | other
  }

  interface IChatSubagentToolInvocationData {
    kind: 'subagent';
    agentName?: string;
    description?: string;
    prompt?: string;
    result?: string;
  }
  ```
- Function `parseJsonSession(content: string): Promise<ISerializableChatData>`
- Add try-catch with error reporting

#### Step 6: Session file parser (`.jsonl`)

**Objective:** Parse `.jsonl` (newline-delimited) format using the `ObjectMutationLog` replay algorithm.

**JSONL Format:**
```
{"kind":0,"v":{...full ISerializableChatData...}}
{"kind":1,"k":["requests",0,"response",1],"v":{...new value...}}
{"kind":2,"k":["requests"],"v":[{...items to append...}]}
{"kind":3,"k":["requests",0,"isHidden"]}
```

**Replay algorithm:**
```
1. Parse first line → should be kind=0 (Initial), extract full state as base
2. For each subsequent line:
   - Parse JSON
   - kind=1 (Set): `setIn(base, line.k, line.v)`
   - kind=2 (Push): `appendAt(base, line.k, line.v)`
   - kind=3 (Delete): `deleteAt(base, line.k)`
3. Return final base state
```

**Implement:**
- Helper functions:
  - `setIn(obj: any, path: string[], value: any): void` — navigate path, set value
  - `appendAt(obj: any, path: string[], items: any[]): void` — navigate path, splice items into array
  - `deleteAt(obj: any, path: string[]): void` — navigate path, delete key or array index
- Function `parseJsonlSession(content: string): Promise<ISerializableChatData>`
- Add bounds checking and error handling for malformed JSONL

#### Step 7: Session metadata caching

**Objective:** Cache parsed metadata in memory for fast tree rendering.

**Implementation:**
- Map: `Map<sessionId, SessionMetadata>`
  ```typescript
  interface SessionMetadata {
    sessionId: string;
    filename: string;
    title: string; // customTitle or first message
    creationDate: number;
    turnCount: number;
    lastResponseState?: ResponseModelState;
    modelIds: string[];
    agents: string[];
    toolCount: number;
    subAgentCount: number;
    thinkingBlockCount: number;
    parsedFull?: ISerializableChatData; // cached full data
  }
  ```
- Quick parse: read JSONL first line only (kind=0) to extract metadata without full replay
- Invalidate cache when file watcher fires

---

### Phase 3: Tree View (Sidebar)

#### Step 8: Implement ChatSessionTreeDataProvider

**Objective:** Display sessions in a tree view with fast refresh on file changes.

**Implementation:**
- Class `ChatSessionTreeDataProvider implements TreeDataProvider<ChatSessionItem>`
  ```typescript
  interface ChatSessionItem {
    type: 'session';
    id: string;
    metadata: SessionMetadata;
  }
  ```
- Methods:
  - `async getChildren(element?: ChatSessionItem): Promise<ChatSessionItem[]>`
    - If element is undefined: return root sessions (sorted by metadata.creationDate descending)
    - If element is a session: return empty (no children)
  - `getTreeItem(element: ChatSessionItem): TreeItem`
    - Label: `metadata.title` (truncate > 60 chars)
    - Description: relative date (e.g., "2 hours ago") + turn count (e.g., "5 turns")
    - Icon:
      - ✓ (check) if `lastResponseState === 'complete'`
      - ✗ (error) if `lastResponseState === 'failed'`
      - ⊘ (circle with slash) if `lastResponseState === 'cancelled'`
      - ⋯ (ellipsis) if `lastResponseState === 'in-progress'`
    - ContextValue: `'chatSession'` (for context menu filtering)
  - `onDidChangeTreeData: Event<ChatSessionItem | undefined>` — fire when:
    - User clicks refresh
    - File watcher detects changes to `*.json` / `*.jsonl` files

- Setup:
  - `vscode.window.registerTreeDataProvider('chatSessionList', provider)`
  - Also call `vscode.window.createTreeView('chatSessionList', { treeDataProvider: provider })`

- File watcher:
  ```typescript
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(storageUri, '*.{json,jsonl}'),
    false, false, false
  );
  watcher.onDidChange(() => this.invalidateAndRefresh());
  watcher.onDidCreate(() => this.invalidateAndRefresh());
  watcher.onDidDelete(() => this.invalidateAndRefresh());
  ```

#### Step 9: Add tree view toolbar actions

**Objective:** Add refresh and sort controls.

**Implementation:**
- Command `chatWorkflow.refresh`:
  - Clear metadata cache
  - Fire `onDidChangeTreeData` with `undefined` (refresh all)
  - Show brief status message ("Chat sessions refreshed")
- Command `chatWorkflow.toggleSort`:
  - Toggle `sortBy` config between "date" and "title"
  - Fire `onDidChangeTreeData`
- Add to `TreeView.title` a button that calls refresh (via command)

---

### Phase 4: Metadata Panel

#### Step 10: Implement metadata webview provider

**Objective:** Show session stats when a tree item is clicked.

**Implementation:**
- Listen to `TreeView.onDidChangeSelection` event
- When a session is selected:
  - Parse full session data (use cached `parsedFull` if available)
  - Compute metadata:
    ```typescript
    {
      sessionId: string;
      creationDate: Date;
      customTitle?: string;
      responderUsername: string;
      initialLocation?: ChatAgentLocation;
      turnCount: number; // requests + responses
      models: { [modelId: string]: number }; // model usage count
      agents: { [agentId: string]: number }; // agent usage count
      tools: { [toolId: string]: number }; // tool invocation count
      subAgents: { [agentName: string]: number }; // sub-agent count per agent
      thinkingBlockCount: number;
      thinkingTextTotal: number; // total characters
      responseStates: { complete: number; failed: number; cancelled: number };
      totalDuration: number; // ms from first request to last response
      contentReferencesTotal: number;
      codeCitationsTotal: number;
    }
    ```
  - Display in either:
    - A dedicated `WebviewPanel` (separate window)
    - Or inline in the tree view's description (simpler, but limited space)
    - Recommend: dedicated webview panel for better readability

- Webview HTML:
  ```html
  <body>
    <h2>{{ title }}</h2>
    <dl>
      <dt>Session ID:</dt> <dd>{{ sessionId }}</dd>
      <dt>Created:</dt> <dd>{{ formatDate(creationDate) }}</dd>
      <dt>Duration:</dt> <dd>{{ formatDuration(totalDuration) }}</dd>
      <dt>Turns:</dt> <dd>{{ turnCount }}</dd>
      <dt>Models Used:</dt> <dd>{{ JSON.stringify(models) }}</dd>
      <dt>Agents:</dt> <dd>{{ JSON.stringify(agents) }}</dd>
      <dt>Tools Called:</dt> <dd>{{ JSON.stringify(tools) }}</dd>
      <dt>Sub-Agents:</dt> <dd>{{ JSON.stringify(subAgents) }}</dd>
      <dt>Thinking Blocks:</dt> <dd>{{ thinkingBlockCount }} ({{ thinkingTextTotal }} chars)</dd>
      <dt>Response States:</dt> <dd>✓ {{ responseStates.complete }} | ✗ {{ responseStates.failed }} | ⊘ {{ responseStates.cancelled }}</dd>
      <dt>References:</dt> <dd>{{ contentReferencesTotal }} | Citations: {{ codeCitationsTotal }}</dd>
    </dl>
    <button onclick="openDiagram()">Open Workflow Diagram</button>
  </body>
  ```

---

### Phase 5: Workflow Diagram (React Flow)

#### Step 11: Build the graph data model transformer

**Objective:** Convert `ISerializableChatData` into React Flow nodes and edges.

**Node types:**
- `userRequest` — Blue box, user message (truncated), icon: user
- `agentResponse` — Green (complete) / Red (failed) / Yellow (cancelled) box, agent name + response state, icon: check/error/warning
- `toolInvocation` — Purple box, tool ID + invocation message (truncated), icon: wrench
- `subAgent` — Orange box, agent name + description, icon: robot
- `thinking` — Gray collapsed box (expandable), "🧠 Thinking", icon: brain

**Edge types:**
- `default` (straight) for most connections
- Label text: tool ID for request → tool transfers, "result" for tool → response

**Algorithm:**
```
nodes = []
edges = []
nodeIdCounter = 0

for each request in session.requests:
  // User request node
  userRequestNodeId = generateId('userRequest')
  nodes.push({
    id: userRequestNodeId,
    type: 'userRequest',
    data: {
      text: request.message.text || request.message[0].text,
      timestamp: request.timestamp,
      variableCount: request.variableData.variables.length
    },
    position: { x: 0, y: 0 } // to be set by dagre
  })

  // Response node (if exists)
  if request.response:
    agentResponseNodeId = generateId('agentResponse')
    nodes.push({
      id: agentResponseNodeId,
      type: 'agentResponse',
      data: {
        agent: request.agent.name,
        state: request.modelState.value, // 'complete' | 'failed' | 'cancelled'
        responseLength: request.response.length,
        responsePreview: first 100 chars of response
      },
      position: { x: 0, y: 100 }
    })
    
    edges.push({
      id: `${userRequestNodeId}->${agentResponseNodeId}`,
      source: userRequestNodeId,
      target: agentResponseNodeId,
      type: 'default'
    })

    // Response parts (tool invocations, thinking, etc.)
    for each part in request.response:
      if part.kind === 'thinking':
        thinkingNodeId = generateId('thinking')
        nodes.push({
          id: thinkingNodeId,
          type: 'thinking',
          data: { text: part.value.slice(0, 200) },
          position: { x: 0, y: 200 }
        })
        edges.push({
          id: `${agentResponseNodeId}->${thinkingNodeId}`,
          source: agentResponseNodeId,
          target: thinkingNodeId
        })

      if part.kind === 'toolInvocationSerialized':
        toolInvoNodeId = generateId('toolInvocation')
        nodes.push({
          id: toolInvoNodeId,
          type: 'toolInvocation',
          data: {
            toolId: part.toolId,
            invocationMessage: part.invocationMessage,
            isComplete: part.isComplete,
            isConfirmed: part.isConfirmed
          },
          position: { x: 0, y: 300 }
        })
        edges.push({
          id: `${agentResponseNodeId}->${toolInvoNodeId}`,
          source: agentResponseNodeId,
          target: toolInvoNodeId,
          label: part.toolId
        })

        if part.toolId === 'runSubagent' && part.toolSpecificData.kind === 'subagent':
          subAgentNodeId = generateId('subAgent')
          nodes.push({
            id: subAgentNodeId,
            type: 'subAgent',
            data: {
              agentName: part.toolSpecificData.agentName,
              description: part.toolSpecificData.description,
              prompt: part.toolSpecificData.prompt,
              result: part.toolSpecificData.result
            },
            position: { x: 0, y: 400 }
          })
          edges.push({
            id: `${toolInvoNodeId}->${subAgentNodeId}`,
            source: toolInvoNodeId,
            target: subAgentNodeId
          })

// Apply dagre layout
layoutedNodes = dagreLayout(nodes, edges, { rankdir: 'TB' })

return { nodes: layoutedNodes, edges }
```

**Implement:**
- Function `sessionToGraphData(session: ISerializableChatData): { nodes: Node[]; edges: Edge[] }`
- File: `src/graphTransformer.ts`

#### Step 12: Build React webview app

**Objective:** Render the React Flow diagram with custom nodes.

**Structure:**
```
webview/
├── index.tsx               # ReactDOM.render(<App />)
├── App.tsx                 # Root component, receives session data
├── WorkflowDiagram.tsx     # <ReactFlow /> wrapper with dagre layout
├── nodes/
│   ├── UserRequestNode.tsx
│   ├── AgentResponseNode.tsx
│   ├── ToolInvocationNode.tsx
│   ├── SubAgentNode.tsx
│   └── ThinkingNode.tsx
├── styles.css              # VS Code theme variables
└── vscodeApi.ts            # acquireVsCodeApi() wrapper
```

**App.tsx:**
```typescript
export default function App() {
  const vscode = acquireVsCodeApi();
  const [sessionData, setSessionData] = useState(null);
  const [graphData, setGraphData] = useState({ nodes: [], edges: [] });

  useEffect(() => {
    window.addEventListener('message', (event) => {
      const { type, data } = event.data;
      if (type === 'setSessionData') {
        setSessionData(data);
        const graph = sessionToGraphData(data);
        setGraphData(graph);
      }
    });
  }, []);

  return (
    <div style={{ width: '100%', height: '100vh' }}>
      {graphData.nodes.length > 0 ? (
        <WorkflowDiagram nodes={graphData.nodes} edges={graphData.edges} />
      ) : (
        <div>Loading workflow...</div>
      )}
    </div>
  );
}
```

**WorkflowDiagram.tsx:**
```typescript
export default function WorkflowDiagram({ nodes, edges }) {
  const [selectedNode, setSelectedNode] = useState(null);

  const nodeTypes = useMemo(
    () => ({
      userRequest: UserRequestNode,
      agentResponse: AgentResponseNode,
      toolInvocation: ToolInvocationNode,
      subAgent: SubAgentNode,
      thinking: ThinkingNode,
    }),
    []
  );

  return (
    <>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={(event, node) => setSelectedNode(node)}
      >
        <Background />
        <Controls />
        <MiniMap />
      </ReactFlow>
      {selectedNode && (
        <div style={{ position: 'absolute', right: 0, top: 0, width: '300px', height: '100%', background: '#f0f0f0', overflow: 'auto', padding: '16px' }}>
          <h3>Node Details</h3>
          <pre>{JSON.stringify(selectedNode.data, null, 2)}</pre>
          <button onClick={() => setSelectedNode(null)}>Close</button>
        </div>
      )}
    </>
  );
}
```

**Custom node components** (example):
```typescript
// UserRequestNode.tsx
const UserRequestNode = ({ data }) => (
  <div style={{ padding: '10px', border: '2px solid #0066cc', borderRadius: '8px', background: '#e3f2fd' }}>
    <div style={{ fontWeight: 'bold' }}>👤 User</div>
    <div style={{ fontSize: '12px', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
      {data.text}
    </div>
    <div style={{ fontSize: '10px', color: '#999' }}>
      {new Date(data.timestamp).toLocaleTimeString()}
    </div>
    <Handle type="target" position={Position.Top} />
    <Handle type="source" position={Position.Bottom} />
  </div>
);
```

**Styling with VS Code theme variables** (styles.css):
```css
:root {
  --background: var(--vscode-editor-background);
  --foreground: var(--vscode-editor-foreground);
  --input-background: var(--vscode-input-background);
  --input-border: var(--vscode-input-border);
  --button-background: var(--vscode-button-background);
  --button-foreground: var(--vscode-button-foreground);
}

body {
  background: var(--background);
  color: var(--foreground);
  font-family: var(--vscode-font-family);
  margin: 0;
  padding: 0;
}

.react-flow { background: var(--background) !important; }
.react-flow__edge { stroke: var(--foreground); }
.react-flow__handle { background: var(--vscode-activityBar-background); }
```

#### Step 13: Build webview panel provider

**Objective:** Create and manage the webview panel for diagram rendering.

**Implementation:**
- Command `chatWorkflow.openDiagram`:
  ```typescript
  vscode.commands.registerCommand('chatWorkflow.openDiagram', async (sessionItem: ChatSessionItem) => {
    const panel = vscode.window.createWebviewPanel(
      'chatWorkflowDiagram',
      `Workflow: ${sessionItem.metadata.title}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(context.extensionPath + '/dist')]
      }
    );

    // Read and parse session file
    const sessionData = await parseSessionFile(sessionItem.metadata.filename);
    
    // Load webview HTML
    const webviewUri = panel.webview.asWebviewUri(vscode.Uri.file(...));
    panel.webview.html = getWebviewContent(webviewUri);

    // Send session data to webview
    panel.webview.postMessage({
      type: 'setSessionData',
      data: sessionData
    });

    // Handle messages from webview
    panel.webview.onDidReceiveMessage((message) => {
      if (message.type === 'nodeClicked') {
        console.log('Node clicked:', message.nodeId);
      }
    });
  });
  ```

- Helper `getWebviewContent(webviewUri)`:
  ```html
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Workflow Diagram</title>
  </head>
  <body>
    <div id="root" style="width: 100%; height: 100vh;"></div>
    <script src="${webviewUri}"></script>
  </body>
  </html>
  ```

---

### Phase 6: Polish & Error Handling

#### Step 14: Error handling

**Objective:** Handle corrupted files, missing data, large sessions gracefully.

**Scenarios:**
- Missing `chatSessions/` directory → show "No sessions found" in tree
- Corrupt `.json` file → catch JSON parse error, show error icon in tree with error message on hover
- Corrupt `.jsonl` file → catch replay error, show warning, offer to use fallback data
- Empty session (no requests) → show in tree but disable diagram button
- Very large session (200+ turns) → show warning, lazy-load or paginate the graph
- Session file being actively written → read what's available, show reload button
- React Flow rendering errors → show error boundary with message

#### Step 15: Manual verification

**Test scenarios:**

1. **Tree view:**
   - [ ] Activate extension in a workspace with existing chat sessions
   - [ ] Verify tree populates with session titles sorted by date
   - [ ] Verify relative date display (e.g., "2 hours ago")
   - [ ] Verify turn count in description
   - [ ] Verify state icons (✓ / ✗ / ⊘)
   - [ ] Click refresh → tree updates
   - [ ] Manually create a new session file → auto-refresh triggers

2. **Metadata panel:**
   - [ ] Click a session in tree → metadata panel opens
   - [ ] Verify all stats are accurate (turn count, model names, tool names, etc.)
   - [ ] Verify dates formatted correctly
   - [ ] Verify durations calculated correctly

3. **Workflow diagram:**
   - [ ] Click "Open Workflow Diagram" → webview panel opens
   - [ ] Verify nodes render with correct labels and colors
   - [ ] Verify edges connect nodes correctly
   - [ ] Verify dagre layout positions nodes in a tree structure (top-to-bottom)
   - [ ] Test zoom/pan controls
   - [ ] Test minimap
   - [ ] Click on a node → details panel shows in right panel
   - [ ] Verify VS Code light/dark/high-contrast theme colors applied correctly

4. **Edge cases:**
   - [ ] Empty session (no requests) → don't crash
   - [ ] Session with 200+ turns → diagram renders (can test with synthetic data)
   - [ ] Corrupt `.json` file → show error in tree
   - [ ] Manually delete a session file while viewing → handle gracefully
   - [ ] Very long user prompt / response text → truncate with ellipsis

---

## Relevant Files (VS Code internals — reference only, not modified)

- `src/vs/workbench/contrib/chat/common/model/chatSessionStore.ts` — storage paths logic, `getChatStorageFolder()`, file format (`.json` vs `.jsonl`)
- `src/vs/workbench/contrib/chat/common/model/chatModel.ts` — `ISerializableChatData` (v3), `ISerializableChatRequestData`, `ISerializableChatResponseData`, `SerializedChatResponsePart` type union
- `src/vs/workbench/contrib/chat/common/model/chatSessionOperationLog.ts` — JSONL mutation log schema (Initial/Set/Push/Delete operations)
- `src/vs/workbench/contrib/chat/common/model/objectMutationLog.ts` — generic `ObjectMutationLog` replay algorithm
- `src/vs/workbench/contrib/chat/common/chatService/chatService.ts` — `IChatToolInvocationSerialized` (tool call data), `IChatSubagentToolInvocationData` (sub-agent data)
- `src/vs/workbench/contrib/chat/browser/actions/chatImportExport.ts` — existing export/import commands (reference for `toExport()` shape)

---

## Extension File Structure

```
chat-workflow-viewer/
├── package.json                      # Extension manifest
├── tsconfig.json
├── esbuild.mjs                       # Build script
├── src/
│   ├── extension.ts                  # Activation, command registration, main coordination
│   ├── sessionDiscovery.ts           # Get storage path, discover session files
│   ├── sessionParser.ts              # Parse .json files
│   ├── jsonlReplay.ts                # Parse .jsonl files (JSONL replay algorithm)
│   ├── sessionMetadata.ts            # Extract metadata from parsed sessions
│   ├── types.ts                      # TypeScript interfaces (mirrored from VS Code internals)
│   ├── treeView.ts                   # ChatSessionTreeDataProvider
│   ├── metadataPanel.ts              # Metadata webview provider
│   ├── graphTransformer.ts           # Convert session to React Flow nodes/edges
│   ├── diagramPanel.ts               # WebviewPanel provider for diagram
│   └── utils.ts                      # Helpers (format date, format duration, etc.)
├── webview/
│   ├── index.tsx                     # React entry, ReactDOM.render
│   ├── App.tsx                       # Root component
│   ├── WorkflowDiagram.tsx           # React Flow wrapper
│   ├── nodes/
│   │   ├── UserRequestNode.tsx
│   │   ├── AgentResponseNode.tsx
│   │   ├── ToolInvocationNode.tsx
│   │   ├── SubAgentNode.tsx
│   │   └── ThinkingNode.tsx
│   ├── styles.css                    # VS Code theme variables
│   ├── vscodeApi.ts                  # acquireVsCodeApi() wrapper & types
│   └── sessionToGraphData.ts         # Webview-side version of graphTransformer
└── README.md
```

---

## Verification & Testing

### Unit Tests

1. **`sessionParser.test.ts`** — test `.json` parsing with valid/invalid fixtures
2. **`jsonlReplay.test.ts`** — test `.jsonl` replay algorithm with various operations
3. **`graphTransformer.test.ts`** — test session → graph conversion with known shapes

### Integration Tests

1. **Activate in a workspace with chat sessions** — verify tree populates correctly
2. **Click a session** → verify metadata panel shows expected stats
3. **Open workflow diagram** → verify React Flow renders nodes/edges

### Manual Tests

1. Tree view — date sorting, icons, refresh, auto-refresh on file change
2. Metadata panel — accuracy of all stats
3. Workflow diagram — rendering, zoom/pan, node click details
4. Themes — light, dark, high-contrast
5. Edge cases — corrupt files, large sessions, empty sessions

---

## Key Decisions

| Decision | Rationale |
|----------|-----------|
| React Flow + dagre | User preference; dagre is simple and effective for tree-like agent workflows |
| Current workspace only | Simpler initial scope; can add multi-workspace browsing later |
| Full detail diagram | Shows complete agent execution flow (prompts, responses, tools, sub-agents, thinking) |
| Standalone extension | Own repo, publishable to marketplace |
| Storage path derived from `context.storageUri` | Only way without public API; includes manual override setting as fallback |
| Support `.json` and `.jsonl` | `.jsonl` preferred (newer format); `.json` for backward compat |
| WebviewPanel, not CustomEditor | We're viewing, not editing; simpler UX |

---

## Further Considerations

1. **Storage path stability** — The chat session storage path format is internal to VS Code and may change between versions. Mitigate by adding a `chatWorkflow.sessionStoragePath` setting for manual override.

2. **JSONL replay complexity** — The `ObjectMutationLog` format with nested path replay is non-trivial. Alternative: support only `.json` files initially, defer `.jsonl` support to a later version to reduce initial scope.

3. **Diagram export** — Consider adding an "Export as SVG/PNG" button. React Flow supports `toObject()` + libraries like `html-to-image` or `canvas` rendering.

4. **Performance on large sessions** — Sessions with 200+ turns produce large node/edge arrays. Solutions:
   - Lazy-load: show first N turns, button to load more
   - Virtualize: only render visible nodes (React Flow's performance features)
   - Paginate: split into "Request 1-10" / "Request 11-20" etc.

5. **Sub-agent nesting** — If a sub-agent call has its own inner tool calls/responses, render as a sub-flow (React Flow's sub-flows feature) for better visualization.

6. **Keyboard shortcuts** — Add shortcuts: `Ctrl+Shift+W` to toggle tree view, `Ctrl+Enter` to open diagram from tree, `Escape` to close metadata panel.

7. **Accessibility** — Ensure tree view and diagram are keyboard-navigable, semantic HTML, ARIA labels, sufficient color contrast.

---

## Implementation Order Recommendation

1. Phase 1 (scaffolding) — 2-3 hours
2. Phase 2 (parsing) — 3-4 hours (JSONL replay is the most complex)
3. Phase 3 (tree view) — 2 hours
4. Phase 4 (metadata) — 1.5 hours
5. Phase 5.a (graph transformer) — 1.5 hours
6. Phase 5.b (React webview) — 3-4 hours (custom nodes, styling)
7. Phase 5.c (panel provider) — 1 hour
8. Phase 6 (polish, testing) — 2-3 hours

**Estimated total: 14-18 hours** for a fully functional MVP.

---

## Success Criteria

- [ ] Extension activates without errors
- [ ] Tree view displays all sessions from current workspace's `chatSessions/` dir
- [ ] Metadata panel shows accurate stats for each session
- [ ] Workflow diagram renders nodes and edges correctly for all session types (simple + multi-turn + tools + sub-agents)
- [ ] Diagram layout is clean and readable (dagre top-to-bottom)
- [ ] VS Code light/dark/high-contrast themes applied correctly
- [ ] No crashes on corrupt files or edge cases
- [ ] Performance: tree refresh < 1 sec, diagram render < 2 sec even for 100-turn sessions
- [ ] README documents usage, limitations, and development setup
- [ ] Ready for marketplace publication
