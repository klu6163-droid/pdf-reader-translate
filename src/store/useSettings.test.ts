import { beforeEach, describe, expect, it } from "vitest";
import { useStore } from "@/store/useSettings";

/**
 * useStore（Zustand + persist）单元测试。
 *
 * 重点验证：
 * - 设置合并
 * - Tab 生命周期（新增/关闭/邻近激活/上限）
 * - 最近文件去重置顶
 * - History / Notes 限长
 */

// 每个用例前重置 store 到初始态（避免用例间污染）
const INITIAL_SNAPSHOT = useStore.getState();
beforeEach(() => {
  useStore.setState(
    {
      ...INITIAL_SNAPSHOT,
      settings: { apiKey: "", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
      tabs: [],
      activeTabId: null,
      recentFiles: [],
      history: [],
      notes: [],
      settingsOpen: false,
      backendStatus: "unknown",
      splitRatio: 0.5,
      syncTranslatedPage: true,
      notesFlash: 0,
    },
    true,
  );
});

const bytes = () => new Uint8Array([37, 80, 68, 70]); // "%PDF"

describe("settings", () => {
  it("hasSettings 依赖 apiKey", () => {
    expect(useStore.getState().hasSettings()).toBe(false);
    useStore.getState().setSettings({ apiKey: "sk-xxx" });
    expect(useStore.getState().hasSettings()).toBe(true);
  });

  it("setSettings 合并而不是替换", () => {
    useStore.getState().setSettings({ apiKey: "sk-xxx" });
    useStore.getState().setSettings({ model: "gpt-4o" });
    const s = useStore.getState().settings;
    expect(s.apiKey).toBe("sk-xxx");
    expect(s.model).toBe("gpt-4o");
    expect(s.baseUrl).toBe("https://api.openai.com/v1");
  });
});

describe("tabs", () => {
  it("addTab 添加并激活", () => {
    const id = useStore.getState().addTab(bytes(), "a.pdf");
    expect(id).toBeTruthy();
    expect(useStore.getState().tabs).toHaveLength(1);
    expect(useStore.getState().activeTabId).toBe(id);
  });

  it("超过上限（8）返回 null", () => {
    for (let i = 0; i < 8; i++) useStore.getState().addTab(bytes(), `${i}.pdf`);
    expect(useStore.getState().addTab(bytes(), "9.pdf")).toBeNull();
    expect(useStore.getState().tabs).toHaveLength(8);
  });

  it("closeTab 后激活相邻标签（优先右侧）", () => {
    const a = useStore.getState().addTab(bytes(), "a.pdf")!;
    const b = useStore.getState().addTab(bytes(), "b.pdf")!;
    const c = useStore.getState().addTab(bytes(), "c.pdf")!;
    useStore.getState().setActiveTab(b);
    useStore.getState().closeTab(b);
    // 关掉中间那个后，右侧的 c 被激活
    expect(useStore.getState().activeTabId).toBe(c);
    // 关掉最后一个后，激活左侧
    useStore.getState().closeTab(c);
    expect(useStore.getState().activeTabId).toBe(a);
  });

  it("updateTab 只更新命中项", () => {
    const a = useStore.getState().addTab(bytes(), "a.pdf")!;
    const b = useStore.getState().addTab(bytes(), "b.pdf")!;
    useStore.getState().updateTab(a, { currentPage: 42 });
    const tabs = useStore.getState().tabs;
    expect(tabs.find((t) => t.id === a)?.currentPage).toBe(42);
    expect(tabs.find((t) => t.id === b)?.currentPage).toBe(1);
  });
});

describe("recentFiles / history / notes", () => {
  it("最近文件去重并置顶", () => {
    const s = useStore.getState();
    s.addRecentFile("/a.pdf", "a.pdf");
    s.addRecentFile("/b.pdf", "b.pdf");
    s.addRecentFile("/a.pdf", "a.pdf"); // 再次打开 a
    const rf = useStore.getState().recentFiles;
    expect(rf).toHaveLength(2);
    expect(rf[0].path).toBe("/a.pdf");
  });

  it("history 保留最新 50 条", () => {
    for (let i = 0; i < 55; i++) {
      useStore.getState().addHistory({
        original: `s${i}`,
        translated: `t${i}`,
        page: 1,
        tabName: "test.pdf",
      });
    }
    expect(useStore.getState().history).toHaveLength(50);
    // 最新的在头部
    expect(useStore.getState().history[0].original).toBe("s54");
  });

  it("addNote/removeNote", () => {
    useStore.getState().addNote({
      original: "hello",
      translated: "你好",
      page: 1,
      tabName: "test.pdf",
    });
    const id = useStore.getState().notes[0].id;
    useStore.getState().removeNote(id);
    expect(useStore.getState().notes).toHaveLength(0);
  });
});
