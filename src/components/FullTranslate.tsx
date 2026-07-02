// 全文翻译：上传当前 PDF → 后端处理 → SSE 进度 → 右侧显示翻译后 PDF。
// 翻译后的 PDF 与左侧原文做页码级同步滚动（PDFViewer side="right"）。

import { useState, useCallback, useRef } from "react";
import { Loader2, Play, AlertCircle } from "lucide-react";
import {
  startPdfTranslate,
  subscribePdfProgress,
  pdfResultUrl,
  bytesToPdfBlob,
} from "@/services/api";
import { useStore } from "@/store/useSettings";
import PDFViewer from "./PDFViewer";
import type { PdfProgressEvent } from "@/types";

export default function FullTranslate() {
  const { pdfData, pdfName, settings, hasSettings, setSettingsOpen } =
    useStore();
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");
  const [mode, setMode] = useState("");
  const [error, setError] = useState("");
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  const start = useCallback(async () => {
    if (!pdfData) {
      setError("请先打开一个 PDF");
      return;
    }
    if (!hasSettings()) {
      setError("请先在「设置」中配置 API Key");
      setSettingsOpen(true);
      return;
    }
    setRunning(true);
    setError("");
    setProgress(0);
    setResultUrl(null);
    setMessage("上传中...");

    try {
      const blob = bytesToPdfBlob(pdfData);
      const taskId = await startPdfTranslate(blob, pdfName, settings);

      cleanupRef.current = subscribePdfProgress(
        taskId,
        (e: PdfProgressEvent) => {
          setProgress(e.progress);
          setMessage(e.message);
          if (e.mode) setMode(e.mode);
          if (e.done) {
            setRunning(false);
            if (e.error) {
              setError(e.message);
            } else {
              setResultUrl(pdfResultUrl(taskId));
            }
          }
        },
        (err) => {
          setRunning(false);
          setError(err.message);
        }
      );
    } catch (e) {
      setRunning(false);
      setError(e instanceof Error ? e.message : "启动失败");
    }
  }, [pdfData, pdfName, settings, hasSettings, setSettingsOpen]);

  // 已有结果：显示翻译后的 PDF
  if (resultUrl) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 px-3 py-2 text-xs bg-green-50 text-green-700 border-b shrink-0">
          翻译完成
          {mode === "fallback" && (
            <span className="text-amber-600">
              （降级模式：纯文本，未保留排版/公式/图表）
            </span>
          )}
          <button
            onClick={() => setResultUrl(null)}
            className="ml-auto text-slate-500 hover:text-slate-700"
          >
            重新翻译
          </button>
        </div>
        <div className="flex-1 min-h-0">
          <PDFViewer data={resultUrl} side="right" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full p-4 gap-4">
      <div className="text-sm text-slate-600">
        将当前 PDF 全文翻译为中文，尽量保留原排版、公式、图片、表格
        （依赖 pdf2zh；若后端未安装则自动降级为纯文本翻译）。
      </div>

      <button
        onClick={start}
        disabled={running || !pdfData}
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
    </div>
  );
}
