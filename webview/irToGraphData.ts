// irToGraphData.ts — Maps SessionGraph IR → React Flow nodes/edges.
// Replaces sessionToGraphData.ts for the new pipeline.

import type {
  SessionGraph,
  TurnNode,
  ResponseChildNode,
  ToolNode,
  SubAgentNode,
} from '../src/sessionIR';

export interface ChildNodeData {
  id: string;
  type: 'toolInvocation' | 'thinking' | 'subAgent';
  data: Record<string, unknown>;
}

export interface GraphNode {
  id: string;
  type: string;
  data: Record<string, unknown>;
  position: { x: number; y: number };
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type?: string;
  label?: string;
  animated?: boolean;
  style?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Transform flat IR ToolSpecificData → nested shape expected by rendering components
// ---------------------------------------------------------------------------

function irSpecificDataToLegacy(
  sd: import('../src/sessionIR').ToolSpecificData | undefined,
): Record<string, unknown> | undefined {
  if (!sd) return undefined;
  switch (sd.kind) {
    case 'terminal':
      return {
        kind: 'terminal',
        commandLine: sd.commandLine ? { original: sd.commandLine } : undefined,
        terminalCommandState:
          sd.exitCode !== undefined || sd.duration !== undefined
            ? { exitCode: sd.exitCode, duration: sd.duration }
            : undefined,
        terminalCommandOutput: sd.output ? { text: sd.output } : undefined,
        cwd: sd.cwd,
        autoApproveInfo: sd.autoApproveInfo ? { value: sd.autoApproveInfo } : undefined,
      };
    case 'todoList':
      return { kind: 'todoList', todoList: sd.items };
    case 'input':
      return { kind: 'input', rawInput: sd.rawInput };
    case 'subagent':
      return {
        kind: 'subagent',
        agentName: sd.agentName,
        description: sd.description,
        prompt: sd.prompt,
        result: sd.result,
      };
    case 'unknown':
      return sd.raw as Record<string, unknown>;
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Map a ResponseChildNode → ChildNodeData (consumed by WorkflowDiagram expand)
// ---------------------------------------------------------------------------

function childToNodeData(child: ResponseChildNode): ChildNodeData {
  switch (child.type) {
    case 'tool':
      return {
        id: child.id,
        type: 'toolInvocation',
        data: {
          toolId: child.toolId,
          toolCallId: child.toolCallId,
          invocationMessage: child.message,
          pastTenseMessage: child.pastTenseMessage,
          isComplete: child.isComplete,
          isConfirmed: child.isConfirmed,
          sourceType: child.source.type,
          sourceLabel: child.source.label,
          isMcp: child.isMcp,
          uris: child.uris,
          toolSpecificData: irSpecificDataToLegacy(child.specificData),
          resultDetails: child.resultDetails,
          generatedTitle: child.generatedTitle,
          presentation: child.presentation,
        },
      };
    case 'thinking':
      return {
        id: child.id,
        type: 'thinking',
        data: {
          text: child.text,
          fullText: child.fullText,
          charCount: child.charCount,
          wordCount: child.wordCount,
          lineCount: child.lineCount,
          readingTimeSec: child.readingTimeSec,
        },
      };
    case 'subAgent': {
      const subChildren: ChildNodeData[] = child.children.map((t: ToolNode, si: number) => ({
        id: t.id,
        type: 'toolInvocation' as const,
        data: {
          toolId: t.toolId,
          toolCallId: t.toolCallId,
          invocationMessage: t.message,
          pastTenseMessage: t.pastTenseMessage,
          isComplete: t.isComplete,
          isConfirmed: t.isConfirmed,
          sourceType: t.source.type,
          sourceLabel: t.source.label,
          isMcp: t.isMcp,
          uris: t.uris,
          toolSpecificData: irSpecificDataToLegacy(t.specificData),
          resultDetails: t.resultDetails,
          generatedTitle: t.generatedTitle,
          presentation: t.presentation,
        },
      }));
      return {
        id: child.id,
        type: 'subAgent',
        data: {
          agentName: child.agentName,
          description: child.description,
          prompt: child.prompt,
          result: child.result,
          parentToolId: child.parentToolId,
          toolCount: child.toolCount,
          childNodes: subChildren,
        },
      };
    }
    case 'editGroup':
      return {
        id: child.id,
        type: 'toolInvocation',
        data: {
          toolId: 'textEditGroup',
          toolCallId: child.id,
          invocationMessage: `Edited ${child.uri} (${child.editCount} edits)`,
          isComplete: true,
          sourceType: 'internal',
          sourceLabel: 'Built-In',
          uris: [child.uri],
          edits: child.edits,
        },
      };
    case 'elicitation':
      return {
        id: child.id,
        type: 'toolInvocation',
        data: {
          toolId: 'elicitation',
          toolCallId: child.id,
          invocationMessage: `${child.title}: ${child.message}`,
          isComplete: true,
          isConfirmed: child.state,
          sourceType: 'internal',
          sourceLabel: 'Built-In',
        },
      };
  }
}

// ---------------------------------------------------------------------------
// Map a TurnNode → spine nodes + edges
// ---------------------------------------------------------------------------

function turnToNodes(turn: TurnNode): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const turnNumber = turn.turnIndex + 1;

  // User request node
  nodes.push({
    id: turn.request.id,
    type: 'userRequest',
    data: {
      text: turn.request.text,
      fullText: turn.request.fullText,
      timestamp: turn.request.timestamp,
      turnNumber,
      modelId: turn.request.modelId,
      variableCount: turn.request.variables.length,
      variableNames: turn.request.variables.map(v => v.name),
      timeSpentWaiting: turn.request.waitTime,
      requestId: turn.request.requestId,
    },
    position: { x: 0, y: 0 },
  });

  if (turn.response) {
    const r = turn.response;
    const childNodeDatas: ChildNodeData[] = r.children.map(childToNodeData);

    nodes.push({
      id: r.id,
      type: 'agentResponse',
      data: {
        agent: r.agent,
        state: r.state,
        turnNumber,
        modelId: r.modelId,
        responsePreview: r.markdown.preview,
        fullResponsePreview: r.markdown.fullText,
        markdownLength: r.markdown.length,
        responsePartCount: r.responsePartCount,
        partKindCounts: r.partKindCounts,
        toolCount: r.toolCount,
        thinkingCount: r.thinkingCount,
        subAgentCount: r.subAgentCount,
        mcpServerCount: r.children.filter(
          (c): c is import('../src/sessionIR').ToolNode => c.type === 'tool' && c.isMcp,
        ).length,
        textEditGroupCount: r.editGroupCount,
        duration: r.duration,
        ttft: r.ttft,
        childNodes: childNodeDatas,
        responseId: r.responseId,
        vote: r.vote,
        voteDownReason: r.voteDownReason,
        contentReferencesCount: r.contentReferencesCount,
        contentReferences: r.contentReferences,
        codeCitationsCount: r.codeCitationsCount,
        editedFileCount: r.editedFileCount,
        followupCount: r.followupCount,
        errorMessage: r.error,
        renderedUserMessage: r.renderedUserMessage,
        renderedGlobalContext: r.renderedGlobalContext,
        usage: r.tokens,
      },
      position: { x: 0, y: 0 },
    });

    edges.push({
      id: `${turn.request.id}->${r.id}`,
      source: turn.request.id,
      target: r.id,
      type: 'smoothstep',
    });
  }

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Public API: SessionGraph → full React Flow nodes/edges
// ---------------------------------------------------------------------------

/**
 * Convert a full SessionGraph to React Flow nodes and edges.
 * Builds the vertical spine: user→agent→user→agent...
 */
export function sessionGraphToSpine(graph: SessionGraph): {
  nodes: GraphNode[];
  edges: GraphEdge[];
} {
  const allNodes: GraphNode[] = [];
  const allEdges: GraphEdge[] = [];
  let prevNodeId: string | undefined;

  for (const turn of graph.turns) {
    const { nodes, edges } = turnToNodes(turn);

    // Connect to previous node in the spine
    const firstNodeId = nodes[0]?.id;
    if (prevNodeId && firstNodeId) {
      allEdges.push({
        id: `${prevNodeId}->${firstNodeId}`,
        source: prevNodeId,
        target: firstNodeId,
        type: 'smoothstep',
      });
    }

    allNodes.push(...nodes);
    allEdges.push(...edges);

    // Last node in this turn becomes the prev for the next
    prevNodeId = turn.response ? turn.response.id : turn.request.id;
  }

  return { nodes: allNodes, edges: allEdges };
}

/**
 * Incrementally append a new turn to an existing spine without rebuilding.
 * Returns new nodes and edges to add.
 */
export function appendTurnToSpine(
  existingNodes: GraphNode[],
  existingEdges: GraphEdge[],
  newTurn: TurnNode,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const { nodes: turnNodes, edges: turnEdges } = turnToNodes(newTurn);

  // Find the last node in the existing spine
  const lastExistingNode = existingNodes[existingNodes.length - 1];
  const firstNewNodeId = turnNodes[0]?.id;
  const newEdges = [...turnEdges];

  if (lastExistingNode && firstNewNodeId) {
    newEdges.push({
      id: `${lastExistingNode.id}->${firstNewNodeId}`,
      source: lastExistingNode.id,
      target: firstNewNodeId,
      type: 'smoothstep',
    });
  }

  return {
    nodes: [...existingNodes, ...turnNodes],
    edges: [...existingEdges, ...newEdges],
  };
}

/**
 * Update nodes for a specific turn in-place within existing node/edge arrays.
 * Returns new arrays (immutable update).
 */
export function updateTurnInSpine(
  existingNodes: GraphNode[],
  existingEdges: GraphEdge[],
  turnIndex: number,
  updatedTurn: TurnNode,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const { nodes: turnNodes, edges: turnEdges } = turnToNodes(updatedTurn);

  const userNodeId = `user_${turnIndex}`;
  const agentNodeId = `agent_${turnIndex}`;

  // Replace existing nodes for this turn
  const filteredNodes = existingNodes.filter(
    n => n.id !== userNodeId && n.id !== agentNodeId,
  );

  // Replace existing edges from/to this turn's nodes
  const filteredEdges = existingEdges.filter(
    e => e.source !== userNodeId && e.target !== userNodeId &&
         e.source !== agentNodeId && e.target !== agentNodeId,
  );

  // Re-insert at the correct position
  // Find the insertion index: after the last node of the previous turn
  let insertIdx = 0;
  if (turnIndex > 0) {
    const prevAgentId = `agent_${turnIndex - 1}`;
    const prevUserId = `user_${turnIndex - 1}`;
    for (let i = 0; i < filteredNodes.length; i++) {
      if (filteredNodes[i].id === prevAgentId || filteredNodes[i].id === prevUserId) {
        insertIdx = i + 1;
      }
    }
  }

  const newNodes = [...filteredNodes];
  newNodes.splice(insertIdx, 0, ...turnNodes);

  // Rebuild spine connectivity edges for this turn
  const newEdges = [...filteredEdges, ...turnEdges];

  // Connect to previous
  if (turnIndex > 0) {
    const prevNodeId = filteredNodes.find(n => n.id === `agent_${turnIndex - 1}`)
      ? `agent_${turnIndex - 1}`
      : `user_${turnIndex - 1}`;
    newEdges.push({
      id: `${prevNodeId}->${userNodeId}`,
      source: prevNodeId,
      target: userNodeId,
      type: 'smoothstep',
    });
  }

  // Connect to next
  const nextUserId = `user_${turnIndex + 1}`;
  if (filteredNodes.some(n => n.id === nextUserId)) {
    const lastTurnNodeId = updatedTurn.response ? agentNodeId : userNodeId;
    newEdges.push({
      id: `${lastTurnNodeId}->${nextUserId}`,
      source: lastTurnNodeId,
      target: nextUserId,
      type: 'smoothstep',
    });
  }

  return { nodes: newNodes, edges: newEdges };
}
