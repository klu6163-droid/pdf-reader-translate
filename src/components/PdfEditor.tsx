// PDF 文本块编辑器（全屏浮层，独立封装，不影响阅读/翻译/总结）。
//
// 渲染：pdf.js 画每页 canvas 作背景；覆盖一层绝对定位的可编辑文本框，
//       位置由后端解析的 bbox（PDF 点）× 缩放系数得到。
// 编辑：点击选中 → 就地改文字 / 拖动手柄移动 / 调字号 / 改颜色 / 删除。
// 预览：编辑器内对改动块用「白底盖旧字 + 新字」做所见即所得预览；
//       真正的内容流修改在后端用 redaction+重写完成，保存为新 PDF。
//
// 坐标：fitz 与 pdf.js 均以左上角为原点、单位为点(pt)，故 bbox×scale 即像素位置。

import { useCallback, useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import {
  X, Save, Loader2, AlertCircle, Type, Trash2, RotateCcw,
  Plus, Minus, MousePointer2, Info,
} from "lucide-react";
import {
  analyzePdfForEdit, savePdfEdits, editedPdfBytes, errMsg, bytesToPdfBlob,
} from "@/services/api";
import { savePdfFile } from "@/services/pdf";
import type { AnalyzeResult, EditBlock, EditOp } from "@/types";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

interface Props {
  data: Uint8Array;
  name: string;
  onClose: () => void;
}

// 单块的本地改动（未改动的块不进此表）
type EditMap = Map<string, EditOp>;

export default function PdfEditor({ data, name, onClose }: Props) {
  const [analyzeResult, setAnalyzeResult] = useState<AnalyzeResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [scale, setScale] = useState(1.3);
  const [edits, setEdits] = useState<EditMap>(new Map());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<{ kind: "info" | "ok" | "warn"; text: string } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const pdfRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);

  // ---- 解析文本块 ----
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    (async () => {
      try {
        const blob = bytesToPdfBlob(data);
        const result = await analyzePdfForEdit(blob, name);
        if (cancelled) return;
        setAnalyzeResult(result);
        setBanner({
          kind: result.mode === "text" ? "info" : "warn",
          text: result.mode_label,
        });
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

  // ---- 加载 pdf.js 文档（用于渲染背景 canvas）----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const doc = await pdfjsLib.getDocument({ data: data.slice(0) }).promise;
        if (cancelled) return;
        pdfRef.current = doc;
        // 触发一次重渲染让 canvas 挂载
        setAnalyzeResult((r) => (r ? { ...r } : r));
      } catch {
        /* 背景渲染失败不阻断编辑；框仍可用 */
      }
    })();
    return () => {
      cancelled = true;
      pdfRef.current?.destroy();
      pdfRef.current = null;
    };
  }, [data]);

  // ---- 编辑操作 ----
  const patchEdit = useCallback((id: string, patch: Partial<EditOp>) => {
    setEdits((prev) => {
      const next = new Map(prev);
      const cur = next.get(id) ?? { id };
      next.set(id, { ...cur, ...patch });
      return next;
    });
  }, []);

  const resetEdit = useCallback((id: string) => {
    setEdits((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const effective = useCallback(
    (b: EditBlock) => {
      const e = edits.get(b.id);
      return {
        text: e?.text ?? b.text,
        bbox: (e?.bbox ?? b.bbox) as [number, number, number, number],
        size: e?.size ?? b.size,
        color: e?.color ?? b.color,
        deleted: !!e?.deleted,
        isEdited: !!e,
      };
    },
    [edits]
  );

  // ---- 保存为新 PDF ----
  const handleSave = useCallback(async () => {
    if (!analyzeResult) return;
    setSaving(true);
    setBanner({ kind: "info", text: "正在生成编辑后的 PDF..." });
    try {
      const ops: EditOp[] = [];
      edits.forEach((e) => ops.push(e));
      if (ops.length === 0) {
        setBanner({ kind: "info", text: "尚无改动。修改文本块后再保存。" });
        setSaving(false);
        return;
      }
      const res = await savePdfEdits(analyzeResult.edit_id, ops);
      const bytes = await editedPdfBytes(analyzeResult.edit_id);
      const outName = name.replace(/\.pdf$/i, "") + "-edited.pdf";
      const savedPath = await savePdfFile(bytes, outName);
      setBanner({
        kind: res.mode === "text" ? "ok" : "warn",
        text: savedPath ? `${res.message}` : `${res.message}（已取消另存）`,
      });
    } catch (e) {
      setBanner({ kind: "warn", text: `保存失败：${errMsg(e)}` });
    } finally {
      setSaving(false);
    }
  }, [analyzeResult, edits, name]);

  const editCount = edits.size;

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-slate-800/95">
      {/* 顶部工具栏 */}
      <header className="flex items-center gap-3 px-4 h-12 bg-white shrink-0 shadow">
        <Type size={18} className="text-primary-600" />
        <span className="font-semibold text-slate-800">PDF 编辑</span>
        <span className="text-xs text-slate-400 truncate max-w-[240px]">{name}</span>

        <div className="flex items-center gap-1 ml-2">
          <button onClick={() => setScale((s) => Math.max(0.6, s - 0.15))}
            className="p-1 hover:bg-slate-100 rounded" title="缩小">
            <Minus size={16} />
          </button>
          <span className="w-12 text-center text-sm">{Math.round(scale * 100)}%</span>
          <button onClick={() => setScale((s) => Math.min(3, s + 0.15))}
            className="p-1 hover:bg-slate-100 rounded" title="放大">
            <Plus size={16} />
          </button>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-slate-500">
            {editCount > 0 ? `${editCount} 处改动` : "点击文本块开始编辑"}
          </span>
          <button
            onClick={handleSave}
            disabled={saving || loading || !!error}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary-600 text-white rounded hover:bg-primary-700 disabled:opacity-50"
          >
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
            保存为新 PDF
          </button>
          <button onClick={onClose} className="p-1.5 hover:bg-slate-100 rounded" title="关闭编辑器">
            <X size={18} />
          </button>
        </div>
      </header>

      {/* 模式 / 状态提示条 */}
      {banner && (
        <div
          className={`flex items-center gap-2 px-4 py-2 text-sm shrink-0 ${
            banner.kind === "ok"
              ? "bg-green-50 text-green-700 border-b border-green-200"
              : banner.kind === "warn"
              ? "bg-amber-50 text-amber-700 border-b border-amber-200"
              : "bg-sky-50 text-sky-700 border-b border-sky-200"
          }`}
        >
          <Info size={15} className="shrink-0" />
          <span className="flex-1">{banner.text}</span>
        </div>
      )}

      {/* 主体 */}
      <div className="flex-1 relative overflow-hidden">
        {loading && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 text-slate-200">
            <Loader2 className="animate-spin" size={28} />
            <p className="text-sm">正在解析文本块...</p>
          </div>
        )}
        {error && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 text-center p-6">
            <AlertCircle size={40} className="text-red-400" strokeWidth={1.5} />
            <p className="text-sm text-red-200 max-w-md">{error}</p>
            <button onClick={onClose} className="px-3 py-1.5 text-sm bg-white/90 rounded">关闭</button>
          </div>
        )}

        {analyzeResult && !error && (
          <div
            ref={scrollRef}
            className="h-full overflow-auto py-4"
            onMouseDown={(e) => {
              // 点空白处取消选中
              if (e.target === e.currentTarget) setSelectedId(null);
            }}
          >
            {analyzeResult.pages.map((pg) => (
              <PageLayer
                key={pg.page}
                pdfDoc={pdfRef.current}
                page={pg}
                scale={scale}
                edits={edits}
                effective={effective}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onPatch={patchEdit}
                onReset={resetEdit}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ================= 单页 =================

interface PageLayerProps {
  pdfDoc: pdfjsLib.PDFDocumentProxy | null;
  page: import("@/types").EditPage;
  scale: number;
  edits: EditMap;
  effective: (b: EditBlock) => {
    text: string; bbox: [number, number, number, number];
    size: number; color: string; deleted: boolean; isEdited: boolean;
  };
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onPatch: (id: string, patch: Partial<EditOp>) => void;
  onReset: (id: string) => void;
}

function PageLayer({
  pdfDoc, page, scale, effective, selectedId, onSelect, onPatch, onReset,
}: PageLayerProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const renderedRef = useRef(false);

  const w = page.width * scale;
  const h = page.height * scale;

  // 懒渲染：进入视口才画 canvas
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => entries.forEach((en) => { if (en.isIntersecting) setVisible(true); }),
      { rootMargin: "600px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    renderedRef.current = false; // 缩放变化需重画
  }, [scale]);

  useEffect(() => {
    if (!visible || !pdfDoc || renderedRef.current) return;
    let cancelled = false;
    (async () => {
      try {
        const p = await pdfDoc.getPage(page.page + 1); // pdf.js 1-based
        if (cancelled) return;
        const viewport = p.getViewport({ scale });
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        await p.render({ canvasContext: ctx, viewport }).promise;
        renderedRef.current = true;
      } catch {
        /* 背景渲染失败不影响编辑框 */
      }
    })();
    return () => { cancelled = true; };
  }, [visible, pdfDoc, page.page, scale]);

  return (
    <div
      ref={wrapRef}
      className="relative mx-auto my-3 bg-white shadow-lg"
      style={{ width: w, height: h }}
    >
      <canvas ref={canvasRef} style={{ width: w, height: h }} className="block" />
      {/* 页码标 */}
      <span className="absolute -top-2 left-2 -translate-y-full text-[10px] text-slate-300">
        第 {page.page + 1} 页
      </span>
      {visible &&
        page.blocks.map((b) => (
          <BlockBox
            key={b.id}
            block={b}
            scale={scale}
            eff={effective(b)}
            selected={selectedId === b.id}
            onSelect={onSelect}
            onPatch={onPatch}
            onReset={onReset}
          />
        ))}
    </div>
  );
}

// ================= 单个文本块 =================

interface BlockBoxProps {
  block: EditBlock;
  scale: number;
  eff: {
    text: string; bbox: [number, number, number, number];
    size: number; color: string; deleted: boolean; isEdited: boolean;
  };
  selected: boolean;
  onSelect: (id: string | null) => void;
  onPatch: (id: string, patch: Partial<EditOp>) => void;
  onReset: (id: string) => void;
}

function BlockBox({ block, scale, eff, selected, onSelect, onPatch, onReset }: BlockBoxProps) {
  const dragRef = useRef<{ sx: number; sy: number; bbox: [number, number, number, number] } | null>(null);

  const [ox0, oy0, ox1, oy1] = block.bbox; // 原始位置（白底盖旧字）
  const [x0, y0, x1, y1] = eff.bbox; // 生效位置
  const needCover = selected || eff.isEdited; // 需要盖住原字

  // 拖动移动
  const onDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { sx: e.clientX, sy: e.clientY, bbox: eff.bbox };
    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dxPt = (ev.clientX - d.sx) / scale;
      const dyPt = (ev.clientY - d.sy) / scale;
      onPatch(block.id, {
        bbox: [d.bbox[0] + dxPt, d.bbox[1] + dyPt, d.bbox[2] + dxPt, d.bbox[3] + dyPt],
      });
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const fontStyle: React.CSSProperties = {
    fontSize: eff.size * scale,
    color: eff.color,
    fontWeight: block.bold ? 600 : 400,
    fontStyle: block.italic ? "italic" : "normal",
    lineHeight: 1.1,
  };

  // 已删除：只显示还原按钮
  if (eff.deleted) {
    return (
      <>
        <div className="absolute bg-white" style={rectStyle(ox0, oy0, ox1, oy1, scale)} />
        <button
          onClick={() => onReset(block.id)}
          className="absolute flex items-center gap-1 px-1 text-[10px] bg-red-100 text-red-600 rounded border border-red-300 hover:bg-red-200"
          style={{ left: ox0 * scale, top: oy0 * scale }}
          title="还原此文本块"
        >
          <RotateCcw size={10} /> 已删除
        </button>
      </>
    );
  }

  return (
    <>
      {/* 盖住原字（编辑或选中时）*/}
      {needCover && (
        <div className="absolute bg-white" style={rectStyle(ox0, oy0, ox1, oy1, scale)} />
      )}

      {selected ? (
        <div
          className="absolute z-20 ring-2 ring-primary-500 rounded-sm"
          style={rectStyle(x0, y0, x1, y1, scale, true)}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {/* 拖动手柄 */}
          <div
            onMouseDown={onDragStart}
            className="absolute -top-5 left-0 flex items-center gap-1 px-1 h-5 bg-primary-600 text-white text-[10px] rounded-t cursor-move select-none"
            title="拖动移动位置"
          >
            <MousePointer2 size={11} /> 拖动
          </div>
          <textarea
            autoFocus
            value={eff.text}
            onChange={(e) => onPatch(block.id, { text: e.target.value })}
            className="w-full h-full resize-none bg-transparent outline-none overflow-hidden p-0 m-0"
            style={fontStyle}
            spellCheck={false}
          />
          {/* 浮动工具条 */}
          <BlockToolbar
            size={eff.size}
            color={eff.color}
            isEdited={eff.isEdited}
            onSize={(s) => onPatch(block.id, { size: s })}
            onColor={(c) => onPatch(block.id, { color: c })}
            onDelete={() => onPatch(block.id, { deleted: true })}
            onReset={() => onReset(block.id)}
          />
        </div>
      ) : eff.isEdited ? (
        // 已改动但未选中：显示新文字
        <div
          onClick={() => onSelect(block.id)}
          className="absolute cursor-text hover:ring-1 hover:ring-primary-300 overflow-hidden whitespace-pre-wrap"
          style={{ ...rectStyle(x0, y0, x1, y1, scale, true), ...fontStyle }}
          title="点击编辑"
        >
          {eff.text}
        </div>
      ) : (
        // 未改动：透明可点区域（canvas 已显示原字）
        <div
          onClick={() => onSelect(block.id)}
          className="absolute cursor-text hover:bg-primary-400/10 hover:ring-1 hover:ring-primary-300"
          style={rectStyle(x0, y0, x1, y1, scale, true)}
          title="点击编辑此文本块"
        />
      )}
    </>
  );
}

function BlockToolbar({
  size, color, isEdited, onSize, onColor, onDelete, onReset,
}: {
  size: number; color: string; isEdited: boolean;
  onSize: (s: number) => void; onColor: (c: string) => void;
  onDelete: () => void; onReset: () => void;
}) {
  return (
    <div
      className="absolute left-0 top-full mt-1 flex items-center gap-1 px-1.5 py-1 bg-white rounded shadow-lg border text-slate-600 z-30"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button className="p-1 hover:bg-slate-100 rounded" title="减小字号"
        onClick={() => onSize(Math.max(4, Math.round((size - 1) * 10) / 10))}>
        <Minus size={13} />
      </button>
      <span className="text-[11px] w-8 text-center tabular-nums">{size.toFixed(1)}</span>
      <button className="p-1 hover:bg-slate-100 rounded" title="增大字号"
        onClick={() => onSize(Math.round((size + 1) * 10) / 10)}>
        <Plus size={13} />
      </button>
      <span className="w-px h-4 bg-slate-200 mx-0.5" />
      <label className="p-0.5 hover:bg-slate-100 rounded cursor-pointer" title="文字颜色">
        <input type="color" value={color} onChange={(e) => onColor(e.target.value)}
          className="w-4 h-4 cursor-pointer align-middle" />
      </label>
      <span className="w-px h-4 bg-slate-200 mx-0.5" />
      <button className="p-1 hover:bg-red-50 text-red-500 rounded" title="删除此文本块" onClick={onDelete}>
        <Trash2 size={13} />
      </button>
      {isEdited && (
        <button className="p-1 hover:bg-slate-100 rounded" title="撤销此块改动" onClick={onReset}>
          <RotateCcw size={13} />
        </button>
      )}
    </div>
  );
}

// 由 PDF 点坐标算出绝对定位样式
function rectStyle(
  x0: number, y0: number, x1: number, y1: number, scale: number, pad = false
): React.CSSProperties {
  const p = pad ? 1 : 0;
  return {
    left: x0 * scale - p,
    top: y0 * scale - p,
    width: (x1 - x0) * scale + p * 2,
    height: (y1 - y0) * scale + p * 2,
  };
}
