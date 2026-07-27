// 后端状态提示条：
// - offline：友好卡片，说明 AI 功能暂不可用，提供「复制启动命令 / 重新检测 / 查看说明」
// - online：绿色条「后端服务运行正常…」
// - unknown：灰色「检测中…」
// 取代原先只甩一行启动命令的 amber 条。

import { useEffect, useState } from "react";
import {
  AlertTriangle, CheckCircle2, Loader2, Copy, RotateCw, HelpCircle,
} from "lucide-react";

interface Props {
  status: "unknown" | "online" | "offline";
  onRecheck: () => void;
  onShowHelp: () => void;
}

const START_CMD = "cd backend && python start.py";

export default function BackendStatusBanner({ status, onRecheck, onShowHelp }: Props) {
  if (status === "online") {
    return (
      <div className="flex items-center gap-2 px-4 py-2 text-sm bg-green-50 text-green-700 border-b border-green-200 shrink-0">
        <CheckCircle2 size={16} className="shrink-0" />
        <span>后端服务运行正常，AI 翻译和总结功能已就绪。</span>
      </div>
    );
  }

  if (status === "unknown") {
    return (
      <div className="flex items-center gap-2 px-4 py-2 text-sm bg-slate-50 text-slate-500 border-b border-slate-200 shrink-0">
        <Loader2 size={16} className="shrink-0 animate-spin" />
        <span>正在检测本地后端服务…</span>
      </div>
    );
  }

  return (
    <OfflineCard onRecheck={onRecheck} onShowHelp={onShowHelp} />
  );
}

function OfflineCard({
  onRecheck,
  onShowHelp,
}: {
  onRecheck: () => void;
  onShowHelp: () => void;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);

  const copyCmd = async () => {
    try {
      await navigator.clipboard.writeText(START_CMD);
    } catch {
      // 降级：临时 textarea + execCommand
      const ta = document.createElement("textarea");
      ta.value = START_CMD;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* ignore */
      }
      document.body.removeChild(ta);
    }
    setCopied(true);
  };

  return (
    <div className="flex items-start gap-3 px-4 py-3 text-sm bg-amber-50 text-amber-800 border-b border-amber-200 shrink-0">
      <AlertTriangle size={18} className="shrink-0 mt-0.5 text-amber-500" />
      <div className="flex-1 min-w-0">
        <p className="font-medium">后端服务未连接</p>
        <p className="text-amber-700 mt-0.5">
          AI 翻译、全文翻译和文献总结暂不可用。请在终端启动本地后端：
        </p>
        <code className="inline-block mt-1.5 px-2 py-1 bg-amber-100 rounded text-xs text-amber-900 break-all">
          {START_CMD}
        </code>
        <div className="flex flex-wrap items-center gap-2 mt-2">
          <button
            onClick={copyCmd}
            className="flex items-center gap-1 px-2.5 py-1 text-xs bg-white border border-amber-300 rounded hover:bg-amber-50 text-amber-700"
          >
            <Copy size={13} />
            {copied ? "已复制" : "复制启动命令"}
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
        </div>
      </div>
    </div>
  );
}
