import React from 'react';
import { Handle, Position } from '@xyflow/react';

import { getVsCodeApi } from '../vscodeApi';

interface ToolInvocationNodeData {
  toolId: string;
  invocationMessage: string;
  pastTenseMessage?: string;
  isComplete: boolean;
  isConfirmed?: boolean | string;
  toolCallId?: string;
  isMcp?: boolean;
  sourceLabel?: string;
  sourceType?: string;
  uris?: string[];
  edits?: Array<any>;
  generatedTitle?: string;
  presentation?: string;
  toolSpecificData?: {
    kind?: string;
    terminalCommandState?: { exitCode?: number; duration?: number };
    commandLine?: { original?: string; toolEdited?: string };
    terminalCommandOutput?: { text?: string; lineCount?: number };
    cwd?: string;
    autoApproveInfo?: { value?: string };
    todoList?: Array<{ id: string; title: string; status: string }>;
    rawInput?: Record<string, unknown>;
  };
  resultDetails?: { input?: string; output?: Array<{ value?: string }>; isError?: boolean };
  onShowDetails?: () => void;
}

/** Safely coerce any value to a string for rendering — prevents URI objects crashing React. */
function safeStr(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    return (v as any).fsPath || (v as any).path || (v as any).value || JSON.stringify(v);
  }
  return String(v);
}

