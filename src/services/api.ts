// 前端 -> Python 后端 的 HTTP 封装。
// 后端固定监听 127.0.0.1:8765。

import type {
  LLMSettings,
  TextTranslateResult,
  PdfProgressEvent,
  AnalyzeResult,
  EditOp,
  SaveEditsResult,
  OpenAnnotResult,
  PdfAnnotation,
  SaveAnnotResult,
} from '@/types';
import { normalizeLLMRateLimit } from '@/services/llmConfig';

const BASE = 'http://127.0.0.1:8765';

/** 后端未连接时抛出的可识别错误，UI 可据此给出「后端正在启动」提示。 */
export class BackendUnreachableError extends Error {
  constructor() {
    super('后端服务尚未就绪，请稍候几秒后重试（若持续未恢复，见顶栏「查看说明」）。');
    this.name = 'BackendUnreachableError';
  }
}

export class TimeoutError extends Error {
  constructor(seconds: number) {
    super(`请求超时（超过 ${seconds} 秒）。可能是网络或上游 API 响应过慢。`);
    this.name = 'TimeoutError';
  }
}

/** 术语解释经本地后端代理失败时的可识别错误。 */
export class TermsUnavailableError extends Error {
  constructor(message = '术语解释暂不可用') {
    super(message);
    this.name = 'TermsUnavailableError';
  }
}

/** 保留非成功响应的状态码，供需要按语义重试的调用方判断。 */
class HttpStatusError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpStatusError';
    this.status = status;
  }
}

/**
 * 统一 fetch 封装：
 * - 带超时（AbortController），避免请求永久挂起
 * - 把底层 "Failed to fetch"（后端没起/端口不通）翻译成可读错误
 */
async function apiFetch(path: string, init: RequestInit = {}, timeoutSec = 60): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
  // 调用方 signal 与超时 controller 必须同时生效：把调用方取消转发到
  // 内部 controller（不用 AbortSignal.any——tsconfig lib 为 ES2020，缺类型声明）。
  // 旧写法 `init.signal ?? controller.signal` 会让超时在调用方传 signal 时失效。
  if (init.signal) {
    if (init.signal.aborted) controller.abort();
    else init.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  try {
    return await fetch(`${BASE}${path}`, {
      ...init,
      signal: controller.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
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
  return new Blob([copy.buffer], { type: 'application/pdf' });
}

/** 测试 API 配置连通性 */
export async function testSettings(
  settings: LLMSettings,
): Promise<{ ok: boolean; message: string }> {
  try {
    const resp = await apiFetch(
      '/api/settings/test',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: toConfig(settings) }),
      },
      35,
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
  targetLang = '中文',
  signal?: AbortSignal,
): Promise<TextTranslateResult> {
  const resp = await apiFetch(
    '/api/translate/text',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        source_lang: 'auto',
        target_lang: targetLang,
        config: toConfig(settings),
      }),
      signal,
    },
    90,
  );
  if (!resp.ok) throw new Error(await safeDetail(resp));
  return resp.json();
}

/** 通过本地后端代理生成术语解释，浏览器不再直连用户配置的 LLM。 */
export async function explainTerms(
  text: string,
  settings: LLMSettings,
  signal?: AbortSignal,
): Promise<string> {
  if (!settings.apiKey || !settings.baseUrl) {
    throw new TermsUnavailableError('请先在「设置」中配置 API Key 与 Base URL');
  }
  let resp: Response;
  try {
    resp = await apiFetch(
      '/api/translate/terms',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.slice(0, 4000), config: toConfig(settings) }),
        signal,
      },
      90,
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new TermsUnavailableError(errMsg(error));
  }
  if (!resp.ok) throw new TermsUnavailableError(`术语解释请求失败：${await safeDetail(resp)}`);
  const data: unknown = await resp.json();
  const terms =
    data && typeof data === 'object' && 'terms' in data
      ? (data as { terms?: unknown }).terms
      : undefined;
  if (typeof terms !== 'string' || !terms.trim()) {
    throw new TermsUnavailableError('术语解释返回为空');
  }
  return terms.trim();
}

/** 启动 PDF 全文翻译，返回 task_id */
export async function startPdfTranslate(
  file: File | Blob,
  filename: string,
  settings: LLMSettings,
  targetLang = 'zh',
): Promise<string> {
  const form = new FormData();
  form.append('file', file, filename);
  form.append('target_lang', targetLang);

  const resp = await apiFetch(
    '/api/translate/pdf/start',
    { method: 'POST', body: form, headers: llmHeaders(settings) },
    120,
  );
  if (!resp.ok) throw new Error(await safeDetail(resp));
  const data = await resp.json();
  return data.task_id;
}

