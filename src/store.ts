import { create } from "zustand";
import { noteEdit, noteTotalWords } from "./lib/writingStats";
import { api, isDesktop, type FileNode, type Workspace } from "./api";
import { isChapterFile } from "./lib/chapter";
import { countWords } from "./lib/wordcount";
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

/** 伴读人物是否显示。缺省为显示；「关于」里点应用图标切换 */
const COMPANION_KEY = "mynovel:companion";

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
  /** false = 即时预览（Typora 实时预览）；true = 源码模式（显示原始 Markdown） */
  sourceMode: boolean;
  /** 专注模式（F8）：只提亮光标所在段落 */
  focusMode: boolean;
  /** 打字机模式（F9）：光标行保持垂直居中 */
  typewriterMode: boolean;
  /**
   * 输入法还没落定：正在打拼音（预编辑中），**或者**刚上屏、提交文本还在异步落盘的那一小段。
   *
   * 这段时间里 `contents[活动章]` 要么装着 "nihao" 这种拼音字母，要么是提交还没完全落定的
   * 正文 —— 它是编辑器（CodeMirror）真实同步过来的内容，但**不是最终要统计的东西**。所以：
   *   · 字数（左侧树 / 全书 / 统计 / 本章）一律等落定之后再算，别把拼音当字；
   *   · 内容本身照收，保存与脏标记不能等（关上窗口时正文得是完整的）。
   *
   * 编辑器在每次 onChange 时把这个状态带过来，并在**落定那一刻再报一次正文**
   * （见 Editor.tsx 的「落定补报」）。补报这条不能省：「上屏那一次恰好 pending=false」
   * 是靠不住的 —— 真实输入法里提交事件与 compositionend 的先后顺序各引擎不同，
   * 顺序不对就会把上屏那一次也当成预编辑，汉字于是永远进不了字数（实测踩过）。
   */
  imePending: boolean;

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
  /**
   * 正文改动。
   *
   * `imePending` = 这次正文来自「输入法还没落定」的那一段（拼音未上屏，或提交还没落稳）：
   * 内容照收（编辑器回显、保存、脏标记都要它即时），但**字数先别重算** ——
   * 那会儿的数字不是用户写的字。落定之后编辑器会再报一次（imePending=false），字数在那里落定。
   */
  setContent: (path: string, content: string, imePending?: boolean) => void;
  saveFile: (path: string) => Promise<void>;
  saveAll: () => Promise<void>;
  toggleExpand: (path: string) => void;
  ensureExpanded: (path: string) => void;
  /** 文件/目录被删除后清理内存态：关闭标签、丢弃内容与未保存标记 */
  forgetPaths: (paths: string[]) => void;
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

/*
 * chapters 当前是不是「一整个工作区的完整快照」。
 *
 * 打开工作区时 chapters 会先被清成 []（上一个工作区的章节名不能留在屏上），读完盘才落成
 * 完整列表。**那当口的 [] 不是「这本书一个字都没有」** —— 统计认的是净增，把 0 喂进去会
 * 先把基准砸到 0，等真数字回来又把整本书记成今天写的：实测不管第一次打开还是重开，
 * 挂件上的「今日已写」都当场变成 +全书字数（一万多字就是这么跳出来的），而用户一个字没敲。
 *
 * 所以载入期间先别喂（见 setRoot / loadChapters），等完整快照落地再喂。
 * 缺省是 true：常态下 chapters 一变就该喂，别让统计漏掉（见 feedBookWords）。
 */
