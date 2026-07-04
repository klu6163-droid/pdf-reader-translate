// PDF 编辑状态 store。
// 按 pdfId 存 EditState，快照式 undo/redo（history + historyIndex）。
// 编辑与翻译/设置完全解耦：独立 store，不碰 settings/API Key。

import { create } from "zustand";
import type { EditState, EditTool, Overlay } from "@/types/editTypes";
import { createInitialEditState } from "@/types/editTypes";

interface EditStoreState {
  states: Record<string, EditState>;
  history: Record<string, EditState[]>;
  historyIndex: Record<string, number>;
  tool: EditTool;
  color: string;
  strokeWidth: number;
  /** 待放置的图片（base64）。设后 tool 切到 image，点页面放置 */
  pendingImage: string | null;

  setTool: (t: EditTool) => void;
  setColor: (c: string) => void;
  setStrokeWidth: (w: number) => void;
  setPendingImage: (data: string | null) => void;

  /** 若该 pdfId 尚未初始化，按页数建初始状态 */
  ensureState: (pdfId: string, numPages: number) => void;
  getEditState: (pdfId: string) => EditState | undefined;
  /** 用新状态覆盖并压入历史（截断 redo 尾巴） */
  pushState: (pdfId: string, state: EditState) => void;

  addOverlay: (pdfId: string, overlay: Overlay) => void;
  removeOverlay: (pdfId: string, id: string) => void;
  setPageOrder: (pdfId: string, order: number[]) => void;
  rotatePage: (pdfId: string, page: number, degrees: number) => void;
  deletePage: (pdfId: string, page: number) => void;
  movePage: (pdfId: string, fromIdx: number, toIdx: number) => void;

  undo: (pdfId: string) => void;
  redo: (pdfId: string) => void;
  canUndo: (pdfId: string) => boolean;
  canRedo: (pdfId: string) => boolean;
  /** 丢弃该 pdfId 全部编辑状态与历史 */
  discard: (pdfId: string) => void;
}

const DEFAULTS = {
  tool: "select" as EditTool,
  color: "#ef4444", // red-500
  strokeWidth: 2,
};

export const useEditStore = create<EditStoreState>((set, get) => ({
  states: {},
  history: {},
  historyIndex: {},
  tool: DEFAULTS.tool,
  color: DEFAULTS.color,
  strokeWidth: DEFAULTS.strokeWidth,
  pendingImage: null,

  setTool: (t) => set({ tool: t }),
  setColor: (c) => set({ color: c }),
  setStrokeWidth: (w) => set({ strokeWidth: w }),
  setPendingImage: (data) => set({ pendingImage: data, tool: data ? "image" : "select" }),

  ensureState: (pdfId, numPages) => {
    if (get().history[pdfId]) return;
    const initial = createInitialEditState(numPages);
    set((s) => ({
      states: { ...s.states, [pdfId]: initial },
      history: { ...s.history, [pdfId]: [initial] },
      historyIndex: { ...s.historyIndex, [pdfId]: 0 },
    }));
  },

  getEditState: (pdfId) => get().states[pdfId],

  pushState: (pdfId, state) =>
    set((s) => {
      const hist = s.history[pdfId] || [];
      const idx = s.historyIndex[pdfId] ?? -1;
      const newHist = [...hist.slice(0, idx + 1), state];
      return {
        states: { ...s.states, [pdfId]: state },
        history: { ...s.history, [pdfId]: newHist },
        historyIndex: { ...s.historyIndex, [pdfId]: newHist.length - 1 },
      };
    }),

  addOverlay: (pdfId, overlay) => {
    const cur = get().states[pdfId];
    if (!cur) return;
    get().pushState(pdfId, { ...cur, overlays: [...cur.overlays, overlay] });
  },

  removeOverlay: (pdfId, id) => {
    const cur = get().states[pdfId];
    if (!cur) return;
    get().pushState(pdfId, {
      ...cur,
      overlays: cur.overlays.filter((o) => o.id !== id),
    });
  },

  setPageOrder: (pdfId, order) => {
    const cur = get().states[pdfId];
    if (!cur) return;
    get().pushState(pdfId, { ...cur, pageOrder: order });
  },

  rotatePage: (pdfId, page, degrees) => {
    const cur = get().states[pdfId];
    if (!cur) return;
    get().pushState(pdfId, {
      ...cur,
      rotations: { ...cur.rotations, [page]: degrees },
    });
  },

  deletePage: (pdfId, page) => {
    const cur = get().states[pdfId];
    if (!cur) return;
    get().pushState(pdfId, {
      ...cur,
      pageOrder: cur.pageOrder.filter((p) => p !== page),
    });
  },

  movePage: (pdfId, fromIdx, toIdx) => {
    const cur = get().states[pdfId];
    if (!cur || fromIdx === toIdx) return;
    const order = [...cur.pageOrder];
    const [moved] = order.splice(fromIdx, 1);
    order.splice(toIdx, 0, moved);
    get().pushState(pdfId, { ...cur, pageOrder: order });
  },

  undo: (pdfId) =>
    set((s) => {
      const idx = s.historyIndex[pdfId] ?? 0;
      if (idx <= 0) return {};
      const newIdx = idx - 1;
      const hist = s.history[pdfId] || [];
      return {
        historyIndex: { ...s.historyIndex, [pdfId]: newIdx },
        states: { ...s.states, [pdfId]: hist[newIdx] },
      };
    }),

  redo: (pdfId) =>
    set((s) => {
      const idx = s.historyIndex[pdfId] ?? 0;
      const hist = s.history[pdfId] || [];
      if (idx >= hist.length - 1) return {};
      const newIdx = idx + 1;
      return {
        historyIndex: { ...s.historyIndex, [pdfId]: newIdx },
        states: { ...s.states, [pdfId]: hist[newIdx] },
      };
    }),

  canUndo: (pdfId) => (get().historyIndex[pdfId] ?? 0) > 0,
  canRedo: (pdfId) => {
    const idx = get().historyIndex[pdfId] ?? 0;
    const hist = get().history[pdfId] || [];
    return idx < hist.length - 1;
  },

  discard: (pdfId) =>
    set((s) => {
      const { [pdfId]: _s, ...restStates } = s.states;
      const { [pdfId]: _h, ...restHist } = s.history;
      const { [pdfId]: _i, ...restIdx } = s.historyIndex;
      return { states: restStates, history: restHist, historyIndex: restIdx };
    }),
}));
