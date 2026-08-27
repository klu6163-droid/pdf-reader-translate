// 通用工具栏按钮：PDFViewer 与 PdfAnnotator 共用。
// 合并两处略有差异的实现，通过 variant 区分样式。

import type { ReactNode } from 'react';

interface ToolBtnProps {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  /** "viewer" = PDFViewer 底部工具栏风格；"annotator" = 批注器侧栏风格 */
  variant?: 'viewer' | 'annotator';
}

export default function ToolBtn({
  icon,
  label,
  onClick,
  active = false,
  disabled = false,
  title,
  variant = 'viewer',
}: ToolBtnProps) {
  const base =
    'flex min-h-7 items-center gap-1 rounded-control border border-transparent text-xs text-slate-600';
  const padding = variant === 'annotator' ? 'px-1.5 py-1' : 'px-2 py-1';
  const activeCls = 'border-primary-200 bg-white/85 text-primary-700 shadow-sm';
  const inactiveCls = 'hover:border-slate-200 hover:bg-white/70';

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
      aria-pressed={active}
      className={`${base} ${padding} ${
        active ? activeCls : inactiveCls
      } disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent`}
    >
      {icon}
      <span className={variant === 'annotator' ? 'compact-label' : 'viewer-tool-label'}>
        {label}
      </span>
    </button>
  );
}
