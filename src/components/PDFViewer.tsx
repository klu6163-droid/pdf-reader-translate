// PDF.js 渲染器：负责渲染页面、翻页、缩放、滚动、文字选中。
// 页面容器会一次创建，实际 canvas/textLayer 只在视口附近懒渲染。

import { useEffect, useRef, useState, useCallback } from "react";
import * as pdfjsLib from "pdfjs-dist";
import { ZoomIn, ZoomOut, AlertCircle, Loader2, Download } from "lucide-react";
import { savePdfFile } from "@/services/pdf";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

interface Props {
  data: Uint8Array | string;
  side: "left" | "right";
  currentPage: number;
  onPageChange?: (p: number) => void;
  suggestedName?: string;
}

export default function PDFViewer({ data, side, currentPage, onPageChange, suggestedName }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1.2);
  const [numPages, setNumPages] = useState(0);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const pdfRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const pageElsRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const renderedPagesRef = useRef<Set<number>>(new Set());
  const currentPageRef = useRef(currentPage);

  const setSelection = useSelectionReporter(side);

  useEffect(() => {
    currentPageRef.current = currentPage;
  }, [currentPage]);

  useEffect(() => {
    let cancelled = false;
    setLoadError("");
    setLoading(true);
    setNumPages(0);
    const load = async () => {
      try {
        const src = typeof data === "string" ? { url: data } : { data: data.slice(0) };
        const doc = await pdfjsLib.getDocument(src as any).promise;
        if (cancelled) return;
        pdfRef.current = doc;
        setNumPages(doc.numPages);
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setLoading(false);
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

  useEffect(() => {
    const doc = pdfRef.current;
    const container = containerRef.current;
    if (!doc || !container) return;

    let cancelled = false;
    let observer: IntersectionObserver | null = null;
    container.innerHTML = "";
    pageElsRef.current.clear();
    renderedPagesRef.current.clear();

    const renderPage = async (pageNumber: number, pageDiv: HTMLDivElement) => {
      if (renderedPagesRef.current.has(pageNumber)) return;
      renderedPagesRef.current.add(pageNumber);
      try {
        const page = await doc.getPage(pageNumber);
        if (cancelled) return;
        const viewport = page.getViewport({ scale });
        const canvas = pageDiv.querySelector("canvas");
        const textLayerDiv = pageDiv.querySelector<HTMLDivElement>(".textLayer");
        if (!canvas || !textLayerDiv) return;

        syncPageLayerSize(pageDiv, textLayerDiv, viewport);
        textLayerDiv.replaceChildren();

        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        await page.render({ canvasContext: ctx, viewport }).promise;
        if (cancelled) return;

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
            appendEndOfContent(textLayerDiv);
          } else if (typeof lib.renderTextLayer === "function") {
            await lib.renderTextLayer({
              textContentSource: textContent,
              container: textLayerDiv,
              viewport,
            }).promise;
            appendEndOfContent(textLayerDiv);
          }
        } catch {
          /* 文本层渲染失败不影响画面，仅无法选中该页 */
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

    const buildPages = async () => {
      try {
        observer = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              const pageDiv = entry.target as HTMLDivElement;
              const pageNumber = Number(pageDiv.dataset.page);
              if (Number.isFinite(pageNumber)) {
                void renderPage(pageNumber, pageDiv);
              }
            }
          },
          { root: container, rootMargin: "900px 0px" }
        );

        for (let i = 1; i <= doc.numPages; i++) {
          if (cancelled) return;
          const page = await doc.getPage(i);
          const viewport = page.getViewport({ scale });

          const pageDiv = document.createElement("div");
          pageDiv.className = "relative mx-auto my-3 shadow bg-white";
          pageDiv.style.width = `${viewport.width}px`;
          pageDiv.style.height = `${viewport.height}px`;
          pageDiv.style.setProperty("--scale-factor", String(viewport.scale));
          pageDiv.dataset.page = String(i);

          const canvas = document.createElement("canvas");
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          canvas.style.width = `${viewport.width}px`;
          canvas.style.height = `${viewport.height}px`;
          pageDiv.appendChild(canvas);

          const textLayerDiv = document.createElement("div");
          textLayerDiv.className = "textLayer";
          syncPageLayerSize(pageDiv, textLayerDiv, viewport);
          pageDiv.appendChild(textLayerDiv);

          container.appendChild(pageDiv);
          pageElsRef.current.set(i, pageDiv);
          observer.observe(pageDiv);
        }

        if (side === "right") {
          requestAnimationFrame(() => {
            const el = pageElsRef.current.get(currentPageRef.current);
            if (el) container.scrollTo({ top: el.offsetTop - 12, behavior: "auto" });
          });
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

    void buildPages();
    return () => {
      cancelled = true;
      observer?.disconnect();
    };
  }, [scale, numPages, side]);

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

  useEffect(() => {
    if (side !== "right") return;
    const el = pageElsRef.current.get(currentPage);
    const container = containerRef.current;
    if (el && container) {
      container.scrollTo({ top: el.offsetTop - 12, behavior: "smooth" });
    }
  }, [currentPage, side, numPages]);

  const onMouseUp = useCallback(() => {
    if (side !== "left") return;
    const sel = window.getSelection();
    const text = sel?.toString().trim();
    if (!text || !sel) return;
    setSelection(text, pageFromSelection(sel) ?? currentPage);
  }, [side, currentPage, setSelection]);

  // 导出当前 PDF：源 PDF（Uint8Array）直接存；译文 PDF（URL）先 fetch 再存
  const handleExport = useCallback(async () => {
    try {
      let bytes: Uint8Array;
      const name = suggestedName || "document.pdf";
      if (typeof data === "string") {
        const resp = await fetch(data);
        if (!resp.ok) throw new Error("获取 PDF 失败");
        bytes = new Uint8Array(await resp.arrayBuffer());
      } else {
        bytes = data;
      }
      await savePdfFile(bytes, name);
    } catch (e) {
      console.error("导出失败:", e);
    }
  }, [data, suggestedName]);

  return (
    <div className="flex flex-col h-full">
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
        <button
          onClick={handleExport}
          className="ml-auto flex items-center gap-1 px-2 py-1 text-slate-600 hover:bg-slate-100 rounded"
          title="导出 PDF"
        >
          <Download size={15} />
          导出
        </button>
        <span className="text-slate-500">
          {numPages > 0 && `第 ${currentPage} / ${numPages} 页`}
        </span>
      </div>

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

function syncPageLayerSize(
  pageDiv: HTMLDivElement,
  textLayerDiv: HTMLDivElement,
  viewport: pdfjsLib.PageViewport
) {
  const width = `${viewport.width}px`;
  const height = `${viewport.height}px`;
  pageDiv.style.width = width;
  pageDiv.style.height = height;
  pageDiv.style.setProperty("--scale-factor", String(viewport.scale));
  textLayerDiv.style.width = width;
  textLayerDiv.style.height = height;
  textLayerDiv.style.setProperty("--scale-factor", String(viewport.scale));
}

function appendEndOfContent(textLayerDiv: HTMLDivElement) {
  if (textLayerDiv.querySelector(".endOfContent")) return;
  const end = document.createElement("div");
  end.className = "endOfContent";
  textLayerDiv.appendChild(end);
}
function pageFromSelection(sel: Selection): number | null {
  const node = sel.anchorNode;
  const element = node instanceof Element ? node : node?.parentElement;
  const pageEl = element?.closest<HTMLElement>("[data-page]");
  const page = Number(pageEl?.dataset.page);
  return Number.isFinite(page) && page > 0 ? page : null;
}

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
