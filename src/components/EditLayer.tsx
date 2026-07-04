// 编辑叠加层：每页一个，渲染该页 overlays + 捕获鼠标创建新 overlay。
// 坐标用页面相对值 (0~1, y 向下，相对未旋转页)；页面旋转时用 rotPt/unrotPt 变换。
// 工具为 select 时不拦截事件（让文字层正常划词）。

import { useCallback, useRef, useState } from "react";
import { useEditStore } from "@/store/useEditStore";
import type { Overlay } from "@/types/editTypes";

interface Props {
  pdfId: string;
  pageNumber: number; // 原始页号
  rotation: number;
}

// 未旋转 rel → 显示 rel
function rotPt(x: number, y: number, r: number): { x: number; y: number } {
  switch (((r % 360) + 360) % 360) {
    case 90: return { x: 1 - y, y: x };
    case 180: return { x: 1 - x, y: 1 - y };
    case 270: return { x: y, y: 1 - x };
    default: return { x, y };
  }
}
// 显示 rel → 未旋转 rel（鼠标坐标存储用）
function unrotPt(x: number, y: number, r: number): { x: number; y: number } {
  switch (((r % 360) + 360) % 360) {
    case 90: return { x: y, y: 1 - x };
    case 180: return { x: 1 - x, y: 1 - y };
    case 270: return { x: 1 - y, y: x };
    default: return { x, y };
  }
}
function rotRect(x: number, y: number, w: number, h: number, r: number) {
  const cs = [rotPt(x, y, r), rotPt(x + w, y, r), rotPt(x, y + h, r), rotPt(x + w, y + h, r)];
  const xs = cs.map((c) => c.x);
  const ys = cs.map((c) => c.y);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}

export default function EditLayer({ pdfId, pageNumber, rotation }: Props) {
  const tool = useEditStore((s) => s.tool);
  const color = useEditStore((s) => s.color);
  const strokeWidth = useEditStore((s) => s.strokeWidth);
  const pendingImage = useEditStore((s) => s.pendingImage);
  const overlays = useEditStore((s) => s.states[pdfId]?.overlays || []);
  const addOverlay = useEditStore((s) => s.addOverlay);
  const setPendingImage = useEditStore((s) => s.setPendingImage);

  const layerRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const drawingRef = useRef(false);
  const [draft, setDraft] = useState<Overlay | null>(null);
  const draftRef = useRef<Overlay | null>(null);
  const setDraftSync = useCallback((d: Overlay | null) => {
    draftRef.current = d;
    setDraft(d);
  }, []);

  const active = tool !== "select";
  const pageAnns = overlays.filter((o) => o.page === pageNumber);
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
    const up = unrotPt(p.x, p.y, rotation);
    if (tool === "text") {
      const text = window.prompt("输入文字：") || "";
      if (text.trim()) {
        addOverlay(pdfId, {
          id: crypto.randomUUID(), type: "text", page: pageNumber,
          x: up.x, y: up.y, text, fontSize: 16, color,
        });
      }
      return;
    }
    if (tool === "image" && pendingImage) {
      addOverlay(pdfId, {
        id: crypto.randomUUID(), type: "image", page: pageNumber,
        x: Math.max(0, up.x - 0.1), y: Math.max(0, up.y - 0.1),
        w: 0.2, h: 0.2, imageData: pendingImage, color: "#000",
      });
      setPendingImage(null);
      return;
    }
    startRef.current = up;
    drawingRef.current = true;
    if (tool === "draw") {
      setDraftSync({ id: "draft", type: "draw", page: pageNumber, points: [up], color, strokeWidth });
    } else if (tool === "arrow") {
      setDraftSync({ id: "draft", type: "arrow", page: pageNumber, x1: up.x, y1: up.y, x2: up.x, y2: up.y, color, strokeWidth });
    } else {
      // highlight / underline / rectangle / redact
      setDraftSync({ id: "draft", type: tool as Overlay["type"], page: pageNumber, x: up.x, y: up.y, w: 0, h: 0, color, strokeWidth });
    }
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (!active || !drawingRef.current || !startRef.current) return;
    const p = toRel(e.clientX, e.clientY);
    const up = unrotPt(p.x, p.y, rotation);
    const s = startRef.current;
    const d = draftRef.current;
    if (!d) return;
    if (d.type === "draw") {
      setDraftSync({ ...d, points: [...(d.points || []), up] });
    } else if (d.type === "arrow") {
      setDraftSync({ ...d, x2: up.x, y2: up.y });
    } else {
      setDraftSync({ ...d, x: Math.min(s.x, up.x), y: Math.min(s.y, up.y), w: Math.abs(up.x - s.x), h: Math.abs(up.y - s.y) });
    }
  };

  const onMouseUp = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    startRef.current = null;
    const d = draftRef.current;
    if (d) {
      if (d.type === "draw" && (d.points || []).length > 1) {
        addOverlay(pdfId, { ...d, id: crypto.randomUUID() });
      } else if (d.type === "arrow" && (Math.abs((d.x2 || 0) - (d.x1 || 0)) > 0.005 || Math.abs((d.y2 || 0) - (d.y1 || 0)) > 0.005)) {
        addOverlay(pdfId, { ...d, id: crypto.randomUUID() });
      } else if (["highlight", "underline", "rectangle", "redact"].includes(d.type) && (d.w || 0) > 0.005 && (d.h || 0) > 0.005) {
        addOverlay(pdfId, { ...d, id: crypto.randomUUID() });
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
      style={{ pointerEvents: active ? "auto" : "none", cursor: active ? "crosshair" : "default" }}
    >
      {shown.map((a) => (
        <OverlayView key={a.id} o={a} rotation={rotation} />
      ))}
    </div>
  );
}

