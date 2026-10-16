/*
 * 工作区后端（从 src-tauri/src/vault.rs 逐条翻过来）。
 *
 * 这个文件是「安全边界」的所在地，翻的时候**语义一对一**，不要顺手「优化」：
 *   · safeJoin            相对路径规范化，拒绝绝对路径 / .. / 退化成根本身
 *   · ensureParentInside  最近的存在祖先 realpath 后必须落在工作区内（挡符号链接外逃）
 *   · ensureRealpathInside 连最后一级也解析（挡「符号链接冒充文件」）
 *   · atomicReplace       同目录临时文件 + O_EXCL + fsync + rename
 *   · base64Decode        严格校验（非规范编码一律拒绝）
 *   · ensureAbsExportTarget 导出出口：绝对路径、非链接、非目录、不覆盖 .md/.txt 手稿
 *
 * 原 Rust 侧对这些都有单测，这里同样有（scripts/test-vault.mjs），别把它们删了。
 */
"use strict";

const fsp = require("node:fs/promises");
const fs = require("node:fs");
const path = require("node:path");

/** 源文件扩展名：导出只写产物，绝不允许覆盖这些 */
const SOURCE_EXTENSIONS = ["md", "markdown", "mdx", "txt"];

/**
 * 相对路径的分隔符。Linux 上 `\` 是文件名里合法的普通字符，只有 Windows 把它当分隔符
 * （Rust 的 Component 也是这么分的）。所以这里按平台分，Linux 的行为与原来完全一致。
 */
const REL_SEP_RE = process.platform === "win32" ? /[\\/]/ : /\//;

/** 二进制导出单次允许写入的最大字节数（与 Rust 侧同一个量级） */
const MAX_BINARY_EXPORT_BYTES = 256 * 1024 * 1024;

/* ------------------------------------------------------------------ 路径校验 */

/** 目标是否在 root 之内（按路径分量比较，不用裸 startsWith 免得 /a/bc 命中 /a/b） */
function inside(target, root) {
  if (target === root) return true;
  return target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * 工作区相对路径 → 绝对路径。任何一段是 `..`、或者是绝对路径、或者整条退化成根，都拒绝。
 * 最后那条很关键：否则 deleteEntry(root, "") 能把整个工作区删掉。
 *
 * 分隔符必须是两种都切（Windows 上 `..\..\x` 与 `../../x` 等价）；
 * 只切 "/" 的话 `..\..\windows\win.ini` 会被当成一整段普通文件名，
 * 虽然后面 ensureParentInside 还能兜住，但这道闸门本身就是安全边界，不能破。
 */
function safeJoin(root, rel) {
  if (typeof rel !== "string" || rel.trim() === "") throw new Error("路径为空");
  if (path.isAbsolute(rel)) throw new Error(`非法路径: ${rel}`);
  const parts = rel.split(REL_SEP_RE).filter((s) => s !== "" && s !== ".");
  if (parts.length === 0) throw new Error(`非法路径: ${rel}`);
  for (const p of parts) {
    // Rust 侧只认 Normal 分量：`..` 及任何根前缀都会被拒
    if (p === ".." || p === "/" || p === "\\" || p.includes("\0")) throw new Error(`非法路径: ${rel}`);
  }
  return path.join(root, ...parts);
}

async function realpathOrNull(p) {
  try {
    return await fsp.realpath(p);
  } catch {
    return null;
  }
}

/**
 * 父目录的真实路径必须落在工作区内。
 * 否则 `root/link_outside/x.md` 这类路径会经由符号链接读写工作区外的位置。
 */
async function ensureParentInside(root, full) {
  const rootReal = await realpathOrNull(root);
  if (!rootReal) throw new Error("工作区不可访问");
  let cur = path.dirname(full);
  // 建目录之前父目录可能还不存在，所以往上找到第一个存在的祖先
  for (;;) {
    if (fs.existsSync(cur)) {
      const real = await realpathOrNull(cur);
      if (!real || !inside(real, rootReal)) {
        throw new Error(`路径超出工作区范围（符号链接指向外部）: ${cur}`);
      }
      return rootReal;
    }
    const up = path.dirname(cur);
    if (up === cur) return rootReal;
    cur = up;
  }
}

/**
 * 目标路径（必须已存在）的真实位置也必须落在工作区内。
 * 与 ensureParentInside 的区别：这里连**最后一级**也解析，
 * 所以 `root/secret.md -> /etc/passwd` 这种「符号链接冒充文件」也会被拦下。
 */
async function ensureRealpathInside(root, full) {
  const rootReal = await realpathOrNull(root);
  if (!rootReal) throw new Error("工作区不可访问");
  const real = await realpathOrNull(full);
  if (!real) throw new Error(`目标不可访问: ${full}`);
  if (!inside(real, rootReal)) {
    throw new Error(`路径超出工作区范围（符号链接指向外部）: ${full}`);
  }
}

/* ------------------------------------------------------------------ 扫描 */

function isHidden(full, root) {
  const rel = path.relative(root, full);
  if (!rel) return false;
  return rel.split(path.sep).some((s) => s.startsWith(".") || s === "node_modules");
}

/**
 * 递归收集节点。`obsidian` 目录的行为与 Rust 侧一致：**不把自己放进树里**，
 * 但仍然往下走（所以它里面的文件会以根级节点的形式出现）。
 */
async function collectNodes(root) {
  const nodes = new Map(); // rel -> { path, name, isDir }
  const walk = async (dir) => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (isHidden(full, root)) continue;
      const rel = path.relative(root, full).split(path.sep).join("/");
      let isDir = ent.isDirectory();
      if (ent.isSymbolicLink()) {
        // 跟随链接判断类型（扫描只负责展示，真正的读写另有 realpath 校验）
        try {
          isDir = (await fsp.stat(full)).isDirectory();
        } catch {
          continue;
        }
      }
      if (!(isDir && ent.name === "obsidian")) {
        nodes.set(rel, { path: rel, name: ent.name, isDir });
      }
      if (isDir) await walk(full);
    }
  };
  await walk(root);
  return nodes;
}

