import type { LLMRateLimitSettings } from '@/types';

/**
 * Qwen-MT-Plus 防 429 的保守默认值：约 54 次请求/分钟，低于常见的 60 RPM 限额。
 * 用户可在设置页按自己账号的实际配额调整。
 */
export const QWEN_MT_RATE_LIMIT_PRESET: Readonly<LLMRateLimitSettings> = {
  maxConcurrency: 1,
  requestIntervalMs: 1100,
  maxRetries: 5,
  retryBaseSeconds: 2,
};

export const DEFAULT_LLM_RATE_LIMIT = QWEN_MT_RATE_LIMIT_PRESET;

export function normalizeLLMRateLimit(value?: Partial<LLMRateLimitSettings>): LLMRateLimitSettings {
  return {
    maxConcurrency: clampInteger(value?.maxConcurrency, 1, 8, 1),
    requestIntervalMs: clampInteger(value?.requestIntervalMs, 0, 60000, 1100),
    maxRetries: clampInteger(value?.maxRetries, 0, 10, 5),
    retryBaseSeconds: clampNumber(value?.retryBaseSeconds, 0.1, 60, 2),
  };
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number) {
  return Math.round(clampNumber(value, min, max, fallback));
}

function clampNumber(value: number | undefined, min: number, max: number, fallback: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
