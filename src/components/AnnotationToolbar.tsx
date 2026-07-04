// 标注工具栏：工具切换（选择/高亮/画线/批注）+ 颜色 + 撤销/清空。
// 工具与颜色全局共享（存于 useAnnotations）。

import {
  MousePointer2,
  Highlighter,
  Pen,
  StickyNote,
  Undo2,
  Eraser,
} from "lucide-react";
import clsx from "clsx";
import { useAnnotations } from "@/store/useAnnotations";
import type { AnnotationTool } from "@/types";

const COLORS = [
  "#fde047", // yellow-300
  "#fca5a5", // red-300
  "#86efac", // green-300
  "#93c5fd", // blue-300
  "#c4b5fd", // violet-300
  "#111827", // near black
];

interface Props {
  pdfId: string;
}

export default function AnnotationToolbar({ pdfId }: Props) {
  const tool = useAnnotations((s) => s.tool);
  const setTool = useAnnotations((s) => s.setTool);
  const color = useAnnotations((s) => s.color);
  const setColor = useAnnotations((s) => s.setColor);
  const anns = useAnnotations((s) => s.annotations[pdfId] || []);
  const removeAnnotation = useAnnotations((s) => s.removeAnnotation);
  const clearAnnotations = useAnnotations((s) => s.clearAnnotations);

  const tools: { key: AnnotationTool; icon: JSX.Element; label: string }[] = [
    { key: "select", icon: <MousePointer2 size={15} />, label: "选择 / 划词" },
    { key: "highlight", icon: <Highlighter size={15} />, label: "高亮" },
    { key: "draw", icon: <Pen size={15} />, label: "画线" },
    { key: "note", icon: <StickyNote size={15} />, label: "批注" },
  ];

  return (
    <div className="flex items-center gap-1">
      {tools.map((t) => (
        <button
          key={t.key}
          onClick={() => setTool(t.key)}
          title={t.label}
          className={clsx(
            "p-1 rounded",
            tool === t.key
              ? "bg-primary-100 text-primary-700"
              : "text-slate-500 hover:bg-slate-100"
          )}
        >
          {t.icon}
        </button>
      ))}
      <span className="w-px h-4 bg-slate-200 mx-1" />
      {COLORS.map((c) => (
        <button
          key={c}
          onClick={() => setColor(c)}
          className={clsx(
            "w-4 h-4 rounded-full border",
            color === c
              ? "ring-2 ring-primary-400 border-white"
              : "border-slate-300 hover:scale-110"
          )}
          style={{ background: c }}
          title={c}
        />
      ))}
      <span className="w-px h-4 bg-slate-200 mx-1" />
      <button
        onClick={() => {
          const last = anns[anns.length - 1];
          if (last) removeAnnotation(pdfId, last.id);
        }}
        disabled={!anns.length}
        title="撤销最近一条标注"
        className="p-1 rounded text-slate-500 hover:bg-slate-100 disabled:opacity-30"
      >
        <Undo2 size={15} />
      </button>
      <button
        onClick={() => {
          if (anns.length && window.confirm("清空本 PDF 的全部标注？")) {
            clearAnnotations(pdfId);
          }
        }}
        disabled={!anns.length}
        title="清空本 PDF 全部标注"
        className="p-1 rounded text-slate-500 hover:bg-slate-100 disabled:opacity-30"
      >
        <Eraser size={15} />
      </button>
    </div>
  );
}
