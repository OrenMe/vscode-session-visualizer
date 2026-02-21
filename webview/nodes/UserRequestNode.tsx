import React from 'react';
import { Handle, Position } from '@xyflow/react';

interface UserRequestNodeData {
  text: string;
  turnNumber?: number;
  timestamp?: number;
  variableCount: number;
  variableNames?: string[];
  modelId?: string;
  timeSpentWaiting?: number;
  onShowDetails?: () => void;
}

export function UserRequestNode({ data }: { data: UserRequestNodeData }) {
  return (
    <div
      style={{
        padding: '10px 14px',
        border: '2px solid var(--vscode-charts-blue, #0066cc)',
        borderRadius: '8px',
        background: 'var(--vscode-input-background, #e3f2fd)',
        color: 'var(--vscode-input-foreground, #000)',
        minWidth: '220px',
        maxWidth: '320px',
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
          👤 Turn {data.turnNumber || '?'}
        </div>
        {data.modelId && (
          <div style={{ fontSize: '9px', opacity: 0.6, background: 'rgba(0,0,0,0.1)', padding: '1px 5px', borderRadius: '3px' }}>
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
          WebkitLineClamp: 3,
          WebkitBoxOrient: 'vertical',
          lineHeight: '1.3',
        }}
      >
        {data.text}
      </div>
      <div style={{ display: 'flex', gap: '6px', marginTop: '6px', flexWrap: 'wrap' }}>
        {data.timestamp && (
          <span style={{ fontSize: '9px', opacity: 0.6 }}>
            {new Date(data.timestamp).toLocaleTimeString()}
          </span>
        )}
        {data.variableCount > 0 && (
          <span style={{ fontSize: '9px', background: 'rgba(0,102,204,0.2)', padding: '1px 4px', borderRadius: '3px' }}>
            📎 {data.variableCount} var{data.variableCount > 1 ? 's' : ''}
          </span>
        )}
        {data.timeSpentWaiting && data.timeSpentWaiting > 0 && (
          <span style={{ fontSize: '9px', opacity: 0.5 }}>
            ⏱ {data.timeSpentWaiting}ms
          </span>
        )}
      </div>
      <Handle type="target" position={Position.Top} />
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
