// 本地 PDF 文件读取 —— 走 Tauri Rust command（read_pdf_file），
// 不依赖 tauri-plugin-fs 的 scope 配置，可读任意本地路径。
// 纯浏览器（非 Tauri）环境下这些调用会失败，由调用方降级处理。

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";

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
