// 前端直连用户配置的 LLM（OpenAI 兼容 chat/completions）。
// 用于「术语解释」等后端未提供的能力 —— 不经过本地后端，避免改动后端接口。
//
// 注意：OpenAI 官方域名不支持浏览器 CORS，中转/兼容地址通常支持。
// 连接失败时抛 TermsUnavailableError，UI 据此降级为提示，不影响翻译/总结（仍走后端）。

import type { LLMSettings } from '@/types';

/** 术语解释不可用时抛出（CORS / 网络错误 / 接口非兼容）。 */
export class TermsUnavailableError extends Error {
  constructor(message = '术语解释暂不可用（接口可能不支持浏览器跨域调用）') {
    super(message);
    this.name = 'TermsUnavailableError';
  }
}

const SYSTEM_PROMPT = `你是一名专业术语词典助手。给定一段（可能是科研/技术文献的）原文，请：
1. 识别其中最重要的专业术语（通常 3~8 个，过多则只取最关键）。
2. 用中文给出每个术语的简短解释（1~2 句，面向该文语境）。
3. 若原文为中文，术语保留原文形式并解释；若判断不出明确术语，输出「原文未包含明确的专业术语」。
输出格式为 Markdown 列表：\`- 术语：解释\`。不要输出与术语无关的内容，不要复述原文。`;

/** 调用 chat/completions 生成术语解释，返回 Markdown 文本。 */
export async function explainTerms(
  text: string,
  settings: LLMSettings,
  signal?: AbortSignal,
): Promise<string> {
  if (!settings.apiKey || !settings.baseUrl) {
    throw new TermsUnavailableError('请先在「设置」中配置 API Key 与 Base URL');
  }
  const url = `${settings.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model,
        temperature: 0.2,
        stream: false,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text.slice(0, 4000) },
        ],
      }),
      signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    // 几乎都是 CORS / 网络不通
    throw new TermsUnavailableError();
  }

  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      const data = await resp.json();
      if (data?.error?.message) detail = data.error.message;
      else if (data?.detail) detail = data.detail;
    } catch {
      /* ignore */
    }
    throw new TermsUnavailableError(`术语解释请求失败：${detail}`);
  }

  let data: any;
  try {
    data = await resp.json();
  } catch {
    throw new TermsUnavailableError('术语解释响应解析失败');
  }
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new TermsUnavailableError('术语解释返回为空');
  }
  return content.trim();
}
