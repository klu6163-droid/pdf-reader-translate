// PDF 标签栏：每个标签对应一篇打开的 PDF，可切换 / 关闭 / 新增。

import clsx from "clsx";
import { FileText, Plus, X, Loader2 } from "lucide-react";
import { useStore } from "@/store/useSettings";

const MAX_TABS = 8;

export default function TabBar({ onOpen }: { onOpen: () => void }) {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const closeTab = useStore((s) => s.closeTab);
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
              closeTab(t.id);
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
