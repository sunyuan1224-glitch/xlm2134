/*
 * 应用外壳：Typora 式「顶部菜单栏 + 左侧文件/大纲/搜索 + 居中正文」。
 *
 * 面向小说写作：正文只保留真正会用的格式（加粗/斜体/下划线/删除线/链接/引用/列表），
 * 公式、表格、代码高亮、脚注、任务框、多级标题等通用编辑器功能已按需精简掉。
 *
 * 版式要点：
 *  - 顶部是菜单栏（文件/编辑/段落/格式/视图/主题/帮助）；
 *  - 左侧栏是「文件 / 大纲」两个标签：「大纲」标签是工作区的纲要导航树
 *    （书 → 卷 → 章），点一行在正文区打开编辑；
 *  - 源码模式、专注模式、打字机模式、浮动工具栏、沉浸写作。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EditorView } from "@codemirror/view";
import { undo, redo } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useStore } from "./store";
import { api, isDesktop } from "./api";
import { TabBar } from "./components/TabBar";
import { StatusBar } from "./components/StatusBar";
import { Editor } from "./editor/Editor";
import { PaperCompanion } from "./components/PaperCompanion";
import { splitCurrent, createNextChapter } from "./lib/chapterOps";
import { ImmersiveEditor } from "./components/ImmersiveEditor";
import { ContextMenu } from "./components/ContextMenu";
import { SettingsDialog } from "./components/SettingsDialog";
import { MenuBar, type MenuDef } from "./components/MenuBar";
import { Sidebar } from "./components/Sidebar";
import { PromptDialog, type PromptField } from "./components/PromptDialog";
import { HelpDialog } from "./components/HelpDialog";
import { AboutDialog } from "./components/AboutDialog";
import { QuickOpen } from "./components/QuickOpen";
import { ExportReportDialog } from "./components/ExportReportDialog";
import { runFormat, type FormatCmd } from "./lib/format";
import { DIALOG_HOTKEYS, EDIT_HOTKEYS, FORMAT_HOTKEYS, matchesKeys } from "./lib/shortcuts";
import { insertImageFromDisk } from "./lib/imageInsert";
import {
  exportFileName,
  saveDocxExport,
  saveEpubExport,
  type ExportReport,
} from "./lib/exportActions";
import { resolveLink, findAnchorPos } from "./lib/links";
import { setTypography, useTypography } from "./lib/typography";
import { setTheme, useTheme } from "./lib/theme";
import { epubVolumeRef, groupItemsByVolume, isBookOutlinePath } from "./lib/volume";
import { bookTitleFrom } from "./lib/bookOutline";

/**
 * 焦点是不是落在「正文以外」的输入控件里（侧栏搜索框、快速打开、改名框、对话框输入框…）。
 * 是的话格式快捷键必须让路，否则用户在搜索框里按 Ctrl+B 会去改正文。
 * 侧栏「大纲」标签里也是一个 CodeMirror（编的是 总纲.md），所以只有焦点落在
 * **正文栏**（.pane-main）的编辑器里才不算「外面」。
 */
function typingOutsideEditor(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body) return false;
  const tag = el.tagName;
  // 真正的表单控件一律让路，哪怕是编辑器里的查找框（.cm-search 的输入框也在 .cm-editor 里）
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  // contenteditable 只有落在正文编辑器里才算「不是外面」
  if (el.isContentEditable) return !el.closest?.(".pane-main .cm-editor");
  return false;
}

/**
 * 焦点是不是在「侧栏那台编辑器」里（大纲面板的总纲）。
 * 这类编辑器有自己的 Mod-s，Ctrl+S 必须让给它 —— 否则会去存正文栏那份。
 */
function focusInSideEditor(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  return !!el.closest?.(".cm-editor") && !el.closest(".pane-main");
}

/** 打开文件里的链接：桌面版交给系统默认程序，浏览器预览退化为新标签页 */
async function openExternal(href: string): Promise<void> {
  if (/^https?:/i.test(href)) {
    if (isDesktop()) {
      try {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(href);
        return;
      } catch {
        /* 落到下面的 window.open */
      }
    }
    window.open(href, "_blank");
    return;
  }
  useStore.getState().setStatus(`本地链接：${href}（暂不在应用内打开）`);
}

