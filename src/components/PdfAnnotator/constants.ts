// PdfAnnotator 内部共享的常量与工具函数（避免子组件之间隐式耦合）
import type { AnnotationType } from "@/types";

/** 工具枚举：select + 所有 AnnotationType */
export type Tool = "select" | AnnotationType;

/** 文本类工具：需要基于用户划选文字生成 quads */
export const TEXT_TOOLS: Tool[] = ["highlight", "underline", "strikeout"];

/** 默认调色板（用户仍可通过 color input 自定义） */
export const PALETTE = ["#ffd633", "#4caf50", "#2196f3", "#f44336", "#9c27b0", "#ff9800"];

/** 类型 → 中文标签（用于列表/属性面板显示） */
export const TYPE_LABELS: Record<AnnotationType, string> = {
  highlight: "高亮",
  underline: "下划线",
  strikeout: "删除线",
  note: "笔记",
  rectangle: "矩形框",
  ink: "画笔",
};

/** 去除 uuid 中的连字符，生成 32 位纯 hex ID（与后端约定的批注 ID 格式一致） */
export const newId = (): string => crypto.randomUUID().replace(/-/g, "");

/** 四舍五入到两位小数（PDF 坐标够用，避免浮点噪声） */
export const r2 = (v: number): number => Math.round(v * 100) / 100;
