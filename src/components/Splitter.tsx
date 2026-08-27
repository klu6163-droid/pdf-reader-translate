// 左右分栏的拖拽分隔条。
// 拖动调整左栏占比（clamp 到 0.2~0.8），双击重置 50/50。
// 拖动期间挂全屏遮罩，防止 PDF canvas / 文字层抢鼠标事件、防误选文字。

import { useCallback, useRef, useState } from 'react';
import { useStore } from '@/store/useSettings';

const MIN = 0.2;
const MAX = 0.8;

export default function Splitter() {
  const splitRatio = useStore((s) => s.splitRatio);
  const setSplitRatio = useStore((s) => s.setSplitRatio);
  const [dragging, setDragging] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const parent = barRef.current?.parentElement;
      if (!parent) return;
      const rect = parent.getBoundingClientRect();
      setDragging(true);

      const move = (ev: PointerEvent) => {
        const ratio = (ev.clientX - rect.left) / rect.width;
        setSplitRatio(Math.min(MAX, Math.max(MIN, ratio)));
      };
      const up = () => {
        setDragging(false);
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [setSplitRatio],
  );

  const onDoubleClick = useCallback(() => setSplitRatio(0.5), [setSplitRatio]);

  return (
    <>
      <div
        ref={barRef}
        role="separator"
        aria-label="调整原文与功能面板宽度"
        aria-orientation="vertical"
        aria-valuemin={20}
        aria-valuemax={80}
        aria-valuenow={Math.round(splitRatio * 100)}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onDoubleClick={onDoubleClick}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') {
            event.preventDefault();
            setSplitRatio(Math.max(MIN, splitRatio - 0.02));
          } else if (event.key === 'ArrowRight') {
            event.preventDefault();
            setSplitRatio(Math.min(MAX, splitRatio + 0.02));
          } else if (event.key === 'Home') {
            event.preventDefault();
            setSplitRatio(MIN);
          } else if (event.key === 'End') {
            event.preventDefault();
            setSplitRatio(MAX);
          }
        }}
        title="拖动调整左右比例，双击重置"
        className="group relative w-2 shrink-0 cursor-col-resize rounded-full outline-none"
      >
        <span
          className={`absolute inset-y-1 left-1/2 w-0.5 -translate-x-1/2 rounded-full ${
            dragging ? 'bg-primary-500' : 'bg-slate-300 group-hover:bg-primary-400'
          }`}
        />
      </div>
      {dragging && <div className="fixed inset-0 z-50 cursor-col-resize select-none" />}
    </>
  );
}
