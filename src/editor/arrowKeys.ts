/*
 * 上下键：跨过「被即时预览渲染成块」的源码行时，先把光标送进那一块的源码，
 * 而不是整块跳过去。
 *
 * 背景：MyNovel 是「源码编辑 + 块级渲染」。渲染过的块在源码位置上依然存在
 * （点它就能编辑），但看不见 —— CodeMirror 默认的上下键按视觉行走，遇到这种
 * 「没有可见落脚点」的块就直接跨过去，于是一按 ↓ 就从一段跳到了下一段之外，
 * 手感不像 Word。（实测：从空行按 ↓ 会跳过整条软换行的长段落。）
 *
 * 做法：先让 CodeMirror 自己的 cursorLineDown/Up 跑一遍，再比较落点的行号：
 *   · 只相邻一行 → 正常的段内/相邻行移动，保留它的结果
 *     （段内软换行逐行移动保持不变，那部分本来就和 Word 一致）
 *   · 跳了不止一行 → 中间有渲染过的块，把光标改落到相邻那一行的行首/行尾，
 *     那一块随即成为「当前块」、源码显形；下一次上下键就在它内部逐行走。
 * 先跑默认命令、再纠正，都在同一个 keydown 里同步完成：命令行内不会有布局与绘制，
 * 浏览器只画最终位置，所以用户看不到中间那一步。
 */
import { cursorLineDown, cursorLineUp } from "@codemirror/commands";
import type { EditorView, KeyBinding } from "@codemirror/view";

function step(view: EditorView, dir: 1 | -1, move: (view: EditorView) => boolean): boolean {
  const sel = view.state.selection.main;
  if (!sel.empty) return false; // 有选区：一律交给默认（选区扩张语义）
  const startNo = view.state.doc.lineAt(sel.head).number;
  const moved = move(view);
  if (!moved) return true; // 已经在首/末行，什么也没发生，与默认一致
  const endNo = view.state.doc.lineAt(view.state.selection.main.head).number;
  if (Math.abs(endNo - startNo) <= 1) return true; // 正常移动（含段内逐视觉行），保留
  const nextNo = startNo + dir;
  if (nextNo < 1 || nextNo > view.state.doc.lines) return true;
  const next = view.state.doc.line(nextNo);
  view.dispatch({
    // 往下进入时停在行首，往上进入时停在行尾 —— 都对应「刚跨进这一段」
    selection: { anchor: dir === 1 ? next.from : next.to },
    scrollIntoView: true,
  });
  return true;
}

export const arrowKeys: KeyBinding[] = [
  { key: "ArrowDown", run: (view) => step(view, 1, cursorLineDown) },
  { key: "ArrowUp", run: (view) => step(view, -1, cursorLineUp) },
];
