import { afterEach, describe, expect, it, vi } from 'vitest';
import { explainTerms, TermsUnavailableError } from './api';

const settings = {
  apiKey: 'sk-test-only',
  baseUrl: 'https://upstream.example/private/v1',
  model: 'fake-model',
  rateLimit: {
    maxConcurrency: 2,
    requestIntervalMs: 750,
    maxRetries: 3,
    retryBaseSeconds: 1.5,
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('explainTerms backend proxy', () => {
  it('posts only to the local backend and returns its typed payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ terms: '- polymer：聚合物', model: 'fake-model' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(explainTerms('polymer', settings)).resolves.toBe('- polymer：聚合物');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8765/api/translate/terms');
    expect(url).not.toContain(settings.baseUrl);
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(String(init.body))).toEqual({
      text: 'polymer',
      config: {
        api_key: settings.apiKey,
        base_url: settings.baseUrl,
        model: settings.model,
        max_concurrency: 2,
        request_interval_ms: 750,
        max_retries: 3,
        retry_base_seconds: 1.5,
      },
    });
  });

  it('turns a backend upstream error into the existing friendly error type', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: '上游术语服务失败' }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    await expect(explainTerms('polymer', settings)).rejects.toEqual(
      new TermsUnavailableError('术语解释请求失败：上游术语服务失败'),
    );
  });
});
