// 右侧功能面板：四个标签页 -- 划词翻译 / 全文翻译 / 文献总结 / 生成译文 PDF。
// 无打开 PDF 时内容区显示统一空态；底部挂「历史 / 笔记」可折叠抽屉。

import { useState } from 'react';
import { Languages, FileText, ScrollText, FileOutput, FileSearch } from 'lucide-react';
import type { PanelTab } from '@/types';
import { useStore } from '@/store/useSettings';
import TextTranslate from './TextTranslate';
import FullTranslate from './FullTranslate';
import Summary from './Summary';
import OverlayTranslate from './OverlayTranslate';
import HistoryNotes from './HistoryNotes';

const TABS: { key: PanelTab; label: string; icon: JSX.Element }[] = [
  { key: 'text', label: '划词翻译', icon: <Languages size={16} /> },
  { key: 'full', label: '全文翻译', icon: <FileText size={16} /> },
  { key: 'summary', label: '文献总结', icon: <ScrollText size={16} /> },
  { key: 'overlay', label: '生成译文 PDF', icon: <FileOutput size={16} /> },
];

export default function TranslationPanel() {
  const [tab, setTab] = useState<PanelTab>('text');
  const activeTabId = useStore((s) => s.activeTabId);
  const hasTab = activeTabId !== null;
  const tabIndex = TABS.findIndex((item) => item.key === tab);

  return (
    <div className="translation-panel relative flex h-full flex-col overflow-hidden">
      {/* 标签切换 */}
      <div
        className="panel-switcher shrink-0"
        role="tablist"
        aria-label="PDF 功能"
        style={{ '--tab-index': tabIndex } as React.CSSProperties}
      >
        <span className="panel-tab-indicator" aria-hidden="true" />
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            role="tab"
            aria-selected={tab === t.key}
            aria-controls={`panel-${t.key}`}
            title={t.label}
            className="panel-tab"
          >
            {t.icon}
            <span className="panel-tab-label truncate">{t.label}</span>
          </button>
        ))}
      </div>

      {/* 内容区：无 PDF 时统一空态；用隐藏而非卸载，保留各自状态 */}
      <div className="panel-deck flex-1 min-h-0 overflow-hidden">
        {!hasTab ? (
          <NoPdfHint />
        ) : (
          <>
            <div
              id="panel-text"
              role="tabpanel"
              aria-hidden={tab !== 'text'}
              data-active={tab === 'text'}
              className="panel-page"
            >
              <TextTranslate />
            </div>
            <div
              id="panel-full"
              role="tabpanel"
              aria-hidden={tab !== 'full'}
              data-active={tab === 'full'}
              className="panel-page"
            >
              <FullTranslate />
            </div>
            <div
              id="panel-summary"
              role="tabpanel"
              aria-hidden={tab !== 'summary'}
              data-active={tab === 'summary'}
              className="panel-page"
            >
              <Summary />
            </div>
            <div
              id="panel-overlay"
              role="tabpanel"
              aria-hidden={tab !== 'overlay'}
              data-active={tab === 'overlay'}
              className="panel-page"
            >
              <OverlayTranslate />
            </div>
          </>
        )}
      </div>

      {/* 底部：历史 / 笔记 抽屉 */}
      <HistoryNotes />
    </div>
  );
}

function NoPdfHint() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-[var(--text-tertiary)]">
      <div className="soft-icon-orb flex h-16 w-16 items-center justify-center text-primary-400">
        <FileSearch size={28} strokeWidth={1.45} />
      </div>
      <p className="text-sm font-semibold text-[var(--text-secondary)]">先打开一篇 PDF</p>
      <p className="max-w-xs text-center text-xs leading-5 text-[var(--text-tertiary)]">
        在左侧打开 PDF 后，即可使用划词翻译、全文翻译、文献总结与生成译文 PDF。
      </p>
    </div>
  );
}
