// 划词翻译：监听 PDFViewer 派发的 pdf-selection 事件，调用后端翻译。
// 选中文本与译文存于当前标签页；loading 为组件本地态（仅活跃标签可见）。

import { useEffect, useState, useCallback, useRef } from "react";
import { Loader2, Languages } from "lucide-react";
import { translateText } from "@/services/api";
import { useStore, useActiveTab } from "@/store/useSettings";
import type { SelectionInfo } from "@/types";

export default function TextTranslate() {
  const tab = useActiveTab();
  const activeTabId = useStore((s) => s.activeTabId);

  const [loading, setLoading] = useState(false);
  // 保存进行中的请求控制器，新的划词到来时取消上一个，避免结果错位
  const abortRef = useRef<AbortController | null>(null);

  const doTranslate = useCallback(
    async (text: string, targetId: string, page: number) => {
      const s = useStore.getState();
      if (!s.hasSettings()) {
        s.updateTab(targetId, {
          lastTranslateError: "请先在「设置」中配置 API Key",
        });
        s.setSettingsOpen(true);
        return;
      }
      // 取消上一个未完成的请求
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      s.updateTab(targetId, {
        lastSelection: { text, page },
        lastTranslated: "",
        lastTranslateError: "",
      });
      setLoading(true);

      try {
        const res = await translateText(text, s.settings, "中文", controller.signal);
        // 若期间又发起了新请求，丢弃本次结果
        if (abortRef.current !== controller) return;
        useStore.getState().updateTab(targetId, { lastTranslated: res.translated });
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        if (abortRef.current !== controller) return;
        useStore.getState().updateTab(targetId, {
          lastTranslateError: e instanceof Error ? e.message : "翻译失败",
        });
      } finally {
        if (abortRef.current === controller) setLoading(false);
      }
    },
    []
  );

  // 切换标签时复位 loading（旧标签的请求仍在后台写入其自身状态）
  useEffect(() => {
    setLoading(false);
  }, [activeTabId]);

  // 监听划词事件
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as SelectionInfo;
      const s = useStore.getState();
      const current = s.tabs.find((t) => t.id === s.activeTabId);
      if (!current) return;
      // 立即展示选中
      s.updateTab(current.id, { lastSelection: detail });
      doTranslate(detail.text, current.id, detail.page);
    };
    window.addEventListener("pdf-selection", handler);
    return () => {
      window.removeEventListener("pdf-selection", handler);
      abortRef.current?.abort();
    };
  }, [doTranslate]);

  const selection = tab?.lastSelection ?? null;
  const translated = tab?.lastTranslated ?? "";
  const error = tab?.lastTranslateError ?? "";

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
            onClick={() =>
              selection && doTranslate(selection.text, tab!.id, selection.page)
            }
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
