// 结构化翻译：上传当前标签 PDF → 后端 PyMuPDF 提取块+清洗+分类+逐块翻译 → SSE 进度
// → 右侧按当前页显示译文块（翻左侧 PDF 联动）；导出 Markdown / 重排中文 PDF。

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Play, AlertCircle, Download, FileText } from "lucide-react";
import {
  startStructTrans,
  subscribeStructProgress,
  getStructResult,
  structExportUrl,
  bytesToPdfBlob,
} from "@/services/api";
import { useStore, useActiveTab } from "@/store/useSettings";
import type { PdfProgressEvent, PdfTab, StructBlock } from "@/types";

const TYPE_LABEL: Record<string, string> = {
  title: "标题",
  abstract: "摘要",
  body: "正文",
  caption: "图注",
  table: "表格",
  references: "参考文献",
};
const TYPE_COLOR: Record<string, string> = {
  title: "bg-primary-100 text-primary-700",
  abstract: "bg-amber-100 text-amber-700",
  body: "bg-slate-100 text-slate-600",
  caption: "bg-blue-100 text-blue-700",
  table: "bg-purple-100 text-purple-700",
  references: "bg-gray-100 text-gray-600",
};

export default function StructTranslate() {
  const tab = useActiveTab();
  const updateTab = useStore((s) => s.updateTab);
  const [fetchError, setFetchError] = useState("");

  const taskId = tab?.structTaskId ?? null;

  // 订阅 SSE 进度
  useEffect(() => {
    if (!taskId) return;
    const st0 = useStore.getState();
    const owner0 = st0.tabs.find((t) => t.structTaskId === taskId);
    if (
      !owner0 ||
      owner0.structResult ||
      owner0.structError ||
      !owner0.structRunning
    )
      return;

    const cleanup = subscribeStructProgress(
      taskId,
      async (e: PdfProgressEvent) => {
        const cur = useStore.getState();
        const owner = cur.tabs.find((t) => t.structTaskId === taskId);
        if (!owner) return;
        const patch: Partial<PdfTab> = {
          structProgress: e.progress,
          structMessage: e.message,
        };
        cur.updateTab(owner.id, patch);
        if (e.done) {
          if (e.error) {
            cur.updateTab(owner.id, {
              structRunning: false,
              structError: e.message,
            });
          } else {
            try {
              const result = await getStructResult(taskId);
              useStore.getState().updateTab(owner.id, {
                structRunning: false,
                structResult: result,
              });
            } catch (err) {
              useStore.getState().updateTab(owner.id, {
                structRunning: false,
                structError: err instanceof Error ? err.message : "获取结果失败",
              });
            }
          }
        }
      },
      (err) => {
        const cur = useStore.getState();
        const owner = cur.tabs.find((t) => t.structTaskId === taskId);
        if (owner)
          cur.updateTab(owner.id, {
            structRunning: false,
            structError: err.message,
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
      s.updateTab(targetId, { structError: "请先打开一个 PDF" });
      return;
    }
    if (!s.hasSettings()) {
      s.updateTab(targetId, { structError: "请先在「设置」中配置 API Key" });
      s.setSettingsOpen(true);
      return;
    }
    s.updateTab(targetId, {
      structRunning: true,
      structError: "",
      structProgress: 0,
      structResult: null,
      structMessage: "上传中...",
      structTaskId: null,
    });
    try {
      const blob = bytesToPdfBlob(current.pdfData);
      const newTaskId = await startStructTrans(blob, current.name, s.settings);
      useStore.getState().updateTab(targetId, { structTaskId: newTaskId });
    } catch (e) {
      useStore.getState().updateTab(targetId, {
        structRunning: false,
        structError: e instanceof Error ? e.message : "启动失败",
      });
    }
  }, []);

  const downloadExport = useCallback(
    async (format: "md" | "pdf") => {
      if (!tab?.structTaskId || !tab?.structResult) return;
      setFetchError("");
      try {
        const resp = await fetch(structExportUrl(tab.structTaskId, format));
        if (!resp.ok) throw new Error("导出失败");
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const base = tab.structResult.source_name.replace(/\.pdf$/i, "");
        a.href = url;
        a.download = `${base}-zh.${format}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch (e) {
        setFetchError(e instanceof Error ? e.message : "导出失败");
      }
    },
    [tab?.structTaskId, tab?.structResult]
  );

  const currentPage = tab?.currentPage ?? 1;
  const pageBlocks = useMemo<StructBlock[]>(
    () =>
      tab?.structResult
        ? tab.structResult.blocks.filter((b) => b.page === currentPage)
        : [],
    [tab?.structResult, currentPage]
  );

  // 已有结果：按当前页显示译文块
  if (tab?.structResult) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 px-3 py-2 text-xs bg-green-50 text-green-700 border-b shrink-0 flex-wrap">
          <span>
            结构化翻译完成（{tab.structResult.blocks.length} 块 /{" "}
            {tab.structResult.page_count} 页）
          </span>
          <button
            onClick={() => downloadExport("md")}
            className="ml-auto flex items-center gap-1 text-primary-700 hover:text-primary-900"
          >
            <Download size={12} /> Markdown
          </button>
          <button
            onClick={() => downloadExport("pdf")}
            className="flex items-center gap-1 text-amber-600 hover:text-amber-800"
          >
            <FileText size={12} /> 中文 PDF
          </button>
          <button
            onClick={() =>
              updateTab(tab.id, {
                structResult: null,
                structTaskId: null,
                structProgress: 0,
                structMessage: "",
              })
            }
            className="text-slate-500 hover:text-slate-700"
          >
            重新翻译
          </button>
        </div>
        {fetchError && (
          <div className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-red-50 text-red-600 border-b shrink-0">
            <AlertCircle size={13} />
            {fetchError}
            <button
              onClick={() => setFetchError("")}
              className="ml-auto hover:text-red-800"
            >
              ✕
            </button>
          </div>
        )}
        <div className="flex-1 min-h-0 overflow-auto p-3 space-y-3">
          <div className="text-xs text-slate-400 sticky top-0 bg-white py-1 z-10">
            第 {currentPage} / {tab.structResult.page_count} 页（{pageBlocks.length}{" "}
            块）— 翻左侧 PDF 联动
          </div>
          {pageBlocks.length === 0 && (
            <div className="text-sm text-slate-400">本页无文本块</div>
          )}
          {pageBlocks.map((b) => (
            <div
              key={b.block_id}
              className="border border-slate-200 rounded p-2.5 space-y-1.5"
            >
              <div className="flex items-center gap-2">
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded ${
                    TYPE_COLOR[b.type] || TYPE_COLOR.body
                  }`}
                >
                  {TYPE_LABEL[b.type] || b.type}
                </span>
                <span className="text-[10px] text-slate-300">{b.block_id}</span>
              </div>
              <div className="text-xs text-slate-400 leading-relaxed whitespace-pre-wrap">
                {b.source_text}
              </div>
              <div className="text-sm text-slate-800 leading-relaxed whitespace-pre-wrap">
                {b.translated_text}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const running = tab?.structRunning ?? false;
  const progress = tab?.structProgress ?? 0;
  const message = tab?.structMessage ?? "";
  const error = tab?.structError ?? "";
  const hasPdf = !!tab?.pdfData;

  return (
    <div className="flex flex-col h-full p-4 gap-4">
      <div className="text-sm text-slate-600">
        结构化翻译：PyMuPDF 提取文本块 → 清洗去水印/页眉 → 按类型分类 →
        逐块 LLM 翻译（医学术语强约束）。适合 pdf2zh
        效果差的多栏/字体异常文献；可导出 Markdown 与重排中文 PDF。
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
        {running ? "翻译中..." : "开始结构化翻译"}
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
