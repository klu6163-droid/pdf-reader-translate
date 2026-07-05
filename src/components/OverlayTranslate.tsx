// 覆盖翻译：跳过 pdf2zh，直接用 PyMuPDF 提取文本块 + LLM 翻译 + 原位覆盖。
// 适合 pdf2zh 效果不理想时改用。流程与全文翻译一致：上传 → SSE 进度 → 右侧译文 PDF。

import { useCallback, useEffect, useState } from "react";
import { Loader2, Play, AlertCircle, Type, Highlighter } from "lucide-react";
import {
  startOverlayTrans,
  subscribeOverlayProgress,
  overlayResultUrl,
  bytesToPdfBlob,
} from "@/services/api";
import { useStore, useActiveTab } from "@/store/useSettings";
import PDFViewer from "./PDFViewer";
import PdfEditor from "./PdfEditor";
import PdfAnnotator from "./PdfAnnotator";
import type { PdfProgressEvent, PdfTab } from "@/types";

export default function OverlayTranslate() {
  const tab = useActiveTab();
  const updateTab = useStore((s) => s.updateTab);

  // 译文编辑/批注器：fetch 到字节后打开（null = 关闭）
  const [overlay, setOverlay] = useState<{
    kind: "edit" | "annot";
    data: Uint8Array;
  } | null>(null);
  const [editorLoading, setEditorLoading] = useState(false);
  const [editorError, setEditorError] = useState("");

  const openOverlayPdf = useCallback(
    async (url: string, kind: "edit" | "annot") => {
      setEditorLoading(true);
      setEditorError("");
      try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error("获取译文 PDF 失败（可能已被清理，请重新翻译）");
        setOverlay({ kind, data: new Uint8Array(await resp.arrayBuffer()) });
      } catch (e) {
        setEditorError(e instanceof Error ? e.message : "打开失败");
      } finally {
        setEditorLoading(false);
      }
    },
    []
  );

  const taskId = tab?.overlayTaskId ?? null;

  // 订阅 SSE 进度
  useEffect(() => {
    if (!taskId) return;
    const st0 = useStore.getState();
    const owner0 = st0.tabs.find((t) => t.overlayTaskId === taskId);
    if (
      !owner0 ||
      owner0.overlayPdfUrl ||
      owner0.overlayError ||
      !owner0.overlayRunning
    )
      return;

    const cleanup = subscribeOverlayProgress(
      taskId,
      (e: PdfProgressEvent) => {
        const cur = useStore.getState();
        const owner = cur.tabs.find((t) => t.overlayTaskId === taskId);
        if (!owner) return;
        const patch: Partial<PdfTab> = {
          overlayProgress: e.progress,
          overlayMessage: e.message,
        };
        cur.updateTab(owner.id, patch);
        if (e.done) {
          cur.updateTab(
            owner.id,
            e.error
              ? { overlayRunning: false, overlayError: e.message }
              : { overlayRunning: false, overlayPdfUrl: overlayResultUrl(taskId) }
          );
        }
      },
      (err) => {
        const cur = useStore.getState();
        const owner = cur.tabs.find((t) => t.overlayTaskId === taskId);
        if (owner)
          cur.updateTab(owner.id, {
            overlayRunning: false,
            overlayError: err.message,
          });
      }
    );
    return cleanup;
  }, [taskId]);

  const start = useCallback(async () => {
    const s = useStore.getState();
    const current = s.tabs.find((t) => t.id === s.activeTabId);
    if (!current) return;
    const targetId = current.id;
    if (!current.pdfData) {
      s.updateTab(targetId, { overlayError: "请先打开一个 PDF" });
      return;
    }
    if (!s.hasSettings()) {
      s.updateTab(targetId, { overlayError: "请先在「设置」中配置 API Key" });
      s.setSettingsOpen(true);
      return;
    }
    s.updateTab(targetId, {
      overlayRunning: true,
      overlayError: "",
      overlayProgress: 0,
      overlayPdfUrl: null,
      overlayMessage: "上传中...",
      overlayTaskId: null,
    });
    try {
      const blob = bytesToPdfBlob(current.pdfData);
      const newTaskId = await startOverlayTrans(blob, current.name, s.settings);
      useStore.getState().updateTab(targetId, { overlayTaskId: newTaskId });
    } catch (e) {
      useStore.getState().updateTab(targetId, {
        overlayRunning: false,
        overlayError: e instanceof Error ? e.message : "启动失败",
      });
    }
  }, []);

  // 已有结果：显示翻译后的 PDF
  if (tab?.overlayPdfUrl) {
    const zhName =
      (tab.name || "translated.pdf").replace(/\.pdf$/i, "") + "-zh.pdf";
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 px-3 py-2 text-xs bg-green-50 text-green-700 border-b shrink-0">
          覆盖翻译完成（跳过 pdf2zh，原位覆盖文本、保留 figure）
          <button
            onClick={() => openOverlayPdf(tab.overlayPdfUrl!, "edit")}
            disabled={editorLoading}
            className="ml-auto flex items-center gap-1 text-primary-700 hover:text-primary-900 disabled:opacity-50"
            title="编辑译文 PDF 的文本块"
          >
            {editorLoading ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Type size={12} />
            )}
            编辑译文
          </button>
          <button
            onClick={() => openOverlayPdf(tab.overlayPdfUrl!, "annot")}
            disabled={editorLoading}
            className="flex items-center gap-1 text-amber-600 hover:text-amber-800 disabled:opacity-50"
            title="为译文 PDF 添加批注"
          >
            <Highlighter size={12} /> 批注译文
          </button>
          <button
            onClick={() =>
              updateTab(tab.id, {
                overlayPdfUrl: null,
                overlayProgress: 0,
                overlayMessage: "",
              })
            }
            className="text-slate-500 hover:text-slate-700"
          >
            重新翻译
          </button>
        </div>
        {editorError && (
          <div className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-red-50 text-red-600 border-b shrink-0">
            <AlertCircle size={13} className="shrink-0" />
            <span className="flex-1">{editorError}</span>
            <button
              onClick={() => setEditorError("")}
              className="hover:text-red-800"
            >
              ✕
            </button>
          </div>
        )}
        <div className="flex-1 min-h-0">
          <PDFViewer
            data={tab.overlayPdfUrl}
            side="right"
            currentPage={tab.currentPage}
            suggestedName={zhName}
          />
        </div>

        {/* 译文 PDF 编辑/批注器（全屏浮层） */}
        {overlay?.kind === "edit" && (
          <PdfEditor
            data={overlay.data}
            name={zhName}
            onClose={() => setOverlay(null)}
          />
        )}
        {overlay?.kind === "annot" && (
          <PdfAnnotator
            data={overlay.data}
            name={zhName}
            onClose={() => setOverlay(null)}
          />
        )}
      </div>
    );
  }

  const running = tab?.overlayRunning ?? false;
  const progress = tab?.overlayProgress ?? 0;
  const message = tab?.overlayMessage ?? "";
  const error = tab?.overlayError ?? "";
  const hasPdf = !!tab?.pdfData;

  return (
    <div className="flex flex-col h-full p-4 gap-4">
      <div className="text-sm text-slate-600">
        覆盖翻译：跳过 pdf2zh，用 PyMuPDF 提取文本块 → LLM 翻译 →
        原位覆盖（保留 figure/页面图像，只覆盖文本）。适合 pdf2zh
        效果不理想时改用。
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
        {running ? "翻译中..." : "开始覆盖翻译"}
      </button>

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