/** 组装成嵌套树；同级按名字排序（Rust 侧是 HashMap 无序，前端本来也会再排一次） */
async function buildTree(root) {
  const nodes = await collectNodes(root);
  const byParent = new Map(); // parentRel -> [childRel]
  for (const rel of nodes.keys()) {
    const parent = path.posix.dirname(rel);
    const key = parent === "." ? "" : parent;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(rel);
  }
  const build = (rel) => {
    const node = nodes.get(rel);
    const kids = (byParent.get(rel) ?? []).slice().sort();
    return {
      path: node.path,
      name: node.name,
      is_dir: node.isDir,
      children: node.isDir ? kids.map(build) : [],
    };
  };
  return (byParent.get("") ?? []).slice().sort().map(build);
}

function collectFiles(nodes) {
  const out = [];
  const walk = (n) => {
    if (!n.is_dir) {
      if (n.path.endsWith(".md") || n.path.endsWith(".txt")) out.push(n.path);
    } else {
      for (const c of n.children) walk(c);
    }
  };
  for (const n of nodes) walk(n);
  return out;
}

async function scanWorkspace(root) {
  let stat;
  try {
    stat = await fsp.stat(root);
  } catch {
    throw new Error("工作区目录不存在");
  }
  if (!stat.isDirectory()) throw new Error("工作区目录不存在");
  const tree = await buildTree(root);
  return { root, tree, files: collectFiles(tree) };
}

/* ------------------------------------------------------------------ 读写 */

/**
 * 换行统一成 LF 之后再交给上层。
 *
 * 编辑器（CodeMirror）的文档模型里没有 `\r`：把 "a\r\nb" 交给它，它存的是 "a\nb"。
 * 于是 CRLF 的手稿一打开就和盘上那份对不上，store 按「正文变了」把它标成未保存——
 * 用户没敲一个字，随手按一下 Ctrl+S 就会把整份稿子重写一遍；拆章更麻烦，
 * 它拿光标的 UTF-16 偏移去切字节，偏移量会少掉前面每一个 `\r`，切点落到正文中间。
 * Windows 上用记事本之类工具存出来的 .md 基本都是 CRLF，所以这个归一是必须的。
 *
 * 只在读入口做：写盘一律写 LF（编辑器本来就是 LF），
 * 与「用户改一下就保存」的结果一致，不会凭空改盘上的文件。
 */
function toLF(text) {
  return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}

