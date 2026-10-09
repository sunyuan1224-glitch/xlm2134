import { create } from "zustand";
import { api, isDesktop, type FileNode, type Workspace } from "./api";
import { isChapterFile } from "./lib/chapter";
import {
  chapterFilesInTreeOrder,
  normalizeDir,
  sortTreeNodes,
  type ChapterOrder,
} from "./lib/order";
import {
  ensureBookOutlines,
  loadChapterOrder,
  loadFlipRegistry,
  loadVolumeRegistry,
  saveChapterOrder,
  saveFlipRegistry,
  saveVolumeRegistry,
} from "./lib/orderSidecar";

export interface ChapterMeta {
  path: string;
  name: string;
  title: string;
  status: string;
  summary: string;
  words: number;
}

export type WorkTab = "plot" | "timeline" | "lore" | "proofread";

/** 工作台持久化的 localStorage 键：展开状态与当前标签页 */
const WORKBENCH_OPEN_KEY = "mynovel:workbench-open";
/** 伴读人物是否显示。缺省为显示；「关于」里点应用图标切换 */
const COMPANION_KEY = "mynovel:companion";
const WORK_TAB_KEY = "mynovel:work-tab";
const WORK_TABS: readonly WorkTab[] = ["plot", "timeline", "lore", "proofread"];

