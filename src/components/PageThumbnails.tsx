// 页面管理面板：缩略图列表，支持删除 / 旋转 / 上下重排。
// MVP 用页号占位（不渲染真实缩略图，避免逐页 render 的性能开销）。

import { RotateCw, RotateCcw, Trash2, ArrowUp, ArrowDown, X } from "lucide-react";
import { useEditStore } from "@/store/useEditStore";

interface Props {
  pdfId: string;
  onClose: () => void;
}

export default function PageThumbnails({ pdfId, onClose }: Props) {
  const pageOrder = useEditStore((s) => s.states[pdfId]?.pageOrder) || [];
  const rotations = useEditStore((s) => s.states[pdfId]?.rotations) || {};
  const rotatePage = useEditStore((s) => s.rotatePage);
  const deletePage = useEditStore((s) => s.deletePage);
  const movePage = useEditStore((s) => s.movePage);

  return (
    <div className="absolute right-0 top-0 bottom-0 z-30 w-56 bg-white border-l shadow-lg flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b text-sm font-medium">
        页面管理
        <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
          <X size={16} />
        </button>
      </div>
      <div className="flex-1 overflow-auto p-2 space-y-2">
        {pageOrder.map((origPage, idx) => {
          const rot = rotations[origPage] || 0;
          return (
            <div key={origPage} className="flex items-center gap-2 p-2 border rounded">
              <div
                className="w-12 h-16 bg-slate-100 flex items-center justify-center text-xs text-slate-500 shrink-0"
                style={{ transform: `rotate(${rot}deg)` }}
              >
                P{origPage}
              </div>
              <div className="flex flex-col gap-1 text-slate-500">
                <div className="flex gap-1">
                  <button
                    onClick={() => rotatePage(pdfId, origPage, (rot + 270) % 360)}
                    title="左转 90°"
                    className="hover:text-slate-800"
                  >
                    <RotateCcw size={14} />
                  </button>
                  <button
                    onClick={() => rotatePage(pdfId, origPage, (rot + 90) % 360)}
                    title="右转 90°"
                    className="hover:text-slate-800"
                  >
                    <RotateCw size={14} />
                  </button>
                  <button
                    onClick={() => {
                      if (window.confirm(`删除第 ${origPage} 页？`)) deletePage(pdfId, origPage);
                    }}
                    title="删除"
                    className="hover:text-red-600"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={() => movePage(pdfId, idx, idx - 1)}
                    disabled={idx === 0}
                    title="上移"
                    className="hover:text-slate-800 disabled:opacity-30"
                  >
                    <ArrowUp size={14} />
                  </button>
                  <button
                    onClick={() => movePage(pdfId, idx, idx + 1)}
                    disabled={idx === pageOrder.length - 1}
                    title="下移"
                    className="hover:text-slate-800 disabled:opacity-30"
                  >
                    <ArrowDown size={14} />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
        {!pageOrder.length && (
          <div className="text-xs text-slate-400 text-center mt-4">无页面</div>
        )}
      </div>
    </div>
  );
}
