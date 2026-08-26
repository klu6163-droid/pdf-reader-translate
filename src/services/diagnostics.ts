import type { ErrorInfo } from 'react';
import type { LLMSettings } from '@/types';

const DIAGNOSTIC_STATUS_URL = 'http://127.0.0.1:8765/api/diagnostics/status';

export interface RecentTranslationStatus {
  task_id: string;
  mode: string;
  duration_ms: number | null;
  succeeded: boolean | null;
}

export interface BackendDiagnosticSnapshot {
  backend_version: string;
  os: string;
  arch: string;
  pdf2zh_available: boolean;
  recent_translations: RecentTranslationStatus[];
}

/** Rebuild the response with an allowlist; document text and unexpected fields cannot pass. */
export function sanitizeBackendSnapshot(value: unknown): BackendDiagnosticSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  const recent = Array.isArray(source.recent_translations) ? source.recent_translations : [];
  return {
    backend_version:
      typeof source.backend_version === 'string' ? source.backend_version.slice(0, 32) : '',
    os: typeof source.os === 'string' ? source.os.slice(0, 64) : '',
    arch: typeof source.arch === 'string' ? source.arch.slice(0, 64) : '',
    pdf2zh_available: source.pdf2zh_available === true,
    recent_translations: recent.slice(0, 20).map((item) => {
      const record = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
      return {
        task_id: typeof record.task_id === 'string' ? record.task_id.slice(0, 64) : '',
        mode: typeof record.mode === 'string' ? record.mode.slice(0, 32) : '',
        duration_ms: typeof record.duration_ms === 'number' ? record.duration_ms : null,
        succeeded: typeof record.succeeded === 'boolean' ? record.succeeded : null,
      };
    }),
  };
}

export function baseUrlHostname(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

async function fetchBackendSnapshot(): Promise<BackendDiagnosticSnapshot | null> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(DIAGNOSTIC_STATUS_URL, { signal: controller.signal });
    if (!response.ok) return null;
    return sanitizeBackendSnapshot(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function timestampedName(): string {
  return `diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
}

function browserDownload(value: unknown, name: string): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function exportDiagnosticBundle(
  translateSettings: LLMSettings,
  summarySettings: LLMSettings,
): Promise<string> {
  const backendSnapshot = await fetchBackendSnapshot();
  const baseUrls = [translateSettings.baseUrl, summarySettings.baseUrl].filter(Boolean);
  const hosts = baseUrls.map(baseUrlHostname).filter((host): host is string => host !== null);
  const name = timestampedName();

  if (!('__TAURI_INTERNALS__' in window)) {
    browserDownload(
      {
        schema_version: 1,
        generated_at: new Date().toISOString(),
        app: { version: 'browser-dev', os: navigator.platform, arch: 'unknown' },
        base_url_hosts: [...new Set(hosts)],
        backend: backendSnapshot,
        logs: null,
      },
      name,
    );
    return name;
  }

  const [{ invoke }, { save }] = await Promise.all([
    import('@tauri-apps/api/core'),
    import('@tauri-apps/plugin-dialog'),
  ]);
  const path = await save({
    defaultPath: name,
    filters: [{ name: '诊断信息', extensions: ['json'] }],
  });
  if (!path) return '';
  return invoke<string>('export_diagnostics', {
    request: {
      path,
      backendSnapshot,
      baseUrls,
      // Secrets are used only for in-memory exact replacement and are never serialized.
      redactSecrets: [translateSettings.apiKey, summarySettings.apiKey].filter(Boolean),
    },
  });
}

export function formatFrontendCrash(error: Error, info: ErrorInfo): string {
  return `${new Date().toISOString()} ERROR frontend.crash\nmessage=${error.message}\nstack=${error.stack ?? ''}\ncomponent_stack=${info.componentStack ?? ''}\n`;
}

export async function recordFrontendCrash(error: Error, info: ErrorInfo): Promise<string> {
  if (!('__TAURI_INTERNALS__' in window)) {
    const report = formatFrontendCrash(error, info);
    localStorage.setItem('pdf-reader-translate-frontend-crash', report);
    return '';
  }
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string>('record_frontend_crash', {
    message: error.message,
    stack: error.stack ?? '',
    componentStack: info.componentStack ?? '',
  });
}

export function downloadFrontendCrash(report: string): void {
  const blob = new Blob([report], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'frontend-crash.log';
  anchor.click();
  URL.revokeObjectURL(url);
}
