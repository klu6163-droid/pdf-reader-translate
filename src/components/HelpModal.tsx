// 「查看说明」弹窗：如何启动后端、端口、降级说明、常见问题。
// 纯静态内容，给后端未连接的用户一个友好的引导。

import { X, Terminal, Server, Lightbulb } from "lucide-react";

export default function HelpModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/50"
      onClick={onClose}
    >
      <div
        className="w-[520px] max-w-[92vw] max-h-[86vh] overflow-auto bg-white rounded-lg shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b sticky top-0 bg-white">
          <h2 className="font-semibold text-slate-800">后端服务说明</h2>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600"
            aria-label="关闭"
          >
            <X size={20} />
          </button>
        </div>

        <div className="p-5 space-y-5 text-sm text-slate-700">
          <section className="space-y-2">
            <h3 className="flex items-center gap-1.5 font-medium text-slate-800">
              <Server size={15} className="text-primary-600" />
              这是什么
            </h3>
            <p className="leading-relaxed">
              AI 翻译、全文翻译与文献总结需要调用大模型，由一个运行在本机的 Python
              后端服务统一代理。软件启动时会自动检测它在
              <code className="mx-1 px-1.5 py-0.5 bg-slate-100 rounded text-xs">127.0.0.1:8765</code>
              是否可用。检测不到时，相关功能会暂时置灰。
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="flex items-center gap-1.5 font-medium text-slate-800">
              <Terminal size={15} className="text-primary-600" />
              如何手动启动
            </h3>
            <p className="leading-relaxed">
              在项目根目录打开终端，执行：
            </p>
            <pre className="px-3 py-2 bg-slate-50 border border-slate-200 rounded text-xs overflow-x-auto">
{`cd backend
python -m venv .venv
# Windows
.venv\\Scripts\\activate
# macOS / Linux
source .venv/bin/activate

pip install -r requirements.txt
python start.py`}
            </pre>
            <p className="leading-relaxed text-xs text-slate-500">
              桌面应用（Tauri）启动时通常会自动拉起该后端；若你已手动启动，二者不冲突。
              启动后回到软件点「重新检测」即可。
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="flex items-center gap-1.5 font-medium text-slate-800">
              <Lightbulb size={15} className="text-amber-500" />
              常见问题
            </h3>
            <ul className="space-y-1.5 leading-relaxed list-disc pl-5 text-xs text-slate-600">
              <li>
                全文翻译若提示「降级模式」，是因为后端未安装 pdf2zh，会退化为纯文本翻译；
                需要保留排版/公式/图表时执行 <code className="px-1 bg-slate-100 rounded">pip install pdf2zh</code>。
              </li>
              <li>扫描件（图片型 PDF）无法提取文本，翻译与总结会提示无可用文本。</li>
              <li>首次使用请到右上角「设置」填入你自己的 API Key / Base URL / 模型名。</li>
              <li>任务状态存于后端内存，重启后端会丢失进行中的任务。</li>
            </ul>
          </section>
        </div>

        <div className="flex justify-end px-5 py-3 border-t sticky bottom-0 bg-white">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-sm bg-primary-600 text-white rounded hover:bg-primary-700"
          >
            知道了
          </button>
        </div>
      </div>
    </div>
  );
}
