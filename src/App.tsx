import { useCallback, useEffect, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import {
  FileText,
  Settings as SettingsIcon,
  AlertTriangle,
  Upload,
  Type,
  Highlighter,
  ChevronDown,
  Clock,
  Download,
  Loader2,
  X,
} from 'lucide-react';
import { useStore } from '@/store/useSettings';
import { checkBackend } from '@/services/api';
import { readPdfFile, basename, listenDragDrop } from '@/services/pdf';
import PDFViewer from '@/components/PDFViewer';
import TranslationPanel from '@/components/TranslationPanel';
import TabBar from '@/components/TabBar';
import Settings from '@/components/Settings';
import Splitter from '@/components/Splitter';
import PdfEditor from '@/components/PdfEditor';
import PdfAnnotator from '@/components/PdfAnnotator';
import BackendStatusBanner from '@/components/BackendStatusBanner';
import HelpModal from '@/components/HelpModal';
import AppMark from '@/components/ui/AppMark';
import IconButton from '@/components/ui/IconButton';
import ModalSurface from '@/components/ui/ModalSurface';
import clayDocumentTranslate from '@/assets/clay-document-translate.png';
import type { AnnotTool } from '@/types';
import { hasDirtyStash, persistStash, discardDirtyStash } from '@/services/annotStash';
import { exportDiagnosticBundle } from '@/services/diagnostics';

/** Rust 侧 emit 的 backend-status 事件载荷（审计 3.6 崩溃重拉） */
type BackendStatusEvent =
  | { state: 'restarting'; attempt: number; max: number }
  | { state: 'running' }
  | { state: 'failed'; code: number | null; logPath: string; restartLog: string };

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
  const settings = useStore((s) => s.settings);

  // 拖放遮罩显隐 + 拖放错误提示
  const [dragOver, setDragOver] = useState(false);
  const [dropError, setDropError] = useState('');
  const recentDropRef = useRef<{ path: string; at: number } | null>(null);
  const dismissDropError = useCallback(() => setDropError(''), []);

  // PDF 编辑器 / 批注器浮层开关
  const [editorOpen, setEditorOpen] = useState(false);
  const [annotOpen, setAnnotOpen] = useState(false);
  // 打开批注器时预选的工具（来自顶栏「批注」或 PDFViewer 底部工具栏）
  const [annotInitialTool, setAnnotInitialTool] = useState<AnnotTool>('select');

  // 「查看说明」弹窗
  const [helpOpen, setHelpOpen] = useState(false);
  const [diagnosticExporting, setDiagnosticExporting] = useState(false);
  const [diagnosticNotice, setDiagnosticNotice] = useState('');

  // 后端崩溃重拉相关（审计 3.6）：
  // - restartAttempt：Rust 侧正在自动重拉的进度（attempt=0 表示用户手动触发）
  // - backendFail：自动重拉耗尽 / 手动重启失败时的详情（退出码、日志路径、错误文案）
  const [restartAttempt, setRestartAttempt] = useState<{ attempt: number; max: number } | null>(
    null,
  );
  const [backendFail, setBackendFail] = useState<{
    message?: string;
    code?: number | null;
    logPath?: string;
    restartLog?: string;
  } | null>(null);

  // 退出确认：有未保留的批注改动时，关窗前询问是否保留
  const [exitAskOpen, setExitAskOpen] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
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
        window.addEventListener('beforeunload', handler);
        unlisten = () => window.removeEventListener('beforeunload', handler);
      }
    })();
    return () => unlisten?.();
  }, []);

  const finishExit = useCallback(async (keep: boolean) => {
    if (keep) persistStash();
    else discardDirtyStash();
    setExitAskOpen(false);
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      // destroy 跳过 CloseRequested，直接销毁（Rust 侧在 Destroyed 时清理后端）
      await getCurrentWindow().destroy();
    } catch {
      window.close();
    }
  }, []);

  // 启动后轮询后端健康状态（后端由 Tauri 拉起，首启需加载 PyMuPDF/pdf2zh 等重依赖）
  useEffect(() => {
    let stopped = false;
    const startedAt = Date.now();
    // 启动宽限期：10 秒内探测失败仍显示「启动中」而非「离线」（onedir 冷启动约 3s，留余量）
    const GRACE_MS = 10_000;
    setBackendStatus('starting');
    const poll = async () => {
      const ok = await checkBackend();
      if (stopped) return;
      if (ok) {
        setBackendStatus('online');
        setRestartAttempt(null);
        setBackendFail(null);
        return;
      }
      // Rust 侧自动重拉 / 手动重启进行中：不降级为 offline（会闪掉「正在重启」提示），
      // 状态流转交给 backend-status 事件；轮询只负责在恢复时翻回 online
      if (useStore.getState().backendStatus === 'reconnecting') return;
      const elapsed = Date.now() - startedAt;
      setBackendStatus(elapsed < GRACE_MS ? 'starting' : 'offline');
    };
    poll();
    const timer = setInterval(poll, 3000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [setBackendStatus]);

  // 监听 Rust 侧后端生命周期事件（审计 3.6）：
  // restarting → 显示「正在自动重启」；failed → 落回离线卡并给出退出码与日志路径；
  // running → 后端已恢复（如退避等待期间自己活了），直接翻 online。
  // 非 Tauri 环境（纯浏览器）没有该通道，退化为仅轮询，行为与之前一致。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const un = await listen<BackendStatusEvent>('backend-status', (e) => {
          const p = e.payload;
          if (p.state === 'restarting') {
            setBackendFail(null);
            setRestartAttempt({ attempt: p.attempt, max: p.max });
            setBackendStatus('reconnecting');
          } else if (p.state === 'running') {
            setRestartAttempt(null);
            setBackendFail(null);
            setBackendStatus('online');
          } else if (p.state === 'failed') {
            setRestartAttempt(null);
            setBackendFail({ code: p.code, logPath: p.logPath, restartLog: p.restartLog });
            setBackendStatus('offline');
          }
        });
        if (cancelled) un();
        else unlisten = un;
      } catch {
        /* 非 Tauri 环境：无事件通道 */
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [setBackendStatus]);

  // 「重新检测」：立即探测一次后端（用户在状态卡上点击）
  const recheckBackend = useCallback(async () => {
    setBackendStatus('starting');
    const ok = await checkBackend();
    if (ok) {
      setBackendStatus('online');
      setRestartAttempt(null);
      setBackendFail(null);
    } else if (useStore.getState().backendStatus === 'reconnecting') {
      // 重启进行中：不覆盖为离线
      setBackendStatus('reconnecting');
    } else {
      setBackendStatus('offline');
    }
  }, [setBackendStatus]);

  // 「重启后端」：调 Rust 命令强制换新（先杀旧进程再拉起）。
  // 失败原因（如端口被外部进程占用）写入 backendFail，在离线卡上展示。
  const restartBackend = useCallback(async () => {
    setBackendFail(null);
    setRestartAttempt({ attempt: 0, max: 3 });
    setBackendStatus('reconnecting');
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('restart_backend');
    } catch (e) {
      setRestartAttempt(null);
      setBackendFail({ message: e instanceof Error ? e.message : String(e) });
      setBackendStatus('offline');
    }
  }, [setBackendStatus]);

  const exportDiagnostics = useCallback(async () => {
    setDiagnosticExporting(true);
    setDiagnosticNotice('');
    try {
      const path = await exportDiagnosticBundle(settings, useStore.getState().getSummarySettings());
      if (path) setDiagnosticNotice(`诊断信息已保存：${path}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setDiagnosticNotice(`诊断信息导出失败：${detail}`);
    } finally {
      setDiagnosticExporting(false);
    }
  }, [settings]);

  // 以指定工具打开批注器（顶栏「批注」传 select；阅读器底部按钮传对应工具）
  const openAnnotWith = useCallback((tool: AnnotTool) => {
    setAnnotInitialTool(tool);
    setAnnotOpen(true);
  }, []);

  // 从本地路径加载 PDF 为新标签（打开按钮与拖放共用）
  const loadFromPath = useCallback(
    async (path: string, keepDropNotice = false) => {
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
        if (!id) setDropError('最多同时打开 8 个标签页');
        // 多文件拖入已有「仅打开第一个」提示时，成功不能把它立即清掉。
        else if (!keepDropNotice) setDropError('');
      } catch (e) {
        setDropError(e instanceof Error ? e.message : '打开 PDF 失败');
      }
    },
    [addTab, addRecentFile],
  );

  // 监听 Tauri 原生拖放
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listenDragDrop({
      onEnter: () => setDragOver(true),
      onLeave: () => setDragOver(false),
      onDrop: (paths) => {
        const pdfs = paths.filter((p) => p.toLowerCase().endsWith('.pdf'));
        if (pdfs.length === 0) {
          setDropError('请拖入 PDF 文件（未检测到 .pdf）');
          return;
        }
        if (pdfs.length > 1) {
          setDropError('检测到多个文件，仅打开第一个 PDF');
        }
        loadFromPath(pdfs[0], pdfs.length > 1);
      },
    }).then((fn) => (unlisten = fn));
    return () => unlisten?.();
  }, [loadFromPath]);

  // 打开本地 PDF：优先用 Tauri 原生对话框；浏览器环境降级为 <input>
  const openPdf = useCallback(async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (typeof selected === 'string') {
        await loadFromPath(selected);
      }
    } catch {
      // 非 Tauri 环境（纯浏览器 dev）降级
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/pdf';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (file) {
          const buf = new Uint8Array(await file.arrayBuffer());
          const id = addTab(buf, file.name);
          setDropError(id ? '' : '最多同时打开 8 个标签页');
        }
      };
      input.click();
    }
  }, [loadFromPath, addTab]);

  return (
    <div className="app-shell relative flex h-full flex-col overflow-hidden">
      {/* 拖放遮罩：当文件拖入窗口时显示 */}
      {dragOver && (
        <div className="drag-overlay pointer-events-none absolute inset-3 z-50 flex flex-col items-center justify-center">
          <div className="soft-icon-orb flex h-16 w-16 items-center justify-center text-primary-600">
            <Upload size={32} />
          </div>
          <p className="mt-3 text-base font-semibold text-primary-700">松开以打开 PDF</p>
          <p className="mt-1 text-xs text-slate-600">仅处理第一个有效的 PDF 文件</p>
        </div>
      )}

      {/* 顶部主工具栏与标签栏共用一个玻璃平面，避免玻璃叠玻璃。 */}
      <div className="app-top-chrome shrink-0">
        <header className="flex h-14 items-center justify-between gap-3 px-4">
          <div className="flex min-w-0 items-center gap-2">
            <div className="mr-1 flex shrink-0 items-center gap-2.5" aria-label="PDF 阅读翻译">
              <span className="app-mark-shell flex h-9 w-9 items-center justify-center">
                <AppMark size={24} />
              </span>
              <span className="compact-title whitespace-nowrap font-semibold tracking-[-0.025em] text-[var(--text-primary)]">
                PDF 阅读翻译
              </span>
            </div>
            <button onClick={openPdf} className="ui-button ui-button-primary text-sm">
              <FileText size={16} />
              打开 PDF
            </button>
            <RecentFilesMenu files={recentFiles} onOpen={loadFromPath} />
            {activeTab && (
              <button
                onClick={() => setEditorOpen(true)}
                disabled={backendStatus !== 'online'}
                title={
                  backendStatus === 'online' ? '编辑当前 PDF 的文本块' : '需先连接后端才能编辑'
                }
                className="ui-button text-sm"
              >
                <Type size={16} />
                <span className="compact-label">编辑</span>
              </button>
            )}
            {activeTab && (
              <button
                onClick={() => openAnnotWith('select')}
                disabled={backendStatus !== 'online'}
                title={
                  backendStatus === 'online'
                    ? '为当前 PDF 添加批注（高亮/下划线/便签/画笔）'
                    : '需先连接后端才能批注'
                }
                className="ui-button ui-button-accent text-sm"
              >
                <Highlighter size={16} />
                <span className="compact-label">批注</span>
              </button>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              onClick={exportDiagnostics}
              disabled={diagnosticExporting}
              className="ui-button text-sm"
              title="导出不含原文、译文和 API Key 的 diagnostics.json"
            >
              {diagnosticExporting ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Download size={16} />
              )}
              <span className="compact-label">{diagnosticExporting ? '导出中' : '导出诊断'}</span>
            </button>
            <button
              onClick={() => setSettingsOpen(true)}
              className="ui-button text-sm"
              title="API 与模型设置"
            >
              <SettingsIcon size={16} />
              <span className="compact-label">设置</span>
            </button>
          </div>
        </header>

        <TabBar onOpen={openPdf} />
      </div>

      {/* 后端状态提示（离线=友好卡片 / 在线=绿色条 / unknown=检测中） */}
      <BackendStatusBanner
        status={backendStatus}
        onRecheck={recheckBackend}
        onShowHelp={() => setHelpOpen(true)}
        onRestart={restartBackend}
        onExportDiagnostics={exportDiagnostics}
        diagnosticExporting={diagnosticExporting}
        restartAttempt={restartAttempt}
        failure={backendFail}
      />

      {diagnosticNotice && (
        <div
          className="app-alert-banner status-surface status-info flex items-center gap-2 break-all px-4 py-1.5 text-xs"
          role="status"
        >
          <span className="flex-1">{diagnosticNotice}</span>
          <IconButton
            size="sm"
            label="关闭诊断提示"
            onClick={() => setDiagnosticNotice('')}
            icon={<X size={14} />}
          />
        </div>
      )}

      {/* 拖放错误提示条（自动 3 秒消失） */}
      {dropError && <DropErrorBanner message={dropError} onDismiss={dismissDropError} />}

      {/* 主体：左右分栏（可拖拽调整比例） */}
      <div className="workspace-grid flex min-h-0 flex-1 gap-2 px-2 pb-2 pt-1.5">
        {/* 左侧原始 PDF（按标签 key 重建，保证每篇独立 PDF.js 实例） */}
        <div
          className="workspace-pane workspace-pane-pdf min-w-0 shrink-0 overflow-hidden"
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
        <div className="workspace-pane workspace-pane-tools min-w-0 flex-1 overflow-hidden">
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
      <ModalSurface
        open={exitAskOpen}
        onClose={() => setExitAskOpen(false)}
        closeOnBackdrop={false}
        labelledBy="exit-confirm-title"
        className="max-w-96"
        zIndexClass="z-[80]"
      >
        <div className="modal-body-solid space-y-4 p-5">
          <h3 id="exit-confirm-title" className="font-semibold text-slate-800">
            保留批注？
          </h3>
          <p className="text-sm text-slate-600">
            本次会话中有批注改动尚未写入 PDF。是否保留这些批注， 以便下次打开软件继续编辑？
          </p>
          <p className="text-xs text-slate-400">
            保留：下次打开同一 PDF 的批注时自动恢复。不保留：仅丢弃本次改动。
          </p>
          <div className="flex justify-end gap-2 pt-1">
            <button onClick={() => setExitAskOpen(false)} className="ui-button text-sm">
              取消
            </button>
            <button
              onClick={() => finishExit(false)}
              className="ui-button ui-button-danger text-sm"
            >
              不保留并退出
            </button>
            <button
              onClick={() => finishExit(true)}
              className="ui-button ui-button-primary text-sm"
            >
              保留并退出
            </button>
          </div>
        </div>
      </ModalSurface>
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
      const el = (e.target as HTMLElement)?.closest('[data-recent-menu]');
      if (!el) setOpen(false);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div className="relative z-[60]" data-recent-menu>
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={files.length === 0}
        title={files.length === 0 ? '暂无最近文件' : '最近打开的文件'}
        className="ui-button text-sm"
        aria-expanded={open}
      >
        <Clock size={16} />
        <span className="compact-label">最近文件</span>
        <ChevronDown size={14} className="text-slate-400" />
      </button>
      {open && files.length > 0 && (
        <div className="glass-surface-strong absolute left-0 top-full z-[70] mt-2 max-h-80 w-72 overflow-auto rounded-panel p-1.5">
          {files.map((f) => (
            <div
              key={f.path}
              className="group flex cursor-pointer items-center gap-2 rounded-control px-3 py-2 hover:bg-white/70"
              onClick={() => {
                setOpen(false);
                onOpen(f.path);
              }}
              title={f.path}
            >
              <FileText size={14} className="shrink-0 text-slate-400" />
              <span className="flex-1 truncate text-sm text-slate-700">{f.name}</span>
              <IconButton
                onClick={(e) => {
                  e.stopPropagation();
                  removeRecentFile(f.path);
                }}
                size="sm"
                label="从列表移除"
                className="opacity-0 group-hover:opacity-100 text-slate-400"
                icon={<X size={13} />}
              />
            </div>
          ))}
          <div className="border-t mt-1 pt-1">
            <button
              onClick={() => {
                clearRecentFiles();
                setOpen(false);
              }}
              className="w-full rounded-control px-3 py-2 text-left text-xs text-slate-500 hover:bg-red-50 hover:text-red-600"
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
    <div className="flex h-full flex-col items-center justify-center p-6">
      <div className="empty-state-card flex w-full max-w-sm flex-col items-center gap-3.5 px-8 pb-8 pt-5 text-center">
        <img
          src={clayDocumentTranslate}
          alt=""
          aria-hidden="true"
          className="clay-empty-illustration h-32 w-32 object-contain"
        />
        <div>
          <p className="text-base font-semibold tracking-[-0.015em] text-[var(--text-primary)]">
            打开一篇 PDF 开始阅读
          </p>
          <p className="mt-1.5 text-sm text-[var(--text-secondary)]">
            支持拖拽 PDF 到这里，或选择本地 PDF 文件。
          </p>
        </div>
        <button onClick={onOpen} className="ui-button ui-button-primary px-5 text-sm">
          <FileText size={16} />
          选择 PDF 文件
        </button>
        <p className="text-xs text-slate-400">也可点击顶部「最近文件」重新打开</p>
      </div>
    </div>
  );
}

function DropErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  // 3 秒后自动消失
  useEffect(() => {
    const t = setTimeout(onDismiss, 3000);
    return () => clearTimeout(t);
  }, [message, onDismiss]);

  return (
    <div
      className="app-alert-banner status-surface status-danger flex shrink-0 items-center gap-2 px-4 py-1.5 text-sm"
      role="alert"
    >
      <AlertTriangle size={16} className="shrink-0" />
      <span className="flex-1">{message}</span>
      <IconButton size="sm" label="关闭提示" onClick={onDismiss} icon={<X size={14} />} />
    </div>
  );
}
