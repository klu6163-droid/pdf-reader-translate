// useTranslateTask：统一全文翻译 / 覆盖翻译的 SSE 任务生命周期。
// 两种翻译模式共享相同的「启动 → 订阅进度 → 获取结果」流程，
// 仅字段名和 API 函数不同，通过 TranslateTaskConfig 注入差异。

import { useCallback, useEffect, useState } from "react";
import { bytesToPdfBlob } from "@/services/api";
import { useStore, useActiveTab } from "@/store/useSettings";
import type { PdfProgressEvent, PdfTab, LLMSettings } from "@/types";

/** 每种翻译模式需要提供的差异化配置 */
export interface TranslateTaskConfig {
  /** 从 tab 中读取 taskId 的字段名 */
  taskIdField: "translationTaskId" | "overlayTaskId";
  runningField: "translationRunning" | "overlayRunning";
  progressField: "translationProgress" | "overlayProgress";
  messageField: "translationMessage" | "overlayMessage";
  resultUrlField: "translatedPdfUrl" | "overlayPdfUrl";
  errorField: "translationError" | "overlayError";
  /** 全文翻译独有：模式字段（pdf2zh / fallback） */
  modeField?: "translationMode";
  /** 启动翻译的 API 函数 */
  startApi: (file: Blob, filename: string, settings: LLMSettings) => Promise<string>;
  /** 订阅 SSE 进度 */
  subscribeApi: (
    taskId: string,
    onEvent: (e: PdfProgressEvent) => void,
    onError?: (err: Error) => void
  ) => () => void;
  /** 根据 taskId 生成结果 PDF 的 URL */
  resultUrlApi: (taskId: string) => string;
}

export interface TranslateTaskState {
  taskId: string | null;
  running: boolean;
  progress: number;
  message: string;
  mode: string;
  resultUrl: string | null;
  error: string;
}

export interface TranslateTaskActions {
  start: () => Promise<void>;
  /** 打开译文编辑/批注浮层前，fetch PDF 字节 */
  openTranslatedOverlay: (url: string, kind: "edit" | "annot") => Promise<void>;
  overlay: { kind: "edit" | "annot"; data: Uint8Array } | null;
  closeOverlay: () => void;
  editorLoading: boolean;
  editorError: string;
  clearEditorError: () => void;
}

export function useTranslateTask(
  config: TranslateTaskConfig
): [TranslateTaskState, TranslateTaskActions] {
  const tab = useActiveTab();

  const [overlay, setOverlay] = useState<{ kind: "edit" | "annot"; data: Uint8Array } | null>(null);
  const [editorLoading, setEditorLoading] = useState(false);
  const [editorError, setEditorError] = useState("");

  const openTranslatedOverlay = useCallback(async (url: string, kind: "edit" | "annot") => {
    setEditorLoading(true);
    setEditorError("");
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error("获取译文 PDF 失败（可能已被清理，请重新翻译）");
      setOverlay({ kind, data: new Uint8Array(await resp.arrayBuffer()) });
    } catch (e) {
      setEditorError(e instanceof Error ? e.message : "打开失败");
    } finally {
      setEditorLoading(false);
    }
  }, []);

  // 从当前 tab 读取任务状态
  const taskId = tab ? (tab[config.taskIdField] as string | null) : null;
  const running = tab ? (tab[config.runningField] as boolean) : false;
  const progress = tab ? (tab[config.progressField] as number) : 0;
  const message = tab ? (tab[config.messageField] as string) : "";
  const mode = tab && config.modeField ? (tab[config.modeField] as string) : "";
  const resultUrl = tab ? (tab[config.resultUrlField] as string | null) : null;
  const error = tab ? (tab[config.errorField] as string) : "";

  // 订阅 SSE 进度
  useEffect(() => {
    if (!taskId) return;
    const st0 = useStore.getState();
    const owner0 = st0.tabs.find((t) => t[config.taskIdField] === taskId);
    if (
      !owner0 ||
      (owner0[config.resultUrlField] as string | null) ||
      (owner0[config.errorField] as string) ||
      !(owner0[config.runningField] as boolean)
    )
      return;

    const cleanup = config.subscribeApi(
      taskId,
      (e: PdfProgressEvent) => {
        const cur = useStore.getState();
        const owner = cur.tabs.find((t) => t[config.taskIdField] === taskId);
        if (!owner) return;
        const patch: Partial<PdfTab> = {
          [config.progressField]: e.progress,
          [config.messageField]: e.message,
        } as Partial<PdfTab>;
        if (e.mode && config.modeField) {
          (patch as Record<string, unknown>)[config.modeField] = e.mode;
        }
        cur.updateTab(owner.id, patch);
        if (e.done) {
          cur.updateTab(
            owner.id,
            e.error
              ? ({ [config.runningField]: false, [config.errorField]: e.message } as Partial<PdfTab>)
              : ({
                  [config.runningField]: false,
                  [config.resultUrlField]: config.resultUrlApi(taskId),
                } as Partial<PdfTab>)
          );
        }
      },
      (err) => {
        const cur = useStore.getState();
        const owner = cur.tabs.find((t) => t[config.taskIdField] === taskId);
        if (owner)
          cur.updateTab(owner.id, {
            [config.runningField]: false,
            [config.errorField]: err.message,
          } as Partial<PdfTab>);
      }
    );
    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  const start = useCallback(async () => {
    const s = useStore.getState();
    const current = s.tabs.find((t) => t.id === s.activeTabId);
    if (!current) return;
    const targetId = current.id;

    if (!current.pdfData) {
      s.updateTab(targetId, { [config.errorField]: "请先打开一个 PDF" } as Partial<PdfTab>);
      return;
    }
    if (!s.hasSettings()) {
      s.updateTab(targetId, { [config.errorField]: "请先在「设置」中配置 API Key" } as Partial<PdfTab>);
      s.setSettingsOpen(true);
      return;
    }

    const initPatch: Record<string, unknown> = {
      [config.runningField]: true,
      [config.errorField]: "",
      [config.progressField]: 0,
      [config.resultUrlField]: null,
      [config.messageField]: "上传中...",
      [config.taskIdField]: null,
    };
    if (config.modeField) initPatch[config.modeField] = "";
    s.updateTab(targetId, initPatch as Partial<PdfTab>);

    try {
      const blob = bytesToPdfBlob(current.pdfData);
      const newTaskId = await config.startApi(blob, current.name, s.settings);
      useStore.getState().updateTab(targetId, {
        [config.taskIdField]: newTaskId,
      } as Partial<PdfTab>);
    } catch (e) {
      useStore.getState().updateTab(targetId, {
        [config.runningField]: false,
        [config.errorField]: e instanceof Error ? e.message : "启动失败",
      } as Partial<PdfTab>);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const state: TranslateTaskState = { taskId, running, progress, message, mode, resultUrl, error };
  const actions: TranslateTaskActions = {
    start,
    openTranslatedOverlay,
    overlay,
    closeOverlay: () => setOverlay(null),
    editorLoading,
    editorError,
    clearEditorError: () => setEditorError(""),
  };

  return [state, actions];
}
