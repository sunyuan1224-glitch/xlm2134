/*
 * 快捷键的**真实 WebKit** 端到端断言。
 *
 * 规格来源 = 「帮助 → 快捷键」对话框里的那份列表（HelpDialog 的 SHORTCUTS 导出）。
 * 这份测试逐条把它变成真实的按键：用 `new KeyboardEvent("keydown", …)` 带上真正的
 * ctrlKey / shiftKey / altKey / key（例如 Ctrl+Shift+] 在美式键盘上给的是 `}`，
 * Alt+Shift+5 给的是 `%`），dispatch 到 CodeMirror 的 `.cm-content` —— 和用户真的
 * 按下去时事件的目标一致 —— 然后断言**可见效果**：
 *
 *   - 行内：文档里必须真的出现 `**` `*` `<u>` `~~`；
 *   - 引用/列表/删段：文档内容断言；
 *   - 对话框类（Ctrl+K / Ctrl+Shift+I / Ctrl+P / Ctrl+,）：DOM 里必须出现 .modal-mask；
 *   - 视图类（Ctrl+/ F8 F9 Ctrl+Shift+L/B）：读 store；
 *   - F11：测试页没有 Tauri（isDesktop() === false），只能断言「按键被处理、给出提示、
 *     不抛错」；真机全屏另由 capabilities 断言 + 人工确认（见用例末尾的说明）；
 *   - Alt+↑/↓：CodeMirror defaultKeymap 的 moveLineUp/moveLineDown，断言行真的换了位置。
 *
 * 每条用例单独 PASS/FAIL（输出 `CASE PASS: …` / `CASE FAIL: …`），最后只发一条总判决，
 * 让 test-webkit.py 知道该退出。全程用内存 fixture，不碰真实工作区、不联网。
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { Transaction } from "@codemirror/state";
import App from "../src/App";
import { useStore } from "../src/store";
import { api, type FileNode } from "../src/api";
import { SHORTCUTS } from "../src/components/HelpDialog";
import capabilities from "../src-tauri/capabilities/default.json";
import "../src/styles.css";
import "../src/shell.css";

const send = (text: string) => (window as any).webkit.messageHandlers.result.postMessage(text);
const wait = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

function assert(value: unknown, message: string) {
  if (!value) throw new Error(message);
}

/* ------------------------------------------------------------------ *
 * 逐条 PASS/FAIL：任何一条炸掉都不影响后面的用例继续跑
 * ------------------------------------------------------------------ */

interface CaseResult {
  name: string;
  ok: boolean;
  why?: string;
}
const results: CaseResult[] = [];

/**
 * 让 React 把上一批 store 变化渲染完、Editor 的外部同步跑完，再进下一条用例。
 * 少了这一步，直接在 EditorView 上改文档的用例会和「慢半拍」的 store 回写打架
 * （表现为下一摘用例读到上一摘的残留内容），那不是应用的问题而是测试自己没等。
 */
async function settle(): Promise<void> {
  await wait(50);
}

async function ck(name: string, body: () => void | Promise<void>): Promise<void> {
  try {
    await settle();
    await body();
    await settle();
    results.push({ name, ok: true });
    send(`CASE PASS: ${name}`);
  } catch (e) {
    const why = String((e as Error)?.message ?? e);
    results.push({ name, ok: false, why });
    send(`CASE FAIL: ${name} — ${why}`);
  }
}

/* ------------------------------------------------------------------ *
 * 内存 fixture（绝不落盘、绝不联网）
 * ------------------------------------------------------------------ */

const ROOT = "/shortcut-fixture";
const BOOK = "书";
const C1 = `${BOOK}/001-第一章.md`;
const DOC = "# 第一章 启程\n\n正文一。\n\n正文二。\n\n正文三。\n";
const MOVE_DOC = "甲段。\n乙段。\n丙段。\n";

const memFiles = new Map<string, string>([[C1, DOC]]);

