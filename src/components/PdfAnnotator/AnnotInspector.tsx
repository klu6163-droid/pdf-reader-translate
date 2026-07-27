// 选中批注的编辑面板（左下角固定，非 note 类型使用；note 走 NoteBubble）
import { Trash2, X } from "lucide-react";
import { PALETTE, TYPE_LABELS } from "./constants";
import type { PdfAnnotation } from "@/types";

interface Props {
  annot: PdfAnnotation;
  onPatch: (p: Partial<PdfAnnotation>) => void;
  onRemove: () => void;
  onClose: () => void;
}

export default function AnnotInspector({ annot, onPatch, onRemove, onClose }: Props) {
  return (
    <div className="absolute bottom-4 left-4 z-30 w-72 bg-white rounded-lg shadow-xl border p-3 space-y-2">
      <div className="flex items-center gap-2 text-sm">
        <span className="w-3 h-3 rounded-full shrink-0" style={{ background: annot.color }} />
        <span className="font-medium text-slate-700">
          {TYPE_LABELS[annot.type]} · 第 {annot.page + 1} 页
        </span>
        {annot.source === "pdf" && (
          <span className="text-[10px] px-1 py-0.5 bg-slate-100 text-slate-500 rounded">原有</span>
        )}
        <button onClick={onClose} className="ml-auto text-slate-400 hover:text-slate-600">
          <X size={14} />
        </button>
      </div>

      {annot.text && (
        <p className="text-xs text-slate-500 bg-slate-50 rounded p-1.5 max-h-16 overflow-auto">
          {annot.text}
        </p>
      )}

      <textarea
        value={annot.comment}
        onChange={(e) => onPatch({ comment: e.target.value })}
        placeholder="写点批注..."
        autoFocus={annot.type === "note" && !annot.comment}
        className="w-full h-16 text-sm border rounded p-1.5 resize-none outline-none focus:border-primary-400"
      />

      <div className="flex items-center gap-1.5">
        {PALETTE.map((c) => (
          <button
            key={c}
            onClick={() => onPatch({ color: c })}
            disabled={annot.source === "pdf"}
            className={`w-4 h-4 rounded-full border disabled:opacity-40 ${
              annot.color === c ? "ring-2 ring-offset-1 ring-slate-400" : "border-slate-300"
            }`}
            style={{ background: c }}
          />
        ))}
        <button
          onClick={onRemove}
          className="ml-auto flex items-center gap-1 px-2 py-1 text-xs text-red-600 hover:bg-red-50 rounded"
        >
          <Trash2 size={13} />
          删除
        </button>
      </div>
    </div>
  );
}
