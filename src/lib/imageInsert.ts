/*
 * 插入本地图片：选图 → 复制进工作区 assets/ → 插入相对路径。
 * root 为空（没打开工作区）时退化为直接插入用户选择的绝对路径。
 */
import type { EditorView } from "@codemirror/view";
import { resolveRelative } from "./mdExport";
import { useStore } from "../store";
import { api } from "../api";

function baseName(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || "image.png";
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
  for (const abs of srcs) {
    let href = abs;
    if (root) {
      try {
        href = await api.copyAsset(root, abs, "assets/" + baseName(abs));
      } catch {
        href = abs;
      }
    }
    if (root && !/^(?:[a-z]+:|\/)/i.test(href)) {
      const active = useStore.getState().activePath || "";
      const depth = active.split("/").length - 1;
      href = "../".repeat(depth) + resolveRelative("", href);
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

