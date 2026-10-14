/*
 * 插入本地图片：选图 → 复制进**本章所在目录**的 assets/ → 插入相对路径。
 * root 为空（没打开工作区）时退化为直接插入用户选择的绝对路径。
 *
 * 为什么放在"本章目录"而不是工作区根：这样一本书连同它的图都在书文件夹里，
 * 换台电脑只搬书目录也能正常显示（图片引用就是相对本章目录的 assets/xxx）。
 * 以前放工作区根、靠 ../ 往上数层数来指回去，一旦只搬书目录，图就全断了。
 */
import type { EditorView } from "@codemirror/view";
import { useStore } from "../store";
import { api } from "../api";

function baseName(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || "image.png";
}

/** 工作区相对路径里，章所在的那一层目录（根级章返回 ""） */
function activeDir(): string {
  const active = useStore.getState().activePath || "";
  const i = active.lastIndexOf("/");
  return i === -1 ? "" : active.slice(0, i);
}

export async function insertImageFromDisk(view: EditorView, root: string | null): Promise<void> {
  const sel = view.state.selection.main;
  const selected = view.state.sliceDoc(sel.from, sel.to).trim();
  let srcs: string[] = [];
  if (/\.(png|jpe?g|gif|svg|webp|bmp)$/i.test(selected) && !selected.includes("](")) {
    srcs = [selected];
  } else {
    try {
      const picked = await api.pickImageFiles();
      if (!picked || picked.length === 0) return;
      srcs = picked;
    } catch {
      return;
    }
  }
  const snippets: string[] = [];
  const dir = activeDir();
  const prefix = dir ? dir + "/" : "";
  for (const abs of srcs) {
    let href = abs;
    if (root) {
      try {
        // 落到本章目录下的 assets/；copyAsset 返回的是工作区相对路径，去掉本章目录前缀
        // 就是"从本章看过去"的引用（assets/xxx）
        const dest = prefix + "assets/" + baseName(abs);
        const full = await api.copyAsset(root, abs, dest);
        href = full.startsWith(prefix) ? full.slice(prefix.length) : full;
      } catch {
        href = abs;
      }
    }
    const alt = baseName(href).replace(/\.[^.]+$/, "");
    snippets.push(`![${alt}](${href})`);
  }
  if (snippets.length === 0) return;
  const text = snippets.join("\n");
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: text },
    selection: { anchor: sel.from + text.length },
  });
  view.focus();
}