/** 读取持久化的工作台展开状态；读不到时默认收起 */
function loadWorkbenchOpen(): boolean {
  try {
    return window.localStorage.getItem(WORKBENCH_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

/** 读取持久化的工作台标签页；非法值回落到「伏笔」 */
function loadWorkTab(): WorkTab {
  try {
    const raw = window.localStorage.getItem(WORK_TAB_KEY);
    return WORK_TABS.includes(raw as WorkTab) ? (raw as WorkTab) : "plot";
  } catch {
    return "plot";
  }
}

function persistWorkbenchOpen(v: boolean): void {
  try {
    window.localStorage.setItem(WORKBENCH_OPEN_KEY, v ? "1" : "0");
  } catch {
    /* 隐私模式等场景下 localStorage 不可用：只影响持久化，不影响本次会话 */
  }
}

function loadCompanionVisible(): boolean {
  try {
    return window.localStorage.getItem(COMPANION_KEY) !== "0";
  } catch {
    return true;
  }
}

function persistCompanionVisible(v: boolean): void {
  try {
    window.localStorage.setItem(COMPANION_KEY, v ? "1" : "0");
  } catch {
    /* 同上 */
  }
}

function persistWorkTab(t: WorkTab): void {
  try {
    window.localStorage.setItem(WORK_TAB_KEY, t);
  } catch {
    /* 同上 */
  }
}

/** 左侧栏的三个标签页：文件树 / 大纲（可编辑的总纲文档）/ 工作区搜索（Typora 的侧栏也是这一组） */
export type SidebarTab = "files" | "outline" | "search";

interface AppState {
  root: string | null;
  tree: FileNode[];
  files: string[];
  configDir: string | null;
  openTabs: string[];
  activePath: string | null;
  contents: Record<string, string>;
  dirty: Set<string>;
  expanded: Set<string>;
  workTab: WorkTab;
  chapters: ChapterMeta[];
  /** 卷注册表：工作区相对目录路径（.novel/volumes.json） */
  volumes: string[];
  /** 章手动顺序：目录相对路径 → 该目录内章文件名顺序（.novel/chapter-order.json） */
  chapterOrder: ChapterOrder;
  /**
   * 反转显示的书（顶层书文件夹路径，.novel/order-flip.json）。
   * 只把左侧文件树、大纲页里这本书的子树倒过来看；阅读顺序与 EPUB 导出不受影响。
   */
  flippedBooks: string[];
  settings: Record<string, unknown>;
  status: string;

  /** 左侧栏当前标签；重复点击只切标签、不折叠侧栏 */
  sidebarTab: SidebarTab;
  sidebarOpen: boolean;
  /**
   * 右侧「小说工作台」是否展开。首次使用默认收起（Typora 式正文中心布局里右栏是
   * 额外信息，不应常驻挤占正文）；用户切换后会记进 localStorage，
   * 下次打开软件保持上次的展开/收起状态。
   */
  workbenchOpen: boolean;
  /** false = 即时预览（Typora 实时预览）；true = 源码模式（显示原始 Markdown） */
  sourceMode: boolean;
  /** 专注模式（F8）：只提亮光标所在段落 */
  focusMode: boolean;
  /** 打字机模式（F9）：光标行保持垂直居中 */
  typewriterMode: boolean;

  init: () => Promise<void>;
  chooseRoot: () => Promise<void>;
  /** 切换工作区；true = 已成功切换（或已在同一目录） */
  setRoot: (root: string) => Promise<boolean>;
  /** 重新扫描当前工作区；false = 扫描失败（状态栏可见） */
  refresh: () => Promise<boolean>;
  openFile: (path: string) => Promise<void>;
  /**
   * 只把文件内容读进内存（不改 activePath、不标脏、不加标签页）。
   * 供「旁路编辑器」使用（大纲面板的总纲），已加载过则直接返回。
   */
  loadContent: (path: string) => Promise<void>;
  closeTab: (path: string) => void;
  setActive: (path: string) => void;
  setContent: (path: string, content: string) => void;
  saveFile: (path: string) => Promise<void>;
  saveAll: () => Promise<void>;
  toggleExpand: (path: string) => void;
  ensureExpanded: (path: string) => void;
  /** 文件/目录被删除后清理内存态：关闭标签、丢弃内容与未保存标记 */
  forgetPaths: (paths: string[]) => void;
  setWorkTab: (t: WorkTab) => void;
  loadChapters: () => Promise<void>;
  setStatus: (s: string) => void;
  /** 覆盖卷注册表并持久化（新建卷 / 改名 / 删除都会走这里） */
  setVolumes: (next: string[]) => Promise<void>;
  /** 打补丁式更新章顺序并持久化；值为空数组表示删除该目录的登记 */
  applyChapterOrder: (patch: Record<string, string[]>) => Promise<void>;
  /** 覆盖「反转显示」的书并持久化（右键书 →「反转卷与章的顺序」）；只影响左侧显示 */
  setFlippedBooks: (next: string[]) => Promise<void>;

  /** 切到指定标签并确保侧栏展开；重复点当前标签不会折叠侧栏（一律不退栏） */
  openSidebarTab: (t: SidebarTab) => void;
  setSidebarOpen: (v: boolean) => void;
  toggleSidebar: () => void;
  setWorkbenchOpen: (v: boolean) => void;
  toggleWorkbench: () => void;
  /** 稿纸旁的伴读人物。关于对话框里点应用图标切换，记在 localStorage */
  companionVisible: boolean;
  toggleCompanion: () => void;
  setSourceMode: (v: boolean) => void;
  toggleSourceMode: () => void;
  toggleFocusMode: () => void;
  toggleTypewriterMode: () => void;
  /** 丢弃内存副本并按磁盘重读（不改 dirty），见实现处注释 */
  reloadFromDisk: (path: string) => Promise<void>;
}

// \r? 是为了兼容 CRLF：外部编辑器存过的章节不能因此丢掉 title/status/words。
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * 同一路径的写盘串行化队列。
 * 保存是异步的，删除也可能在保存进行中发生；不串行化就会出现
 * 「删除成功 → 未落地的保存又把文件写回来」的复活问题。
 */
const writeQueue = new Map<string, Promise<void>>();

function enqueueWrite(path: string, task: () => Promise<void>): Promise<void> {
  const prev = writeQueue.get(path) ?? Promise.resolve();
  const run = prev.then(task, task);
  const settled = run.catch(() => {}).finally(() => {
    if (writeQueue.get(path) === settled) writeQueue.delete(path);
  });
  writeQueue.set(path, settled);
  return run;
}

/** 等待在途写盘结束；paths 省略表示全部。删除前必须先调用 */
export async function flushWrites(paths?: string[]): Promise<void> {
  const entries = Array.from(writeQueue.entries());
  // 目录目标要连带等待其下所有子路径，否则只等了目录自身这个 key
  const list = paths
    ? entries
        .filter(([p]) => paths.some((t) => p === t || p.startsWith(t + "/")))
        .map(([, v]) => v)
    : entries.map(([, v]) => v);
  await Promise.allSettled(list);
}

interface WriteOutcome {
  ok: boolean;
  /** 因路径被锁定（删除中）而跳过：调用方必须保留 dirty，不能当成已保存 */
  skipped?: boolean;
  error?: string;
}

/**
 * 破坏性操作（删除）期间对路径加锁：flush 只能保证「已经排队的写盘」结束，
 * 挡不住确认后在 delete 请求飞行途中新插入的 Ctrl+S。
 * 加锁后 saveFile/saveAll 会跳过这些路径，删除完成或失败后再解锁。
 */
const lockedPaths = new Set<string>();

function isLocked(path: string): boolean {
  if (lockedPaths.has(path)) return true;
  for (const l of lockedPaths) {
    if (path.startsWith(l + "/")) return true;
  }
  return false;
}

/** 锁定若干路径（目录锁覆盖其下所有子路径），返回解锁函数 */
export function lockPaths(paths: string[]): () => void {
  const added = paths.filter((p) => !lockedPaths.has(p));
  added.forEach((p) => lockedPaths.add(p));
  return () => added.forEach((p) => lockedPaths.delete(p));
}

function writePathSerial(root: string, path: string, content: string): Promise<WriteOutcome> {
  let outcome: WriteOutcome = { ok: true };
  return enqueueWrite(path, async () => {
    // 队伍里排到执行时才检查锁：加锁前入队的写入由 flush 等待，加锁后不再落盘
    if (isLocked(path)) return;
    try {
      await api.writeFile(root, path, content);
    } catch (e) {
      outcome = { ok: false, error: String(e) };
    }
  }).then(() => outcome);
}

export function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = text.match(FRONTMATTER_RE);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) {
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      if (k) meta[k] = v;
    }
  }
  return { meta, body: text.slice(m[0].length) };
}

