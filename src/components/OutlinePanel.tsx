/*
 * 左侧「大纲」页：整个工作区的纲要导航树。
 *
 * 纲要（总纲 / 卷纲 / 章节纲要）都是书文件夹里 outline/ 下的普通 .md 文件，
 * 不在文件树里露面。这里把它们按 书 → 卷 → 章 排成一棵树：
 *   - 书行   = 这本书的总纲   book/outline/总纲.md    （固定名，排在最上面）
 *   - 卷行   = 该卷的卷纲     book/outline/<卷目录名>.md
 *   - 章行   = 该章的章节纲要 book/outline/<章文件名>.md（还没有时显示成虚线「＋」）
 *
 * 这个页面只负责「找」，不负责「编」：点任意一行就在**正文编辑器**里打开它
 * （和章节一样是一个标签页），编辑、保存、另存都用正文那一套。
 *
 * 纲要一律挂在书文件夹下：直接散在工作区根目录（或根级卷里）的章不属于任何一本书，
 * 也就没有纲要，「新建章节纲要」对它们不可用。
 */
import { useCallback, useMemo, useState } from "react";
import type { FileNode } from "../api";
import { api } from "../api";
import { useStore } from "../store";
import { basename, dirName, isChapterFile, isOutlineFile } from "../lib/chapter";
import { isVolumeDir, sortTreeNodes } from "../lib/order";
import { BOOK_OUTLINE_NAME, OUTLINE_DIR, bookOutlinePath } from "../lib/volume";

/** 导航树里的一行 */
interface OutlineRow {
  /** 唯一键（折叠状态、React key 都用它） */
  id: string;
  /** 纲要文件路径 */
  path: string;
  kind: "book" | "volume" | "chapter" | "other";
  /** 行上显示的名字 */
  name: string;
  /** 缩进层级：书 = 0，卷 = 1，卷下的章 = 2 */
  depth: number;
  /** 文件是否已经存在（不存在时点一下就地创建） */
  exists: boolean;
  /** 有这条就是可折叠节点（书 / 卷），值是该目录的路径 */
  foldKey?: string;
}

/** 行尾的小标签 */
const TAG: Record<OutlineRow["kind"], string> = {
  book: "总纲",
  volume: "卷纲",
  chapter: "章节纲要",
  other: "纲要",
};

