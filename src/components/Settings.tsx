// 设置弹窗：配置 API Key / Base URL / 模型名，并可测试连通性。
// API Key 只存在本地 localStorage，不写死、不上传第三方。

import { useState } from "react";
import { X, Loader2, CheckCircle, XCircle } from "lucide-react";
import { useStore } from "@/store/useSettings";
import { testSettings } from "@/services/api";

export default function Settings() {
  const { settings, setSettings, settingsOpen, setSettingsOpen } = useStore();
  const [apiKey, setApiKey] = useState(settings.apiKey);
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  const [model, setModel] = useState(settings.model);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  if (!settingsOpen) return null;

  const save = () => {
    setSettings({ apiKey, baseUrl, model });
    setSettingsOpen(false);
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    const res = await testSettings({ apiKey, baseUrl, model });
    setTestResult(res);
    setTesting(false);
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-[480px] max-w-[90vw]">
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <h2 className="font-semibold text-slate-800">API 设置</h2>
          <button
            onClick={() => setSettingsOpen(false)}
            className="text-slate-400 hover:text-slate-600"
          >
            <X size={20} />
          </button>
        </div>

        <div className="p-5 space-y-4">
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

          {testResult && (
            <div
              className={`flex items-center gap-2 text-sm ${
                testResult.ok ? "text-green-600" : "text-red-600"
              }`}
            >
              {testResult.ok ? (
                <CheckCircle size={16} />
              ) : (
                <XCircle size={16} />
              )}
              <span className="break-all">{testResult.message}</span>
            </div>
          )}
        </div>

        <div className="flex justify-between items-center px-5 py-3 border-t">
          <button
            onClick={test}
            disabled={testing || !apiKey}
            className="flex items-center gap-2 px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
          >
            {testing && <Loader2 className="animate-spin" size={14} />}
            测试连接
          </button>
          <div className="flex gap-2">
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
      </div>

      <style>{`.input{width:100%;padding:0.5rem 0.75rem;border:1px solid #cbd5e1;border-radius:0.375rem;font-size:0.875rem;outline:none}.input:focus{border-color:#2563eb}`}</style>
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
