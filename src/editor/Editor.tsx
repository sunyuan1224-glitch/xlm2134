import { useEffect, useMemo, useRef } from "react";
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
import { isInCode, livePreview, readBlockMetrics } from "./livePreview";
import { lineHeightHints } from "./lineHeightHints";
import { installImeGuard, planExternalSync, type ImeGuard } from "./ime";
import { listKeys } from "./listKeys";
import { arrowKeys } from "./arrowKeys";
import { inlineMarks } from "./inlineMarks";
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
  /**
   * 正文变化。`imePending = true` 表示这次正文来自「输入法还没落定」的那一段
   * （拼音未上屏，或刚上屏、提交还在落盘）：上层照收内容，但字数统计要等落定 ——
   * 落定那一刻会**再回调一次**（imePending=false），那一次才是可以计数的正文。
   * 别把这个参数当成「正文不完整」而丢掉。
   */
  onChange: (content: string, imePending: boolean) => void;
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

/**
 * 这份手稿是不是以中文为主（汉字多于拉丁字母）。
 *
 * 只用来决定要不要给 CodeMirror 的总高估算挂中文校准（规则在 src/typora.css 的
 * `.cm-cjk-wrap`）—— 那是「拖右侧滚动条，条和内容对不上」的根因：
 *
 *   CodeMirror 只测量已经画出来的行，屏幕外用「一行放得下多少字」估总高，而这个字宽是它
 *   临时插进正文的一行 ASCII 样本量出来的（"abc def ghi jkl mno pqr stu"）。中文里一个汉字
 *   约等于两个 ASCII 字符宽，于是屏幕外几乎不被算作折行、总高估少三成。这份估算会落成
 *   `.cm-gap` 垫片，就是浏览器滚动条的量程：往下拖时量程一路变长，滑块与内容越拖越对不上
 *   （实测 8 万字章节 83655px → 118020px，帧间隔却一直是正常的 16.4ms）。
 *
 * 纯英文稿件的字宽本来就是它量到的那个值，套上中文校准反而会估过头，所以只认
 * 「汉字比拉丁字母多」。只看前 2 万字：开文件时粗判一次就够，正文比例不会写几段就翻过来。
 */
function looksChinese(text: string): boolean {
  let cjk = 0;
  let latin = 0;
  for (const ch of text.slice(0, 20000)) {
    if (/[\u3400-\u4dbf\u4e00-\u9fff]/.test(ch)) cjk++;
    else if (/[A-Za-z]/.test(ch)) latin++;
  }
  return cjk > latin;
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
  /**
   * 中文手稿才挂总高估算校准。按 path 记忆：判定只看开文件那一刻的正文，
   * 打字过程中不需要重算（比例不会翻），也免得每敲一个字都扫一遍正文。
   * 类挂在 .editor-host 上（React 渲染时就带上，早于 CodeMirror 建视图与第一次测量 ——
   * 挂到编辑器元素上会晚一帧，第一次估算就已经用错了字宽）。
   */
  const cjkWrap = useMemo(() => looksChinese(initialContent), [path]);
  const cbs = useRef({ typewriterMode, onLinkClick, onHeadingClick, onChange, onSave, onCursor, onSelectionChange, contextMenu });
  cbs.current = { typewriterMode, onLinkClick, onHeadingClick, onChange, onSave, onCursor, onSelectionChange, contextMenu };

  const modeExtensions = (source: boolean): Extension[] => [
    syntaxHighlighting(source ? sourceHighlightStyle : highlightStyle),
    // 源码模式只看原文，所以即时预览与行内装饰都只挂在非源码模式
    ...(source
      ? [
          // 源码模式没有整块 widget，屏幕外全是纯文本行：逐行给高度提示，
          // 否则 CodeMirror 会把一大片没画出来的行揉成一个 gap 用粗公式估（实测漂 16%）
          lineHeightHints(() => readBlockMetrics(hostRef.current)),
        ]
      : [
          livePreview({
            onLink: (href, mod) => cbs.current.onLinkClick?.(href, mod),
            // 给「还没渲染到屏幕上的块」估高度用；懒读 + 缓存，见 livePreview.readBlockMetrics
            metrics: () => readBlockMetrics(hostRef.current),
            image: async src => {
              const root = useStore.getState().root;
              if (!root) return null;
              let decoded: string;
              try { decoded = decodeURIComponent(src); } catch { return null; }
              const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
              return api.readImageDataUrl(root, resolveRelative(dir, decoded));
            },
          }),
          inlineMarks,
        ]),
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

  /** 现在这份正文算不算「输入法还没落定」（预编辑中，或刚上屏、提交还在落盘） */
  const imePending = () => !(imeRef.current?.idle() ?? true);

  /**
   * 把**当前**正文报给 store（这次算「已落定」，字数照算）。
   *
   * 组合结束 / 提交落盘之后由 whenImeIdle 触发，所以现读文档 —— 不能用某次 update 里
   * 捕获的那份，那份可能还停在拼音上。多次组合变更会被守卫按 key 合并成一次。
   */
  const echoNow = () => {
    const view = viewRef.current;
    if (!view) return;
    const text = view.state.doc.toString();
    echoRef.current = text;
    cbs.current.onChange(text, false);
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
          /*
           * 正文照报，但把「输入法还没落定」一起报上去，让 store 先别动字数：
           * 组合期间文档里是 "nihao" 这种拼音（CodeMirror 会把预编辑文本同步进 state.doc，
           * 见 @codemirror/view 的 applyDOMChange），不是用户要写的字。
           *
           * 判据是 !guard.idle()（预编辑中 + 提交落盘前的那段宽限），不是 guard.composing：
           * 前者把「上屏那一次」也可能罩进来 —— 那正是我们要的。各引擎里「提交文本进文档」
           * 与 compositionend 的先后顺序不同，光靠「上屏那一下 composing 恰好为 false」
           * 会把提交漏掉（漏了就再也补不上：汉字一直不进字数）。所以这里不赌顺序，
           * 而是在**落定那一刻再补报一次**（下面 whenImeIdle(echoNow)），由那一次来落字数。
           */
          cbs.current.onChange(nextDoc, imePending());
          if (imePending()) whenImeIdle(echoNow, "echo");
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
      /*
       * 组合没结束就被拆掉（切文件、换视图模式）：把当前正文按「组合已结束」报一次。
       * 不报的话 store 那边 imePending 会一直挂着 true，字数一路冻着不更新
       * （冻到下一次真正敲键才解开）；而正文里那串没上屏的拼音此刻也确实留在文档里了，
       * 就当普通正文算 —— 这与「点开别处、拼音留在正文里」的既有行为一致。
       */
      cbs.current.onChange(view.state.doc.toString(), false);
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
      cbs.current.onChange(cur, imePending());
    };
    if (imeRef.current?.idle() ?? true) apply();
    else whenImeIdle(apply, "external");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialContent]);

  return (
    <div
      className={`editor-host${sourceMode ? " cm-source-mode" : ""}${focusMode ? " cm-focus" : ""}${typewriterMode ? " cm-typewriter" : ""}${cjkWrap ? " cm-cjk-wrap" : ""}`}
      ref={hostRef}
    />
  );
}
