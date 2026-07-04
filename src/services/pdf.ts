// 本地 PDF 文件读取 —— 走 Tauri Rust command（read_pdf_file），
// 不依赖 tauri-plugin-fs 的 scope 配置，可读任意本地路径。
// 纯浏览器（非 Tauri）环境下这些调用会失败，由调用方降级处理。

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { save } from "@tauri-apps/plugin-dialog";

/** 通过 Rust command 读取本地 PDF，返回字节。 */
export async function readPdfFile(path: string): Promise<Uint8Array> {
  // Rust 返回 Vec<u8> → 前端拿到 number[]
  const bytes = await invoke<number[]>("read_pdf_file", { path });
  return new Uint8Array(bytes);
}

/** 从路径中取文件名。 */
export function basename(path: string): string {
  return path.split(/[\\/]/).pop() || "document.pdf";
}

/**
 * 把 PDF 字节保存到本地（导出/另存）。
 * Tauri：save 对话框选路径 + write_file command 落盘；返回保存路径，取消则 null。
 * 非 Tauri（浏览器 dev）：降级为触发浏览器下载。
 */
export async function savePdfFile(
  data: Uint8Array,
  suggestedName: string
): Promise<string | null> {
  // 复制一份，避免序列化原 buffer
  const copy = new Uint8Array(data.length);
  copy.set(data);
  try {
    const path = await save({
      defaultPath: suggestedName,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!path) return null; // 用户取消
    await invoke<void>("write_file", { path, data: Array.from(copy) });
    return path;
  } catch {
    // 非 Tauri 环境降级：浏览器下载
    const blob = new Blob([copy], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = suggestedName;
    a.click();
    URL.revokeObjectURL(url);
    return null;
  }
}

export interface DragDropCallbacks {
  onEnter: () => void;
  onLeave: () => void;
  /** paths 为拖入的所有文件路径（已由调用方过滤前的原始列表）。 */
  onDrop: (paths: string[]) => void;
}

/**
 * 监听 Tauri 原生拖放事件（HTML5 ondrop 在 Tauri 下不触发）。
 * 返回取消监听的函数。非 Tauri 环境下返回空函数。
 */
export async function listenDragDrop(
  cb: DragDropCallbacks
): Promise<() => void> {
  try {
    const webview = getCurrentWebview();
    const unlisten = await webview.onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === "enter") cb.onEnter();
      else if (p.type === "leave") cb.onLeave();
      else if (p.type === "drop") {
        cb.onLeave();
        cb.onDrop(p.paths);
      }
    });
    return unlisten;
  } catch {
    // 非 Tauri 环境（纯浏览器 dev）
    return () => {};
  }
}
