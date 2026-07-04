// PDF 标签栏：每个标签对应一篇打开的 PDF，可切换 / 关闭 / 新增。

import clsx from "clsx";
import { FileText, Plus, X, Loader2 } from "lucide-react";
import { useStore } from "@/store/useSettings";
import { useAnnotations } from "@/store/useAnnotations";
import { savePdfWithAnnotations } from "@/services/annotate";
import type { PdfTab } from "@/types";

const MAX_TABS = 8;

export default function TabBar({ onOpen }: { onOpen: () => void }) {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const closeTab = useStore((s) => s.closeTab);
  const isDirty = useAnnotations((s) => s.isDirty);
  const discard = useAnnotations((s) => s.discard);

  // 关闭前：若有未保存标注，询问是否保留为副本
  const handleClose = async (t: PdfTab) => {
    const srcDirty = isDirty(t.id);
    const transDirty = !!t.translatedPdfUrl && isDirty(`trans-${t.id}`);
    if (srcDirty || transDirty) {
      const keep = window.confirm(
        "该 PDF 有未保存的标注，是否保留为副本？\n（点「取消」则丢弃标注并关闭）"
      );
      if (keep) {
        try {
          if (srcDirty) {
            await savePdfWithAnnotations(t.id, t.pdfData, t.name);
          }
          if (transDirty) {
            const resp = await fetch(t.translatedPdfUrl!);
            const buf = new Uint8Array(await resp.arrayBuffer());
            await savePdfWithAnnotations(
              `trans-${t.id}`,
              buf,
              t.name.replace(/\.pdf$/i, "") + "-zh.pdf"
            );
          }
        } catch (e) {
          console.error("保存失败:", e);
        }
      } else {
        discard(t.id);
        discard(`trans-${t.id}`);
      }
    }
    closeTab(t.id);
  };
  const atCap = tabs.length >= MAX_TABS;

  return (
    <div className="flex items-stretch bg-slate-50 border-b h-9 px-2 gap-1 shrink-0 overflow-x-auto">
      {tabs.map((t) => (
        <div
          key={t.id}
          onClick={() => setActiveTab(t.id)}
          title={t.name}
          className={clsx(
            "group flex items-center gap-1.5 pl-3 pr-2 my-1 rounded text-sm cursor-pointer whitespace-nowrap border-t-2 transition-colors",
            t.id === activeTabId
              ? "bg-white text-primary-600 border-primary-600 shadow-sm"
              : "text-slate-500 hover:bg-slate-200/60 border-transparent"
          )}
        >
          <FileText size={13} className="shrink-0" />
          <span className="max-w-[150px] truncate">{t.name}</span>
          {t.translationRunning && (
            <Loader2 size={11} className="animate-spin text-primary-500 shrink-0" />
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              void handleClose(t);
            }}
            className="ml-0.5 p-0.5 rounded text-slate-400 hover:bg-slate-300/60 hover:text-slate-600"
            title="关闭"
          >
            <X size={13} />
          </button>
        </div>
      ))}

      <button
        onClick={onOpen}
        disabled={atCap}
        title={atCap ? `最多 ${MAX_TABS} 个标签页` : "打开 PDF"}
        className="flex items-center justify-center w-7 h-7 my-1 ml-1 rounded text-slate-500 hover:bg-slate-200 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Plus size={16} />
      </button>
    </div>
  );
}
