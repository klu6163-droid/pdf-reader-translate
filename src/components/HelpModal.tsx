// 「查看说明」弹窗：如何启动后端、端口、降级说明、常见问题。
// 纯静态内容，给后端未连接的用户一个友好的引导。

import { X, Terminal, Server, Lightbulb } from 'lucide-react';
import IconButton from './ui/IconButton';
import ModalSurface from './ui/ModalSurface';

export default function HelpModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <ModalSurface
      open={open}
      onClose={onClose}
      labelledBy="backend-help-title"
      className="flex max-h-[86vh] flex-col"
    >
      <div className="modal-header flex shrink-0 items-center justify-between border-b border-slate-200/70 px-5 py-3">
        <h2 id="backend-help-title" className="font-semibold tracking-[-0.01em] text-slate-800">
          后端服务说明
        </h2>
        <IconButton label="关闭说明" onClick={onClose} icon={<X size={18} />} />
      </div>

      <div className="modal-body-solid space-y-5 overflow-auto p-5 text-sm text-slate-700">
        <section className="space-y-2">
          <h3 className="flex items-center gap-1.5 font-medium text-slate-800">
            <Server size={15} className="text-primary-600" />
            这是什么
          </h3>
          <p className="leading-relaxed">
            AI 翻译、全文翻译与文献总结需要调用大模型，由一个运行在本机的 Python
            后端服务统一代理。软件启动时会自动检测它在
            <code className="mx-1 rounded-control bg-slate-100 px-1.5 py-0.5 text-xs">
              127.0.0.1:8765
            </code>
            是否可用。检测不到时，相关功能会暂时置灰。
          </p>
        </section>

        <section className="space-y-2">
          <h3 className="flex items-center gap-1.5 font-medium text-slate-800">
            <Terminal size={15} className="text-primary-600" />
            如何手动启动
          </h3>
          <p className="leading-relaxed">在项目根目录打开终端，执行：</p>
          <pre className="overflow-x-auto rounded-control border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
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
            <Lightbulb size={15} className="text-primary-600" />
            常见问题
          </h3>
          <ul className="space-y-1.5 leading-relaxed list-disc pl-5 text-xs text-slate-600">
            <li>
              全文翻译若提示「降级模式」，是因为后端未安装 pdf2zh，会退化为纯文本翻译；
              需要保留排版/公式/图表时执行{' '}
              <code className="rounded-control bg-slate-100 px-1">pip install pdf2zh</code>。
            </li>
            <li>扫描件（图片型 PDF）无法提取文本，翻译与总结会提示无可用文本。</li>
            <li>
              首次使用请到右上角「设置」填入你自己的 API Key / Base URL /
              模型名；文献总结可单独配置模型，留空则复用翻译配置。
            </li>
            <li>任务状态存于后端内存，重启后端会丢失进行中的任务。</li>
          </ul>
        </section>
      </div>

      <div className="modal-footer flex shrink-0 justify-end border-t border-slate-200/70 px-5 py-3">
        <button onClick={onClose} className="ui-button ui-button-primary px-4 text-sm">
          知道了
        </button>
      </div>
    </ModalSurface>
  );
}