async function readFile(root, rel) {
  const full = safeJoin(root, rel);
  if (!fs.existsSync(full)) return null;
  await ensureRealpathInside(root, full);
  const st = await fsp.stat(full);
  if (!st.isFile()) return null;
  const content = toLF(await fsp.readFile(full, "utf8"));
  return { path: rel, content };
}

async function fileExists(root, rel) {
  return fs.existsSync(safeJoin(root, rel));
}

async function writeFile(root, rel, content) {
  const full = safeJoin(root, rel);
  await ensureParentInside(root, full);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await atomicWrite(full, content);
}

async function createFile(root, rel, content) {
  const full = safeJoin(root, rel);
  await ensureParentInside(root, full);
  if (fs.existsSync(full)) throw new Error("文件已存在");
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await atomicWrite(full, content);
}

async function deleteEntry(root, rel) {
  const full = safeJoin(root, rel);
  // 1) 先确认父目录真实路径在工作区内：只有这一步通过，后面才允许对「链接本身」执行 unlink
  const rootReal = await ensureParentInside(root, full);

  // symlink_metadata：不跟随符号链接，才能区分「链接本身」和「链接指向的目录」
  let lstat;
  try {
    lstat = await fsp.lstat(full);
  } catch (e) {
    throw new Error(`目标不存在或不可访问: ${rel}（${e.message}）`);
  }

  // 2) 目标本身是符号链接：只删除链接本身，绝不跟随
  if (lstat.isSymbolicLink()) {
    await fsp.unlink(full);
    return;
  }

  // 3) 真实路径必须落在工作区内，且不能是工作区根目录
  const fullReal = await realpathOrNull(full);
  if (!fullReal) throw new Error("目标不可访问");
  if (fullReal === rootReal) throw new Error("不允许删除工作区根目录");
  if (!inside(fullReal, rootReal)) throw new Error(`路径超出工作区范围: ${rel}`);

  if (lstat.isDirectory()) await fsp.rm(full, { recursive: true, force: true });
  else await fsp.unlink(full);
}

async function renameEntry(root, rel, newRel) {
  const from = safeJoin(root, rel);
  const to = safeJoin(root, newRel);
  if (!fs.existsSync(from)) throw new Error(`源路径不存在: ${rel}`);
  await ensureRealpathInside(root, from);
  await ensureParentInside(root, to);
  try {
    const lstat = await fsp.lstat(to);
    if (lstat.isSymbolicLink()) throw new Error(`目标已是符号链接，拒绝覆盖: ${newRel}`);
  } catch (e) {
    if (e.message.includes("拒绝覆盖")) throw e;
    /* 目标不存在：正常 */
  }
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.rename(from, to);
}

async function createDir(root, rel) {
  const full = safeJoin(root, rel);
  await ensureParentInside(root, full);
  await fsp.mkdir(full, { recursive: true });
}

/* ------------------------------------------------------------------ 原子写入 */

/** 进程内递增序号，配合 pid + 纳秒时间戳保证临名不可预测 */
let tempSeq = 0;

function tempSibling(full) {
  const seq = tempSeq++;
  const nanos = Number(process.hrtime.bigint() % 1000000000n);
  const name = path.basename(full) || "out";
  const dir = path.dirname(full) || ".";
  return path.join(dir, `.${name}.mynovel-tmp-${process.pid}-${nanos}-${seq}`);
}

/**
 * 临时文件 + rename 的原子替换。三条硬约束（照抄 Rust 侧）：
 *   1) 临时文件与目标同目录且 O_EXCL 独占创建——绝不跟随预置的符号链接，绝不复用残留临时文件；
 *   2) 任何一步失败都清掉临时文件，真实错误照实抛（fsync 的错误也不吞）；
 *   3) 名字被占就换名重试，绝不覆盖别人的文件。
 */
async function atomicReplace(full, writeFn) {
  const ATTEMPTS = 8;
  let lastErr = null;
  for (let i = 0; i < ATTEMPTS; i++) {
    const tmp = tempSibling(full);
    let handle;
    try {
      handle = await fsp.open(tmp, "wx");
    } catch (e) {
      if (e.code === "EEXIST") {
        lastErr = e;
        continue;
      }
      throw new Error(`创建临时文件失败: ${e.message}`);
    }
    try {
      await writeFn(handle);
      await handle.sync();
    } catch (e) {
      await handle.close().catch(() => {});
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw new Error(`写入临时文件失败: ${e.message}`);
    }
    await handle.close().catch(() => {});
    try {
      await fsp.rename(tmp, full);
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw new Error(`替换目标文件失败: ${e.message}`);
    }
    return;
  }
  throw new Error(`无法创建唯一的临时文件（已重试 ${ATTEMPTS} 次）: ${lastErr ? lastErr.message : ""}`);
}

