// PDF.js 渲染器：负责渲染页面、翻页、缩放、滚动、文字选中。
// 页面容器会一次创建；canvas 位图进入预取区（视口 ±900px）才分配，
// 离开回收区（视口 ±3000px）即释放（保留占位 div），textLayer 同生命周期。

import { useEffect, useRef, useState, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import {
  ZoomIn,
  ZoomOut,
  AlertCircle,
  Loader2,
  Download,
  Search,
  Maximize2,
  MousePointer2,
  Hand,
  Highlighter,
  Underline,
  PenLine,
  StickyNote,
  Undo2,
  Redo2,
} from 'lucide-react';
import { savePdfFile } from '@/services/pdf';
import { useStore } from '@/store/useSettings';
import ToolBtn from './shared/ToolBtn';
import type { AnnotTool } from '@/types';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

interface Props {
  data: Uint8Array | string;
  side: 'left' | 'right';
  currentPage: number;
  onPageChange?: (p: number) => void;
  suggestedName?: string;
  /** 阅读器底部「高亮/下划线/批注/笔记」按钮点击时调用，打开批注器并预选工具 */
  onOpenAnnot?: (tool: AnnotTool) => void;
  /** 译文侧（side="right"）是否跟随原文 currentPage 翻页；默认 true。
   *  传 false 时译文 PDF 独立滚动，不跟随原文。 */
  syncPage?: boolean;
}

export default function PDFViewer({
  data,
  side,
  currentPage,
  onPageChange,
  suggestedName,
  onOpenAnnot,
  syncPage,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1.2);
  const [numPages, setNumPages] = useState(0);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);
  const pdfRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const pageElsRef = useRef<Map<number, HTMLDivElement>>(new Map());
  // 当前持有 canvas 位图的页（渲染时加入、回收时移除，非「曾渲染过」的记录）
  const renderedPagesRef = useRef<Set<number>>(new Set());
  // 页 → 在途渲染任务：回收/重建时 cancel，防止向已释放的位图继续写入
  const renderTasksRef = useRef<Map<number, pdfjsLib.RenderTask>>(new Map());
  // 页 → 纪元号：每次渲染/回收递增，令已越过回收点的在途异步流程失效
  const pageEpochRef = useRef<Map<number, number>>(new Map());
  const currentPageRef = useRef(currentPage);
  // 译文是否跟随原文翻页（ref 形式供 buildPages 读取，避免把它加进 build 依赖触发重建）
  const syncPageRef = useRef(syncPage !== false);
  // 搜索：缓存各页文本，避免重复抓取
  const pageTextRef = useRef<Map<number, string>>(new Map());
  // 手型工具拖拽平移
  const panRef = useRef<{ x: number; y: number } | null>(null);

  // 阅读器视图模式：select=可选文字（划词）/ hand=手型平移
  const [viewMode, setViewMode] = useState<'select' | 'hand'>('select');
  // 搜索
  const [searchQ, setSearchQ] = useState('');
  const [searchResult, setSearchResult] = useState<{ count: number; firstPage: number } | null>(
    null,
  );
  const [searching, setSearching] = useState(false);
  // 页码跳转输入
  const [pageInput, setPageInput] = useState(String(currentPage));

  const backendOnline = useStore((s) => s.backendStatus) === 'online';

  const setSelection = useSelectionReporter(side);

  useEffect(() => {
    currentPageRef.current = currentPage;
  }, [currentPage]);

  useEffect(() => {
    syncPageRef.current = syncPage !== false;
  }, [syncPage]);

  // 页码输入跟随当前页（滚动改变 currentPage 时同步，但不打断输入）
  useEffect(() => {
    setPageInput(String(currentPage));
  }, [currentPage]);

  useEffect(() => {
    let cancelled = false;
    setLoadError('');
    setLoading(true);
    setNumPages(0);
    const load = async () => {
      try {
        const src = typeof data === 'string' ? { url: data } : { data: data.slice(0) };
        const doc = await pdfjsLib.getDocument(src as any).promise;
        if (cancelled) {
          // 加载途中卸载：必须销毁，否则 pdf.js 文档 + worker 泄漏
          doc.destroy();
          return;
        }
        pdfRef.current = doc;
        setNumPages(doc.numPages);
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setLoading(false);
        const isUrl = typeof data === 'string';
        setLoadError(
          isUrl
            ? '无法加载翻译结果 PDF（后端可能已重启或文件已清理）'
            : `PDF 加载失败：${e instanceof Error ? e.message : '文件可能损坏或不是有效 PDF'}`,
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
    let renderObserver: IntersectionObserver | null = null;
    let evictObserver: IntersectionObserver | null = null;
    container.innerHTML = '';
    pageElsRef.current.clear();
    renderedPagesRef.current.clear();
    renderTasksRef.current.clear();
    pageEpochRef.current.clear();

    const bumpEpoch = (pageNumber: number) => {
      const epoch = (pageEpochRef.current.get(pageNumber) ?? 0) + 1;
      pageEpochRef.current.set(pageNumber, epoch);
      return epoch;
    };

    // 回收一页：释放位图与文本层，保留占位 div（布局与 scrollTop 不变）
    const evictPage = (pageNumber: number) => {
      bumpEpoch(pageNumber); // 令在途渲染（若有）越过下一个 alive() 检查即放弃
      renderTasksRef.current.get(pageNumber)?.cancel();
      renderTasksRef.current.delete(pageNumber);
      if (!renderedPagesRef.current.delete(pageNumber)) return;
      const pageDiv = pageElsRef.current.get(pageNumber);
      const canvas = pageDiv?.querySelector('canvas');
      if (canvas) {
        canvas.width = 0; // 宽高归零即释放位图后备存储
        canvas.height = 0;
      }
      pageDiv?.querySelector('.textLayer')?.replaceChildren();
      if (import.meta.env.DEV)
        console.debug(`[PDFViewer:${side}] 持有位图页数=${renderedPagesRef.current.size}`);
    };

    const renderPage = async (pageNumber: number, pageDiv: HTMLDivElement) => {
      if (renderedPagesRef.current.has(pageNumber)) return;
      renderedPagesRef.current.add(pageNumber);
      const epoch = bumpEpoch(pageNumber);
      const alive = () => !cancelled && pageEpochRef.current.get(pageNumber) === epoch;
      try {
        const page = await doc.getPage(pageNumber);
        if (!alive()) return;
        const viewport = page.getViewport({ scale });
        const canvas = pageDiv.querySelector('canvas');
        const textLayerDiv = pageDiv.querySelector<HTMLDivElement>('.textLayer');
        if (!canvas || !textLayerDiv) return;

        syncPageLayerSize(pageDiv, textLayerDiv, viewport);
        textLayerDiv.replaceChildren();

        // 位图延迟分配：创建时 canvas 无宽高不占显存，进入预取区才在此分配
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const task = page.render({ canvasContext: ctx, viewport });
        renderTasksRef.current.set(pageNumber, task);
        try {
          await task.promise;
        } finally {
          if (renderTasksRef.current.get(pageNumber) === task) {
            renderTasksRef.current.delete(pageNumber);
          }
        }
        if (!alive()) return;

        try {
          const textContent = await page.getTextContent();
          if (!alive()) return;
          const lib = pdfjsLib as any;
          if (typeof lib.TextLayer === 'function') {
            const textLayer = new lib.TextLayer({
              textContentSource: textContent,
              container: textLayerDiv,
              viewport,
            });
            await textLayer.render();
            if (!alive()) {
              textLayerDiv.replaceChildren(); // 回收发生在渲染途中：清掉迟到写入
              return;
            }
            appendEndOfContent(textLayerDiv);
          } else if (typeof lib.renderTextLayer === 'function') {
            await lib.renderTextLayer({
              textContentSource: textContent,
              container: textLayerDiv,
              viewport,
            }).promise;
            if (!alive()) {
              textLayerDiv.replaceChildren();
              return;
            }
            appendEndOfContent(textLayerDiv);
          }
        } catch {
          /* 文本层渲染失败不影响画面，仅无法选中该页 */
        }
      } catch (e) {
        if (cancelled) return;
        // 被回收/缩放重建取消属正常流程，不是错误
        if (e instanceof Error && e.name === 'RenderingCancelledException') return;
        setLoadError(`PDF 渲染失败：${e instanceof Error ? e.message : 'worker 可能未正确加载'}`);
      }
    };

    const buildPages = async () => {
      try {
        renderObserver = new IntersectionObserver(
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
          { root: container, rootMargin: '900px 0px' },
        );
        // 回收观察器：离开 ±3000px 窗口即回收位图；
        // 与渲染区（±900px）之间 2100px 滞回带避免边界抖动
        evictObserver = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (entry.isIntersecting) continue;
              const pageDiv = entry.target as HTMLDivElement;
              const pageNumber = Number(pageDiv.dataset.page);
              if (Number.isFinite(pageNumber)) evictPage(pageNumber);
            }
          },
          { root: container, rootMargin: '3000px 0px' },
        );

        for (let i = 1; i <= doc.numPages; i++) {
          if (cancelled) return;
          const page = await doc.getPage(i);
          const viewport = page.getViewport({ scale });

          const pageDiv = document.createElement('div');
          pageDiv.className = 'relative mx-auto my-3 shadow bg-white';
          pageDiv.style.width = `${viewport.width}px`;
          pageDiv.style.height = `${viewport.height}px`;
          pageDiv.style.setProperty('--scale-factor', String(viewport.scale));
          pageDiv.dataset.page = String(i);

          // 只给样式尺寸、不设 width/height 属性：0×0 canvas 不分配位图，
          // 分配推迟到进入预取区（见 renderPage），否则每页先占 ~2.9MB
          const canvas = document.createElement('canvas');
          canvas.style.width = `${viewport.width}px`;
          canvas.style.height = `${viewport.height}px`;
          pageDiv.appendChild(canvas);

          const textLayerDiv = document.createElement('div');
          textLayerDiv.className = 'textLayer';
          syncPageLayerSize(pageDiv, textLayerDiv, viewport);
          pageDiv.appendChild(textLayerDiv);

          container.appendChild(pageDiv);
          pageElsRef.current.set(i, pageDiv);
          renderObserver.observe(pageDiv);
          evictObserver.observe(pageDiv);
        }

        if (side === 'right' && syncPageRef.current) {
          requestAnimationFrame(() => {
            const el = pageElsRef.current.get(currentPageRef.current);
            if (el) container.scrollTo({ top: el.offsetTop - 12, behavior: 'auto' });
          });
        }
      } catch (e) {
        if (!cancelled) {
          setLoadError(`PDF 渲染失败：${e instanceof Error ? e.message : 'worker 可能未正确加载'}`);
        }
      }
    };

    void buildPages();
    const tasks = renderTasksRef.current; // 局部别名供清理使用（ref 值在清理期可能已变）
    const epochs = pageEpochRef.current;
    return () => {
      cancelled = true;
      renderObserver?.disconnect();
      evictObserver?.disconnect();
      tasks.forEach((task) => task.cancel());
      tasks.clear();
      epochs.clear();
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
    if (side !== 'right') return;
    if (syncPage === false) return; // 关闭跟随：译文独立翻页
    const el = pageElsRef.current.get(currentPage);
    const container = containerRef.current;
    if (el && container) {
      container.scrollTo({ top: el.offsetTop - 12, behavior: 'smooth' });
    }
  }, [currentPage, side, numPages, syncPage]);

  const onMouseUp = useCallback(() => {
    if (side !== 'left') return;
    if (viewMode !== 'select') return; // 手型模式不上报选中
    const sel = window.getSelection();
    const text = sel?.toString().trim();
    if (!text || !sel) return;
    setSelection(text, pageFromSelection(sel) ?? currentPage);
  }, [side, currentPage, setSelection, viewMode]);

  // 跳转到指定页（页码输入 / 搜索结果）
  const jumpToPage = useCallback(
    (p: number) => {
      const n = Math.max(1, Math.min(numPages || 1, p));
      const el = pageElsRef.current.get(n);
      const container = containerRef.current;
      if (el && container) {
        container.scrollTo({ top: el.offsetTop - 12, behavior: 'smooth' });
      }
      onPageChange?.(n);
    },
    [numPages, onPageChange],
  );

  // 适合宽度：按容器宽与第 1 页原始宽计算缩放
  const fitWidth = useCallback(async () => {
    const doc = pdfRef.current;
    const container = containerRef.current;
    if (!doc || !container) return;
    try {
      const page = await doc.getPage(1);
      const vp1 = page.getViewport({ scale: 1 });
      const avail = container.clientWidth - 16; // 留出 padding
      if (vp1.width > 0) {
        setScale(Math.max(0.5, Math.min(3, avail / vp1.width)));
      }
    } catch {
      /* ignore */
    }
  }, []);

  // 搜索：遍历各页文本（缓存），统计匹配数并跳到首个匹配页
  const runSearch = useCallback(async () => {
    const q = searchQ.trim();
    if (!q) {
      setSearchResult(null);
      return;
    }
    const doc = pdfRef.current;
    if (!doc) return;
    setSearching(true);
    const ql = q.toLowerCase();
    let count = 0;
    let firstPage = 0;
    try {
      for (let i = 1; i <= doc.numPages; i++) {
        let text = pageTextRef.current.get(i);
        if (text === undefined) {
          try {
            const page = await doc.getPage(i);
            const tc = await page.getTextContent();
            text = (tc.items as any[])
              .map((it) => (typeof it.str === 'string' ? it.str : ''))
              .join(' ');
          } catch {
            text = '';
          }
          pageTextRef.current.set(i, text);
        }
        const lower = text.toLowerCase();
        let idx = 0;
        while ((idx = lower.indexOf(ql, idx)) !== -1) {
          count++;
          if (!firstPage) firstPage = i;
          idx += ql.length;
        }
      }
      setSearchResult({ count, firstPage });
      if (firstPage) jumpToPage(firstPage);
    } finally {
      setSearching(false);
    }
  }, [searchQ, jumpToPage]);

  // 手型工具：按下拖动平移
  const onPanDown = useCallback(
    (e: React.PointerEvent) => {
      if (viewMode !== 'hand') return;
      panRef.current = { x: e.clientX, y: e.clientY };
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    },
    [viewMode],
  );
  const onPanMove = useCallback((e: React.PointerEvent) => {
    if (!panRef.current) return;
    const dx = e.clientX - panRef.current.x;
    const dy = e.clientY - panRef.current.y;
    panRef.current = { x: e.clientX, y: e.clientY };
    containerRef.current?.scrollBy(-dx, -dy);
  }, []);
  const onPanUp = useCallback(() => {
    panRef.current = null;
  }, []);

  // 导出当前 PDF：源 PDF（Uint8Array）直接存；译文 PDF（URL）先 fetch 再存
  const handleExport = useCallback(async () => {
    try {
      let bytes: Uint8Array;
      const name = suggestedName || 'document.pdf';
      if (typeof data === 'string') {
        const resp = await fetch(data);
        if (!resp.ok) throw new Error('获取 PDF 失败');
        bytes = new Uint8Array(await resp.arrayBuffer());
      } else {
        bytes = data;
      }
      await savePdfFile(bytes, name);
    } catch (e) {
      console.error('导出失败:', e);
    }
  }, [data, suggestedName]);

  return (
    <div className="flex flex-col h-full">
      {/* 顶部工具栏：页码 / 缩放 / 适合宽度 / 搜索 / 导出 */}
      <div className="flex items-center gap-1.5 px-3 h-10 bg-white border-b text-sm shrink-0 overflow-x-auto whitespace-nowrap">
        <input
          value={pageInput}
          onChange={(e) => setPageInput(e.target.value.replace(/[^\d]/g, ''))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') jumpToPage(Number(pageInput) || 1);
          }}
          onBlur={() => jumpToPage(Number(pageInput) || 1)}
          className="w-10 px-1 py-0.5 text-center border border-slate-200 rounded text-xs"
          title="跳转到页码（回车）"
        />
        <span className="text-slate-400 text-xs">/ {numPages || '-'}</span>

        <span className="w-px h-5 bg-slate-200 mx-1" />
        <button
          onClick={() => setScale((s) => Math.max(0.5, s - 0.15))}
          className="p-1 hover:bg-slate-100 rounded"
          title="缩小"
        >
          <ZoomOut size={16} />
        </button>
        <span className="w-12 text-center text-xs">{Math.round(scale * 100)}%</span>
        <button
          onClick={() => setScale((s) => Math.min(3, s + 0.15))}
          className="p-1 hover:bg-slate-100 rounded"
          title="放大"
        >
          <ZoomIn size={16} />
        </button>
        <button onClick={fitWidth} className="p-1 hover:bg-slate-100 rounded" title="适合宽度">
          <Maximize2 size={15} />
        </button>

        <span className="w-px h-5 bg-slate-200 mx-1" />
        <input
          value={searchQ}
          onChange={(e) => setSearchQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') runSearch();
          }}
          placeholder="搜索"
          className="w-24 px-2 py-0.5 border border-slate-200 rounded text-xs"
        />
        <button
          onClick={runSearch}
          disabled={searching}
          className="p-1 hover:bg-slate-100 rounded disabled:opacity-50"
          title="搜索"
        >
          {searching ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
        </button>
        {searchResult && (
          <span className="text-xs text-slate-400 whitespace-nowrap">
            {searchResult.count > 0 ? `${searchResult.count} 处` : '无结果'}
          </span>
        )}

        <button
          onClick={handleExport}
          className="ml-auto flex items-center gap-1 px-2 py-1 text-slate-600 hover:bg-slate-100 rounded"
          title="导出 PDF"
        >
          <Download size={15} />
          导出
        </button>
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
          onPointerDown={onPanDown}
          onPointerMove={onPanMove}
          onPointerUp={onPanUp}
          className={`h-full overflow-auto bg-slate-200 px-2 ${
            viewMode === 'hand' ? 'cursor-grab mode-hand active:cursor-grabbing' : ''
          }`}
        />
      </div>

      {/* 底部工具栏：选择 / 手型 / 高亮 / 下划线 / 批注 / 笔记 / 撤销 / 重做（仅阅读侧） */}
      {side === 'left' && onOpenAnnot && (
        <div className="flex items-center gap-0.5 px-2 h-9 bg-white border-t text-slate-600 shrink-0 overflow-x-auto whitespace-nowrap">
          <ToolBtn
            active={viewMode === 'select'}
            onClick={() => setViewMode('select')}
            icon={<MousePointer2 size={16} />}
            label="选择"
          />
          <ToolBtn
            active={viewMode === 'hand'}
            onClick={() => setViewMode('hand')}
            icon={<Hand size={16} />}
            label="手型"
          />
          <span className="w-px h-5 bg-slate-200 mx-1" />
          <ToolBtn
            onClick={() => onOpenAnnot('highlight')}
            icon={<Highlighter size={16} />}
            label="高亮"
            disabled={!backendOnline}
          />
          <ToolBtn
            onClick={() => onOpenAnnot('underline')}
            icon={<Underline size={16} />}
            label="下划线"
            disabled={!backendOnline}
          />
          <ToolBtn
            onClick={() => onOpenAnnot('select')}
            icon={<PenLine size={16} />}
            label="批注"
            disabled={!backendOnline}
          />
          <ToolBtn
            onClick={() => onOpenAnnot('note')}
            icon={<StickyNote size={16} />}
            label="笔记"
            disabled={!backendOnline}
          />
          <span className="w-px h-5 bg-slate-200 mx-1" />
          <ToolBtn icon={<Undo2 size={16} />} label="撤销" disabled title="在批注模式中可用" />
          <ToolBtn icon={<Redo2 size={16} />} label="重做" disabled title="在批注模式中可用" />
        </div>
      )}
    </div>
  );
}

