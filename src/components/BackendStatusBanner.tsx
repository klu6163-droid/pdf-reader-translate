// 后端状态提示条：
// - starting：首启加载窗口（PyMuPDF/pdf2zh 等重依赖），蓝色「启动中」条
// - online：绿色条「后端服务运行正常…」
// - offline：黄色卡片，说明 AI 功能暂不可用，提供「重新检测 / 查看说明」
// - unknown：灰色「检测中…」（兜底，正常不会出现）

import { AlertTriangle, CheckCircle2, Loader2, RotateCw, HelpCircle } from 'lucide-react';

interface Props {
  status: 'unknown' | 'starting' | 'online' | 'offline';
  onRecheck: () => void;
  onShowHelp: () => void;
}

export default function BackendStatusBanner({ status, onRecheck, onShowHelp }: Props) {
  if (status === 'online') {
    return (
      <div className="flex items-center gap-2 px-4 py-2 text-sm bg-green-50 text-green-700 border-b border-green-200 shrink-0">
        <CheckCircle2 size={16} className="shrink-0" />
        <span>后端服务运行正常，AI 翻译和总结功能已就绪。</span>
      </div>
    );
  }

  if (status === 'starting') {
    return (
      <div className="flex items-center gap-2 px-4 py-2 text-sm bg-sky-50 text-sky-700 border-b border-sky-200 shrink-0">
        <Loader2 size={16} className="shrink-0 animate-spin" />
        <span>后端服务启动中，正在加载翻译引擎，请稍候…</span>
      </div>
    );
  }

  if (status === 'unknown') {
    return (
      <div className="flex items-center gap-2 px-4 py-2 text-sm bg-slate-50 text-slate-500 border-b border-slate-200 shrink-0">
        <Loader2 size={16} className="shrink-0 animate-spin" />
        <span>正在检测本地后端服务…</span>
      </div>
    );
  }

  return <OfflineCard onRecheck={onRecheck} onShowHelp={onShowHelp} />;
}

function OfflineCard({ onRecheck, onShowHelp }: { onRecheck: () => void; onShowHelp: () => void }) {
  return (
    <div className="flex items-start gap-3 px-4 py-3 text-sm bg-amber-50 text-amber-800 border-b border-amber-200 shrink-0">
      <AlertTriangle size={18} className="shrink-0 mt-0.5 text-amber-500" />
      <div className="flex-1 min-w-0">
        <p className="font-medium">后端服务未连接</p>
        <p className="text-amber-700 mt-0.5">
          AI
          翻译、全文翻译和文献总结暂不可用。请稍候几秒后点击「重新检测」；若仍未恢复，可能是被杀毒软件拦截或端口
          8765 被占用。
        </p>
        <div className="flex flex-wrap items-center gap-2 mt-2">
          <button
            onClick={onRecheck}
            className="flex items-center gap-1 px-2.5 py-1 text-xs bg-white border border-amber-300 rounded hover:bg-amber-50 text-amber-700"
          >
            <RotateCw size={13} />
            重新检测
          </button>
          <button
            onClick={onShowHelp}
            className="flex items-center gap-1 px-2.5 py-1 text-xs bg-white border border-amber-300 rounded hover:bg-amber-50 text-amber-700"
          >
            <HelpCircle size={13} />
            查看说明
          </button>
        </div>
      </div>
    </div>
  );
}