export function OutlinePanel() {
  const root = useStore((s) => s.root);
  const tree = useStore((s) => s.tree);
  const files = useStore((s) => s.files);
  const volumes = useStore((s) => s.volumes);
  const chapterOrder = useStore((s) => s.chapterOrder);
  const activePath = useStore((s) => s.activePath);
  const chapters = useStore((s) => s.chapters);
  const openFile = useStore((s) => s.openFile);
  const flippedBooks = useStore((s) => s.flippedBooks);

  const [busy, setBusy] = useState(false);
  /** 折叠起来的书 / 卷（默认全展开，所以记的是「塌下去的」） */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  /** 正在双击改名的纲要（路径 + 输入框里的新名，不含 .md） */
  const [renaming, setRenaming] = useState<{ path: string; value: string } | null>(null);

  const volumeSet = useMemo(() => new Set(volumes), [volumes]);
  /** 反转显示的书：这棵树要和文件树看到的一致，所以同一本书里也要倒过来列 */
  const flippedSet = useMemo(() => new Set(flippedBooks), [flippedBooks]);

  /**
   * 整棵纲要树：每本书一行总纲，下面按树序接卷纲与章节纲要。
   * 卷与章的先后取自 sortTreeNodes，所以和文件树里的排列一一对应。
   */
  const rows = useMemo<OutlineRow[]>(() => {
    const stem = (p: string) => basename(p).replace(/\.md$/i, "");
    const out: OutlineRow[] = [];
    // 逐行去 files / chapters 里线性搜一遍是 O(行数 × 文件数)，而每次折叠展开都要整棵重建；
    // 先建好查表，查询就都是 O(1)。
    const fileSet = new Set(files);
    const titleOf = new Map(chapters.map((c) => [c.path, c.title]));

    /**
     * 走一本「书」的子树：卷行 + 章行，非卷子目录继续往下找。
     * flipped = 这本书被「反转显示」了，逐层倒着列，和文件树里的顺序保持一致。
     */
    const walk = (
      nodes: FileNode[],
      depth: number,
      outlineDir: string,
      used: Set<string>,
      flipped: boolean,
    ) => {
      for (const n of flipped ? [...nodes].reverse() : nodes) {
        if (n.is_dir) {
          if (isOutlineFile(n.path)) continue;
          if (isVolumeDir(n.name, n.path, volumeSet)) {
            const outline = `${outlineDir}/${n.name}.md`;
            if (!used.has(outline)) {
              used.add(outline);
              out.push({
                id: `vol:${n.path}`,
                path: outline,
                kind: "volume",
                name: n.name,
                depth,
                exists: fileSet.has(outline),
                foldKey: n.path,
              });
            }
            if (!collapsed.has(n.path)) {
              walk(n.children ?? [], depth + 1, outlineDir, used, flipped);
            }
          } else {
            // 书目录下非卷的子目录：继续往下
            walk(n.children ?? [], depth, outlineDir, used, flipped);
          }
        } else if (isChapterFile(n.path)) {
          const outline = `${outlineDir}/${stem(n.path)}.md`;
          if (used.has(outline)) continue;
          used.add(outline);
          out.push({
            id: `ch:${n.path}`,
            path: outline,
            kind: "chapter",
            name: titleOf.get(n.path) || stem(n.path),
            depth,
            exists: fileSet.has(outline),
          });
        }
      }
    };

    const sorted = sortTreeNodes(tree, volumeSet, chapterOrder);
    for (const top of sorted) {
      // 一本书 = 顶层的普通文件夹（顶层卷不是书：它属于「没有书」的根级）
      if (!top.is_dir || isVolumeDir(top.name, top.path, volumeSet)) continue;
      const book = top.path;
      const outlineDir = `${book}/${OUTLINE_DIR}`;
      // 总纲：新位置优先，旧工作区的「书/总纲.md」兜底
      const canonical = bookOutlinePath(book);
      const legacy = `${book}/${BOOK_OUTLINE_NAME}`;
      const total = fileSet.has(canonical) ? canonical : legacy;
      const used = new Set<string>([total]);
      out.push({
        id: `book:${book}`,
        path: total,
        kind: "book",
        name: top.name,
        depth: 0,
        exists: fileSet.has(total),
        foldKey: book,
      });
      if (collapsed.has(book)) continue;

      walk(top.children ?? [], 1, outlineDir, used, flippedSet.has(book));

      // 兜底：outline/ 里没和任何卷、章对上号的纲要也别丢
      const rest = files
        .filter((p) => dirName(p.replace(/\\/g, "/")) === outlineDir && /\.md$/i.test(p))
        .filter((p) => !used.has(p))
        .sort((a, b) => basename(a).localeCompare(basename(b), "zh-CN"));
      for (const p of rest) {
        out.push({
          id: `other:${p}`,
          path: p,
          kind: "other",
          name: stem(p),
          depth: 1,
          exists: true,
        });
      }
    }
    return out;
  }, [tree, files, volumes, chapters, volumeSet, chapterOrder, collapsed, flippedSet]);

  /** 点一行：已存在就在正文区打开，还没有就先建出来再打开 */
  const openOrCreate = useCallback(
    async (row: OutlineRow) => {
      if (!root || busy) return; // 建文件期间先挡住第二次点击
      if (row.exists) {
        await openFile(row.path);
        return;
      }
      setBusy(true);
      try {
        const dir = dirName(row.path.replace(/\\/g, "/"));
        // 老工作区可能还没有 outline/ 目录：先补出来再落文件
        try {
          await api.createDir(root, dir);
        } catch {
          /* 目录已存在 */
        }
        await api.createFile(root, row.path, `# ${row.name}\n\n`);
        await useStore.getState().refresh();
        await openFile(row.path);
        useStore.getState().setStatus(`已创建 ${row.path}`);
      } catch (e) {
        useStore.getState().setStatus(`创建失败：${String(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [root, busy, openFile],
  );

  /** 折叠 / 展开一行（书、卷） */
  const toggleFold = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /**
   * 双击改名：纲要就是普通文件，名字可以随便改。
   * 总纲名固定（总纲.md），不给改；其余改成和卷/章无关的名字后，
   * 会落到这本书清单末尾的「纲要」一组里，仍然可编辑。
   */
  const commitRename = useCallback(async () => {
    const pending = renaming;
    setRenaming(null);
    if (!pending || !root) return;
    const name = pending.value.trim().replace(/[/\\]/g, "");
    if (!name) return;
    const newPath = `${dirName(pending.path.replace(/\\/g, "/"))}/${name}.md`;
    if (newPath === pending.path) return;
    if (files.includes(newPath)) {
      useStore.getState().setStatus(`已存在同名文件：${newPath}`);
      return;
    }
    try {
      await api.renameEntry(root, pending.path, newPath);
      await useStore.getState().refresh();
      useStore.getState().setStatus(`已重命名为 ${newPath}`);
    } catch (e) {
      useStore.getState().setStatus(`重命名失败：${String(e)}`);
    }
  }, [renaming, root, files]);

  if (!root) {
    return (
      <div className="outline-panel">
        <div className="outline-empty">打开工作区后显示大纲</div>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="outline-panel">
        <div className="outline-empty">
          <p>工作区里还没有书</p>
          <p className="outline-hint">
            纲要跟着书文件夹走：先建一本「书」，它下面会自动有 outline/总纲.md。
            <br />
            在左侧「文件」页的空白处右键 →「新建书」。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="outline-panel">
      <div className="outline-list">
        {rows.map((r) => (
          <div
            key={r.id}
            role="button"
            tabIndex={0}
            className={
              "outline-item kind-" +
              r.kind +
              (activePath === r.path ? " on" : "") +
              (r.exists ? "" : " missing")
            }
            style={{ paddingLeft: 6 + r.depth * 14 }}
            title={
              r.exists
                ? r.kind === "book"
                  ? `${r.path}（总纲名固定）`
                  : `${r.path}（双击改名）`
                : `${r.path}（点一下创建）`
            }
            onClick={() => void openOrCreate(r)}
            onDoubleClick={() => {
              if (r.exists && r.kind !== "book") {
                setRenaming({ path: r.path, value: basename(r.path).replace(/\.md$/i, "") });
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                void openOrCreate(r);
              }
            }}
          >
            {r.foldKey ? (
              <span
                className={"outline-twisty " + (collapsed.has(r.foldKey) ? "" : "open")}
                title={collapsed.has(r.foldKey) ? "展开" : "折叠"}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleFold(r.foldKey!);
                }}
              />
            ) : (
              <span className="outline-twisty outline-twisty-spacer" />
            )}
            {renaming?.path === r.path ? (
              <input
                className="outline-rename"
                autoFocus
                value={renaming.value}
                onChange={(e) => setRenaming({ path: r.path, value: e.target.value })}
                onClick={(e) => e.stopPropagation()}
                onBlur={() => void commitRename()}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") void commitRename();
                  else if (e.key === "Escape") setRenaming(null);
                }}
              />
            ) : (
              <span className="outline-item-name">{r.name}</span>
            )}
            <span className="outline-item-tag">{r.exists ? TAG[r.kind] : "＋"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default OutlinePanel;
