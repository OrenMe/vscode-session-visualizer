import React, { useState } from 'react';
import { Handle, Position } from '@xyflow/react';

interface AgentResponseNodeData {
  agent: string;
  state: string;
  turnNumber?: number;
  modelId?: string;
  responsePreview: string;
  markdownLength?: number;
  toolCount?: number;
  thinkingCount?: number;
  subAgentCount?: number;
  mcpServerCount?: number;
  textEditGroupCount?: number;
  duration?: number;
  ttft?: number;
  vote?: number;
  errorMessage?: string;
  childNodes?: unknown[];
  renderedUserMessage?: string;
  renderedGlobalContext?: string;
  usage?: { totalTokens?: number; promptTokens?: number; completionTokens?: number };
  onShowDetails?: () => void;
}

const stateStyles: Record<string, { border: string; bg: string; icon: string }> = {
  complete: { border: '#2ea043', bg: 'rgba(46, 160, 67, 0.15)', icon: '✓' },
  failed: { border: '#f85149', bg: 'rgba(248, 81, 73, 0.15)', icon: '✗' },
  cancelled: { border: '#d29922', bg: 'rgba(210, 153, 34, 0.15)', icon: '⊘' },
};

export function AgentResponseNode({ data }: { data: AgentResponseNodeData }) {
  const style = stateStyles[data.state] || {
    border: '#8b949e',
    bg: 'rgba(139, 148, 158, 0.15)',
    icon: '⋯',
  };

  const hasChildren =
    (data.toolCount || 0) + (data.thinkingCount || 0) + (data.subAgentCount || 0) > 0;

  return (
    <div
      style={{
        padding: '10px 14px',
        border: `2px solid ${style.border}`,
        borderRadius: '8px',
        background: style.bg,
        color: 'var(--vscode-editor-foreground, #fff)',
        minWidth: '220px',
        maxWidth: '320px',
        cursor: hasChildren ? 'pointer' : 'default',
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px', paddingRight: '16px' }}>
        <div style={{ fontWeight: 'bold', fontSize: '12px' }}>
          {style.icon} {data.agent}
        </div>
        {data.modelId && (
          <div style={{ fontSize: '9px', opacity: 0.6, background: 'rgba(255,255,255,0.08)', padding: '1px 5px', borderRadius: '3px' }}>
            {data.modelId}
          </div>
        )}
      </div>
      <div
        style={{
          fontSize: '11px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          lineHeight: '1.3',
          opacity: 0.85,
        }}
      >
        {data.responsePreview || `${data.markdownLength || 0} chars`}
      </div>
      {(hasChildren || data.vote !== undefined || data.duration !== undefined) && (
        <div style={{ display: 'flex', gap: '5px', marginTop: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
          {(data.toolCount || 0) > 0 && (
            <span style={{ fontSize: '9px', background: 'rgba(137,87,229,0.25)', padding: '1px 5px', borderRadius: '3px' }}>
              🔧 {data.toolCount}
            </span>
          )}
          {(data.thinkingCount || 0) > 0 && (
            <span style={{ fontSize: '9px', background: 'rgba(139,148,158,0.2)', padding: '1px 5px', borderRadius: '3px' }}>
              🧠 {data.thinkingCount}
            </span>
          )}
          {(data.subAgentCount || 0) > 0 && (
            <span style={{ fontSize: '9px', background: 'rgba(210,153,34,0.25)', padding: '1px 5px', borderRadius: '3px' }}>
              🤖 {data.subAgentCount}
            </span>
          )}
          {(data.mcpServerCount || 0) > 0 && (
            <span style={{ fontSize: '9px', background: 'rgba(100,200,100,0.25)', padding: '1px 5px', borderRadius: '3px' }}>
              ⚡ {data.mcpServerCount} MCP
            </span>
          )}
          {(data.textEditGroupCount || 0) > 0 && (
            <span style={{ fontSize: '9px', background: 'rgba(80,140,220,0.25)', padding: '1px 5px', borderRadius: '3px' }}>
              ✏️ {data.textEditGroupCount}
            </span>
          )}
          {data.vote === 1 && (
            <span style={{ fontSize: '9px' }}>👍</span>
          )}
          {data.vote === -1 && (
            <span style={{ fontSize: '9px' }}>👎</span>
          )}
          {hasChildren && (
            <span style={{ fontSize: '9px', opacity: 0.5, marginLeft: 'auto' }}>
              click to expand ▸
            </span>
          )}
          {data.duration && (
            <span style={{ fontSize: '9px', opacity: 0.5, marginLeft: hasChildren ? '0' : 'auto' }}>
              ⏱ {(data.duration / 1000).toFixed(1)}s
              {data.ttft ? ` (TTFT: ${(data.ttft / 1000).toFixed(1)}s)` : ''}
            </span>
          )}
        </div>
      )}
      {data.usage && (
        <div style={{ fontSize: '9px', opacity: 0.6, marginTop: '4px', display: 'flex', gap: '6px' }}>
          <span>Tokens: {data.usage.totalTokens?.toLocaleString() || '?'}</span>
          <span>(P: {data.usage.promptTokens?.toLocaleString() || '?'}, C: {data.usage.completionTokens?.toLocaleString() || '?'})</span>
        </div>
      )}
      {data.errorMessage && (
        <div style={{ fontSize: '9px', color: '#f85149', marginTop: '4px' }}>
          ⚠ {data.errorMessage.slice(0, 80)}
        </div>
      )}
      <Handle type="target" position={Position.Top} />
      <Handle type="source" position={Position.Bottom} />
      <Handle type="source" position={Position.Right} id="children" />
    </div>
  );
}