function installApiMocks() {
  const a = api as unknown as Record<string, (...args: any[]) => Promise<any>>;
  a.scan = async () => ({
    root: ROOT,
    tree: [
      { path: BOOK, name: BOOK, is_dir: true, children: [{ path: C1, name: "001-第一章.md", is_dir: false, children: [] }] } as FileNode,
    ],
    files: [...memFiles.keys()],
  });
  a.readFile = async (_root: string, path: string) =>
    memFiles.has(path) ? { path, content: memFiles.get(path)! } : null;
  a.writeFile = async (_root: string, path: string, content: string) => {
    memFiles.set(path, content);
  };
  a.createFile = async (_root: string, path: string, content: string) => {
    memFiles.set(path, content);
  };
  a.createDir = async () => {};
  a.deleteEntry = async () => {};
  a.renameEntry = async () => {};
  a.readSidecar = async () => null;
  a.writeSidecar = async () => {};
  // 插图快捷键在浏览器里没有原生对话框：换成内存实现，断言真的插进正文
  a.pickImageFiles = async () => ["/tmp/假图.png"];
  a.copyAsset = async (_root: string, _src: string, destRel: string) => destRel;
}

/* ------------------------------------------------------------------ *
 * 「快捷键文本」→ 真实 KeyboardEvent
 *
 * 这里刻意按**用户手按下去时浏览器实际给出的 key** 来发：
 * Shift 会让 ] [ ` 5 变成 } { ~ %，而 App 的匹配必须照样认得出来。
 * ------------------------------------------------------------------ */

const MAIN_KEY: Record<string, { plain: string; shifted?: string; code: string }> = {
  "]": { plain: "]", shifted: "}", code: "BracketRight" },
  "[": { plain: "[", shifted: "{", code: "BracketLeft" },
  "5": { plain: "5", shifted: "%", code: "Digit5" },
  "↑": { plain: "ArrowUp", code: "ArrowUp" },
  "↓": { plain: "ArrowDown", code: "ArrowDown" },
};

function initFor(keys: string): KeyboardEventInit {
  const parts = keys.split("+");
  const main = parts[parts.length - 1];
  const ctrl = parts.includes("Ctrl") || parts.includes("Mod");
  const shift = parts.includes("Shift");
  const alt = parts.includes("Alt");
  const known = MAIN_KEY[main];
  let key: string;
  let code: string;
  if (known) {
    key = shift && known.shifted ? known.shifted : known.plain;
    code = known.code;
  } else if (/^[a-z]$/i.test(main)) {
    key = shift ? main.toUpperCase() : main.toLowerCase();
    code = "Key" + main.toUpperCase();
  } else {
    key = main;
    code = main;
  }
  return { key, code, ctrlKey: ctrl, shiftKey: shift, altKey: alt, bubbles: true, cancelable: true, composed: true };
}

/** 发一次真实的 keydown：默认打在编辑器正文上（用户按键时的真实目标） */
function press(keys: string, target?: EventTarget): KeyboardEvent {
  const el = target ?? document.querySelector(".cm-content") ?? window;
  const ev = new KeyboardEvent("keydown", initFor(keys));
  el.dispatchEvent(ev);
  return ev;
}

/* ------------------------------------------------------------------ *
 * 读文档 / 放光标
 * ------------------------------------------------------------------ */

function view(): EditorView {
  const dom = document.querySelector<HTMLElement>(".cm-content");
  assert(dom, "页面上找不到 CodeMirror 的 .cm-content");
  const v = EditorView.findFromDOM(dom!);
  assert(v, "找不到 .cm-content 对应的 EditorView");
  return v!;
}

function docText(): string {
  return view().state.doc.toString();
}

/**
 * 把正文重置成固定内容并放好光标。
 * 这一步当成「换了个文件/重新载入」看：不进撤销历史，否则它会和用例里真正的编辑
 * 落进同一个撤销组（CodeMirror 默认 500ms 内合并），Ctrl+Z 的断言就成了假失败。
 */
function resetDoc(text: string, anchor = 0, head = anchor): void {
  const v = view();
  v.dispatch({
    changes: { from: 0, to: v.state.doc.length, insert: text },
    selection: { anchor: Math.min(anchor, text.length), head: Math.min(head, text.length) },
    annotations: Transaction.addToHistory.of(false),
  });
  view().focus();
}

function posOf(needle: string): number {
  const i = DOC.indexOf(needle);
  assert(i >= 0, `fixture 自身有问题：文档里没有「${needle}」`);
  return i;
}

