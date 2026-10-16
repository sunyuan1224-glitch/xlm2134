import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { api, type FileNode } from "../api";
import { useStore, lockPaths, flushWrites } from "../store";
import { ModalStage } from "./ModalStage";
import {
  basename,
  dirName,
  extractVolumeNumber,
  isChapterFile,
  isOutlineFile,
  isVolumeDirectoryName,
  sanitizeFileName,
  validateEntryName,
} from "../lib/chapter";
import {
  DEFAULT_BOOK_NAME,
  DEFAULT_VOLUME_NAME,
  bookScopeOf,
  compareTreeNodes,
  directChildOrder,
  isDisplayFlipped,
  isVolumeDir,
  orderDirChapters,
  outlinesRemovedWith,
  placeVolumeInOrder,
} from "../lib/order";
import { OUTLINE_DIR, bookOutlinePath, findVolumeDir } from "../lib/volume";
import { defaultChapterName } from "../lib/chapterOps";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

type TargetKind = "root" | "dir" | "file";

interface MenuTarget {
  kind: TargetKind;
  /** 相对工作区的路径；root 为 "" */
  path: string;
  name: string;
}

/** 新建文件 / 文件夹的默认名：不再自动编号成「001-第一章」 */
const DEFAULT_NEW_NAME = "Untitled";

/**
 * 拖动阈值（CSS px）：指针位移超过它才算「拖动」，否则当成一次普通点击。
 * 章拖动是拿指针事件自己实现的（不是 HTML5 拖放）：HTML5 拖放期间 WebKit 会把它
 * 自己那套图标画在光标上，改不掉；指针事件下光标完全由 CSS 决定，
 * 拖动时只靠 body.is-dragging-file 就能显示用户光标主题的「抓取」形态。
 */
const DRAG_THRESHOLD_PX = 6;

/**
 * 卷行上/下各留多大比例做「插到这一卷前/后」的落点（中间那条带仍是「移入这一卷」）。
 * 行是紧挨着排的，没有真的缝隙可落，夹层只能寄生在卷行的边缘上。
 */
const DROP_EDGE_RATIO = 1 / 3;

/** 行内改名：把树的某一行换成输入框，不弹对话框 */
interface EditApi {
  editing: { path: string; value: string } | null;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}

interface DeleteTarget {
  path: string;
  isDir: boolean;
}

/** 拖动中的落点提示：插入到某章前/后，或整个移入某目录 */
type DropHint =
  | { kind: "before" | "after"; path: string }
  | { kind: "into"; dir: string };

/*
 * 这个面板没有 props，数据全部来自 store 的细粒度选择器（自己订阅自己用到的字段）。
 * 不包 memo 的话，App 每敲一个字重渲染都会把这棵树整棵跟着重建，
 * 而它订阅的切片根本没变——纯属白干；包上之后重渲染只由选择器自己触发。
 */
