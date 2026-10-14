/*
 * 列表相关的键位 —— 只为对齐 Typora 的三处差异而存在。
 *
 * Enter 续行（自动给出下一个标记与序号）、Tab / Shift+Tab 分级这些由
 * @codemirror/lang-markdown 与 defaultKeymap 提供，行为已经和 Typora 一致，这里不重复实现。
 * 补的是三条 Typora 有、而 MyNovel 之前缺的行为：
 *
 *   1) 空列表项上按 Enter → 摘掉标记、退出列表（Typora 就是靠这个退出列表的），
 *      而不是留下一个光秃秃的 "- "；
 *   2) 光标紧跟在标记之后按 Backspace → 整段删掉标记，不留空格（缩进保留，
 *      所以嵌套项仍留在原层级）；
 *   3) Typora 缩进的另一套键：Ctrl+[ 缩进、Ctrl+] 减少缩进（等同于 Tab / Shift+Tab）。
 *
 * 刻意不补的：公式块（Ctrl+Shift+M）、代码块（Ctrl+Shift+K）等 Typora 有但 MyNovel
 * 已经砍掉的功能不在这里复活。
 */
import { indentLess, indentMore } from "@codemirror/commands";
import type { EditorView, KeyBinding } from "@codemirror/view";

/** 行首的「缩进 + 标记 + 标记后的空白」；有序列表的标记支持 `1.` 与 `1)` 两种写法 */
const ITEM_PREFIX_RE = /^([ \t]*)([-*+]|\d+[.)])([ \t]+)/;

export const listKeys: KeyBinding[] = [
  {
    key: "Enter",
    run: (view: EditorView) => {
      const sel = view.state.selection.main;
      if (!sel.empty) return false; // 有选区时交给默认行为
      const line = view.state.doc.lineAt(sel.from);
      const m = ITEM_PREFIX_RE.exec(line.text);
      if (!m) return false;
      // 整行只有「标记 + 空白」，且光标在行尾 —— 这才是空列表项
      if (m[0].length !== line.text.length || sel.from !== line.to) return false;
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: "" },
        selection: { anchor: line.from },
        scrollIntoView: true,
        userEvent: "delete",
      });
      return true;
    },
  },
  {
    key: "Backspace",
    run: (view: EditorView) => {
      const sel = view.state.selection.main;
      if (!sel.empty) return false;
      const line = view.state.doc.lineAt(sel.from);
      const m = ITEM_PREFIX_RE.exec(line.text);
      if (!m) return false;
      const markerFrom = line.from + m[1].length; // 缩进之后
      const markerTo = line.from + m[0].length; // 标记及其后的空白
      if (sel.from !== markerTo) return false; // 光标必须正好停在标记之后
      view.dispatch({
        changes: { from: markerFrom, to: markerTo, insert: "" },
        selection: { anchor: markerFrom },
        userEvent: "delete",
      });
      return true;
    },
  },
  // Typora 的缩进另一套键（官方表：Indent = Ctrl+[、Outdent = Ctrl+]）
  { key: "Ctrl-[", run: indentMore },
  { key: "Ctrl-]", run: indentLess },
];