function titleOf(name: string, meta: Record<string, string>): string {
  return meta.title || name.replace(/\.md$/, "");
}

export const useStore = create<AppState>((set, get) => ({
  root: null,
  tree: [],
  files: [],
  configDir: null,
  openTabs: [],
  activePath: null,
  contents: {},
  dirty: new Set(),
  expanded: new Set(),
  workTab: loadWorkTab(),
  chapters: [],
  volumes: [],
  chapterOrder: {},
  flippedBooks: [],
  settings: {},
  status: "就绪",

  sidebarTab: "files",
  sidebarOpen: true,
  workbenchOpen: loadWorkbenchOpen(),
  companionVisible: loadCompanionVisible(),
  sourceMode: false,
  focusMode: false,
  typewriterMode: false,

  init: async () => {
    // 浏览器预览没有 Tauri 后端，任何 invoke 都会 reject，直接跳过。
    if (!isDesktop()) return;
    try {
      const dir = await api.configDir();
      set({ configDir: dir });
      const lastRoot =
        window.localStorage.getItem("mynovel:last-root") ??
        window.localStorage.getItem("novel-app:last-root");
      if (lastRoot) await get().setRoot(lastRoot);
    } catch (e) {
      console.error("config dir 失败", e);
    }
  },

  chooseRoot: async () => {
    if (!isDesktop()) {
      set({ status: "当前是浏览器预览，请用 npm run app 启动桌面版" });
      window.alert("工作区目录选择需要 Tauri 桌面版。\n\n请在项目目录运行：\n\nnpm run app");
      return;
    }
    try {
      const dir = await api.pickDirectory();
      if (!dir) return; // 用户取消
      const ok = await get().setRoot(dir);
      // 只有成功打开的工作区才记入 last-root，避免下次启动指向坏目录
      if (ok) {
        window.localStorage.setItem("mynovel:last-root", dir);
        window.localStorage.removeItem("novel-app:last-root");
      }
    } catch (e) {
      set({ status: "打开目录失败: " + String(e) });
      window.alert("打开目录失败：\n" + String(e));
    }
  },

  setRoot: async (root) => {
    // 1. 有未保存数据先写盘；写盘失败则阻止切换，绝不丢内容
    if (get().dirty.size > 0) {
      await get().saveAll();
      if (get().dirty.size > 0) {
        const err = "存在未保存更改且自动保存失败，已阻止切换工作区";
        set({ status: err });
        window.alert(err);
        return false;
      }
    }

    // 2. 先扫描目标目录，扫描成功后才切换 root（失败时保持现状并显示错误）
    let ws: Workspace;
    try {
      ws = await api.scan(root);
    } catch (e) {
      const errMsg = "扫描工作区失败: " + root + " —— " + String(e);
      set({ status: errMsg });
      window.alert(errMsg);
      return false;
    }

    // 3. 载入侧车（卷注册表 / 章手动顺序）→ 自动补总纲 → 有新增就再扫一次
    const volumes = await loadVolumeRegistry(root);
    const chapterOrder = await loadChapterOrder(root);
    const flippedBooks = await loadFlipRegistry(root);
    let { files, tree } = ws;
    const created = await ensureBookOutlines(root, files, volumes);
    if (created.length) {
      try {
        const again = await api.scan(root);
        files = again.files;
        tree = again.tree;
      } catch {
        /* 保留第一次扫描结果，至少要能打开工作区 */
      }
    }

    const expanded = new Set<string>();
    tree.forEach((n) => expanded.add(n.path)); // 默认展开第一层
    set({
      root,
      tree,
      files,
      expanded,
      openTabs: [],
      activePath: null,
      contents: {},
      dirty: new Set(),
      chapters: [],
      volumes,
      chapterOrder,
      flippedBooks,
      status: "工作区: " + root,
    });
    await get().loadChapters();
    return true;
  },

  refresh: async () => {
    const { root } = get();
    if (!root) return false;
    try {
      const ws: Workspace = await api.scan(root);
      // 新出现的书（有章没总纲）自动补 总纲.md；有新增就再扫一次，让新文件立刻可见
      const created = await ensureBookOutlines(root, ws.files, get().volumes);
      let files = ws.files;
      let tree = ws.tree;
      if (created.length) {
        try {
          const again = await api.scan(root);
          files = again.files;
          tree = again.tree;
        } catch {
          /* 保留第一次扫描结果 */
        }
      }
      const expanded = new Set(get().expanded);
      // 默认展开第一层
      tree.forEach((n) => expanded.add(n.path));
      set({ tree, files, expanded });
      await get().loadChapters();
      set({ status: "已刷新 " + root });
      return true;
    } catch (e) {
      set({ status: "扫描失败: " + String(e) });
      return false;
    }
  },

  openFile: async (path) => {
    const { root, openTabs } = get();
    if (!root) return;
    set({ activePath: path });
    if (!openTabs.includes(path)) {
      set({ openTabs: [...openTabs, path] });
    }
    await get().loadContent(path);
  },
  loadContent: async (path) => {
    const { root, contents } = get();
    if (!root || contents[path] !== undefined) return;
    try {
      const fc = await api.readFile(root, path);
      // 读盘期间可能已经有人写进内存（另一个编辑器先加载完了）：不覆盖更新的那份
      if (fc && get().contents[path] === undefined) {
        set({ contents: { ...get().contents, [path]: fc.content } });
      }
    } catch (e) {
      set({ status: "读取失败: " + String(e) });
    }
  },

  closeTab: (path) => {
    const openTabs = get().openTabs.filter((p) => p !== path);
    const activePath = get().activePath === path ? openTabs[openTabs.length - 1] ?? null : get().activePath;
    set({ openTabs, activePath });
  },

  setActive: (path) => set({ activePath: path }),

  setContent: (path, content) => {
    const st = get();
    // 内容没变就什么都不做：新对象 + 新 Set 会让订阅者白重渲染，
    // 还会把「其实没改」的路径标成脏，Ctrl+S 时白写一遍磁盘。
    if (st.contents[path] === content) return;
    const contents = { ...st.contents, [path]: content };
    // 已经是脏的复用同一个 Set，省掉一次全量复制
    const dirty = st.dirty.has(path) ? st.dirty : new Set(st.dirty).add(path);
    set({ contents, dirty });
  },

  /**
   * 同一路径的正文被外部改写后（合并章节、拆分章节、外部编辑器改盘），
   * 必须显式丢内存副本重读：openFile 对已加载过的路径直接返回，
   * 编辑器会一直显示改写前的旧正文，用户再敲一个字就把它覆盖掉。
   */
  reloadFromDisk: async (path) => {
    const { root } = get();
    if (!root) return;
    try {
      const fc = await api.readFile(root, path);
      if (!fc) return; // 文件不在了：让上层自己处理，这里不凭空造一份空正文
      const contents = { ...get().contents, [path]: fc.content };
      const dirty = new Set(get().dirty);
      dirty.delete(path); // 磁盘版本就是当前版本，不再算未保存
      set({ contents, dirty });
    } catch (e) {
      set({ status: "重新读取失败: " + String(e) });
    }
  },

  saveFile: async (path) => {
    const { root, contents, dirty } = get();
    if (!root || !dirty.has(path)) return;
    if (isLocked(path)) {
      // 不写盘也不清 dirty：保持未保存状态，删除流程结束后用户仍可保存
      set({ status: "该路径正在删除，已跳过保存" });
      return;
    }
    const snapshot = contents[path] ?? "";
    const { ok, skipped, error } = await writePathSerial(root, path, snapshot);
    if (get().root !== root) return; // 工作区已切换，不更新另一个工作区的状态
    if (skipped) {
      set({ status: "该路径正在删除，已跳过保存" });
      return; // dirty 保持不变
    }
    if (!ok) {
      set({ status: "保存失败: " + error });
      return;
    }
    const next = new Set(get().dirty);
    // 写盘期间文件被删除 → forgetPaths 已清掉 dirty，不能再标记为已保存
    if (!next.has(path)) return;
    const latest = get().contents[path];
    if (latest === snapshot) next.delete(path);
    set({
      dirty: next,
      status:
        latest === snapshot
          ? "已保存 " + path
          : "已保存 " + path + "（写盘期间有新改动，仍有未保存内容）",
    });
  },

  saveAll: async () => {
    const { root, contents, dirty } = get();
    if (!root || dirty.size === 0) return;
    let firstError = "";
    let skippedCount = 0;
    for (const p of Array.from(dirty)) {
      if (get().root !== root) return;
      // 期间可能已被删除（dirty 被清掉），跳过以免把文件写回来
      if (!get().dirty.has(p)) continue;
      if (isLocked(p)) {
        skippedCount++;
        continue;
      }
      const snapshot = contents[p] ?? get().contents[p] ?? "";
      try {
        const { ok, skipped, error } = await writePathSerial(root, p, snapshot);
        if (skipped) {
          skippedCount++;
          continue;
        }
        if (!ok) {
          if (!firstError) firstError = error ?? "未知错误";
          continue;
        }
      } catch (e) {
        if (!firstError) firstError = String(e);
        continue;
      }
      const next = new Set(get().dirty);
      if (!next.has(p)) continue;
      if (get().contents[p] === snapshot) next.delete(p);
      else if (!firstError) firstError = "写盘期间有新改动";
      set({ dirty: next });
    }
    if (get().root !== root) return;
    const left = get().dirty;
    if (left.size > 0) {
      set({
        dirty: left,
        status:
          "保存失败: " +
          (firstError || "仍有未保存内容") +
          (skippedCount > 0 ? `（${skippedCount} 个路径正在删除，已跳过）` : "") +
          "（" +
          left.size +
          " 个文件未保存）",
      });
    } else {
      set({ dirty: new Set(), status: "全部已保存" });
    }
  },

  toggleExpand: (path) => {
    const expanded = new Set(get().expanded);
    if (expanded.has(path)) expanded.delete(path);
    else expanded.add(path);
    set({ expanded });
  },

  ensureExpanded: (path) => {
    if (!path) return;
    const expanded = new Set(get().expanded);
    // 逐级展开祖先，否则新建/打开的深层文件在树里看不见
    const parts = path.split("/");
    let acc = "";
    for (const seg of parts) {
      acc = acc ? `${acc}/${seg}` : seg;
      expanded.add(acc);
    }
    expanded.add(path);
    if (expanded.size === get().expanded.size) return;
    set({ expanded });
  },

  forgetPaths: (paths) => {
    if (paths.length === 0) return;
    const prefixes = paths.map((p) => p + "/");
    const gone = (p: string) => paths.includes(p) || prefixes.some((pre) => p.startsWith(pre));
    const st = get();
    const openTabs = st.openTabs.filter((p) => !gone(p));
    const contents: Record<string, string> = {};
    for (const [k, v] of Object.entries(st.contents)) {
      if (!gone(k)) contents[k] = v;
    }
    const dirty = new Set(Array.from(st.dirty).filter((p) => !gone(p)));
    const activePath =
      st.activePath && gone(st.activePath)
        ? (openTabs[openTabs.length - 1] ?? null)
        : st.activePath;
    set({ openTabs, contents, dirty, activePath });
  },

  setWorkTab: (workTab) => {
    persistWorkTab(workTab);
    set({ workTab });
  },

  loadChapters: async () => {
    const { root, files, contents, volumes, chapterOrder } = get();
    if (!root) return;
    // 阅读顺序 = 文件树的视觉顺序（卷按卷号、章按手动顺序），大纲与 EPUB 共用
    const sortedTree = sortTreeNodes(get().tree, new Set(volumes), chapterOrder);
    const ordered = chapterFilesInTreeOrder(sortedTree);
    const seen = new Set(ordered);
    const chaps = [
      ...ordered,
      ...files
        .filter((p) => isChapterFile(p) && !seen.has(p))
        .sort((a, b) => a.localeCompare(b, "zh-CN")),
    ];
    // 串行 await 在长篇上是几百次 IPC 往返；这里限并发 8 路，结果顺序仍按 chaps 对齐。
    const texts = await mapLimit(chaps, 8, async (path) => {
      const cached = contents[path];
      if (cached !== undefined) return cached;
      try {
        return (await api.readFile(root, path))?.content ?? "";
      } catch {
        return "";
      }
    });
    const result: ChapterMeta[] = chaps.map((path, i) => {
      const text = texts[i] ?? "";
      const { meta } = parseFrontmatter(text);
      const name = path.split("/").pop() ?? path;
      return {
        path,
        name,
        title: titleOf(name, meta),
        status: meta.status || "草稿",
        summary: meta.summary || "",
        words: meta.words ? parseInt(meta.words, 10) : countQuick(text),
      };
    });
    set({ chapters: result });
  },

  setStatus: (status) => set({ status }),

  setVolumes: async (next) => {
    const root = get().root;
    const clean = Array.from(new Set(next.map(normalizeDir))).filter(Boolean);
    set({ volumes: clean });
    if (root) await saveVolumeRegistry(root, clean);
    reorderChapters();
  },

  setFlippedBooks: async (next) => {
    const root = get().root;
    const clean = Array.from(new Set(next.map(normalizeDir))).filter(Boolean);
    set({ flippedBooks: clean });
    if (root) await saveFlipRegistry(root, clean);
    // 故意不调 reorderChapters()：反转只是显示，阅读顺序与 EPUB 导出保持原样
  },

  applyChapterOrder: async (patch) => {
    const root = get().root;
    const cur: ChapterOrder = { ...get().chapterOrder };
    for (const [dir, list] of Object.entries(patch)) {
      const key = normalizeDir(dir);
      if (list && list.length > 0) cur[key] = list;
      else delete cur[key];
    }
    set({ chapterOrder: cur });
    if (root) await saveChapterOrder(root, cur);
    reorderChapters();
  },

  // 打开这一栏，而不是「切换这一栏」：
  // 重复点/按同一个标签（文件、大纲、搜索）一律只保证展开，绝不收起侧栏。
  // 收起侧栏只剩两个显式入口：视图菜单的「左侧栏」与 Ctrl+Shift+L。
  openSidebarTab: (t) => set({ sidebarTab: t, sidebarOpen: true }),
  setSidebarOpen: (v) => set({ sidebarOpen: v }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setWorkbenchOpen: (v) => {
    persistWorkbenchOpen(v);
    set({ workbenchOpen: v });
  },
  toggleWorkbench: () =>
    set((s) => {
      persistWorkbenchOpen(!s.workbenchOpen);
      return { workbenchOpen: !s.workbenchOpen };
    }),
  toggleCompanion: () =>
    set((s) => {
      const next = !s.companionVisible;
      persistCompanionVisible(next);
      return { companionVisible: next };
    }),
  setSourceMode: (v) => set({ sourceMode: v }),
  toggleSourceMode: () => set((s) => ({ sourceMode: !s.sourceMode })),
  toggleFocusMode: () => set((s) => ({ focusMode: !s.focusMode })),
  toggleTypewriterMode: () => set((s) => ({ typewriterMode: !s.typewriterMode })),
}));

/**
 * 卷注册表 / 章顺序变化后，不重读磁盘，直接按新的树顺序重排已有的 chapters 元数据。
 * （章节文本已经读进 contents，这里只改顺序，避免一次 loadChapters 全量重读。）
 */
/** 限并发的 map：保持输出顺序，同时不让几百个文件读请求一次性全压给后端 */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker),
  );
  return out;
}

function reorderChapters(): void {
  const st = useStore.getState();
  if (st.chapters.length === 0) return;
  const sortedTree = sortTreeNodes(st.tree, new Set(st.volumes), st.chapterOrder);
  const paths = chapterFilesInTreeOrder(sortedTree);
  const byPath = new Map(st.chapters.map((c) => [c.path, c] as const));
  const next: ChapterMeta[] = [];
  for (const p of paths) {
    const c = byPath.get(p);
    if (c) next.push(c);
  }
  const inTree = new Set(paths);
  for (const c of st.chapters) {
    if (!inTree.has(c.path)) next.push(c);
  }
  if (next.length === st.chapters.length) useStore.setState({ chapters: next });
}

function countQuick(text: string): number {
  const body = text.replace(FRONTMATTER_RE, "");
  const stripped = body.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  let n = 0;
  let inWord = false;
  for (const ch of stripped) {
    if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(ch)) {
      n++;
      inWord = false;
    } else if (/[\p{L}\p{N}]/u.test(ch)) {
      if (!inWord) {
        n++;
        inWord = true;
      }
    } else inWord = false;
  }
  return n;
}
