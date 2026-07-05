// 全局状态：LLM 配置 + 多 PDF 标签页。
// 配置持久化到 localStorage（不写死在代码里，用户自行填写）。
// PDF 数据不落盘（体积过大）。

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { LLMSettings, PdfTab } from "@/types";

const MAX_TABS = 8;

interface AppState {
  settings: LLMSettings;
  setSettings: (s: Partial<LLMSettings>) => void;
  hasSettings: () => boolean;

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

  settingsOpen: boolean;
  setSettingsOpen: (v: boolean) => void;

  // 后端连接状态：unknown（探测中）/ online / offline
  backendStatus: "unknown" | "online" | "offline";
  setBackendStatus: (s: "unknown" | "online" | "offline") => void;

  // 左右分栏比例（左栏占比，0.2~0.8，默认 0.5）
  splitRatio: number;
  setSplitRatio: (r: number) => void;
}

const DEFAULT_SETTINGS: LLMSettings = {
  apiKey: "",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
};

function createTab(data: Uint8Array, name: string): PdfTab {
  return {
    id: crypto.randomUUID(),
    name,
    pdfData: data,
    currentPage: 1,
    translationTaskId: null,
    translationRunning: false,
    translationProgress: 0,
    translationMessage: "",
    translationMode: "",
    translatedPdfUrl: null,
    translationError: "",
    summaryContent: "",
    summaryRunning: false,
    summaryError: "",
    lastSelection: null,
    lastTranslated: "",
    lastTranslateError: "",
    structTaskId: null,
    structRunning: false,
    structProgress: 0,
    structMessage: "",
    structResult: null,
    structError: "",
  };
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      settings: DEFAULT_SETTINGS,
      setSettings: (s) =>
        set((state) => ({ settings: { ...state.settings, ...s } })),
      hasSettings: () => !!get().settings.apiKey,

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
          tabs: state.tabs.map((t) =>
            t.id === id ? { ...t, ...patch } : t
          ),
        })),
      appendSummary: (id, delta) =>
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.id === id ? { ...t, summaryContent: t.summaryContent + delta } : t
          ),
        })),

      settingsOpen: false,
      setSettingsOpen: (v) => set({ settingsOpen: v }),

      backendStatus: "unknown",
      setBackendStatus: (s) => set({ backendStatus: s }),

      splitRatio: 0.5,
      setSplitRatio: (r) => set({ splitRatio: r }),
    }),
    {
      name: "pdf-translate-settings",
      // 持久化 settings + 分栏比例；PDF 数据不落盘
      partialize: (state) => ({
        settings: state.settings,
        splitRatio: state.splitRatio,
      }),
    }
  )
);

/** 读取当前激活的标签页。无标签时返回 null。 */
export function useActiveTab(): PdfTab | null {
  return useStore((s) => s.tabs.find((t) => t.id === s.activeTabId) ?? null);
}
