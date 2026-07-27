// 笔记就地输入气泡（跟随落点显示，越界翻转）
import { StickyNote, Trash2, X } from "lucide-react";
import { PALETTE } from "./constants";
import type { PdfAnnotation } from "@/types";

interface Props {
  annot: PdfAnnotation;
  scale: number;
  pageW: number;
  pageH: number;
  onPatch: (p: Partial<PdfAnnotation>) => void;
  onRemove: () => void;
  onClose: () => void;
}

export default function NoteBubble({ annot, scale, pageW, pageH, onPatch, onRemove, onClose }: Props) {
  const [x0, y0] = annot.rect!;
  const BUBBLE_W = 240;
  const BUBBLE_H = 150;
  // 默认贴在图标右侧；越界则翻到左侧/上方，保证气泡完整可见
  let left = x0 * scale + 24;
  if (left + BUBBLE_W > pageW - 4) left = Math.max(4, x0 * scale - BUBBLE_W - 6);
  let top = y0 * scale - 4;
  if (top + BUBBLE_H > pageH - 4) top = Math.max(4, pageH - BUBBLE_H - 4);

  // 新建时为空 → 关闭时若仍为空自动删除，避免留下无内容的孤儿便签
  const emptyOnCloseRemoves = () => {
    if (!annot.comment.trim()) onRemove();
    else onClose();
  };

  return (
    <div
      className="absolute z-30 bg-white rounded-lg shadow-xl border border-slate-200 p-2 space-y-1.5"
      style={{ left, top, width: BUBBLE_W }}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-1.5 text-xs text-slate-500">
        <StickyNote size={13} style={{ color: annot.color }} />
        <span>笔记 · 第 {annot.page + 1} 页</span>
        {annot.source === "pdf" && (
          <span className="text-[10px] px-1 bg-slate-100 text-slate-400 rounded">原有</span>
        )}
        <button
          onClick={emptyOnCloseRemoves}
          className="ml-auto text-slate-400 hover:text-slate-600"
          title="完成"
        >
          <X size={13} />
        </button>
      </div>
      <textarea
        autoFocus
        value={annot.comment}
        onChange={(e) => onPatch({ comment: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
            e.preventDefault();
            emptyOnCloseRemoves();
          }
        }}
        placeholder="输入笔记内容...（Ctrl+Enter 完成）"
        className="w-full h-20 text-sm border rounded p-1.5 resize-none outline-none focus:border-primary-400"
      />
      <div className="flex items-center gap-1.5">
        {PALETTE.map((c) => (
          <button
            key={c}
            onClick={() => onPatch({ color: c })}
            className={`w-3.5 h-3.5 rounded-full border ${
              annot.color === c ? "ring-2 ring-offset-1 ring-slate-400" : "border-slate-300"
            }`}
            style={{ background: c }}
          />
        ))}
        <button
          onClick={onRemove}
          className="ml-auto flex items-center gap-1 px-1.5 py-0.5 text-xs text-red-600 hover:bg-red-50 rounded"
        >
          <Trash2 size={12} />
          删除
        </button>
      </div>
    </div>
  );
}
