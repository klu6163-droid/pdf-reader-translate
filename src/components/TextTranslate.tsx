// 划词翻译：监听 PDFViewer 派发的 pdf-selection 事件，调用后端翻译。
// 选中文本与译文存于当前标签页；loading 为组件本地态（仅活跃标签可见）。
// 术语解释经本地后端代理生成，与主翻译共用网络与日志边界。

import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Loader2,
  Languages,
  Copy,
  Check,
  Star,
  NotebookPen,
  RefreshCw,
  BookOpen,
} from 'lucide-react';
import { translateText } from '@/services/api';
import { explainTerms, TermsUnavailableError } from '@/services/api';
import { useStore, useActiveTab } from '@/store/useSettings';
import MarkdownLite from './shared/MarkdownLite';
import type { LLMSettings, SelectionInfo } from '@/types';

export default function TextTranslate() {
  const tab = useActiveTab();
  const activeTabId = useStore((s) => s.activeTabId);
  const backendStatus = useStore((s) => s.backendStatus);

  const [loading, setLoading] = useState(false);
  // 术语解释 loading 为组件本地态（结果存于标签页）
  const [termsLoading, setTermsLoading] = useState(false);
  // 按标签存放进行中的请求控制器：跨标签划词互不取消（旧实现全局共享，
  // 标签 B 划词会 abort 标签 A 的进行中请求，被取消方静默停在空白态）。
  // 同一标签内新划词仍取消旧请求——其状态立刻被新请求覆盖，不会出现空白。
  const abortMapRef = useRef<Map<string, AbortController>>(new Map());
  const termsAbortMapRef = useRef<Map<string, AbortController>>(new Map());

  // 按钮反馈
  const [copied, setCopied] = useState(false);
  const [noted, setNoted] = useState(false);

  const doTranslate = useCallback(async (text: string, targetId: string, page: number) => {
    const s = useStore.getState();
    if (s.backendStatus !== 'online') {
      s.updateTab(targetId, {
        lastTranslateError: '后端未连接，划词翻译暂不可用。请先启动本地后端。',
      });
      return;
    }
    if (!s.hasSettings()) {
      s.updateTab(targetId, {
        lastTranslateError: '请先在「设置」中配置 API Key',
      });
      s.setSettingsOpen(true);
      return;
    }
    // 只取消同一标签上一个未完成的请求（其他标签的请求不受影响）
    abortMapRef.current.get(targetId)?.abort();
    termsAbortMapRef.current.get(targetId)?.abort();
    const controller = new AbortController();
    abortMapRef.current.set(targetId, controller);

    s.updateTab(targetId, {
      lastSelection: { text, page },
      lastTranslated: '',
      lastTranslateError: '',
      lastTerms: '',
      lastTermsError: '',
    });
    setLoading(true);

    let translated = '';
    try {
      const res = await translateText(text, s.settings, '中文', controller.signal);
      // 若期间该标签又发起了新请求，丢弃本次结果
      if (abortMapRef.current.get(targetId) !== controller) return;
      translated = res.translated;
      useStore.getState().updateTab(targetId, { lastTranslated: translated });

      // 写入翻译历史
      const owner = useStore.getState().tabs.find((t) => t.id === targetId);
      useStore.getState().addHistory({
        original: text,
        translated,
        page,
        tabName: owner?.name ?? 'PDF',
      });

      // 异步生成术语解释；失败仅标记，不影响主翻译
      void fetchTerms(text, targetId, s.settings);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      if (abortMapRef.current.get(targetId) !== controller) return;
      useStore.getState().updateTab(targetId, {
        lastTranslateError: e instanceof Error ? e.message : '翻译失败',
      });
    } finally {
      if (abortMapRef.current.get(targetId) === controller) {
        abortMapRef.current.delete(targetId);
        // loading 是「当前可见标签」的本地态：仅活跃标签的请求结束时复位
        if (useStore.getState().activeTabId === targetId) setLoading(false);
      }
    }
  }, []);

  // 经本地后端代理生成术语解释，与翻译共用连接与日志边界
  const fetchTerms = useCallback(async (text: string, targetId: string, settings: LLMSettings) => {
    if (!settings.apiKey) {
      useStore.getState().updateTab(targetId, {
        lastTermsError: '未配置 API Key，术语解释不可用',
      });
      return;
    }
    termsAbortMapRef.current.get(targetId)?.abort();
    const c = new AbortController();
    termsAbortMapRef.current.set(targetId, c);
    setTermsLoading(true);
    try {
      const terms = await explainTerms(text, settings, c.signal);
      if (termsAbortMapRef.current.get(targetId) !== c) return;
      useStore.getState().updateTab(targetId, { lastTerms: terms, lastTermsError: '' });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      if (termsAbortMapRef.current.get(targetId) !== c) return;
      const msg =
        e instanceof TermsUnavailableError
          ? e.message
          : e instanceof Error
            ? e.message
            : '术语解释失败';
      useStore.getState().updateTab(targetId, { lastTermsError: msg });
    } finally {
      if (termsAbortMapRef.current.get(targetId) === c) {
        termsAbortMapRef.current.delete(targetId);
        if (useStore.getState().activeTabId === targetId) setTermsLoading(false);
      }
    }
  }, []);

  // 切换标签时按该标签的进行中请求复位本地 loading
  //（旧标签的请求仍在后台写入其自身状态，互不影响）
  useEffect(() => {
    setLoading(activeTabId ? abortMapRef.current.has(activeTabId) : false);
    setTermsLoading(activeTabId ? termsAbortMapRef.current.has(activeTabId) : false);
    setCopied(false);
    setNoted(false);
  }, [activeTabId]);

  // 监听划词事件
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as SelectionInfo;
      const s = useStore.getState();
      const current = s.tabs.find((t) => t.id === s.activeTabId);
      if (!current) return;
      // 立即展示选中
      s.updateTab(current.id, { lastSelection: detail });
      doTranslate(detail.text, current.id, detail.page);
    };
    window.addEventListener('pdf-selection', handler);
    return () => {
      window.removeEventListener('pdf-selection', handler);
      abortMapRef.current.forEach((c) => c.abort());
      abortMapRef.current.clear();
      termsAbortMapRef.current.forEach((c) => c.abort());
      termsAbortMapRef.current.clear();
    };
  }, [doTranslate]);

  const selection = tab?.lastSelection ?? null;
  const translated = tab?.lastTranslated ?? '';
  const error = tab?.lastTranslateError ?? '';
  const terms = tab?.lastTerms ?? '';
  const termsError = tab?.lastTermsError ?? '';
  const backendOnline = backendStatus === 'online';

  const copyTranslated = async () => {
    if (!translated) return;
    try {
      await navigator.clipboard.writeText(translated);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  const favorite = () => {
    if (!selection || !translated || !tab) return;
    useStore.getState().addNote({
      original: selection.text,
      translated,
      page: selection.page,
      tabName: tab.name,
    });
    setNoted(true);
    setTimeout(() => setNoted(false), 1500);
  };

  const addToNotes = () => {
    if (!selection || !translated || !tab) return;
    useStore.getState().addNote({
      original: selection.text,
      translated,
      page: selection.page,
      tabName: tab.name,
    });
    // 触发底部抽屉展开并切到笔记栏
    useStore.getState().bumpNotesFlash();
  };

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto bg-white p-4">
      {backendOnline === false && (
        <div className="status-surface status-warning flex items-start gap-2 rounded-control border p-3 text-xs">
          <Languages size={14} className="mt-0.5 shrink-0" />
          <span>后端未连接，划词翻译暂不可用。请在顶栏点「查看说明」启动后端。</span>
        </div>
      )}

      {!selection && (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-slate-400">
          <div className="flex h-14 w-14 items-center justify-center rounded-panel bg-slate-100">
            <Languages size={30} />
          </div>
          <p className="text-sm">在左侧 PDF 中选中文字，即可翻译</p>
          {backendOnline && (
            <p className="text-xs text-slate-400">译文下方含术语解释，可复制 / 收藏 / 加笔记</p>
          )}
        </div>
      )}

      {selection && (
        <>
          <section>
            <h3 className="text-xs font-medium text-slate-400 mb-1">
              原文（第 {selection.page} 页）
            </h3>
            <div className="max-h-40 overflow-auto whitespace-pre-wrap rounded-control border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
              {selection.text}
            </div>
          </section>

          <section className="flex-1">
            <h3 className="text-xs font-medium text-slate-400 mb-1">中文翻译</h3>
            <div className="content-surface min-h-[3rem] whitespace-pre-wrap border-primary-100 p-3 text-sm text-slate-800">
              {loading && (
                <span className="flex items-center gap-2 text-slate-400">
                  <Loader2 className="animate-spin" size={16} /> 翻译中...
                </span>
              )}
              {error && <span className="text-red-500">{error}</span>}
              {!loading && !error && translated}
            </div>

            {/* 译文操作按钮 */}
            {translated && !error && (
              <div className="flex flex-wrap items-center gap-2 mt-2">
                <button onClick={copyTranslated} className="ui-button min-h-7 px-2.5 py-1 text-xs">
                  {copied ? <Check size={13} className="text-green-500" /> : <Copy size={13} />}
                  {copied ? '已复制' : '复制译文'}
                </button>
                <button
                  onClick={() => selection && doTranslate(selection.text, tab!.id, selection.page)}
                  disabled={loading}
                  className="ui-button min-h-7 px-2.5 py-1 text-xs"
                >
                  <RefreshCw size={13} />
                  重新翻译
                </button>
                <button
                  onClick={favorite}
                  className="ui-button ui-button-accent min-h-7 px-2.5 py-1 text-xs"
                >
                  <Star size={13} />
                  {noted ? '已收藏' : '收藏'}
                </button>
                <button
                  onClick={addToNotes}
                  className="ui-button ui-button-accent min-h-7 px-2.5 py-1 text-xs"
                >
                  <NotebookPen size={13} />
                  添加到笔记
                </button>
              </div>
            )}
          </section>

          {/* 术语解释 */}
          {translated && !error && (
            <section>
              <h3 className="flex items-center gap-1 text-xs font-medium text-slate-400 mb-1">
                <BookOpen size={13} />
                术语解释
              </h3>
              <div className="min-h-[2rem] whitespace-pre-wrap rounded-control border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                {termsLoading && (
                  <span className="flex items-center gap-2 text-slate-400">
                    <Loader2 className="animate-spin" size={14} /> 提取术语中...
                  </span>
                )}
                {!termsLoading && termsError && (
                  <span className="text-slate-400 text-xs">{termsError}</span>
                )}
                {!termsLoading && !termsError && terms && (
                  <span className="summary-md">
                    <MarkdownLite text={terms} />
                  </span>
                )}
                {!termsLoading && !termsError && !terms && (
                  <span className="text-slate-400 text-xs">—</span>
                )}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
