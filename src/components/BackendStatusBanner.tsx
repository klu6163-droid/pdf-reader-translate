// 后端状态提示条：
// - starting：首启加载窗口（PyMuPDF/pdf2zh 等重依赖），蓝色「启动中」条
// - reconnecting：后端崩溃后 Tauri 正在自动重启（或用户点了「重启后端」），蓝色「重启中」条
// - online：绿色条「后端服务运行正常…」
// - offline：黄色卡片，说明 AI 功能暂不可用，提供「重启后端 / 重新检测 / 查看说明」；
//   自动重拉耗尽时额外显示退出码与日志文件路径，方便用户反馈问题时提供
// - unknown：灰色「检测中…」（兜底，正常不会出现）

import { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Loader2,
  RotateCw,
  HelpCircle,
  RefreshCw,
} from 'lucide-react';

/** 自动重拉进度；attempt=0 表示用户手动触发的重启 */
export interface RestartProgress {
  attempt: number;
  max: number;
}

/** 自动重拉耗尽 / 手动重启失败时的详情 */
export interface BackendFailureInfo {
  /** 手动重启 invoke 失败的可读原因（如外部进程占用端口） */
  message?: string;
  /** 最后一次崩溃的进程退出码 */
  code?: number | null;
  /** 后端运行日志（崩溃详情主要看这里） */
  logPath?: string;
  /** Rust 侧重启轨迹日志 */
  restartLog?: string;
}

interface Props {
  status: 'unknown' | 'starting' | 'online' | 'offline' | 'reconnecting';
  onRecheck: () => void;
  onShowHelp: () => void;
  onRestart: () => void;
  onExportDiagnostics: () => void;
  diagnosticExporting?: boolean;
  restartAttempt?: RestartProgress | null;
  failure?: BackendFailureInfo | null;
}

export default function BackendStatusBanner({
  status,
  onRecheck,
  onShowHelp,
  onRestart,
  onExportDiagnostics,
  diagnosticExporting,
  restartAttempt,
  failure,
}: Props) {
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

  if (status === 'reconnecting') {
    const detail =
      restartAttempt && restartAttempt.attempt > 0
        ? `正在自动重启（第 ${restartAttempt.attempt}/${restartAttempt.max} 次）`
        : '正在重启';
    return (
      <div className="flex items-center gap-2 px-4 py-2 text-sm bg-sky-50 text-sky-700 border-b border-sky-200 shrink-0">
        <Loader2 size={16} className="shrink-0 animate-spin" />
        <span>后端服务意外退出，{detail}中，AI 功能恢复前暂不可用…</span>
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

  return (
    <OfflineCard
      onRecheck={onRecheck}
      onShowHelp={onShowHelp}
      onRestart={onRestart}
      onExportDiagnostics={onExportDiagnostics}
      diagnosticExporting={diagnosticExporting}
      failure={failure}
    />
  );
}

function OfflineCard({
  onRecheck,
  onShowHelp,
  onRestart,
  onExportDiagnostics,
  diagnosticExporting,
  failure,
}: {
  onRecheck: () => void;
  onShowHelp: () => void;
  onRestart: () => void;
  onExportDiagnostics: () => void;
  diagnosticExporting?: boolean;
  failure?: BackendFailureInfo | null;
}) {
  // 崩溃后自动重拉耗尽：给出退出码与日志路径，方便用户反馈时提供
  const crashDetail =
    failure?.message ??
    (failure?.code != null ? `后端进程异常退出（退出码 ${failure.code}），自动重启未能恢复。` : '');

  return (
    <div className="flex items-start gap-3 px-4 py-3 text-sm bg-amber-50 text-amber-800 border-b border-amber-200 shrink-0">
      <AlertTriangle size={18} className="shrink-0 mt-0.5 text-amber-500" />
      <div className="flex-1 min-w-0">
        <p className="font-medium">后端服务未连接</p>
        <p className="text-amber-700 mt-0.5">
          {crashDetail ||
            'AI 翻译、全文翻译和文献总结暂不可用。请稍候几秒后点击「重新检测」；若仍未恢复，可能是被杀毒软件拦截或端口 8765 被占用。'}
        </p>
        {failure?.logPath && (
          <p className="text-amber-700 mt-1 text-xs break-all">
            反馈问题时请附上后端日志：{failure.logPath}
            <CopyButton text={failure.logPath} />
          </p>
        )}
        {failure?.restartLog && (
          <p className="text-amber-700 mt-1 text-xs break-all">
            重启轨迹日志：{failure.restartLog}
            <CopyButton text={failure.restartLog} />
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2 mt-2">
          <button
            onClick={onRestart}
            className="flex items-center gap-1 px-2.5 py-1 text-xs bg-amber-500 border border-amber-500 rounded hover:bg-amber-600 text-white"
            title="强制结束旧的后端进程并重新启动"
          >
            <RefreshCw size={13} />
            重启后端
          </button>
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
          <button
            onClick={onExportDiagnostics}
            disabled={diagnosticExporting}
            className="flex items-center gap-1 px-2.5 py-1 text-xs bg-white border border-amber-300 rounded hover:bg-amber-50 text-amber-700 disabled:opacity-50"
          >
            {diagnosticExporting ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Download size={13} />
            )}
            {diagnosticExporting ? '正在导出' : '导出诊断'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 复制日志路径；WebView2 下 clipboard API 不可用时降级为临时文本框 */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } catch {
        /* 复制失败：路径仍可选中手动复制 */
      }
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button
      onClick={copy}
      className="ml-1 px-1.5 py-0.5 text-xs bg-white border border-amber-300 rounded hover:bg-amber-50 text-amber-700 align-middle"
    >
      {copied ? '已复制' : '复制路径'}
    </button>
  );
}
