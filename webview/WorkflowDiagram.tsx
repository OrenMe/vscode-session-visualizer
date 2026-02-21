import React, { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { UserRequestNode } from './nodes/UserRequestNode';
import { AgentResponseNode } from './nodes/AgentResponseNode';
import { ToolInvocationNode } from './nodes/ToolInvocationNode';
import { SubAgentNode } from './nodes/SubAgentNode';
import { ThinkingNode } from './nodes/ThinkingNode';
import type { ChildNodeData } from './sessionToGraphData';

const SPINE_X = 300;
const SPINE_Y_START = 40;
const SPINE_Y_GAP = 140;
const CHILD_OFFSET_X = 360;
const CHILD_Y_GAP = 130;
const EXPANDED_EXTRA_GAP = 80;

interface WorkflowDiagramProps {
  spineNodes: Node[];
  spineEdges: Edge[];
}

interface ContextMenuState {
  x: number;
  y: number;
  node: Node;
}

function buildVisibleGraph(
  spineNodes: Node[],
  spineEdges: Edge[],
  expandedSet: Set<string>
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [...spineEdges];

  // Track cumulative Y offset for spine nodes when predecessors are expanded
  let yOffset = 0;

  for (const spineNode of spineNodes) {
    const positioned: Node = {
      ...spineNode,
      position: {
        x: spineNode.position.x,
        y: spineNode.position.y + yOffset,
      },
    };
    nodes.push(positioned);

    const children = (spineNode.data as Record<string, unknown>).childNodes as
      | ChildNodeData[]
      | undefined;
    const isExpanded = expandedSet.has(spineNode.id);

    if (isExpanded && children && children.length > 0) {
      const parentY = positioned.position.y;
      const childStartY = parentY - ((children.length - 1) * CHILD_Y_GAP) / 2;

      for (let ci = 0; ci < children.length; ci++) {
        const child = children[ci];
        const childX = positioned.position.x + CHILD_OFFSET_X;
        const childY = childStartY + ci * CHILD_Y_GAP;

        const childNode: Node = {
          id: child.id,
          type: child.type,
          data: child.data as Record<string, unknown>,
          position: { x: childX, y: childY },
        } as Node;
        nodes.push(childNode);

        edges.push({
          id: `${spineNode.id}->${child.id}`,
          source: spineNode.id,
          target: child.id,
          type: 'smoothstep',
          animated: true,
          style: { stroke: '#666', strokeDasharray: '5 3' },
        });

        // Handle SubAgent second-level expansion
        if (child.type === 'subAgent' && expandedSet.has(child.id)) {
          const subChildren = child.data.childNodes as ChildNodeData[] | undefined;
          if (subChildren && subChildren.length > 0) {
            const subChildStartY = childY - ((subChildren.length - 1) * CHILD_Y_GAP) / 2;
            for (let sci = 0; sci < subChildren.length; sci++) {
              const subChild = subChildren[sci];
              nodes.push({
                id: subChild.id,
                type: subChild.type,
                data: subChild.data as Record<string, unknown>,
                position: {
                  x: childX + CHILD_OFFSET_X,
                  y: subChildStartY + sci * CHILD_Y_GAP,
                },
              } as Node);
              edges.push({
                id: `${child.id}->${subChild.id}`,
                source: child.id,
                target: subChild.id,
                type: 'smoothstep',
                animated: true,
                style: { stroke: '#d29922', strokeDasharray: '5 3' },
              });
            }
          }
        }
      }

      yOffset += Math.max(0, (children.length - 1) * CHILD_Y_GAP) + EXPANDED_EXTRA_GAP;
    }
  }

  return { nodes, edges };
}

function formatContextValue(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value || '—';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '(empty)';
    if (depth > 1) return `[${value.length} items]`;
    return value.map((v) => formatContextValue(v, depth + 1)).join(', ');
  }
  if (typeof value === 'object') {
    if (depth > 1) return '{...}';
    const entries = Object.entries(value as Record<string, unknown>);
    return entries
      .map(([k, v]) => `${k}: ${formatContextValue(v, depth + 1)}`)
      .join('\n');
  }
  return String(value);
}