/**
 * 共用：带指数退避重连的进度 SSE 订阅。
 * 后端 /progress 对（重）订阅会重放 last_event，重连不丢进度；
 * 一次瞬时抖动（休眠/唤醒）不该让前端永久显示「连接中断」。
 */
function subscribeProgressSse(
  url: string,
  onEvent: (e: PdfProgressEvent) => void,
  onError?: (err: Error) => void,
): () => void {
  let es: EventSource | null = null;
  let stopped = false;
  let attempts = 0;
  let timer: number | undefined;

  const stop = () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    es?.close();
    es = null;
  };

  const connect = () => {
    if (stopped) return;
    es = new EventSource(url);
    es.onopen = () => {
      attempts = 0;
    };
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data) as PdfProgressEvent;
        onEvent(data);
        if (data.done) stop();
      } catch {
        /* ignore */
      }
    };
    es.onerror = () => {
      es?.close();
      es = null;
      if (stopped) return;
      if (attempts >= 8) {
        stop();
        onError?.(new Error('进度连接中断'));
        return;
      }
      // 指数退避：1s → 2s → 4s → 8s（封顶），最多重试 8 次
      const delay = Math.min(1000 * 2 ** attempts, 8000);
      attempts += 1;
      timer = window.setTimeout(connect, delay);
    };
  };

  connect();
  return stop;
}

/** 监听全文翻译进度（SSE） */
export function subscribePdfProgress(
  taskId: string,
  onEvent: (e: PdfProgressEvent) => void,
  onError?: (err: Error) => void,
): () => void {
  return subscribeProgressSse(`${BASE}/api/translate/pdf/progress/${taskId}`, onEvent, onError);
}

/** 获取翻译结果 PDF 的 URL */
export function pdfResultUrl(taskId: string): string {
  return `${BASE}/api/translate/pdf/result/${taskId}`;
}

// ---- 覆盖翻译（跳过 pdf2zh）----

/** 启动覆盖翻译，返回 task_id */
export async function startOverlayTrans(
  file: File | Blob,
  filename: string,
  settings: LLMSettings,
): Promise<string> {
  const form = new FormData();
  form.append('file', file, filename);
  const resp = await apiFetch(
    '/api/overlay/pdf/start',
    { method: 'POST', body: form, headers: llmHeaders(settings) },
    120,
  );
  if (!resp.ok) throw new Error(await safeDetail(resp));
  const data = await resp.json();
  return data.task_id;
}

/** 监听覆盖翻译进度（SSE） */
export function subscribeOverlayProgress(
  taskId: string,
  onEvent: (e: PdfProgressEvent) => void,
  onError?: (err: Error) => void,
): () => void {
  return subscribeProgressSse(`${BASE}/api/overlay/pdf/progress/${taskId}`, onEvent, onError);
}

/** 获取覆盖翻译结果 PDF 的 URL */
export function overlayResultUrl(taskId: string): string {
  return `${BASE}/api/overlay/pdf/result/${taskId}`;
}

/** 文献总结（SSE 流式），通过 fetch + ReadableStream 读取 */
export async function streamSummary(
  file: File | Blob,
  filename: string,
  settings: LLMSettings,
  onDelta: (text: string) => void,
  onDone: () => void,
  onError: (err: string) => void,
): Promise<void> {
  const form = new FormData();
  form.append('file', file, filename);

  let resp: Response;
  try {
    resp = await apiFetch(
      '/api/summary/stream',
      { method: 'POST', body: form, headers: llmHeaders(settings) },
      300,
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
    onError('无法读取响应流');
    return;
  }
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n\n');
      buffer = lines.pop() ?? '';
      for (const block of lines) {
        const line = block.trim();
        if (!line.startsWith('data:')) continue;
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
  } catch (e) {
    // 流中途断开（休眠/网络）时 reader.read() 会 reject：
    // 必须转成 onError，否则调用方的 summaryRunning 永久卡在「生成中」
    onError(e instanceof Error ? e.message : '总结流中断');
    return;
  }
  onDone();
}

// ---- PDF 文本块编辑 ----

/** 上传 PDF 解析文本块，返回 edit_id + 每页文本块 + 预测编辑模式。 */
export async function analyzePdfForEdit(
  file: File | Blob,
  filename: string,
): Promise<AnalyzeResult> {
  const form = new FormData();
  form.append('file', file, filename);
  const resp = await apiFetch('/api/edit/pdf/analyze', { method: 'POST', body: form }, 120);
  if (!resp.ok) throw new Error(await safeDetail(resp));
  return resp.json();
}

/** 应用编辑并另存为新 PDF，返回实际模式与友好提示。 */
export async function savePdfEdits(editId: string, edits: EditOp[]): Promise<SaveEditsResult> {
  const resp = await apiFetch(
    '/api/edit/pdf/save',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ edit_id: editId, edits }),
    },
    120,
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