export const FileTree = memo(function FileTree() {
  const tree = useStore((s) => s.tree);
  const chapters = useStore((s) => s.chapters);
  const expanded = useStore((s) => s.expanded);
  const toggleExpand = useStore((s) => s.toggleExpand);
  const openFile = useStore((s) => s.openFile);
  const activePath = useStore((s) => s.activePath);
  const root = useStore((s) => s.root);
  const files = useStore((s) => s.files);
  const volumes = useStore((s) => s.volumes);
  const chapterOrder = useStore((s) => s.chapterOrder);
  const applyChapterOrder = useStore((s) => s.applyChapterOrder);
  const flippedBooks = useStore((s) => s.flippedBooks);
  const setFlippedBooks = useStore((s) => s.setFlippedBooks);
  /** 反转显示的书（Set 版，TreeNode 每层都要查一次） */
  const flippedBookSet = useMemo(() => new Set(flippedBooks), [flippedBooks]);

  const [menu, setMenu] = useState<{ x: number; y: number; target: MenuTarget } | null>(null);
  const [deleting, setDeleting] = useState<DeleteTarget | null>(null);
  const [busy, setBusy] = useState(false);
  /** 对话框内的错误提示：只显示在对话框里，被遮罩挡住时 status 看不见 */
  const [dialogError, setDialogError] = useState("");
  /** 行内改名状态：新建文件/文件夹/卷、重命名都在树的这一行上直接改 */
  const [editing, setEditing] = useState<{
    path: string;
    value: string;
    isDir: boolean;
    autoMd: boolean;
  } | null>(null);
  /** 一次编辑只提交一次：Enter 之后输入框被移除还会再触发一次 blur */
  const editDone = useRef(false);

  // ---------- 拖动状态（指针事件自实现，见 onChapterPointerDown） ----------
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<DropHint | null>(null);
  /** 拖动结束后的极短时间里点树会误触 openFile，这里把它吞掉 */
  const suppressClick = useRef(0);
  /** 落点的同步副本：pointermove/pointerup 挂在 window 上，闭包里的 state 是注册那一刻的旧值 */
  const dropHintRef = useRef<DropHint | null>(null);
  /** 这次按下之后的拖动进度：src 固定，dragging = 是否已越过阈值 */
  const pointerRef = useRef<{ src: string; x: number; y: number; dragging: boolean } | null>(null);
  /** 已挂上的 window/document 监听器：摘除时必须用同一份引用 */
  const listenersRef = useRef<{
    move: (e: PointerEvent) => void;
    finish: (e: Event) => void;
    select: (e: Event) => void;
  } | null>(null);

  const volumeSet = useMemo(() => new Set(volumes), [volumes]);

  const words = useMemo(() => {
    const map = new Map<string, number>();
    chapters.forEach((c) => map.set(c.path, c.words));
    return map;
  }, [chapters]);

  /** 卷目录 → 该卷下的章节数（只统计真正的章，总纲/卷纲不计入） */
  const volumeCounts = useMemo(() => {
    const map = new Map<string, number>();
    files.filter(isChapterFile).forEach((p) => {
      const dir = findVolumeDir(p, volumeSet);
      if (dir) map.set(dir, (map.get(dir) ?? 0) + 1);
    });
    return map;
  }, [files, volumeSet]);

  // 工作区切换时关掉遗留的菜单/对话框，避免对旧工作区操作
  useEffect(() => {
    setMenu(null);
    setDeleting(null);
    resetDrag();
    // 换工作区 / 卸载时别把监听器和 body 上的拖动类留下
    return () => resetDrag();
  }, [root]);

  if (!root) return null;

  const rootLabel = basename(root) || root;

  /** 某目录里章的完整顺序（注册表优先，未列入的按文件名兜底）。总是读最新 files。 */
  const effectiveOrder = (dir: string): string[] => {
    const st = useStore.getState();
    const names = st.files
      .filter((p) => dirName(p) === dir && isChapterFile(p))
      .map((p) => basename(p));
    return orderDirChapters(names, st.chapterOrder[dir] ?? []);
  };

  /**
   * 某目录**直接子项**的当前顺序（卷目录名与章文件名混合）。
   * 拖动落点往这份列表里插名字，松散章才能夹到两卷之间 ——
   * 它就是文件树同一层的视觉顺序，所以插进去的顺序就是看到的顺序。
   * 根目录或树里找不到的目录回落到纯章名顺序。
   */
  const childList = (dir: string): string[] => {
    const st = useStore.getState();
    const node = dir ? findNode(st.tree, dir) : null;
    return node
      ? directChildOrder(node.children, volumeSet, st.chapterOrder, dir === "")
      : effectiveOrder(dir);
  };

  const handleOpenFile = (p: string) => {
    if (Date.now() - suppressClick.current < 400) return;
    void openFile(p);
  };

  /** 空白处右键 = 工作区根目录 */
  const onBlankContextMenu = (e: ReactMouseEvent) => {
    if ((e.target as HTMLElement).closest(".tree-row")) return;
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, target: { kind: "root", path: "", name: rootLabel } });
  };

  /**
   * 空白处新建章节的落点：当前展开的目录里最靠下的那一个。
   * 一个目录都没展开时返回 null —— 这种情况下「添加章节」是禁用的。
   */
  const expandedChapterDir = (): string | null => {
    if (expanded.size === 0) return null;
    let found: string | null = null;
    const walk = (nodes: FileNode[]) => {
      for (const n of nodes) {
        // 纲要不进文件树（由左侧「大纲」页统一管理），别把新章落到 outline/ 里
        if (n.is_dir && expanded.has(n.path) && !isOutlineFile(n.path)) {
          found = n.path;
          walk(n.children ?? []);
        }
      }
    };
    walk(tree);
    return found;
  };

  /** 目标目录下不重名的默认名字：Untitled、Untitled 2、Untitled 3… */
  const freeName = (dir: string, base: string, ext: string): string => {
    const st = useStore.getState();
    const taken = (n: string) => {
      const p = dir ? `${dir}/${n}` : n;
      return st.files.includes(p) || !!findNode(st.tree, p);
    };
    if (!taken(base + ext) && !taken(base)) return base;
    for (let i = 2; i < 200; i++) {
      const n = `${base} ${i}`;
      if (!taken(n + ext) && !taken(n)) return n;
    }
    return `${base} ${Date.now()}`;
  };

  /** 书目录下的 outline/ 文件夹（book === "" 时为工作区根的 outline/） */
  const outlineDirOf = (book: string): string => (book ? `${book}/${OUTLINE_DIR}` : OUTLINE_DIR);

  /**
   * 在 book 的 outline/ 下创建一个纲要文件：默认名取实体名，重名自动加序号。
   * 已存在同名纲要时（例：同一章重复右键）会得到「第一章 2.md」而不是报错。
   */
  const createOutlineFile = async (book: string, base: string, content = ""): Promise<string> => {
    const r = useStore.getState().root;
    if (!r) throw new Error("没有工作区");
    const dir = outlineDirOf(book);
    const name = freeName(dir, base, ".md");
    const rel = `${dir}/${name}.md`;
    await api.createFile(r, rel, content);
    return rel;
  };

  const onNodeContextMenu = (e: ReactMouseEvent, node: FileNode) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      target: {
        kind: node.is_dir ? "dir" : "file",
        path: node.path,
        name: node.name,
      },
    });
  };

  const menuItems = (): (ContextMenuItem | "separator")[] => {
    if (!menu) return [];
    const { kind, path, name } = menu.target;
    // 新建文件：文件夹节点 → 该文件夹；文件节点 → 它所在目录；空白处 → 工作区根目录
    const fileDir = kind === "dir" ? path : kind === "file" ? dirName(path) : "";
    // 新建章节：跟着节点的目录走；空白处则落在当前展开的目录里
    const chapterDir = kind === "dir" ? path : kind === "file" ? dirName(path) : expandedChapterDir();

    const newChapter: ContextMenuItem = {
      key: "new-chapter",
      label: "添加章节",
      disabled: chapterDir === null,
      onClick: () => {
        if (chapterDir === null) return;
        void quickCreateChapter(chapterDir);
      },
    };
    const newFile: ContextMenuItem = {
      key: "new-file",
      label: "新建文件",
      onClick: () => void quickCreateFile(fileDir),
    };
    const newFolder: ContextMenuItem = {
      key: "new-folder",
      label: "新建文件夹",
      onClick: () => void quickCreateFolder(fileDir),
    };
    const newVolume: ContextMenuItem = {
      key: "new-volume",
      label: "新建卷",
      onClick: () => void quickCreateVolume(fileDir),
    };
    const newBook: ContextMenuItem = {
      key: "new-book",
      label: "新建书",
      onClick: () => void quickCreateBook(),
    };
    /** 章节纲要只能从章的右键菜单按需创建（不随建章自动生成） */
    const newChapterOutline: ContextMenuItem = {
      key: "new-chapter-outline",
      label: "新建章节纲要",
      onClick: () => void quickCreateChapterOutline(path),
    };
    const renameItem: ContextMenuItem = {
      key: "rename",
      label: kind === "dir" ? "重命名文件夹" : "重命名",
      onClick: () => {
        const isDir = kind === "dir";
        startEdit({
          path,
          isDir,
          autoMd: !isDir && /\.md$/i.test(name),
          value: !isDir && /\.md$/i.test(name) ? name.replace(/\.md$/i, "") : name,
        });
      },
    };
    const refreshItem: ContextMenuItem = {
      key: "refresh",
      label: "刷新工作区",
      onClick: () => void useStore.getState().refresh(),
    };


    if (kind === "file") {
      const fileItems: (ContextMenuItem | "separator")[] = [
        {
          key: "open",
          label: "打开文件",
          onClick: () => void openFile(path),
        },
        renameItem,
        "separator",
        newChapter,
        newFile,
      ];
      // 只有真正的章、而且它属于某本书文件夹时才给「新建章节纲要」：
      // 纲要一律挂在 书/outline/ 下，散在工作区根目录（或根级卷里）的章没有纲要。
      if (isChapterFile(path) && bookScopeOf(path, volumeSet) !== "") {
        fileItems.push(newChapterOutline);
      }
      fileItems.push("separator", {
        key: "delete",
        label: `删除 ${basename(name) || name}`,
        danger: true,
        onClick: () => {
          setDialogError("");
          setDeleting({ path, isDir: false });
        },
      });
      return fileItems;
    }

    const items: (ContextMenuItem | "separator")[] = [newChapter, newFile, newFolder];
    /*
     * 卷只能挂在「书」下面：只有右键书文件夹（工作区根的直接子目录、且自己不是卷）才给「新建卷」。
     * 右键空白/工作区根不给——那里是书的上一层，落点不明确；卷目录里也不给，卷不能套卷。
     */
    const isBookFolder =
      kind === "dir" ? dirName(path) === "" && !isVolumeDir(name, path, volumeSet) : false;
    if (isBookFolder) {
      items.push(newVolume);
      /*
       * 反转卷与章的顺序：只把这本书在左侧（文件树 + 大纲页）倒过来看，再点一下还原。
       * 顺序侧车、阅读顺序、EPUB 导出都不动 —— 所以这里只是切换一个显示开关。
       */
      const flipped = flippedBooks.includes(path);
      items.push({
        key: "flip-order",
        label: flipped ? "还原卷与章的顺序" : "反转卷与章的顺序",
        onClick: () => {
          const next = flipped
            ? flippedBooks.filter((p) => p !== path)
            : [...flippedBooks, path];
          void setFlippedBooks(next);
          useStore
            .getState()
            .setStatus(flipped ? `已还原 ${basename(path)} 的显示顺序` : `已反转 ${basename(path)} 的显示顺序`);
        },
      });
    }
    if (kind === "dir") {
      items.push("separator", renameItem, "separator", {
        key: "delete-dir",
        label: `删除文件夹 ${basename(path)}`,
        danger: true,
        onClick: () => {
          setDialogError("");
          setDeleting({ path, isDir: true });
        },
      });
    } else {
      items.push(newBook, "separator", refreshItem);
    }
    return items;
  };

  const edit: EditApi = {
    editing: editing ? { path: editing.path, value: editing.value } : null,
    onChange: (v: string) => setEditing((cur) => (cur ? { ...cur, value: v } : cur)),
    onCommit: () => void commitEdit(),
    onCancel: cancelEdit,
  };

  // ---------- 拖动：章行（指针事件） ----------

  /** 落点既进 state（画高亮）也进 ref（pointerup 时读最新值） */
  function applyHint(hint: DropHint | null) {
    dropHintRef.current = hint;
    setDropHint(hint);
  }

  /** 清掉拖动状态：摘监听器、清 ref、清 body 上的类与 userSelect，但不屏蔽随后的点击 */
  function resetDrag() {
    const l = listenersRef.current;
    if (l) {
      window.removeEventListener("pointermove", l.move);
      window.removeEventListener("pointerup", l.finish);
      window.removeEventListener("pointercancel", l.finish);
      window.removeEventListener("blur", l.finish);
      document.removeEventListener("selectstart", l.select, true);
      listenersRef.current = null;
    }
    pointerRef.current = null;
    dropHintRef.current = null;
    setDragging(null);
    setDropHint(null);
    document.body.classList.remove("is-dragging-file");
    document.body.style.userSelect = "";
  }

  /**
   * 光标位置 → 落点。命中测试走 elementFromPoint（行上都有 title=path）：
   *   章行 → 按矩形中线插到前面/后面；
   *   普通目录行 → 整体移入该目录；卷行 → 上/下边缘插到这一卷前/后（夹层），中间仍是移入；
   *   两行之间的缝隙（如果有） → 就近吸附到章行 / 卷行；
   *   树内空白（含底部 tree-blank） → 回工作区根目录；
   *   指针跑到树外（编辑器等） → null，等于取消，跟原来拖到树外松手一样。
   */

  /**
   * 拖动落点落在行间缝里时：向上/下就近吸附到一条章行或卷行。
   * 卷行也算落点，是松散章插进两卷之间（夹层）的入口 —— 缝隙正好在两段子树中间。
   */
  function nearestRow(y: number, src: string): DropHint | null {
    let best: { row: HTMLElement; dy: number; rank: number } | null = null;
    for (const r of Array.from(document.querySelectorAll<HTMLElement>(".tree .tree-row[title]"))) {
      const path = r.getAttribute("title") ?? "";
      if (!path || path === src) continue;
      // 卷行认，其它目录行与纲要行不认（它们只做「整体移入」）
      const isVol = r.classList.contains("tree-volume");
      if (!isVol && (r.classList.contains("tree-dir") || !isChapterFile(path))) continue;
      const rect = r.getBoundingClientRect();
      const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
      if (dy > 48) continue;
      // 一样近时章行优先：卷行正下方就是它自己的第一章，那一格缝隙仍该按章行算
      // （= 移进卷里），否则「夹层」会把紧挨着的这一格抢过去。
      const rank = isVol ? 1 : 0;
      if (!best || dy < best.dy || (dy === best.dy && rank < best.rank)) {
        best = { row: r, dy, rank };
      }
    }
    if (!best) return null;
    const rect = best.row.getBoundingClientRect();
    return {
      kind: y < rect.top + rect.height / 2 ? "before" : "after",
      path: best.row.getAttribute("title") as string,
    };
  }

  function hintAtPoint(x: number, y: number, src: string): DropHint | null {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    if (!el || !el.closest(".tree")) return null;
    // 「回工作区根」只认两处：顶部投放带、底部空白区；行与行之间的窄缝不算
    if (el.closest(".tree-root-drop") || el.closest(".tree-blank")) {
      return { kind: "into", dir: "" };
    }
    const row = el.closest(".tree-row[title]") as HTMLElement | null;
    if (!row) {
      // 落在两行之间的缝里：吸附到最近的一条章行 / 卷行，别把章甩到工作区根
      return nearestRow(y, src) ?? { kind: "into", dir: "" };
    }
    const path = row.getAttribute("title") ?? "";
    if (!path) return { kind: "into", dir: "" };
    if (row.classList.contains("tree-dir")) {
      /*
       * 卷行的上/下边缘 = 插到这一卷的前/后，中间那条带仍是「整体移入这一卷」。
       * 行是紧挨着排的，「行间缝隙」根本命中不到，所以夹层只能长在卷行自己的边缘上：
       * 想把松散章夹进「第一卷」与「第二卷」之间，就落到第二卷的上边缘。
       *
       * 源章已经在这个卷里时不提供插到卷前的落点（整行照旧是移入）：否则在卷内
       * 拖章时蹭到卷行上沿，会把章甩到卷外，那不是这一下想干的事。
       */
      const inVol = row.classList.contains("tree-volume") && !src.startsWith(path + "/");
      if (inVol) {
        const rect = row.getBoundingClientRect();
        const frac = (y - rect.top) / Math.max(1, rect.height);
        if (frac < DROP_EDGE_RATIO) return { kind: "before", path };
        if (frac > 1 - DROP_EDGE_RATIO) return { kind: "after", path };
      }
      return { kind: "into", dir: path };
    }
    // 停在被拖的那一行自己身上：不算落点（否则会被挪到目录末尾）
    if (path === src) return null;
    // 非章的纲要文件行：把它所在目录当落点，不做章节插入线
    if (!isChapterFile(path)) return { kind: "into", dir: dirName(path) };
    const rect = row.getBoundingClientRect();
    return { kind: y < rect.top + rect.height / 2 ? "before" : "after", path };
  }

  /** 松手：按落点执行真实的移动/排序（moveChapterToDir 本身没变） */
  function dropAt(hint: DropHint | null, src: string) {
    if (!hint) return;
    if (hint.kind === "into") {
      void moveChapterToDir(src, hint.dir, null, "before");
      return;
    }
    if (hint.path === src) return;
    void moveChapterToDir(src, dirName(hint.path), hint.path, hint.kind);
  }

  /**
   * 章行按下左键：先只「记下起点」，位移过了阈值才真的进入拖动。
   * 没过阈值就松手 = 一次普通点击，onClick → openFile 照常走。
   */
  function onChapterPointerDown(e: ReactPointerEvent, node: FileNode) {
    if (e.button !== 0 || !e.isPrimary) return; // 只认左键 / 主指针
    if (!isChapterFile(node.path)) return;
    if (pointerRef.current) return; // 上一次拖动还没收尾
    // 行内改名时点的是输入框：那是选字/移光标，不是拖章
    const target = e.target as HTMLElement | null;
    if (target?.closest("input, textarea, [contenteditable='true']")) return;

    const state = { src: node.path, x: e.clientX, y: e.clientY, dragging: false };
    pointerRef.current = state;

    // 算一次落点要走 elementFromPoint（必要时还要逐行 getBoundingClientRect），
    // 比指针事件本身慢得多，鼠标一快就是每个事件整树量一遍。
    // 按帧合并：一帧最多算一次落点，指针停下来时看到的还是最后那个位置。
    let queuedX = 0;
    let queuedY = 0;
    let frame = 0;
    const flushHint = () => {
      frame = 0;
      const cur = pointerRef.current;
      if (cur) applyHint(hintAtPoint(queuedX, queuedY, cur.src));
    };

    const move = (ev: PointerEvent) => {
      const cur = pointerRef.current;
      if (!cur) return;
      if (!cur.dragging) {
        const dx = ev.clientX - cur.x;
        const dy = ev.clientY - cur.y;
        if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
        cur.dragging = true;
        // 光标皮肤：整窗「抓取」由 body.is-dragging-file 的 CSS 决定，不依赖 dataTransfer
        document.body.classList.add("is-dragging-file");
        // 拖动期间不许顺手选中文本（行本身已 user-select:none，这里连树外一起压住）
        document.body.style.userSelect = "none";
        window.getSelection()?.removeAllRanges();
        setDragging(cur.src);
        applyHint(null);
      }
      // 拖动中光标可能落在任何元素上：拦掉默认行为，WebKit 才不会一路拉出选区。
      // 这一句必须当场调，挪进 rAF 就晚了。
      ev.preventDefault();
      queuedX = ev.clientX;
      queuedY = ev.clientY;
      if (!frame) frame = requestAnimationFrame(flushHint);
    };

    /** pointerup 是「落下去」，pointercancel / blur 只收尾不移动 */
    const finish = (ev: Event) => {
      // 松手前先补上还没算的那一帧，否则读到的落点是上一次的位置
      if (frame) {
        cancelAnimationFrame(frame);
        flushHint();
      }
      const cur = pointerRef.current;
      const hint = dropHintRef.current;
      resetDrag();
      if (!cur || !cur.dragging) return; // 没真的拖过：放行这次 click
      suppressClick.current = Date.now(); // 真的拖过了：吞掉随后那一下 click
      if (ev.type !== "pointerup") return;
      dropAt(hint, cur.src);
    };

    /** 按住期间禁止选中（只挡选择，不碰 click） */
    const select = (ev: Event) => {
      if (pointerRef.current) ev.preventDefault();
    };

    listenersRef.current = { move, finish, select };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    // 窗口失焦（比如 Alt+Tab / 拖出窗口后松手）也要收尾，否则拖动状态会粘住
    window.addEventListener("blur", finish);
    document.addEventListener("selectstart", select, true);
  }

  const blankDropActive =
    dragging !== null && dropHint !== null && dropHint.kind === "into" && dropHint.dir === "";

  return (
    <div className="tree" onContextMenu={onBlankContextMenu}>
      {tree.length === 0 && (
        <div className="tree-empty">空工作区 · 右键可新建章节 / 文件 / 文件夹 / 卷</div>
      )}
      {/* 拖到这条窄带 = 移回工作区根；根下的文件就显示在它下面 */}
      <div className={"tree-root-drop" + (blankDropActive ? " tree-drop-into" : "")} />
      {tree
        .slice()
        .sort((a, b) => compareTreeNodes(a, b, volumeSet, chapterOrder, true))
        .map((n) => (
        <TreeNode
          key={n.path}
          node={n}
          depth={0}
          expanded={expanded}
          toggleExpand={toggleExpand}
          openFile={handleOpenFile}
          activePath={activePath}
          words={words}
          volumeCounts={volumeCounts}
          onContextMenu={onNodeContextMenu}
          edit={edit}
          volumeSet={volumeSet}
          chapterOrder={chapterOrder}
          dragging={dragging}
          dropHint={dropHint}
          flipped={false}
          flippedBooks={flippedBookSet}
          onChapterPointerDown={onChapterPointerDown}
        />
      ))}
      {/*
        铺满剩余高度的空白区：既保证下方空白能右键，也是拖回工作区根时的落点。
        落点判定不用它自己的事件，而是拖动时 elementFromPoint 命中到这里（指针事件方案）。
      */}
      <div className={"tree-blank" + (blankDropActive ? " tree-drop-into" : "")} />

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems()}
          onClose={() => setMenu(null)}
        />
      )}

      {deleting && (
        <DeleteDialog
          path={deleting.path}
          isDir={deleting.isDir}
          error={dialogError}
          busy={busy}
          onConfirm={() => void confirmDelete()}
          onClose={() => {
            if (!busy) {
              setDialogError("");
              setDeleting(null);
            }
          }}
        />
      )}
    </div>
  );

  /** 让某一行进入改名状态（重命名、以及新建之后立刻改名） */
  function startEdit(next: { path: string; value: string; isDir: boolean; autoMd: boolean }) {
    editDone.current = false;
    setEditing(next);
  }

  function cancelEdit() {
    editDone.current = true;
    setEditing(null);
  }

  /**
   * 添加章节：不等对话框，直接建好并打开，然后把树里那一行切成输入框 —— 名字就在原地改。
   * 默认名接着目录里最后一章排（第二章 → 第三章）；不是「第X章」风格就是 Untitled。
   */
  async function quickCreateChapter(dir: string): Promise<void> {
    const st = useStore.getState();
    const r = st.root;
    if (!r) return;
    const base = freeName(dir, defaultChapterName(dir), ".md");
    const rel = dir ? `${dir}/${base}.md` : `${base}.md`;
    setBusy(true);
    try {
      // 新建的章是空白正文：章节名由文件名管理，正文里不再生成 `# 标题`
      await api.createFile(r, rel, "");
      if (dir) useStore.getState().ensureExpanded(dir);
      await useStore.getState().refresh();
      await useStore.getState().openFile(rel);
      startEdit({ path: rel, value: base, isDir: false, autoMd: true });
      useStore.getState().setStatus(`已新建 ${rel}`);
    } catch (e) {
      useStore.getState().setStatus(`新建失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  /** 新建文件：立即创建 Untitled.md，然后该行进入行内改名 */
  async function quickCreateFile(dir: string): Promise<void> {
    const st = useStore.getState();
    const r = st.root;
    if (!r) return;
    const base = freeName(dir, DEFAULT_NEW_NAME, ".md");
    const rel = dir ? `${dir}/${base}.md` : `${base}.md`;
    setBusy(true);
    try {
      // 新建的章是空白正文：章节名由文件名管理，正文里不再生成 `# 标题`
      await api.createFile(r, rel, "");
      if (dir) useStore.getState().ensureExpanded(dir);
      await useStore.getState().refresh();
      await useStore.getState().openFile(rel);
      startEdit({ path: rel, value: base, isDir: false, autoMd: true });
      useStore.getState().setStatus(`已新建 ${rel}`);
    } catch (e) {
      useStore.getState().setStatus(`新建失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  /** 新建文件夹：立即创建 Untitled 目录，然后该行进入行内改名 */
  async function quickCreateFolder(dir: string): Promise<void> {
    const st = useStore.getState();
    const r = st.root;
    if (!r) return;
    const base = freeName(dir, DEFAULT_NEW_NAME, "");
    const rel = dir ? `${dir}/${base}` : base;
    setBusy(true);
    try {
      await api.createDir(r, rel);
      // 顶层文件夹就是一本「书」：立刻建书级总纲 outline/总纲.md
      if (dir === "") {
        try {
          await api.createFile(r, bookOutlinePath(rel), `# ${base}\n\n`);
        } catch (e) {
          useStore.getState().setStatus(`总纲创建失败：${String(e)}`);
        }
      }
      if (dir) useStore.getState().ensureExpanded(dir);
      await useStore.getState().refresh();
      startEdit({ path: rel, value: base, isDir: true, autoMd: false });
      useStore.getState().setStatus(`已新建 ${rel}`);
    } catch (e) {
      useStore.getState().setStatus(`新建失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  /** 新建书：创建顶层书文件夹 + 立即建 outline/总纲.md，然后该行进入行内改名 */
  async function quickCreateBook(): Promise<void> {
    const r = useStore.getState().root;
    if (!r) return;
    const base = freeName("", DEFAULT_BOOK_NAME, "");
    setBusy(true);
    try {
      await api.createDir(r, base);
      await api.createFile(r, bookOutlinePath(base), `# ${base}\n\n`);
      await useStore.getState().refresh();
      startEdit({ path: base, value: base, isDir: true, autoMd: false });
      useStore.getState().setStatus(`已新建书 ${base}`);
    } catch (e) {
      useStore.getState().setStatus(`新建失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  /** 新建卷：立即创建「新建卷」目录并登记进卷注册表，同时建卷纲，然后行内改名 */
  async function quickCreateVolume(dir: string): Promise<void> {
    const st = useStore.getState();
    const r = st.root;
    if (!r) return;
    const base = freeName(dir, DEFAULT_VOLUME_NAME, "");
    const rel = dir ? `${dir}/${base}` : base;
    setBusy(true);
    try {
      await api.createDir(r, rel);
      await useStore.getState().setVolumes([...useStore.getState().volumes, rel]);
      // 卷纲：默认名取卷目录名，落在书目录的 outline/ 下（改名时会在 commitEdit 里跟着改）
      try {
        const book = bookScopeOf(rel, new Set(useStore.getState().volumes));
        await createOutlineFile(book, base, `# ${base}\n\n`);
      } catch (e) {
        useStore.getState().setStatus(`卷纲创建失败：${String(e)}`);
      }
      if (dir) useStore.getState().ensureExpanded(dir);
      await useStore.getState().refresh();
      // 这本书的顺序表登记过卷（夹层模式）时，把新卷插回卷堆里，
      // 否则它会掉到表尾的松散章下面（见 order.ts 的 placeVolumeInOrder）
      const parentList = useStore.getState().chapterOrder[dir];
      if (parentList) {
        const next = placeVolumeInOrder(parentList, base);
        if (next.join("\u0000") !== parentList.join("\u0000")) {
          await useStore.getState().applyChapterOrder({ [dir]: next });
        }
      }
      startEdit({ path: rel, value: base, isDir: true, autoMd: false });
      useStore.getState().setStatus(`已新建卷 ${rel}`);
    } catch (e) {
      useStore.getState().setStatus(`新建失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  /** 右键章节 → 新建章节纲要：默认名 = 章节文件名，落在这本书的 outline/ 下 */
  async function quickCreateChapterOutline(chapterPath: string): Promise<void> {
    const r = useStore.getState().root;
    if (!r) return;
    const book = bookScopeOf(chapterPath, volumeSet);
    // 不属于任何书文件夹的章（散在根目录 / 根级卷里）没有纲要可建
    if (!book) {
      useStore.getState().setStatus("这个章不在任何书文件夹里，没有对应的纲要位置");
      return;
    }
    const stem = basename(chapterPath).replace(/\.md$/i, "");
    setBusy(true);
    try {
      const rel = await createOutlineFile(book, stem);
      await useStore.getState().refresh();
      await useStore.getState().openFile(rel);
      useStore.getState().setStatus(`已新建章节纲要 ${rel}`);
    } catch (e) {
      useStore.getState().setStatus(`新建失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  /**
   * 拖动章：同目录 = 调顺序；跨目录 = api.renameEntry 移动文件并更新两侧章顺序。
   * 卷注册表不受章移动影响（章不是卷）。
   */
  async function moveChapterToDir(
    srcPath: string,
    targetDir: string,
    beforeChapter: string | null,
    where: "before" | "after",
  ): Promise<void> {
    const st = useStore.getState();
    const r = st.root;
    if (!r) return;
    const srcDir = dirName(srcPath);
    const name = basename(srcPath);
    /*
     * 「反转显示」的书里，行是倒着画的，但顺序侧车仍是正着的：
     * 界面上「插到第二章前面」在侧车里其实是「插到第二章后面」，方向得翻一次。
     */
    const flippedDir = isDisplayFlipped(targetDir, new Set(st.flippedBooks));
    const dirWhere: "before" | "after" = flippedDir
      ? where === "before"
        ? "after"
        : "before"
      : where;

    // 同目录：只改顺序，不碰文件系统
    if (srcDir === targetDir) {
      const rest = childList(targetDir).filter((n) => n !== name);
      const idx = beforeChapter ? rest.indexOf(basename(beforeChapter)) : -1;
      if (idx < 0) rest.push(name);
      else rest.splice(dirWhere === "after" ? idx + 1 : idx, 0, name);
      await applyChapterOrder({ [targetDir]: rest });
      return;
    }

    // 目标目录重名时自动加序号
    let finalName = name;
    const targetPath = (n: string) => (targetDir ? `${targetDir}/${n}` : n);
    if (st.files.includes(targetPath(name))) {
      const stem = name.replace(/\.md$/i, "");
      for (let i = 2; i < 500; i++) {
        const cand = `${stem} ${i}.md`;
        if (!st.files.includes(targetPath(cand))) {
          finalName = cand;
          break;
        }
      }
    }
    const newPath = targetPath(finalName);

    setBusy(true);
    try {
      if (st.dirty.has(srcPath)) await st.saveFile(srcPath);
      await flushWrites([srcPath]);
      const unlock = lockPaths([srcPath]);
      try {
        await api.renameEntry(r, srcPath, newPath);
      } finally {
        unlock();
      }
      const wasOpen = st.openTabs.includes(srcPath);
      const wasActive = st.activePath === srcPath;
      const prevActive = st.activePath;
      useStore.getState().forgetPaths([srcPath]);

      const patch: Record<string, string[]> = {};
      patch[srcDir] = childList(srcDir).filter((n) => n !== name);
      const tgtList = childList(targetDir).filter((n) => n !== finalName);
      let idx = beforeChapter ? tgtList.indexOf(basename(beforeChapter)) : -1;
      if (idx < 0) tgtList.push(finalName);
      else tgtList.splice(dirWhere === "after" ? idx + 1 : idx, 0, finalName);
      patch[targetDir] = tgtList;
      await useStore.getState().applyChapterOrder(patch);

      await useStore.getState().refresh();
      if (targetDir) useStore.getState().ensureExpanded(targetDir);
      if (wasOpen) await useStore.getState().openFile(newPath);
      if (wasOpen && !wasActive && prevActive) useStore.getState().setActive(prevActive);
      useStore.getState().setStatus(`已移动到 ${newPath}`);
    } catch (err) {
      useStore.getState().setStatus(`移动失败：${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  /**
   * 提交行内改名。名字没变、名字非法、同名冲突都只是退回原名，
   * 不会留下半改动状态。目录改名会同步卷注册表与章顺序的 key。
   */
  async function commitEdit(): Promise<void> {
    if (editDone.current) return;
    const e = editing;
    editDone.current = true;
    // 不管后面成不成功，先把编辑态收掉：否则输入框会一直挂在那里变成空名字
    setEditing(null);
    if (!e) return;
    const value = e.value.trim();
    if (!value) {
      // 没输入就点别处 = 放弃改名，保持上一次的名字
      useStore.getState().setStatus(`名字为空，保持原名 ${basename(e.path)}`);
      return;
    }
    const nameError = validateEntryName(value);
    if (nameError) {
      useStore.getState().setStatus(nameError);
      return;
    }
    const clean = sanitizeFileName(value);
    const finalName = !e.isDir && e.autoMd && !/\.[^./]+$/.test(clean) ? clean + ".md" : clean;
    const dir = dirName(e.path);
    const newPath = dir ? `${dir}/${finalName}` : finalName;
    if (newPath === e.path) return;

    const st = useStore.getState();
    const r = st.root;
    if (!r) return;
    if (st.files.includes(newPath) || findNode(st.tree, newPath)) {
      useStore.getState().setStatus(`已存在同名项：${finalName}`);
      return;
    }
    setBusy(true);
    try {
      // 未保存的改动先写盘，否则改完名那份内容就找不回来了
      if (!e.isDir && st.dirty.has(e.path)) await st.saveFile(e.path);
      // 改名之后旧的写入队列不能再往原路径写，否则会把旧文件复活
      await flushWrites([e.path]);
      const unlock = lockPaths([e.path]);
      try {
        await api.renameEntry(r, e.path, newPath);
      } finally {
        unlock();
      }

      // —— 同步卷注册表与章顺序 ——
      if (e.isDir) {
        const vols = useStore.getState().volumes;
        const affected = vols.filter((p) => p === e.path || p.startsWith(e.path + "/"));
        const wasNameVolume = isVolumeDirectoryName(basename(e.path));
        if (affected.length || wasNameVolume) {
          const next = vols.map((p) =>
            p === e.path ? newPath : p.startsWith(e.path + "/") ? newPath + p.slice(e.path.length) : p,
          );
          // 原来按名字识别的卷（未登记）改名后要补登记，保证改成「风起」也仍是卷
          if (wasNameVolume && !next.includes(newPath)) next.push(newPath);
          await useStore.getState().setVolumes(next);
        }
        const patch: Record<string, string[]> = {};
        for (const [d, list] of Object.entries(useStore.getState().chapterOrder)) {
          if (d === e.path) {
            patch[d] = [];
            patch[newPath] = list;
          } else if (d.startsWith(e.path + "/")) {
            patch[d] = [];
            patch[newPath + d.slice(e.path.length)] = list;
          }
        }
        // 父目录的直接子项列表里记着的是子目录名（卷名），也要跟着改名，
        // 否则「松散章夹在卷之间」那份混合顺序会指向一个不存在的卷名
        const parentDir = dirName(e.path);
        const parentList = useStore.getState().chapterOrder[parentDir];
        if (parentList && parentList.includes(basename(e.path))) {
          const renamed = parentList.map((n) =>
            n === basename(e.path) ? basename(newPath) : n,
          );
          // 改的新名字带卷号时按卷号摆回卷堆里（改号 = 换位置）；
          // 不带卷号（「风起」这类）就留在原地，免得把它和相邻松散章的夹层搅乱
          patch[parentDir] =
            extractVolumeNumber(basename(newPath)) !== null
              ? placeVolumeInOrder(renamed, basename(newPath))
              : renamed;
        }
        if (Object.keys(patch).length) await useStore.getState().applyChapterOrder(patch);
      } else if (isChapterFile(e.path) || isChapterFile(newPath)) {
        const list = useStore.getState().chapterOrder[dir];
        if (list && list.includes(basename(e.path))) {
          await useStore.getState().applyChapterOrder({
            [dir]: list.map((n) => (n === basename(e.path) ? basename(newPath) : n)),
          });
        }
      }

      // 纲要跟着实体改名：卷目录/章节改名时，把 outline/<旧名>.md 一并改成新名。
      // 总纲名固定（总纲.md），书目录改名时整份 outline/ 随目录一起移动，无需特殊处理。
      {
        const stem = (p: string) => (e.isDir ? basename(p) : basename(p).replace(/\.md$/i, ""));
        const oldBase = stem(e.path);
        const newBase = stem(newPath);
        if (oldBase !== newBase) {
          const filesNow = useStore.getState().files;
          const volSetNow = new Set(useStore.getState().volumes);
          const dirOf = (book: string) => (book ? `${book}/${OUTLINE_DIR}` : OUTLINE_DIR);
          const oldOutline = `${dirOf(bookScopeOf(e.path, volSetNow))}/${oldBase}.md`;
          if (filesNow.includes(oldOutline)) {
            const newOutline = `${dirOf(bookScopeOf(newPath, volSetNow))}/${newBase}.md`;
            if (!filesNow.includes(newOutline)) {
              try {
                await api.renameEntry(r, oldOutline, newOutline);
              } catch {
                /* 纲要跟改失败不影响主体改名 */
              }
            }
          }
        }
      }

      const wasOpen = !e.isDir && st.openTabs.includes(e.path);
      const wasActive = st.activePath === e.path;
      const prevActive = st.activePath;
      const prefix = `${e.path}/`;
      const stale = e.isDir
        ? [e.path, ...useStore.getState().openTabs.filter((t) => t.startsWith(prefix))]
        : [e.path];
      useStore.getState().forgetPaths(stale);
      await useStore.getState().refresh();
      if (wasOpen) await useStore.getState().openFile(newPath);
      if (wasOpen && !wasActive && prevActive) useStore.getState().setActive(prevActive);
      useStore.getState().setStatus(`已重命名为 ${newPath}`);
    } catch (err) {
      useStore.getState().setStatus(`重命名失败：${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  /**
   * 删除：先锁路径（阻止删除期间新入队的保存），再等在途写盘结束，
   * 然后才真正删除；成功后清理 tab/内容/dirty，并同步卷注册表与章顺序。
   *
   * 纲要挂在书目录的 outline/ 下，不在被删章/卷的子树里，所以要**显式跟着删**：
   * 否则 outline/ 里会留下对不上任何章的孤儿（删掉章之后它还在大纲页里列着）。
   */
  async function confirmDelete(): Promise<void> {
    const st = useStore.getState();
    const r = st.root;
    if (!deleting || !r) return;
    const target = deleting.path;
    setBusy(true);
    setDialogError("");
    const outlineExtras = outlinesRemovedWith(target, st.files, new Set(st.volumes));
    const unlock = lockPaths([target, ...outlineExtras]);
    try {
      await flushWrites([target, ...outlineExtras]);
      await api.deleteEntry(r, target);
      const failedOutlines: string[] = [];
      for (const p of outlineExtras) {
        try {
          await api.deleteEntry(r, p);
        } catch (e) {
          // 纲要删不掉不该让整次删除失败（章本身已经删了），但要如实报出来
          failedOutlines.push(p);
          console.error(`删除纲要失败 ${p}`, e);
        }
      }
      useStore.getState().forgetPaths([target, ...outlineExtras]);

      if (deleting.isDir) {
        const vols = useStore.getState().volumes.filter(
          (p) => p !== target && !p.startsWith(target + "/"),
        );
        if (vols.length !== useStore.getState().volumes.length) {
          await useStore.getState().setVolumes(vols);
        }
        const patch: Record<string, string[]> = {};
        for (const d of Object.keys(useStore.getState().chapterOrder)) {
          if (d === target || d.startsWith(target + "/")) patch[d] = [];
        }
        // 父目录的直接子项列表里别留下这个名字（删掉的卷/目录已经不在了）
        const parentDir = dirName(target);
        const parentList = useStore.getState().chapterOrder[parentDir];
        if (parentList && parentList.includes(basename(target))) {
          patch[parentDir] = parentList.filter((n) => n !== basename(target));
        }
        if (Object.keys(patch).length) await useStore.getState().applyChapterOrder(patch);
      } else {
        const list = useStore.getState().chapterOrder[dirName(target)];
        if (list && list.includes(basename(target))) {
          await useStore.getState().applyChapterOrder({
            [dirName(target)]: list.filter((n) => n !== basename(target)),
          });
        }
      }

      await useStore.getState().refresh();
      const removedOutlines = outlineExtras.length - failedOutlines.length;
      useStore.getState().setStatus(
        failedOutlines.length
          ? `已删除 ${target}；但 ${failedOutlines.length} 份纲要没删掉：${failedOutlines.join("、")}`
          : removedOutlines
            ? `已删除 ${target}（连带 ${removedOutlines} 份纲要）`
            : `已删除 ${target}`,
      );
      setDeleting(null);
    } catch (e) {
      setDialogError(`删除失败：${String(e)}`);
    } finally {
      unlock();
      setBusy(false);
    }
  }
});

interface NodeProps {
  node: FileNode;
  depth: number;
  expanded: Set<string>;
  toggleExpand: (p: string) => void;
  openFile: (p: string) => void;
  activePath: string | null;
  words: Map<string, number>;
  /** 卷目录 → 章节数（卷行右侧的小徽标） */
  volumeCounts: Map<string, number>;
  onContextMenu: (e: ReactMouseEvent, node: FileNode) => void;
  /** 行内改名：哪一行正在改名、怎么提交 */
  edit: EditApi;
  volumeSet: ReadonlySet<string>;
  chapterOrder: Record<string, string[]>;
  dragging: string | null;
  dropHint: DropHint | null;
  /**
   * 这一层是不是「反转显示」：书被右键反转后，它的整棵子树每层兄弟列表都倒过来画。
   * 只影响显示，不影响顺序侧车与导出（见 lib/order.ts 顶部说明）。
   */
  flipped: boolean;
  /** 被反转显示的书（顶层目录路径）；节点靠它判断自己是不是那本书 */
  flippedBooks: ReadonlySet<string>;
  /** 章行按下左键 → 指针拖动（自实现，见 onChapterPointerDown） */
  onChapterPointerDown: (e: ReactPointerEvent, node: FileNode) => void;
}

function TreeNode({
  node,
  depth,
  expanded,
  toggleExpand,
  openFile,
  activePath,
  words,
  volumeCounts,
  onContextMenu,
  edit,
  volumeSet,
  chapterOrder,
  dragging,
  dropHint,
  flipped,
  flippedBooks,
  onChapterPointerDown,
}: NodeProps) {
  const isOpen = expanded.has(node.path);
  const pad = 8 + depth * 12;

  // 纲要（outline/ 文件夹、以及旧式 书/总纲.md）不在文件树里露面：
  // 它们是创作辅助文档，统一在左侧「大纲」页里按 总纲 → 卷纲 → 章节纲要 排列编辑。
  if (isOutlineFile(node.path)) return null;

  if (node.is_dir) {
    // 卷 = 目录名匹配「第X卷 / 卷X / Volume N」或登记在卷注册表里
    const isVolume = isVolumeDir(node.name, node.path, volumeSet);
    const chapterCount = volumeCounts.get(node.path) ?? 0;
    const children = node.children
      .slice()
      .sort((a, b) => compareTreeNodes(a, b, volumeSet, chapterOrder));
    // 自己这本书被反转了 → 这一层连同以下每一层都倒过来画（顺序侧车不动）
    const childFlipped = flipped || flippedBooks.has(node.path);
    if (childFlipped) children.reverse();
    const childProps = {
      depth: depth + 1,
      expanded,
      toggleExpand,
      openFile,
      activePath,
      words,
      volumeCounts,
      onContextMenu,
      edit,
      volumeSet,
      chapterOrder,
      dragging,
      dropHint,
      flipped: childFlipped,
      flippedBooks,
      onChapterPointerDown,
    };
    const childNodes = children.map((c) => (
      <TreeNode key={c.path} node={c} {...childProps} />
    ));
    const dropInto =
      dragging !== null && dropHint !== null && dropHint.kind === "into" && dropHint.dir === node.path;
    // 卷行也能收「插到这一卷前面/后面」：把松散章夹进两卷之间时画的就是这条线。
    // 只有卷行会收到这种落点（命中测试里目录行一律是「整体移入」）
    const dirBefore =
      dragging !== null && dropHint !== null && dropHint.kind === "before" && dropHint.path === node.path;
    const dirAfter =
      dragging !== null && dropHint !== null && dropHint.kind === "after" && dropHint.path === node.path;
    return (
      <div>
        <div
          className={
            "tree-row tree-dir" +
            (isVolume ? " tree-volume" : "") +
            (dirBefore ? " tree-drop-before" : "") +
            (dirAfter ? " tree-drop-after" : "") +
            (dropInto ? " tree-drop-into" : "")
          }
          style={{ paddingLeft: pad }}
          onClick={() => toggleExpand(node.path)}
          onContextMenu={(e) => onContextMenu(e, node)}
          title={node.path}
        >
          <span className={"twisty " + (isOpen ? "open" : "")} />
          <span className="tree-icon">{isVolume ? "📚" : "📁"}</span>
          {edit.editing?.path === node.path ? (
            <RenameInput edit={edit} />
          ) : (
            <span className="tree-name">{node.name}</span>
          )}
          {isVolume && chapterCount > 0 && (
            <span className="tree-volume-count" title={`该卷有 ${chapterCount} 章`}>
              {chapterCount} 章
            </span>
          )}
        </div>
        {isOpen &&
          (isVolume ? (
            <div className="tree-volume-block">
              {/* 纯视觉的细竖线：pointer-events:none，不影响点击/右键 */}
              <span className="tree-volume-rail" style={{ left: pad + 8 }} aria-hidden="true" />
              {childNodes}
            </div>
          ) : (
            childNodes
          ))}
      </div>
    );
  }

  const w = words.get(node.path);
  // 纲要行在上面就已经 return null 了，走到这里的都是正文/资料文件
  const isChapter = isChapterFile(node.path);
  const before =
    dragging !== null && dropHint !== null && dropHint.kind === "before" && dropHint.path === node.path;
  const after =
    dragging !== null && dropHint !== null && dropHint.kind === "after" && dropHint.path === node.path;
  return (
    <div
      className={
        "tree-row tree-file " +
        (activePath === node.path ? "active" : "") +
        (before ? "tree-drop-before " : "") +
        (after ? "tree-drop-after " : "") +
        (dragging === node.path ? "dragging " : "")
      }
      onClick={() => openFile(node.path)}
      onContextMenu={(e) => onContextMenu(e, node)}
      title={node.path}
    >
      {/*
       * 拖动区 = 章名左边那一整块（缩进 + 抓手 + 图标），含最左侧缩进，
       * 整块都是抓取光标；章名及其右侧是普通点击区，保持默认箭头。
       */}
      <span
        className={"tree-dragzone" + (isChapter ? "" : " tree-dragzone-off")}
        /* +4：抵消章行自己去掉的 4px 左边距，缩进后内容仍与目录行对齐 */
        style={{ paddingLeft: pad + 4 }}
        title={isChapter ? "按住拖动排序" : undefined}
        onPointerDown={isChapter ? (e) => onChapterPointerDown(e, node) : undefined}
        onClick={isChapter ? (e) => e.stopPropagation() : undefined}
      >
        <span className="twisty twisty-spacer" />
        <span className="tree-icon">📄</span>
      </span>
      {edit.editing?.path === node.path ? (
        <RenameInput edit={edit} />
      ) : (
        <span className="tree-name">{node.name.replace(/\.md$/, "")}</span>
      )}
      {w !== undefined && w > 0 && <span className="tree-words">{w}</span>}
    </div>
  );
}

function findNode(nodes: FileNode[], path: string): FileNode | null {
  for (const n of nodes) {
    if (n.path === path) return n;
    const hit = findNode(n.children, path);
    if (hit) return hit;
  }
  return null;
}

function DeleteDialog({
  path,
  isDir,
  error,
  busy,
  onConfirm,
  onClose,
}: {
  path: string;
  isDir: boolean;
  error?: string;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [busy, onClose]);

  // 删除会导致这些未保存修改一起消失，必须明确提示
  const dirtyCount = useStore((s) =>
    Array.from(s.dirty).filter((p) => p === path || p.startsWith(path + "/")).length,
  );
  const chapterCount = useStore((s) =>
    isDir ? s.files.filter((p) => p.startsWith(path + "/")).length : 0,
  );
  // 纲要不在被删项的子树里（都在 书/outline/ 下），所以要单独列出来，别让它们悄悄消失
  const files = useStore((s) => s.files);
  const volumes = useStore((s) => s.volumes);
  const outlines = useMemo(
    () => outlinesRemovedWith(path, files, new Set(volumes)),
    [path, files, volumes],
  );
  return (
    <div
      className="modal-mask"
      role="dialog"
      aria-modal="true"
      onMouseDown={() => {
        if (!busy) onClose();
      }}
    >
      <ModalStage>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">确认删除{isDir ? "文件夹" : "文件"}？</div>
        <div className="modal-quote">{path}</div>
        {error && (
          <div
            style={{
              color: "var(--danger, #f38ba8)",
              margin: "8px 0",
              fontSize: 13,
              lineHeight: 1.4,
            }}
          >
            {error}
          </div>
        )}
        <div className="panel-empty" style={{ textAlign: "left", padding: "10px 0" }}>
          {isDir && chapterCount > 0 && (
            <div>该文件夹内有 {chapterCount} 个文件，将一并删除。</div>
          )}
          {outlines.length > 0 && (
            <div>
              对应的 {outlines.length} 份纲要也会一并删除：{outlines.join("、")}
            </div>
          )}
          <div>删除不可撤销，磁盘上的文件会被直接移除。</div>
          {dirtyCount > 0 && (
            <div style={{ color: "var(--danger)" }}>
              其中 {dirtyCount} 个文件有未保存修改，删除后这些修改也会丢失。
            </div>
          )}
        </div>
        <div className="modal-actions">
          <button className="btn" autoFocus onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="btn danger" onClick={onConfirm} disabled={busy}>
            {busy ? "删除中…" : "删除"}
          </button>
        </div>
      </div>
      </ModalStage>
    </div>
  );
}

/** 树里的行内改名输入框：Enter 提交、Esc 取消、点别处也算提交 */
function RenameInput({ edit }: { edit: EditApi }) {
  return (
    <input
      className="tree-rename"
      value={edit.editing?.value ?? ""}
      autoFocus
      spellCheck={false}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => edit.onChange(e.target.value)}
      onBlur={() => edit.onCommit()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          edit.onCommit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          edit.onCancel();
        }
      }}
    />
  );
}
