/*
 * 卷级 + 纲要 的**真实 GUI**（GTK/WebKit）端到端断言，用内存 fixture，绝不读写真实工作区。
 *
 * 覆盖两段：
 *   Phase A（纯视觉）：文件树卷行（📚 + 「N 章」徽标）、卷排序、纲要（总纲/卷纲/章节纲要）
 *     不出现在文件树里、卷与章之间的左侧细线、卷展开折叠、点章打开；
 *     大纲页：整棵纲要导航树（书 → 卷 → 章，总纲/卷纲染色、章纲缩进），
 *     不内嵌编辑器，点一行到正文区打开。
 *   Phase B（真实流程，api 换成内存实现）：走真实 store.setRoot →
 *     卷注册表侧车（.novel/volumes.json）、章手动顺序侧车（.novel/chapter-order.json）、
 *     总纲自动创建（书/outline/总纲.md）；右键菜单区分「新建书 / 新建文件夹 / 新建卷」
 *     （只有书文件夹提供新建卷）与「新建章节纲要」（只有书里的章才有）；
 *     快速创建 + 行内改名（新建书 / 新建文件夹 / 新建卷，无确认对话框）；卷纲随卷改名；
 *     书改名时 outline/ 整份跟着搬；卷改名为「风起」后仍是卷（注册表路径同步）；
 *     章拖动排序与跨目录拖动；删除卷后注册表清理；大纲树与阅读顺序一致。
 *
 * 注意：章拖动已从 HTML5 拖放换成指针事件自实现，Phase B 里的拖动一律用
 * pointerdown / pointermove / pointerup + 真实坐标（落点走 elementFromPoint 命中行）。
 */
import React from "react";
import { createRoot } from "react-dom/client";
import App from "../src/App";
import { useStore } from "../src/store";
import { api, type FileNode } from "../src/api";
import "../src/styles.css";
import "../src/shell.css";

const send = (text: string) => (window as any).webkit.messageHandlers.result.postMessage(text);
const wait = (ms = 220) => new Promise((resolve) => setTimeout(resolve, ms));
function assert(value: unknown, message: string) {
  if (!value) throw new Error(message);
}
function rows(selector: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(selector)];
}
function rowByText(selector: string, text: string): HTMLElement {
  const hit = rows(selector).find((el) => (el.textContent ?? "").includes(text));
  assert(hit, `找不到「${text}」（${selector}）：${rows(selector).map((e) => e.textContent?.trim()).join(" | ")}`);
  return hit!;
}
function rowByTitle(selector: string, title: string): HTMLElement {
  const hit = rows(selector).find((el) => el.getAttribute("title") === title);
  assert(hit, `找不到 title=${title}（${selector}）：${rows(selector).map((e) => e.getAttribute("title")).join(" | ")}`);
  return hit!;
}

/* ------------------------------------------------------------------ *
 * 内存文件系统 + api 替身（Phase B 用；绝不落盘、绝不联网）
 * ------------------------------------------------------------------ */

const memFiles = new Map<string, string>();
const memDirs = new Set<string>();
const sidecars = new Map<string, string>();

function buildTree(dirs: string[], files: string[]): FileNode[] {
  const map = new Map<string, FileNode>();
  for (const d of dirs) {
    map.set(d, { path: d, name: d.split("/").pop()!, is_dir: true, children: [] });
  }
  for (const f of files) {
    map.set(f, { path: f, name: f.split("/").pop()!, is_dir: false, children: [] });
  }
  const roots: FileNode[] = [];
  for (const key of map.keys()) {
    const at = key.lastIndexOf("/");
    const parent = at < 0 ? "" : key.slice(0, at);
    if (parent && map.has(parent)) map.get(parent)!.children.push(map.get(key)!);
    else roots.push(map.get(key)!);
  }
  return roots;
}

function installApiMocks() {
  const a = api as unknown as Record<string, (...args: any[]) => Promise<any>>;
  a.scan = async () => ({
    root: "/vol-fixture",
    tree: buildTree([...memDirs], [...memFiles.keys()]),
    files: [...memFiles.keys()],
  });
  a.readFile = async (_root: string, path: string) =>
    memFiles.has(path) ? { path, content: memFiles.get(path)! } : null;
  /** 真实 vault 会 create_dir_all(parent)：这里也补中间目录，扫描出的树才连得上 */
  const ensureParents = (path: string) => {
    const parts = path.split("/");
    parts.pop();
    for (let i = 1; i <= parts.length; i++) memDirs.add(parts.slice(0, i).join("/"));
  };
  a.createFile = async (_root: string, path: string, content: string) => {
    if (memFiles.has(path)) throw new Error("文件已存在");
    memFiles.set(path, content);
    ensureParents(path);
  };
  a.createDir = async (_root: string, path: string) => {
    memDirs.add(path);
    ensureParents(path);
  };
  a.writeFile = async (_root: string, path: string, content: string) => {
    memFiles.set(path, content);
  };
  a.deleteEntry = async (_root: string, path: string) => {
    memFiles.delete(path);
    memDirs.delete(path);
    for (const k of [...memFiles.keys()]) if (k.startsWith(path + "/")) memFiles.delete(k);
    for (const d of [...memDirs]) if (d.startsWith(path + "/")) memDirs.delete(d);
  };
  a.renameEntry = async (_root: string, path: string, newPath: string) => {
    if (memFiles.has(path)) {
      const content = memFiles.get(path)!;
      memFiles.delete(path);
      memFiles.set(newPath, content);
      return;
    }
    if (memDirs.has(path)) {
      memDirs.delete(path);
      memDirs.add(newPath);
      for (const k of [...memFiles.keys()]) {
        if (k.startsWith(path + "/")) {
          const content = memFiles.get(k)!;
          memFiles.delete(k);
          memFiles.set(newPath + k.slice(path.length), content);
        }
      }
      for (const d of [...memDirs]) {
        if (d.startsWith(path + "/")) {
          memDirs.delete(d);
          memDirs.add(newPath + d.slice(path.length));
        }
      }
      return;
    }
    throw new Error(`rename: 源不存在 ${path}`);
  };
  a.readSidecar = async (_root: string, _work: string, name: string) => sidecars.get(name) ?? null;
  a.writeSidecar = async (_root: string, _work: string, name: string, data: string) => {
    sidecars.set(name, data);
  };
}

/* ------------------------------------------------------------------ *
 * 真实交互的小工具
 * ------------------------------------------------------------------ */

function openContextMenu(el: HTMLElement) {
  el.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }),
  );
}
function menuLabels(): string[] {
  return rows(".ctx-menu button").map((b) => (b.textContent ?? "").trim());
}
function clickMenu(label: string) {
  const btn = rows(".ctx-menu button").find((b) => (b.textContent ?? "").includes(label));
  assert(btn, `菜单里找不到「${label}」：${menuLabels().join(" | ")}`);
  btn!.click();
}
function closeMenu() {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

/*
 * 章拖动已经换成指针事件自实现：拖动看的是**真实坐标**（落点用 elementFromPoint
 * 命中 .tree-row[title]），所以这里必须传真实坐标，不能只发个无参事件。
 */
/** 拖动区：章名左边那一整块（含最左缩进、抓手、图标）都能起拖 */
function dragZoneOf(row: Element | null): HTMLElement | null {
  return (row?.querySelector(".tree-dragzone") as HTMLElement) ?? null;
}

function firePointer(
  target: EventTarget,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  x: number,
  y: number,
) {
  const init = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: type === "pointerdown" || type === "pointermove" ? 1 : 0,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
  };
  let ev: Event;
  try {
    ev = new PointerEvent(type, init as PointerEventInit);
  } catch {
    // 老 WebKit 没有 PointerEvent 构造器：拿 MouseEvent 顶上，把指针专有字段补出来
    ev = new MouseEvent(type, init as MouseEventInit);
    for (const [k, v] of Object.entries({ pointerId: 1, pointerType: "mouse", isPrimary: true })) {
      Object.defineProperty(ev, k, { value: v, configurable: true });
    }
  }
  target.dispatchEvent(ev);
}