function select(needle: string): void {
  const at = docText().indexOf(needle);
  assert(at >= 0, `文档里没有「${needle}」，无法选中：${JSON.stringify(docText())}`);
  const v = view();
  v.dispatch({ selection: { anchor: at, head: at + needle.length } });
}

/** 断言文档里出现了某个标记，并且把整篇原文回显出来方便定位 */
function expectDoc(needle: string, hint: string): void {
  const text = docText();
  assert(text.includes(needle), `${hint}：期待出现 ${JSON.stringify(needle)}，实际 ${JSON.stringify(text)}`);
}

function modal(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".modal-mask");
}

function modalTitle(): string {
  return (document.querySelector(".modal-title")?.textContent ?? "").trim();
}

async function closeModal(): Promise<void> {
  const m = modal();
  assert(m, "想关闭对话框，但页面上没有 .modal-mask");
  // 设置/快速打开走 Esc，PromptDialog 走点遮罩：两种都发一遍，跟用户能做的一样
  const active = document.activeElement as HTMLElement | null;
  const esc = () => new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  (active ?? m!).dispatchEvent(esc());
  window.dispatchEvent(esc());
  await wait(40);
  const still = modal();
  if (still) {
    still.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    still.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await wait(40);
  }
  assert(!modal(), "对话框没有关掉");
}

/* ------------------------------------------------------------------ *
 * 正文里逐条跑的用例
 * ------------------------------------------------------------------ */

