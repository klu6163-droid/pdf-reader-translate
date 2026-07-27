// 右侧批注列表（按页分组 + 跳转 + 导出）
import { FileJson, FileText, Trash2 } from "lucide-react";
import { TYPE_LABELS } from "./constants";
import type { PdfAnnotation } from "@/types";

interface Props {
  annotations: PdfAnnotation[];
  selectedId: string | null;
  onJump: (a: PdfAnnotation) => void;
  onRemove: (id: string) => void;
  onExport: (fmt: "json" | "markdown") => void;
}

export default function AnnotList({ annotations, selectedId, onJump, onRemove, onExport }: Props) {
  const byPage = new Map<number, PdfAnnotation[]>();
  for (const a of annotations) {
    const list = byPage.get(a.page) ?? [];
    list.push(a);
    byPage.set(a.page, list);
  }
  const pagesSorted = Array.from(byPage.keys()).sort((x, y) => x - y);

  return (
    <div className="w-72 bg-white border-l flex flex-col shrink-0">
      <div className="flex items-center gap-2 px-3 h-9 border-b text-sm shrink-0">
        <span className="font-medium text-slate-700">批注列表</span>
        <span className="text-xs text-slate-400">{annotations.length}</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => onExport("json")}
            className="p-1 text-slate-500 hover:bg-slate-100 rounded"
            title="导出 JSON（复制到剪贴板）"
          >
            <FileJson size={14} />
          </button>
          <button
            onClick={() => onExport("markdown")}
            className="p-1 text-slate-500 hover:bg-slate-100 rounded"
            title="导出 Markdown（复制到剪贴板）"
          >
            <FileText size={14} />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        {annotations.length === 0 && (
          <p className="text-xs text-slate-400 text-center mt-8 px-4">
            还没有批注。选择上方工具，在 PDF 上划选文字或绘制即可添加。
          </p>
        )}
        {pagesSorted.map((pno) => (
          <div key={pno}>
            <div className="px-3 py-1 text-[11px] text-slate-400 bg-slate-50 sticky top-0">
              第 {pno + 1} 页
            </div>
            {byPage.get(pno)!.map((a) => (
              <div
                key={a.id}
                onClick={() => onJump(a)}
                className={`px-3 py-2 border-b border-slate-100 cursor-pointer hover:bg-slate-50 ${
                  selectedId === a.id ? "bg-primary-50" : ""
                }`}
              >
                <div className="flex items-center gap-1.5 text-xs">
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ background: a.color }}
                  />
                  <span className="text-slate-600 font-medium">{TYPE_LABELS[a.type]}</span>
                  {a.source === "pdf" && (
                    <span className="text-[10px] px-1 bg-slate-100 text-slate-400 rounded">原有</span>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemove(a.id);
                    }}
                    className="ml-auto p-0.5 text-slate-300 hover:text-red-500"
                    title="删除"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
                {(a.text || a.comment) && (
                  <p className="mt-1 text-xs text-slate-500 line-clamp-2">
                    {a.comment ? `💬 ${a.comment}` : a.text}
                  </p>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