export default function App() {
  const init = useStore((s) => s.init);
  const root = useStore((s) => s.root);
  const chooseRoot = useStore((s) => s.chooseRoot);
  const activePath = useStore((s) => s.activePath);
  const content = useStore((s) => (s.activePath ? s.contents[s.activePath] : undefined));
  const setContent = useStore((s) => s.setContent);
  const saveFile = useStore((s) => s.saveFile);
  const saveAll = useStore((s) => s.saveAll);
  const status = useStore((s) => s.status);
  const chapters = useStore((s) => s.chapters);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const sidebarTab = useStore((s) => s.sidebarTab);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const sourceMode = useStore((s) => s.sourceMode);
  const toggleSourceMode = useStore((s) => s.toggleSourceMode);
  const focusMode = useStore((s) => s.focusMode);
  const toggleFocusMode = useStore((s) => s.toggleFocusMode);
  const typewriterMode = useStore((s) => s.typewriterMode);
  const toggleTypewriterMode = useStore((s) => s.toggleTypewriterMode);
  const typography = useTypography();
  const theme = useTheme();

  const viewRef = useRef<EditorView | null>(null);
  const [menu, setMenu] = useState<
    null | { x: number; y: number; sel: { from: number; to: number; text: string }; pos: number }
  >(null);
  const [cursor, setCursor] = useState({ line: 1, col: 1, selLen: 0 });
  const [selection, setSelection] = useState<{ from: number; to: number; text: string } | null>(null);
  const [leftWidth, setLeftWidth] = useState(272);
  /** 拖拽开始时的宽度：每次以它为基准算绝对宽度，避免累加导致越拖越快 */
  const leftDragBase = useRef(272);
  const [immersive, setImmersive] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [exportReport, setExportReport] = useState<{ title: string; report: ExportReport } | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const [prompt, setPrompt] = useState<null | {
    title: string;
    fields: PromptField[];
    onSubmit: (v: Record<string, string>) => void;
  }>(null);

  /** 所有需要编辑器的菜单动作都从这里取 view，避免到处判空 */
  const withView = useCallback((fn: (v: EditorView) => void) => {
    const v = viewRef.current;
    if (v) fn(v);
  }, []);

  const fmt = useCallback((cmd: FormatCmd) => withView((v) => void runFormat(v, cmd)), [withView]);

  useEffect(() => {
    init();
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      const mod = e.ctrlKey || e.metaKey;
      // 有对话框打开时（设置/删除/新建/命名），快捷键不越过它去操作编辑器
      const modalOpen = !!document.querySelector(".modal-mask");
      const key = e.key.toLowerCase();
      if (mod && key === "s") {
        if (modalOpen) return;
        // 焦点在大纲面板里：让那台编辑器自己处理（它存的是总纲，不是当前章）
        if (focusInSideEditor()) return;
        e.preventDefault();
        if (st.activePath) st.saveFile(st.activePath);
        else st.saveAll();
        return;
      }
      if (mod && e.key === ",") {
        if (modalOpen) return;
        e.preventDefault();
        setShowSettings(true);
        return;
      }
      if (mod && key === "p") {
        if (modalOpen) return;
        e.preventDefault();
        setQuickOpen(true);
        return;
      }
      if (mod && e.shiftKey && key === "f") {
        if (modalOpen) return;
        e.preventDefault();
        st.openSidebarTab("search");
        return;
      }
      // 以下是 Typora 的视图类快捷键，交给应用层统一处理，避免与编辑器 keymap 冲突
      if (modalOpen) return;
      if (mod && key === "/") {
        e.preventDefault();
        st.toggleSourceMode();
        return;
      }
      if (e.key === "F8") {
        e.preventDefault();
        st.toggleFocusMode();
        return;
      }
      if (e.key === "F9") {
        e.preventDefault();
        st.toggleTypewriterMode();
        return;
      }
      if (e.key === "F11") {
        e.preventDefault();
        void toggleFullscreen();
        return;
      }
      if (mod && e.shiftKey && key === "l") {
        e.preventDefault();
        st.toggleSidebar();
        return;
      }
      if (mod && e.shiftKey && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        zoomBy(2);
        return;
      }
      if (mod && e.shiftKey && e.key === "-") {
        e.preventDefault();
        zoomBy(-2);
        return;
      }

      /*
       * ---- 正文格式 / 编辑类键位（「帮助 → 快捷键」列表的下半部分）----
       *
       * 为什么放在 window 的**捕获阶段**并 preventDefault：
       * CodeMirror 自己把好几个键位绑给了别的命令 —— Mod-i = selectParentSyntax、
       * Mod-u = undoSelection、Shift-Mod-k = deleteLine、Mod-/ = toggleComment、
       * Mod-Shift-l = selectSelectionMatches。而 @codemirror/view 的 runHandlers
       * 一看到 event.defaultPrevented 就直接不执行任何键位，所以在 window 捕获阶段
       * （比 contentDOM 上的编辑器监听更早）处理并 preventDefault，既能真正生效，
       * 又不会和 CodeMirror 的默认键位打架，更不会两处各执行一次。
       */
      if (!mod && !e.altKey) return; // 下面这些都是带 Ctrl/Alt 的组合
      if (typingOutsideEditor()) return; // 焦点在搜索框/改名框里时不动正文
      for (const h of EDIT_HOTKEYS) {
        if (!matchesKeys(h.keys, e)) continue;
        e.preventDefault();
        if (h.edit === "replace") hotkeys.current.openReplace();
        else hotkeys.current.redo();
        return;
      }
      for (const h of DIALOG_HOTKEYS) {
        if (!matchesKeys(h.keys, e)) continue;
        e.preventDefault();
        if (h.dialog === "link") hotkeys.current.insertLinkDialog();
        else hotkeys.current.insertImage();
        return;
      }
      for (const h of FORMAT_HOTKEYS) {
        if (!matchesKeys(h.keys, e)) continue;
        e.preventDefault();
        hotkeys.current.fmt(h.cmd);
        return;
      }
    };
    // 捕获阶段：要比 CodeMirror 挂在 contentDOM 上的键盘监听更早拿到事件
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("beforeunload", saveAll);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("beforeunload", saveAll);
    };
  }, [init, saveAll]);

  /*
   * Ctrl + 滚轮：上滑放大字号、下滑缩小（走同一套 zoomBy，带上下限）。
   * 必须 preventDefault：WebKit 自己会把 Ctrl+滚轮当页面缩放，不放行会两套一起动。
   * 带 Shift/Alt 的组合不拦，留给以后可能的横向滚动之类的用途。
   */
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey || e.shiftKey || e.altKey) return;
      if (e.deltaY === 0) return;
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 2 : -2);
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, []);

  const onCursor = useCallback((line: number, col: number, selLen: number) => {
    setCursor({ line, col, selLen });
  }, []);

  const onSelectionChange = useCallback((sel: { from: number; to: number; text: string }) => {
    setSelection(sel);
  }, []);

  // 点击任意处关闭右键菜单
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu]);

  const hasSelection = !!menu && menu.sel.to > menu.sel.from;

  const docTitle = useMemo(() => {
    if (!activePath) return root ? root.split("/").pop()! : "MyNovel";
    // 优先用章列表里的标题（与文件树、EPUB 目录同一来源），拿不到再退回文件名
    const meta = chapters.find((c) => c.path === activePath);
    return meta?.title ?? activePath.split("/").pop()!.replace(/\.md$/, "");
  }, [activePath, root, chapters]);

  const docDir = useCallback(() => {
    if (!activePath || !activePath.includes("/")) return "";
    return activePath.slice(0, activePath.lastIndexOf("/"));
  }, [activePath]);

  /* ---------------- 编辑器动作 ---------------- */
  const openFind = () =>
    withView((v) => {
      openSearchPanel(v);
      setTimeout(() => {
        const el = document.querySelector<HTMLInputElement>(".cm-search input[name='search']");
        el?.focus();
        el?.select();
      }, 0);
    });

  const openReplace = () =>
    withView((v) => {
      openSearchPanel(v);
      setTimeout(() => {
        const el = document.querySelector<HTMLInputElement>(".cm-search input[name='replace']");
        if (el) {
          el.focus();
        } else {
          document.querySelector<HTMLInputElement>(".cm-search input[name='search']")?.focus();
        }
      }, 0);
    });

  const copySelection = () =>
    withView((v) => {
      const s = v.state.selection.main;
      const t = v.state.sliceDoc(s.from, s.to);
      if (t) void navigator.clipboard.writeText(t);
      useStore.getState().setStatus(t ? "已复制" : "没有选中内容");
    });

  const cutSelection = () =>
    withView((v) => {
      const s = v.state.selection.main;
      const t = v.state.sliceDoc(s.from, s.to);
      if (!t) return;
      void navigator.clipboard.writeText(t);
      v.dispatch({ changes: { from: s.from, to: s.to, insert: "" } });
      v.focus();
    });

  const pasteClipboard = () =>
    withView((v) => {
      void navigator.clipboard.readText().then((t) => {
        if (!t) return;
        const s = v.state.selection.main;
        v.dispatch({
          changes: { from: s.from, to: s.to, insert: t },
          selection: { anchor: s.from + t.length },
        });
        v.focus();
      });
    });

  const selectAll = () =>
    withView((v) => {
      v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } });
      v.focus();
    });

  const copyWholeAsMarkdown = async () => {
    if (content === undefined) return;
    try {
      await navigator.clipboard.writeText(content);
      useStore.getState().setStatus("已复制为 Markdown 源码");
    } catch (e) {
      // 剪贴板被拒绝（非安全上下文 / 权限）时不能报「已复制」——与 copyWholeAsHtml 保持一致
      useStore.getState().setStatus(`复制失败：${String(e)}`);
    }
  };

  /**
   * 导出为 DOCX（真实 OOXML 容器，离线）：
   * 本地图片内嵌、超大图缩放、远程图与缺失图明确文字占位、复杂块源码一字不丢；
   * 目标路径拦截覆盖手稿；若有降级或问题，弹出清晰的 ExportReportDialog 说明。
   */
  const exportDocx = async () => {
    if (content === undefined || !activePath) return;
    try {
      useStore.getState().setStatus(`正在生成 DOCX（${docTitle}）…`);
      const res = await saveDocxExport({
        markdown: content,
        title: docTitle,
        root,
        baseDir: docDir(),
        sourcePath: activePath,
      });
      if (res.cancelled) {
        useStore.getState().setStatus("已取消导出 DOCX");
        return;
      }
      if (!res.path) {
        // 目标路径被拒绝（如覆盖了原 .md）
        setExportReport({ title: "DOCX 导出被拒绝", report: res.report });
        useStore.getState().setStatus(res.report.summary);
        return;
      }
      useStore.getState().setStatus(res.report.summary);
      if (res.report.hasIssues) {
        setExportReport({ title: "DOCX 导出完成（包含格式降级提示）", report: res.report });
      }
    } catch (e) {
      useStore.getState().setStatus(`导出 DOCX 失败：${String(e)}`);
    }
  };

  /**
   * 导出**当前文档**为 EPUB 3（真实 OCF 容器）：
   * 只把当前打开的这一篇（content / activePath / docTitle）交给导出器——不读工作区里
   * 的其他文件、也不按 .md 列表聚合，避免把别的作品夹带进电子书，或把读不到的文件
   * 静默当成空章；读不到内容时宁可报错，也不生成空章节。
   * 「一组章节 → 一本书」的多章能力保留在 lib/epubExport / lib/exportActions 里，
   * 界面暂不默认暴露（多章成书的调用方需要自己显式传 chapters）。
   * 自动生成 EPUB3 nav.xhtml + EPUB2 toc.ncx 双目录；离线不下载远程图；手稿防覆盖。
   */
  const exportEpub = async () => {
    if (content === undefined || !activePath) return;
    try {
      useStore.getState().setStatus(`正在生成 EPUB 电子书…`);
      const res = await saveEpubExport({
        title: docTitle,
        chapters: [{ title: docTitle, markdown: content, path: activePath }],
        root,
        sourcePath: activePath,
      });
      if (res.cancelled) {
        useStore.getState().setStatus("已取消导出 EPUB");
        return;
      }
      if (!res.path) {
        setExportReport({ title: "EPUB 导出被拒绝", report: res.report });
        useStore.getState().setStatus(res.report.summary);
        return;
      }
      useStore.getState().setStatus(res.report.summary);
      if (res.report.hasIssues) {
        setExportReport({ title: "EPUB 导出完成（包含格式降级提示）", report: res.report });
      }
    } catch (e) {
      useStore.getState().setStatus(`导出 EPUB 失败：${String(e)}`);
    }
  };

  /**
   * 导出**整本书**为 EPUB 3（按卷分组）：
   *   卷目录 → 该卷的章；nav.xhtml 的 toc 变成「卷（li）→ 章（li 嵌套 ol）」，
   *   toc.ncx 变成嵌套 navPoint 且 playOrder 递增；卷标题取卷目录名的可读名
   *   （「第一卷 风起」→「风起」）；书名取 总纲.md 的 H1。
   * 整本书不设卷（章直接放在书目录下）时，目录保持原来的扁平章列表。
   * 读不到正文的章节宁可中止导出，也不静默生成空章。
   */
  const exportBookEpub = async () => {
    const st = useStore.getState();
    if (!st.root || st.chapters.length === 0) return;
    useStore.getState().setStatus(`正在生成整本 EPUB…`);

    const texts: Record<string, string> = {};
    const failed: string[] = [];
    for (const c of st.chapters) {
      const cached = st.contents[c.path];
      if (cached !== undefined) {
        texts[c.path] = cached;
        continue;
      }
      try {
        const fc = await api.readFile(st.root, c.path);
        if (fc) texts[c.path] = fc.content;
        else failed.push(c.path);
      } catch {
        failed.push(c.path);
      }
    }
    if (failed.length) {
      useStore.getState().setStatus(
        `导出中止：${failed.length} 个章节读不到内容（${failed.slice(0, 3).join("、")}${failed.length > 3 ? "…" : ""}）`,
      );
      return;
    }

    // 总纲（决定书名）读不到只降级，不阻断导出
    const outlineTexts: Record<string, string> = {};
    const outlinePaths = st.files.filter(isBookOutlinePath);
    for (const p of outlinePaths) {
      const cached = st.contents[p];
      if (cached !== undefined) {
        outlineTexts[p] = cached;
        continue;
      }
      try {
        const fc = await api.readFile(st.root, p);
        if (fc) outlineTexts[p] = fc.content;
      } catch {
        /* 书名退化为目录名，不影响导出 */
      }
    }

    const groups = groupItemsByVolume(st.chapters, (c) => c.path, new Set(st.volumes));
    const epubChapters = groups.flatMap((group) =>
      group.items.map((c) => ({
        title: c.title,
        markdown: texts[c.path] ?? "",
        path: c.path,
        ...(group.volume ? { volume: epubVolumeRef(group.volume) } : {}),
      })),
    );

    const bookOutlinePath = st.files.filter(isBookOutlinePath).sort()[0];
    const bookTitle = bookTitleFrom(
      bookOutlinePath ? outlineTexts[bookOutlinePath] : undefined,
      st.root.split("/").pop() || "未命名",
    );

    try {
      const res = await saveEpubExport({
        title: bookTitle,
        chapters: epubChapters,
        root: st.root,
        sourcePath: null,
        defaultName: exportFileName(bookTitle, "epub"),
      });
      if (res.cancelled) {
        useStore.getState().setStatus("已取消导出整本 EPUB");
        return;
      }
      if (!res.path) {
        setExportReport({ title: "EPUB 导出被拒绝", report: res.report });
        useStore.getState().setStatus(res.report.summary);
        return;
      }
      useStore.getState().setStatus(res.report.summary);
      if (res.report.hasIssues) {
        setExportReport({ title: "整本 EPUB 导出完成（包含格式降级提示）", report: res.report });
      }
    } catch (e) {
      useStore.getState().setStatus(`导出整本 EPUB 失败：${String(e)}`);
    }
  };

  const insertLinkDialog = () =>
    setPrompt({
      title: "插入超链接",
      fields: [
        { key: "text", label: "链接文字", value: selection?.text ?? "" },
        { key: "url", label: "地址", value: "https://" },
      ],
      onSubmit: (v) => {
        const text = v.text || v.url;
        fmt({ k: "insertText", text: `[${text}](${v.url})` });
      },
    });

  const insertImage = () => withView((v) => void insertImageFromDisk(v, useStore.getState().root));

  /**
   * 键位处理要用到的「当前」动作。keydown 监听只在挂载时注册一次（捕获阶段），
   * 直接闭包捕获会拿到首帧的旧函数（例如 insertLinkDialog 就永远看不到最新选区），
   * 所以走 ref，每次渲染刷新。
   */
  const hotkeys = useRef({
    fmt,
    insertLinkDialog,
    insertImage,
    openReplace,
    redo: () => withView((v) => void redo(v)),
  });
  hotkeys.current = {
    fmt,
    insertLinkDialog,
    insertImage,
    openReplace,
    redo: () => withView((v) => void redo(v)),
  };

  const newFileDialog = () =>
    setPrompt({
      title: "新建文件",
      fields: [{ key: "name", label: "文件名（自动补 .md）", value: "新文件" }],
      onSubmit: async (v) => {
        const st = useStore.getState();
        const r = st.root;
        if (!r) return;
        // 先 trim 再判断后缀：否则「稿.md 」会拼成「稿.md.md」
        const typed = v.name.trim();
        const name = (typed || "新文件") + (typed.endsWith(".md") ? "" : ".md");
        try {
          await api.createFile(r, name, "");
          await st.refresh();
          await st.openFile(name);
          st.setStatus(`已新建 ${name}`);
        } catch (e) {
          st.setStatus(`新建失败：${String(e)}`);
        }
      },
    });

  /**
   * 点击正文链接（需 Ctrl/Cmd 修饰，由编辑器判定）：
   * 当前文档锚点、工作区其他 .md 文件、缺失文件（询问是否新建）与外部网址四条路径。
   */
  const handleLinkClick = useCallback(
    async (href: string) => {
      const st = useStore.getState();
      const target = resolveLink(href, st.activePath, st.files);
      const jump = (pos: number) =>
        withView((v) => {
          v.dispatch({
            selection: { anchor: pos },
            effects: EditorView.scrollIntoView(pos, { y: "start" }),
          });
          v.focus();
        });

      if (target.kind === "external") {
        void openExternal(target.href);
        return;
      }
      if (target.kind === "anchor") {
        const cur = st.activePath ? st.contents[st.activePath] : undefined;
        if (!target.anchor || cur === undefined) return;
        const pos = findAnchorPos(cur, target.anchor);
        if (pos === null) st.setStatus(`未找到锚点：#${target.anchor}`);
        else jump(pos);
        return;
      }
      if (target.kind === "file") {
        // 打开前后各记一笔：这个文件本来就是当前文件时，编辑器不会重建，也就没什么可等的
        const sameDoc = st.activePath === target.path;
        const before = viewRef.current;
        await st.openFile(target.path);
        if (target.anchor) {
          const anchor = target.anchor;
          // 切文件时 Editor（按 activePath 建 key）会整个重建，viewRef 还会指着旧视图几帧；
          // 这时候跳只会跳到那个马上被丢掉的视图上，表现就是「点了没反应」。
          // 原来的 60ms 是估的，文件大 / 机器慢时不够，所以改成盯着视图真的换过再跳。
          const deadline = performance.now() + 1500;
          const tryJump = () => {
            const v = viewRef.current;
            if (sameDoc || (v && v !== before)) {
              const cur = useStore.getState().contents[target.path];
              if (cur !== undefined) {
                const pos = findAnchorPos(cur, anchor);
                if (pos !== null) jump(pos);
                return;
              }
            }
            if (performance.now() < deadline) requestAnimationFrame(tryJump);
          };
          tryJump();
        }
        return;
      }
      // 目标文件还不存在：问一下要不要顺手创建（对应 Typora 的点击即创建）
      setPrompt({
        title: `文件不存在：${target.path}`,
        fields: [
          {
            key: "body",
            label: "在工作区创建该文件，可先写一句（留空就是空白文档）：",
            value: "",
          },
        ],
        onSubmit: async (v) => {
          const r = st.root;
          if (!r) return;
          try {
            await api.createFile(r, target.path, v.body);
            await st.refresh();
            await st.openFile(target.path);
            st.setStatus(`已创建并打开 ${target.path}`);
          } catch (e) {
            st.setStatus(`创建失败：${String(e)}`);
          }
        },
      });
    },
    [withView],
  );

  /* ---------------- 菜单定义 ----------------
   * 故意不用 useMemo：这一百多行菜单闭包里抓了三十来个东西（activePath / content / 各个 action），
   * 依赖表漏一个就是「菜单点了没反应 / 操作的是上一章」这种事后极难查的陈旧闭包，
   * 而重建成这几百个小对象本来就不贵。要优化菜单栏请从别处下手，别给这个数组套 memo。
   */
  const menus: MenuDef[] = [
    {
      label: "文件",
      items: [
        { title: "文档" },
        { label: "保存", shortcut: "Ctrl+S", disabled: !activePath, onClick: () => activePath && void saveFile(activePath) },
        { label: "全部保存", disabled: useStore.getState().dirty.size === 0, onClick: () => void saveAll() },
        "separator",
        { title: "导出" },
        { label: "导出为 Word 文档 (.docx)…", disabled: content === undefined, onClick: () => void exportDocx() },
        { label: "导出当前文档为 EPUB 电子书 (.epub)…", disabled: content === undefined, onClick: () => void exportEpub() },
        {
          label: "导出整本书为 EPUB（按卷分组）…",
          disabled: !root || chapters.length === 0,
          onClick: () => void exportBookEpub(),
        },
        { label: "复制为 Markdown", disabled: content === undefined, onClick: copyWholeAsMarkdown },
        "separator",
        { label: "新建章节", onClick: () => void createNextChapter() },
        { label: "新建文件…", disabled: !root, onClick: newFileDialog },
        { label: "刷新工作区", disabled: !root, onClick: () => void useStore.getState().refresh() },
        "separator",
        { label: "打开/切换工作区…", onClick: () => void chooseRoot() },
      ],
    },
    {
      label: "编辑",
      items: [
        { label: "撤销", shortcut: "Ctrl+Z", disabled: !activePath, onClick: () => withView((v) => void undo(v)) },
        { label: "重做", shortcut: "Ctrl+Shift+Z", disabled: !activePath, onClick: () => withView((v) => void redo(v)) },
        "separator",
        { label: "剪切", shortcut: "Ctrl+X", disabled: !activePath, onClick: cutSelection },
        { label: "复制", shortcut: "Ctrl+C", disabled: !activePath, onClick: copySelection },
        { label: "粘贴", shortcut: "Ctrl+V", disabled: !activePath, onClick: pasteClipboard },
        { label: "全选", shortcut: "Ctrl+A", disabled: !activePath, onClick: selectAll },
        "separator",
        { label: "快速打开文件…", shortcut: "Ctrl+P", disabled: !root, onClick: () => setQuickOpen(true) },
        { label: "查找", shortcut: "Ctrl+F", disabled: !activePath, onClick: openFind },
        { label: "查找与替换", shortcut: "Ctrl+H", disabled: !activePath, onClick: openReplace },
        {
          label: "在工作区中搜索",
          shortcut: "Ctrl+Shift+F",
          onClick: () => useStore.getState().openSidebarTab("search"),
        },
        "separator",
        { label: "复制为 Markdown", disabled: content === undefined, onClick: copyWholeAsMarkdown },
      ],
    },
    {
      label: "段落",
      items: [
        { title: "列表与引用" },
        { label: "无序列表", shortcut: "Ctrl+Shift+]", onClick: () => fmt({ k: "list", kind: "ul" }) },
        { label: "有序列表", shortcut: "Ctrl+Shift+[", onClick: () => fmt({ k: "list", kind: "ol" }) },
        { label: "引用", shortcut: "Ctrl+Shift+Q", onClick: () => fmt({ k: "quote" }) },
        "separator",
        { title: "其他" },
        { label: "分割线", onClick: () => fmt({ k: "hr" }) },
        "separator",
        // 整段移动没有键位：Alt+↑/↓ 是 CodeMirror defaultKeymap 的「当前行」移动
        // （见「帮助 → 快捷键」），这里标上 Alt+↑ 会让人以为同一键位能干两件事。
        { label: "段落上移", onClick: () => fmt({ k: "paraMove", dir: -1 }) },
        { label: "段落下移", onClick: () => fmt({ k: "paraMove", dir: 1 }) },
        { label: "复制段落", onClick: () => fmt({ k: "paraDuplicate" }) },
        { label: "删除段落", shortcut: "Ctrl+Shift+D", onClick: () => fmt({ k: "paraDelete" }) },
      ],
    },
    {
      label: "格式",
      items: [
        { label: "加粗", shortcut: "Ctrl+B", onClick: () => fmt({ k: "inline", style: "bold" }) },
        { label: "斜体", shortcut: "Ctrl+I", onClick: () => fmt({ k: "inline", style: "italic" }) },
        { label: "下划线", shortcut: "Ctrl+U", onClick: () => fmt({ k: "inline", style: "underline" }) },
        { label: "删除线", shortcut: "Alt+Shift+5", onClick: () => fmt({ k: "inline", style: "strike" }) },
        "separator",
        { label: "超链接", shortcut: "Ctrl+K", onClick: insertLinkDialog },
        { label: "插入本地图片", shortcut: "Ctrl+Shift+I", disabled: !activePath, onClick: insertImage },
        "separator",
        { label: "清除格式", onClick: () => fmt({ k: "clearFormat" }) },
      ],
    },
    {
      label: "视图",
      items: [
        { title: "编辑模式" },
        { label: "源码模式", shortcut: "Ctrl+/", checked: sourceMode, onClick: () => toggleSourceMode() },
        { label: "专注模式", shortcut: "F8", checked: focusMode, onClick: () => toggleFocusMode() },
        { label: "打字机模式", shortcut: "F9", checked: typewriterMode, onClick: () => toggleTypewriterMode() },
        "separator",
        { title: "面板" },
        { label: "左侧栏", shortcut: "Ctrl+Shift+L", checked: sidebarOpen, onClick: () => toggleSidebar() },
        { label: "工作区搜索", checked: sidebarOpen && sidebarTab === "search", onClick: () => useStore.getState().openSidebarTab("search") },
        "separator",
        { title: "窗口" },
        // keepOpen：连点调字号时菜单不关，方便一直按
        { label: "放大字号", shortcut: "Ctrl+Shift+= / 滚轮", keepOpen: true, onClick: () => zoomBy(2) },
        { label: "缩小字号", shortcut: "Ctrl+Shift+- / 滚轮", keepOpen: true, onClick: () => zoomBy(-2) },
        {
          label: "还原默认",
          onClick: () => {
            setTypography({ fontSize: 16 });
            useStore.getState().setStatus("字号已重置为 16px");
          },
        },
        { label: "全屏", shortcut: "F11", onClick: () => void toggleFullscreen() },
        {
          label: "沉浸写作",
          disabled: !activePath,
          onClick: () => setImmersive(true),
        },
      ],
    },
    {
      label: "主题",
      items: [
        { label: "粉白", checked: theme === "light", onClick: () => setTheme("light") },
        { label: "暗色", checked: theme === "dark", onClick: () => setTheme("dark") },
        "separator",
        { label: "字体与排版…", shortcut: "Ctrl+,", onClick: () => setShowSettings(true) },
        { label: `当前字号 ${typography.fontSize}px`, disabled: true, onClick: () => {} },
      ],
    },
    {
      label: "帮助",
      items: [
        { label: "功能与快捷键…", onClick: () => setShowHelp(true) },
        { label: "关于 MyNovel", onClick: () => setShowAbout(true) },
      ],
    },
  ];

  /**
   * 设置对话框：标题栏按钮、Ctrl+, 以及沉浸/欢迎页都能打开。
   * 沉浸模式请求全屏时只有 fullscreen 宿主子树会显示，所以 portal 到
   * document.fullscreenElement；非全屏时退回 body（.settings-mask 的 z-index
   * 高于 .immersive，能压住沉浸浮层）。
   */
  const settingsModal = showSettings
    ? createPortal(
        <SettingsDialog onClose={() => setShowSettings(false)} />,
        document.fullscreenElement ?? document.body,
      )
    : null;
  const helpModal = showHelp
    ? createPortal(<HelpDialog onClose={() => setShowHelp(false)} />, document.fullscreenElement ?? document.body)
    : null;
  const aboutModal = showAbout
    ? createPortal(<AboutDialog onClose={() => setShowAbout(false)} />, document.fullscreenElement ?? document.body)
    : null;
  /**
   * 导出报告弹窗：只有真的写了文件、或目标被拒绝时才会用到；
   * 内容完全来自 exportActions 的报告（不造假成功消息）。
   */
  const exportReportModal = exportReport
    ? createPortal(
        <ExportReportDialog
          title={exportReport.title}
          report={exportReport.report}
          onClose={() => setExportReport(null)}
        />,
        document.fullscreenElement ?? document.body,
      )
    : null;

  if (immersive && activePath && content !== undefined) {
    return (
      <>
        <ImmersiveEditor
          activePath={activePath}
          content={content}
          onChange={(v) => setContent(activePath, v)}
          onSave={() => saveFile(activePath)}
          onExit={() => setImmersive(false)}
          headerSlot={
            <button className="im-btn" onClick={() => setShowSettings(true)} title="字体与排版">
              字体
            </button>
          }
        />
        {settingsModal}
        {exportReportModal}
      </>
    );
  }

  if (!root) {
    return (
      <>
        <div className="welcome">
          <div className="welcome-inner">
            <h1>MyNovel</h1>
            <p>本地优先的小说写作工具 · 数据即 Markdown 文件</p>
            <button className="btn btn-lg" onClick={chooseRoot}>
              选择工作区目录
            </button>
            {status !== "就绪" && <p className="welcome-status">{status}</p>}
            <p className="welcome-hint">
              {isDesktop()
                ? "建议选一个专门放小说的文件夹，如 ~/小说"
                : "当前是浏览器预览，目录访问需要启动桌面版：npm run app"}
            </p>
            <p className="welcome-hint">
              <button className="btn" onClick={() => setShowSettings(true)}>
                字体与排版
              </button>{" "}
              <button className="btn" onClick={() => setShowHelp(true)}>
                功能与快捷键
              </button>
              <button className="btn" onClick={() => setShowAbout(true)}>
                关于
              </button>
            </p>
          </div>
        </div>
        {settingsModal}
        {helpModal}
        {aboutModal}
      </>
    );
  }

  return (
    <div className="app">
      <MenuBar menus={menus} />

      <div className="body">
        {sidebarOpen && (
          <>
            <div className="pane pane-left" style={{ width: leftWidth }}>
              <Sidebar />
            </div>
            <Splitter
              onDragStart={() => {
                leftDragBase.current = leftWidth;
              }}
              onDrag={(dx) =>
                setLeftWidth(Math.max(200, Math.min(560, leftDragBase.current + dx)))
              }
            />
          </>
        )}

        <div className="pane pane-main">
          <TabBar />
          <div className="editor-area">
            {activePath && content !== undefined ? (
              <Editor
                key={activePath}
                path={activePath}
                initialContent={content}
                onChange={(v) => setContent(activePath, v)}
                onSave={() => saveFile(activePath)}
                onCursor={onCursor}
                onSelectionChange={onSelectionChange}
                registerView={(v) => (viewRef.current = v)}
                contextMenu={(info: any) =>
                  setMenu({
                    x: info.x,
                    y: info.y,
                    sel: info.sel,
                    pos: typeof info.pos === "number" ? info.pos : info.sel?.from ?? 0,
                  })
                }
                sourceMode={sourceMode}
                focusMode={focusMode}
                typewriterMode={typewriterMode}
                onLinkClick={(href: string, mod: boolean) => {
                  if (mod) void handleLinkClick(href);
                }}
              />
            ) : (
              <div className="editor-blank">从左侧打开一个文件开始写作</div>
            )}
            <PaperCompanion />
          </div>
        </div>

      </div>

      <StatusBar cursor={cursor} />

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              key: "copy",
              label: "复制",
              disabled: !hasSelection,
              onClick: () => {
                void navigator.clipboard.writeText(menu.sel.text);
                useStore.getState().setStatus("已复制");
              },
            },
            { key: "bold", label: "加粗", disabled: !hasSelection, onClick: () => fmt({ k: "inline", style: "bold" }) },
            { key: "italic", label: "斜体", disabled: !hasSelection, onClick: () => fmt({ k: "inline", style: "italic" }) },
            { key: "strike", label: "删除线", disabled: !hasSelection, onClick: () => fmt({ k: "inline", style: "strike" }) },
            { key: "highlight", label: "高亮", disabled: !hasSelection, onClick: () => fmt({ k: "inline", style: "highlight" }) },
            { key: "link", label: "超链接", onClick: insertLinkDialog },
            { key: "image", label: "插入图片", onClick: insertImage },
            "separator",
            {
              key: "split",
              label: "在此拆分章节",
              onClick: () => {
                void splitCurrent(menu.sel.from);
              },
            },
          ]}
        />
      )}

      {prompt && (
        <PromptDialog
          title={prompt.title}
          fields={prompt.fields}
          onSubmit={prompt.onSubmit}
          onClose={() => setPrompt(null)}
        />
      )}

      {settingsModal}
      {helpModal}
      {aboutModal}
      {exportReportModal}
      {quickOpen && (
        <QuickOpen
          files={useStore.getState().files}
          onOpen={(p) => void useStore.getState().openFile(p)}
          onClose={() => setQuickOpen(false)}
        />
      )}
    </div>
  );
}