async function atomicWrite(full, content) {
  return atomicReplace(full, (h) => h.writeFile(content, "utf8"));
}

async function atomicWriteBytes(full, bytes) {
  return atomicReplace(full, (h) => h.writeFile(bytes));
}

/* ------------------------------------------------------------------ 侧车 */

/**
 * 侧车文件路径：`{work}/.novel/{name}.json`，work 为空时落在工作区根的 `.novel/` 下。
 * name 必须是单个文件名，不能借它跳出 .novel。
 */
function sidecarPath(root, work, name) {
  const n = String(name ?? "").trim();
  if (n === "") throw new Error("侧车文件名为空");
  if (n.includes("/") || n.includes("\\") || n === "." || n === "..") {
    throw new Error(`非法侧车文件名: ${n}`);
  }
  const w = String(work ?? "").trim();
  const rel = w === "" ? `.novel/${n}.json` : `${w}/.novel/${n}.json`;
  return safeJoin(root, rel);
}

async function readSidecar(root, work, name) {
  const p = sidecarPath(root, work, name);
  if (!fs.existsSync(p)) return null;
  await ensureRealpathInside(root, p);
  return fsp.readFile(p, "utf8");
}

async function writeSidecar(root, work, name, data) {
  const p = sidecarPath(root, work, name);
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await atomicWrite(p, data);
}

/* ------------------------------------------------------------------ 搜索 */

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildRegex(pattern, isRegex, caseSensitive) {
  const src = isRegex ? pattern : escapeRegExp(pattern);
  try {
    return new RegExp(src, caseSensitive ? "" : "i");
  } catch (e) {
    throw new Error(`正则无效: ${e.message}`);
  }
}

async function searchText(root, query, isRegex, caseSensitive) {
  const re = buildRegex(query, isRegex, caseSensitive);
  const hits = [];
  const walk = async (dir) => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (isHidden(full, root)) continue;
      let isDir = ent.isDirectory();
      if (ent.isSymbolicLink()) {
        try {
          isDir = (await fsp.stat(full)).isDirectory();
        } catch {
          continue;
        }
      }
      if (isDir) {
        await walk(full);
        continue;
      }
      const name = ent.name;
      if (!(name.endsWith(".md") || name.endsWith(".txt"))) continue;
      let content;
      try {
        content = await fsp.readFile(full, "utf8");
      } catch {
        continue;
      }
      const rel = path.relative(root, full).split(path.sep).join("/");
      const lines = content.split(/\r?\n/);
      lines.forEach((line, i) => {
        // 空正则不清空匹配状态；全局标志在 Rust 侧不存在，这里也不用 g
        if (re.test(line)) {
          hits.push({
            path: rel,
            line: i + 1,
            text: [...line].length > 200 ? [...line].slice(0, 200).join("") : line,
          });
        }
      });
    }
  };
  await walk(root);
  return hits;
}

/* ------------------------------------------------------------------ 拆章 */

/** UTF-16 偏移（浏览器侧的光标位置）→ 字节偏移。Rust 侧的 utf16_to_byte_offset 等价物 */
function utf16ToByteOffset(text, wanted) {
  if (wanted === 0) return 0;
  let units = 0;
  let bytes = 0;
  for (const ch of text) {
    const len = ch.length; // UTF-16 码元数
    if (units === wanted) return bytes;
    units += len;
    bytes += Buffer.byteLength(ch, "utf8");
    if (units === wanted) return bytes;
    if (units > wanted) return -1;
  }
  return units === wanted ? bytes : -1;
}

