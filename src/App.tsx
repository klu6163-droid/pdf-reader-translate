import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  FileText, Settings as SettingsIcon, AlertTriangle, Upload, Type, Highlighter,
  ChevronDown, Clock,
} from "lucide-react";
import { useStore } from "@/store/useSettings";
import { checkBackend } from "@/services/api";
import { readPdfFile, basename, listenDragDrop } from "@/services/pdf";
import PDFViewer from "@/components/PDFViewer";
import TranslationPanel from "@/components/TranslationPanel";
import TabBar from "@/components/TabBar";
import Settings from "@/components/Settings";
import Splitter from "@/components/Splitter";
import PdfEditor from "@/components/PdfEditor";
import PdfAnnotator from "@/components/PdfAnnotator";
import BackendStatusBanner from "@/components/BackendStatusBanner";
import HelpModal from "@/components/HelpModal";
import type { AnnotTool } from "@/types";
import {
  hasDirtyStash,
  persistStash,
  discardDirtyStash,
} from "@/services/annotStash";

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
  const recentFiles = useStore((s) => s.recentFiles);
  const addRecentFile = useStore((s) => s.addRecentFile);

  // 拖放遮罩显隐 + 拖放错误提示
  const [dragOver, setDragOver] = useState(false);
  const [dropError, setDropError] = useState("");
  const recentDropRef = useRef<{ path: string; at: number } | null>(null);

  // PDF 编辑器 / 批注器浮层开关
  const [editorOpen, setEditorOpen] = useState(false);
  const [annotOpen, setAnnotOpen] = useState(false);
  // 打开批注器时预选的工具（来自顶栏「批注」或 PDFViewer 底部工具栏）
  const [annotInitialTool, setAnnotInitialTool] = useState<AnnotTool>("select");

  // 「查看说明」弹窗
  const [helpOpen, setHelpOpen] = useState(false);

  // 退出确认：有未保留的批注改动时，关窗前询问是否保留
  const [exitAskOpen, setExitAskOpen] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        unlisten = await getCurrentWindow().onCloseRequested((event) => {
          if (hasDirtyStash()) {
            event.preventDefault();
            setExitAskOpen(true);
          }
        });
      } catch {
        // 非 Tauri（浏览器 dev）：退化为直接持久化，不打断关闭
        const handler = () => {
          if (hasDirtyStash()) persistStash();
        };
        window.addEventListener("beforeunload", handler);
        unlisten = () => window.removeEventListener("beforeunload", handler);
      }
    })();
    return () => unlisten?.();
  }, []);

  const finishExit = useCallback(async (keep: boolean) => {
    if (keep) persistStash();
    else discardDirtyStash();
    setExitAskOpen(false);
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      // destroy 跳过 CloseRequested，直接销毁（Rust 侧在 Destroyed 时清理后端）
      await getCurrentWindow().destroy();
    } catch {
      window.close();
    }
  }, []);

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

  // 「重新检测」：立即探测一次后端（用户在状态卡上点击）
  const recheckBackend = useCallback(async () => {
    setBackendStatus("unknown");
    const ok = await checkBackend();
    setBackendStatus(ok ? "online" : "offline");
  }, [setBackendStatus]);

  // 以指定工具打开批注器（顶栏「批注」传 select；阅读器底部按钮传对应工具）
  const openAnnotWith = useCallback((tool: AnnotTool) => {
    setAnnotInitialTool(tool);
    setAnnotOpen(true);
  }, []);

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
        if (id) addRecentFile(path, basename(path));
        setDropError(id ? "" : "最多同时打开 8 个标签页");
      } catch (e) {
        setDropError(e instanceof Error ? e.message : "打开 PDF 失败");
      }
    },
    [addTab, addRecentFile]
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
        <div className="flex items-center gap-2">
          <span className="font-semibold text-slate-800 mr-1">PDF 阅读翻译</span>
          <button
            onClick={openPdf}
            className="flex items-center gap-1 px-3 py-1.5 text-sm bg-primary-600 text-white rounded hover:bg-primary-700"
          >
            <FileText size={16} />
            打开 PDF
          </button>
          <RecentFilesMenu
            files={recentFiles}
            onOpen={loadFromPath}
          />
          {activeTab && (
            <button
              onClick={() => setEditorOpen(true)}
              disabled={backendStatus !== "online"}
              title={
                backendStatus === "online"
                  ? "编辑当前 PDF 的文本块"
                  : "需先连接后端才能编辑"
              }
              className="flex items-center gap-1 px-3 py-1.5 text-sm border border-primary-600 text-primary-700 rounded hover:bg-primary-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Type size={16} />
              编辑
            </button>
          )}
          {activeTab && (
            <button
              onClick={() => openAnnotWith("select")}
              disabled={backendStatus !== "online"}
              title={
                backendStatus === "online"
                  ? "为当前 PDF 添加批注（高亮/下划线/便签/画笔）"
                  : "需先连接后端才能批注"
              }
              className="flex items-center gap-1 px-3 py-1.5 text-sm border border-amber-500 text-amber-600 rounded hover:bg-amber-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Highlighter size={16} />
              批注
            </button>
          )}
        </div>
        <div className="flex items-center gap-3">
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

      {/* 后端状态提示（离线=友好卡片 / 在线=绿色条 / unknown=检测中） */}
      <BackendStatusBanner
        status={backendStatus}
        onRecheck={recheckBackend}
        onShowHelp={() => setHelpOpen(true)}
      />

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
              suggestedName={activeTab.name}
              onOpenAnnot={openAnnotWith}
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
      <HelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />

      {/* PDF 文本块编辑器（全屏浮层）。按 activeTab.id 重建，确保切换标签后编辑正确的 PDF。 */}
      {editorOpen && activeTab && (
        <PdfEditor
          key={activeTab.id}
          data={activeTab.pdfData}
          name={activeTab.name}
          onClose={() => setEditorOpen(false)}
        />
      )}

      {/* PDF 批注器（全屏浮层，可预选工具） */}
      {annotOpen && activeTab && (
        <PdfAnnotator
          key={activeTab.id}
          data={activeTab.pdfData}
          name={activeTab.name}
          initialTool={annotInitialTool}
          onClose={() => setAnnotOpen(false)}
        />
      )}

      {/* 退出确认：是否保留本次批注 */}
      {exitAskOpen && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-900/50">
          <div className="w-96 bg-white rounded-lg shadow-xl p-5 space-y-4">
            <h3 className="font-semibold text-slate-800">保留批注？</h3>
            <p className="text-sm text-slate-600">
              本次会话中有批注改动尚未写入 PDF。是否保留这些批注，
              以便下次打开软件继续编辑？
            </p>
            <p className="text-xs text-slate-400">
              保留：下次打开同一 PDF 的批注时自动恢复。不保留：仅丢弃本次改动。
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setExitAskOpen(false)}
                className="px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100 rounded"
              >
                取消
              </button>
              <button
                onClick={() => finishExit(false)}
                className="px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 rounded"
              >
                不保留并退出
              </button>
              <button
                onClick={() => finishExit(true)}
                className="px-3 py-1.5 text-sm bg-primary-600 text-white rounded hover:bg-primary-700"
              >
                保留并退出
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RecentFilesMenu({
  files,
  onOpen,
}: {
  files: { path: string; name: string; ts: number }[];
  onOpen: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const clearRecentFiles = useStore((s) => s.clearRecentFiles);
  const removeRecentFile = useStore((s) => s.removeRecentFile);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const el = (e.target as HTMLElement)?.closest("[data-recent-menu]");
      if (!el) setOpen(false);
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div className="relative" data-recent-menu>
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={files.length === 0}
        title={files.length === 0 ? "暂无最近文件" : "最近打开的文件"}
        className="flex items-center gap-1 px-3 py-1.5 text-sm text-slate-600 border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Clock size={16} />
        最近文件
        <ChevronDown size={14} className="text-slate-400" />
      </button>
      {open && files.length > 0 && (
        <div className="absolute left-0 top-full mt-1 z-50 w-72 bg-white border border-slate-200 rounded-md shadow-lg py-1 max-h-80 overflow-auto">
          {files.map((f) => (
            <div
              key={f.path}
              className="group flex items-center gap-2 px-3 py-1.5 hover:bg-slate-50 cursor-pointer"
              onClick={() => {
                setOpen(false);
                onOpen(f.path);
              }}
              title={f.path}
            >
              <FileText size={14} className="shrink-0 text-slate-400" />
              <span className="flex-1 truncate text-sm text-slate-700">
                {f.name}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  removeRecentFile(f.path);
                }}
                className="opacity-0 group-hover:opacity-100 text-slate-300 hover:text-red-500 px-1"
                title="从列表移除"
              >
                ✕
              </button>
            </div>
          ))}
          <div className="border-t mt-1 pt-1">
            <button
              onClick={() => {
                clearRecentFiles();
                setOpen(false);
              }}
              className="w-full text-left px-3 py-1.5 text-xs text-slate-400 hover:text-red-500 hover:bg-slate-50"
            >
              清空最近文件
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function EmptyHint({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full p-6">
      <div className="w-full max-w-sm flex flex-col items-center text-center gap-4 p-8 bg-white rounded-xl border border-slate-200 shadow-sm">
        <div className="w-16 h-16 rounded-full bg-primary-50 flex items-center justify-center">
          <FileText size={32} className="text-primary-500" strokeWidth={1.5} />
        </div>
        <div>
          <p className="text-base font-medium text-slate-800">
            打开一篇 PDF 开始阅读
          </p>
          <p className="text-sm text-slate-500 mt-1">
            支持拖拽 PDF 到这里，或选择本地 PDF 文件。
          </p>
        </div>
        <button
          onClick={onOpen}
          className="flex items-center gap-2 px-5 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700"
        >
          <FileText size={16} />
          选择 PDF 文件
        </button>
        <p className="text-xs text-slate-400">也可点击顶部「最近文件」重新打开</p>
      </div>
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
