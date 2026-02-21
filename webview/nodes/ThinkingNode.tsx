import React, { useState } from 'react';
import { Handle, Position } from '@xyflow/react';

interface ThinkingNodeData {
  text: string;
  fullText?: string;
  charCount?: number;
  wordCount?: number;
  lineCount?: number;
  readingTimeSec?: number;
  onShowDetails?: () => void;
}

export function ThinkingNode({ data }: { data: ThinkingNodeData }) {
  const [expanded, setExpanded] = useState(false);
  const fullText = data.fullText || data.text;
  const charCount = data.charCount || fullText.length;
  const wc = data.wordCount ?? (fullText.trim() ? fullText.trim().split(/\s+/).length : 0);
  const readSec = data.readingTimeSec ?? Math.ceil((wc / 200) * 60);
  const readLabel = readSec < 60 ? `${readSec}s read` : `${Math.round(readSec / 60)}m read`;

  return (
    <div
      style={{
        padding: '8px 12px',
        border: '2px solid var(--vscode-descriptionForeground, #8b949e)',
        borderRadius: '8px',
        background: 'rgba(139, 148, 158, 0.1)',
        color: 'var(--vscode-editor-foreground, #fff)',
        minWidth: '160px',
        maxWidth: expanded ? '420px' : '260px',
        cursor: 'pointer',
        position: 'relative',
      }}
      onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
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
        <span style={{ fontWeight: 'bold', fontSize: '11px' }}>
          🧠 Thinking {expanded ? '▾' : '▸'}
        </span>
        <span style={{ fontSize: '9px', opacity: 0.5 }}>
          {wc} words
        </span>
      </div>
      <div style={{ display: 'flex', gap: '6px', marginBottom: '4px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '8px', opacity: 0.5 }}>
          {charCount.toLocaleString()} chars
        </span>
        {(data.lineCount || 0) > 1 && (
          <span style={{ fontSize: '8px', opacity: 0.5 }}>
            · {data.lineCount} lines
          </span>
        )}
        <span style={{ fontSize: '8px', opacity: 0.5 }}>
          · {readLabel}
        </span>
      </div>
      {expanded ? (
        <div
          className="nowheel"
          style={{
            fontSize: '10px',
            lineHeight: '1.4',
            whiteSpace: 'pre-wrap',
            maxHeight: '320px',
            overflow: 'auto',
          }}
        >
          {fullText}
        </div>
      ) : (
        <div
          style={{
            fontSize: '10px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            display: '-webkit-box',
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical',
            lineHeight: '1.4',
            opacity: 0.7,
          }}
        >
          {fullText.slice(0, 200)}
        </div>
      )}
      <Handle type="target" position={Position.Left} />
    </div>
  );
}
