// PDF 批注器（全屏浮层，独立封装，不影响阅读/翻译/总结/编辑）。
//
// 拆分后：本文件只承担会话/状态/副作用编排；具体渲染委派给
// - Toolbar：顶栏工具/颜色/缩放/保存
// - AnnotPage：单页 canvas + textLayer + 覆盖层 + 绘制交互
//   （内部还会引用 AnnotOverlay、NoteBubble）
// - AnnotList：右侧列表 + 导出
// - AnnotInspector：非笔记类批注的左下编辑面板
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

import { useCallback, useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { AlertCircle, Info, Loader2 } from 'lucide-react';
import {
  openPdfAnnot,
  addPdfAnnot,
  updatePdfAnnot,
  deletePdfAnnot,
  savePdfAnnots,
  annotatedPdfBytes,
  exportPdfAnnots,
  bytesToPdfBlob,
  errMsg,
} from '@/services/api';
import { savePdfFile } from '@/services/pdf';
import { docKey, getStash, setStash } from '@/services/annotStash';
import type { AnnotPageInfo, AnnotTool, PdfAnnotation } from '@/types';
import { PALETTE, TEXT_TOOLS, newId, type Tool } from './constants';
import AnnotToolbar from './Toolbar';
import AnnotPage from './AnnotPage';
import AnnotList from './AnnotList';
import AnnotInspector from './AnnotInspector';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

interface Props {
  data: Uint8Array;
  name: string;
  /** 打开时预选的工具（来自阅读器底部工具栏：高亮/下划线/批注/笔记） */
  initialTool?: AnnotTool;
  onClose: () => void;
}

export default function PdfAnnotator({ data, name, initialTool, onClose }: Props) {
  const [annotId, setAnnotId] = useState<string | null>(null);
  const [pages, setPages] = useState<AnnotPageInfo[]>([]);
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([]);
  const [tool, setTool] = useState<Tool>(initialTool ?? 'select');
  const [color, setColor] = useState(PALETTE[0]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [noteEditId, setNoteEditId] = useState<string | null>(null); // 就地编辑中的笔记
  const [flashId, setFlashId] = useState<string | null>(null);
  const [scale, setScale] = useState(1.3);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [banner, setBanner] = useState<{ kind: 'info' | 'ok' | 'warn'; text: string } | null>(null);

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
              kind: 'info',
              text: `已恢复上次的 ${stashed.length} 条批注（未保存到 PDF，记得保存）`,
            });
          }
        } else {
          setAnnotations(res.annotations);
          if (res.annotations.length > 0) {
            setBanner({
              kind: 'info',
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
        type: 'highlight',
        text: '',
        comment: '',
        color,
        rect: null,
        quads: null,
        ink: null,
        created_at: now,
        updated_at: now,
        source: 'user',
        xref: null,
        ...partial,
      };
      setAnnotations((prev) => [...prev, a]);
      if (annotId) addPdfAnnot(annotId, a).catch(() => {});
      return a;
    },
    [annotId, color],
  );

  const patchAnnot = useCallback(
    (id: string, patch: Partial<PdfAnnotation>) => {
      setAnnotations((prev) =>
        prev.map((a) =>
          a.id === id ? { ...a, ...patch, updated_at: new Date().toISOString() } : a,
        ),
      );
      if (annotId) updatePdfAnnot(annotId, id, patch).catch(() => {});
    },
    [annotId],
  );

  const removeAnnot = useCallback(
    (id: string) => {
      setAnnotations((prev) => prev.filter((a) => a.id !== id));
      setSelectedId((cur) => (cur === id ? null : cur));
      if (annotId) deletePdfAnnot(annotId, id).catch(() => {});
    },
    [annotId],
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
        const k = q.map((v) => Math.round(v)).join(',');
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      createAnnot({ page: pno, type: tool as Exclude<Tool, 'select'>, text, quads: unique });
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
        kind: 'warn',
        text: '该 PDF 暂不支持文本选择，可以使用矩形框或画笔批注。',
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
        behavior: 'smooth',
      });
      if (a.type === 'note') {
        openNoteEditor(a.id);
      } else {
        setNoteEditId(null);
        setSelectedId(a.id);
      }
      setFlashId(a.id);
      window.setTimeout(() => setFlashId((cur) => (cur === a.id ? null : cur)), 1600);
    },
    [scale, openNoteEditor],
  );

  // ---- 保存（404 时自动重开会话重试一次）----
  const handleSave = useCallback(async () => {
    if (annotations.length === 0) {
      setBanner({ kind: 'info', text: '尚无批注。先添加批注再保存。' });
      return;
    }
    setSaving(true);
    setBanner({ kind: 'info', text: '正在把批注写入 PDF...' });
    try {
      let id = annotId;
      const doSave = async (sid: string) => {
        const res = await savePdfAnnots(sid, annotations);
        const bytes = await annotatedPdfBytes(sid);
        return { res, bytes };
      };
      let result;
      try {
        if (!id) throw new Error('会话未建立');
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
      const outName = name.replace(/\.pdf$/i, '') + '-annotated.pdf';
      const savedPath = await savePdfFile(result.bytes, outName);
      setBanner({
        kind: 'ok',
        text: savedPath ? result.res.message : `${result.res.message}（已取消另存）`,
      });
    } catch (e) {
      setBanner({ kind: 'warn', text: `批注保存失败，请重试：${errMsg(e)}` });
    } finally {
      setSaving(false);
    }
  }, [annotId, annotations, data, name]);

  // ---- 导出 ----
  const handleExport = useCallback(
    async (fmt: 'json' | 'markdown') => {
      if (!annotId) return;
      try {
        // 先把当前列表推给后端（导出以会话为准）
        await savePdfAnnots(annotId, annotations).catch(() => {});
        const content = await exportPdfAnnots(annotId, fmt);
        await navigator.clipboard.writeText(content);
        setBanner({ kind: 'ok', text: `批注已导出为 ${fmt.toUpperCase()} 并复制到剪贴板` });
      } catch (e) {
        setBanner({ kind: 'warn', text: `导出失败：${errMsg(e)}` });
      }
    },
    [annotId, annotations],
  );

  const selected = annotations.find((a) => a.id === selectedId) ?? null;

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-slate-800/95">
      <AnnotToolbar
        name={name}
        tool={tool}
        color={color}
        scale={scale}
        sidebarOpen={sidebarOpen}
        saving={saving}
        disabled={loading || !!error}
        onPickTool={pickTool}
        onColor={setColor}
        onZoom={(d) => setScale((s) => Math.max(0.6, Math.min(3, s + d)))}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        onSave={handleSave}
        onClose={onClose}
      />

      {/* 提示条 */}
      {banner && (
        <div
          className={`flex items-center gap-2 px-4 py-1.5 text-sm shrink-0 ${
            banner.kind === 'ok'
              ? 'bg-green-50 text-green-700 border-b border-green-200'
              : banner.kind === 'warn'
                ? 'bg-amber-50 text-amber-700 border-b border-amber-200'
                : 'bg-sky-50 text-sky-700 border-b border-sky-200'
          }`}
        >
          <Info size={14} className="shrink-0" />
          <span className="flex-1">{banner.text}</span>
          <button onClick={() => setBanner(null)} className="opacity-60 hover:opacity-100">
            ✕
          </button>
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
              <button onClick={onClose} className="px-3 py-1.5 text-sm bg-white/90 rounded">
                关闭
              </button>
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
      {selected && selected.type !== 'note' && (
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
