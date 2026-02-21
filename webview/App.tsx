import React, { useState, useEffect } from 'react';
import { ReactFlowProvider, type Node, type Edge } from '@xyflow/react';
import WorkflowDiagram from './WorkflowDiagram';
import { sessionToGraphData } from './sessionToGraphData';
import { getVsCodeApi } from './vscodeApi';

const SPINE_Y_GAP = 160;

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
        const { nodes, edges } = sessionToGraphData(data);
        const result = layoutSpine(nodes, edges);
        setGraphData(result);
        setLoading(false);
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
    <ReactFlowProvider>
      <WorkflowDiagram spineNodes={graphData.nodes} spineEdges={graphData.edges} />
    </ReactFlowProvider>
  );
}
