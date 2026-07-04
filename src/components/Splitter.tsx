// 左右分栏的拖拽分隔条。
// 拖动调整左栏占比（clamp 到 0.2~0.8），双击重置 50/50。
// 拖动期间挂全屏遮罩，防止 PDF canvas / 文字层抢鼠标事件、防误选文字。

import { useCallback, useRef, useState } from "react";
import { useStore } from "@/store/useSettings";

const MIN = 0.2;
const MAX = 0.8;

export default function Splitter() {
  const setSplitRatio = useStore((s) => s.setSplitRatio);
  const [dragging, setDragging] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const parent = barRef.current?.parentElement;
      if (!parent) return;
      const rect = parent.getBoundingClientRect();
      setDragging(true);

      const move = (ev: MouseEvent) => {
        const ratio = (ev.clientX - rect.left) / rect.width;
        setSplitRatio(Math.min(MAX, Math.max(MIN, ratio)));
      };
      const up = () => {
        setDragging(false);
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [setSplitRatio]
  );

  const onDoubleClick = useCallback(
    () => setSplitRatio(0.5),
    [setSplitRatio]
  );

  return (
    <>
      <div
        ref={barRef}
        onMouseDown={onMouseDown}
        onDoubleClick={onDoubleClick}
        title="拖动调整左右比例，双击重置"
        className={`w-1.5 shrink-0 cursor-col-resize transition-colors ${
          dragging ? "bg-primary-500" : "bg-slate-200 hover:bg-primary-400"
        }`}
      />
      {dragging && (
        <div className="fixed inset-0 z-50 cursor-col-resize select-none" />
      )}
    </>
  );
}
