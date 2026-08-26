// 设置弹窗：翻译与文献总结两套模型配置（各含 API Key / Base URL / 模型名），
// 各自可测试连通性。总结配置留空的字段自动复用翻译配置。
// API Key 只存在本地 localStorage，不写死、不上传第三方。

import { useEffect, useRef, useState } from 'react';
import { X, Loader2, CheckCircle, XCircle } from 'lucide-react';
import { useStore, resolveSummarySettings } from '@/store/useSettings';
import { testSettings } from '@/services/api';
import { normalizeLLMRateLimit, QWEN_MT_RATE_LIMIT_PRESET } from '@/services/llmConfig';

interface TestResult {
  ok: boolean;
  message: string;
}

export default function Settings() {
  const {
    settings,
    setSettings,
    summarySettings,
    setSummarySettings,
    settingsOpen,
    setSettingsOpen,
  } = useStore();

  // 翻译配置（本地编辑态）
  const [apiKey, setApiKey] = useState(settings.apiKey);
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  const [model, setModel] = useState(settings.model);
  const initialRateLimit = normalizeLLMRateLimit(settings.rateLimit);
  const [maxConcurrency, setMaxConcurrency] = useState(initialRateLimit.maxConcurrency);
  const [requestIntervalMs, setRequestIntervalMs] = useState(initialRateLimit.requestIntervalMs);
  const [maxRetries, setMaxRetries] = useState(initialRateLimit.maxRetries);
  const [retryBaseSeconds, setRetryBaseSeconds] = useState(initialRateLimit.retryBaseSeconds);

  // 文献总结配置（本地编辑态；留空 = 复用翻译配置）
  const [summaryApiKey, setSummaryApiKey] = useState(summarySettings.apiKey);
  const [summaryBaseUrl, setSummaryBaseUrl] = useState(summarySettings.baseUrl);
  const [summaryModel, setSummaryModel] = useState(summarySettings.model);

  const [testing, setTesting] = useState<'translate' | 'summary' | null>(null);
  const [translateResult, setTranslateResult] = useState<TestResult | null>(null);
  const [summaryResult, setSummaryResult] = useState<TestResult | null>(null);

  // 「打开会话」编号：每次打开弹窗自增，使上一次打开时发起的在途测试请求作废，
  // 避免其结果（最长 35s 后才返回）写到已重置的新输入框上
  const sessionRef = useRef(0);

  // 每次打开弹窗时从已保存的配置重新填充，避免上次未保存的编辑残留
  useEffect(() => {
    if (settingsOpen) {
      sessionRef.current += 1;
      setTesting(null);
      setApiKey(settings.apiKey);
      setBaseUrl(settings.baseUrl);
      setModel(settings.model);
      const rateLimit = normalizeLLMRateLimit(settings.rateLimit);
      setMaxConcurrency(rateLimit.maxConcurrency);
      setRequestIntervalMs(rateLimit.requestIntervalMs);
      setMaxRetries(rateLimit.maxRetries);
      setRetryBaseSeconds(rateLimit.retryBaseSeconds);
      setSummaryApiKey(summarySettings.apiKey);
      setSummaryBaseUrl(summarySettings.baseUrl);
      setSummaryModel(summarySettings.model);
      setTranslateResult(null);
      setSummaryResult(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsOpen]);

  if (!settingsOpen) return null;

  const currentRateLimit = () =>
    normalizeLLMRateLimit({
      maxConcurrency,
      requestIntervalMs,
      maxRetries,
      retryBaseSeconds,
    });

  const applyQwenPreset = () => {
    setMaxConcurrency(QWEN_MT_RATE_LIMIT_PRESET.maxConcurrency);
    setRequestIntervalMs(QWEN_MT_RATE_LIMIT_PRESET.requestIntervalMs);
    setMaxRetries(QWEN_MT_RATE_LIMIT_PRESET.maxRetries);
    setRetryBaseSeconds(QWEN_MT_RATE_LIMIT_PRESET.retryBaseSeconds);
  };

  const save = () => {
    setSettings({ apiKey, baseUrl, model, rateLimit: currentRateLimit() });
    setSummarySettings({ apiKey: summaryApiKey, baseUrl: summaryBaseUrl, model: summaryModel });
    setSettingsOpen(false);
  };

  const testTranslate = async () => {
    const session = sessionRef.current;
    setTesting('translate');
    setTranslateResult(null);
    const res = await testSettings({ apiKey, baseUrl, model, rateLimit: currentRateLimit() });
    if (sessionRef.current !== session) return; // 期间弹窗被重新打开，丢弃过期结果
    setTranslateResult(res);
    setTesting(null);
  };

  // 总结测试用「实际生效」的配置（空字段回退到左侧翻译配置）
  const testSummary = async () => {
    const session = sessionRef.current;
    setTesting('summary');
    setSummaryResult(null);
    const effective = resolveSummarySettings(
      { apiKey, baseUrl, model, rateLimit: currentRateLimit() },
      { apiKey: summaryApiKey, baseUrl: summaryBaseUrl, model: summaryModel },
    );
    const res = await testSettings(effective);
    if (sessionRef.current !== session) return; // 期间弹窗被重新打开，丢弃过期结果
    setSummaryResult(res);
    setTesting(null);
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-[520px] max-w-[92vw] max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b shrink-0">
          <h2 className="font-semibold text-slate-800">API 设置</h2>
          <button
            onClick={() => setSettingsOpen(false)}
            className="text-slate-400 hover:text-slate-600"
          >
            <X size={20} />
          </button>
        </div>

        <div className="p-5 space-y-5 overflow-auto">
          {/* ---- 翻译配置 ---- */}
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-1.5">
              <span className="w-1.5 h-4 bg-primary-500 rounded-full inline-block" />
              翻译模型
              <span className="text-xs font-normal text-slate-400">
                划词翻译 / 全文翻译 / 覆盖翻译 / 术语解释
              </span>
            </h3>

            <Field label="API Key" hint="仅保存在本地，不会上传">
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
                className="input"
              />
            </Field>

            <Field label="Base URL" hint="OpenAI-compatible 接口地址">
              <input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.openai.com/v1"
                className="input"
              />
            </Field>

            <Field label="模型名称">
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="gpt-4o-mini"
                className="input"
              />
            </Field>

            <div className="rounded-md border border-slate-200 bg-slate-50 p-3 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-slate-700">限流与 429 重试</div>
                  <p className="text-xs text-slate-500 mt-0.5">
                    全文翻译使用最大并发；划词、覆盖翻译、术语和总结同时使用请求间隔与退避。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={applyQwenPreset}
                  className="shrink-0 px-2.5 py-1 text-xs border border-primary-300 text-primary-700 rounded hover:bg-primary-50"
                >
                  Qwen-MT 防 429 预设
                </button>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field label="最大并发" hint="1~8">
                  <input
                    type="number"
                    min={1}
                    max={8}
                    step={1}
                    value={maxConcurrency}
                    onChange={(e) => setMaxConcurrency(Number(e.target.value))}
                    className="input"
                  />
                </Field>
                <Field label="请求间隔" hint="毫秒">
                  <input
                    type="number"
                    min={0}
                    max={60000}
                    step={100}
                    value={requestIntervalMs}
                    onChange={(e) => setRequestIntervalMs(Number(e.target.value))}
                    className="input"
                  />
                </Field>
                <Field label="429 重试次数" hint="0~10">
                  <input
                    type="number"
                    min={0}
                    max={10}
                    step={1}
                    value={maxRetries}
                    onChange={(e) => setMaxRetries(Number(e.target.value))}
                    className="input"
                  />
                </Field>
                <Field label="退避初始等待" hint="秒">
                  <input
                    type="number"
                    min={0.1}
                    max={60}
                    step={0.5}
                    value={retryBaseSeconds}
                    onChange={(e) => setRetryBaseSeconds(Number(e.target.value))}
                    className="input"
                  />
                </Field>
              </div>
              <p className="text-xs text-slate-500">
                保守预设：并发 1、间隔 1100ms、最多重试 5 次、初始退避 2 秒。
              </p>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={testTranslate}
                disabled={testing !== null || !apiKey}
                className="flex items-center gap-2 px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
              >
                {testing === 'translate' && <Loader2 className="animate-spin" size={14} />}
                测试连接
              </button>
              {translateResult && <TestBadge result={translateResult} />}
            </div>
          </section>

          <div className="border-t border-dashed" />

          {/* ---- 文献总结配置 ---- */}
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-1.5">
              <span className="w-1.5 h-4 bg-amber-500 rounded-full inline-block" />
              文献总结模型
              <span className="text-xs font-normal text-slate-400">可选</span>
            </h3>
            <p className="text-xs text-slate-400 -mt-2">
              可为文献总结单独指定服务商与模型；留空的项自动复用上方「翻译模型」配置。
            </p>

            <Field label="API Key">
              <input
                type="password"
                value={summaryApiKey}
                onChange={(e) => setSummaryApiKey(e.target.value)}
                placeholder="留空则使用翻译配置的 API Key"
                className="input"
              />
            </Field>

            <Field label="Base URL">
              <input
                value={summaryBaseUrl}
                onChange={(e) => setSummaryBaseUrl(e.target.value)}
                placeholder="留空则使用翻译配置的 Base URL"
                className="input"
              />
            </Field>

            <Field label="模型名称">
              <input
                value={summaryModel}
                onChange={(e) => setSummaryModel(e.target.value)}
                placeholder="留空则使用翻译配置的模型"
                className="input"
              />
            </Field>

            <div className="flex items-center gap-2">
              <button
                onClick={testSummary}
                disabled={
                  testing !== null ||
                  !resolveSummarySettings(
                    { apiKey, baseUrl, model, rateLimit: currentRateLimit() },
                    { apiKey: summaryApiKey, baseUrl: summaryBaseUrl, model: summaryModel },
                  ).apiKey
                }
                className="flex items-center gap-2 px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
              >
                {testing === 'summary' && <Loader2 className="animate-spin" size={14} />}
                测试连接
              </button>
              {summaryResult && <TestBadge result={summaryResult} />}
            </div>
          </section>
        </div>

        <div className="flex justify-end items-center gap-2 px-5 py-3 border-t shrink-0">
          <button
            onClick={() => setSettingsOpen(false)}
            className="px-4 py-1.5 text-sm text-slate-600 hover:bg-slate-100 rounded"
          >
            取消
          </button>
          <button
            onClick={save}
            className="px-4 py-1.5 text-sm bg-primary-600 text-white rounded hover:bg-primary-700"
          >
            保存
          </button>
        </div>
      </div>

      <style>{`.input{width:100%;padding:0.5rem 0.75rem;border:1px solid #cbd5e1;border-radius:0.375rem;font-size:0.875rem;outline:none}.input:focus{border-color:#2563eb}`}</style>
    </div>
  );
}

function TestBadge({ result }: { result: TestResult }) {
  return (
    <div
      className={`flex items-center gap-2 text-sm min-w-0 ${
        result.ok ? 'text-green-600' : 'text-red-600'
      }`}
    >
      {result.ok ? (
        <CheckCircle size={16} className="shrink-0" />
      ) : (
        <XCircle size={16} className="shrink-0" />
      )}
      <span className="break-all">{result.message}</span>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 mb-1">
        {label}
        {hint && <span className="ml-2 text-xs text-slate-400">{hint}</span>}
      </label>
      {children}
    </div>
  );
}
