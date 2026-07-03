// PDF.js 渲染器：负责渲染页面、翻页、缩放、滚动、文字选中。
// 通过 side="left" 的实例上报选中文本与当前页码，实现左右同步。

import { useEffect, useRef, useState, useCallback } from "react";
import * as pdfjsLib from "pdfjs-dist";
import { ZoomIn, ZoomOut, AlertCircle, Loader2 } from "lucide-react";

// 配置 worker（Vite 方式）
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

interface Props {
  data: Uint8Array | string; // 字节或 URL
  side: "left" | "right";
  currentPage: number; // 当前页码（左侧用于上报，右侧用于同步滚动）
  onPageChange?: (p: number) => void; // 左侧滚动时回调
}

export default function PDFViewer({ data, side, currentPage, onPageChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1.2);
  const [numPages, setNumPages] = useState(0);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const pdfRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const pageElsRef = useRef<Map<number, HTMLDivElement>>(new Map());

  const setSelection = useSelectionReporter(side);

  // 加载文档
  useEffect(() => {
    let cancelled = false;
    setLoadError("");
    setLoading(true);
    setNumPages(0);
    const load = async () => {
      try {
        const src =
          typeof data === "string" ? { url: data } : { data: data.slice(0) };
        const doc = await pdfjsLib.getDocument(src as any).promise;
        if (cancelled) return;
        pdfRef.current = doc;
        setNumPages(doc.numPages);
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setLoading(false);
        // 区分「结果 URL 拉不到」和「PDF 本身损坏 / worker 挂了」
        const isUrl = typeof data === "string";
        setLoadError(
          isUrl
            ? "无法加载翻译结果 PDF（后端可能已重启或文件已清理）"
            : `PDF 加载失败：${
                e instanceof Error ? e.message : "文件可能损坏或不是有效 PDF"
              }`
        );
      }
    };
    load();
    return () => {
      cancelled = true;
      pdfRef.current?.destroy();
      pdfRef.current = null;
    };
  }, [data]);

  // 渲染所有页面
  useEffect(() => {
    const doc = pdfRef.current;
    const container = containerRef.current;
    if (!doc || !container) return;
    let cancelled = false;

    const render = async () => {
      try {
        container.innerHTML = "";
        pageElsRef.current.clear();
        for (let i = 1; i <= doc.numPages; i++) {
          if (cancelled) return;
          const page = await doc.getPage(i);
          const viewport = page.getViewport({ scale });

          const pageDiv = document.createElement("div");
          pageDiv.className = "relative mx-auto my-3 shadow bg-white";
          pageDiv.style.width = `${viewport.width}px`;
          pageDiv.style.height = `${viewport.height}px`;
          pageDiv.dataset.page = String(i);

          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const ctx = canvas.getContext("2d")!;
          pageDiv.appendChild(canvas);

          // 文本层，用于选中
          const textLayerDiv = document.createElement("div");
          textLayerDiv.className = "textLayer";
          pageDiv.appendChild(textLayerDiv);

          container.appendChild(pageDiv);
          pageElsRef.current.set(i, pageDiv);

          await page.render({ canvasContext: ctx, viewport }).promise;

          // 渲染文本层（用于文字选中）。
          // pdfjs v4 不同小版本 API 不同：优先 TextLayer 类，回退 renderTextLayer 函数。
          try {
            const textContent = await page.getTextContent();
            const lib = pdfjsLib as any;
            if (typeof lib.TextLayer === "function") {
              const textLayer = new lib.TextLayer({
                textContentSource: textContent,
                container: textLayerDiv,
                viewport,
              });
              await textLayer.render();
            } else if (typeof lib.renderTextLayer === "function") {
              await lib.renderTextLayer({
                textContentSource: textContent,
                container: textLayerDiv,
                viewport,
              }).promise;
            }
          } catch {
            /* 文本层渲染失败不影响画面，仅无法选中该页 */
          }
        }
      } catch (e) {
        if (!cancelled) {
          setLoadError(
            `PDF 渲染失败：${
              e instanceof Error ? e.message : "worker 可能未正确加载"
            }`
          );
        }
      }
    };
    render();
    return () => {
      cancelled = true;
    };
  }, [scale, numPages]);

  // 滚动时上报当前页；右侧监听 store.currentPage 做同步
  const onScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const mid = container.scrollTop + container.clientHeight / 2;
    let best = 1;
    let bestDist = Infinity;
    pageElsRef.current.forEach((el, page) => {
      const center = el.offsetTop + el.offsetHeight / 2;
      const dist = Math.abs(center - mid);
      if (dist < bestDist) {
        bestDist = dist;
        best = page;
      }
    });
    if (onPageChange) onPageChange(best);
  }, [onPageChange]);

  // 右侧根据 currentPage 同步滚动
  useEffect(() => {
    if (side !== "right") return;
    const el = pageElsRef.current.get(currentPage);
    const container = containerRef.current;
    if (el && container) {
      container.scrollTo({ top: el.offsetTop - 12, behavior: "smooth" });
    }
  }, [currentPage, side, numPages]);

  // 文字选中上报
  const onMouseUp = useCallback(() => {
    if (side !== "left") return;
    const sel = window.getSelection();
    const text = sel?.toString().trim();
    if (text) setSelection(text, currentPage);
  }, [side, currentPage, setSelection]);

  return (
    <div className="flex flex-col h-full">
      {/* 工具条 */}
      <div className="flex items-center gap-2 px-3 h-9 bg-white border-b text-sm shrink-0">
        <button
          onClick={() => setScale((s) => Math.max(0.5, s - 0.15))}
          className="p-1 hover:bg-slate-100 rounded"
          title="缩小"
        >
          <ZoomOut size={16} />
        </button>
        <span className="w-12 text-center">{Math.round(scale * 100)}%</span>
        <button
          onClick={() => setScale((s) => Math.min(3, s + 0.15))}
          className="p-1 hover:bg-slate-100 rounded"
          title="放大"
        >
          <ZoomIn size={16} />
        </button>
        <span className="ml-auto text-slate-500">
          {numPages > 0 && `第 ${currentPage} / ${numPages} 页`}
        </span>
      </div>

      {/* 页面滚动区 */}
      <div className="flex-1 relative overflow-hidden">
        {loadError && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-slate-100 text-center p-6">
            <AlertCircle size={40} className="text-red-400" strokeWidth={1.5} />
            <p className="text-sm text-red-600 max-w-sm">{loadError}</p>
          </div>
        )}
        {loading && !loadError && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-slate-100 text-slate-400">
            <Loader2 className="animate-spin" size={28} />
            <p className="text-sm">加载 PDF 中...</p>
          </div>
        )}
        <div
          ref={containerRef}
          onScroll={onScroll}
          onMouseUp={onMouseUp}
          className="h-full overflow-auto bg-slate-200 px-2"
        />
      </div>
    </div>
  );
}

// 把选中文本写进一个自定义事件总线，供 TextTranslate 消费
function useSelectionReporter(side: "left" | "right") {
  return useCallback(
    (text: string, page: number) => {
      if (side !== "left") return;
      window.dispatchEvent(
        new CustomEvent("pdf-selection", { detail: { text, page } })
      );
    },
    [side]
  );
}
