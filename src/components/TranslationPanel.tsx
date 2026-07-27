// 右侧功能面板：四个标签页 -- 划词翻译 / 全文翻译 / 文献总结 / 生成译文 PDF。
// 无打开 PDF 时内容区显示统一空态；底部挂「历史 / 笔记」可折叠抽屉。

import { useState } from 'react';
import clsx from 'clsx';
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

  return (
    <div className="flex flex-col h-full">
      {/* 标签切换 */}
      <div className="flex border-b shrink-0">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={clsx(
              'flex items-center gap-1.5 px-4 py-2.5 text-sm border-b-2 transition-colors',
              tab === t.key
                ? 'border-primary-600 text-primary-600 font-medium'
                : 'border-transparent text-slate-500 hover:text-slate-700',
            )}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* 内容区：无 PDF 时统一空态；用隐藏而非卸载，保留各自状态 */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {!hasTab ? (
          <NoPdfHint />
        ) : (
          <>
            <div className={clsx('h-full', tab !== 'text' && 'hidden')}>
              <TextTranslate />
            </div>
            <div className={clsx('h-full', tab !== 'full' && 'hidden')}>
              <FullTranslate />
            </div>
            <div className={clsx('h-full', tab !== 'summary' && 'hidden')}>
              <Summary />
            </div>
            <div className={clsx('h-full', tab !== 'overlay' && 'hidden')}>
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
    <div className="flex flex-col items-center justify-center h-full text-slate-400 gap-3 p-6">
      <div className="w-14 h-14 rounded-full bg-slate-100 flex items-center justify-center">
        <FileSearch size={28} strokeWidth={1.4} />
      </div>
      <p className="text-sm text-slate-500 font-medium">先打开一篇 PDF</p>
      <p className="text-xs text-slate-400 text-center max-w-xs">
        在左侧打开 PDF 后，即可使用划词翻译、全文翻译、文献总结与生成译文 PDF。
      </p>
    </div>
  );
}