export function ToolInvocationNode({ data }: { data: ToolInvocationNodeData }) {
  const displayMsg = safeStr(data.generatedTitle || data.pastTenseMessage || data.invocationMessage);
  const isMcp = data.isMcp || data.sourceType === 'mcp';
  const borderColor = isMcp ? '#2db8a8' : 'var(--vscode-charts-purple, #8957e5)';
  const bgColor = isMcp ? 'rgba(45, 184, 168, 0.15)' : 'rgba(137, 87, 229, 0.15)';
  const icon = isMcp ? '🔌' : '🔧';

  // Extract short filename/path from URI for display
  const uriLabels = (data.uris || []).map(u => {
    const s = typeof u === 'string' ? u : (u as any)?.fsPath || (u as any)?.path || String(u);
    try {
      const decoded = decodeURIComponent(s);
      const parts = decoded.split('/');
      return parts.slice(-2).join('/');
    } catch {
      return s.slice(s.lastIndexOf('/') + 1);
    }
  });

  const renderToolSpecificData = () => {
    if (!data.toolSpecificData) return null;

    if (data.toolSpecificData.kind === 'terminal') {
      const cmd = safeStr(data.toolSpecificData.commandLine?.original || '');
      const exitCode = data.toolSpecificData.terminalCommandState?.exitCode;
      const duration = data.toolSpecificData.terminalCommandState?.duration;
      const output = safeStr(data.toolSpecificData.terminalCommandOutput?.text);
      return (
        <div style={{ marginTop: '4px', padding: '4px', background: 'rgba(0,0,0,0.2)', borderRadius: '4px', fontSize: '9px', fontFamily: 'monospace', overflow: 'hidden' }}>
          <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>$ {cmd}</div>
          {exitCode !== undefined && (
            <div style={{ color: exitCode === 0 ? '#4ade80' : '#f87171', marginTop: '2px' }}>
              Exit: {exitCode} {duration ? `(${Math.round(duration / 1000)}s)` : ''}
            </div>
          )}
          {!!output && (
            <div className="nowheel" style={{ 
              marginTop: '4px', 
              padding: '4px', 
              background: 'rgba(0,0,0,0.3)', 
              borderRadius: '2px',
              maxHeight: '60px',
              overflowY: 'auto',
              overflowX: 'hidden',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              color: '#d1d5db'
            }}>
              {output}
            </div>
          )}
        </div>
      );
    }

    if (data.toolSpecificData.kind === 'todoList' && data.toolSpecificData.todoList) {
      const todos = data.toolSpecificData.todoList;
      const completed = todos.filter(t => t.status === 'completed').length;
      return (
        <div style={{ marginTop: '4px', fontSize: '9px', opacity: 0.8 }}>
          📋 {completed}/{todos.length} tasks completed
        </div>
      );
    }

    if (data.toolSpecificData.kind === 'input' && data.toolSpecificData.rawInput) {
      const inputStr = JSON.stringify(data.toolSpecificData.rawInput);
      return (
        <div style={{ marginTop: '4px', padding: '4px', background: 'rgba(0,0,0,0.2)', borderRadius: '4px', fontSize: '9px', fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {inputStr}
        </div>
      );
    }

    if (data.toolSpecificData.kind === 'subagent') {
      const sd = data.toolSpecificData as any;
      return (
        <div style={{ marginTop: '4px', fontSize: '9px', opacity: 0.8 }}>
          {sd.agentName && <div>🤖 {safeStr(sd.agentName)}</div>}
          {sd.description && <div style={{ opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{safeStr(sd.description)}</div>}
        </div>
      );
    }

    return null;
  };

  return (
    <div
      style={{
        padding: '8px 12px',
        border: `2px solid ${borderColor}`,
        borderRadius: '8px',
        background: bgColor,
        color: 'var(--vscode-editor-foreground, #fff)',
        minWidth: '180px',
        maxWidth: '280px',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      {data.onShowDetails && (
        <button
          onClick={(e) => { e.stopPropagation(); data.onShowDetails!(); }}
          style={{
            position: 'absolute',
            top: '4px',
            right: '4px',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            fontSize: '12px',
            opacity: 0.6,
            padding: '2px',
          }}
          title="Show Details"
        >
          ℹ️
        </button>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '3px', paddingRight: '16px' }}>
        <div style={{ fontWeight: 'bold', fontSize: '11px' }}>
          {icon} {safeStr(data.toolId)}
        </div>
        {(isMcp || data.sourceLabel) && (
          <span style={{
            fontSize: '8px',
            padding: '1px 4px',
            borderRadius: '3px',
            background: isMcp ? 'rgba(45,184,168,0.3)' : 'rgba(255,255,255,0.1)',
            opacity: 0.9,
          }}>
            {isMcp ? '⚡ MCP' : safeStr(data.sourceLabel || data.sourceType)}
          </span>
        )}
      </div>
      <div
        style={{
          fontSize: '10px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          lineHeight: '1.3',
          opacity: 0.85,
        }}
      >
        {displayMsg}
      </div>
      {renderToolSpecificData()}
      {data.resultDetails?.isError && (
        <div style={{ color: '#f87171', fontSize: '9px', marginTop: '2px' }}>⚠️ Tool Error</div>
      )}
      {data.resultDetails?.output && data.resultDetails.output.length > 0 && !data.resultDetails.isError && (() => {
        const outputStr = data.resultDetails!.output!.map((o: any) => typeof o.value === 'string' ? o.value : JSON.stringify(o.value ?? '')).join('');
        if (!outputStr) return null;
        return (
          <div style={{ fontSize: '9px', opacity: 0.6, marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            📤 {outputStr.slice(0, 60)}{outputStr.length > 60 ? '…' : ''}
          </div>
        );
      })()}
      {data.resultDetails?.input && (() => {
        const inputStr = typeof data.resultDetails!.input === 'string' ? data.resultDetails!.input : JSON.stringify(data.resultDetails!.input);
        return (
          <div style={{ fontSize: '9px', opacity: 0.5, marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            📥 {inputStr.slice(0, 60)}{inputStr.length > 60 ? '…' : ''}
          </div>
        );
      })()}
      {uriLabels.length > 0 && (
        <div style={{ marginTop: '3px' }}>
          {uriLabels.slice(0, 2).map((u, i) => (
            <div key={i} style={{
              fontSize: '9px',
              opacity: 0.65,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              📄 {u}
            </div>
          ))}
          {uriLabels.length > 2 && (
            <div style={{ fontSize: '9px', opacity: 0.45 }}>+{uriLabels.length - 2} more</div>
          )}
        </div>
      )}
      {data.edits && data.edits.length > 0 && (
        <div style={{ marginTop: '4px' }}>
          <button
            onClick={(e) => {
              e.stopPropagation();
              getVsCodeApi().postMessage({
                command: 'showDiff',
                uri: data.uris?.[0],
                edits: data.edits
              });
            }}
            style={{
              background: 'rgba(80,140,220,0.25)',
              border: '1px solid rgba(80,140,220,0.5)',
              color: 'inherit',
              fontSize: '9px',
              padding: '2px 6px',
              borderRadius: '4px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '4px'
            }}
          >
            <span>🔍</span> View {data.edits.flat().length} Edit{data.edits.flat().length > 1 ? 's' : ''}
          </button>
        </div>
      )}
      <div style={{ fontSize: '9px', opacity: 0.6, marginTop: '3px' }}>
        {data.isComplete ? '✓ complete' : '⋯ pending'}
        {data.isConfirmed !== undefined && ` · ${
          data.isConfirmed === true ? 'confirmed' :
          data.isConfirmed === false ? 'rejected' :
          typeof data.isConfirmed === 'object' ? (
            (data.isConfirmed as any).type === 1 ? 'confirmed' :
            (data.isConfirmed as any).type === 4 ? 'auto-approved' :
            JSON.stringify(data.isConfirmed)
          ) :
          String(data.isConfirmed)
        }`}
      </div>
      <Handle type="target" position={Position.Left} />
    </div>
  );
}
