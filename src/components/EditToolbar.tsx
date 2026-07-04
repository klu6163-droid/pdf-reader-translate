// 编辑工具栏：工具切换 + 颜色 + 线宽 + 撤销/重做 + 图片插入 + 页面操作入口 + 导出。
// 工具/颜色/线宽全局共享（useEditStore）。

import { useRef } from "react";
import {
  MousePointer2, Type, Highlighter, Underline, Pen, Square,
  ArrowUpRight, ImagePlus, Undo2, Redo2, Layers, Download,
} from "lucide-react";
import clsx from "clsx";
import { useEditStore } from "@/store/useEditStore";
import type { EditTool } from "@/types/editTypes";

const COLORS = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7", "#111827"];
const WIDTHS = [1, 2, 4];

interface Props {
  pdfId: string;
  onExport: () => void;
  onTogglePages: () => void;
}

export default function EditToolbar({ pdfId, onExport, onTogglePages }: Props) {
  const tool = useEditStore((s) => s.tool);
  const setTool = useEditStore((s) => s.setTool);
  const color = useEditStore((s) => s.color);
  const setColor = useEditStore((s) => s.setColor);
  const strokeWidth = useEditStore((s) => s.strokeWidth);
  const setStrokeWidth = useEditStore((s) => s.setStrokeWidth);
  const setPendingImage = useEditStore((s) => s.setPendingImage);
  const undo = useEditStore((s) => s.undo);
  const redo = useEditStore((s) => s.redo);
  const histLen = useEditStore((s) => s.history[pdfId]?.length || 0);
  const histIdx = useEditStore((s) => s.historyIndex[pdfId] ?? 0);
  const canUndo = histIdx > 0;
  const canRedo = histIdx < histLen - 1;
  const fileInput = useRef<HTMLInputElement>(null);

  const tools: { key: EditTool; icon: JSX.Element; label: string }[] = [
    { key: "select", icon: <MousePointer2 size={15} />, label: "选择 / 划词" },
    { key: "text", icon: <Type size={15} />, label: "文字" },
    { key: "highlight", icon: <Highlighter size={15} />, label: "高亮" },
    { key: "underline", icon: <Underline size={15} />, label: "下划线" },
    { key: "draw", icon: <Pen size={15} />, label: "画笔" },
    { key: "rectangle", icon: <Square size={15} />, label: "矩形" },
    { key: "arrow", icon: <ArrowUpRight size={15} />, label: "箭头" },
    { key: "redact", icon: <Square size={15} />, label: "遮盖" },
  ];

  const onPickImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setPendingImage(reader.result as string);
    reader.readAsDataURL(f);
    e.target.value = "";
  };

  return (
    <div className="flex items-center gap-0.5">
      {tools.map((t) => (
        <button
          key={t.key}
          onClick={() => setTool(t.key)}
          title={t.label}
          className={clsx(
            "p-1 rounded",
            tool === t.key ? "bg-primary-100 text-primary-700" : "text-slate-500 hover:bg-slate-100"
          )}
        >
          {t.icon}
        </button>
      ))}
      <button
        onClick={() => fileInput.current?.click()}
        title="插入图片"
        className={clsx("p-1 rounded", tool === "image" ? "bg-primary-100 text-primary-700" : "text-slate-500 hover:bg-slate-100")}
      >
        <ImagePlus size={15} />
      </button>
      <input ref={fileInput} type="file" accept="image/*" className="hidden" onChange={onPickImage} />

      <span className="w-px h-4 bg-slate-200 mx-1" />
      {COLORS.map((c) => (
        <button
          key={c}
          onClick={() => setColor(c)}
          className={clsx(
            "w-4 h-4 rounded-full border",
            color === c ? "ring-2 ring-primary-400 border-white" : "border-slate-300 hover:scale-110"
          )}
          style={{ background: c }}
        />
      ))}
      <span className="w-px h-4 bg-slate-200 mx-1" />
      {WIDTHS.map((w) => (
        <button
          key={w}
          onClick={() => setStrokeWidth(w)}
          title={`线宽 ${w}`}
          className={clsx(
            "px-1.5 py-0.5 rounded text-[10px]",
            strokeWidth === w ? "bg-primary-100 text-primary-700" : "text-slate-500 hover:bg-slate-100"
          )}
        >
          {w}
        </button>
      ))}
      <span className="w-px h-4 bg-slate-200 mx-1" />
      <button onClick={() => undo(pdfId)} disabled={!canUndo} title="撤销" className="p-1 rounded text-slate-500 hover:bg-slate-100 disabled:opacity-30">
        <Undo2 size={15} />
      </button>
      <button onClick={() => redo(pdfId)} disabled={!canRedo} title="重做" className="p-1 rounded text-slate-500 hover:bg-slate-100 disabled:opacity-30">
        <Redo2 size={15} />
      </button>
      <button onClick={onTogglePages} title="页面操作" className="p-1 rounded text-slate-500 hover:bg-slate-100">
        <Layers size={15} />
      </button>
      <button onClick={onExport} title="导出编辑后的 PDF" className="p-1 rounded text-slate-500 hover:bg-slate-100">
        <Download size={15} />
      </button>
    </div>
  );
}
