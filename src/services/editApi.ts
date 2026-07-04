// 编辑导出 API：把 EditState 发给后端，后端用 PyMuPDF 应用编辑后返回新 PDF 字节。
// 与翻译 API 完全独立（不同路由，不带 API Key）。

import type { EditState } from "@/types/editTypes";

const BASE = "http://127.0.0.1:8765";

/** 应用编辑到 PDF，返回编辑后的 PDF 字节。 */
export async function exportEditedPdf(
  pdfBytes: Uint8Array,
  edits: EditState
): Promise<Uint8Array> {
  const form = new FormData();
  const blob = new Blob([pdfBytes.slice()], { type: "application/pdf" });
  form.append("file", blob, "source.pdf");
  form.append("edits", JSON.stringify(edits));

  const resp = await fetch(`${BASE}/api/pdf/edit/export`, {
    method: "POST",
    body: form,
  });
  if (!resp.ok) {
    let detail = "";
    try {
      const data = await resp.json();
      detail = data.detail || "";
    } catch {
      detail = await resp.text().catch(() => "");
    }
    throw new Error(`导出失败: HTTP ${resp.status} ${String(detail).slice(0, 200)}`);
  }
  return new Uint8Array(await resp.arrayBuffer());
}
