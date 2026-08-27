// PDF 标签栏：每个标签对应一篇打开的 PDF，可切换 / 关闭 / 新增。

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { FileText, Plus, X, Loader2 } from 'lucide-react';
import { useStore } from '@/store/useSettings';
import IconButton from './ui/IconButton';

const MAX_TABS = 8;

export default function TabBar({ onOpen }: { onOpen: () => void }) {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const closeTab = useStore((s) => s.closeTab);
  const atCap = tabs.length >= MAX_TABS;
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const [indicator, setIndicator] = useState({ x: 0, width: 0, visible: false });

  const syncIndicator = useCallback(() => {
    const active = activeTabId ? tabRefs.current.get(activeTabId) : null;
    if (!active) {
      setIndicator((current) => ({ ...current, visible: false }));
      return;
    }
    setIndicator({
      x: active.parentElement?.offsetLeft ?? active.offsetLeft,
      width: active.parentElement?.offsetWidth ?? active.offsetWidth,
      visible: true,
    });
  }, [activeTabId]);

  useLayoutEffect(() => {
    syncIndicator();
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(syncIndicator);
    tabRefs.current.forEach((element) => observer?.observe(element));
    window.addEventListener('resize', syncIndicator);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', syncIndicator);
    };
  }, [syncIndicator, tabs]);

  const moveFocus = (id: string, direction: -1 | 1) => {
    const index = tabs.findIndex((tab) => tab.id === id);
    const next = tabs[(index + direction + tabs.length) % tabs.length];
    if (!next) return;
    setActiveTab(next.id);
    tabRefs.current.get(next.id)?.focus();
  };

  return (
    <div
      className="document-tabbar relative flex h-11 shrink-0 items-stretch gap-1 overflow-x-auto px-3 pb-1.5"
      role="tablist"
      aria-label="已打开的 PDF"
      style={
        {
          '--tab-x': `${indicator.x}px`,
          '--tab-width': `${indicator.width}px`,
          '--tab-visible': indicator.visible ? 1 : 0,
        } as React.CSSProperties
      }
    >
      <span className="document-tab-indicator" aria-hidden="true" />
      {tabs.map((t) => (
        <div
          key={t.id}
          title={t.name}
          className="group relative z-[1] my-1 flex min-w-0 items-center whitespace-nowrap rounded-control"
        >
          <button
            ref={(element) => {
              if (element) tabRefs.current.set(t.id, element);
              else tabRefs.current.delete(t.id);
            }}
            type="button"
            role="tab"
            aria-selected={t.id === activeTabId}
            tabIndex={t.id === activeTabId ? 0 : -1}
            onClick={() => setActiveTab(t.id)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft') {
                event.preventDefault();
                moveFocus(t.id, -1);
              } else if (event.key === 'ArrowRight') {
                event.preventDefault();
                moveFocus(t.id, 1);
              }
            }}
            className={clsx(
              'flex min-w-0 items-center gap-1.5 py-1 pl-3 text-sm',
              t.id === activeTabId ? 'font-medium text-primary-700' : 'text-slate-500',
            )}
          >
            <FileText size={14} className="shrink-0" />
            <span className="max-w-[150px] truncate">{t.name}</span>
            {t.translationRunning && (
              <Loader2 size={12} className="animate-spin shrink-0 text-primary-500" />
            )}
          </button>
          <IconButton
            size="sm"
            label={`关闭 ${t.name}`}
            onClick={() => closeTab(t.id)}
            className="mr-1 text-slate-400"
            icon={<X size={13} />}
          />
        </div>
      ))}

      <IconButton
        onClick={onOpen}
        disabled={atCap}
        label={atCap ? `最多 ${MAX_TABS} 个标签页` : '打开 PDF'}
        className="relative z-[1] my-1 ml-1"
        icon={<Plus size={16} />}
      />
    </div>
  );
}
