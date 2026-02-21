import React from 'react';
import { Handle, Position } from '@xyflow/react';

interface SubAgentNodeData {
  agentName: string;
  description: string;
  prompt: string;
  result: string;
  parentToolId?: string;
  toolCount?: number;
  childNodes?: unknown[];
  onShowDetails?: () => void;
}

export function SubAgentNode({ data }: { data: SubAgentNodeData }) {
  const hasChildren = (data.toolCount || 0) > 0 || (data.childNodes?.length || 0) > 0;

  return (
    <div
      style={{
        padding: '8px 12px',
        border: '2px solid var(--vscode-charts-orange, #d29922)',
        borderRadius: '8px',
        background: 'rgba(210, 153, 34, 0.15)',
        color: 'var(--vscode-editor-foreground, #fff)',
        minWidth: '180px',
        maxWidth: '280px',
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
      <div style={{ fontWeight: 'bold', fontSize: '11px', marginBottom: '3px', paddingRight: '16px' }}>
        🤖 {data.agentName}
      </div>
      {data.description && (
        <div
          style={{
            fontSize: '10px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            opacity: 0.85,
          }}
        >
          {data.description}
        </div>
      )}
      {data.result && (
        <div style={{ fontSize: '9px', opacity: 0.6, marginTop: '3px' }}>
          Result: {data.result.length > 60 ? data.result.slice(0, 60) + '…' : data.result}
        </div>
      )}
      {hasChildren && (
        <div style={{ display: 'flex', gap: '5px', marginTop: '4px', alignItems: 'center' }}>
          <span style={{ fontSize: '9px', background: 'rgba(137,87,229,0.25)', padding: '1px 5px', borderRadius: '3px' }}>
            🔧 {data.toolCount ?? data.childNodes?.length}
          </span>
          <span style={{ fontSize: '9px', opacity: 0.5, marginLeft: 'auto' }}>
            click to expand ▸
          </span>
        </div>
      )}
      <Handle type="target" position={Position.Left} />
      {hasChildren && <Handle type="source" position={Position.Right} id="children" />}
    </div>
  );
}
