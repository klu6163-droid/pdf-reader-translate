// 批注在页面上的视觉呈现（高亮 / 下划线 / 删除线 / 矩形 / 画笔 / 便签图标）
import { StickyNote } from 'lucide-react';
import type { PdfAnnotation } from '@/types';

interface Props {
  a: PdfAnnotation;
  scale: number;
  selected: boolean;
  flash: boolean;
  interactive: boolean;
  onSelect: () => void;
}

export default function AnnotOverlay({ a, scale, selected, flash, interactive, onSelect }: Props) {
  const common: React.CSSProperties = {
    pointerEvents: interactive ? 'auto' : 'none',
    cursor: interactive ? 'pointer' : undefined,
  };
  const ring = selected
    ? '0 0 0 2px rgba(59,130,246,.85)'
    : flash
      ? '0 0 0 3px rgba(59,130,246,.6)'
      : undefined;

  if ((a.type === 'highlight' || a.type === 'underline' || a.type === 'strikeout') && a.quads) {
    return (
      <>
        {a.quads.map((q, i) => {
          const [x0, y0, x1, y1] = q;
          const base: React.CSSProperties = {
            ...common,
            position: 'absolute',
            left: x0 * scale,
            width: (x1 - x0) * scale,
            boxShadow: ring,
          };
          if (a.type === 'highlight') {
            return (
              <div
                key={i}
                onClick={onSelect}
                style={{
                  ...base,
                  top: y0 * scale,
                  height: (y1 - y0) * scale,
                  background: a.color,
                  opacity: 0.38,
                  mixBlendMode: 'multiply',
                }}
              />
            );
          }
          const lineTop =
            a.type === 'underline' ? y1 * scale - 2 : (y0 + (y1 - y0) / 2) * scale - 1;
          return (
            <div
              key={i}
              onClick={onSelect}
              style={{
                ...base,
                top: lineTop,
                height: 2,
                background: a.color,
              }}
            />
          );
        })}
      </>
    );
  }

  if (a.type === 'rectangle' && a.rect) {
    const [x0, y0, x1, y1] = a.rect;
    return (
      <div
        onClick={onSelect}
        style={{
          ...common,
          position: 'absolute',
          left: x0 * scale,
          top: y0 * scale,
          width: (x1 - x0) * scale,
          height: (y1 - y0) * scale,
          border: `1.5px solid ${a.color}`,
          boxShadow: ring,
        }}
      />
    );
  }

  if (a.type === 'ink' && a.ink) {
    return (
      <svg
        className="absolute inset-0"
        style={{ ...common, width: '100%', height: '100%', overflow: 'visible' }}
        onClick={onSelect}
      >
        {a.ink.map((stroke, i) => (
          <polyline
            key={i}
            points={stroke.map(([x, y]) => `${x * scale},${y * scale}`).join(' ')}
            fill="none"
            stroke={a.color}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ filter: ring ? 'drop-shadow(0 0 2px rgba(59,130,246,.9))' : undefined }}
          />
        ))}
      </svg>
    );
  }

  if (a.type === 'note' && a.rect) {
    const [x0, y0] = a.rect;
    return (
      <div
        onClick={onSelect}
        title={a.comment}
        style={{
          ...common,
          pointerEvents: 'auto', // 便签始终可点（不挡文字选择：面积小）
          cursor: 'pointer',
          position: 'absolute',
          left: x0 * scale,
          top: y0 * scale,
          boxShadow: ring,
          borderRadius: 3,
        }}
        className="flex items-center justify-center w-5 h-5 rounded-sm"
      >
        <StickyNote size={18} style={{ color: a.color, fill: `${a.color}55` }} strokeWidth={2} />
      </div>
    );
  }
  return null;
}