async function run() {
  installApiMocks();

  useStore.setState({
    root: ROOT,
    files: [C1],
    tree: [
      { path: BOOK, name: BOOK, is_dir: true, children: [{ path: C1, name: "001-第一章.md", is_dir: false, children: [] }] } as FileNode,
    ],
    expanded: new Set([BOOK]),
    chapters: [{ path: C1, name: "001-第一章.md", title: "第一章 启程", status: "草稿", summary: "", words: 12 }],
    contents: { [C1]: DOC },
    openTabs: [C1],
    activePath: C1,
    volumes: [],
    chapterOrder: {},
    sidebarTab: "files",
    sidebarOpen: true,
    workbenchOpen: false,
    sourceMode: false,
    focusMode: false,
    typewriterMode: false,
  });
  createRoot(document.getElementById("root")!).render(<App />);
  await wait(200);
  assert(document.querySelector(".cm-content"), "编辑器没有挂载起来，后面的用例没法跑");

  /* ---------------- 行内格式 ---------------- */

  await ck("Ctrl+B → 加粗", () => {
    resetDoc(DOC, posOf("正文一。"));
    select("正文一。");
    press("Ctrl+B");
    expectDoc("**正文一。**", "Ctrl+B 没有把选区变成加粗");
  });

  await ck("Ctrl+I → 斜体", () => {
    resetDoc(DOC, posOf("正文二。"));
    select("正文二。");
    press("Ctrl+I");
    expectDoc("*正文二。*", "Ctrl+I 没有把选区变成斜体");
  });

  await ck("Ctrl+U → 下划线", () => {
    resetDoc(DOC, posOf("正文三。"));
    select("正文三。");
    press("Ctrl+U");
    expectDoc("<u>正文三。</u>", "Ctrl+U 没有把选区变成下划线");
  });

  await ck("Alt+Shift+5 → 删除线", () => {
    resetDoc(DOC, posOf("正文一。"));
    select("正文一。");
    press("Alt+Shift+5");
    expectDoc("~~正文一。~~", "Alt+Shift+5 没有把选区变成删除线");
  });

  /* ---------------- 块级格式 ---------------- */

  /* ---------------- 标题等级（Ctrl+1..6 / Ctrl+0） ---------------- */

  await ck("Ctrl+1..6 → 把光标所在段落设成对应级别的标题", () => {
    for (const n of [1, 2, 3, 4, 5, 6]) {
      resetDoc(DOC, posOf("正文一。"));
      press(`Ctrl+${n}`);
      expectDoc(`${"#".repeat(n)} 正文一。`, `Ctrl+${n} 没有把段落设成 ${n} 级标题`);
    }
  });

  await ck("Ctrl+1 再按一次 → 取消标题（同级即开关）", () => {
    resetDoc(DOC, posOf("正文一。"));
    press("Ctrl+1");
    expectDoc("# 正文一。", "第一次 Ctrl+1 应把段落设成一级标题");
    press("Ctrl+1");
    assert(!docText().includes("# 正文一。"), `第二次 Ctrl+1 应取消标题，实际 ${JSON.stringify(docText())}`);
  });

  await ck("Ctrl+0 → 变回正文", () => {
    resetDoc(DOC, posOf("正文一。"));
    press("Ctrl+3");
    expectDoc("### 正文一。", "Ctrl+3 应先设成三级标题");
    press("Ctrl+0");
    const text = docText();
    assert(text.includes("正文一。") && !text.includes("# 正文一。"), `Ctrl+0 应去掉标题标记，实际 ${JSON.stringify(text)}`);
  });

  await ck("Ctrl+Shift+Q → 引用", () => {
    resetDoc(DOC, posOf("正文一。"));
    press("Ctrl+Shift+Q");
    expectDoc("> 正文一。", "Ctrl+Shift+Q 没有把段落变成引用");
  });

  await ck("Ctrl+Shift+] → 无序列表", () => {
    resetDoc(DOC, posOf("正文一。"));
    press("Ctrl+Shift+]");
    expectDoc("- 正文一。", "Ctrl+Shift+] 没有把段落变成无序列表");
  });

  await ck("Ctrl+Shift+[ → 有序列表", () => {
    resetDoc(DOC, posOf("正文一。"));
    press("Ctrl+Shift+[");
    expectDoc("1. 正文一。", "Ctrl+Shift+[ 没有把段落变成有序列表");
  });

  await ck("Ctrl+Shift+D → 删除段落", () => {
    resetDoc(DOC, posOf("正文二。"));
    press("Ctrl+Shift+D");
    const text = docText();
    assert(!text.includes("正文二。"), `段落没被删掉：${JSON.stringify(text)}`);
    assert(text.includes("正文一。") && text.includes("正文三。"), `不该删掉旁边的段落：${JSON.stringify(text)}`);
  });

  /* ---------------- 对话框类 ---------------- */

  await ck("Ctrl+K → 打开超链接对话框（且带出选中文字）", async () => {
    resetDoc(DOC, posOf("正文一。"));
    select("正文一。");
    await wait(80); // 选区要先过一遍 React 状态，App 才知道「选中了什么」= 真实的用户节奏
    press("Ctrl+K");
    await wait(60);
    assert(modal(), "Ctrl+K 没有打开任何对话框（.modal-mask 不存在）");
    assert(modalTitle() === "插入超链接", `对话框标题不对：${modalTitle()}`);
    const first = document.querySelector<HTMLInputElement>(".prompt-modal .panel-input");
    assert(first?.value === "正文一。", `链接文字没有带出当前选区：${JSON.stringify(first?.value)}`);
    await closeModal();
  });

  await ck("Ctrl+Shift+I → 插入本地图片（写进正文）", async () => {
    resetDoc(DOC, posOf("正文一。"));
    press("Ctrl+Shift+I");
    await wait(120);
    const text = docText();
    assert(
      /!\[假图\]\(.*假图\.png\)/.test(text),
      `图片没有插进正文：${JSON.stringify(text)}`,
    );
  });

  /* ---------------- 段落移动（CodeMirror 原生 moveLine） ---------------- */

  await ck("Alt+↑ → 光标所在行真的上移了", () => {
    const v = view();
    v.dispatch({
      changes: { from: 0, to: v.state.doc.length, insert: MOVE_DOC },
      selection: { anchor: MOVE_DOC.indexOf("乙段。") },
    });
    press("Alt+↑");
    assert(
      docText() === "乙段。\n甲段。\n丙段。\n",
      `Alt+↑ 没有把乙段移到甲段前面：${JSON.stringify(docText())}`,
    );
  });

  await ck("Alt+↓ → 光标所在行真的下移了", () => {
    const v = view();
    v.dispatch({
      changes: { from: 0, to: v.state.doc.length, insert: MOVE_DOC },
      selection: { anchor: MOVE_DOC.indexOf("乙段。") },
    });
    press("Alt+↓");
    assert(
      docText() === "甲段。\n丙段。\n乙段。\n",
      `Alt+↓ 没有把乙段移到丙段后面：${JSON.stringify(docText())}`,
    );
  });

  /* ---------------- 视图类（读 store） ---------------- */

  await ck("Ctrl+/ → 源码模式 ⇄ 即时预览（且不会往正文里塞注释）", async () => {
    resetDoc(DOC, posOf("正文一。"));
    const before = useStore.getState().sourceMode;
    press("Ctrl+/");
    assert(useStore.getState().sourceMode === !before, "Ctrl+/ 没有切换 sourceMode");
    assert(docText() === DOC, `Ctrl+/ 改动了正文：${JSON.stringify(docText())}`);
    press("Ctrl+/");
    assert(useStore.getState().sourceMode === before, "Ctrl+/ 再按一次没有切回去");
    await wait(30);
  });

  await ck("F8 → 专注模式", () => {
    const before = useStore.getState().focusMode;
    press("F8");
    assert(useStore.getState().focusMode === !before, "F8 没有切换 focusMode");
    press("F8");
  });

  await ck("F9 → 打字机模式", () => {
    const before = useStore.getState().typewriterMode;
    press("F9");
    assert(useStore.getState().typewriterMode === !before, "F9 没有切换 typewriterMode");
    press("F9");
  });

  await ck("Ctrl+Shift+L → 显示 / 折叠左侧栏（且不会顺手把相同文字全选中）", async () => {
    const before = useStore.getState().sidebarOpen;
    // 光标停在词里、不带选区：CodeMirror 的 Mod-Shift-l（selectSelectionMatches）
    // 一旦也跑起来，会把全文相同文字选中，正文看起来就像被「框了一片」
    resetDoc(DOC, posOf("正文一。") + 1);
    const docBefore = docText();
    press("Ctrl+Shift+L");
    await wait(60);
    assert(useStore.getState().sidebarOpen === !before, "Ctrl+Shift+L 没有切换 sidebarOpen");
    assert(docText() === docBefore, "Ctrl+Shift+L 不该动正文");
    assert(
      view().state.selection.main.empty,
      `Ctrl+Shift+L 顺手选中了正文：「${view().state.sliceDoc(0, 40)}」那一带被框住了`,
    );
    press("Ctrl+Shift+L");
    await wait(60);
    assert(useStore.getState().sidebarOpen === before, "再按一次没有切回来");
  });

  await ck("Ctrl+Shift+B → 显示 / 收起小说工作台", async () => {
    const before = useStore.getState().workbenchOpen;
    press("Ctrl+Shift+B");
    await wait(60);
    assert(useStore.getState().workbenchOpen === !before, "Ctrl+Shift+B 没有切换 workbenchOpen");
    press("Ctrl+Shift+B");
    await wait(60);
    assert(useStore.getState().workbenchOpen === before, "再按一次没有切回来");
  });

  /* ---------------- 编辑 / 文件 / 窗口类 ---------------- */

  await ck("Ctrl+S → 保存当前文档", async () => {
    resetDoc(DOC + "（改过）\n", 0);
    await wait(40);
    useStore.getState().setStatus("——");
    press("Ctrl+S");
    await wait(120);
    const st = useStore.getState().status;
    assert(st.startsWith("已保存"), `Ctrl+S 没有生效：状态栏是 ${JSON.stringify(st)}`);
    assert(memFiles.get(C1) === DOC + "（改过）\n", "Ctrl+S 没有把内容写进「磁盘」");
  });

  await ck("Ctrl+Z → 撤销", () => {
    resetDoc(DOC, 0);
    const v = view();
    v.dispatch({ changes: { from: v.state.doc.length, insert: "XYZ" } });
    assert(docText() === DOC + "XYZ", "fixture 自身有问题：没打上 XYZ");
    press("Ctrl+Z");
    assert(docText() === DOC, `Ctrl+Z 没有撤销：${JSON.stringify(docText())}`);
  });

  await ck("Ctrl+Shift+Z → 重做", () => {
    resetDoc(DOC, 0);
    const v = view();
    v.dispatch({ changes: { from: v.state.doc.length, insert: "XYZ" } });
    press("Ctrl+Z");
    assert(docText() === DOC, `撤销没成功：${JSON.stringify(docText())}`);
    press("Ctrl+Shift+Z");
    assert(docText() === DOC + "XYZ", `Ctrl+Shift+Z 没有重做：${JSON.stringify(docText())}`);
  });

  await ck("Ctrl+F → 文档内查找", async () => {
    resetDoc(DOC, 0);
    press("Ctrl+F");
    await wait(80);
    assert(document.querySelector(".cm-search"), "Ctrl+F 没有打开查找面板（.cm-search 不存在）");
    press("Escape");
    await wait(80);
    assert(!document.querySelector(".cm-search"), "查找面板没有关掉");
  });

  await ck("Ctrl+H → 文档内替换", async () => {
    resetDoc(DOC, 0);
    press("Ctrl+H");
    await wait(120);
    const panel = document.querySelector(".cm-search");
    assert(panel, "Ctrl+H 没有打开查找替换面板");
    assert(panel!.querySelector("input[name='replace']"), "替换面板里没有替换输入框");
    press("Escape");
    await wait(80);
  });

  await ck("Ctrl+Shift+F → 工作区搜索", async () => {
    press("Ctrl+Shift+F");
    await wait(80);
    const st = useStore.getState();
    assert(st.sidebarOpen && st.sidebarTab === "search", `没有切到工作区搜索：${st.sidebarTab}`);
    assert(document.querySelector(".sidebar-search-btn.on"), "侧栏没有停在搜索页");
  });

  await ck("Ctrl+P → 快速打开文件", async () => {
    press("Ctrl+P");
    await wait(80);
    assert(document.querySelector(".qo-input"), "Ctrl+P 没有打开快速打开面板");
    const input = document.querySelector<HTMLElement>(".qo-input")!;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await wait(80);
    assert(!document.querySelector(".qo-input"), "快速打开面板没有关掉");
  });

  await ck("Ctrl+, → 字体与排版设置", async () => {
    press("Ctrl+,");
    await wait(80);
    assert(modal(), "Ctrl+, 没有打开设置对话框");
    assert(modalTitle().includes("字体与排版"), `设置对话框标题不对：${modalTitle()}`);
    await closeModal();
  });

  /* ---------------- F11：测试页没有 Tauri ---------------- */

  await ck("F11 → 按键被处理（浏览器预览下给出明确提示、不抛错）", async () => {
    assert(!modal(), `F11 用例开始时不该有对话框挡着：${modalTitle()}`);
    useStore.getState().setStatus("——");
    const ev = press("F11", window);
    await wait(60);
    const st = useStore.getState().status;
    assert(ev.defaultPrevented, "F11 没有被 preventDefault，说明根本没被处理");
    assert(!st.startsWith("全屏切换失败"), `F11 抛错了：${st}`);
    assert(
      st.includes("浏览器预览不支持全屏切换"),
      `F11 没有被处理（状态栏没有对应提示）：${JSON.stringify(st)}`,
    );
  });

  /*
   * 真机全屏走的是 Tauri 的 set_fullscreen 命令，权限清单编译进二进制，
   * WebKit 页面里既没有 Tauri 也没有办法验证窗口状态 —— 这里只能断言
   * 「权限确实补上了」，真正的全屏开关只能在打包后的桌面版里人工确认。
   */
  await ck("capabilities/default.json 含 core:window:allow-set-fullscreen / allow-is-fullscreen", () => {
    const perms = (capabilities as { permissions?: string[] }).permissions ?? [];
    assert(
      perms.includes("core:window:allow-set-fullscreen"),
      `缺少 core:window:allow-set-fullscreen（F11 会失败）：${JSON.stringify(perms)}`,
    );
    assert(
      perms.includes("core:window:allow-is-fullscreen") || perms.includes("core:default"),
      `缺少读取全屏状态的权限：${JSON.stringify(perms)}`,
    );
  });

  /* ---------------- 反向用例：别把普通按键当成快捷键 ---------------- */

  await ck("无修饰键的 b / 1 / 5 不能被当成格式快捷键", () => {
    resetDoc(DOC, posOf("正文一。"));
    for (const k of ["b", "1", "5"]) {
      const ev = press(k);
      assert(!ev.defaultPrevented, `裸按 ${k} 被 preventDefault 了，说明误匹配成格式快捷键`);
    }
    assert(docText() === DOC, `裸按按键改动了正文：${JSON.stringify(docText())}`);
  });

  await ck("对话框打开时格式快捷键不越过它去改正文", async () => {
    resetDoc(DOC, posOf("正文一。"));
    press("Ctrl+K");
    await wait(80);
    assert(modal(), "Ctrl+K 没打开对话框，无法验证「不越过对话框」");
    const before = docText();
    press("Ctrl+B", window);
    await wait(40);
    assert(docText() === before, `对话框开着的时候 Ctrl+B 仍然改了正文：${JSON.stringify(docText())}`);
    await closeModal();
  });

  await ck("焦点在输入框里时格式快捷键不误触发正文格式", async () => {
    resetDoc(DOC, posOf("正文一。"));
    const input = document.createElement("input");
    input.type = "text";
    document.body.appendChild(input);
    input.focus();
    const before = docText();
    press("Ctrl+B", input);
    press("Ctrl+U", input);
    await wait(40);
    assert(docText() === before, `焦点在输入框里时正文还是被改了：${JSON.stringify(docText())}`);
    input.remove();
    view().focus();
  });

  /* ---------------- 帮助列表与实现的一致性 ---------------- */

  /** 把「Ctrl+1..6 / Ctrl+0」这种文案拆成一条条具体的键位 */
  function expand(entry: string): string[] {
    return entry
      .split(" / ") // 分隔符两侧一定带空格，"Ctrl+/" 里的斜杠不是分隔符
      .map((s) => s.trim())
      .flatMap((tok) => {
        const range = tok.match(/^(.+?)(\d)\.\.(\d+)$/);
        if (!range) return [tok];
        const out: string[] = [];
        for (let i = Number(range[2]); i <= Number(range[3]); i++) out.push(range[1] + i);
        return out;
      });
  }

  await ck("「帮助 → 快捷键」逐条都有对应的真实按键用例（没有只写文案的假条目）", () => {
    const documented = SHORTCUTS.flatMap(([keys]) => expand(keys));
    const missing = documented.filter((k) => !COVERED.includes(k));
    assert(
      missing.length === 0,
      `帮助里这些快捷键没有任何用例验证过：${missing.join("、")}`,
    );
    const extra = COVERED.filter((k) => !documented.includes(k));
    assert(extra.length === 0, `用例里有帮助没写的键位：${extra.join("、")}`);
    send(`NOTE: 帮助列表共 ${documented.length} 个键位，全部有用例覆盖`);
  });

  const bad = results.filter((r) => !r.ok);
  if (bad.length > 0) {
    send(
      `FAIL: 快捷键 ${bad.length}/${results.length} 条未通过：\n` +
        bad.map((b) => `  · ${b.name} —— ${b.why}`).join("\n"),
    );
  } else {
    send(`PASS: 快捷键 ${results.length} 条全部通过（真实 GTK/WebKit 合成 KeyboardEvent）`);
  }
}