async function splitAtCursor(root, rel, offset, suffix) {
  const fc = await readFile(root, rel);
  if (!fc) throw new Error("文件不存在");
  const byteOffset = utf16ToByteOffset(fc.content, offset);
  if (byteOffset < 0) throw new Error("光标位置无效");
  const buf = Buffer.from(fc.content, "utf8");
  if (byteOffset === 0 || byteOffset >= buf.length) throw new Error("光标位置无效");

  const first = buf.subarray(0, byteOffset).toString("utf8");
  const second = buf.subarray(byteOffset).toString("utf8");

  const slash = rel.lastIndexOf("/");
  const dir = slash >= 0 ? rel.slice(0, slash) : "";
  const name = slash >= 0 ? rel.slice(slash + 1) : rel;
  const stem = name.replace(/\.md$/, "");
  const sfx = suffix ? suffix : "下";
  const join = (n) => (dir ? `${dir}/${n}` : n);
  const firstPath = join(`${stem}-上.md`);
  const secondPath = join(`${stem}-${sfx}.md`);

  // 先查再写：两个目标都已存在时直接拒绝，避免无声覆盖既有章节
  for (const p of [firstPath, secondPath]) {
    if (p !== rel && (await fileExists(root, p))) {
      throw new Error(`拆分目标已存在，未拆分: ${p}`);
    }
  }
  await writeFile(root, firstPath, first.replace(/\s+$/, "") + "\n");
  await writeFile(root, secondPath, "\n" + second.replace(/^\s+/, ""));
  await deleteEntry(root, rel);

  return {
    path: rel,
    firstPath,
    secondPath,
    firstTitle: `${stem}-上`,
    secondTitle: `${stem}-${sfx}`,
  };
}

/* ------------------------------------------------------------------ 图片 / 素材 */

function imageMime(ext) {
  switch (String(ext).toLowerCase()) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "svg":
      return "image/svg+xml";
    case "webp":
      return "image/webp";
    case "bmp":
      return "image/bmp";
    case "ico":
      return "image/x-icon";
    default:
      return null;
  }
}

/**
 * 读工作区内的图片并编码成 data URL。
 * 不存在 / 不是文件 / 扩展名不是图片 → 返回 null（不当作错误）；只有路径非法才抛。
 */
