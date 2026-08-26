import { describe, expect, it } from 'vitest';
import { baseUrlHostname, sanitizeBackendSnapshot } from './diagnostics';

describe('diagnostics privacy boundary', () => {
  it('rebuilds recent translation state from the four allowed metadata fields only', () => {
    const snapshot = sanitizeBackendSnapshot({
      backend_version: '0.2.2',
      os: 'windows',
      arch: 'x86_64',
      pdf2zh_available: true,
      api_key: 'sk-must-not-leak',
      recent_translations: [
        {
          task_id: 'task-1',
          mode: 'pdf',
          duration_ms: 1234,
          succeeded: true,
          original_text: 'unpublished manuscript',
          translated_text: 'internal translation',
          filename: 'secret.pdf',
        },
      ],
    });

    expect(snapshot).toEqual({
      backend_version: '0.2.2',
      os: 'windows',
      arch: 'x86_64',
      pdf2zh_available: true,
      recent_translations: [{ task_id: 'task-1', mode: 'pdf', duration_ms: 1234, succeeded: true }],
    });
    expect(JSON.stringify(snapshot)).not.toContain('unpublished manuscript');
    expect(JSON.stringify(snapshot)).not.toContain('internal translation');
    expect(JSON.stringify(snapshot)).not.toContain('sk-must-not-leak');
  });

  it('keeps only the hostname from a configured Base URL', () => {
    expect(baseUrlHostname('https://user:pass@Gateway.Example.com:8443/private/v1?q=secret')).toBe(
      'gateway.example.com',
    );
    expect(baseUrlHostname('not a URL')).toBeNull();
  });
});
