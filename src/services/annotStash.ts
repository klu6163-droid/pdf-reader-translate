// PDF 批注会话暂存：内存 Map（应用运行期一直有效）+ 退出时可选持久化。
//
// key = PDF 内容指纹（与标签页/后端会话无关）：同一个文件关掉批注器再开、
// 换标签页重开、甚至「保留」后重启软件再开，都能恢复到上次的批注。
//
// dirty 语义：仅当用户本次会话真正增/删/改过批注才置位；
// 退出时若 dirty，App 弹「是否保留」——保留=写入 localStorage，
// 不保留=不写盘（localStorage 维持启动时的内容）。

import type { PdfAnnotation } from "@/types";

const STORAGE_KEY = "pdf-annot-stash-v1";
const MAX_DOCS = 20; // 持久化时只保留最近 N 个文档的批注，防止无限增长

interface StashEntry {
  annotations: PdfAnnotation[];
  updatedAt: number;
}

const mem = new Map<string, StashEntry>();
let dirty = false;

// 启动时载入上次「保留」的批注
try {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    const obj = JSON.parse(raw) as Record<string, StashEntry>;
    for (const [k, v] of Object.entries(obj)) {
      if (v && Array.isArray(v.annotations)) mem.set(k, v);
    }
  }
} catch {
  /* 数据损坏则忽略，从空开始 */
}

/** 取某文档的暂存批注；无暂存返回 null（注意：空数组也是有效暂存，表示“全删了”）。 */
export function getStash(key: string): PdfAnnotation[] | null {
  return mem.get(key)?.annotations ?? null;
}

/** 写入暂存（用户改动批注时调用），并标记本次会话有未保留的改动。 */
export function setStash(key: string, annotations: PdfAnnotation[]): void {
  mem.set(key, { annotations, updatedAt: Date.now() });
  dirty = true;
}

/** 本次会话是否有增/删/改过批注（决定退出时是否询问）。 */
export function hasDirtyStash(): boolean {
  return dirty;
}

/** 退出时选择「保留」：写入 localStorage，下次启动自动载入。 */
export function persistStash(): void {
  try {
    const entries = Array.from(mem.entries())
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .slice(0, MAX_DOCS);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* 空间不足等异常：放弃持久化，但不阻塞退出 */
  }
  dirty = false;
}

/** 退出时选择「不保留」：本次改动不写盘。 */
export function discardDirtyStash(): void {
  dirty = false;
}

/** 计算 PDF 内容指纹。优先 SHA-256；环境不支持时退化为采样 FNV-1a。 */
export async function docKey(bytes: Uint8Array): Promise<string> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", bytes.slice(0));
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    let h = 0x811c9dc5;
    const step = Math.max(1, Math.floor(bytes.length / 65536));
    for (let i = 0; i < bytes.length; i += step) {
      h ^= bytes[i];
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return `fnv-${bytes.length.toString(16)}-${h.toString(16)}`;
  }
}
