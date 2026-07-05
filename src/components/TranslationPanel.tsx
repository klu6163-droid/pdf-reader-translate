// 右侧功能面板：三个标签页 —— 划词翻译 / 全文翻译 / 文献总结。

import { useState } from "react";
import clsx from "clsx";
import { Languages, FileText, ScrollText, Copy } from "lucide-react";
import type { PanelTab } from "@/types";
import TextTranslate from "./TextTranslate";
import FullTranslate from "./FullTranslate";
import Summary from "./Summary";
import OverlayTranslate from "./OverlayTranslate";

const TABS: { key: PanelTab; label: string; icon: JSX.Element }[] = [
  { key: "text", label: "划词翻译", icon: <Languages size={16} /> },
  { key: "full", label: "全文翻译", icon: <FileText size={16} /> },
  { key: "summary", label: "文献总结", icon: <ScrollText size={16} /> },
  { key: "overlay", label: "覆盖翻译", icon: <Copy size={16} /> },
];

export default function TranslationPanel() {
  const [tab, setTab] = useState<PanelTab>("text");

  return (
    <div className="flex flex-col h-full">
      {/* 标签切换 */}
      <div className="flex border-b shrink-0">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={clsx(
              "flex items-center gap-1.5 px-4 py-2.5 text-sm border-b-2 transition-colors",
              tab === t.key
                ? "border-primary-600 text-primary-600 font-medium"
                : "border-transparent text-slate-500 hover:text-slate-700"
            )}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* 内容区（用隐藏而非卸载，保留各自状态） */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <div className={clsx("h-full", tab !== "text" && "hidden")}>
          <TextTranslate />
        </div>
        <div className={clsx("h-full", tab !== "full" && "hidden")}>
          <FullTranslate />
        </div>
        <div className={clsx("h-full", tab !== "summary" && "hidden")}>
          <Summary />
        </div>
        <div className={clsx("h-full", tab !== "overlay" && "hidden")}>
          <OverlayTranslate />
        </div>
      </div>
    </div>
  );
}
