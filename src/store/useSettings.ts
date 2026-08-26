// 全局状态：LLM 配置 + 多 PDF 标签页。
// 配置持久化到 localStorage（不写死在代码里，用户自行填写）。
// PDF 数据不落盘（体积过大）。

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { LLMSettings, PdfTab, RecentFile, HistoryItem, NoteItem } from '@/types';

const MAX_TABS = 8;
const MAX_RECENT = 12;
const MAX_HISTORY = 50;
// 与 history 一致：无上限时长期收藏会缓慢挤占 localStorage 直至写入失败
const MAX_NOTES = 50;

interface AppState {
  settings: LLMSettings;
  setSettings: (s: Partial<LLMSettings>) => void;
  hasSettings: () => boolean;

  // 文献总结独立配置：任一字段留空时，该字段回退到翻译配置（settings）
  summarySettings: LLMSettings;
  setSummarySettings: (s: Partial<LLMSettings>) => void;
  /** 文献总结实际生效的配置（空字段逐项回退到翻译配置） */
  getSummarySettings: () => LLMSettings;

  // 多标签页
  tabs: PdfTab[];
  activeTabId: string | null;
  /** 新增标签页并激活。达到上限（8）时返回 null。 */
  addTab: (data: Uint8Array, name: string) => string | null;
  /** 关闭标签页，自动激活相邻标签。 */
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  /** 局部更新某个标签页的字段。 */
  updateTab: (id: string, patch: Partial<PdfTab>) => void;
  /** 追加总结内容（流式增量）。 */
  appendSummary: (id: string, delta: string) => void;

  // 最近文件（仅路径，点击用 readPdfFile 重新读盘）
  recentFiles: RecentFile[];
  addRecentFile: (path: string, name: string) => void;
  removeRecentFile: (path: string) => void;
  clearRecentFiles: () => void;

  // 划词翻译历史 & 收藏笔记（持久化，纯文本，体积小）
  history: HistoryItem[];
  addHistory: (item: Omit<HistoryItem, 'id' | 'ts'>) => void;
  clearHistory: () => void;

  notes: NoteItem[];
  addNote: (item: Omit<NoteItem, 'id' | 'ts'>) => void;
  removeNote: (id: string) => void;
  clearNotes: () => void;

  // 跨组件信号：划词翻译「添加到笔记」时自增，HistoryNotes 监听后展开并切到笔记栏
  notesFlash: number;
  bumpNotesFlash: () => void;

  settingsOpen: boolean;
  setSettingsOpen: (v: boolean) => void;

  // 后端连接状态：
  //   unknown（未探测过）/ starting（首次启动等待中）/ online / offline
  //   / reconnecting（后端崩溃后 Tauri 正在自动重启，或用户点了「重启后端」）
  backendStatus: 'unknown' | 'starting' | 'online' | 'offline' | 'reconnecting';
  setBackendStatus: (s: 'unknown' | 'starting' | 'online' | 'offline' | 'reconnecting') => void;

  // 左右分栏比例（左栏占比，0.2~0.8，默认 0.5）
  splitRatio: number;
  setSplitRatio: (r: number) => void;

  // 译文 PDF 是否跟随原文翻页（全文翻译 / 生成译文 PDF 共用，默认开）
  syncTranslatedPage: boolean;
  setSyncTranslatedPage: (v: boolean) => void;
}

const DEFAULT_SETTINGS: LLMSettings = {
  apiKey: '',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
};

// 文献总结独立配置默认全空 = 完全复用翻译配置
const DEFAULT_SUMMARY_SETTINGS: LLMSettings = {
  apiKey: '',
  baseUrl: '',
  model: '',
};

/**
 * 计算文献总结实际生效的配置：总结配置中为空的字段，
 * 逐项回退到翻译配置（支持「同一服务商只换模型」到「完全独立两套」的全部场景）。
 */
export function resolveSummarySettings(
  translate: LLMSettings,
  summary: LLMSettings,
): LLMSettings {
  return {
    apiKey: summary.apiKey.trim() ? summary.apiKey : translate.apiKey,
    baseUrl: summary.baseUrl.trim() ? summary.baseUrl : translate.baseUrl,
    model: summary.model.trim() ? summary.model : translate.model,
  };
}

