import React, { Component, useState, useEffect } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { ReactFlowProvider, type Node, type Edge } from '@xyflow/react';
import WorkflowDiagram from './WorkflowDiagram';
import { sessionToGraphData } from './sessionToGraphData';
import { sessionGraphToSpine, appendTurnToSpine, updateTurnInSpine } from './irToGraphData';
import { getVsCodeApi } from './vscodeApi';
import type { SessionGraph, TurnNode } from '../src/sessionIR';

const SPINE_Y_GAP = 160;

class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error?: Error }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[SessionVisualizer] Render error:', error, info.componentStack);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: '24px',
          color: 'var(--vscode-errorForeground, #f87171)',
          fontFamily: 'var(--vscode-font-family)',
          fontSize: '13px',
        }}>
          <h3 style={{ marginTop: 0 }}>Something went wrong rendering the diagram</h3>
          <pre style={{
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            background: 'rgba(0,0,0,0.2)',
            padding: '12px',
            borderRadius: '6px',
            fontSize: '11px',
            maxHeight: '200px',
            overflow: 'auto',
          }}>
            {this.state.error?.message}
          </pre>
          <button
            onClick={() => this.setState({ hasError: false, error: undefined })}
            style={{
              marginTop: '12px',
              padding: '6px 16px',
              background: 'var(--vscode-button-background, #0078d4)',
              color: 'var(--vscode-button-foreground, #fff)',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '12px',
            }}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function layoutSpine(
  nodes: Array<{ id: string; type: string; data: Record<string, unknown>; position: { x: number; y: number } }>,
  edges: Array<{ id: string; source: string; target: string; type?: string; label?: string; animated?: boolean; style?: Record<string, unknown> }>
): { nodes: Node[]; edges: Edge[] } {
  const laid = nodes.map((node, i) => ({
    ...node,
    position: { x: 0, y: i * SPINE_Y_GAP },
  }));
  return { nodes: laid as Node[], edges: edges as Edge[] };
}

export default function App() {
  const [graphData, setGraphData] = useState<{
    nodes: Node[];
    edges: Edge[];
  }>({ nodes: [], edges: [] });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const vscode = getVsCodeApi();

    const handleMessage = (event: MessageEvent) => {
      const { type, data } = event.data;
      if (type === 'setSessionData') {
        // Legacy batch mode: raw ISerializableChatData
        const { nodes, edges } = sessionToGraphData(data);
        const result = layoutSpine(nodes, edges);
        setGraphData(result);
        setLoading(false);
      } else if (type === 'setSessionGraph') {
        // New batch mode: pre-built SessionGraph IR
        const graph = data as SessionGraph;
        const { nodes, edges } = sessionGraphToSpine(graph);
        const result = layoutSpine(nodes, edges);
        setGraphData(result);
        setLoading(false);
      } else if (type === 'addTurn') {
        // Streaming: new turn added
        const turn = data as TurnNode;
        setGraphData(prev => {
          const { nodes, edges } = appendTurnToSpine(
            prev.nodes as any,
            prev.edges as any,
            turn,
          );
          return layoutSpine(nodes, edges);
        });
        setLoading(false);
      } else if (type === 'updateTurn') {
        // Streaming: existing turn updated
        const { turnIndex, turn } = data as { turnIndex: number; turn: TurnNode };
        setGraphData(prev => {
          const { nodes, edges } = updateTurnInSpine(
            prev.nodes as any,
            prev.edges as any,
            turnIndex,
            turn,
          );
          return layoutSpine(nodes, edges);
        });
      }
    };

    window.addEventListener('message', handleMessage);
    vscode.postMessage({ type: 'ready' });

    return () => window.removeEventListener('message', handleMessage);
  }, []);

  if (loading) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          color: 'var(--vscode-editor-foreground)',
          fontFamily: 'var(--vscode-font-family)',
          fontSize: '14px',
        }}
      >
        Loading workflow diagram…
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <ReactFlowProvider>
        <WorkflowDiagram spineNodes={graphData.nodes} spineEdges={graphData.edges} />
      </ReactFlowProvider>
    </ErrorBoundary>
  );
}