function syncPageLayerSize(
  pageDiv: HTMLDivElement,
  textLayerDiv: HTMLDivElement,
  viewport: pdfjsLib.PageViewport,
) {
  const width = `${viewport.width}px`;
  const height = `${viewport.height}px`;
  pageDiv.style.width = width;
  pageDiv.style.height = height;
  pageDiv.style.setProperty('--scale-factor', String(viewport.scale));
  textLayerDiv.style.width = width;
  textLayerDiv.style.height = height;
  textLayerDiv.style.setProperty('--scale-factor', String(viewport.scale));
}

function appendEndOfContent(textLayerDiv: HTMLDivElement) {
  if (textLayerDiv.querySelector('.endOfContent')) return;
  const end = document.createElement('div');
  end.className = 'endOfContent';
  textLayerDiv.appendChild(end);
}
function pageFromSelection(sel: Selection): number | null {
  const node = sel.anchorNode;
  const element = node instanceof Element ? node : node?.parentElement;
  const pageEl = element?.closest<HTMLElement>('[data-page]');
  const page = Number(pageEl?.dataset.page);
  return Number.isFinite(page) && page > 0 ? page : null;
}

function useSelectionReporter(side: 'left' | 'right') {
  return useCallback(
    (text: string, page: number) => {
      if (side !== 'left') return;
      window.dispatchEvent(new CustomEvent('pdf-selection', { detail: { text, page } }));
    },
    [side],
  );
}