function OverlayView({ o, rotation }: { o: Overlay; rotation: number }) {
  if (o.type === "text") {
    const p = rotPt(o.x || 0, o.y || 0, rotation);
    return (
      <span
        style={{
          position: "absolute",
          left: `${p.x * 100}%`,
          top: `${p.y * 100}%`,
          color: o.color,
          fontSize: o.fontSize || 16,
          whiteSpace: "nowrap",
          pointerEvents: "none",
        }}
      >
        {o.text}
      </span>
    );
  }
  if (o.type === "draw") {
    const pts = (o.points || [])
      .map((p) => rotPt(p.x, p.y, rotation))
      .map((p) => `${p.x * 100},${p.y * 100}`)
      .join(" ");
    return (
      <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
        <polyline points={pts} fill="none" stroke={o.color} strokeWidth={o.strokeWidth || 2} style={{ vectorEffect: "non-scaling-stroke" } as React.CSSProperties} />
      </svg>
    );
  }
  if (o.type === "arrow") {
    const a = rotPt(o.x1 || 0, o.y1 || 0, rotation);
    const b = rotPt(o.x2 || 0, o.y2 || 0, rotation);
    const mid = `${o.id}`;
    return (
      <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
        <defs>
          <marker id={`ah-${mid}`} markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto" markerUnits="strokeWidth">
            <path d="M0,0 L6,3 L0,6 Z" fill={o.color} />
          </marker>
        </defs>
        <line
          x1={a.x * 100} y1={a.y * 100} x2={b.x * 100} y2={b.y * 100}
          stroke={o.color} strokeWidth={o.strokeWidth || 2}
          markerEnd={`url(#ah-${mid})`}
          style={{ vectorEffect: "non-scaling-stroke" } as React.CSSProperties}
        />
      </svg>
    );
  }
  // 矩形类
  const r = rotRect(o.x || 0, o.y || 0, o.w || 0, o.h || 0, rotation);
  const base: React.CSSProperties = {
    position: "absolute",
    left: `${r.x * 100}%`,
    top: `${r.y * 100}%`,
    width: `${r.w * 100}%`,
    height: `${r.h * 100}%`,
    pointerEvents: "none",
    boxSizing: "border-box",
  };
  if (o.type === "highlight") {
    return <div style={{ ...base, background: o.color, opacity: 0.4, mixBlendMode: "multiply" }} />;
  }
  if (o.type === "redact") {
    return <div style={{ ...base, background: "#000" }} />;
  }
  if (o.type === "underline") {
    return <div style={{ ...base, borderBottom: `${o.strokeWidth || 2}px solid ${o.color}` }} />;
  }
  if (o.type === "rectangle") {
    return <div style={{ ...base, border: `${o.strokeWidth || 2}px solid ${o.color}` }} />;
  }
  if (o.type === "image" && o.imageData) {
    return <img src={o.imageData} style={base} alt="" />;
  }
  return null;
}
