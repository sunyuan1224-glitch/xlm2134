/*
 * 快捷键的键位判定 + 「键位 → 动作」表。
 *
 * 为什么单独成文件：这份表就是「帮助 → 快捷键」列表的机器可读版本，
 * 应用层（App.tsx 的 window keydown）和真实 WebKit 测试
 * （scripts/shortcut-ui-webkit.test.tsx）都从它出发，避免文案、实现、测试三处各写一份。
 *
 * 关于 Shift：浏览器报的是**按住 Shift 之后那个符号**，所以 Ctrl+Shift+] 的
 * event.key 是 "}"、Alt+Shift+5 是 "%"、Ctrl+Shift+` 是 "~"。判定时统一折回
 * 基础键，这样「帮助」里写的 ] / 5 / ` 就能照样匹配。
 */
import type { FormatCmd } from "./format";

const SHIFTED_TO_BASE: Record<string, string> = {
  "}": "]",
  "{": "[",
  "~": "`",
  "|": "\\",
  ":": ";",
  '"': "'",
  "<": ",",
  ">": ".",
  "?": "/",
  "_": "-",
  "+": "=",
  "!": "1",
  "@": "2",
  "#": "3",
  "$": "4",
  "%": "5",
  "^": "6",
  "&": "7",
  "*": "8",
  "(": "9",
  ")": "0",
};

/** 把 event.key 折算成不带 Shift 的基础键（"}" → "]"、"%" → "5"） */
export function baseKey(key: string): string {
  const k = (key || "").toLowerCase();
  return SHIFTED_TO_BASE[k] ?? k;
}

/**
 * 一次 keydown 是不是 keys 描述的键位。
 * keys 写法：「Ctrl+1」「Ctrl+Shift+]」「Alt+Shift+5」「Ctrl+Shift+`」「F8」「Alt+↑」。
 * 修饰键必须**完全一致**（多按少按都不算），否则 Ctrl+Shift+5 会误命中 Ctrl+5。
 */
export function matchesKeys(keys: string, e: KeyboardEvent): boolean {
  const parts = keys.split("+");
  const main = parts[parts.length - 1];
  const wantMod = parts.includes("Ctrl") || parts.includes("Mod");
  const wantShift = parts.includes("Shift");
  const wantAlt = parts.includes("Alt");
  if ((e.ctrlKey || e.metaKey) !== wantMod) return false;
  if (e.shiftKey !== wantShift) return false;
  if (e.altKey !== wantAlt) return false;
  return baseKey(e.key) === baseKey(main);
}

export interface FormatHotkey {
  keys: string;
  cmd: FormatCmd;
}

/** 作用于正文的格式键位（走 lib/format.ts 的 runFormat） */
export const FORMAT_HOTKEYS: FormatHotkey[] = [
  { keys: "Ctrl+B", cmd: { k: "inline", style: "bold" } },
  { keys: "Ctrl+I", cmd: { k: "inline", style: "italic" } },
  { keys: "Ctrl+U", cmd: { k: "inline", style: "underline" } },
  { keys: "Alt+Shift+5", cmd: { k: "inline", style: "strike" } },
  { keys: "Ctrl+Shift+Q", cmd: { k: "quote" } },
  { keys: "Ctrl+Shift+]", cmd: { k: "list", kind: "ul" } },
  { keys: "Ctrl+Shift+[", cmd: { k: "list", kind: "ol" } },
  { keys: "Ctrl+Shift+D", cmd: { k: "paraDelete" } },
];

/** 需要弹一个对话框的键位（超链接、插入本地图片） */
export const DIALOG_HOTKEYS: { keys: string; dialog: "link" | "image" }[] = [
  { keys: "Ctrl+K", dialog: "link" },
  { keys: "Ctrl+Shift+I", dialog: "image" },
];

/**
 * 编辑器自带键位不够用的两条：
 *  - Ctrl+H：CodeMirror 的 searchKeymap 只绑了 Mod-f，Typora 用 Ctrl+H 开替换面板；
 *  - Ctrl+Shift+Z：historyKeymap 在 Linux/Windows 上重做是 Mod-y，Ctrl+Shift+Z 没人管。
 */
export const EDIT_HOTKEYS: { keys: string; edit: "replace" | "redo" }[] = [
  { keys: "Ctrl+H", edit: "replace" },
  { keys: "Ctrl+Shift+Z", edit: "redo" },
];
