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

export type PanelTab = "text" | "full" | "summary" | "overlay";

// 划词事件：选中的文本 + 所在页码
export interface SelectionInfo {
  text: string;
  page: number;
}

// ---- PDF 文本块编辑 ----

// 单个可编辑文本块（后端 PyMuPDF span 解析结果）
export interface EditBlock {
  id: string;
  page: number;
  text: string;
  bbox: [number, number, number, number]; // x0,y0,x1,y1（PDF 点，左上原点）
  font: string;
  size: number;
  color: string; // #rrggbb
  bold: boolean;
  italic: boolean;
}

export interface EditPage {
  page: number;
  width: number; // PDF 点
  height: number;
  blocks: EditBlock[];
}

export interface AnalyzeResult {
  edit_id: string;
  mode: "text" | "compatible";
  mode_label: string;
  page_count: number;
  pages: EditPage[];
}

// ---- PDF 批注 ----

export type AnnotationType =
  | "highlight"
  | "underline"
  | "strikeout"
  | "note"
  | "rectangle"
  | "ink";

// 单条批注（前后端一致；坐标为 PDF 点，左上原点）
export interface PdfAnnotation {
  id: string;
  page: number; // 0-based
  type: AnnotationType;
  text: string; // 文本类批注选中的原文摘录
  comment: string; // 用户注释
  color: string; // #rrggbb
  rect?: [number, number, number, number] | null; // note 锚点 / rectangle 框
  quads?: [number, number, number, number][] | null; // 文本类逐行矩形
  ink?: [number, number][][] | null; // 画笔笔迹（每笔一条点列）
  created_at?: string;
  updated_at?: string;
  source?: "user" | "pdf"; // pdf = 从原 PDF 导入的已有批注
  xref?: number | null;
}

export interface AnnotPageInfo {
  page: number;
  width: number;
  height: number;
}

export interface OpenAnnotResult {
  annot_id: string;
  page_count: number;
  pages: AnnotPageInfo[];
  annotations: PdfAnnotation[];
}

export interface SaveAnnotResult {
  ok: boolean;
  written: number;
  skipped: number;
  deleted_existing: number;
  message: string;
}

// 一次编辑操作（只发送有改动的块）
export interface EditOp {
  id: string;
  text?: string;
  bbox?: [number, number, number, number];
  size?: number;
  color?: string;
  deleted?: boolean;
}

export interface SaveEditsResult {
  ok: boolean;
  edit_id: string;
  mode: "text" | "compatible";
  mode_label: string;
  edited: number;
  message: string;
}

// 一个打开的 PDF 标签页：持有自己的 PDF 数据与三大功能的状态，
// 切换标签页时各自的状态独立保留。
export interface PdfTab {
  id: string;
  name: string;
  pdfData: Uint8Array;
  currentPage: number;

  // 全文翻译
  translationTaskId: string | null;
  translationRunning: boolean;
  translationProgress: number; // 0~1
  translationMessage: string;
  translationMode: string; // "pdf2zh" | "fallback" | ""
  translatedPdfUrl: string | null;
  translationError: string;

  // 覆盖翻译（跳过 pdf2zh）
  overlayTaskId: string | null;
  overlayRunning: boolean;
  overlayProgress: number; // 0~1
  overlayMessage: string;
  overlayPdfUrl: string | null;
  overlayError: string;

  // 文献总结
  summaryContent: string;
  summaryRunning: boolean;
  summaryError: string;

  // 划词翻译（最近一次）
  lastSelection: SelectionInfo | null;
  lastTranslated: string;
  lastTranslateError: string;
}
