import { useEffect, useRef } from "react";
import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import {
  EditorView,
  keymap,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  highlightActiveLine,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { GFM } from "@lezer/markdown";
import { markdown } from "@codemirror/lang-markdown";
import { isInCode, livePreview } from "./livePreview";
import { installImeGuard, planExternalSync, type ImeGuard } from "./ime";
import { listKeys } from "./listKeys";
import { arrowKeys } from "./arrowKeys";
import { baseTheme, highlightStyle, sourceHighlightStyle } from "./extensions";
import { syntaxHighlighting } from "@codemirror/language";
import { api } from "../api";
import { useStore } from "../store";
import { atxHeadingOf } from "../lib/outline";
import { resolveRelative } from "../lib/mdExport";

interface Props {
  sourceMode?: boolean;
  focusMode?: boolean;
  typewriterMode?: boolean;
  onLinkClick?: (href: string, mod: boolean) => void;
  /** Ctrl/⌘+点击某一行标题时回调（大纲文档用来跳到同名章节） */
  onHeadingClick?: (h: { level: number; text: string; line: number }) => void;
  path: string;
  initialContent: string;
  onChange: (content: string) => void;
  onSave: () => void;
  onCursor: (line: number, col: number, selLen: number) => void;
  registerView?: (view: EditorView | null) => void;
  onSelectionChange?: (sel: { from: number; to: number; text: string }) => void;
  contextMenu?: (info: {
    x: number;
    y: number;
    sel: { from: number; to: number; text: string };
  }) => void;
}

export function Editor({
  path,
  sourceMode = false, focusMode = false, typewriterMode = false, onLinkClick, onHeadingClick,
  initialContent,
  onChange,
  onSave,
  onCursor,
  registerView,
  onSelectionChange,
  contextMenu,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const imeRef = useRef<ImeGuard | null>(null);
  /** store 上一次给过来的正文：外部改动是不是基于「当前」正文写的，靠它判断。 */
  const storeRef = useRef<string | null>(null);
  /** 编辑器自己通过 onChange 回显给 store 的正文：用来区分外部改写与自身回显。 */
  const echoRef = useRef<string | null>(null);
  const mode = useRef(new Compartment());
  const cbs = useRef({ typewriterMode, onLinkClick, onHeadingClick, onChange, onSave, onCursor, onSelectionChange, contextMenu });
  cbs.current = { typewriterMode, onLinkClick, onHeadingClick, onChange, onSave, onCursor, onSelectionChange, contextMenu };

  const modeExtensions = (source: boolean): Extension[] => [
    syntaxHighlighting(source ? sourceHighlightStyle : highlightStyle),
    ...(source ? [] : [livePreview({
      onLink: (href, mod) => cbs.current.onLinkClick?.(href, mod),
      image: async src => {
        const root = useStore.getState().root;
        if (!root) return null;
        let decoded: string;
        try { decoded = decodeURIComponent(src); } catch { return null; }
        const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        return api.readImageDataUrl(root, resolveRelative(dir, decoded));
      },
    })]),
  ];

  /**
   * 组合态里 dispatch 会打断输入法预编辑（候选窗跳位、提交被覆盖），
   * 所以统一的规矩是：空闲就直接做，组合中排到组合真正结束、提交文本落盘之后再做。
   */
  const whenImeIdle = (fn: () => void, key: string) => {
    const guard = imeRef.current;
    if (!guard) {
      fn();
      return;
    }
    guard.whenIdle(fn, key);
  };

  useEffect(() => {
    if (!hostRef.current) return;

    const extensions: Extension[] = [
      history(),
      drawSelection(),
      dropCursor(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      EditorState.phrases.of({
        Find: "查找",
        Replace: "替换",
        next: "下一个",
        previous: "上一个",
        all: "全部",
        "match case": "区分大小写",
        regexp: "正则",
        "by word": "全词匹配",
        replace: "替换",
        "replace all": "全部替换",
        close: "关闭",
      }),
      markdown({ extensions: [GFM] }),
      baseTheme,
      EditorView.lineWrapping,
      mode.current.of(modeExtensions(sourceMode)),
      /*
       * 列表键位必须用 Prec.highest 单独提权。
       *
       * @codemirror/lang-markdown 内部是 `Prec.high(keymap.of(markdownKeymap))`，
       * 而它的 Enter 会在空列表项上插一个空行、把 "- " 留着，和 Typora 的"退出列表"不一样。
       * 同级的 Prec.high 压不过它（优先级相同时按注册顺序，markdown() 在更前面），
       * 所以这里必须用 Prec.highest；listKeys 只在这三种情况下返回 true，其余按键照旧
       * 交给它的 keymap 处理（续行、序号递增仍由它负责）。
       */
      Prec.highest(keymap.of(listKeys)),
      // 上下键要压过 defaultKeymap 的 cursorLineDown/Up（默认优先级低，Prec.high 就够）
      Prec.high(keymap.of(arrowKeys)),
      keymap.of([
        { key: "Mod-s", run: () => { cbs.current.onSave(); return true; } },
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          const nextDoc = u.state.doc.toString();
          echoRef.current = nextDoc;
          cbs.current.onChange(nextDoc);
        }
        if (u.selectionSet || u.docChanged) {
          const head = u.state.selection.main.head;
          const line = u.state.doc.lineAt(head);
          cbs.current.onCursor(line.number, head - line.from + 1, u.state.selection.main.to - u.state.selection.main.from);
          if (cbs.current.typewriterMode) {
            requestAnimationFrame(() => {
              if (viewRef.current !== u.view) return;
              // rAF 比排队处晚 ~16ms，其间可能刚好开始一次组合（compositionstart 时
              // view.composing 还是 false），所以真正滚动前用守卫再判一次；
              // 组合中就推迟，组合结束后自然补上这次打字机对齐。
              whenImeIdle(() => {
                if (viewRef.current === u.view) {
                  u.view.dispatch({ effects: EditorView.scrollIntoView(u.view.state.selection.main.head, { y: "center" }) });
                }
              }, "typewriter");
            });
          }
          const sel = u.state.selection.main;
          cbs.current.onSelectionChange?.({
            from: sel.from,
            to: sel.to,
            text: u.state.sliceDoc(sel.from, sel.to),
          });
        }
      }),
      EditorView.contentAttributes.of({
        "data-gramm": "false",
        autocapitalize: "off",
        autocomplete: "off",
        spellcheck: "false",
      }),
      EditorView.domEventHandlers({
        click: (e, view) => {
          if (!(e.ctrlKey || e.metaKey)) return false;
          const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
          if (pos === null || isInCode(view, pos)) return false;
          const line = view.state.doc.lineAt(pos);
          // Ctrl+点击标题：交给调用方决定要做什么（大纲文档跳章节）
          const heading = atxHeadingOf(line.text);
          if (heading && cbs.current.onHeadingClick) {
            e.preventDefault();
            cbs.current.onHeadingClick({ ...heading, line: line.number });
            return true;
          }
          for (const match of line.text.matchAll(/(?<!!)\[[^\]]*\]\(([^\s)]+)(?:\s+["'][^"']*["'])?\)/g)) {
            if (pos >= line.from + match.index! && pos <= line.from + match.index! + match[0].length) {
              const href = match[1];
              if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^(https?:|mailto:|ftp:)/i.test(href)) return true;
              e.preventDefault();
              cbs.current.onLinkClick?.(href, true);
              return true;
            }
          }
          return false;
        },
        contextmenu: (e, view) => {
          const cb = cbs.current.contextMenu;
          if (!cb) return false;
          e.preventDefault();
          const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
          const sel = view.state.selection.main;
          // 右键点在选区外时，把光标移到点击处并清除选区
          if (pos !== null && (pos < sel.from || pos > sel.to)) {
            view.dispatch({ selection: { anchor: pos } });
          }
          const s = view.state.selection.main;
          cb({
            x: e.clientX,
            y: e.clientY,
            sel: { from: s.from, to: s.to, text: view.state.sliceDoc(s.from, s.to) },
          });
          return true;
        },
      }),
    ];

    const view = new EditorView({
      state: EditorState.create({ doc: initialContent, extensions }),
      parent: hostRef.current,
    });
    viewRef.current = view;
    imeRef.current = installImeGuard(view);
    storeRef.current = initialContent;
    registerView?.(view);

    // 当前编辑块始终保留源码 DOM，输入法期间不执行打字机滚动。
    return () => {
      imeRef.current?.dispose();
      imeRef.current = null;
      registerView?.(null);
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    // Ctrl+/ 这类快捷键可以正好落在组合态里：重配会重建装饰 DOM，把预编辑一起丢掉。
    whenImeIdle(() => {
      if (viewRef.current === view) view.dispatch({ effects: mode.current.reconfigure(modeExtensions(sourceMode)) });
    }, "mode");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceMode]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !typewriterMode) return;
    whenImeIdle(() => {
      if (viewRef.current === view) view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: "center" }) });
    }, "typewriter");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typewriterMode]);

  // 外部内容变化时同步（例如从别处加载）
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    // 如果 initialContent 的变化是由本组件自己的 onChange 引起的回显，直接更新基线，跳过 dispatch
    if (echoRef.current === initialContent) {
      echoRef.current = null;
      storeRef.current = initialContent;
      return;
    }
    const incoming = initialContent;
    // 基线要在「外部内容到达的这一刻」定下来：它是外部作者看到的那份正文。
    // 组合态里它还会被 onChange 回显继续刷新，等到落定时再读就变成当前正文了，
    // 那样会把用户刚提交的字当成外部内容整篇替换掉。
    const base = storeRef.current ?? incoming;
    storeRef.current = incoming;
    const apply = () => {
      if (viewRef.current !== view) return;
      const cur = view.state.doc.toString();
      const plan = planExternalSync(base, cur, incoming);
      if (plan.kind === "noop") return;
      if (plan.kind === "replace") {
        view.dispatch({
          changes: { from: 0, to: cur.length, insert: incoming },
        });
        return;
      }
      if (plan.kind === "merge") {
        view.dispatch({ changes: { from: plan.from, to: plan.to, insert: plan.insert } });
        return;
      }
      // 外部内容来自组合中的旧文本、改动又重叠，直接整篇替换会把用户刚提交的字冲掉。
      // 保留本地正文，并把文档重新声明为真源，避免 store 与正文长期不一致。
      cbs.current.onChange(cur);
    };
    if (imeRef.current?.idle() ?? true) apply();
    else whenImeIdle(apply, "external");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialContent]);

  return <div className={`editor-host${sourceMode ? " cm-source-mode" : ""}${focusMode ? " cm-focus" : ""}${typewriterMode ? " cm-typewriter" : ""}`} ref={hostRef} />;
}
