# Chat Session Workflow Viewer

A VS Code extension that reads chat session files from VS Code's internal storage and renders interactive agent workflow diagrams.

## Features

- **Session Tree View** — sidebar panel listing sessions from the current workspace's `chatSessions/` directory
- **Metadata Panel** — session stats, timing, model info, tool usage summary
- **Workflow Diagram** — interactive React Flow graph of the agent workflow (user prompts → LLM responses → tool calls → sub-agents → thinking blocks)

## Usage

1. Open a workspace that has existing VS Code chat sessions
2. Click the flow/diagram icon in the activity bar to open the Chat Workflow Explorer
3. Click a session to view its metadata
4. Right-click a session and select "Open Workflow Diagram" to see the interactive workflow graph

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `chatWorkflow.sessionStoragePath` | `""` | Manual override for the chat sessions storage path |
| `chatWorkflow.sortBy` | `"date"` | Sort sessions by `"date"` or `"title"` |
| `chatWorkflow.autoRefresh` | `true` | Auto-refresh session list on file changes |

## Development

```bash
npm install
npm run build
```

Press F5 in VS Code to launch the Extension Development Host.

## Supported Formats

- `.json` — standard JSON session files
- `.jsonl` — newline-delimited mutation log format (ObjectMutationLog replay)
