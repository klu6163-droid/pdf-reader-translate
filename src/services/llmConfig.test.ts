import { describe, expect, it } from 'vitest';
import { isQwenMtModel, normalizeLLMRateLimit, QWEN_MT_RATE_LIMIT_PRESET } from './llmConfig';

describe('LLM rate-limit settings', () => {
  it('旧 localStorage 没有限流字段时使用 Qwen-MT 保守预设', () => {
    expect(normalizeLLMRateLimit()).toEqual(QWEN_MT_RATE_LIMIT_PRESET);
  });

  it('越界或非有限数值在发送前被收敛到后端契约范围', () => {
    expect(
      normalizeLLMRateLimit({
        maxConcurrency: 99,
        requestIntervalMs: -1,
        maxRetries: Number.NaN,
        retryBaseSeconds: 0,
      }),
    ).toEqual({
      maxConcurrency: 8,
      requestIntervalMs: 0,
      maxRetries: 5,
      retryBaseSeconds: 0.1,
    });
  });

  it('只把 Qwen-MT 系列识别为专用翻译模型', () => {
    expect(isQwenMtModel(' qwen-mt-plus ')).toBe(true);
    expect(isQwenMtModel('QWEN-MT-TURBO')).toBe(true);
    expect(isQwenMtModel('qwen-plus')).toBe(false);
  });
});
