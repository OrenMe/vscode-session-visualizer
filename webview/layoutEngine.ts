import dagre from '@dagrejs/dagre';

interface LayoutNode {
  id: string;
  type: string;
  data: Record<string, unknown>;
  position: { x: number; y: number };
  measured?: { width: number; height: number };
}

interface LayoutEdge {
  id: string;
  source: string;
  target: string;
  type?: string;
  label?: string;
}

const NODE_WIDTH = 250;
const NODE_HEIGHT = 80;

export function applyDagreLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  direction: 'TB' | 'LR' = 'TB'
): LayoutNode[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: direction, nodesep: 60, ranksep: 80 });

  for (const node of nodes) {
    const w = node.measured?.width ?? NODE_WIDTH;
    const h = node.measured?.height ?? NODE_HEIGHT;
    g.setNode(node.id, { width: w, height: h });
  }

  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  return nodes.map((node) => {
    const dagreNode = g.node(node.id);
    const w = node.measured?.width ?? NODE_WIDTH;
    const h = node.measured?.height ?? NODE_HEIGHT;
    return {
      ...node,
      position: {
        x: dagreNode.x - w / 2,
        y: dagreNode.y - h / 2,
      },
    };
  });
}
