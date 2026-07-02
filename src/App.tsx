import { useCallback, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { FileText, Settings as SettingsIcon, AlertTriangle } from "lucide-react";
import { useStore } from "@/store/useSettings";
import { checkBackend } from "@/services/api";
import PDFViewer from "@/components/PDFViewer";
import TranslationPanel from "@/components/TranslationPanel";
import Settings from "@/components/Settings";

export default function App() {
  const {
    pdfData,
    pdfName,
    setPdf,
    setSettingsOpen,
    backendStatus,
    setBackendStatus,
  } = useStore();

  // 启动后轮询后端健康状态（后端由 Tauri 拉起，可能晚几秒才就绪）
  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      const ok = await checkBackend();
      if (stopped) return;
      setBackendStatus(ok ? "online" : "offline");
    };
    poll();
    const timer = setInterval(poll, 5000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [setBackendStatus]);

  // 打开本地 PDF：优先用 Tauri 原生对话框；浏览器环境降级为 <input>
  const openPdf = useCallback(async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (typeof selected === "string") {
        const bytes = await readFile(selected);
        const name = selected.split(/[\\/]/).pop() || "document.pdf";
        setPdf(bytes, name);
      }
    } catch {
      // 非 Tauri 环境（纯浏览器 dev）降级
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "application/pdf";
      input.onchange = async () => {
        const file = input.files?.[0];
        if (file) {
          const buf = new Uint8Array(await file.arrayBuffer());
          setPdf(buf, file.name);
        }
      };
      input.click();
    }
  }, [setPdf]);

  return (
    <div className="flex flex-col h-full bg-slate-100">
      {/* 顶部工具栏 */}
      <header className="flex items-center justify-between px-4 h-12 bg-white border-b shrink-0">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-slate-800">PDF 阅读翻译</span>
          <button
            onClick={openPdf}
            className="flex items-center gap-1 px-3 py-1.5 text-sm bg-primary-600 text-white rounded hover:bg-primary-700"
          >
            <FileText size={16} />
            打开 PDF
          </button>
          {pdfName && (
            <span className="text-sm text-slate-500 truncate max-w-xs">
              {pdfName}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <BackendIndicator status={backendStatus} />
          <button
            onClick={() => setSettingsOpen(true)}
            className="flex items-center gap-1 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 rounded"
          >
            <SettingsIcon size={16} />
            设置
          </button>
        </div>
      </header>

      {/* 后端离线提示条 */}
      {backendStatus === "offline" && (
        <div className="flex items-center gap-2 px-4 py-2 text-sm bg-amber-50 text-amber-700 border-b border-amber-200 shrink-0">
          <AlertTriangle size={16} className="shrink-0" />
          <span>
            未连接到本地后端服务。请在终端启动：
            <code className="mx-1 px-1.5 py-0.5 bg-amber-100 rounded text-xs">
              cd backend &amp;&amp; python start.py
            </code>
            翻译与总结功能暂不可用。
          </span>
        </div>
      )}

      {/* 主体：左右分栏 */}
      <div className="flex flex-1 min-h-0">
        {/* 左侧原始 PDF */}
        <div className="w-1/2 border-r bg-slate-200 min-w-0">
          {pdfData ? (
            <PDFViewer data={pdfData} side="left" />
          ) : (
            <EmptyHint onOpen={openPdf} />
          )}
        </div>

        {/* 右侧功能面板 */}
        <div className="w-1/2 bg-white min-w-0">
          <TranslationPanel />
        </div>
      </div>

      <Settings />
    </div>
  );
}

function BackendIndicator({
  status,
}: {
  status: "unknown" | "online" | "offline";
}) {
  const map = {
    unknown: { color: "bg-slate-300", label: "后端检测中" },
    online: { color: "bg-green-500", label: "后端已连接" },
    offline: { color: "bg-red-500", label: "后端未连接" },
  } as const;
  const { color, label } = map[status];
  return (
    <div
      className="flex items-center gap-1.5 text-xs text-slate-500"
      title={label}
    >
      <span className={`w-2 h-2 rounded-full ${color}`} />
      {label}
    </div>
  );
}

function EmptyHint({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-slate-400 gap-3">
      <FileText size={48} strokeWidth={1} />
      <p>尚未打开 PDF</p>
      <button
        onClick={onOpen}
        className="px-4 py-2 text-sm bg-primary-600 text-white rounded hover:bg-primary-700"
      >
        选择本地 PDF 文件
      </button>
    </div>
  );
}