// ---- PDF 批注 ----

/** 上传 PDF 建立批注会话，返回 annot_id + 页尺寸 + PDF 内已有批注。 */
export async function openPdfAnnot(file: File | Blob, filename: string): Promise<OpenAnnotResult> {
  const form = new FormData();
  form.append('file', file, filename);
  const resp = await apiFetch('/api/annot/pdf/open', { method: 'POST', body: form }, 120);
  if (!resp.ok) throw new Error(await safeDetail(resp));
  return resp.json();
}

/** 新增一条批注（同步到后端会话）。 */
export async function addPdfAnnot(
  annotId: string,
  annot: Partial<PdfAnnotation>,
): Promise<PdfAnnotation> {
  const resp = await apiFetch(
    `/api/annot/pdf/${annotId}/annotations`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(annot),
    },
    30,
  );
  if (!resp.ok) throw new Error(await safeDetail(resp));
  return resp.json();
}

/** 更新批注（注释/颜色等）。 */
export async function updatePdfAnnot(
  annotId: string,
  aid: string,
  patch: Partial<PdfAnnotation>,
): Promise<PdfAnnotation> {
  const resp = await apiFetch(
    `/api/annot/pdf/${annotId}/annotations/${aid}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    },
    30,
  );
  if (!resp.ok) throw new Error(await safeDetail(resp));
  return resp.json();
}

/** 删除批注。 */
export async function deletePdfAnnot(annotId: string, aid: string): Promise<void> {
  const resp = await apiFetch(
    `/api/annot/pdf/${annotId}/annotations/${aid}`,
    { method: 'DELETE' },
    30,
  );
  if (!resp.ok) throw new Error(await safeDetail(resp));
}

/** 把批注写入 PDF 副本并生成 annotated.pdf（body 传完整列表，前端为准）。 */
export async function savePdfAnnots(
  annotId: string,
  annotations: PdfAnnotation[],
): Promise<SaveAnnotResult> {
  const resp = await apiFetch(
    `/api/annot/pdf/${annotId}/save`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ annotations }),
    },
    120,
  );
  if (!resp.ok) throw new HttpStatusError(resp.status, await safeDetail(resp));
  return resp.json();
}

/** 拉取批注后的新 PDF 字节。 */
export async function annotatedPdfBytes(annotId: string): Promise<Uint8Array> {
  const resp = await apiFetch(`/api/annot/pdf/${annotId}/result`, {}, 60);
  if (!resp.ok) throw new HttpStatusError(resp.status, await safeDetail(resp));
  return new Uint8Array(await resp.arrayBuffer());
}

/** 导出批注列表（json / markdown），返回文本内容。 */
export async function exportPdfAnnots(
  annotId: string,
  format: 'json' | 'markdown',
): Promise<string> {
  const resp = await apiFetch(`/api/annot/pdf/${annotId}/export?format=${format}`, {}, 30);
  if (!resp.ok) throw new Error(await safeDetail(resp));
  return resp.text();
}

function llmHeaders(s: LLMSettings): Record<string, string> {
  const rateLimit = normalizeLLMRateLimit(s.rateLimit);
  return {
    'x-llm-api-key': s.apiKey,
    'x-llm-base-url': s.baseUrl,
    'x-llm-model': s.model,
    'x-llm-max-concurrency': String(rateLimit.maxConcurrency),
    'x-llm-request-interval-ms': String(rateLimit.requestIntervalMs),
    'x-llm-max-retries': String(rateLimit.maxRetries),
    'x-llm-retry-base-seconds': String(rateLimit.retryBaseSeconds),
  };
}

function toConfig(s: LLMSettings) {
  const rateLimit = normalizeLLMRateLimit(s.rateLimit);
  return {
    api_key: s.apiKey,
    base_url: s.baseUrl,
    model: s.model,
    max_concurrency: rateLimit.maxConcurrency,
    request_interval_ms: rateLimit.requestIntervalMs,
    max_retries: rateLimit.maxRetries,
    retry_base_seconds: rateLimit.retryBaseSeconds,
  };
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
