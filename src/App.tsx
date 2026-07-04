import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { FileText, Settings as SettingsIcon, AlertTriangle, Upload } from "lucide-react";
import { useStore } from "@/store/useSettings";
import { checkBackend } from "@/services/api";
import { readPdfFile, basename, listenDragDrop } from "@/services/pdf";
import PDFViewer from "@/components/PDFViewer";
import TranslationPanel from "@/components/TranslationPanel";
import TabBar from "@/components/TabBar";
import Settings from "@/components/Settings";
import Splitter from "@/components/Splitter";

export default function App() {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const addTab = useStore((s) => s.addTab);
  const updateTab = useStore((s) => s.updateTab);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const backendStatus = useStore((s) => s.backendStatus);
  const setBackendStatus = useStore((s) => s.setBackendStatus);
  const splitRatio = useStore((s) => s.splitRatio);

  // 拖放遮罩显隐 + 拖放错误提示
  const [dragOver, setDragOver] = useState(false);
  const [dropError, setDropError] = useState("");
  const recentDropRef = useRef<{ path: string; at: number } | null>(null);

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

  // 从本地路径加载 PDF 为新标签（打开按钮与拖放共用）
  const loadFromPath = useCallback(
    async (path: string) => {
      try {
        const normalizedPath = path.toLowerCase();
        const now = Date.now();
        const recent = recentDropRef.current;
        if (recent?.path === normalizedPath && now - recent.at < 1200) {
          return;
        }
        recentDropRef.current = { path: normalizedPath, at: now };

        const bytes = await readPdfFile(path);
        const id = addTab(bytes, basename(path));
        setDropError(id ? "" : "最多同时打开 8 个标签页");
      } catch (e) {
        setDropError(e instanceof Error ? e.message : "打开 PDF 失败");
      }
    },
    [addTab]
  );

  // 监听 Tauri 原生拖放
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listenDragDrop({
      onEnter: () => setDragOver(true),
      onLeave: () => setDragOver(false),
      onDrop: (paths) => {
        const pdfs = paths.filter((p) => p.toLowerCase().endsWith(".pdf"));
        if (pdfs.length === 0) {
          setDropError("请拖入 PDF 文件（未检测到 .pdf）");
          return;
        }
        if (pdfs.length > 1) {
          setDropError("检测到多个文件，仅打开第一个 PDF");
        }
        loadFromPath(pdfs[0]);
      },
    }).then((fn) => (unlisten = fn));
    return () => unlisten?.();
  }, [loadFromPath]);

  // 打开本地 PDF：优先用 Tauri 原生对话框；浏览器环境降级为 <input>
  const openPdf = useCallback(async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (typeof selected === "string") {
        await loadFromPath(selected);
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
          const id = addTab(buf, file.name);
          setDropError(id ? "" : "最多同时打开 8 个标签页");
        }
      };
      input.click();
    }
  }, [loadFromPath, addTab]);

  return (
    <div className="flex flex-col h-full bg-slate-100 relative">
      {/* 拖放遮罩：当文件拖入窗口时显示 */}
      {dragOver && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-primary-600/20 border-4 border-dashed border-primary-500 pointer-events-none">
          <Upload size={56} className="text-primary-600 mb-3" strokeWidth={1.5} />
          <p className="text-xl font-semibold text-primary-700">松开以打开 PDF</p>
        </div>
      )}

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

      {/* 标签栏 */}
      <TabBar onOpen={openPdf} />

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

      {/* 拖放错误提示条（自动 3 秒消失） */}
      {dropError && (
        <DropErrorBanner message={dropError} onDismiss={() => setDropError("")} />
      )}

      {/* 主体：左右分栏（可拖拽调整比例） */}
      <div className="flex flex-1 min-h-0">
        {/* 左侧原始 PDF（按标签 key 重建，保证每篇独立 PDF.js 实例） */}
        <div
          className="bg-slate-200 min-w-0 shrink-0"
          style={{ width: `${splitRatio * 100}%` }}
        >
          {activeTab ? (
            <PDFViewer
              key={activeTab.id}
              data={activeTab.pdfData}
              side="left"
              currentPage={activeTab.currentPage}
              onPageChange={(p) => updateTab(activeTab.id, { currentPage: p })}
              pdfId={activeTab.id}
            />
          ) : (
            <EmptyHint onOpen={openPdf} />
          )}
        </div>

        <Splitter />

        {/* 右侧功能面板（常驻，随激活标签重渲染） */}
        <div className="bg-white min-w-0 flex-1">
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
      <p className="text-xs text-slate-400 mt-1">或将 PDF 文件拖入窗口</p>
    </div>
  );
}

function DropErrorBanner({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  // 3 秒后自动消失
  useEffect(() => {
    const t = setTimeout(onDismiss, 3000);
    return () => clearTimeout(t);
  }, [message, onDismiss]);

  return (
    <div className="flex items-center gap-2 px-4 py-2 text-sm bg-red-50 text-red-600 border-b border-red-200 shrink-0">
      <AlertTriangle size={16} className="shrink-0" />
      <span className="flex-1">{message}</span>
      <button onClick={onDismiss} className="text-red-400 hover:text-red-600 ml-2">✕</button>
    </div>
  );
}
