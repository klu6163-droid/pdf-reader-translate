// 划词翻译：监听 PDFViewer 派发的 pdf-selection 事件，调用后端翻译。

import { useEffect, useState, useCallback, useRef } from "react";
import { Loader2, Languages } from "lucide-react";
import { translateText } from "@/services/api";
import { useStore } from "@/store/useSettings";
import type { SelectionInfo } from "@/types";

export default function TextTranslate() {
  const { settings, hasSettings, setSettingsOpen } = useStore();
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [translated, setTranslated] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // 保存进行中的请求控制器，新的划词到来时取消上一个，避免结果错位
  const abortRef = useRef<AbortController | null>(null);

  const doTranslate = useCallback(
    async (text: string) => {
      if (!hasSettings()) {
        setError("请先在「设置」中配置 API Key");
        setSettingsOpen(true);
        return;
      }
      // 取消上一个未完成的请求
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      setError("");
      setTranslated("");
      try {
        const res = await translateText(text, settings, "中文", controller.signal);
        // 若期间又发起了新请求，丢弃本次结果
        if (abortRef.current !== controller) return;
        setTranslated(res.translated);
      } catch (e) {
        // 主动取消不算错误
        if (e instanceof DOMException && e.name === "AbortError") return;
        if (abortRef.current !== controller) return;
        setError(e instanceof Error ? e.message : "翻译失败");
      } finally {
        if (abortRef.current === controller) setLoading(false);
      }
    },
    [settings, hasSettings, setSettingsOpen]
  );

  // 监听划词事件
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as SelectionInfo;
      setSelection(detail);
      doTranslate(detail.text);
    };
    window.addEventListener("pdf-selection", handler);
    return () => {
      window.removeEventListener("pdf-selection", handler);
      abortRef.current?.abort();
    };
  }, [doTranslate]);

  return (
    <div className="flex flex-col h-full p-4 gap-3 overflow-auto">
      {!selection && (
        <div className="flex flex-col items-center justify-center h-full text-slate-400 gap-2">
          <Languages size={40} strokeWidth={1} />
          <p className="text-sm">在左侧 PDF 中选中文字，即可翻译</p>
        </div>
      )}

      {selection && (
        <>
          <section>
            <h3 className="text-xs font-medium text-slate-400 mb-1">
              原文（第 {selection.page} 页）
            </h3>
            <div className="p-3 bg-slate-50 rounded text-sm text-slate-700 whitespace-pre-wrap max-h-40 overflow-auto">
              {selection.text}
            </div>
          </section>

          <section className="flex-1">
            <h3 className="text-xs font-medium text-slate-400 mb-1">中文翻译</h3>
            <div className="p-3 bg-primary-50 rounded text-sm text-slate-800 whitespace-pre-wrap min-h-[3rem]">
              {loading && (
                <span className="flex items-center gap-2 text-slate-400">
                  <Loader2 className="animate-spin" size={16} /> 翻译中...
                </span>
              )}
              {error && <span className="text-red-500">{error}</span>}
              {!loading && !error && translated}
            </div>
          </section>

          <button
            onClick={() => selection && doTranslate(selection.text)}
            disabled={loading}
            className="self-start px-3 py-1.5 text-sm bg-primary-600 text-white rounded hover:bg-primary-700 disabled:opacity-50"
          >
            重新翻译
          </button>
        </>
      )}
    </div>
  );
}
