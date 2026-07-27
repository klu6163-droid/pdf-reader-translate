// 单页渲染：pdf.js canvas + textLayer + 批注覆盖层 + 绘制捕获层
import { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { r2, type Tool } from './constants';
import AnnotOverlay from './AnnotOverlay';
import NoteBubble from './NoteBubble';
import type { AnnotPageInfo, PdfAnnotation } from '@/types';

interface Props {
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

export default function AnnotPage({
  pdfDoc,
  info,
  scale,
  tool,
  color,
  annotations,
  selectedId,
  noteEditId,
  flashId,
  onSelect,
  onOpenNote,
  onCloseNote,
  onCreate,
  onPatch,
  onRemove,
  registerEl,
  reportHasText,
}: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const renderedForScaleRef = useRef<number | null>(null);

  // 拖拽矩形 / 画笔中间态（CSS px）
  const [draft, setDraft] = useState<
    | { kind: 'rect'; x0: number; y0: number; x1: number; y1: number }
    | { kind: 'ink'; points: [number, number][] }
    | null
  >(null);

  const w = info.width * scale;
  const h = info.height * scale;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (es) => es.forEach((en) => en.isIntersecting && setVisible(true)),
      { rootMargin: '700px 0px' },
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
        const ctx = canvas.getContext('2d');
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
          textLayerDiv.style.setProperty('--scale-factor', String(viewport.scale));
          const lib = pdfjsLib as any;
          if (typeof lib.TextLayer === 'function') {
            await new lib.TextLayer({
              textContentSource: textContent,
              container: textLayerDiv,
              viewport,
            }).render();
          } else if (typeof lib.renderTextLayer === 'function') {
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
    if (tool === 'note') {
      const [x, y] = toLocal(e);
      const px = x / scale;
      const py = y / scale;
      const a = onCreate({
        page: info.page,
        type: 'note',
        color,
        rect: [r2(px), r2(py), r2(px + 18), r2(py + 18)],
      });
      onOpenNote(a.id); // 落点处直接弹输入气泡开始打字
      return;
    }
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const [x, y] = toLocal(e);
    if (tool === 'rectangle') setDraft({ kind: 'rect', x0: x, y0: y, x1: x, y1: y });
    else if (tool === 'ink') setDraft({ kind: 'ink', points: [[x, y]] });
  };

  const onCapturePointerMove = (e: React.PointerEvent) => {
    if (!draft) return;
    const [x, y] = toLocal(e);
    if (draft.kind === 'rect') setDraft({ ...draft, x1: x, y1: y });
    else setDraft({ kind: 'ink', points: [...draft.points, [x, y]] });
  };

  const onCapturePointerUp = () => {
    if (!draft) return;
    if (draft.kind === 'rect') {
      const x0 = Math.min(draft.x0, draft.x1) / scale;
      const y0 = Math.min(draft.y0, draft.y1) / scale;
      const x1 = Math.max(draft.x0, draft.x1) / scale;
      const y1 = Math.max(draft.y0, draft.y1) / scale;
      if (x1 - x0 >= 4 && y1 - y0 >= 4) {
        onCreate({
          page: info.page,
          type: 'rectangle',
          color,
          rect: [r2(x0), r2(y0), r2(x1), r2(y1)],
        });
      }
    } else if (draft.kind === 'ink' && draft.points.length >= 2) {
      const stroke = draft.points.map(
        ([x, y]) => [r2(x / scale), r2(y / scale)] as [number, number],
      );
      onCreate({ page: info.page, type: 'ink', color, ink: [stroke] });
    }
    setDraft(null);
  };

  const captureActive = tool === 'note' || tool === 'rectangle' || tool === 'ink';
  const overlayInteractive = tool === 'select';

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
      <div ref={textLayerRef} className="textLayer" style={{ width: w, height: h }} />
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
          onSelect={() => (a.type === 'note' ? onOpenNote(a.id) : onSelect(a.id))}
        />
      ))}

      {/* 笔记就地输入气泡（跟随落点） */}
      {(() => {
        const editing = annotations.find((a) => a.id === noteEditId && a.type === 'note');
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
          style={{ cursor: tool === 'note' ? 'copy' : 'crosshair', touchAction: 'none' }}
          onPointerDown={onCapturePointerDown}
          onPointerMove={onCapturePointerMove}
          onPointerUp={onCapturePointerUp}
        />
      )}

      {/* 拖拽中的预览 */}
      {draft?.kind === 'rect' && (
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
      {draft?.kind === 'ink' && (
        <svg className="absolute inset-0 z-10 pointer-events-none" width={w} height={h}>
          <polyline
            points={draft.points.map((p) => p.join(',')).join(' ')}
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
