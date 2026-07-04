// PDF 批注器（全屏浮层，独立封装，不影响阅读/翻译/总结/编辑）。
//
// 渲染：pdf.js 懒渲染每页 canvas（annotationMode=DISABLE 关掉内置批注绘制，
//       所有批注统一由覆盖层呈现）+ .textLayer 文本层（支持划选文字）。
// 批注：高亮/下划线/删除线（划选文字）、便签/矩形/画笔（画布交互）；
//       颜色可选；点选批注可改注释/改色/删除；右侧批注列表可跳转。
// 保存：后端 PyMuPDF 把批注写成标准 PDF annotation，另存新文件，原 PDF 不动。
// 权威：前端 state 是唯一权威，保存时推送完整列表；期间的增删改仅
//       尽力同步后端会话（失败忽略），会话失效(404)时自动重开会话重试。
//
// 坐标：fitz 与 pdf.js 都是左上原点、单位点(pt)：PDF 坐标 × scale = 像素。

import { useCallback, useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import {
  X, Save, Loader2, AlertCircle, Info, Highlighter, Underline,
  Strikethrough, StickyNote, Square, Pen, MousePointer2, Trash2,
  List, Plus, Minus, FileJson, FileText,
} from "lucide-react";
import {
  openPdfAnnot, addPdfAnnot, updatePdfAnnot, deletePdfAnnot,
  savePdfAnnots, annotatedPdfBytes, exportPdfAnnots, bytesToPdfBlob, errMsg,
} from "@/services/api";
import { savePdfFile } from "@/services/pdf";
import { docKey, getStash, setStash } from "@/services/annotStash";
import type { AnnotPageInfo, AnnotationType, PdfAnnotation } from "@/types";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

type Tool = "select" | AnnotationType;

const TEXT_TOOLS: Tool[] = ["highlight", "underline", "strikeout"];
const PALETTE = ["#ffd633", "#4caf50", "#2196f3", "#f44336", "#9c27b0", "#ff9800"];
const TYPE_LABELS: Record<AnnotationType, string> = {
  highlight: "高亮", underline: "下划线", strikeout: "删除线",
  note: "笔记", rectangle: "矩形框", ink: "画笔",
};

const newId = () => crypto.randomUUID().replace(/-/g, "");

interface Props {
  data: Uint8Array;
  name: string;
  onClose: () => void;
}

export default function PdfAnnotator({ data, name, onClose }: Props) {
  const [annotId, setAnnotId] = useState<string | null>(null);
  const [pages, setPages] = useState<AnnotPageInfo[]>([]);
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([]);
  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState(PALETTE[0]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [noteEditId, setNoteEditId] = useState<string | null>(null); // 就地编辑中的笔记
  const [flashId, setFlashId] = useState<string | null>(null);
  const [scale, setScale] = useState(1.3);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [banner, setBanner] = useState<{ kind: "info" | "ok" | "warn"; text: string } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const pageElsRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const pdfRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const hasTextRef = useRef<boolean | null>(null); // null=未知（尚未渲染任何页）
  const stashKeyRef = useRef<string | null>(null); // 文档指纹（暂存 key）

  // ---- 建立批注会话（导入 PDF 已有批注；有暂存则恢复暂存）----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const key = await docKey(data);
        const res = await openPdfAnnot(bytesToPdfBlob(data), name);
        if (cancelled) return;
        stashKeyRef.current = key;
        setAnnotId(res.annot_id);
        setPages(res.pages);

        // 暂存优先于 PDF 导入（暂存是导入+用户改动的叠加结果）
        const stashed = getStash(key);
        if (stashed !== null) {
          setAnnotations(stashed);
          // 把暂存推给新后端会话，保证增量同步/导出的基线一致
          savePdfAnnots(res.annot_id, stashed).catch(() => {});
          if (stashed.length > 0) {
            setBanner({
              kind: "info",
              text: `已恢复上次的 ${stashed.length} 条批注（未保存到 PDF，记得保存）`,
            });
          }
        } else {
          setAnnotations(res.annotations);
          if (res.annotations.length > 0) {
            setBanner({
              kind: "info",
              text: `已导入该 PDF 中原有的 ${res.annotations.length} 条批注（列表中标为「原有」）`,
            });
          }
        }
      } catch (e) {
        if (!cancelled) setError(errMsg(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data, name]);

  // ---- 批注变化 → 写入暂存（关掉批注器/切标签都不丢）----
  const firstRunRef = useRef(true);
  useEffect(() => {
    if (loading || !stashKeyRef.current) return;
    if (firstRunRef.current) {
      // 跳过初始载入那一次，只记录用户后续的真实改动
      firstRunRef.current = false;
      return;
    }
    setStash(stashKeyRef.current, annotations);
  }, [annotations, loading]);

  // ---- pdf.js 文档 ----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const doc = await pdfjsLib.getDocument({ data: data.slice(0) }).promise;
        if (cancelled) return;
        pdfRef.current = doc;
        setPdfDoc(doc);
      } catch (e) {
        if (!cancelled) setError(`PDF 加载失败：${errMsg(e)}`);
      }
    })();
    return () => {
      cancelled = true;
      pdfRef.current?.destroy();
      pdfRef.current = null;
    };
  }, [data]);

  // ---- 批注增删改（前端权威 + 尽力同步会话）----
  const createAnnot = useCallback(
    (partial: Partial<PdfAnnotation>) => {
      const now = new Date().toISOString();
      const a: PdfAnnotation = {
        id: newId(),
        page: 0,
        type: "highlight",
        text: "",
        comment: "",
        color,
        rect: null,
        quads: null,
        ink: null,
        created_at: now,
        updated_at: now,
        source: "user",
        xref: null,
        ...partial,
      };
      setAnnotations((prev) => [...prev, a]);
      if (annotId) addPdfAnnot(annotId, a).catch(() => {});
      return a;
    },
    [annotId, color]
  );

  const patchAnnot = useCallback(
    (id: string, patch: Partial<PdfAnnotation>) => {
      setAnnotations((prev) =>
        prev.map((a) =>
          a.id === id ? { ...a, ...patch, updated_at: new Date().toISOString() } : a
        )
      );
      if (annotId) updatePdfAnnot(annotId, id, patch).catch(() => {});
    },
    [annotId]
  );

  const removeAnnot = useCallback(
    (id: string) => {
      setAnnotations((prev) => prev.filter((a) => a.id !== id));
      setSelectedId((cur) => (cur === id ? null : cur));
      if (annotId) deletePdfAnnot(annotId, id).catch(() => {});
    },
    [annotId]
  );

  // ---- 划选文字 → 文本类批注 ----
  const onContainerMouseUp = useCallback(() => {
    if (!TEXT_TOOLS.includes(tool)) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const text = sel.toString().trim();
    if (!text) return;

    const rects = Array.from(sel.getRangeAt(0).getClientRects());
    // 按页分组转换为 PDF 点坐标
    const byPage = new Map<number, [number, number, number, number][]>();
    pageElsRef.current.forEach((el, pno) => {
      const pb = el.getBoundingClientRect();
      for (const r of rects) {
        if (r.width < 2 || r.height < 2) continue;
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        if (cx < pb.left || cx > pb.right || cy < pb.top || cy > pb.bottom) continue;
        const q: [number, number, number, number] = [
          Math.round(((r.left - pb.left) / scale) * 100) / 100,
          Math.round(((r.top - pb.top) / scale) * 100) / 100,
          Math.round(((r.right - pb.left) / scale) * 100) / 100,
          Math.round(((r.bottom - pb.top) / scale) * 100) / 100,
        ];
        const list = byPage.get(pno) ?? [];
        list.push(q);
        byPage.set(pno, list);
      }
    });
    if (byPage.size === 0) return;

    byPage.forEach((quads, pno) => {
      // 去重（textLayer 偶尔给出重复矩形）
      const seen = new Set<string>();
      const unique = quads.filter((q) => {
        const k = q.map((v) => Math.round(v)).join(",");
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      createAnnot({ page: pno, type: tool as AnnotationType, text, quads: unique });
    });
    sel.removeAllRanges();
  }, [tool, scale, createAnnot]);

  // ---- 选择文本工具时，对扫描件给提示 ----
  const pickTool = useCallback((t: Tool) => {
    setTool(t);
    setSelectedId(null);
    setNoteEditId(null);
    if (TEXT_TOOLS.includes(t) && hasTextRef.current === false) {
      setBanner({
        kind: "warn",
        text: "该 PDF 暂不支持文本选择，可以使用矩形框或画笔批注。",
      });
    }
  }, []);

  // ---- 打开笔记就地编辑气泡 ----
  const openNoteEditor = useCallback((id: string) => {
    setNoteEditId(id);
    setSelectedId(null); // 笔记用气泡编辑，不再叠加左下角面板
  }, []);

  // ---- 批注列表跳转 ----
  const jumpTo = useCallback(
    (a: PdfAnnotation) => {
      const el = pageElsRef.current.get(a.page);
      const container = scrollRef.current;
      if (!el || !container) return;
      const y = a.rect?.[1] ?? a.quads?.[0]?.[1] ?? a.ink?.[0]?.[0]?.[1] ?? 0;
      container.scrollTo({
        top: el.offsetTop + y * scale - 120,
        behavior: "smooth",
      });
      if (a.type === "note") {
        openNoteEditor(a.id);
      } else {
        setNoteEditId(null);
        setSelectedId(a.id);
      }
      setFlashId(a.id);
      window.setTimeout(() => setFlashId((cur) => (cur === a.id ? null : cur)), 1600);
    },
    [scale, openNoteEditor]
  );

  // ---- 保存（404 时自动重开会话重试一次）----
  const handleSave = useCallback(async () => {
    if (annotations.length === 0) {
      setBanner({ kind: "info", text: "尚无批注。先添加批注再保存。" });
      return;
    }
    setSaving(true);
    setBanner({ kind: "info", text: "正在把批注写入 PDF..." });
    try {
      let id = annotId;
      const doSave = async (sid: string) => {
        const res = await savePdfAnnots(sid, annotations);
        const bytes = await annotatedPdfBytes(sid);
        return { res, bytes };
      };
      let result;
      try {
        if (!id) throw new Error("会话未建立");
        result = await doSave(id);
      } catch (e) {
        // 会话失效（后端重启/清理）→ 重开会话再试一次
        const msg = errMsg(e);
        if (!/会话|重新打开|404/.test(msg)) throw e;
        const reopened = await openPdfAnnot(bytesToPdfBlob(data), name);
        id = reopened.annot_id;
        setAnnotId(id);
        result = await doSave(id);
      }
      const outName = name.replace(/\.pdf$/i, "") + "-annotated.pdf";
      const savedPath = await savePdfFile(result.bytes, outName);
      setBanner({
        kind: "ok",
        text: savedPath ? result.res.message : `${result.res.message}（已取消另存）`,
      });
    } catch (e) {
      setBanner({ kind: "warn", text: `批注保存失败，请重试：${errMsg(e)}` });
    } finally {
      setSaving(false);
    }
  }, [annotId, annotations, data, name]);

  // ---- 导出 ----
  const handleExport = useCallback(
    async (fmt: "json" | "markdown") => {
      if (!annotId) return;
      try {
        // 先把当前列表推给后端（导出以会话为准）
        await savePdfAnnots(annotId, annotations).catch(() => {});
        const content = await exportPdfAnnots(annotId, fmt);
        await navigator.clipboard.writeText(content);
        setBanner({ kind: "ok", text: `批注已导出为 ${fmt.toUpperCase()} 并复制到剪贴板` });
      } catch (e) {
        setBanner({ kind: "warn", text: `导出失败：${errMsg(e)}` });
      }
    },
    [annotId, annotations]
  );

  const selected = annotations.find((a) => a.id === selectedId) ?? null;

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-slate-800/95">
      {/* 顶部工具栏 */}
      <header className="flex items-center gap-2 px-3 h-12 bg-white shrink-0 shadow">
        <Highlighter size={18} className="text-primary-600 shrink-0" />
        <span className="font-semibold text-slate-800 shrink-0">PDF 批注</span>
        <span className="text-xs text-slate-400 truncate max-w-[160px]">{name}</span>

        {/* 工具 */}
        <div className="flex items-center gap-0.5 ml-2 pl-2 border-l">
          <ToolBtn icon={<MousePointer2 size={15} />} label="选择" active={tool === "select"} onClick={() => pickTool("select")} />
          <ToolBtn icon={<Highlighter size={15} />} label="高亮" active={tool === "highlight"} onClick={() => pickTool("highlight")} />
          <ToolBtn icon={<Underline size={15} />} label="下划线" active={tool === "underline"} onClick={() => pickTool("underline")} />
          <ToolBtn icon={<Strikethrough size={15} />} label="删除线" active={tool === "strikeout"} onClick={() => pickTool("strikeout")} />
          <ToolBtn icon={<StickyNote size={15} />} label="笔记" active={tool === "note"} onClick={() => pickTool("note")} />
          <ToolBtn icon={<Square size={15} />} label="矩形" active={tool === "rectangle"} onClick={() => pickTool("rectangle")} />
          <ToolBtn icon={<Pen size={15} />} label="画笔" active={tool === "ink"} onClick={() => pickTool("ink")} />
        </div>

        {/* 颜色 */}
        <div className="flex items-center gap-1 ml-1 pl-2 border-l">
          {PALETTE.map((c) => (
            <button
              key={c}
              onClick={() => setColor(c)}
              className={`w-4.5 h-4.5 w-[18px] h-[18px] rounded-full border ${
                color === c ? "ring-2 ring-offset-1 ring-slate-500" : "border-slate-300"
              }`}
              style={{ background: c }}
              title={c}
            />
          ))}
          <label className="w-[18px] h-[18px] rounded-full border border-slate-300 overflow-hidden cursor-pointer relative" title="自定义颜色">
            <span
              className="absolute inset-0"
              style={{ background: "conic-gradient(red,yellow,lime,cyan,blue,magenta,red)" }}
            />
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="absolute inset-0 opacity-0 cursor-pointer"
            />
          </label>
        </div>

        {/* 缩放 */}
        <div className="flex items-center gap-0.5 ml-1 pl-2 border-l">
          <button onClick={() => setScale((s) => Math.max(0.6, s - 0.15))} className="p-1 hover:bg-slate-100 rounded" title="缩小">
            <Minus size={14} />
          </button>
          <span className="w-10 text-center text-xs">{Math.round(scale * 100)}%</span>
          <button onClick={() => setScale((s) => Math.min(3, s + 0.15))} className="p-1 hover:bg-slate-100 rounded" title="放大">
            <Plus size={14} />
          </button>
        </div>

        <div className="ml-auto flex items-center gap-2 shrink-0">
          <button
            onClick={() => setSidebarOpen((v) => !v)}
            className={`p-1.5 rounded ${sidebarOpen ? "bg-primary-50 text-primary-700" : "hover:bg-slate-100 text-slate-600"}`}
            title="批注列表"
          >
            <List size={16} />
          </button>
          <button
            onClick={handleSave}
            disabled={saving || loading || !!error}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary-600 text-white rounded hover:bg-primary-700 disabled:opacity-50"
          >
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
            保存为批注 PDF
          </button>
          <button onClick={onClose} className="p-1.5 hover:bg-slate-100 rounded" title="关闭">
            <X size={18} />
          </button>
        </div>
      </header>

      {/* 提示条 */}
      {banner && (
        <div
          className={`flex items-center gap-2 px-4 py-1.5 text-sm shrink-0 ${
            banner.kind === "ok"
              ? "bg-green-50 text-green-700 border-b border-green-200"
              : banner.kind === "warn"
              ? "bg-amber-50 text-amber-700 border-b border-amber-200"
              : "bg-sky-50 text-sky-700 border-b border-sky-200"
          }`}
        >
          <Info size={14} className="shrink-0" />
          <span className="flex-1">{banner.text}</span>
          <button onClick={() => setBanner(null)} className="opacity-60 hover:opacity-100">✕</button>
        </div>
      )}

      {/* 主体 */}
      <div className="flex flex-1 min-h-0">
        <div className="flex-1 relative overflow-hidden">
          {loading && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 text-slate-200">
              <Loader2 className="animate-spin" size={28} />
              <p className="text-sm">正在打开批注会话...</p>
            </div>
          )}
          {error && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 text-center p-6">
              <AlertCircle size={40} className="text-red-400" strokeWidth={1.5} />
              <p className="text-sm text-red-200 max-w-md">{error}</p>
              <button onClick={onClose} className="px-3 py-1.5 text-sm bg-white/90 rounded">关闭</button>
            </div>
          )}
          {!loading && !error && (
            <div
              ref={scrollRef}
              className="h-full overflow-auto py-4"
              onMouseUp={onContainerMouseUp}
            >
              {pages.map((pg) => (
                <AnnotPage
                  key={pg.page}
                  pdfDoc={pdfDoc}
                  info={pg}
                  scale={scale}
                  tool={tool}
                  color={color}
                  annotations={annotations.filter((a) => a.page === pg.page)}
                  selectedId={selectedId}
                  noteEditId={noteEditId}
                  flashId={flashId}
                  onSelect={(id) => {
                    setNoteEditId(null);
                    setSelectedId(id);
                  }}
                  onOpenNote={openNoteEditor}
                  onCloseNote={() => setNoteEditId(null)}
                  onCreate={createAnnot}
                  onPatch={patchAnnot}
                  onRemove={removeAnnot}
                  registerEl={(el) => {
                    if (el) pageElsRef.current.set(pg.page, el);
                    else pageElsRef.current.delete(pg.page);
                  }}
                  reportHasText={(has) => {
                    if (has) hasTextRef.current = true;
                    else if (hasTextRef.current === null) hasTextRef.current = false;
                  }}
                />
              ))}
            </div>
          )}
        </div>

        {/* 右侧批注列表 */}
        {sidebarOpen && !loading && !error && (
          <AnnotList
            annotations={annotations}
            selectedId={selectedId}
            onJump={jumpTo}
            onRemove={removeAnnot}
            onExport={handleExport}
          />
        )}
      </div>

      {/* 选中批注的编辑面板（笔记类型走页面内就地气泡，不在这里） */}
      {selected && selected.type !== "note" && (
        <AnnotInspector
          annot={selected}
          onPatch={(p) => patchAnnot(selected.id, p)}
          onRemove={() => removeAnnot(selected.id)}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

// ================= 工具按钮 =================

function ToolBtn({ icon, label, active, onClick }: {
  icon: React.ReactNode; label: string; active: boolean; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={`flex items-center gap-1 px-1.5 py-1 rounded text-xs ${
        active ? "bg-primary-600 text-white" : "text-slate-600 hover:bg-slate-100"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

// ================= 单页（canvas + textLayer + 批注覆盖层 + 绘制捕获层）=================

interface AnnotPageProps {
  pdfDoc: pdfjsLib.PDFDocumentProxy | null;
  info: AnnotPageInfo;
  scale: number;
  tool: Tool;
  color: string;
  annotations: PdfAnnotation[];
  selectedId: string | null;
  noteEditId: string | null;
  flashId: string | null;
  onSelect: (id: string | null) => void;
  onOpenNote: (id: string) => void;
  onCloseNote: () => void;
  onCreate: (p: Partial<PdfAnnotation>) => PdfAnnotation;
  onPatch: (id: string, p: Partial<PdfAnnotation>) => void;
  onRemove: (id: string) => void;
  registerEl: (el: HTMLDivElement | null) => void;
  reportHasText: (has: boolean) => void;
}

function AnnotPage({
  pdfDoc, info, scale, tool, color, annotations, selectedId, noteEditId, flashId,
  onSelect, onOpenNote, onCloseNote, onCreate, onPatch, onRemove,
  registerEl, reportHasText,
}: AnnotPageProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const renderedForScaleRef = useRef<number | null>(null);

  // 拖拽矩形 / 画笔中间态（CSS px）
  const [draft, setDraft] = useState<
    | { kind: "rect"; x0: number; y0: number; x1: number; y1: number }
    | { kind: "ink"; points: [number, number][] }
    | null
  >(null);

  const w = info.width * scale;
  const h = info.height * scale;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (es) => es.forEach((en) => en.isIntersecting && setVisible(true)),
      { rootMargin: "700px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !pdfDoc || renderedForScaleRef.current === scale) return;
    let cancelled = false;
    (async () => {
      try {
        const page = await pdfDoc.getPage(info.page + 1);
        if (cancelled) return;
        const viewport = page.getViewport({ scale });
        const canvas = canvasRef.current;
        const textLayerDiv = textLayerRef.current;
        if (!canvas || !textLayerDiv) return;
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        await page.render({
          canvasContext: ctx,
          viewport,
          annotationMode: (pdfjsLib as any).AnnotationMode?.DISABLE ?? 0,
        } as any).promise;
        if (cancelled) return;
        renderedForScaleRef.current = scale;

        // 文本层（划选用）
        try {
          const textContent = await page.getTextContent();
          reportHasText((textContent.items?.length ?? 0) > 0);
          textLayerDiv.replaceChildren();
          textLayerDiv.style.setProperty("--scale-factor", String(viewport.scale));
          const lib = pdfjsLib as any;
          if (typeof lib.TextLayer === "function") {
            await new lib.TextLayer({
              textContentSource: textContent,
              container: textLayerDiv,
              viewport,
            }).render();
          } else if (typeof lib.renderTextLayer === "function") {
            await lib.renderTextLayer({
              textContentSource: textContent,
              container: textLayerDiv,
              viewport,
            }).promise;
          }
        } catch {
          /* 文本层失败仅影响划选，不影响画布与其他工具 */
        }
      } catch {
        /* 单页渲染失败不阻断其他页 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, pdfDoc, info.page, scale, reportHasText]);

  // ---- note/rect/ink 的画布交互 ----
  const toLocal = (e: React.PointerEvent | React.MouseEvent) => {
    const box = wrapRef.current!.getBoundingClientRect();
    return [e.clientX - box.left, e.clientY - box.top] as [number, number];
  };

  const onCapturePointerDown = (e: React.PointerEvent) => {
    if (tool === "note") {
      const [x, y] = toLocal(e);
      const px = x / scale;
      const py = y / scale;
      const a = onCreate({
        page: info.page, type: "note", color,
        rect: [r2(px), r2(py), r2(px + 18), r2(py + 18)],
      });
      onOpenNote(a.id); // 落点处直接弹输入气泡开始打字
      return;
    }
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const [x, y] = toLocal(e);
    if (tool === "rectangle") setDraft({ kind: "rect", x0: x, y0: y, x1: x, y1: y });
    else if (tool === "ink") setDraft({ kind: "ink", points: [[x, y]] });
  };

  const onCapturePointerMove = (e: React.PointerEvent) => {
    if (!draft) return;
    const [x, y] = toLocal(e);
    if (draft.kind === "rect") setDraft({ ...draft, x1: x, y1: y });
    else setDraft({ kind: "ink", points: [...draft.points, [x, y]] });
  };

  const onCapturePointerUp = () => {
    if (!draft) return;
    if (draft.kind === "rect") {
      const x0 = Math.min(draft.x0, draft.x1) / scale;
      const y0 = Math.min(draft.y0, draft.y1) / scale;
      const x1 = Math.max(draft.x0, draft.x1) / scale;
      const y1 = Math.max(draft.y0, draft.y1) / scale;
      if (x1 - x0 >= 4 && y1 - y0 >= 4) {
        onCreate({
          page: info.page, type: "rectangle", color,
          rect: [r2(x0), r2(y0), r2(x1), r2(y1)],
        });
      }
    } else if (draft.kind === "ink" && draft.points.length >= 2) {
      const stroke = draft.points.map(
        ([x, y]) => [r2(x / scale), r2(y / scale)] as [number, number]
      );
      onCreate({ page: info.page, type: "ink", color, ink: [stroke] });
    }
    setDraft(null);
  };

  const captureActive = tool === "note" || tool === "rectangle" || tool === "ink";
  const overlayInteractive = tool === "select";

  return (
    <div
      ref={(el) => {
        wrapRef.current = el;
        registerEl(el);
      }}
      className="relative mx-auto my-3 bg-white shadow-lg"
      style={{ width: w, height: h }}
      data-annot-page={info.page}
    >
      <canvas ref={canvasRef} style={{ width: w, height: h }} className="block" />
      <div
        ref={textLayerRef}
        className="textLayer"
        style={{ width: w, height: h }}
      />
      <span className="absolute -top-1 left-1 -translate-y-full text-[10px] text-slate-300 select-none">
        第 {info.page + 1} 页
      </span>

      {/* 批注覆盖层 */}
      {annotations.map((a) => (
        <AnnotOverlay
          key={a.id}
          a={a}
          scale={scale}
          selected={selectedId === a.id || noteEditId === a.id}
          flash={flashId === a.id}
          interactive={overlayInteractive}
          onSelect={() => (a.type === "note" ? onOpenNote(a.id) : onSelect(a.id))}
        />
      ))}

      {/* 笔记就地输入气泡（跟随落点） */}
      {(() => {
        const editing = annotations.find((a) => a.id === noteEditId && a.type === "note");
        if (!editing?.rect) return null;
        return (
          <NoteBubble
            key={editing.id}
            annot={editing}
            scale={scale}
            pageW={w}
            pageH={h}
            onPatch={(p) => onPatch(editing.id, p)}
            onRemove={() => {
              onRemove(editing.id);
              onCloseNote();
            }}
            onClose={onCloseNote}
          />
        );
      })()}

      {/* 绘制捕获层（note/rect/ink 激活时） */}
      {captureActive && (
        <div
          className="absolute inset-0 z-20"
          style={{ cursor: tool === "note" ? "copy" : "crosshair", touchAction: "none" }}
          onPointerDown={onCapturePointerDown}
          onPointerMove={onCapturePointerMove}
          onPointerUp={onCapturePointerUp}
        />
      )}

      {/* 拖拽中的预览 */}
      {draft?.kind === "rect" && (
        <div
          className="absolute z-10 pointer-events-none"
          style={{
            left: Math.min(draft.x0, draft.x1),
            top: Math.min(draft.y0, draft.y1),
            width: Math.abs(draft.x1 - draft.x0),
            height: Math.abs(draft.y1 - draft.y0),
            border: `1.5px solid ${color}`,
            background: `${color}18`,
          }}
        />
      )}
      {draft?.kind === "ink" && (
        <svg className="absolute inset-0 z-10 pointer-events-none" width={w} height={h}>
          <polyline
            points={draft.points.map((p) => p.join(",")).join(" ")}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </div>
  );
}

const r2 = (v: number) => Math.round(v * 100) / 100;

// ================= 批注覆盖层（视觉呈现）=================

function AnnotOverlay({ a, scale, selected, flash, interactive, onSelect }: {
  a: PdfAnnotation; scale: number; selected: boolean; flash: boolean;
  interactive: boolean; onSelect: () => void;
}) {
  const common: React.CSSProperties = {
    pointerEvents: interactive ? "auto" : "none",
    cursor: interactive ? "pointer" : undefined,
  };
  const ring = selected
    ? "0 0 0 2px rgba(59,130,246,.85)"
    : flash
    ? "0 0 0 3px rgba(59,130,246,.6)"
    : undefined;

  if ((a.type === "highlight" || a.type === "underline" || a.type === "strikeout") && a.quads) {
    return (
      <>
        {a.quads.map((q, i) => {
          const [x0, y0, x1, y1] = q;
          const base: React.CSSProperties = {
            ...common,
            position: "absolute",
            left: x0 * scale,
            width: (x1 - x0) * scale,
            boxShadow: ring,
          };
          if (a.type === "highlight") {
            return (
              <div
                key={i}
                onClick={onSelect}
                style={{
                  ...base,
                  top: y0 * scale,
                  height: (y1 - y0) * scale,
                  background: a.color,
                  opacity: 0.38,
                  mixBlendMode: "multiply",
                }}
              />
            );
          }
          const lineTop = a.type === "underline" ? y1 * scale - 2 : (y0 + (y1 - y0) / 2) * scale - 1;
          return (
            <div
              key={i}
              onClick={onSelect}
              style={{
                ...base,
                top: lineTop,
                height: 2,
                background: a.color,
              }}
            />
          );
        })}
      </>
    );
  }

  if (a.type === "rectangle" && a.rect) {
    const [x0, y0, x1, y1] = a.rect;
    return (
      <div
        onClick={onSelect}
        style={{
          ...common,
          position: "absolute",
          left: x0 * scale,
          top: y0 * scale,
          width: (x1 - x0) * scale,
          height: (y1 - y0) * scale,
          border: `1.5px solid ${a.color}`,
          boxShadow: ring,
        }}
      />
    );
  }

  if (a.type === "ink" && a.ink) {
    return (
      <svg
        className="absolute inset-0"
        style={{ ...common, width: "100%", height: "100%", overflow: "visible" }}
        onClick={onSelect}
      >
        {a.ink.map((stroke, i) => (
          <polyline
            key={i}
            points={stroke.map(([x, y]) => `${x * scale},${y * scale}`).join(" ")}
            fill="none"
            stroke={a.color}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ filter: ring ? "drop-shadow(0 0 2px rgba(59,130,246,.9))" : undefined }}
          />
        ))}
      </svg>
    );
  }

  if (a.type === "note" && a.rect) {
    const [x0, y0] = a.rect;
    return (
      <div
        onClick={onSelect}
        title={a.comment}
        style={{
          ...common,
          pointerEvents: "auto", // 便签始终可点（不挡文字选择：面积小）
          cursor: "pointer",
          position: "absolute",
          left: x0 * scale,
          top: y0 * scale,
          boxShadow: ring,
          borderRadius: 3,
        }}
        className="flex items-center justify-center w-5 h-5 rounded-sm"
      >
        <StickyNote size={18} style={{ color: a.color, fill: `${a.color}55` }} strokeWidth={2} />
      </div>
    );
  }
  return null;
}

// ================= 笔记就地输入气泡 =================

function NoteBubble({ annot, scale, pageW, pageH, onPatch, onRemove, onClose }: {
  annot: PdfAnnotation;
  scale: number;
  pageW: number;
  pageH: number;
  onPatch: (p: Partial<PdfAnnotation>) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const [x0, y0] = annot.rect!;
  const BUBBLE_W = 240;
  const BUBBLE_H = 150;
  // 默认贴在图标右侧；越界则翻到左侧/上方，保证气泡完整可见
  let left = x0 * scale + 24;
  if (left + BUBBLE_W > pageW - 4) left = Math.max(4, x0 * scale - BUBBLE_W - 6);
  let top = y0 * scale - 4;
  if (top + BUBBLE_H > pageH - 4) top = Math.max(4, pageH - BUBBLE_H - 4);

  // 新建时为空 → 关闭时若仍为空自动删除，避免留下无内容的孤儿便签
  const emptyOnCloseRemoves = () => {
    if (!annot.comment.trim()) onRemove();
    else onClose();
  };

  return (
    <div
      className="absolute z-30 bg-white rounded-lg shadow-xl border border-slate-200 p-2 space-y-1.5"
      style={{ left, top, width: BUBBLE_W }}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-1.5 text-xs text-slate-500">
        <StickyNote size={13} style={{ color: annot.color }} />
        <span>笔记 · 第 {annot.page + 1} 页</span>
        {annot.source === "pdf" && (
          <span className="text-[10px] px-1 bg-slate-100 text-slate-400 rounded">原有</span>
        )}
        <button
          onClick={emptyOnCloseRemoves}
          className="ml-auto text-slate-400 hover:text-slate-600"
          title="完成"
        >
          <X size={13} />
        </button>
      </div>
      <textarea
        autoFocus
        value={annot.comment}
        onChange={(e) => onPatch({ comment: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
            e.preventDefault();
            emptyOnCloseRemoves();
          }
        }}
        placeholder="输入笔记内容...（Ctrl+Enter 完成）"
        className="w-full h-20 text-sm border rounded p-1.5 resize-none outline-none focus:border-primary-400"
      />
      <div className="flex items-center gap-1.5">
        {PALETTE.map((c) => (
          <button
            key={c}
            onClick={() => onPatch({ color: c })}
            className={`w-3.5 h-3.5 rounded-full border ${
              annot.color === c ? "ring-2 ring-offset-1 ring-slate-400" : "border-slate-300"
            }`}
            style={{ background: c }}
          />
        ))}
        <button
          onClick={onRemove}
          className="ml-auto flex items-center gap-1 px-1.5 py-0.5 text-xs text-red-600 hover:bg-red-50 rounded"
        >
          <Trash2 size={12} />
          删除
        </button>
      </div>
    </div>
  );
}

// ================= 选中批注的编辑面板（右下角固定）=================

function AnnotInspector({ annot, onPatch, onRemove, onClose }: {
  annot: PdfAnnotation;
  onPatch: (p: Partial<PdfAnnotation>) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  return (
    <div className="absolute bottom-4 left-4 z-30 w-72 bg-white rounded-lg shadow-xl border p-3 space-y-2">
      <div className="flex items-center gap-2 text-sm">
        <span className="w-3 h-3 rounded-full shrink-0" style={{ background: annot.color }} />
        <span className="font-medium text-slate-700">
          {TYPE_LABELS[annot.type]} · 第 {annot.page + 1} 页
        </span>
        {annot.source === "pdf" && (
          <span className="text-[10px] px-1 py-0.5 bg-slate-100 text-slate-500 rounded">原有</span>
        )}
        <button onClick={onClose} className="ml-auto text-slate-400 hover:text-slate-600">
          <X size={14} />
        </button>
      </div>

      {annot.text && (
        <p className="text-xs text-slate-500 bg-slate-50 rounded p-1.5 max-h-16 overflow-auto">
          {annot.text}
        </p>
      )}

      <textarea
        value={annot.comment}
        onChange={(e) => onPatch({ comment: e.target.value })}
        placeholder="写点批注..."
        autoFocus={annot.type === "note" && !annot.comment}
        className="w-full h-16 text-sm border rounded p-1.5 resize-none outline-none focus:border-primary-400"
      />

      <div className="flex items-center gap-1.5">
        {PALETTE.map((c) => (
          <button
            key={c}
            onClick={() => onPatch({ color: c })}
            disabled={annot.source === "pdf"}
            className={`w-4 h-4 rounded-full border disabled:opacity-40 ${
              annot.color === c ? "ring-2 ring-offset-1 ring-slate-400" : "border-slate-300"
            }`}
            style={{ background: c }}
          />
        ))}
        <button
          onClick={onRemove}
          className="ml-auto flex items-center gap-1 px-2 py-1 text-xs text-red-600 hover:bg-red-50 rounded"
        >
          <Trash2 size={13} />
          删除
        </button>
      </div>
    </div>
  );
}

// ================= 右侧批注列表 =================

function AnnotList({ annotations, selectedId, onJump, onRemove, onExport }: {
  annotations: PdfAnnotation[];
  selectedId: string | null;
  onJump: (a: PdfAnnotation) => void;
  onRemove: (id: string) => void;
  onExport: (fmt: "json" | "markdown") => void;
}) {
  const byPage = new Map<number, PdfAnnotation[]>();
  for (const a of annotations) {
    const list = byPage.get(a.page) ?? [];
    list.push(a);
    byPage.set(a.page, list);
  }
  const pagesSorted = Array.from(byPage.keys()).sort((x, y) => x - y);

  return (
    <div className="w-72 bg-white border-l flex flex-col shrink-0">
      <div className="flex items-center gap-2 px-3 h-9 border-b text-sm shrink-0">
        <span className="font-medium text-slate-700">批注列表</span>
        <span className="text-xs text-slate-400">{annotations.length}</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => onExport("json")}
            className="p-1 text-slate-500 hover:bg-slate-100 rounded"
            title="导出 JSON（复制到剪贴板）"
          >
            <FileJson size={14} />
          </button>
          <button
            onClick={() => onExport("markdown")}
            className="p-1 text-slate-500 hover:bg-slate-100 rounded"
            title="导出 Markdown（复制到剪贴板）"
          >
            <FileText size={14} />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        {annotations.length === 0 && (
          <p className="text-xs text-slate-400 text-center mt-8 px-4">
            还没有批注。选择上方工具，在 PDF 上划选文字或绘制即可添加。
          </p>
        )}
        {pagesSorted.map((pno) => (
          <div key={pno}>
            <div className="px-3 py-1 text-[11px] text-slate-400 bg-slate-50 sticky top-0">
              第 {pno + 1} 页
            </div>
            {byPage.get(pno)!.map((a) => (
              <div
                key={a.id}
                onClick={() => onJump(a)}
                className={`px-3 py-2 border-b border-slate-100 cursor-pointer hover:bg-slate-50 ${
                  selectedId === a.id ? "bg-primary-50" : ""
                }`}
              >
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: a.color }} />
                  <span className="text-slate-600 font-medium">{TYPE_LABELS[a.type]}</span>
                  {a.source === "pdf" && (
                    <span className="text-[10px] px-1 bg-slate-100 text-slate-400 rounded">原有</span>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemove(a.id);
                    }}
                    className="ml-auto p-0.5 text-slate-300 hover:text-red-500"
                    title="删除"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
                {(a.text || a.comment) && (
                  <p className="mt-1 text-xs text-slate-500 line-clamp-2">
                    {a.comment ? `💬 ${a.comment}` : a.text}
                  </p>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