/**
 * COVERED：本测试逐条发过的键位，必须和「帮助 → 快捷键」里的列表一一对应。
 * 少了 → 那条文案没人验证（可能有假文案）；多了 → 帮助列表漏写。
 */
const COVERED = [
  "Ctrl+S",
  "Ctrl+P",
  "Ctrl+Z",
  "Ctrl+Shift+Z",
  "Ctrl+F",
  "Ctrl+H",
  "Ctrl+Shift+F",
  "Ctrl+/",
  "F8",
  "F9",
  "F11",
  "Ctrl+Shift+L",
  "Ctrl+Shift+B",
    "Ctrl+B",
    "Ctrl+I",
    "Ctrl+U",
    "Alt+Shift+5",
    "Ctrl+1",
    "Ctrl+2",
    "Ctrl+3",
    "Ctrl+4",
    "Ctrl+5",
    "Ctrl+6",
    "Ctrl+0",
    "Ctrl+K",
  "Ctrl+Shift+I",
  "Ctrl+Shift+Q",
  "Ctrl+Shift+]",
  "Ctrl+Shift+[",
  "Alt+↑",
  "Alt+↓",
  "Ctrl+Shift+D",
  "Ctrl+,",
];

run().catch((error) => send(`FAIL: ${error?.message ?? error}\n${error?.stack ?? ""}`));
