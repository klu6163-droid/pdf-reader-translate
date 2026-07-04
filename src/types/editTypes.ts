// PDF 编辑相关类型。
// 覆盖式编辑（overlay）用页面相对坐标 (0~1, y 向下)，相对未旋转页，与缩放无关。
// 页面级编辑（pageOrder/rotations）控制页面顺序与旋转。

export type EditTool =
  | "select"
  | "text"
  | "highlight"
  | "underline"
  | "draw"
  | "rectangle"
  | "arrow"
  | "image"
  | "redact";

export type OverlayType =
  | "text"
  | "highlight"
  | "underline"
  | "draw"
  | "rectangle"
  | "arrow"
  | "image"
  | "redact";

export interface Overlay {
  id: string;
  type: OverlayType;
  /** 原始页号（1-based），与 pageOrder 解耦：重排/删除页面后 overlay 仍归属原页 */
  page: number;
  color: string;
  /** 矩形类：高亮 / 下划线 / 矩形 / 遮盖 */
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  /** 文字 */
  text?: string;
  fontSize?: number;
  /** 画笔点序列 */
  points?: { x: number; y: number }[];
  /** 箭头端点 */
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  /** 图片 base64 data URL */
  imageData?: string;
  /** 通用线宽 */
  strokeWidth?: number;
}

export interface EditState {
  /** 原始页号（1-based）的显示顺序；删除的页不在此列表 */
  pageOrder: number[];
  /** 原始页号 → 旋转度数（0/90/180/270） */
  rotations: Record<number, number>;
  /** 覆盖编辑列表 */
  overlays: Overlay[];
}

export function createInitialEditState(numPages: number): EditState {
  return {
    pageOrder: Array.from({ length: numPages }, (_, i) => i + 1),
    rotations: {},
    overlays: [],
  };
}
