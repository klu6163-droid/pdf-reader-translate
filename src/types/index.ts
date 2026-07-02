// 共享类型定义

export interface LLMSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface TextTranslateResult {
  original: string;
  translated: string;
  model: string;
}

export interface PdfProgressEvent {
  progress: number; // 0~1
  message: string;
  mode?: string; // "pdf2zh" | "fallback"
  done?: boolean;
  error?: boolean;
}

export type PanelTab = "text" | "full" | "summary";

// 划词事件：选中的文本 + 所在页码
export interface SelectionInfo {
  text: string;
  page: number;
}
