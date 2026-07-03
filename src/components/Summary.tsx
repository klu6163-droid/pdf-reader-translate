// 文献总结：提取全文 → 流式生成结构化中文总结。
// 状态存于当前标签页；切换标签时流不会中断（onDelta 写入所属标签）。
// 用轻量的 Markdown 渲染（仅处理 ## 标题与段落），避免额外依赖。

import { useCallback } from "react";
import { Loader2, Sparkles, AlertCircle } from "lucide-react";
import { streamSummary, bytesToPdfBlob } from "@/services/api";
import { useStore, useActiveTab } from "@/store/useSettings";

export default function Summary() {
  const tab = useActiveTab();

  const start = useCallback(async () => {
    const s = useStore.getState();
    const current = s.tabs.find((t) => t.id === s.activeTabId);
    if (!current) return;
    const targetId = current.id; // 捕获，避免异步期间切换标签写错对象

    if (!current.pdfData) {
      s.updateTab(targetId, { summaryError: "请先打开一个 PDF" });
      return;
    }
    if (!s.hasSettings()) {
      s.updateTab(targetId, { summaryError: "请先在「设置」中配置 API Key" });
      s.setSettingsOpen(true);
      return;
    }

    s.updateTab(targetId, {
      summaryRunning: true,
      summaryError: "",
      summaryContent: "",
    });

    const blob = bytesToPdfBlob(current.pdfData);
    await streamSummary(
      blob,
      current.name,
      s.settings,
      // 增量写入「拥有该任务的标签」——即便用户已切到别的标签，
      // 流仍在后台累积到原标签的 summaryContent。
      (delta) => useStore.getState().appendSummary(targetId, delta),
      () => useStore.getState().updateTab(targetId, { summaryRunning: false }),
      (err) =>
        useStore.getState().updateTab(targetId, {
          summaryRunning: false,
          summaryError: err,
        })
    );
  }, []);

  const running = tab?.summaryRunning ?? false;
  const content = tab?.summaryContent ?? "";
  const error = tab?.summaryError ?? "";
  const hasPdf = !!tab?.pdfData;

  return (
    <div className="flex flex-col h-full p-4 gap-3">
      <button
        onClick={start}
        disabled={running || !hasPdf}
        className="flex items-center justify-center gap-2 px-4 py-2.5 bg-primary-600 text-white rounded hover:bg-primary-700 disabled:opacity-50 shrink-0"
      >
        {running ? (
          <Loader2 className="animate-spin" size={18} />
        ) : (
          <Sparkles size={18} />
        )}
        {running ? "生成中..." : "生成结构化总结"}
      </button>

      {error && (
        <div className="flex items-start gap-2 p-3 text-sm bg-red-50 text-red-600 rounded shrink-0">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {!content && !running && !error && (
        <div className="flex flex-col items-center justify-center flex-1 text-slate-400 gap-2">
          <Sparkles size={40} strokeWidth={1} />
          <p className="text-sm text-center">
            提取 PDF 全文并生成中文总结
            <br />
            （研究问题 / 方法 / 贡献 / 实验 / 结论 / 局限性 / 摘要）
          </p>
        </div>
      )}

      {(content || running) && (
        <div className="flex-1 overflow-auto summary-md text-sm text-slate-800">
          <MarkdownLite text={content} />
          {running && (
            <span className="inline-block w-2 h-4 bg-primary-500 animate-pulse ml-0.5 align-middle" />
          )}
        </div>
      )}

      {!hasPdf && !running && (
        <div className="text-sm text-slate-400 text-center mt-4">
          请先在左侧打开一个 PDF
        </div>
      )}
    </div>
  );
}

// 极简 Markdown：处理 ## 标题、- 列表、空行段落，够 MVP 用
function MarkdownLite({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <>
      {lines.map((line, i) => {
        const t = line.trim();
        if (t.startsWith("## ")) {
          return <h2 key={i}>{t.slice(3)}</h2>;
        }
        if (t.startsWith("# ")) {
          return <h2 key={i}>{t.slice(2)}</h2>;
        }
        if (t.startsWith("- ") || t.startsWith("* ")) {
          return (
            <p key={i} className="pl-4">
              • {t.slice(2)}
            </p>
          );
        }
        if (!t) return <div key={i} className="h-2" />;
        return <p key={i}>{line}</p>;
      })}
    </>
  );
}