async function readImageDataUrl(root, rel) {
  const ext = path.extname(rel).replace(/^\./, "");
  const mime = imageMime(ext);
  if (!mime) return null;
  const full = safeJoin(root, rel);
  let st;
  try {
    st = await fsp.stat(full);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  await ensureRealpathInside(root, full);
  const bytes = await fsp.readFile(full);
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

function splitExt(name) {
  const i = name.lastIndexOf(".");
  return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ""];
}

/**
 * 把本机任意路径的素材复制进工作区。目标已存在时自动改名 a-1.png、a-2.png…，绝不覆盖。
 * 返回最终写入的相对路径。
 */
async function copyAsset(root, srcAbs, destRel) {
  if (!srcAbs || srcAbs.trim() === "") throw new Error("源路径为空");
  let srcStat;
  try {
    srcStat = await fsp.stat(srcAbs);
  } catch {
    throw new Error(`源文件不存在或不是文件: ${srcAbs}`);
  }
  if (!srcStat.isFile()) throw new Error(`源文件不存在或不是文件: ${srcAbs}`);

  const dest = safeJoin(root, destRel);
  await ensureParentInside(root, dest);
  const parent = path.dirname(dest);
  await fsp.mkdir(parent, { recursive: true });

  const slash = destRel.lastIndexOf("/");
  const dir = slash >= 0 ? destRel.slice(0, slash) : "";
  const name = slash >= 0 ? destRel.slice(slash + 1) : destRel;
  const [stem, ext] = splitExt(name);
  if (!stem) throw new Error(`非法目标文件名: ${destRel}`);

  let finalName = name;
  let target = path.join(parent, finalName);
  let n = 0;
  while (fs.existsSync(target)) {
    n += 1;
    if (n > 10000) throw new Error(`目标目录里重名文件过多: ${destRel}`);
    finalName = `${stem}-${n}${ext}`;
    target = path.join(parent, finalName);
  }
  await fsp.copyFile(srcAbs, target);
  return dir ? `${dir}/${finalName}` : finalName;
}

/* ------------------------------------------------------------------ 导出出口 */

/**
 * 导出出口的公共闸门。与工作区无关，所以不走 safeJoin；但必须是绝对路径。
 * 目标是符号链接 / 目录 / 手稿扩展名时一律拒绝。
 */
function ensureAbsExportTarget(p) {
  if (!p || p.trim() === "") throw new Error("路径为空");
  if (!path.isAbsolute(p)) throw new Error(`必须是绝对路径: ${p}`);
  let lstat = null;
  try {
    lstat = fs.lstatSync(p);
  } catch {
    lstat = null;
  }
  if (lstat) {
    if (lstat.isSymbolicLink()) throw new Error(`目标是符号链接，拒绝写入: ${p}`);
    if (lstat.isDirectory()) throw new Error(`目标是目录，无法写入文件: ${p}`);
    const ext = path.extname(p).replace(/^\./, "").toLowerCase();
    if (SOURCE_EXTENSIONS.includes(ext)) {
      throw new Error(`拒绝覆盖源文件（.${ext}）：请换一个导出文件名或目录`);
    }
  }
  return p;
}

/**
 * 严格 base64 解码。任何一条不满足都报错，绝不「猜着解码」：
 *   · 只允许 A-Za-z0-9+/ 与作为填充的 =（URL-safe 的 -_ 一律拒绝）
 *   · 去空白后长度是 4 的倍数，填充只出现在末尾（最多两个）
 *   · 末尾填充位必须是 0（拒绝非规范编码）
 */
function base64Decode(input) {
  const s = String(input ?? "");
  let clean = "";
  for (const ch of s) {
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") continue;
    if (ch === "=") {
      clean += ch;
      continue;
    }
    if (!/[A-Za-z0-9+/]/.test(ch)) throw new Error(`非法 base64 字符: ${JSON.stringify(ch)}`);
    clean += ch;
  }
  if (clean === "") throw new Error("base64 内容为空");
  if (clean.length % 4 !== 0) throw new Error("base64 长度不是 4 的倍数");
  let pad = 0;
  for (let i = clean.length - 1; i >= 0 && clean[i] === "="; i--) pad++;
  if (pad > 2) throw new Error("base64 填充过多");
  if (clean.slice(0, clean.length - pad).includes("=")) throw new Error("base64 填充只能出现在末尾");
  const body = clean.slice(0, clean.length - pad);

  const table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const out = [];
  for (let i = 0; i < body.length; i += 4) {
    const chunk = body.slice(i, i + 4);
    let n = 0;
    let bits = 0;
    for (const c of chunk) {
      n = (n << 6) | table.indexOf(c);
      bits += 6;
    }
    const bytesInChunk = Math.floor(bits / 8);
    const shift = bits % 8;
    if (shift !== 0 && (n & ((1 << shift) - 1)) !== 0) {
      throw new Error("base64 末尾有非零填充位（非规范编码）");
    }
    n >>>= shift;
    for (let b = bytesInChunk - 1; b >= 0; b--) out.push((n >>> (8 * b)) & 0xff);
  }
  if (out.length > MAX_BINARY_EXPORT_BYTES) {
    throw new Error(`导出数据过大: ${out.length} 字节（上限 ${MAX_BINARY_EXPORT_BYTES} 字节）`);
  }
  return Buffer.from(out);
}

/** 把 base64 编码的二进制写到任意绝对路径（「另存为」DOCX / EPUB 导出用） */
async function writeBinaryAbs(p, dataBase64) {
  const full = ensureAbsExportTarget(p);
  const bytes = base64Decode(dataBase64);
  const parent = path.dirname(full);
  if (parent && parent !== "") await fsp.mkdir(parent, { recursive: true });
  await atomicWriteBytes(full, bytes);
}

module.exports = {
  // atomicReplace / tempSibling / sidecarPath 本来是内部函数，这里导出只为让
  // scripts/test-vault.mjs 能像 Rust 侧的 #[cfg(test)] 一样直接验它们的行为。
  atomicReplace,
  tempSibling,
  sidecarPath,
  SOURCE_EXTENSIONS,
  MAX_BINARY_EXPORT_BYTES,
  safeJoin,
  toLF,
  ensureParentInside,
  ensureRealpathInside,
  inside,
  scanWorkspace,
  readFile,
  fileExists,
  writeFile,
  createFile,
  deleteEntry,
  renameEntry,
  createDir,
  readSidecar,
  writeSidecar,
  searchText,
  splitAtCursor,
  readImageDataUrl,
  copyAsset,
  writeBinaryAbs,
  ensureAbsExportTarget,
  base64Decode,
  utf16ToByteOffset,
  buildRegex,
};
