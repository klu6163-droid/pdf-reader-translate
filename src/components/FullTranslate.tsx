// 全文翻译：上传当前标签的 PDF → 后端处理 → SSE 进度 → 右侧显示翻译后 PDF。
// 状态存于当前标签页（store），切换标签可保留进度；
// 切回正在运行的任务时按 taskId 重连 SSE。

import { useCallback, useEffect } from "react";
import { Loader2, Play, AlertCircle } from "lucide-react";
import {
  startPdfTranslate,
  subscribePdfProgress,
  pdfResultUrl,
  bytesToPdfBlob,
} from "@/services/api";
import { useStore, useActiveTab } from "@/store/useSettings";
import PDFViewer from "./PDFViewer";
import type { PdfProgressEvent, PdfTab } from "@/types";

export default function FullTranslate() {
  const tab = useActiveTab();
  const updateTab = useStore((s) => s.updateTab);

  // 当前标签的翻译任务 id；变化时（启动 / 切换标签）触发订阅
  const taskId = tab?.translationTaskId ?? null;

  // 订阅 SSE 进度。依赖 taskId：任务启动（设了 id）或切回运行中的任务时订阅；
  // 进度更新不改变 taskId，因此不会反复重连。
  useEffect(() => {
    if (!taskId) return;
    // 仅当该任务仍属运行中、无结果、无错误时才订阅
    const st0 = useStore.getState();
    const owner0 = st0.tabs.find((t) => t.translationTaskId === taskId);
    if (
      !owner0 ||
      owner0.translatedPdfUrl ||
      owner0.translationError ||
      !owner0.translationRunning
    )
      return;

    const cleanup = subscribePdfProgress(
      taskId,
      (e: PdfProgressEvent) => {
        const cur = useStore.getState();
        const owner = cur.tabs.find((t) => t.translationTaskId === taskId);
        if (!owner) return;
        const patch: Partial<PdfTab> = {
          translationProgress: e.progress,
          translationMessage: e.message,
        };
        if (e.mode) patch.translationMode = e.mode;
        cur.updateTab(owner.id, patch);
        if (e.done) {
          cur.updateTab(
            owner.id,
            e.error
              ? { translationRunning: false, translationError: e.message }
              : {
                  translationRunning: false,
                  translatedPdfUrl: pdfResultUrl(taskId),
                }
          );
        }
      },
      (err) => {
        const cur = useStore.getState();
        const owner = cur.tabs.find((t) => t.translationTaskId === taskId);
        if (owner)
          cur.updateTab(owner.id, {
            translationRunning: false,
            translationError: err.message,
          });
      }
    );
    return cleanup;
  }, [taskId]);

  const start = useCallback(async () => {
    const s = useStore.getState();
    const current = s.tabs.find((t) => t.id === s.activeTabId);
    if (!current) return;
    const targetId = current.id; // 捕获，避免异步期间切换标签写错对象

    if (!current.pdfData) {
      s.updateTab(targetId, { translationError: "请先打开一个 PDF" });
      return;
    }
    if (!s.hasSettings()) {
      s.updateTab(targetId, { translationError: "请先在「设置」中配置 API Key" });
      s.setSettingsOpen(true);
      return;
    }

    s.updateTab(targetId, {
      translationRunning: true,
      translationError: "",
      translationProgress: 0,
      translatedPdfUrl: null,
      translationMessage: "上传中...",
      translationMode: "",
      translationTaskId: null,
    });

    try {
      const blob = bytesToPdfBlob(current.pdfData);
      const newTaskId = await startPdfTranslate(blob, current.name, s.settings);
      // 设置 taskId 触发上面的订阅 effect
      useStore.getState().updateTab(targetId, { translationTaskId: newTaskId });
    } catch (e) {
      useStore.getState().updateTab(targetId, {
        translationRunning: false,
        translationError: e instanceof Error ? e.message : "启动失败",
      });
    }
  }, []);

  // 已有结果：显示翻译后的 PDF
  if (tab?.translatedPdfUrl) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 px-3 py-2 text-xs bg-green-50 text-green-700 border-b shrink-0">
          翻译完成
          {tab.translationMode === "fallback" && (
            <span className="text-amber-600">
              （降级模式：纯文本，未保留排版/公式/图表）
            </span>
          )}
          <button
            onClick={() =>
              updateTab(tab.id, {
                translatedPdfUrl: null,
                translationProgress: 0,
                translationMessage: "",
              })
            }
            className="ml-auto text-slate-500 hover:text-slate-700"
          >
            重新翻译
          </button>
        </div>
        <div className="flex-1 min-h-0">
          <PDFViewer
            data={tab.translatedPdfUrl}
            side="right"
            currentPage={tab.currentPage}
            suggestedName={
              (tab.name || "translated.pdf").replace(/\.pdf$/i, "") + "-zh.pdf"
            }
            pdfId={`trans-${tab.id}`}
          />
        </div>
      </div>
    );
  }

  const running = tab?.translationRunning ?? false;
  const progress = tab?.translationProgress ?? 0;
  const message = tab?.translationMessage ?? "";
  const mode = tab?.translationMode ?? "";
  const error = tab?.translationError ?? "";
  const hasPdf = !!tab?.pdfData;

  return (
    <div className="flex flex-col h-full p-4 gap-4">
      <div className="text-sm text-slate-600">
        将当前 PDF 全文翻译为中文，尽量保留原排版、公式、图片、表格
        （依赖 pdf2zh；若后端未安装则自动降级为纯文本翻译）。
      </div>

      <button
        onClick={start}
        disabled={running || !hasPdf}
        className="flex items-center justify-center gap-2 px-4 py-2.5 bg-primary-600 text-white rounded hover:bg-primary-700 disabled:opacity-50"
      >
        {running ? (
          <Loader2 className="animate-spin" size={18} />
        ) : (
          <Play size={18} />
        )}
        {running ? "翻译中..." : "开始全文翻译"}
      </button>

      {/* 进度 */}
      {(running || progress > 0) && (
        <div className="space-y-2">
          <div className="h-2 bg-slate-200 rounded overflow-hidden">
            <div
              className="h-full bg-primary-600 transition-all duration-300"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
          <div className="flex justify-between text-xs text-slate-500">
            <span className="truncate">{message}</span>
            <span>{Math.round(progress * 100)}%</span>
          </div>
          {mode === "fallback" && (
            <div className="flex items-center gap-1 text-xs text-amber-600">
              <AlertCircle size={14} />
              当前为降级模式（未检测到 pdf2zh）
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 p-3 text-sm bg-red-50 text-red-600 rounded">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {!hasPdf && (
        <div className="text-sm text-slate-400 text-center mt-4">
          请先在左侧打开一个 PDF
        </div>
      )}
    </div>
  );
}