function createTab(data: Uint8Array, name: string): PdfTab {
  return {
    id: crypto.randomUUID(),
    name,
    pdfData: data,
    currentPage: 1,
    translationTaskId: null,
    translationRunning: false,
    translationProgress: 0,
    translationMessage: '',
    translationMode: '',
    translatedPdfUrl: null,
    translationError: '',
    summaryContent: '',
    summaryRunning: false,
    summaryError: '',
    lastSelection: null,
    lastTranslated: '',
    lastTranslateError: '',
    lastTerms: '',
    lastTermsError: '',
    overlayTaskId: null,
    overlayRunning: false,
    overlayProgress: 0,
    overlayMessage: '',
    overlayPdfUrl: null,
    overlayError: '',
  };
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      settings: DEFAULT_SETTINGS,
      setSettings: (s) => set((state) => ({ settings: { ...state.settings, ...s } })),
      hasSettings: () => !!get().settings.apiKey,

      summarySettings: DEFAULT_SUMMARY_SETTINGS,
      setSummarySettings: (s) =>
        set((state) => ({ summarySettings: { ...state.summarySettings, ...s } })),
      getSummarySettings: () => resolveSummarySettings(get().settings, get().summarySettings),

      tabs: [],
      activeTabId: null,
      addTab: (data, name) => {
        if (get().tabs.length >= MAX_TABS) return null;
        const tab = createTab(data, name);
        set((state) => ({ tabs: [...state.tabs, tab], activeTabId: tab.id }));
        return tab.id;
      },
      closeTab: (id) =>
        set((state) => {
          const idx = state.tabs.findIndex((t) => t.id === id);
          if (idx === -1) return {};
          const tabs = state.tabs.filter((t) => t.id !== id);
          let activeTabId = state.activeTabId;
          if (activeTabId === id) {
            // 激活相邻标签（优先右侧，否则左侧，否则无）
            const next = tabs[Math.min(idx, tabs.length - 1)] ?? null;
            activeTabId = next ? next.id : null;
          }
          return { tabs, activeTabId };
        }),
      setActiveTab: (id) => set({ activeTabId: id }),
      updateTab: (id, patch) =>
        set((state) => ({
          tabs: state.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)),
        })),
      appendSummary: (id, delta) =>
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.id === id ? { ...t, summaryContent: t.summaryContent + delta } : t,
          ),
        })),

      recentFiles: [],
      addRecentFile: (path, name) =>
        set((state) => {
          // 去重并置顶，超过上限截断
          const filtered = state.recentFiles.filter((f) => f.path !== path);
          const next = [{ path, name, ts: Date.now() }, ...filtered];
          return { recentFiles: next.slice(0, MAX_RECENT) };
        }),
      removeRecentFile: (path) =>
        set((state) => ({
          recentFiles: state.recentFiles.filter((f) => f.path !== path),
        })),
      clearRecentFiles: () => set({ recentFiles: [] }),

      history: [],
      addHistory: (item) =>
        set((state) => {
          const full: HistoryItem = {
            ...item,
            id: crypto.randomUUID(),
            ts: Date.now(),
          };
          return { history: [full, ...state.history].slice(0, MAX_HISTORY) };
        }),
      clearHistory: () => set({ history: [] }),

      notes: [],
      addNote: (item) =>
        set((state) => {
          const full: NoteItem = {
            ...item,
            id: crypto.randomUUID(),
            ts: Date.now(),
          };
          return { notes: [full, ...state.notes].slice(0, MAX_NOTES) };
        }),
      removeNote: (id) =>
        set((state) => ({
          notes: state.notes.filter((n) => n.id !== id),
        })),
      clearNotes: () => set({ notes: [] }),

      notesFlash: 0,
      bumpNotesFlash: () => set((state) => ({ notesFlash: state.notesFlash + 1 })),

      settingsOpen: false,
      setSettingsOpen: (v) => set({ settingsOpen: v }),

      backendStatus: 'starting',
      setBackendStatus: (s) => set({ backendStatus: s }),

      splitRatio: 0.5,
      setSplitRatio: (r) => set({ splitRatio: r }),

      syncTranslatedPage: true,
      setSyncTranslatedPage: (v) => set({ syncTranslatedPage: v }),
    }),
    {
      name: 'pdf-translate-settings',
      // 持久化 settings + 分栏比例 + 最近文件/历史/笔记（均纯文本，体积小）；
      // PDF 字节不落盘
      partialize: (state) => ({
        settings: state.settings,
        summarySettings: state.summarySettings,
        splitRatio: state.splitRatio,
        syncTranslatedPage: state.syncTranslatedPage,
        recentFiles: state.recentFiles,
        history: state.history,
        notes: state.notes,
      }),
    },
  ),
);

/** 读取当前激活的标签页。无标签时返回 null。 */
export function useActiveTab(): PdfTab | null {
  return useStore((s) => s.tabs.find((t) => t.id === s.activeTabId) ?? null);
}
