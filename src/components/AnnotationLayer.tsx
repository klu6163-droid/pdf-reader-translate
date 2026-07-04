// 标注叠加层：每页一个，渲染该页标注 + 捕获鼠标创建新标注。
// 坐标一律用页面相对值（0~1），渲染时按百分比定位，与缩放无关。
// 工具为 select 时不拦截事件（让文字层正常选词）。

import { useCallback, useRef, useState } from "react";
import { useAnnotations } from "@/store/useAnnotations";
import type { Annotation } from "@/types";

interface Props {
  pdfId: string;
  pageNumber: number;
}

export default function AnnotationLayer({ pdfId, pageNumber }: Props) {
  const tool = useAnnotations((s) => s.tool);
  const color = useAnnotations((s) => s.color);
  const anns = useAnnotations((s) => s.annotations[pdfId] || []);
  const addAnnotation = useAnnotations((s) => s.addAnnotation);

  const layerRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const drawingRef = useRef(false);
  const [draft, setDraft] = useState<Annotation | null>(null);
  const draftRef = useRef<Annotation | null>(null);
  const setDraftSync = useCallback((d: Annotation | null) => {
    draftRef.current = d;
    setDraft(d);
  }, []);

  const active = tool !== "select";
  const pageAnns = anns.filter((a) => a.page === pageNumber);
  const shown = draft ? [...pageAnns, draft] : pageAnns;

  const toRel = useCallback((clientX: number, clientY: number) => {
    const rect = layerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)),
    };
  }, []);

  const onMouseDown = (e: React.MouseEvent) => {
    if (!active) return;
    e.preventDefault();
    const p = toRel(e.clientX, e.clientY);
    if (tool === "note") {
      const text = window.prompt("输入批注内容：") || "";
      if (text.trim()) {
        addAnnotation(pdfId, {
          id: crypto.randomUUID(),
          type: "note",
          page: pageNumber,
          x: p.x,
          y: p.y,
          text,
          color,
        });
      }
      return;
    }
    startRef.current = p;
    drawingRef.current = true;
    if (tool === "highlight") {
      setDraftSync({ id: "draft", type: "highlight", page: pageNumber, x: p.x, y: p.y, w: 0, h: 0, color });
    } else if (tool === "draw") {
      setDraftSync({ id: "draft", type: "draw", page: pageNumber, points: [p], color });
    }
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (!active || !drawingRef.current || !startRef.current) return;
    const p = toRel(e.clientX, e.clientY);
    const s = startRef.current;
    const d = draftRef.current;
    if (!d) return;
    if (d.type === "highlight") {
      setDraftSync({
        ...d,
        x: Math.min(s.x, p.x),
        y: Math.min(s.y, p.y),
        w: Math.abs(p.x - s.x),
        h: Math.abs(p.y - s.y),
      });
    } else if (d.type === "draw") {
      setDraftSync({ ...d, points: [...(d.points || []), p] });
    }
  };

  const onMouseUp = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    startRef.current = null;
    const d = draftRef.current;
    if (d) {
      if (d.type === "highlight" && (d.w || 0) > 0.005 && (d.h || 0) > 0.005) {
        addAnnotation(pdfId, { ...d, id: crypto.randomUUID() });
      } else if (d.type === "draw" && (d.points || []).length > 1) {
        addAnnotation(pdfId, { ...d, id: crypto.randomUUID() });
      }
    }
    setDraftSync(null);
  };

  return (
    <div
      ref={layerRef}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      className="absolute inset-0 z-[2]"
      style={{
        pointerEvents: active ? "auto" : "none",
        cursor: active ? "crosshair" : "default",
      }}
    >
      {shown.map((a) => {
        if (a.type === "highlight") {
          return (
            <div
              key={a.id}
              style={{
                position: "absolute",
                left: `${(a.x || 0) * 100}%`,
                top: `${(a.y || 0) * 100}%`,
                width: `${(a.w || 0) * 100}%`,
                height: `${(a.h || 0) * 100}%`,
                background: a.color,
                opacity: 0.4,
                mixBlendMode: "multiply",
                pointerEvents: "none",
              }}
            />
          );
        }
        if (a.type === "draw") {
          const pts = (a.points || [])
            .map((p) => `${p.x * 100},${p.y * 100}`)
            .join(" ");
          return (
            <svg
              key={a.id}
              className="absolute inset-0 w-full h-full pointer-events-none"
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
            >
              <polyline
                points={pts}
                fill="none"
                stroke={a.color}
                strokeWidth={1.5}
                style={{ vectorEffect: "non-scaling-stroke" } as React.CSSProperties}
              />
            </svg>
          );
        }
        // note
        return (
          <div
            key={a.id}
            style={{
              position: "absolute",
              left: `${(a.x || 0) * 100}%`,
              top: `${(a.y || 0) * 100}%`,
              pointerEvents: "none",
            }}
          >
            <div className="relative -translate-x-1/2 -translate-y-1/2">
              <div
                className="w-5 h-5 rounded-full border-2 border-white shadow flex items-center justify-center text-[10px] text-white font-bold"
                style={{ background: a.color }}
              >
                T
              </div>
              {a.text && (
                <div className="absolute left-1/2 top-full mt-1 -translate-x-1/2 whitespace-pre-wrap max-w-[200px] px-2 py-1 rounded bg-white border text-xs text-slate-700 shadow">
                  {a.text}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