/** 字号缩放：直接改共享的排版设置，编辑器与沉浸模式同时生效 */
function zoomBy(delta: number): void {
  const cur = useStore.getState().status;
  void cur;
  const size = Number(
    getComputedStyle(document.documentElement).getPropertyValue("--editor-font-size").replace("px", ""),
  );
  const next = Math.max(12, Math.min(34, (Number.isFinite(size) ? size : 16) + delta));
  setTypography({ fontSize: next });
  useStore.getState().setStatus(`字号 ${next}px`);
}

async function toggleFullscreen(): Promise<void> {
  if (!isDesktop()) {
    useStore.getState().setStatus("浏览器预览不支持全屏切换");
    return;
  }
  try {
    const win = getCurrentWindow();
    const full = await win.isFullscreen();
    await win.setFullscreen(!full);
  } catch (e) {
    useStore.getState().setStatus(`全屏切换失败：${String(e)}`);
  }
}

function Splitter({
  onDragStart,
  onDrag,
}: {
  onDragStart?: () => void;
  /** 相对拖拽起点的总位移（不是两次事件之间的增量） */
  onDrag: (dx: number) => void;
}) {
  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    onDragStart?.();
    const startX = e.clientX;
    let queued = 0;
    let frame = 0;

    // 一帧只应用一次位移：鼠标事件比渲染快，逐条改宽度会抖
    const flush = () => {
      frame = 0;
      onDrag(queued);
    };
    const move = (ev: MouseEvent) => {
      queued = ev.clientX - startX;
      if (!frame) frame = requestAnimationFrame(flush);
    };
    const up = () => {
      if (frame) {
        cancelAnimationFrame(frame);
        flush();
      }
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  return <div className="splitter" onMouseDown={onMouseDown} />;
}
