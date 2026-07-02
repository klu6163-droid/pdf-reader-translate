// 文献总结：提取全文 → 流式生成结构化中文总结。
// 用轻量的 Markdown 渲染（仅处理 ## 标题与段落），避免额外依赖。

import { useState, useCallback } from "react";
import { Loader2, Sparkles, AlertCircle } from "lucide-react";
import { streamSummary, bytesToPdfBlob } from "@/services/api";
import { useStore } from "@/store/useSettings";

export default function Summary() {
  const { pdfData, pdfName, settings, hasSettings, setSettingsOpen } =
    useStore();
  const [running, setRunning] = useState(false);
  const [content, setContent] = useState("");
  const [error, setError] = useState("");

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
    setContent("");

    const blob = bytesToPdfBlob(pdfData);
    await streamSummary(
      blob,
      pdfName,
      settings,
      (delta) => setContent((c) => c + delta),
      () => setRunning(false),
      (err) => {
        setError(err);
        setRunning(false);
      }
    );
  }, [pdfData, pdfName, settings, hasSettings, setSettingsOpen]);

  return (
    <div className="flex flex-col h-full p-4 gap-3">
      <button
        onClick={start}
        disabled={running || !pdfData}
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
