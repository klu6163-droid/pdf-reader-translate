// 标注烧录 + 保存逻辑。
// burnAnnotations：用 pdf-lib 把标注画进 PDF 字节（坐标从页面相对值转为 PDF 坐标）。
// savePdfWithAnnotations：取该 PDF 的标注，烧录后另存为副本，成功则清 dirty。

import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import type { Annotation } from "@/types";
import { savePdfFile } from "@/services/pdf";
import { useAnnotations } from "@/store/useAnnotations";

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "");
  const v = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(v, 16);
  if (Number.isNaN(n)) return { r: 1, g: 0.84, b: 0 }; // 兜底黄
  return {
    r: ((n >> 16) & 255) / 255,
    g: ((n >> 8) & 255) / 255,
    b: (n & 255) / 255,
  };
}

/**
 * 把标注烧录进 PDF 字节。无标注时原样返回。
 * 坐标转换：标注用页面相对值（0~1，y 向下）；PDF 坐标左下原点、y 向上。
 */
export async function burnAnnotations(
  pdfBytes: Uint8Array,
  annotations: Annotation[]
): Promise<Uint8Array> {
  if (!annotations.length) return pdfBytes;
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();

  for (const a of annotations) {
    const page = pages[a.page - 1];
    if (!page) continue;
    const W = page.getWidth();
    const H = page.getHeight();
    const c = hexToRgb(a.color);
    const color = rgb(c.r, c.g, c.b);

    if (a.type === "highlight") {
      const w = (a.w || 0) * W;
      const h = (a.h || 0) * H;
      const x = (a.x || 0) * W;
      const y = H - (a.y || 0) * H - h; // 顶左 → PDF 左下
      page.drawRectangle({ x, y, width: w, height: h, color, opacity: 0.4 });
    } else if (a.type === "draw" && a.points && a.points.length > 1) {
      const pts = a.points.map((p) => ({ x: p.x * W, y: H - p.y * H }));
      for (let i = 1; i < pts.length; i++) {
        page.drawLine({
          start: pts[i - 1],
          end: pts[i],
          thickness: 1.5,
          color,
        });
      }
    } else if (a.type === "note" && a.text) {
      const x = (a.x || 0) * W;
      const y = H - (a.y || 0) * H;
      page.drawRectangle({ x: x - 2, y: y - 8, width: 4, height: 10, color });
      page.drawText(a.text, {
        x: x + 6,
        y: y - 6,
        size: 10,
        font,
        color,
        maxWidth: Math.max(50, W - x - 12),
      });
    }
  }

  return await doc.save();
}

/**
 * 取该 PDF 的标注，烧录后另存为副本。成功则标记该 PDF 为已保存（清 dirty）。
 * 返回保存路径；用户取消则 null。
 */
export async function savePdfWithAnnotations(
  pdfId: string,
  pdfBytes: Uint8Array,
  suggestedName: string
): Promise<string | null> {
  const anns = useAnnotations.getState().getAnnotations(pdfId);
  let bytes = pdfBytes;
  if (anns.length) {
    bytes = await burnAnnotations(pdfBytes, anns);
  }
  const path = await savePdfFile(bytes, suggestedName);
  if (path) useAnnotations.getState().markClean(pdfId);
  return path;
}
