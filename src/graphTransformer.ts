import {
  ISerializableChatData,
  IChatToolInvocationSerialized,
  IChatSubagentToolInvocationData,
} from './types';
import { getMessageText, getStringValue, truncate } from './utils';

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
}

let nodeIdCounter = 0;

function generateId(prefix: string): string {
  return `${prefix}_${nodeIdCounter++}`;
}

export function sessionToGraphData(session: ISerializableChatData): {
  nodes: GraphNode[];
  edges: GraphEdge[];
} {
  nodeIdCounter = 0;
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  let prevAgentResponseNodeId: string | undefined;

  for (const request of session.requests) {
    // User request node
    const userNodeId = generateId('userRequest');
    const messageText = getMessageText(request.message);
    nodes.push({
      id: userNodeId,
      type: 'userRequest',
      data: {
        text: truncate(messageText, 200),
        timestamp: request.timestamp,
        variableCount: request.variableData?.variables?.length ?? 0,
        modelId: request.modelId,
      },
      position: { x: 0, y: 0 },
    });

    // Connect from previous turn's response
    if (prevAgentResponseNodeId) {
      edges.push({
        id: `${prevAgentResponseNodeId}->${userNodeId}`,
        source: prevAgentResponseNodeId,
        target: userNodeId,
        type: 'default',
        label: 'next turn',
      });
    }

    // Agent response node
    if (request.response && request.response.length > 0) {
      const agentName =
        request.agent?.name || request.agent?.agentId || request.agent?.id || 'copilot';
      const state = request.modelState?.value || 'unknown';
      const agentNodeId = generateId('agentResponse');

      // Compute response preview from markdown content parts
      let responsePreview = '';
      for (const part of request.response) {
        if (part.kind === 'markdownContent') {
          const text = getStringValue(
            part.value as string | { value: string }
          );
          responsePreview += text;
          if (responsePreview.length > 100) {
            break;
          }
        }
      }

      nodes.push({
        id: agentNodeId,
        type: 'agentResponse',
        data: {
          agent: agentName,
          state,
          responseLength: request.response.length,
          responsePreview: truncate(responsePreview, 100),
        },
        position: { x: 0, y: 0 },
      });

      edges.push({
        id: `${userNodeId}->${agentNodeId}`,
        source: userNodeId,
        target: agentNodeId,
        type: 'default',
      });

      // Process response parts
      for (const part of request.response) {
        if (part.kind === 'thinking') {
          const thinkPart = part as {
            kind: 'thinking';
            value: string | string[];
          };
          const text = Array.isArray(thinkPart.value)
            ? thinkPart.value.join('')
            : thinkPart.value;
          const thinkingNodeId = generateId('thinking');
          nodes.push({
            id: thinkingNodeId,
            type: 'thinking',
            data: { text: truncate(text, 200) },
            position: { x: 0, y: 0 },
          });
          edges.push({
            id: `${agentNodeId}->${thinkingNodeId}`,
            source: agentNodeId,
            target: thinkingNodeId,
          });
        }

        if (part.kind === 'toolInvocationSerialized') {
          const tool = part as IChatToolInvocationSerialized;
          const toolNodeId = generateId('toolInvocation');
          nodes.push({
            id: toolNodeId,
            type: 'toolInvocation',
            data: {
              toolId: tool.toolId,
              invocationMessage: truncate(
                getStringValue(tool.invocationMessage),
                150
              ),
              isComplete: tool.isComplete,
              isConfirmed: tool.isConfirmed,
            },
            position: { x: 0, y: 0 },
          });
          edges.push({
            id: `${agentNodeId}->${toolNodeId}`,
            source: agentNodeId,
            target: toolNodeId,
            label: tool.toolId,
          });

          // Sub-agent check
          const specificData =
            tool.toolSpecificData as IChatSubagentToolInvocationData | undefined;
          if (specificData?.kind === 'subagent') {
            const subAgentNodeId = generateId('subAgent');
            nodes.push({
              id: subAgentNodeId,
              type: 'subAgent',
              data: {
                agentName: specificData.agentName || 'sub-agent',
                description: truncate(specificData.description || '', 100),
                prompt: truncate(specificData.prompt || '', 200),
                result: truncate(specificData.result || '', 200),
              },
              position: { x: 0, y: 0 },
            });
            edges.push({
              id: `${toolNodeId}->${subAgentNodeId}`,
              source: toolNodeId,
              target: subAgentNodeId,
            });
          }
        }
      }

      prevAgentResponseNodeId = agentNodeId;
    } else {
      prevAgentResponseNodeId = userNodeId;
    }
  }

  return { nodes, edges };
}
