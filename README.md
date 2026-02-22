# Chat Session Workflow Viewer

> Visualize VS Code chat session workflows as interactive diagrams.

Turn your Copilot Chat sessions into clear, navigable workflow graphs — see every user prompt, LLM response, tool invocation, sub-agent call, and thinking block at a glance.

<div align="center">

https://github.com/OrenMe/vscode-session-visualizer/raw/main/extension_demo.mp4

</div>

## Features

- **Session Explorer** — browse all chat sessions from the activity bar, filter by workspace, and search by title or message content
- **Interactive Workflow Diagram** — React Flow–powered graph showing the full agent workflow (user prompts → LLM responses → tool calls → sub-agents → thinking blocks)
- **Metadata Panel** — session stats including timing, model info, and tool usage summary
- **Multi-format Support** — reads both `.json` session files and `.jsonl` mutation logs

## Getting Started

1. Open a workspace that has existing VS Code chat sessions
2. Click the **Chat Workflow Explorer** icon in the activity bar
3. Click a session to view its metadata
4. Right-click a session and select **Open Workflow Diagram** to see the interactive workflow graph

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `chatWorkflow.sessionStoragePath` | `""` | Manual override for the chat sessions storage path |
| `chatWorkflow.sortBy` | `"date"` | Sort sessions by `"date"` or `"title"` |
| `chatWorkflow.autoRefresh` | `true` | Auto-refresh session list on file changes |

## Requirements

- VS Code 1.109.0 or later

## Known Issues

See [GitHub Issues](https://github.com/OrenMe/vscode-session-visualizer/issues).

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

```bash
npm install
npm run build
# Press F5 in VS Code to launch the Extension Development Host
```

## License

[MIT](LICENSE)