/** Coerce unknown values to safe React-renderable strings — prevents URI objects crashing. */
function safeRender(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    return (v as any).fsPath || (v as any).path || (v as any).value || JSON.stringify(v);
  }
  return String(v);
}

function DetailsModal({
  node,
  onClose,
}: {
  node: Node;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as HTMLElement)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const data = node.data as Record<string, unknown>;
  const sections: Array<{ label: string; value: React.ReactNode }> = [];
  const handledKeys = new Set<string>(['childNodes', 'id', 'type', 'onShowDetails']);

  const addSection = (key: string | null, label: string, value: React.ReactNode) => {
    if (key) handledKeys.add(key);
    if (value !== undefined && value !== null && value !== '') {
      sections.push({ label, value });
    }
  };

  if (node.type === 'userRequest') {
    addSection('turnNumber', 'Turn', `#${data.turnNumber}`);
    addSection('fullText', 'Message', (data.fullText as string) || (data.text as string) || '—');
    handledKeys.add('text');
    if (data.timestamp) addSection('timestamp', 'Time', new Date(data.timestamp as number).toLocaleString());
    addSection('modelId', 'Model', data.modelId as string);
    addSection('requestId', 'Request ID', data.requestId as string);
    if ((data.variableCount as number) > 0) {
      addSection('variableNames', 'Variables', (data.variableNames as string[]).join(', '));
    }
    handledKeys.add('variableCount');
    if (data.timeSpentWaiting) addSection('timeSpentWaiting', 'Wait Time', `${data.timeSpentWaiting}ms`);
  } else if (node.type === 'agentResponse') {
    addSection('turnNumber', 'Turn', `#${data.turnNumber}`);
    addSection('agent', 'Agent', data.agent as string);
    addSection('state', 'State', data.state as string);
    addSection('modelId', 'Model', data.modelId as string);
    addSection('responseId', 'Response ID', data.responseId as string);
    const fullPreview = (data.fullResponsePreview as string) || (data.responsePreview as string);
    if (fullPreview) {
      addSection('fullResponsePreview', 'Response Preview', <pre className="nowheel" style={{ margin: 0, padding: '6px', background: 'rgba(0,0,0,0.2)', borderRadius: '4px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '300px', overflowY: 'auto', fontFamily: 'inherit', fontSize: '11px', lineHeight: '1.5' }}>{fullPreview}</pre>);
      handledKeys.add('responsePreview');
    }
    addSection('markdownLength', 'Markdown Length', `${data.markdownLength} chars`);
    addSection('responsePartCount', 'Response Parts', `${data.responsePartCount}`);

    const kinds = data.partKindCounts as Record<string, number> | undefined;
    if (kinds) {
      addSection('partKindCounts', 'Part Breakdown', Object.entries(kinds).map(([k, v]) => `${k}: ${v}`).join(', '));
    }

    addSection('toolCount', 'Tools', `${data.toolCount}`);
    addSection('thinkingCount', 'Thinking Blocks', `${data.thinkingCount}`);
    addSection('subAgentCount', 'Sub-Agents', `${data.subAgentCount}`);
    if ((data.mcpServerCount as number) > 0) addSection('mcpServerCount', 'MCP Servers', `${data.mcpServerCount}`);
    if ((data.textEditGroupCount as number) > 0) addSection('textEditGroupCount', 'Edit Groups', `${data.textEditGroupCount}`);
    if (data.duration) addSection('duration', 'Duration', `${((data.duration as number) / 1000).toFixed(1)}s`);

    // Token usage & multiplier
    const usage = data.usage as Record<string, unknown> | undefined;
    if (usage) {
      const totalTokens = usage.totalTokens as number | undefined;
      const promptTokens = usage.promptTokens as number | undefined;
      const completionTokens = usage.completionTokens as number | undefined;
      const maxInput = usage.maxInputTokens as number | undefined;
      const maxOutput = usage.maxOutputTokens as number | undefined;
      const multiplier = usage.multiplier as string | undefined;
      const details = usage.details as string | undefined;
      if (details) addSection(null, 'Model Details', details);
      if (multiplier) addSection(null, 'Multiplier', multiplier);
      if (totalTokens) addSection(null, 'Total Tokens', totalTokens.toLocaleString());
      if (promptTokens) addSection(null, 'Prompt Tokens', promptTokens.toLocaleString());
      if (completionTokens) addSection(null, 'Completion Tokens', completionTokens.toLocaleString());
      if (maxInput) addSection(null, 'Max Input Tokens', maxInput.toLocaleString());
      if (maxOutput) addSection(null, 'Max Output Tokens', maxOutput.toLocaleString());
      if (promptTokens && maxInput) {
        const pct = Math.round((promptTokens / maxInput) * 100);
        addSection(null, 'Context Usage', `${pct}%`);
      }
      const promptTokenDetails = usage.promptTokenDetails as Array<{ category: string; label: string; percentageOfPrompt: number }> | undefined;
      if (promptTokenDetails && promptTokenDetails.length > 0) {
        addSection(null, 'Prompt Breakdown', promptTokenDetails.map(d => `${d.label}: ${d.percentageOfPrompt}%`).join(', '));
      }
    }
    handledKeys.add('usage');

    if (data.vote !== undefined && data.vote !== null) {
      const voteLabel = (data.vote as number) === 1 ? '👍 Upvoted' : (data.vote as number) === -1 ? '👎 Downvoted' : `Vote: ${data.vote}`;
      addSection('vote', 'Vote', voteLabel);
      if (data.voteDownReason) addSection('voteDownReason', 'Downvote Reason', data.voteDownReason as string);
    }
    if ((data.contentReferencesCount as number) > 0) addSection('contentReferencesCount', 'Content References', `${data.contentReferencesCount}`);
    handledKeys.add('contentReferences');
    if ((data.codeCitationsCount as number) > 0) addSection('codeCitationsCount', 'Code Citations', `${data.codeCitationsCount}`);
    if ((data.editedFileCount as number) > 0) addSection('editedFileCount', 'Edited Files', `${data.editedFileCount}`);
    if ((data.followupCount as number) > 0) addSection('followupCount', 'Follow-ups', `${data.followupCount}`);
    if (data.errorMessage) addSection('errorMessage', 'Error', data.errorMessage as string);
    
    if (data.renderedUserMessage) {
      addSection('renderedUserMessage', 'Rendered User Message', <pre className="nowheel" style={{ margin: 0, padding: '4px', background: 'rgba(0,0,0,0.2)', borderRadius: '4px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: '200px', overflow: 'auto' }}>{data.renderedUserMessage as string}</pre>);
    }
    if (data.renderedGlobalContext) {
      addSection('renderedGlobalContext', 'Rendered Global Context', <pre className="nowheel" style={{ margin: 0, padding: '4px', background: 'rgba(0,0,0,0.2)', borderRadius: '4px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: '200px', overflow: 'auto' }}>{data.renderedGlobalContext as string}</pre>);
    }
  } else if (node.type === 'toolInvocation') {
    addSection('toolId', 'Tool', data.toolId as string);
    if (data.isMcp) {
      addSection('sourceLabel', 'Source', `⚡ MCP — ${data.sourceLabel || 'unknown server'}`);
      handledKeys.add('isMcp');
    } else if (data.sourceLabel || data.sourceType) {
      addSection('sourceLabel', 'Source', `${data.sourceLabel || data.sourceType}`);
      handledKeys.add('sourceType');
    }
    addSection('invocationMessage', 'Message', data.invocationMessage as string || '—');
    if (data.pastTenseMessage) addSection('pastTenseMessage', 'Past Tense', data.pastTenseMessage as string);
    const uris = data.uris as string[] | undefined;
    if (uris && uris.length > 0) {
      addSection('uris', 'Referenced Files', uris.join('\n'));
    }
    addSection('isComplete', 'Complete', data.isComplete ? 'Yes' : 'No');
    
    let confirmedDisplay = String(data.isConfirmed);
    if (typeof data.isConfirmed === 'object' && data.isConfirmed !== null) {
      const confObj = data.isConfirmed as any;
      if (confObj.type === 1) confirmedDisplay = 'Confirmed';
      else if (confObj.type === 4) confirmedDisplay = 'Auto-approved';
      else confirmedDisplay = JSON.stringify(confObj);
    }
    if (data.isConfirmed !== undefined) addSection('isConfirmed', 'Confirmed', confirmedDisplay);
    
    if (data.toolCallId) addSection('toolCallId', 'Call ID', data.toolCallId as string);
    if (data.generatedTitle) addSection('generatedTitle', 'Generated Title', data.generatedTitle as string);
    if (data.presentation) addSection('presentation', 'Presentation', data.presentation as string);

    if (data.toolSpecificData) {
      handledKeys.add('toolSpecificData');
      const tsd = data.toolSpecificData as any;
      if (tsd.kind === 'terminal') {
        if (tsd.commandLine?.original) {
          addSection(null, 'Command', <pre className="nowheel" style={{ margin: 0, padding: '4px', background: 'rgba(0,0,0,0.2)', borderRadius: '4px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{safeRender(tsd.commandLine.original)}</pre>);
        }
        if (tsd.commandLine?.toolEdited && tsd.commandLine.toolEdited !== tsd.commandLine.original) {
          addSection(null, 'Edited Command', <pre className="nowheel" style={{ margin: 0, padding: '4px', background: 'rgba(0,0,0,0.2)', borderRadius: '4px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{safeRender(tsd.commandLine.toolEdited)}</pre>);
        }
        if (tsd.cwd) {
          addSection(null, 'Working Directory', safeRender(tsd.cwd));
        }
        if (tsd.terminalCommandState) {
          const { exitCode, duration } = tsd.terminalCommandState;
          addSection(null, 'Exit Code', exitCode !== undefined ? String(exitCode) : '—');
          if (duration !== undefined) addSection(null, 'Duration', `${(duration / 1000).toFixed(1)}s`);
        }
        if (tsd.terminalCommandOutput?.text) {
          const lineCount = tsd.terminalCommandOutput.lineCount;
          addSection(null, lineCount ? `Terminal Output (${lineCount} lines)` : 'Terminal Output', <pre className="nowheel" style={{ margin: 0, padding: '4px', background: 'rgba(0,0,0,0.2)', borderRadius: '4px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: '200px', overflow: 'auto', fontFamily: 'monospace', fontSize: '11px' }}>{safeRender(tsd.terminalCommandOutput.text)}</pre>);
        }
        if (tsd.autoApproveInfo?.value) {
          addSection(null, 'Auto-Approve', safeRender(tsd.autoApproveInfo.value));
        }
      } else if (tsd.kind === 'todoList' && tsd.todoList) {
        addSection(null, 'Todo List', (
          <ul className="nowheel" style={{ margin: 0, paddingLeft: '16px', maxHeight: '150px', overflow: 'auto' }}>
            {tsd.todoList.map((t: any, i: number) => (
              <li key={i}>
                {t.status === 'completed' ? '✅' : t.status === 'in-progress' ? '⏳' : '⬜'} {t.title}
              </li>
            ))}
          </ul>
        ));
      } else if (tsd.kind === 'input' && tsd.rawInput) {
        addSection(null, 'Raw Input', <pre className="nowheel" style={{ margin: 0, padding: '4px', background: 'rgba(0,0,0,0.2)', borderRadius: '4px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: '150px', overflow: 'auto' }}>{JSON.stringify(tsd.rawInput, null, 2)}</pre>);
      } else if (tsd.kind === 'subagent') {
        if (tsd.agentName) addSection(null, 'Sub-Agent', tsd.agentName);
        if (tsd.description) addSection(null, 'Description', tsd.description);
        if (tsd.prompt) addSection(null, 'Prompt', <pre className="nowheel" style={{ margin: 0, padding: '4px', background: 'rgba(0,0,0,0.2)', borderRadius: '4px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '200px', overflow: 'auto', fontFamily: 'inherit' }}>{tsd.prompt}</pre>);
        if (tsd.result) addSection(null, 'Result', <pre className="nowheel" style={{ margin: 0, padding: '4px', background: 'rgba(0,0,0,0.2)', borderRadius: '4px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '200px', overflow: 'auto', fontFamily: 'inherit' }}>{tsd.result}</pre>);
      }
    }

    if (data.resultDetails) {
      handledKeys.add('resultDetails');
      const rd = data.resultDetails as any;
      if (rd.isError) {
        addSection(null, 'Error', <span style={{ color: '#f87171' }}>Yes</span>);
      }
      if (rd.output && Array.isArray(rd.output)) {
        const outputStr = rd.output.map((o: any) => o.value).join('\n');
        if (outputStr) {
          addSection(null, 'Output', <pre className="nowheel" style={{ margin: 0, padding: '4px', background: 'rgba(0,0,0,0.2)', borderRadius: '4px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: '150px', overflow: 'auto' }}>{outputStr}</pre>);
        }
      }
    }
  } else if (node.type === 'thinking') {
    const charCount = data.charCount as number || 0;
    const wc = data.wordCount as number || 0;
    const readSec = data.readingTimeSec as number || 0;
    const readLabel = readSec < 60 ? `${readSec}s` : `${Math.round(readSec / 60)}m`;
    addSection('wordCount', 'Words', `${wc.toLocaleString()}`);
    addSection('charCount', 'Characters', `${charCount.toLocaleString()}`);
    if (data.lineCount) addSection('lineCount', 'Lines', `${data.lineCount}`);
    if (readSec > 0) addSection('readingTimeSec', 'Reading Time', readLabel);
    addSection('fullText', 'Content', <pre className="nowheel" style={{ margin: 0, padding: '4px', background: 'rgba(0,0,0,0.2)', borderRadius: '4px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '300px', overflow: 'auto', fontFamily: 'inherit' }}>{(data.fullText as string) || (data.text as string) || '—'}</pre>);
    handledKeys.add('text');
  } else if (node.type === 'subAgent') {
    addSection('agentName', 'Agent', data.agentName as string);
    if (data.description) addSection('description', 'Description', data.description as string);
    if (data.prompt) addSection('prompt', 'Prompt', <pre className="nowheel" style={{ margin: 0, padding: '4px', background: 'rgba(0,0,0,0.2)', borderRadius: '4px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '200px', overflow: 'auto', fontFamily: 'inherit' }}>{data.prompt as string}</pre>);
    if (data.result) addSection('result', 'Result', <pre className="nowheel" style={{ margin: 0, padding: '4px', background: 'rgba(0,0,0,0.2)', borderRadius: '4px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '200px', overflow: 'auto', fontFamily: 'inherit' }}>{data.result as string}</pre>);
    if (data.parentToolId) addSection('parentToolId', 'Parent Tool', data.parentToolId as string);
    if ((data.toolCount as number) > 0) addSection('toolCount', 'Tools Used', `${data.toolCount}`);
  } else if (node.type === 'textEditGroup') {
    addSection('uri', 'File', data.uri as string);
    if (data.edits) {
      handledKeys.add('edits');
      const edits = data.edits as any[];
      addSection(null, 'Edits', `${edits.length} edit(s)`);
      edits.forEach((edit, i) => {
        addSection(null, `Edit ${i + 1}`, <pre className="nowheel" style={{ margin: 0, padding: '4px', background: 'rgba(0,0,0,0.2)', borderRadius: '4px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: '100px', overflow: 'auto' }}>{edit.text}</pre>);
      });
    }
  } else if (node.type === 'elicitation') {
    addSection('prompt', 'Prompt', data.prompt as string);
    if (data.response) addSection('response', 'Response', data.response as string);
  }

  // Add any remaining unhandled keys
  const remainingKeys = Object.keys(data).filter(k => !handledKeys.has(k));
  if (remainingKeys.length > 0) {
    sections.push({ label: '---', value: <hr style={{ border: 'none', borderTop: '1px solid rgba(255,255,255,0.1)', margin: '4px 0' }} /> });
    for (const key of remainingKeys) {
      const val = data[key];
      if (val !== undefined && val !== null) {
        const formatted = typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val);
        sections.push({
          label: key,
          value: <pre className="nowheel" style={{ margin: 0, padding: '4px', background: 'rgba(0,0,0,0.2)', borderRadius: '4px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: '150px', overflow: 'auto' }}>{formatted}</pre>
        });
      }
    }
  }

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        zIndex: 1000,
      }}
    >
      <div
        ref={ref}
        style={{
          background: 'var(--vscode-editorWidget-background, #252526)',
          border: '1px solid var(--vscode-editorWidget-border, #454545)',
          borderRadius: '6px',
          boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
          padding: '16px 20px',
          width: '80%',
          maxWidth: '800px',
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          color: 'var(--vscode-editor-foreground, #ccc)',
          fontSize: '12px',
          fontFamily: 'var(--vscode-font-family)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', borderBottom: '1px solid var(--vscode-panel-border, #444)', paddingBottom: '8px' }}>
          <div style={{ fontWeight: 'bold', fontSize: '14px' }}>
            {node.type === 'userRequest' ? '👤 User Request Details' :
             node.type === 'agentResponse' ? '🤖 Agent Response Details' :
             node.type === 'toolInvocation' ? '🔧 Tool Invocation Details' :
             node.type === 'thinking' ? '🧠 Thinking Details' :
             node.type === 'subAgent' ? '🤖 Sub-Agent Details' :
             node.type === 'textEditGroup' ? '📝 File Edit Details' :
             node.type === 'elicitation' ? '❓ Elicitation Details' : `${node.type} Details`}
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--vscode-editor-foreground, #ccc)',
              cursor: 'pointer',
              fontSize: '16px',
              padding: '4px',
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>
        <div className="nowheel" style={{ overflowY: 'auto', flex: 1, paddingRight: '8px' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <tbody>
              {sections.map((s, i) => (
                <tr key={i} style={{ borderBottom: s.label === '---' ? 'none' : '1px solid rgba(255,255,255,0.05)' }}>
                  <td style={{ padding: '8px 12px 8px 0', fontWeight: 600, opacity: 0.7, verticalAlign: 'top', whiteSpace: 'nowrap', width: '140px' }}>
                    {s.label !== '---' ? s.label : ''}
                  </td>
                  <td style={{ padding: '8px 0', wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>
                    {typeof s.value === 'object' && s.value !== null && !React.isValidElement(s.value)
                      ? JSON.stringify(s.value)
                      : s.value}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default function WorkflowDiagram({
  spineNodes,
  spineEdges,
}: WorkflowDiagramProps) {
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [detailsModalNode, setDetailsModalNode] = useState<Node | null>(null);

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

  const { nodes, edges } = useMemo(
    () => {
      const { nodes: visibleNodes, edges: visibleEdges } = buildVisibleGraph(spineNodes, spineEdges, expandedNodes);
      
      // Inject onShowDetails callback into all nodes
      const nodesWithCallbacks = visibleNodes.map(node => ({
        ...node,
        data: {
          ...node.data,
          onShowDetails: () => setDetailsModalNode(node)
        }
      }));
      
      return { nodes: nodesWithCallbacks, edges: visibleEdges };
    },
    [spineNodes, spineEdges, expandedNodes]
  );

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      const children = (node.data as Record<string, unknown>).childNodes as
        | ChildNodeData[]
        | undefined;
      if (children && children.length > 0) {
        setExpandedNodes((prev) => {
          const next = new Set(prev);
          if (next.has(node.id)) {
            next.delete(node.id);
          } else {
            next.add(node.id);
          }
          return next;
        });
      }
    },
    []
  );

  const closeDetailsModal = useCallback(() => setDetailsModalNode(null), []);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        minZoom={0.1}
        maxZoom={2}
      >
        <Background />
        <Controls />
        <MiniMap
          nodeStrokeWidth={3}
          style={{ background: 'var(--vscode-editor-background, #1e1e1e)' }}
        />
      </ReactFlow>
      {detailsModalNode && (
        <DetailsModal
          node={detailsModalNode}
          onClose={closeDetailsModal}
        />
      )}
    </div>
  );
}
