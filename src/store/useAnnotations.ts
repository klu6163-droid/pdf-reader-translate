// 标注状态：按 PDF id 存标注列表 + 当前工具/颜色 + dirty 标志。
// 标注只在内存（不持久化）；保存时由 pdf-lib 烧录进 PDF 副本。

import { create } from "zustand";
import type { Annotation, AnnotationTool } from "@/types";

interface AnnotationState {
  annotations: Record<string, Annotation[]>;
  tool: AnnotationTool;
  color: string;
  dirty: Record<string, boolean>;

  setTool: (t: AnnotationTool) => void;
  setColor: (c: string) => void;
  getAnnotations: (pdfId: string) => Annotation[];
  addAnnotation: (pdfId: string, a: Annotation) => void;
  removeAnnotation: (pdfId: string, id: string) => void;
  clearAnnotations: (pdfId: string) => void;
  /** 标记某个 PDF 的标注已保存（清 dirty） */
  markClean: (pdfId: string) => void;
  /** 清掉某个 PDF 的全部标注与 dirty（丢弃） */
  discard: (pdfId: string) => void;
  isDirty: (pdfId: string) => boolean;
}

export const useAnnotations = create<AnnotationState>((set, get) => ({
  annotations: {},
  tool: "select",
  color: "#fde047", // yellow-300
  dirty: {},

  setTool: (t) => set({ tool: t }),
  setColor: (c) => set({ color: c }),

  getAnnotations: (pdfId) => get().annotations[pdfId] || [],

  addAnnotation: (pdfId, a) =>
    set((s) => ({
      annotations: {
        ...s.annotations,
        [pdfId]: [...(s.annotations[pdfId] || []), a],
      },
      dirty: { ...s.dirty, [pdfId]: true },
    })),

  removeAnnotation: (pdfId, id) =>
    set((s) => ({
      annotations: {
        ...s.annotations,
        [pdfId]: (s.annotations[pdfId] || []).filter((a) => a.id !== id),
      },
      dirty: { ...s.dirty, [pdfId]: true },
    })),

  clearAnnotations: (pdfId) =>
    set((s) => ({
      annotations: { ...s.annotations, [pdfId]: [] },
      dirty: { ...s.dirty, [pdfId]: true },
    })),

  markClean: (pdfId) =>
    set((s) => ({ dirty: { ...s.dirty, [pdfId]: false } })),

  discard: (pdfId) =>
    set((s) => ({
      annotations: { ...s.annotations, [pdfId]: [] },
      dirty: { ...s.dirty, [pdfId]: false },
    })),

  isDirty: (pdfId) => !!get().dirty[pdfId],
}));
