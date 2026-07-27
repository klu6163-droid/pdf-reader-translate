// 右栏底部可折叠抽屉：最近翻译历史 / 收藏笔记。
// 数据来自 store（持久化）。折叠时仅占一行状态条，展开后最高 ~18rem 内部滚动。
// 历史条目可「回填」到当前标签的划词翻译；笔记条目可删除。

import { useEffect, useState } from "react";
import clsx from "clsx";
import {
  History, Star, ChevronDown, ChevronUp, Trash2, CornerUpLeft, Copy, Inbox,
} from "lucide-react";
import { useStore, useActiveTab } from "@/store/useSettings";
import type { HistoryItem, NoteItem } from "@/types";

export default function HistoryNotes() {
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState<"history" | "notes">("history");

  const history = useStore((s) => s.history);
  const notes = useStore((s) => s.notes);
  const clearHistory = useStore((s) => s.clearHistory);
  const clearNotes = useStore((s) => s.clearNotes);
  const notesFlash = useStore((s) => s.notesFlash);

  // 划词翻译「添加到笔记」时展开并切到笔记栏
  useEffect(() => {
    if (notesFlash > 0) {
      setOpen(true);
      setSub("notes");
    }
  }, [notesFlash]);

  return (
    <div className="shrink-0 border-t bg-slate-50">
      {/* 折叠条 */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-4 h-9 text-xs text-slate-500 hover:bg-slate-100"
      >
        <span className="flex items-center gap-1">
          <History size={13} /> 历史 {history.length}
        </span>
        <span className="flex items-center gap-1">
          <Star size={13} /> 笔记 {notes.length}
        </span>
        <span className="ml-auto flex items-center gap-1">
          {open ? "收起" : "展开"}
          {open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </span>
      </button>

      {open && (
        <div className="flex flex-col max-h-72">
          {/* 子标签 */}
          <div className="flex items-center px-3 gap-1 border-b bg-white">
            <SubTab
              active={sub === "history"}
              onClick={() => setSub("history")}
              icon={<History size={13} />}
              label="最近翻译"
              count={history.length}
            />
            <SubTab
              active={sub === "notes"}
              onClick={() => setSub("notes")}
              icon={<Star size={13} />}
              label="收藏笔记"
              count={notes.length}
            />
            {sub === "history" && history.length > 0 && (
              <button
                onClick={clearHistory}
                className="ml-auto flex items-center gap-1 px-2 py-1 text-xs text-slate-400 hover:text-red-500"
              >
                <Trash2 size={12} /> 清空
              </button>
            )}
            {sub === "notes" && notes.length > 0 && (
              <button
                onClick={clearNotes}
                className="ml-auto flex items-center gap-1 px-2 py-1 text-xs text-slate-400 hover:text-red-500"
              >
                <Trash2 size={12} /> 清空
              </button>
            )}
          </div>

          {/* 列表 */}
          <div className="flex-1 overflow-auto p-2 space-y-1.5">
            {sub === "history" ? (
              history.length === 0 ? (
                <Empty text="还没有翻译历史" />
              ) : (
                history.map((h) => (
                  <HistoryRow key={h.id} item={h} />
                ))
              )
            ) : notes.length === 0 ? (
              <Empty text="还没有收藏的笔记" />
            ) : (
              notes.map((n) => <NoteRow key={n.id} item={n} />)
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SubTab({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count: number;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        "flex items-center gap-1 px-2.5 py-2 text-xs border-b-2 transition-colors",
        active
          ? "border-primary-600 text-primary-600 font-medium"
          : "border-transparent text-slate-500 hover:text-slate-700"
      )}
    >
      {icon}
      {label}
      <span className="text-slate-400">({count})</span>
    </button>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-6 text-slate-400 gap-1.5">
      <Inbox size={26} strokeWidth={1.2} />
      <p className="text-xs">{text}</p>
    </div>
  );
}

function HistoryRow({ item }: { item: HistoryItem }) {
  const activeTab = useActiveTab();
  const updateTab = useStore((s) => s.updateTab);

  const restore = () => {
    if (!activeTab) return;
    updateTab(activeTab.id, {
      lastSelection: { text: item.original, page: item.page },
      lastTranslated: item.translated,
      lastTranslateError: "",
    });
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(item.translated);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="p-2 bg-white rounded border border-slate-200 text-xs">
      <div className="flex items-center gap-2 text-slate-400 mb-1">
        <span className="truncate">{item.tabName}</span>
        <span>· 第 {item.page} 页</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={restore}
            disabled={!activeTab}
            title="回填到划词翻译"
            className="p-1 rounded text-slate-400 hover:text-primary-600 hover:bg-primary-50 disabled:opacity-40"
          >
            <CornerUpLeft size={12} />
          </button>
          <button
            onClick={copy}
            title="复制译文"
            className="p-1 rounded text-slate-400 hover:text-slate-600 hover:bg-slate-100"
          >
            <Copy size={12} />
          </button>
        </div>
      </div>
      <p className="text-slate-500 line-clamp-1">{item.original}</p>
      <p className="text-slate-800 line-clamp-2 mt-0.5">{item.translated}</p>
    </div>
  );
}

function NoteRow({ item }: { item: NoteItem }) {
  const removeNote = useStore((s) => s.removeNote);
  return (
    <div className="p-2 bg-white rounded border border-slate-200 text-xs">
      <div className="flex items-center gap-2 text-slate-400 mb-1">
        <Star size={11} className="text-amber-400" />
        <span className="truncate">{item.tabName}</span>
        <span>· 第 {item.page} 页</span>
        <button
          onClick={() => removeNote(item.id)}
          title="删除笔记"
          className="ml-auto p-1 rounded text-slate-400 hover:text-red-500 hover:bg-red-50"
        >
          <Trash2 size={12} />
        </button>
      </div>
      <p className="text-slate-500 line-clamp-1">{item.original}</p>
      <p className="text-slate-800 line-clamp-2 mt-0.5">{item.translated}</p>
      {item.note && (
        <p className="mt-1 pl-2 border-l-2 border-amber-300 text-amber-700 line-clamp-2">
          {item.note}
        </p>
      )}
    </div>
  );
}
