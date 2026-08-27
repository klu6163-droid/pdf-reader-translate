// 文献总结：提取全文 → 流式生成结构化中文总结。
// 状态存于当前标签页；切换标签时流不会中断（onDelta 写入所属标签）。
// 用轻量的 Markdown 渲染（仅处理 ## 标题与段落），避免额外依赖。
// 模型配置：优先使用「文献总结」专属配置，空字段回退到翻译配置。

import { useCallback } from 'react';
import { Loader2, Sparkles, AlertCircle } from 'lucide-react';
import { streamSummary, bytesToPdfBlob, errMsg } from '@/services/api';
import { useStore, useActiveTab } from '@/store/useSettings';
import MarkdownLite from './shared/MarkdownLite';

export default function Summary() {
  const tab = useActiveTab();
  const backendStatus = useStore((s) => s.backendStatus);
  const backendOnline = backendStatus === 'online';

  const start = useCallback(async () => {
    const s = useStore.getState();
    const current = s.tabs.find((t) => t.id === s.activeTabId);
    if (!current) return;
    const targetId = current.id; // 捕获，避免异步期间切换标签写错对象

    if (!current.pdfData) {
      s.updateTab(targetId, { summaryError: '请先打开一个 PDF' });
      return;
    }
    // 文献总结使用自己的配置（空字段回退到翻译配置）
    const summarySettings = s.getSummarySettings();
    if (!summarySettings.apiKey) {
      s.updateTab(targetId, { summaryError: '请先在「设置」中配置 API Key' });
      s.setSettingsOpen(true);
      return;
    }

    s.updateTab(targetId, {
      summaryRunning: true,
      summaryError: '',
      summaryContent: '',
    });

    const blob = bytesToPdfBlob(current.pdfData);
    try {
      await streamSummary(
        blob,
        current.name,
        summarySettings,
        // 增量写入「拥有该任务的标签」——即便用户已切到别的标签，
        // 流仍在后台累积到原标签的 summaryContent。
        (delta) => useStore.getState().appendSummary(targetId, delta),
        () => useStore.getState().updateTab(targetId, { summaryRunning: false }),
        (err) =>
          useStore.getState().updateTab(targetId, {
            summaryRunning: false,
            summaryError: err,
          }),
      );
    } catch (e) {
      // 兜底：streamSummary 自身未捕获的异常也不能让 summaryRunning 卡死
      useStore.getState().updateTab(targetId, {
        summaryRunning: false,
        summaryError: errMsg(e),
      });
    }
  }, []);

  const running = tab?.summaryRunning ?? false;
  const content = tab?.summaryContent ?? '';
  const error = tab?.summaryError ?? '';
  const hasPdf = !!tab?.pdfData;

  return (
    <div className="flex h-full flex-col gap-3 bg-white p-4">
      <button
        onClick={start}
        disabled={running || !hasPdf || !backendOnline}
        className="ui-button ui-button-primary min-h-10 shrink-0 px-4 py-2.5 text-sm"
      >
        {running ? <Loader2 className="animate-spin" size={18} /> : <Sparkles size={18} />}
        {running ? '生成中...' : '生成结构化总结'}
      </button>

      {!backendOnline && (
        <div className="status-surface status-warning flex shrink-0 items-start gap-2 rounded-control border p-3 text-xs">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span>后端未连接，文献总结暂不可用。请在顶栏点「查看说明」启动后端后重试。</span>
        </div>
      )}

      {error && (
        <div
          className="status-surface status-danger flex shrink-0 items-start gap-2 rounded-control border p-3 text-sm"
          role="alert"
        >
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {!content && !running && !error && (
        <div className="flex flex-col items-center justify-center flex-1 text-slate-400 gap-2">
          <div className="flex h-14 w-14 items-center justify-center rounded-panel bg-slate-100">
            <Sparkles size={30} />
          </div>
          <p className="text-sm text-center">
            提取 PDF 全文并生成中文总结
            <br />
            （研究问题 / 方法 / 贡献 / 实验 / 结论 / 局限性 / 摘要）
          </p>
        </div>
      )}

      {(content || running) && (
        <div className="content-surface summary-md flex-1 overflow-auto p-4 text-sm text-slate-800">
          <MarkdownLite text={content} />
          {running && (
            <span
              className="ml-1 inline-flex align-middle text-primary-600"
              aria-label="总结生成中"
            >
              <Loader2 size={14} className="animate-spin" />
            </span>
          )}
        </div>
      )}

      {!hasPdf && !running && (
        <div className="text-sm text-slate-400 text-center mt-4">请先在左侧打开一个 PDF</div>
      )}
    </div>
  );
}