/** 行内的一个真实可命中点（左侧留出缩进，y 取行中心） */
function inRow(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  return { x: r.left + 24, y: r.top + r.height / 2 };
}

/** 落在这行的上半部分（= 插到它前面） */
function aboveRow(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  return { x: r.left + 24, y: r.top + 2 };
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function pressEnter(el: HTMLElement) {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
}

/* ------------------------------------------------------------------ *
 * Phase A fixture（纯视觉，直接写 store）
 * ------------------------------------------------------------------ */

const BOOK = "我的书";
const OUTLINE_DIR = `${BOOK}/outline`;
const V1 = `${BOOK}/第一卷 风起`;
const V2 = `${BOOK}/第二卷 群星`;
const C1 = `${V1}/001-第一章.md`;
const C2 = `${V1}/002-第二章.md`;
const C3 = `${V2}/003-第三章.md`;
// 纲要统一放在 书/outline/ 下：总纲名固定，卷纲默认取卷目录名
const BOOK_OUTLINE = `${OUTLINE_DIR}/总纲.md`;
const V1_OUTLINE = `${OUTLINE_DIR}/第一卷 风起.md`;
const V2_OUTLINE = `${OUTLINE_DIR}/第二卷 群星.md`;

const fileNode = (path: string) => ({ path, name: path.split("/").pop()!, is_dir: false, children: [] as any[] });
const dirNode = (path: string, children: any[]) => ({ path, name: path.split("/").pop()!, is_dir: true, children });

const texts: Record<string, string> = {
  [BOOK_OUTLINE]: "# 我的长篇小说\n\n## 主题\n\n## 人物\n",
  [V1_OUTLINE]: "# 第一卷 风起\n\n本卷讲述启程。\n\n## 本卷目标\n",
  [V2_OUTLINE]: "# 群星\n\n## 本卷目标\n",
  [C1]: "# 第一章 启程\n\n正文一。\n\n## 第一节 出发\n",
  [C2]: "# 第二章 夜宿\n\n正文二。\n\n## 第二节 夜宿\n",
  [C3]: "# 第三章 群星\n\n正文三。\n\n## 群星之始\n",
};

async function run() {
  installApiMocks();

  useStore.setState({
    root: "/vol-fixture",
    files: [BOOK_OUTLINE, V1_OUTLINE, V2_OUTLINE, C1, C2, C3],
    tree: [
      dirNode(BOOK, [
        dirNode(OUTLINE_DIR, [fileNode(BOOK_OUTLINE), fileNode(V1_OUTLINE), fileNode(V2_OUTLINE)]),
        dirNode(V1, [fileNode(C1), fileNode(C2)]),
        dirNode(V2, [fileNode(C3)]),
      ]),
    ],
    expanded: new Set([BOOK, OUTLINE_DIR, V1, V2]),
    chapters: [
      { path: C1, name: "001-第一章.md", title: "第一章 启程", status: "草稿", summary: "", words: 120 },
      { path: C2, name: "002-第二章.md", title: "第二章 夜宿", status: "草稿", summary: "", words: 100 },
      { path: C3, name: "003-第三章.md", title: "第三章 群星", status: "草稿", summary: "", words: 80 },
    ],
    contents: texts,
    openTabs: [C1],
    activePath: C1,
    volumes: [],
    chapterOrder: {},
    sidebarTab: "files",
    sidebarOpen: true,
  });
  createRoot(document.getElementById("root")!).render(<App />);
  await wait();

  /* ================= Phase A：纯视觉 ================= */

  const volumesA = rows(".tree-volume");
  assert(volumesA.length === 2, `应有两个卷行，实际 ${volumesA.length}`);
  assert(volumesA[0].textContent!.includes("第一卷 风起"), "第一卷在前（按卷号排序）");
  assert(volumesA[1].textContent!.includes("第二卷 群星"), "第二卷在后");
  assert(volumesA[0].querySelector(".tree-volume-count")!.textContent === "2 章", "第一卷徽标显示 2 章");
  assert(volumesA[1].querySelector(".tree-volume-count")!.textContent === "1 章", "第二卷徽标显示 1 章");
  assert(volumesA[0].querySelector(".tree-icon")!.textContent === "📚", "卷行用 📚 与普通目录区分");
  assert(volumesA[0].querySelector(".tree-name")!.textContent === "第一卷 风起", "卷行显示目录名");

  // 纲要不在文件树里露面：书/outline/ 整块隐藏，统一由左侧「大纲」页管理
  assert(rows(".tree-outline-file").length === 0, "文件树里不出现纲要文件（📋）");
  assert(
    !rows(".tree-row").some((r) => r.getAttribute("title") === BOOK_OUTLINE),
    "总纲.md 不在文件树里",
  );
  assert(
    !rows(".tree-dir").some((r) => r.getAttribute("title") === OUTLINE_DIR),
    "书/outline/ 文件夹不在文件树里",
  );

  const v1Rows = rows(".tree-file").filter((r) => r.getAttribute("title")?.startsWith(V1 + "/"));
  const chapterNames = v1Rows
    .filter((r) => !r.classList.contains("tree-outline-file"))
    .map((r) => r.querySelector(".tree-name")!.textContent);
  assert(
    chapterNames.join(",") === "001-第一章,002-第二章",
    `没有手动顺序时章的兜底顺序是按文件名，实际：${chapterNames.join(",")}`,
  );

  const rails = rows(".tree-volume-rail");
  assert(rails.length === 2, `每个展开的卷各有一条细线，实际 ${rails.length}`);
  const rail = rails[0];
  assert(getComputedStyle(rail).pointerEvents === "none", "细线不能拦截点击（pointer-events:none）");
  const firstChapterIcon = v1Rows[1].querySelector(".tree-icon") as HTMLElement;
  assert(firstChapterIcon, "第一卷下应有章行");
  assert(
    rail.getBoundingClientRect().left < firstChapterIcon.getBoundingClientRect().left,
    "细线必须在章行的左侧（章缩进在细线内侧）",
  );
  assert(rail.getBoundingClientRect().height > 0, "细线要有可见高度");

  volumesA[0].click();
  await wait(80);
  assert(rows(".tree-volume-rail").length === 1, "折叠第一卷后应只剩第二卷的细线");
  assert(
    rows(".tree-file").filter((r) => r.getAttribute("title")?.startsWith(V1 + "/")).length === 0,
    "折叠后卷内的章不显示",
  );
  rowByText(".tree-volume", "第一卷 风起").click();
  await wait(80);
  assert(rows(".tree-volume-rail").length === 2, "再点一次恢复展开");

  rowByText(".tree-file", "002-第二章").click();
  await wait();
  assert(useStore.getState().activePath === C2, "点文件树里的章应打开它");
  send("SHOT: volume-files");
  await wait(80);

  rowByText(".sidebar-tab", "大纲").click();
  await wait();
  // 大纲页 = 整个工作区的纲要导航树（书 → 卷 → 章），只负责「找」，编辑在正文区
  const outlinePanel = document.querySelector(".outline-panel") as HTMLElement;
  assert(outlinePanel, "大纲页应有 .outline-panel");
  assert(
    !outlinePanel.querySelector(".cm-content"),
    "大纲页不再内嵌编辑器（内容一律在正文区编辑）",
  );
  const outlineRows = rows(".outline-list .outline-item");
  const kinds = outlineRows.map((r) => [...r.classList].find((c) => c.startsWith("kind-")));
  const names = outlineRows.map((r) => r.querySelector(".outline-item-name")!.textContent);
  assert(outlineRows.length === 6, `书 + 2 卷纲 + 3 章节纲要 = 6 行，实际 ${outlineRows.length}`);
  assert(
    kinds.join(",") === "kind-book,kind-volume,kind-chapter,kind-chapter,kind-volume,kind-chapter",
    `排列为 书(总纲) → 第一卷卷纲 → 第一卷第1、2章 → 第二卷卷纲 → 第3章，实际：${kinds.join(",")}`,
  );
  assert(
    names.join(",") === "我的书,第一卷 风起,第一章 启程,第二章 夜宿,第二卷 群星,第三章 群星",
    `树的顺序与文件树一一对应，实际：${names.join(",")}`,
  );
  assert(
    outlineRows[0].querySelector(".outline-item-tag")!.textContent === "总纲",
    "书行就是这本书的总纲，排在每本书最上面",
  );
  assert(
    rows(".outline-item.kind-chapter").every((r) => r.classList.contains("missing")),
    "还没建过的章节纲要显示成虚线「＋」占位行",
  );

  // 颜色区分：书(总纲) / 卷纲 / 章节纲要三档互不相同，且前两者有底色强调
  const styleOf = (sel: string) => getComputedStyle(document.querySelector(sel) as HTMLElement);
  const bookStyle = styleOf(".outline-item.kind-book");
  const volStyle = styleOf(".outline-item.kind-volume");
  const chapStyle = styleOf(".outline-item.kind-chapter");
  assert(
    bookStyle.color !== chapStyle.color &&
      volStyle.color !== chapStyle.color &&
      bookStyle.color !== volStyle.color,
    `总纲/卷纲/章节纲要三种颜色要区分开：${bookStyle.color} / ${volStyle.color} / ${chapStyle.color}`,
  );
  assert(
    bookStyle.backgroundColor !== "rgba(0, 0, 0, 0)" && volStyle.backgroundColor !== "rgba(0, 0, 0, 0)",
    "总纲与卷纲都有底色强调",
  );
  const nameLeft = (sel: string) =>
    (document.querySelector(sel)!.querySelector(".outline-item-name") as HTMLElement).getBoundingClientRect()
      .left;
  assert(
    nameLeft(".outline-item.kind-chapter") > nameLeft(".outline-item.kind-volume"),
    "章节纲要缩进在卷纲内侧（层级靠缩进表示）",
  );

  // 点书行 → 在正文区打开这本书的总纲（和章节一样是个标签页）
  outlineRows[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await wait(400);
  assert(
    useStore.getState().activePath === BOOK_OUTLINE,
    `点总纲应把它在正文区打开，实际 activePath=${useStore.getState().activePath}`,
  );
  assert(useStore.getState().openTabs.includes(BOOK_OUTLINE), "总纲进了正文区的标签页");
  const mainCm = document.querySelector(".cm-content") as HTMLElement | null;
  assert(mainCm, "正文区应是可编辑的文档编辑器");
  assert(
    (mainCm!.textContent ?? "").includes("我的长篇小说"),
    `正文区显示 总纲.md 的内容，实际：${(mainCm!.textContent ?? "").slice(0, 60)}`,
  );
  send("SHOT: volume-outline");
  await wait(80);

  /* ================= Phase B：真实流程 ================= */

  // 回到文件页，清空内存 FS，放一本「书」：一个卷 + 两章，故意不放 总纲.md
  rowByText(".sidebar-tab", "文件").click();
  await wait(80);

  memFiles.clear();
  memDirs.clear();
  sidecars.clear();
  memDirs.add("书");
  memDirs.add("书/第一卷 风起");
  memFiles.set("书/第一卷 风起/001-第一章.md", "# 第一章 启程\n\n正文。\n");
  memFiles.set("书/第一卷 风起/002-第二章.md", "# 第二章 夜宿\n\n正文。\n");
  // 预置手动顺序：002 在 001 之前（与「按数字排序」相反，用来证明顺序来自侧车）
  sidecars.set("chapter-order", JSON.stringify({ "书/第一卷 风起": ["002-第二章.md", "001-第一章.md"] }));

  const ok = await useStore.getState().setRoot("/vol-fixture");
  assert(ok, "setRoot 成功");
  await wait(400);

  // 4. 总纲自动创建：落在 书/outline/ 下
  assert(memFiles.has("书/outline/总纲.md"), "出现章节 + 缺总纲 → 自动创建 书/outline/总纲.md");
  assert(
    memFiles.get("书/outline/总纲.md") === "# 书\n\n",
    `总纲内容只有 # 书名，实际：${JSON.stringify(memFiles.get("书/outline/总纲.md"))}`,
  );
  assert(useStore.getState().files.includes("书/outline/总纲.md"), "总纲进入 files");
  assert(
    !rows(".tree-dir").some((r) => r.getAttribute("title") === "书/outline"),
    "自动创建的总纲也不在文件树里露面（书/outline/ 整块隐藏）",
  );

  // setRoot 只默认展开第一层，先展开卷目录才能看到卷内的章
  rowByText(".tree-volume", "第一卷 风起").click();
  await wait(150);

  // 5. 章手动顺序：chapters 与文件树都按侧车顺序（002 在前）
  assert(
    useStore.getState().chapters.map((c) => c.path).join(",") ===
      "书/第一卷 风起/002-第二章.md,书/第一卷 风起/001-第一章.md",
    `chapters 必须按手动顺序，实际：${useStore.getState().chapters.map((c) => c.name).join(",")}`,
  );
  const treeChapters = rows(".tree-file")
    .filter((r) => r.getAttribute("title")?.startsWith("书/第一卷 风起/") && !r.classList.contains("tree-outline-file"))
    .map((r) => r.querySelector(".tree-name")!.textContent);
  assert(
    treeChapters.join(",") === "002-第二章,001-第一章",
    `文件树章顺序 = 手动顺序，实际：${treeChapters.join(",")}`,
  );

  // 1. 右键菜单：书文件夹同时有「新建文件夹」和「新建卷」
  openContextMenu(rowByText(".tree-dir", "书"));
  await wait(140);
  let labels = menuLabels();
  assert(labels.includes("新建文件夹"), `书文件夹右键应有「新建文件夹」：${labels.join(" | ")}`);
  assert(labels.includes("新建卷"), `书文件夹右键应有「新建卷」：${labels.join(" | ")}`);
  closeMenu();
  await wait(80);

  // 1. 右键菜单：空白处（工作区根）提供 新建书 / 新建文件夹，不提供 新建卷（卷只能挂在书下）
  openContextMenu(document.querySelector(".tree-blank") as HTMLElement);
  await wait(140);
  labels = menuLabels();
  assert(labels.includes("新建文件夹"), `空白处右键应有「新建文件夹」：${labels.join(" | ")}`);
  assert(labels.includes("新建书"), `空白处右键应有「新建书」：${labels.join(" | ")}`);
  assert(!labels.includes("新建卷"), `空白处右键不应有「新建卷」：${labels.join(" | ")}`);
  closeMenu();
  await wait(80);

  // 1. 右键菜单：卷目录不提供「新建卷」，但可新建文件夹/文件/添加章节
  openContextMenu(rowByTitle(".tree-volume", "书/第一卷 风起"));
  await wait(140);
  labels = menuLabels();
  assert(!labels.includes("新建卷"), `卷目录不能提供「新建卷」：${labels.join(" | ")}`);
  for (const l of ["新建文件夹", "新建文件", "添加章节"]) {
    assert(labels.some((x) => x.includes(l)), `卷目录右键应仍有「${l}」：${labels.join(" | ")}`);
  }
  closeMenu();
  await wait(80);

  // 1. 右键菜单：章文件上是原有项 + 「新建章节纲要」，没有「新建卷」
  openContextMenu(rowByText(".tree-file", "001-第一章"));
  await wait(140);
  labels = menuLabels();
  for (const l of ["打开文件", "重命名", "添加章节", "新建文件", "新建章节纲要", "删除"]) {
    assert(labels.some((x) => x.includes(l)), `章文件右键应有「${l}」：${labels.join(" | ")}`);
  }
  assert(!labels.includes("新建卷"), `章文件右键没有「新建卷」：${labels.join(" | ")}`);
  closeMenu();
  await wait(80);

  // 2. 快速创建文件夹：立即建目录 + 行内改名，不弹确认框
  openContextMenu(rowByText(".tree-dir", "书"));
  await wait(140);
  clickMenu("新建文件夹");
  await wait(400);
  assert(memDirs.has("书/Untitled"), "新建文件夹立即创建了 Untitled 目录");
  assert(!document.querySelector('[role="dialog"]'), "快速创建不弹确认对话框");
  let renameInput = document.querySelector(".tree-rename") as HTMLInputElement | null;
  assert(renameInput && renameInput.value === "Untitled", `新建文件夹后立刻进入行内改名，实际 value=${renameInput?.value}`);
  setInputValue(renameInput!, "草稿");
  await wait(30);
  pressEnter(renameInput!);
  await wait(400);
  assert(memDirs.has("书/草稿") && !memDirs.has("书/Untitled"), "行内改名把 Untitled 改成 草稿");

  // 2+3. 新建卷：建「新建卷」目录 + 登记注册表 + 立刻行内改名
  openContextMenu(rowByText(".tree-dir", "书"));
  await wait(140);
  clickMenu("新建卷");
  await wait(400);
  assert(memDirs.has("书/新建卷"), "「新建卷」目录已创建");
  assert(
    (JSON.parse(sidecars.get("volumes") ?? "{}").volumes ?? []).includes("书/新建卷"),
    `卷已登记进 volumes.json：${sidecars.get("volumes")}`,
  );
  assert(
    memFiles.has("书/outline/新建卷.md"),
    `新建卷同时建卷纲（默认名=卷目录名）：${[...memFiles.keys()].join(" | ")}`,
  );
  renameInput = document.querySelector(".tree-rename") as HTMLInputElement | null;
  assert(renameInput && renameInput.value === "新建卷", `新建卷后立刻进入行内改名，实际 value=${renameInput?.value}`);
  // 正在行内改名的卷行里名字在输入框里，所以从输入框往上找卷行
  const newVolRow = renameInput!.closest(".tree-volume") as HTMLElement | null;
  assert(newVolRow, "「新建卷」的行是卷行（.tree-volume）");
  assert(newVolRow!.querySelector(".tree-icon")!.textContent === "📚", "「新建卷」立即显示 📚（不靠目录名）");

  // 3. 卷改名为「风起」后仍是卷（注册表路径同步）
  setInputValue(renameInput!, "风起");
  await wait(30);
  pressEnter(renameInput!);
  await wait(500);
  assert(memDirs.has("书/风起") && !memDirs.has("书/新建卷"), "卷已改名为 风起");
  assert(
    memFiles.has("书/outline/风起.md") && !memFiles.has("书/outline/新建卷.md"),
    `卷改名后卷纲跟着改名：${[...memFiles.keys()].join(" | ")}`,
  );
  const volsAfter = useStore.getState().volumes;
  assert(
    volsAfter.includes("书/风起") && !volsAfter.includes("书/新建卷"),
    `注册表路径同步为 书/风起，实际：${JSON.stringify(volsAfter)}`,
  );
  assert(
    (JSON.parse(sidecars.get("volumes") ?? "{}").volumes ?? []).includes("书/风起"),
    "volumes.json 里的路径也同步了",
  );
  assert(rowByTitle(".tree-volume", "书/风起"), "改名成「风起」后依然是卷行（📚）");

  // 5. 同目录拖动排序：把 001 拖到 002 之前 → 顺序 001,002 并持久化
  const src1 = rowByText(".tree-file", "001-第一章");
  const tgt2 = rowByText(".tree-file", "002-第二章");
  const from1 = inRow(src1);
  const dropBefore2 = aboveRow(tgt2);
  const outsideTree = (document.querySelector(".pane-main") as HTMLElement) ?? document.body;
  const activeBeforeFirstDrag = useStore.getState().activePath;

  // 章行本身是默认箭头；只有图标左边的小把手是「抓取」光标（拖动时全窗换成 grabbing）
  assert(
    getComputedStyle(src1).cursor === "default",
    `章行本身应是默认箭头，实际 ${getComputedStyle(src1).cursor}`,
  );
  const zone1 = dragZoneOf(src1)!;
  assert(
    getComputedStyle(zone1).cursor === "grabbing",
    `左侧拖动区应是 grabbing（菱形），实际 ${getComputedStyle(zone1).cursor}`,
  );
  const rowRect1 = src1.getBoundingClientRect();
  const zoneRect1 = zone1.getBoundingClientRect();
  assert(
    Math.abs(zoneRect1.left - rowRect1.left) <= 1.5 && zoneRect1.height >= rowRect1.height - 6,
    `拖动区要覆盖最左侧（行 left=${rowRect1.left}，区 left=${zoneRect1.left}）`,
  );

  firePointer(dragZoneOf(src1)!, "pointerdown", from1.x, from1.y);
  await wait(40);
  // 阈值内的小抖动不算拖动：松手就是一次普通点击，不该改顺序
  firePointer(window, "pointermove", from1.x + 2, from1.y + 2);
  await wait(40);
  assert(!document.body.classList.contains("is-dragging-file"), "位移没超过 6px 阈值时不进入拖动");
  assert(!document.querySelector(".tree-row.dragging"), "没过阈值时章行没有 .dragging 反馈");

  // 越过阈值 → 进入拖动（真实坐标：落点由 elementFromPoint 命中 002 那一行）
  firePointer(window, "pointermove", dropBefore2.x, dropBefore2.y);
  await wait(80);
  assert(document.querySelector(".tree-row.dragging"), "拖动中的章行有 .dragging 反馈");
  assert(
    document.body.classList.contains("is-dragging-file"),
    "拖动期间 body 带 is-dragging-file 类（整窗「抓取」光标皮肤靠它）",
  );
  assert(document.body.style.userSelect === "none", "拖动期间禁止选中文本（userSelect=none）");
  // 光标皮肤：整窗（含树外的编辑区）都必须是 grabbing —— 这是换成指针事件的全部理由
  assert(
    getComputedStyle(src1).cursor === "grabbing",
    `拖动期间章行光标应是 grabbing，实际 ${getComputedStyle(src1).cursor}`,
  );
  assert(
    getComputedStyle(outsideTree).cursor === "grabbing",
    `拖动期间树外（编辑区）光标也应是 grabbing，实际 ${getComputedStyle(outsideTree).cursor}`,
  );
  assert(
    rows(".tree-drop-before").some((r) => r.getAttribute("title") === "书/第一卷 风起/002-第二章.md"),
    "光标在 002 上半部分 → 插入线画在 002 之上（tree-drop-before）",
  );
  assert(rows(".tree-drop-before, .tree-drop-after").length >= 1, "章与章之间有插入线反馈（tree-drop-before/after）");

  firePointer(window, "pointerup", dropBefore2.x, dropBefore2.y);
  // 真实 WebKit 在指针松手后还会补一次 click（穿透）：必须被 suppressClick 吞掉，
  // 否则拖完就会顺手打开文件。合成事件不会派生 click，所以这里手动补一发。
  rowByText(".tree-file", "001-第一章").click();
  await wait(200);
  assert(
    useStore.getState().activePath === activeBeforeFirstDrag,
    `拖动结束后补发的那一下 click 被吞掉（activePath 仍为 ${activeBeforeFirstDrag}）`,
  );
  await wait(400);
  assert(!document.body.classList.contains("is-dragging-file"), "松手后 body 的拖动类必须清掉（光标回原样）");
  assert(document.body.style.userSelect !== "none", "松手后恢复文本选中");
  assert(!document.querySelector(".tree-row.dragging"), "松手后没有 .dragging 行");
  const draggedRow = rowByText(".tree-file", "001-第一章");
  const cursorAfter = getComputedStyle(draggedRow).cursor;
  assert(cursorAfter === "default", `松手后章行回到默认箭头，实际 ${cursorAfter}`);
  const zoneAfter = getComputedStyle(dragZoneOf(draggedRow)!).cursor;
  assert(zoneAfter === "grabbing", `松手后左侧拖动区仍是抓取光标，实际 ${zoneAfter}`);
  const orderAfterDrag = useStore.getState().chapterOrder["书/第一卷 风起"];
  assert(
    (orderAfterDrag ?? []).join(",") === "001-第一章.md,002-第二章.md",
    `同目录拖动后顺序持久化：${JSON.stringify(orderAfterDrag)}`,
  );
  assert(
    JSON.parse(sidecars.get("chapter-order") ?? "{}")["书/第一卷 风起"].join(",") ===
      "001-第一章.md,002-第二章.md",
    "chapter-order.json 也写入了新顺序",
  );
  assert(
    rows(".tree-file")
      .filter((r) => r.getAttribute("title")?.startsWith("书/第一卷 风起/") && !r.classList.contains("tree-outline-file"))
      .map((r) => r.querySelector(".tree-name")!.textContent)
      .join(",") === "001-第一章,002-第二章",
    "拖动后文件树顺序立即更新",
  );

  // 5. 单击仍然照常打开文件：没过阈值的一次按下+松手不能被当成拖动吞掉。
  //    （合成事件不会派生 click，所以这里手动补一发 click；上一次拖动留下的
  //    抑制窗口是 400ms，先等过去，才能验证「非拖动松手不设抑制」。）
  const clickTarget = rowByText(".tree-file", "002-第二章");
  const clickPoint = inRow(clickTarget);
  firePointer(dragZoneOf(clickTarget)!, "pointerdown", clickPoint.x, clickPoint.y);
  await wait(30);
  firePointer(window, "pointerup", clickPoint.x, clickPoint.y);
  await wait(150);
  clickTarget.click();
  await wait(300);
  assert(
    useStore.getState().activePath === "书/第一卷 风起/002-第二章.md",
    "没越过阈值的按下+松手不吞点击：onClick 照常 openFile",
  );
  assert(useStore.getState().chapterOrder["书/第一卷 风起"].join(",") === "001-第一章.md,002-第二章.md", "单击不改顺序");

  // 5. 跨目录拖动：把 001 拖进「风起」卷 → 移动文件 + 两侧顺序更新
  const srcMove = rowByText(".tree-file", "001-第一章");
  const volFeng = rowByTitle(".tree-volume", "书/风起");
  const fromMove = inRow(srcMove);
  const ontoVol = inRow(volFeng);
  const activeBeforeMove = useStore.getState().activePath;
  firePointer(dragZoneOf(srcMove)!, "pointerdown", fromMove.x, fromMove.y);
  await wait(40);
  firePointer(window, "pointermove", ontoVol.x, ontoVol.y);
  await wait(80);
  assert(document.querySelector(".tree-drop-into"), "拖入目录时目录高亮（tree-drop-into）");
  assert(
    rows(".tree-drop-into").some((r) => r.getAttribute("title") === "书/风起"),
    "高亮的是光标下的「风起」卷行",
  );
  firePointer(window, "pointerup", ontoVol.x, ontoVol.y);
  await wait(500);
  assert(
    memFiles.has("书/风起/001-第一章.md") && !memFiles.has("书/第一卷 风起/001-第一章.md"),
    "章文件已移动到 风起 卷目录",
  );
  const coFinal = useStore.getState().chapterOrder;
  assert(
    !(coFinal["书/第一卷 风起"] ?? []).includes("001-第一章.md"),
    `源目录顺序移除 001：${JSON.stringify(coFinal)}`,
  );
  assert((coFinal["书/风起"] ?? []).includes("001-第一章.md"), `目标目录顺序加入 001：${JSON.stringify(coFinal)}`);
  assert(
    useStore.getState().activePath === activeBeforeMove,
    `拖动本身不触发 openFile（activePath 仍为 ${activeBeforeMove}）`,
  );

  // 5. 大纲树与手动顺序一致（卷识别靠注册表；章顺序靠手动顺序）
  rowByText(".sidebar-tab", "大纲").click();
  await wait(400);
  const phaseBPanel = document.querySelector(".outline-panel") as HTMLElement;
  assert(phaseBPanel, "Phase B 大纲页应有 .outline-panel");
  const phaseBNames = rows(".outline-item").map(
    (r) => r.querySelector(".outline-item-name")!.textContent,
  );
  assert(
    rows(".outline-item").every(
      (r) => r.getAttribute("title")?.startsWith("书/outline/") || r.classList.contains("missing"),
    ),
    `大纲树里的纲要都应落在 书/outline/ 下：${rows(".outline-item")
      .map((r) => r.getAttribute("title"))
      .join(" | ")}`,
  );
  assert(
    phaseBNames.includes("书") && phaseBNames.includes("第一卷 风起") && phaseBNames.includes("风起"),
    `书与两个卷都在树里（卷识别靠注册表），实际：${phaseBNames.join(",")}`,
  );
  // 章序 = 手动顺序：002 排在 001 前面
  assert(
    phaseBNames.indexOf("002-第二章") < phaseBNames.indexOf("001-第一章"),
    `章行按手动顺序排列（002 在 001 前），实际：${phaseBNames.join(",")}`,
  );
  assert(
    useStore.getState().chapters.map((c) => c.path).join(",") ===
      "书/第一卷 风起/002-第二章.md,书/风起/001-第一章.md",
    `chapters（EPUB/大纲共用的阅读顺序）与手动顺序一致，实际：${useStore.getState().chapters.map((c) => c.path).join(",")}`,
  );
  send("SHOT: volume-manual-order");
  await wait(100);

  // 3. 删除卷：注册表与章顺序一起清理
  rowByText(".sidebar-tab", "文件").click();
  await wait(150);
  openContextMenu(rowByTitle(".tree-volume", "书/风起"));
  await wait(140);
  clickMenu("删除文件夹");
  await wait(200);
  const modal = document.querySelector(".modal") as HTMLElement | null;
  assert(modal, "删除文件夹会弹确认框");
  const delBtn = [...modal!.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("删除"));
  assert(delBtn, "确认框里有删除按钮");
  (delBtn as HTMLButtonElement).click();
  await wait(500);
  assert(!memDirs.has("书/风起"), "卷目录已删除");
  assert(
    !useStore.getState().volumes.includes("书/风起"),
    `删除后注册表移除该卷：${JSON.stringify(useStore.getState().volumes)}`,
  );
  assert(
    !(useStore.getState().chapterOrder["书/风起"] ?? []).length,
    `删除后该目录的章顺序也清理：${JSON.stringify(useStore.getState().chapterOrder)}`,
  );
  assert(
    !rows(".tree-volume").some((r) => r.getAttribute("title") === "书/风起"),
    "文件树里不再有「风起」卷",
  );

  // 5. 拖到树内空白 = 回工作区根目录（坐标命中 .tree-blank，不是任何一行）
  const toRoot = rowByText(".tree-file", "002-第二章");
  const from002 = inRow(toRoot);
  const blank = document.querySelector(".tree-blank") as HTMLElement;
  const blankRect = blank.getBoundingClientRect();
  const onBlank = { x: blankRect.left + 24, y: blankRect.top + 10 };
  assert(blankRect.height > 10, "底部应有一块可命中的空白区（tree-blank）");
  firePointer(dragZoneOf(toRoot)!, "pointerdown", from002.x, from002.y);
  await wait(40);
  firePointer(window, "pointermove", onBlank.x, onBlank.y);
  await wait(80);
  assert(
    blank.classList.contains("tree-drop-into"),
    "拖到空白区时空白区高亮（tree-drop-into），表示会落到工作区根",
  );
  firePointer(window, "pointerup", onBlank.x, onBlank.y);
  await wait(500);
  assert(
    memFiles.has("002-第二章.md") && !memFiles.has("书/第一卷 风起/002-第二章.md"),
    `拖到空白 → 章回到工作区根目录：${[...memFiles.keys()].join(" | ")}`,
  );
  assert(
    (useStore.getState().chapterOrder[""] ?? []).includes("002-第二章.md"),
    `根目录的顺序表收下这一章：${JSON.stringify(useStore.getState().chapterOrder)}`,
  );
  assert(
    !(useStore.getState().chapterOrder["书/第一卷 风起"] ?? []).includes("002-第二章.md"),
    "源目录顺序表移除这一章",
  );

  // 6. 先放进书里，再拖到顶部投放带 → 必须能回到工作区根（用户报的那个 bug）
  const back = rowByText(".tree-file", "002-第二章");
  const bookDirRow = rowByText(".tree-dir", "书");
  const fromBack = inRow(back);
  const ontoBook = inRow(bookDirRow);
  firePointer(dragZoneOf(back)!, "pointerdown", fromBack.x, fromBack.y);
  await wait(40);
  firePointer(window, "pointermove", ontoBook.x, ontoBook.y);
  await wait(60);
  assert(
    bookDirRow.classList.contains("tree-drop-into"),
    "拖到书文件夹上时该书高亮（会落进这本书）",
  );
  firePointer(window, "pointerup", ontoBook.x, ontoBook.y);
  await wait(500);
  assert(
    memFiles.has("书/002-第二章.md") && !memFiles.has("002-第二章.md"),
    `章先被移进书里：${[...memFiles.keys()].join(" | ")}`,
  );

  const again = rowByText(".tree-file", "002-第二章");
  const strip = document.querySelector(".tree-root-drop") as HTMLElement;
  assert(strip, "树顶有「移回工作区根」投放带");
  const stripRect = strip.getBoundingClientRect();
  const onStrip = { x: stripRect.left + 40, y: stripRect.top + stripRect.height / 2 };
  firePointer(dragZoneOf(again)!, "pointerdown", inRow(again).x, inRow(again).y);
  await wait(40);
  firePointer(window, "pointermove", onStrip.x, onStrip.y);
  await wait(80);
  assert(
    strip.classList.contains("tree-drop-into"),
    "拖到顶部投放带时它高亮（表示会回到工作区根）",
  );
  firePointer(window, "pointerup", onStrip.x, onStrip.y);
  await wait(500);
  assert(
    memFiles.has("002-第二章.md") && !memFiles.has("书/002-第二章.md"),
    `从书里拖回最外层（工作区根）成功：${[...memFiles.keys()].join(" | ")}`,
  );

  // 7. 纲要跟着书文件夹走：散在工作区根下的章不属于任何一本书 → 没有「新建章节纲要」
  openContextMenu(rowByText(".tree-file", "002-第二章"));
  await wait(140);
  labels = menuLabels();
  assert(
    !labels.includes("新建章节纲要"),
    `根下的章不该有「新建章节纲要」：${labels.join(" | ")}`,
  );
  assert(!memFiles.has("outline/002-第二章.md"), "点不到就不会凭空生成根级 outline/");
  closeMenu();
  await wait(80);

  // 8. 新建书：书文件夹 + 立刻有 outline/总纲.md；书改名时整份 outline/ 跟着搬
  openContextMenu(document.querySelector(".tree-blank") as HTMLElement);
  await wait(140);
  clickMenu("新建书");
  await wait(400);
  assert(
    memDirs.has("新书") && memFiles.has("新书/outline/总纲.md"),
    `新建书即建总纲：${[...memFiles.keys()].join(" | ")}`,
  );
  let bookRename = document.querySelector(".tree-rename") as HTMLInputElement | null;
  assert(
    bookRename && bookRename.value === "新书",
    `新建书后立刻进入行内改名，实际 value=${bookRename?.value}`,
  );
  setInputValue(bookRename!, "第二本");
  await wait(30);
  pressEnter(bookRename!);
  await wait(500);
  assert(
    memFiles.has("第二本/outline/总纲.md") && !memFiles.has("新书/outline/总纲.md"),
    `书改名时 outline/ 整份跟着搬：${[...memFiles.keys()].join(" | ")}`,
  );

  // 8. 这本书里的章：右键有「新建章节纲要」，落在 第二本/outline/ 下
  openContextMenu(rowByText(".tree-dir", "第二本"));
  await wait(140);
  clickMenu("新建文件");
  await wait(400);
  const fileRename = document.querySelector(".tree-rename") as HTMLInputElement | null;
  assert(fileRename, "新建文件后进入行内改名");
  setInputValue(fileRename!, "第一章");
  await wait(30);
  pressEnter(fileRename!);
  await wait(400);
  assert(memFiles.has("第二本/第一章.md"), `书里建了一章：${[...memFiles.keys()].join(" | ")}`);
  openContextMenu(rowByText(".tree-file", "第一章"));
  await wait(140);
  labels = menuLabels();
  assert(labels.includes("新建章节纲要"), `书里的章右键有「新建章节纲要」：${labels.join(" | ")}`);
  clickMenu("新建章节纲要");
  await wait(400);
  assert(
    memFiles.has("第二本/outline/第一章.md"),
    `章节纲要落在 第二本/outline/ 下、默认名取章名：${[...memFiles.keys()].join(" | ")}`,
  );
  assert(!memFiles.has("第二本/outline/002-第二章.md"), "没有右键的章不会凭空生成章节纲要");

  // 9. 大纲页 = 全工作区的纲要导航树（列出所有书；点行在正文区打开；双击改名）
  rowByText(".sidebar-tab", "大纲").click();
  await wait(400);
  const bookNames = rows(".outline-item.kind-book").map(
    (r) => r.querySelector(".outline-item-name")!.textContent,
  );
  assert(
    bookNames.includes("书") && bookNames.includes("第二本"),
    `大纲页列出所有书（不只当前打开的那本），实际：${bookNames.join(",")}`,
  );
  const pickRow = (path: string) =>
    rows(".outline-item").find((r) => (r.getAttribute("title") ?? "").startsWith(path));
  const chOutline = pickRow("第二本/outline/第一章.md");
  assert(
    chOutline,
    `章节纲要在树里：${rows(".outline-item")
      .map((r) => r.getAttribute("title"))
      .join(" | ")}`,
  );
  chOutline!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await wait(400);
  assert(
    useStore.getState().activePath === "第二本/outline/第一章.md",
    `点纲要就在正文区打开（不再内嵌编辑器），实际 activePath=${useStore.getState().activePath}`,
  );
  assert(useStore.getState().openTabs.includes("第二本/outline/第一章.md"), "纲要进了正文区的标签页");
  assert(document.querySelector(".cm-content"), "正文区里就是同一台编辑器");

  // 9. 双击改名：纲要就是普通文件，名字随便改
  pickRow("第二本/outline/第一章.md")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  await wait(150);
  const renameBox = document.querySelector(".outline-rename") as HTMLInputElement | null;
  assert(
    renameBox && renameBox.value === "第一章",
    `双击纲要进入行内改名，实际 value=${renameBox?.value}`,
  );
  setInputValue(renameBox!, "第一章纲要");
  await wait(30);
  pressEnter(renameBox!);
  await wait(400);
  assert(
    memFiles.has("第二本/outline/第一章纲要.md") && !memFiles.has("第二本/outline/第一章.md"),
    `纲要改名仍留在本书的 outline/ 下：${[...memFiles.keys()].join(" | ")}`,
  );

  // 10. 添加章节的默认名：目录里最后一章叫「第一章」，新章就默认叫「第二章」
  rowByText(".sidebar-tab", "文件").click();
  await wait(300);
  openContextMenu(rowByText(".tree-dir", "第二本"));
  await wait(140);
  clickMenu("添加章节");
  await wait(400);
  assert(
    memFiles.has("第二本/第二章.md"),
    `上一章是「第一章」时新章默认叫「第二章」：${[...memFiles.keys()].join(" | ")}`,
  );
  const chapterRename = document.querySelector(".tree-rename") as HTMLInputElement | null;
  assert(
    chapterRename && chapterRename.value === "第二章",
    `行内改名的初值就是「第二章」，实际 value=${chapterRename?.value}`,
  );
  // 关掉改名框（文件已经在磁盘上，Escape 只是退出编辑态），后面几步才好在树上点右键
  chapterRename!.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
  await wait(150);

  /* ================= Phase C：反转显示 + 删章连带删纲要 ================= */

  /** 文件树里某本书下的章行名字（按显示顺序；纲要行不在树里，天然滤掉） */
  const treeChapterNames = (book: string) =>
    rows(".tree-file")
      .filter((r) => (r.getAttribute("title") ?? "").startsWith(book + "/"))
      .map((r) => r.querySelector(".tree-name")!.textContent);

  /** 大纲页里某本书那一段的行名（从书行往后，到下一本书为止） */
  const outlineBlockOf = (book: string): string[] => {
    const all = rows(".outline-item");
    const start = all.findIndex(
      (r) =>
        r.classList.contains("kind-book") &&
        r.querySelector(".outline-item-name")!.textContent === book,
    );
    assert(start >= 0, `大纲页里应有书「${book}」`);
    const rest = all.slice(start + 1);
    const end = rest.findIndex((r) => r.classList.contains("kind-book"));
    return (end < 0 ? rest : rest.slice(0, end)).map(
      (r) => r.querySelector(".outline-item-name")!.textContent!,
    );
  };

  // 11. 反转卷与章的顺序：只是把左侧倒过来看，顺序侧车与阅读顺序都不许动
  assert(
    treeChapterNames("第二本").join(",") === "第一章,第二章",
    `反转前书里的章按章号排，实际：${treeChapterNames("第二本").join(",")}`,
  );
  const chaptersBeforeFlip = useStore.getState().chapters.map((c) => c.path).join(",");
  const orderSidecarBeforeFlip = sidecars.get("chapter-order") ?? "";

  openContextMenu(rowByText(".tree-dir", "第二本"));
  await wait(140);
  labels = menuLabels();
  assert(
    labels.includes("反转卷与章的顺序"),
    `书右键应有「反转卷与章的顺序」：${labels.join(" | ")}`,
  );
  clickMenu("反转卷与章的顺序");
  await wait(400);

  assert(
    treeChapterNames("第二本").join(",") === "第二章,第一章",
    `反转后文件树里这本书的兄弟倒过来，实际：${treeChapterNames("第二本").join(",")}`,
  );
  assert(
    useStore.getState().chapters.map((c) => c.path).join(",") === chaptersBeforeFlip,
    "反转是纯显示的：chapters 的阅读顺序（也是 EPUB 的顺序）不能跟着变",
  );
  assert(
    (sidecars.get("chapter-order") ?? "") === orderSidecarBeforeFlip,
    "反转不写 chapter-order.json",
  );
  assert(
    (sidecars.get("order-flip") ?? "").includes("第二本"),
    `反转的书写进 .novel/order-flip.json，实际：${sidecars.get("order-flip")}`,
  );

  // 大纲页和文件树共用同一个显示顺序，所以也要跟着倒
  rowByText(".sidebar-tab", "大纲").click();
  await wait(400);
  assert(
    outlineBlockOf("第二本").slice(0, 2).join(",") === "第二章,第一章",
    `大纲页里同一本书的章也跟着倒，实际：${outlineBlockOf("第二本").join(",")}`,
  );

  // 再按一下还原（这时菜单项叫「还原卷与章的顺序」）
  rowByText(".sidebar-tab", "文件").click();
  await wait(300);
  openContextMenu(rowByText(".tree-dir", "第二本"));
  await wait(140);
  labels = menuLabels();
  assert(
    labels.includes("还原卷与章的顺序") && !labels.includes("反转卷与章的顺序"),
    `已经反转过的书，菜单里只剩「还原」：${labels.join(" | ")}`,
  );
  clickMenu("还原卷与章的顺序");
  await wait(400);
  assert(
    treeChapterNames("第二本").join(",") === "第一章,第二章",
    `还原后恢复原来的顺序，实际：${treeChapterNames("第二本").join(",")}`,
  );
  assert(
    !(sidecars.get("order-flip") ?? "").includes("第二本"),
    `还原的书要从 order-flip.json 里摘掉，实际：${sidecars.get("order-flip")}`,
  );

  // 12. 删章自动删掉对应纲要（用户报的 bug：删了章，大纲页里那份纲要还留着）
  openContextMenu(rowByTitle(".tree-file", "第二本/第二章.md"));
  await wait(140);
  labels = menuLabels();
  assert(labels.includes("新建章节纲要"), `章右键有「新建章节纲要」：${labels.join(" | ")}`);
  clickMenu("新建章节纲要");
  await wait(400);
  assert(
    memFiles.has("第二本/outline/第二章.md"),
    `先给这一章建一份纲要：${[...memFiles.keys()].join(" | ")}`,
  );

  openContextMenu(rowByTitle(".tree-file", "第二本/第二章.md"));
  await wait(140);
  clickMenu("删除");
  await wait(200);
  const deleteDialog = document.querySelector(".modal") as HTMLElement | null;
  assert(deleteDialog, "弹出删除确认框");
  assert(
    (deleteDialog!.textContent ?? "").includes("第二本/outline/第二章.md"),
    `确认框要提前说清哪份纲要会一起删，实际：${deleteDialog!.textContent}`,
  );
  const deleteBtn = rows(".modal button").find((b) => (b.textContent ?? "").includes("删除"));
  assert(deleteBtn, "确认框里有「删除」按钮");
  deleteBtn!.click();
  await wait(600);
  assert(!memFiles.has("第二本/第二章.md"), "章文件已经删掉");
  assert(
    !memFiles.has("第二本/outline/第二章.md"),
    `对应纲要必须跟着删，不能在 outline/ 里留下孤儿：${[...memFiles.keys()].join(" | ")}`,
  );
  assert(
    !useStore.getState().files.includes("第二本/outline/第二章.md"),
    "纲要也要从 store 的 files 里去掉",
  );
  assert(
    (useStore.getState().status ?? "").includes("纲要"),
    `状态栏要说明纲要一并删了，实际：${useStore.getState().status}`,
  );

  /* ================= Phase D：松散章夹进两卷之间 ================= */

  // 另开一个工作区根：一本「书」，两卷各一章，外加一个书目录下的松散章
  memFiles.clear();
  memDirs.clear();
  sidecars.clear();
  memDirs.add("书");
  memDirs.add("书/第一卷 风起");
  memDirs.add("书/第二卷 惊蛰");
  memFiles.set("书/第一卷 风起/001-第一章.md", "# 第一章 启程\n\n正文。\n");
  memFiles.set("书/第二卷 惊蛰/003-第三章.md", "# 第三章 惊蛰\n\n正文。\n");
  memFiles.set("书/第二章.md", "# 第二章 间章\n\n正文。\n");
  assert(await useStore.getState().setRoot("/vol-fixture-two"), "换工作区成功");
  await wait(400);

  // setRoot 默认展开第一层：书的直接子项（两个卷 + 散在书目录下的松散章）本来就在树里，
  // 这里不用点开书（点一下反而会把它折叠起来）；卷保持收起，落点也只认书这一层。
  await wait(250);

  /** 某本书**直接子项**的显示顺序（卷目录行 + 书目录下的章行；卷里的章不算） */
  const bookChildren = (book: string) =>
    rows(".tree-row[title]")
      .map((r) => r.getAttribute("title") ?? "")
      .filter((p) => p.startsWith(book + "/") && !p.slice(book.length + 1).includes("/"));

  assert(
    bookChildren("书").join(",") === "书/第一卷 风起,书/第二卷 惊蛰,书/第二章.md",
    `拖之前：卷按卷号在前、松散章在后，实际：${bookChildren("书").join(",")}`,
  );

  // 13. 把松散章拖到「第二卷 惊蛰」行的上边缘 → 夹进两卷之间
  const looseRow = rowByTitle(".tree-file", "书/第二章.md");
  const vol2Row = rowByTitle(".tree-volume", "书/第二卷 惊蛰");
  const dragFrom = inRow(looseRow);
  const dropAtVol2Top = aboveRow(vol2Row);
  firePointer(dragZoneOf(looseRow)!, "pointerdown", dragFrom.x, dragFrom.y);
  await wait(40);
  firePointer(window, "pointermove", dropAtVol2Top.x, dropAtVol2Top.y);
  await wait(120);
  assert(
    rows(".tree-drop-before").some((r) => r.getAttribute("title") === "书/第二卷 惊蛰"),
    "落在卷行上边缘 → 插入线画在这一卷之上（tree-drop-before）",
  );
  assert(
    !document.querySelector(".tree-drop-into"),
    "卷行边缘的落点不能再判成「移入这一卷」（那样就永远夹不进去）",
  );
  firePointer(window, "pointerup", dropAtVol2Top.x, dropAtVol2Top.y);
  await wait(600);

  assert(
    (useStore.getState().chapterOrder["书"] ?? []).join(",") ===
      "第一卷 风起,第二章.md,第二卷 惊蛰",
    `顺序侧车里记下「卷名 + 章名」的混合顺序，实际：${JSON.stringify(useStore.getState().chapterOrder["书"])}`,
  );
  assert(
    (JSON.parse(sidecars.get("chapter-order") ?? "{}")["书"] ?? []).join(",") ===
      "第一卷 风起,第二章.md,第二卷 惊蛰",
    `chapter-order.json 也写入混合顺序，实际：${sidecars.get("chapter-order")}`,
  );
  assert(
    bookChildren("书").join(",") === "书/第一卷 风起,书/第二章.md,书/第二卷 惊蛰",
    `文件树里松散章夹在两卷之间，实际：${bookChildren("书").join(",")}`,
  );
  assert(
    useStore.getState().chapters.map((c) => c.path).join(",") ===
      "书/第一卷 风起/001-第一章.md,书/第二章.md,书/第二卷 惊蛰/003-第三章.md",
    `阅读顺序（也是 EPUB 的顺序）跟着夹层走，实际：${useStore
      .getState()
      .chapters.map((c) => c.path)
      .join(",")}`,
  );

  // 14. 反转卷与章的顺序：夹层跟着整层倒过来，仍在这两卷之间（阅读顺序不许动）
  const chaptersBeforeFlipD = useStore.getState().chapters.map((c) => c.path).join(",");
  const orderSidecarBeforeFlipD = sidecars.get("chapter-order") ?? "";
  openContextMenu(rowByText(".tree-dir", "书"));
  await wait(140);
  clickMenu("反转卷与章的顺序");
  await wait(400);
  assert(
    bookChildren("书").join(",") === "书/第二卷 惊蛰,书/第二章.md,书/第一卷 风起",
    `反转后仍夹在这两卷之间（只是方向跟着倒），实际：${bookChildren("书").join(",")}`,
  );
  assert(
    useStore.getState().chapters.map((c) => c.path).join(",") === chaptersBeforeFlipD,
    "反转是纯显示的：夹层不动阅读顺序（也是 EPUB 的顺序）",
  );
  assert(
    (sidecars.get("chapter-order") ?? "") === orderSidecarBeforeFlipD,
    "反转不写 chapter-order.json",
  );

  // 15. 卷改名 / 删除时，混合列表里的卷名要跟着改 / 摘掉
  openContextMenu(rowByText(".tree-dir", "书"));
  await wait(140);
  clickMenu("还原卷与章的顺序");
  await wait(400);

  openContextMenu(vol2Row);
  await wait(140);
  clickMenu("重命名");
  await wait(200);
  const volRename = document.querySelector(".tree-rename") as HTMLInputElement | null;
  assert(volRename, "卷行进入行内改名");
  setInputValue(volRename!, "第二卷 惊雷");
  volRename!.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
  );
  await wait(700);
  assert(
    (useStore.getState().chapterOrder["书"] ?? []).join(",") ===
      "第一卷 风起,第二章.md,第二卷 惊雷",
    `卷改名后混合列表里的卷名跟着改，实际：${JSON.stringify(useStore.getState().chapterOrder["书"])}`,
  );
  assert(
    bookChildren("书").join(",") === "书/第一卷 风起,书/第二章.md,书/第二卷 惊雷",
    `改名后夹层不变，实际：${bookChildren("书").join(",")}`,
  );

  openContextMenu(rowByTitle(".tree-volume", "书/第二卷 惊雷"));
  await wait(140);
  clickMenu("删除");
  await wait(200);
  const volDeleteBtn = rows(".modal button").find((b) => (b.textContent ?? "").includes("删除"));
  assert(volDeleteBtn, "删除卷的确认框里有「删除」按钮");
  volDeleteBtn!.click();
  await wait(700);
  assert(
    (useStore.getState().chapterOrder["书"] ?? []).join(",") === "第一卷 风起,第二章.md",
    `删卷后混合列表里不留已删卷的名字，实际：${JSON.stringify(useStore.getState().chapterOrder["书"])}`,
  );
  assert(
    bookChildren("书").join(",") === "书/第一卷 风起,书/第二章.md",
    `删卷后剩下的顺序照常，实际：${bookChildren("书").join(",")}`,
  );

  // 16. 夹层模式下新建卷：新卷落进卷堆里（接在最后一个卷后面），
  //     而不是掉到表尾那个松散章下面 —— 表尾是松散章时最容易看错。
  openContextMenu(rowByText(".tree-dir", "书"));
  await wait(140);
  clickMenu("新建卷");
  await wait(700);
  assert(
    (useStore.getState().chapterOrder["书"] ?? []).join(",") ===
      "第一卷 风起,新建卷,第二章.md",
    `新建的卷插在卷堆里，实际：${JSON.stringify(useStore.getState().chapterOrder["书"])}`,
  );
  assert(
    bookChildren("书").join(",") === "书/第一卷 风起,书/新建卷,书/第二章.md",
    `文件树里新卷也在松散章之前，实际：${bookChildren("书").join(",")}`,
  );
  // 新建之后这一行会进入行内改名：Esc 退出，别把输入框留给后面的步骤
  document
    .querySelector(".tree-rename")
    ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await wait(200);

  send(
    "PASS: 文件树卷行/卷细线/纲要导航树（Phase A）+ 右键菜单区分/快速创建+行内改名/新建书·卷·章节纲要/卷纲随卷改名/总纲自动创建/卷注册表/指针事件拖动排序与移动/纲要跟书走·正文区编辑·双击改名/添加章节默认名顺延（Phase B）+ 反转卷与章显示·再按还原·导出顺序不受影响/删章连带删纲要（Phase C）+ 松散章夹进两卷之间·侧车混合顺序·反转后仍夹在同两卷之间·卷改名与删除同步·新建卷插回卷堆（Phase D）",
  );
}

run().catch((error) => send(`FAIL: ${error?.message ?? error}\n${error?.stack ?? ""}`));