let chaptersComplete = true;

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
  chapters: [],
  volumes: [],
  chapterOrder: {},
  flippedBooks: [],
  settings: {},
  status: "就绪",

  sidebarTab: "files",
  sidebarOpen: true,
  companionVisible: loadCompanionVisible(),
  sourceMode: false,
  focusMode: false,
  typewriterMode: false,
  imePending: false,

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
    // 显式传刚扫到的 ws.files：此刻 store 里的 files 还是上一个工作区的，
    // 而这三个侧车要按"书"去找（每本书自己 .novel/ 下各一份）。
    const volumes = await loadVolumeRegistry(root, ws.files);
    const chapterOrder = await loadChapterOrder(root, ws.files);
    const flippedBooks = await loadFlipRegistry(root, ws.files);
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
    // 从这里到 loadChapters 落盘之间，chapters 是「还没读」而不是「书是空的」，
    // 别把这个 0 喂给写作统计（那会把基准砸到 0，整本书被记成今天写的，见 chaptersComplete）
    chaptersComplete = false;
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
    try {
      await get().loadChapters();
    } finally {
      // loadChapters 正常结束时它自己会置回 true；读盘半路炸了也不能把统计永久哑掉
      chaptersComplete = true;
    }
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

  setContent: (path, content, imePending = false) => {
    // 只记「有人在敲」：活跃时长照记（拼音也是在打字）
    noteEdit();
    const st = get();
    const sameText = st.contents[path] === content;
    // 内容没变、组合态也没变就什么都不做：新对象 + 新 Set 会让订阅者白重渲染，
    // 还会把「其实没改」的路径标成脏，Ctrl+S 时白写一遍磁盘。
    if (sameText && st.imePending === imePending) return;
    if (sameText) {
      set({ imePending });
    } else {
      const contents = { ...st.contents, [path]: content };
      // 已经是脏的复用同一个 Set，省掉一次全量复制
      const dirty = st.dirty.has(path) ? st.dirty : new Set(st.dirty).add(path);
      set({ contents, dirty, imePending });
    }
    /*
     * 输入法没落定就**不重算字数**。
     *
     * 编辑器（CodeMirror）会把预编辑文本同步进文档，也就是说这段正文此刻是 "nihao"
     * 这种拼音字母 —— 它不是用户写的字。算进去的话，左侧树、全书、挂件的「今日已写」
     * 会先按拼音涨一遍，而拼音上屏时 "nihao" → "你好" 在统计眼里是**净减少**
     * （统计只认增加），已经记进去的拼音不会退回来：白记一笔。
     *
     * 落定之后编辑器会**再报一次**（imePending=false），字数在那里一次补齐 ——
     * 所以这里不做「等下一次 setContent 顺便救回来」的指望：实打实踩过一次，
     * 有的引擎里上屏那次也落在这个 pending 窗口内，于是汉字一路进不了字数。
     */
    if (imePending) return;
    // 左侧栏的字数要跟着打字变（节流 + 只重算这一章，见 scheduleChapterWords）
    scheduleChapterWords(path);
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
      // 正文换了，这一章的字数得跟着重算 —— 不然左侧树/状态栏还挂着旧字数，
      // 写作统计的基准也停在旧数上（外部改小之后再打字会被"吃掉"：正文少了 20 字、
      // 基准却还高着 20，得先白写 20 字才重新开始计数。见 store-writing-stats 用例）
      recountChapterWords(path);
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
      // 再瞄一眼内存：读盘是几毫秒前的事，打开工作区的当口完全来得及又敲进来几个字
      // （读盘途中敲的字在磁盘那份里没有，拿磁盘的去算会让这章的字数落后于编辑器）
      const text = get().contents[path] ?? texts[i] ?? "";
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
    // 这一份是完整快照（每章都已算好字数），现在才轮到统计去喂基准
    chaptersComplete = true;
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

/*
 * 左侧树 / 全书 / 写作统计用的字数 = **lib/wordcount 的默认口径**（每个非空白字符算 1：
 * 汉字、英文、数字、标点都算，空格不算）。
 *
 * 以前这里自己另写了一套「汉字逐字 + 西文按词、标点不计」，于是：
 *   · 英文、数字、标点都不进左侧树，全书与挂件的「今日已写」跟着一起少；
 *   · 而且它和状态栏「本章」用的不是同一套算法（连 `<!-- nw:no -->` 都只剔一半），
 *     保存 / 刷新那一刻数字会莫名跳一下。
 * 现在只留一个入口：要改口径就改 lib/wordcount，别在这儿另起一份。
 */
function countQuick(text: string): number {
  return countWords(text);
}

/*
 * 正文改动 → 那一章的字数跟着变：左侧树、状态栏「全书」、写作统计都吃这一份数。
 *
 * 以前字数只在 loadChapters()（打开工作区 / 手动刷新）时算一次，所以文件树里的数字要
 * 保存或刷新才更新，打字时看着是「死的」。这里在 setContent 之后补一次重算，但必须：
 *
 *   1) 节流 —— 不是防抖。防抖是「停下 N 毫秒才算」，连打时数字整个冻着不动，用户看到
 *      的就是「字数不实时」（上一版就是这么写的，被提过）。节流让它连打时也每 N 毫秒收
 *      一次、数字一路往上爬，停手后还有一次收尾保证落在准数上；
 *   2) 只算改动的那一章：长篇里章节多、单章几万字，全量重算会把主线程占死；
 *   3) 用 countQuick —— 与 loadChapters 同一套算法。两处不一致的话，保存 / 刷新那一刻
 *      数字会莫名其妙跳一下（例如从 3200 变成 3222）。
 *
 * 100ms 的取舍：看着就是实时的（每秒最多 10 次收数），而开销被钳在与打字速度、章节长度
 * 都无关的上限里 —— 实测单章扫描 1 万字 0.15ms / 5 万 0.78ms / 20 万 1.55ms（countWords），
 * 也就是普通章节每秒占不到 1ms。别再退回去用防抖，「停下才动」不算实时。
 */
const CHAPTER_WORDS_THROTTLE_MS = 100;
let wordCountTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * 这一轮里被改过、还等着重算的路径。
 *
 * 用集合而不是「记住最后一个」：一个窗口里（100ms）改了两个文件的话（总纲 + 正文、
 * 拆章、程序化改动…），只重算最后那个会**把另一个的字数永久留在旧值上** —— 留在旧值上
 * 就是「正文矮了、数字还高着」，写作统计的基准跟着一起高，接下来敲的字先得白填这个坑
 * （用户看到的就是「打了三个字只涨一个」）。集合不贵：通常就一个元素。
 */
let wordCountPending = new Set<string>();
/** 上次**真正**重算的时刻：节流的起点，与「什么时候又改了」无关 */
let wordCountLastAt = 0;

function scheduleChapterWords(path: string): void {
  wordCountPending.add(path);
  // 已经排好一次了：它会取到最新的集合，不用重排（重排就退化成防抖了）
  if (wordCountTimer !== null) return;
  const elapsed = Date.now() - wordCountLastAt;
  wordCountTimer = setTimeout(runChapterWords, Math.max(0, CHAPTER_WORDS_THROTTLE_MS - elapsed));
}

function runChapterWords(): void {
  wordCountTimer = null;
  wordCountLastAt = Date.now();
  const pending = wordCountPending;
  wordCountPending = new Set();
  // 组合态里先不算：活儿留在待办里，下一轮再看（见 recountChapterWords 的注释）
  const imePending = useStore.getState().imePending;
  pending.forEach((p) => (imePending ? wordCountPending.add(p) : recountChapterWords(p)));
  if (wordCountPending.size > 0) {
    wordCountTimer = setTimeout(runChapterWords, CHAPTER_WORDS_THROTTLE_MS);
  }
}

/** 重算一章的字数；数字没变就不换 chapters 数组，免掉整棵文件树的白重渲染 */
function recountChapterWords(path: string): void {
  const st = useStore.getState();
  /*
   * 输入法组合中不重算：此刻 contents 里是 "nihao" 这种拼音（CodeMirror 会把预编辑文本
   * 同步进文档），拿它算出来的数字不是用户写的字，喂给写作统计就白记一笔（见 setContent）。
   * 上屏之后 composing 会落回 false，那一轮补算 —— 这里不排新的待办，调用方负责再叫一次。
   */
  if (st.imePending) return;
  const text = st.contents[path];
  if (text === undefined) return;
  const i = st.chapters.findIndex((c) => c.path === path);
  // 不在章列表里（总纲 / 卷纲 / 资料文件）的，左侧树本来就不显示字数
  if (i < 0) return;
  const { meta } = parseFrontmatter(text);
  const words = meta.words ? parseInt(meta.words, 10) : countQuick(text);
  if (st.chapters[i].words === words) return;
  const chapters = st.chapters.slice();
  chapters[i] = { ...chapters[i], words };
  useStore.setState({ chapters });
}

/*
 * 把「全书字数」喂给写作统计（挂件气泡里的「今日已写」是它的净增累加）。
 *
 * 口径 = 各章已算好的字数之和（countQuick / 存档里的值），与左侧树、状态栏那个「全书」
 * 是同一个数、同一套口径。挂在 chapters 上，是为了不漏：正文改动（recountChapterWords）、
 * 重新读盘（loadChapters），以后再加的重算路径，只要动了章节字数就会被喂到一次。
 * 别的 set（contents / dirty / openTabs…）只做一次引用比较，代价可忽略。
 *
 * ⚠️ 统计只认「正文改动」，别挪到界面上去喂。状态栏那个数曾经就是喂数点：它当时为了让
 * 打字即时更新而掺着当前章的实时字数（还会随显示模式换口径），于是切章节那一帧先虚高
 * 再落回来、点一下「本章」整个换口径 —— 全被净增记成了今天写的字（实测在两篇已写好的
 * 文章之间来回切几下，每切一下白涨几百字，长章与短章之差）。何况沉浸模式压根不挂状态栏，
 * 挂那儿还会漏掉整个沉浸写作。界面怎么翻，都不该动这个统计。
 *
 * 顺带把口径也统一了：以前当前章走 countWords、其他章走 countQuick，`<!-- nw:no -->`、
 * 假名之类的差异会在切换 / 刷新那一刻凭空记成一笔；现在喂进去的自始至终只有一套口径。
 */
function feedBookWords(chapters: ChapterMeta[], root: string | null): void {
  let total = 0;
  for (const c of chapters) total += c.words;
  noteTotalWords(total, root);
}

useStore.subscribe((s, prev) => {
  // chaptersComplete = false 只出现在「打开工作区、正读盘」这一小段：那时的 chapters
  // 是清空后的占位，不是书的真实字数（见 chaptersComplete 的注释）
  if (!chaptersComplete) return;
  if (s.chapters !== prev.chapters) feedBookWords(s.chapters, s.root);
});
