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
  const base = 'flex items-center gap-1 rounded text-xs';
  const padding = variant === 'annotator' ? 'px-1.5 py-1' : 'px-2 py-1';
  const activeCls =
    variant === 'annotator' ? 'bg-primary-600 text-white' : 'bg-primary-50 text-primary-600';
  const inactiveCls = 'text-slate-600 hover:bg-slate-100';

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
      className={`${base} ${padding} ${
        active ? activeCls : inactiveCls
      } disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent`}
    >
      {icon}
      {label}
    </button>
  );
}
