// 全局状态：LLM 配置 + 当前 PDF 文件。
// 配置持久化到 localStorage（不写死在代码里，用户自行填写）。

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { LLMSettings } from "@/types";

interface AppState {
  settings: LLMSettings;
  setSettings: (s: Partial<LLMSettings>) => void;
  hasSettings: () => boolean;

  // 当前打开的 PDF
  pdfData: Uint8Array | null;
  pdfName: string;
  setPdf: (data: Uint8Array, name: string) => void;

  // 当前页码（用于左右同步滚动）
  currentPage: number;
  setCurrentPage: (p: number) => void;

  // 翻译结果 PDF 的地址
  translatedPdfUrl: string | null;
  setTranslatedPdfUrl: (url: string | null) => void;

  settingsOpen: boolean;
  setSettingsOpen: (v: boolean) => void;

  // 后端连接状态：unknown（探测中）/ online / offline
  backendStatus: "unknown" | "online" | "offline";
  setBackendStatus: (s: "unknown" | "online" | "offline") => void;
}

const DEFAULT_SETTINGS: LLMSettings = {
  apiKey: "",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
};

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      settings: DEFAULT_SETTINGS,
      setSettings: (s) =>
        set((state) => ({ settings: { ...state.settings, ...s } })),
      hasSettings: () => !!get().settings.apiKey,

      pdfData: null,
      pdfName: "",
      setPdf: (data, name) =>
        set({ pdfData: data, pdfName: name, translatedPdfUrl: null }),

      currentPage: 1,
      setCurrentPage: (p) => set({ currentPage: p }),

      translatedPdfUrl: null,
      setTranslatedPdfUrl: (url) => set({ translatedPdfUrl: url }),

      settingsOpen: false,
      setSettingsOpen: (v) => set({ settingsOpen: v }),

      backendStatus: "unknown",
      setBackendStatus: (s) => set({ backendStatus: s }),
    }),
    {
      name: "pdf-translate-settings",
      // 仅持久化 settings，PDF 数据不落盘
      partialize: (state) => ({ settings: state.settings }),
    }
  )
);
