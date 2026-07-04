// 前端 -> Python 后端 的 HTTP 封装。
// 后端固定监听 127.0.0.1:8765。

import type {
  LLMSettings,
  TextTranslateResult,
  PdfProgressEvent,
  AnalyzeResult,
  EditOp,
  SaveEditsResult,
} from "@/types";

const BASE = "http://127.0.0.1:8765";

/** 后端未连接时抛出的可识别错误，UI 可据此给出「请先启动后端」提示。 */
export class BackendUnreachableError extends Error {
  constructor() {
    super(
      "无法连接本地后端服务（127.0.0.1:8765）。请确认后端已启动：cd backend && python start.py"
    );
    this.name = "BackendUnreachableError";
  }
}

export class TimeoutError extends Error {
  constructor(seconds: number) {
    super(`请求超时（超过 ${seconds} 秒）。可能是网络或上游 API 响应过慢。`);
    this.name = "TimeoutError";
  }
}

/**
 * 统一 fetch 封装：
 * - 带超时（AbortController），避免请求永久挂起
 * - 把底层 "Failed to fetch"（后端没起/端口不通）翻译成可读错误
 */
async function apiFetch(
  path: string,
  init: RequestInit = {},
  timeoutSec = 60
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
  try {
    return await fetch(`${BASE}${path}`, {
      ...init,
      signal: init.signal ?? controller.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      if (init.signal?.aborted) throw e;
      throw new TimeoutError(timeoutSec);
    }
    throw new BackendUnreachableError();
  } finally {
    clearTimeout(timer);
  }
}

/** 探测后端是否可用（供 App 启动时轮询用）。 */
export async function checkBackend(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const resp = await fetch(`${BASE}/api/health`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    return resp.ok;
  } catch {
    return false;
  }
}

/** 把 PDF 字节安全地包成 Blob。 */
export function bytesToPdfBlob(data: Uint8Array): Blob {
  const copy = new Uint8Array(data.length);
  copy.set(data);
  return new Blob([copy.buffer], { type: "application/pdf" });
}

/** 测试 API 配置连通性 */
export async function testSettings(
  settings: LLMSettings
): Promise<{ ok: boolean; message: string }> {
  try {
    const resp = await apiFetch(
      "/api/settings/test",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: toConfig(settings) }),
      },
      35
    );
    if (!resp.ok) return { ok: false, message: `HTTP ${resp.status}` };
    return resp.json();
  } catch (e) {
    return { ok: false, message: errMsg(e) };
  }
}

/** 划词 / 划段落翻译。可传 signal 以支持取消。 */
export async function translateText(
  text: string,
  settings: LLMSettings,
  targetLang = "中文",
  signal?: AbortSignal
): Promise<TextTranslateResult> {
  const resp = await apiFetch(
    "/api/translate/text",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        source_lang: "auto",
        target_lang: targetLang,
        config: toConfig(settings),
      }),
      signal,
    },
    90
  );
  if (!resp.ok) throw new Error(await safeDetail(resp));
  return resp.json();
}

/** 启动 PDF 全文翻译，返回 task_id */
export async function startPdfTranslate(
  file: File | Blob,
  filename: string,
  settings: LLMSettings,
  targetLang = "zh"
): Promise<string> {
  const form = new FormData();
  form.append("file", file, filename);
  form.append("target_lang", targetLang);

  const resp = await apiFetch(
    "/api/translate/pdf/start",
    { method: "POST", body: form, headers: llmHeaders(settings) },
    120
  );
  if (!resp.ok) throw new Error(await safeDetail(resp));
  const data = await resp.json();
  return data.task_id;
}

/** 监听全文翻译进度（SSE） */
export function subscribePdfProgress(
  taskId: string,
  onEvent: (e: PdfProgressEvent) => void,
  onError?: (err: Error) => void
): () => void {
  const es = new EventSource(`${BASE}/api/translate/pdf/progress/${taskId}`);
  es.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data) as PdfProgressEvent;
      onEvent(data);
      if (data.done) es.close();
    } catch {
      /* ignore */
    }
  };
  es.onerror = () => {
    es.close();
    onError?.(new Error("进度连接中断"));
  };
  return () => es.close();
}

/** 获取翻译结果 PDF 的 URL */
export function pdfResultUrl(taskId: string): string {
  return `${BASE}/api/translate/pdf/result/${taskId}`;
}

/** 文献总结（SSE 流式），通过 fetch + ReadableStream 读取 */
export async function streamSummary(
  file: File | Blob,
  filename: string,
  settings: LLMSettings,
  onDelta: (text: string) => void,
  onDone: () => void,
  onError: (err: string) => void
): Promise<void> {
  const form = new FormData();
  form.append("file", file, filename);

  let resp: Response;
  try {
    resp = await apiFetch(
      "/api/summary/stream",
      { method: "POST", body: form, headers: llmHeaders(settings) },
      300
    );
  } catch (e) {
    onError(errMsg(e));
    return;
  }
  if (!resp.ok) {
    onError(await safeDetail(resp));
    return;
  }
  const reader = resp.body?.getReader();
  if (!reader) {
    onError("无法读取响应流");
    return;
  }
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n\n");
    buffer = lines.pop() ?? "";
    for (const block of lines) {
      const line = block.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      try {
        const obj = JSON.parse(payload);
        if (obj.error) {
          onError(obj.error);
          return;
        }
        if (obj.delta) onDelta(obj.delta);
        if (obj.done) {
          onDone();
          return;
        }
      } catch {
        /* ignore partial */
      }
    }
  }
  onDone();
}

// ---- PDF 文本块编辑 ----

/** 上传 PDF 解析文本块，返回 edit_id + 每页文本块 + 预测编辑模式。 */
export async function analyzePdfForEdit(
  file: File | Blob,
  filename: string
): Promise<AnalyzeResult> {
  const form = new FormData();
  form.append("file", file, filename);
  const resp = await apiFetch(
    "/api/edit/pdf/analyze",
    { method: "POST", body: form },
    120
  );
  if (!resp.ok) throw new Error(await safeDetail(resp));
  return resp.json();
}

/** 应用编辑并另存为新 PDF，返回实际模式与友好提示。 */
export async function savePdfEdits(
  editId: string,
  edits: EditOp[]
): Promise<SaveEditsResult> {
  const resp = await apiFetch(
    "/api/edit/pdf/save",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edit_id: editId, edits }),
    },
    120
  );
  if (!resp.ok) throw new Error(await safeDetail(resp));
  return resp.json();
}

/** 拉取编辑后的新 PDF 字节（供另存 / 预览）。 */
export async function editedPdfBytes(editId: string): Promise<Uint8Array> {
  const resp = await apiFetch(`/api/edit/pdf/result/${editId}`, {}, 60);
  if (!resp.ok) throw new Error(await safeDetail(resp));
  return new Uint8Array(await resp.arrayBuffer());
}

function llmHeaders(s: LLMSettings): Record<string, string> {
  return {
    "x-llm-api-key": s.apiKey,
    "x-llm-base-url": s.baseUrl,
    "x-llm-model": s.model,
  };
}

function toConfig(s: LLMSettings) {
  return { api_key: s.apiKey, base_url: s.baseUrl, model: s.model };
}

/** 把任意 error 转成可读中文提示。 */
export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

async function safeDetail(resp: Response): Promise<string> {
  try {
    const data = await resp.json();
    return data.detail || `HTTP ${resp.status}`;
  } catch {
    return `HTTP ${resp.status}`;
  }
}
