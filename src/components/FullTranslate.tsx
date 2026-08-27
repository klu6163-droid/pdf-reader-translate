// 全文翻译：上传当前标签的 PDF → 后端处理 → SSE 进度 → 右侧显示翻译后 PDF。
// 状态存于当前标签页（store），切换标签可保留进度；
// 切回正在运行的任务时按 taskId 重连 SSE。
// 核心任务生命周期由 useTranslateTask 统一管理。

import { Loader2, Play, AlertCircle, Type, Highlighter, X } from 'lucide-react';
import { startPdfTranslate, subscribePdfProgress, pdfResultUrl } from '@/services/api';
import { useStore, useActiveTab } from '@/store/useSettings';
import { useTranslateTask } from '@/hooks/useTranslateTask';
import type { TranslateTaskConfig } from '@/hooks/useTranslateTask';
import PDFViewer from './PDFViewer';
import PdfEditor from './PdfEditor';
import PdfAnnotator from './PdfAnnotator';
import IconButton from './ui/IconButton';

const CONFIG: TranslateTaskConfig = {
  taskIdField: 'translationTaskId',
  runningField: 'translationRunning',
  progressField: 'translationProgress',
  messageField: 'translationMessage',
  resultUrlField: 'translatedPdfUrl',
  errorField: 'translationError',
  modeField: 'translationMode',
  startApi: startPdfTranslate,
  subscribeApi: subscribePdfProgress,
  resultUrlApi: pdfResultUrl,
};

export default function FullTranslate() {
  const tab = useActiveTab();
  const updateTab = useStore((s) => s.updateTab);
  const backendStatus = useStore((s) => s.backendStatus);
  const backendOnline = backendStatus === 'online';
  const syncTranslatedPage = useStore((s) => s.syncTranslatedPage);
  const setSyncTranslatedPage = useStore((s) => s.setSyncTranslatedPage);

  const [task, actions] = useTranslateTask(CONFIG);
  const { running, progress, message, mode, resultUrl, error } = task;
  const {
    start,
    openTranslatedOverlay,
    overlay,
    closeOverlay,
    editorLoading,
    editorError,
    clearEditorError,
  } = actions;

  const hasPdf = !!tab?.pdfData;

  // 已有结果：显示翻译后的 PDF
  if (resultUrl && tab) {
    const zhName = (tab.name || 'translated.pdf').replace(/\.pdf$/i, '') + '-zh.pdf';
    return (
      <div className="flex flex-col h-full">
        <div className="status-surface status-success flex shrink-0 flex-wrap items-center gap-2 px-3 py-1.5 text-xs">
          <label
            className="flex items-center gap-1 cursor-pointer select-none"
            title="开启时译文 PDF 跟随原文翻页；关闭后译文独立翻页"
          >
            <input
              type="checkbox"
              checked={syncTranslatedPage}
              onChange={(e) => setSyncTranslatedPage(e.target.checked)}
              className="h-3.5 w-3.5 accent-primary-600"
            />
            译文跟随原文
          </label>
          翻译完成
          {mode === 'fallback' && (
            <span className="text-amber-600">
              （{message || '已降级为兼容翻译模式（未保留原排版）'}）
            </span>
          )}
          <button
            onClick={() => openTranslatedOverlay(resultUrl, 'edit')}
            disabled={editorLoading}
            className="ml-auto flex items-center gap-1 text-primary-700 hover:text-primary-900 disabled:opacity-50"
            title="编辑译文 PDF 的文本块"
          >
            {editorLoading ? <Loader2 size={12} className="animate-spin" /> : <Type size={12} />}
            编辑译文
          </button>
          <button
            onClick={() => openTranslatedOverlay(resultUrl, 'annot')}
            disabled={editorLoading}
            className="flex items-center gap-1 text-primary-700 hover:text-primary-900 disabled:opacity-50"
            title="为译文 PDF 添加批注"
          >
            <Highlighter size={12} />
            批注译文
          </button>
          <button
            onClick={() =>
              updateTab(tab.id, {
                translatedPdfUrl: null,
                translationProgress: 0,
                translationMessage: '',
              })
            }
            className="text-slate-500 hover:text-slate-700"
          >
            重新翻译
          </button>
        </div>
        {editorError && (
          <div
            className="status-surface status-danger flex shrink-0 items-center gap-1.5 px-3 py-1.5 text-xs"
            role="alert"
          >
            <AlertCircle size={13} className="shrink-0" />
            <span className="flex-1">{editorError}</span>
            <IconButton
              size="sm"
              label="关闭编辑错误"
              onClick={clearEditorError}
              icon={<X size={13} />}
            />
          </div>
        )}
        <div className="flex-1 min-h-0">
          <PDFViewer
            data={resultUrl}
            side="right"
            currentPage={tab.currentPage}
            suggestedName={zhName}
            syncPage={syncTranslatedPage}
          />
        </div>

        {/* 译文 PDF 编辑/批注器（全屏浮层） */}
        {overlay?.kind === 'edit' && (
          <PdfEditor data={overlay.data} name={zhName} onClose={closeOverlay} />
        )}
        {overlay?.kind === 'annot' && (
          <PdfAnnotator data={overlay.data} name={zhName} onClose={closeOverlay} />
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto bg-white p-4">
      <div className="text-sm text-slate-600">
        将当前 PDF 全文翻译为中文，尽量保留原排版、公式、图片、表格 （依赖 pdf2zh；若 pdf2zh
        不可用或翻译失败，自动降级为兼容翻译）。
      </div>

      <button
        onClick={start}
        disabled={running || !hasPdf || !backendOnline}
        className="ui-button ui-button-primary min-h-10 px-4 py-2.5 text-sm"
      >
        {running ? <Loader2 className="animate-spin" size={18} /> : <Play size={18} />}
        {running ? '翻译中...' : '开始全文翻译'}
      </button>

      {!backendOnline && (
        <div className="status-surface status-warning flex items-start gap-2 rounded-control border p-3 text-xs">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span>后端未连接，全文翻译暂不可用。请在顶栏点「查看说明」启动后端后重试。</span>
        </div>
      )}

      {/* 进度 */}
      {(running || progress > 0) && (
        <div className="space-y-2">
          <div
            className="progress-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
            aria-label="全文翻译进度"
          >
            <div
              className="progress-value"
              data-running={running}
              style={{ '--progress': Math.max(0, Math.min(1, progress)) } as React.CSSProperties}
            />
          </div>
          <div className="flex justify-between text-xs text-slate-500">
            <span className="truncate">{message}</span>
            <span>{Math.round(progress * 100)}%</span>
          </div>
          {mode === 'fallback' && (
            <div className="flex items-center gap-1 text-xs text-amber-600">
              <AlertCircle size={14} />
              已降级为兼容翻译模式（pdf2zh 失败或不可用，具体原因见上方说明）
            </div>
          )}
        </div>
      )}

      {error && (
        <div
          className="status-surface status-danger flex items-start gap-2 rounded-control border p-3 text-sm"
          role="alert"
        >
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {!hasPdf && (
        <div className="text-sm text-slate-400 text-center mt-4">请先在左侧打开一个 PDF</div>
      )}
    </div>
  );
}
