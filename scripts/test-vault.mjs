/*
 * 工作区后端的安全不变量（electron/vault.js）。
 *
 * 这批用例是从原来的 src-tauri/src/vault.rs（#[cfg(test)]，15 个）逐条搬过来的——
 * 覆盖的全是「不能退化」的东西：路径规范化、符号链接外逃、原子写入、base64 严格校验、
 * 导出不许覆盖手稿。换引擎时最容易出的错就是「顺手简化」掉其中某一条，
 * 所以这层测试必须跟着语言一起搬，而不是随 Rust 一起删掉。
 *
 * 运行：node scripts/test-vault.mjs
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const vault = require("../electron/vault.cjs");

let failed = 0;
function check(cond, msg) {
  if (cond) return;
  failed++;
  console.error(`✗ ${msg}`);
}
function ok(msg) {
  if (!failed) console.log(`✓ ${msg} 验证通过`);
}

/** 每个用例一个独立临时目录（进程号 + 时间戳 + 序号，不依赖第三方库） */
let seq = 0;
function tempDir() {
  const p = path.join(os.tmpdir(), `mynovel-test-${process.pid}-${Date.now()}-${seq++}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
}
function cleanup(...dirs) {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}
/** 断言「抛出」，并返回错误信息 */
function throws(fn, msg) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      return r.then(
        () => null,
        (e) => e.message,
      );
    }
    check(false, `${msg}（本该报错却成功了）`);
    return Promise.resolve(null);
  } catch (e) {
    return Promise.resolve(e.message);
  }
}
async function rejects(promise, msg) {
  try {
    await promise;
    check(false, `${msg}（本该报错却成功了）`);
    return null;
  } catch (e) {
    return e.message;
  }
}

/*
 * 前置：本机能不能建符号链接。
 *
 * 这套用例里「工作区外逃」的防护全靠符号链接来验（父目录链接、冒充文件的链接、
 * 预置的临时名链接），Windows 上普通用户默认建不了（要管理员，或者打开
 * 「设置 → 系统 → 开发者选项 → 开发人员模式」）。没有这项能力就等于这批边界没测，
 * 所以这里开头直接判定并给出可操作提示，而不是跑到第 105 行抛一个 EPERM 就没了。
 * Linux / macOS 上恒为 true，行为与从前一致。
 */
{
  const probeDir = tempDir();
  let canSymlink = true;
  try {
    fs.symlinkSync(path.join(probeDir, "target"), path.join(probeDir, "probe"));
  } catch {
    canSymlink = false;
  }
  cleanup(probeDir);
  if (!canSymlink) {
    console.error(
      [
        "✗ 本机不允许普通用户创建符号链接，工作区外逃的用例无法运行。",
        "  Windows：设置 → 系统 → 开发者选项 → 打开「开发人员模式」（需管理员），",
        "           或用管理员身份运行终端；之后重跑 npm run test:vault。",
        "  这批用例不能跳过——符号链接外逃正是它们要守的边界。",
      ].join("\n"),
    );
    process.exit(1);
  }
}

/* ------------------------------------------------------------------ 1. 路径规范化 */

{
  const root = tempDir();
  for (const bad of ["", "   ", ".", "./", "../escaped", "a/../../escaped", "/etc/passwd"]) {
    const e = await throws(() => vault.safeJoin(root, bad), `safeJoin 应拒绝 ${JSON.stringify(bad)}`);
    check(e !== null, `safeJoin 应拒绝 ${JSON.stringify(bad)}`);
  }
  check(vault.safeJoin(root, "valid/sub/file.md") === path.join(root, "valid", "sub", "file.md"), "合法相对路径应通过");
  ok("safeJoin 拒绝空/越界路径");
  cleanup(root);
}

/* ------------------------------------------------------------------ 2. 删除保护 */

{
  const root = tempDir();
  check((await throws(() => vault.deleteEntry(root, ""), "删空串")) !== null, "不能删空串");
  check((await throws(() => vault.deleteEntry(root, "."), "删 .")) !== null, "不能删 .");

  await vault.createFile(root, "ch01.md", "hello");
  check(fs.existsSync(vault.safeJoin(root, "ch01.md")), "创建的文件应存在");
  await vault.deleteEntry(root, "ch01.md");
  check(!fs.existsSync(vault.safeJoin(root, "ch01.md")), "删除后应不存在");

  await vault.createDir(root, "vol1");
  await vault.createFile(root, "vol1/c1.md", "c1");
  await vault.deleteEntry(root, "vol1");
  check(!fs.existsSync(vault.safeJoin(root, "vol1")), "目录应被递归删除");

  // 符号链接相关
  const outside = tempDir();
  const outsideFile = path.join(outside, "important.txt");
  fs.writeFileSync(outsideFile, "keep-me");

  await vault.createDir(root, "evil_dir");
  const linkPath = vault.safeJoin(root, "evil_dir/link_outside");
  fs.symlinkSync(outside, linkPath);
  await vault.deleteEntry(root, "evil_dir");
  check(fs.existsSync(outsideFile), "外部文件绝不能被误删");
  check(!fs.existsSync(linkPath), "目录内的符号链接应随目录一起消失");

  const directLink = vault.safeJoin(root, "link_file");
  fs.symlinkSync(outsideFile, directLink);
  await vault.deleteEntry(root, "link_file");
  check(fs.existsSync(outsideFile), "删链接不该伤及外部目标");
  check(!fs.existsSync(directLink), "链接本身应被删除");

  // 经父目录符号链接逃逸：删 / 写 / 建 三件都必须被拒
  const escapeLink = vault.safeJoin(root, "escape");
  fs.symlinkSync(outside, escapeLink);
  const innerLink = path.join(outside, "inner_link");
  fs.symlinkSync(outsideFile, innerLink);
  check(
    (await throws(() => vault.deleteEntry(root, "escape/inner_link"), "经父链接删除")) !== null,
    "经由父目录符号链接的删除必须被拒绝",
  );
  check(fs.existsSync(innerLink), "工作区外的链接不能被删除");

  check(
    (await throws(() => vault.createFile(root, "escape/new.md", "x"), "经父链接创建")) !== null,
    "经由父目录符号链接的写入必须被拒绝",
  );
  check(!fs.existsSync(path.join(outside, "new.md")), "外部不该出现 new.md");
  check(
    (await throws(() => vault.writeFile(root, "escape/new.md", "x"), "经父链接写入")) !== null,
    "write_file 同样必须被拒绝",
  );
  check(!fs.existsSync(path.join(outside, "new.md")), "外部不该出现 new.md（write）");
  check(
    (await throws(() => vault.createDir(root, "escape/newdir"), "经父链接建目录")) !== null,
    "create_dir 同样必须被拒绝",
  );
  check(!fs.existsSync(path.join(outside, "newdir")), "外部不该出现 newdir");

  ok("删除/写入的符号链接保护");
  cleanup(root, outside);
}

/* ------------------------------------------------------------------ 3. 扫描 */

{
  const root = tempDir();
  await vault.createFile(root, "chapter-1.md", "# 1");
  await vault.createDir(root, "卷一");
  await vault.createFile(root, "卷一/第01章.md", "# 卷一01");

  const ws = await vault.scanWorkspace(root);
  check(ws.files.length === 2, `应当扫到 2 个文件，实际 ${ws.files.length}`);
  check(ws.files.includes("chapter-1.md"), "应包含 chapter-1.md");
  check(ws.files.includes("卷一/第01章.md"), "应包含 卷一/第01章.md");
  check(ws.tree.some((n) => n.is_dir && n.name === "卷一"), "树里应有 卷一 目录");
  check(ws.tree.some((n) => !n.is_dir && n.name === "chapter-1.md"), "树里应有 chapter-1.md");
  // 隐藏项不进树
  await vault.createDir(root, ".novel");
  await vault.createFile(root, ".novel/plot.json", "{}");
  const ws2 = await vault.scanWorkspace(root);
  check(!ws2.files.some((f) => f.includes(".novel")), "隐藏目录不该被扫进来");
  ok("扫描与目录树");
  cleanup(root);
}

/* ------------------------------------------------------------------ 4. 图片 / 素材 / 二进制导出 */

{
  const root = tempDir();
  const outside = tempDir();

  const exportFile = path.join(outside, "export", "chapter.html");
  await vault.writeBinaryAbs(exportFile, Buffer.from("<h1>Hello</h1>").toString("base64"));
  check(fs.readFileSync(exportFile, "utf8") === "<h1>Hello</h1>", "二进制导出内容应正确");

  const srcImg = path.join(outside, "sample.png");
  fs.writeFileSync(srcImg, Buffer.from("fake-png-data"));

  const rel1 = await vault.copyAsset(root, srcImg, "assets/sample.png");
  check(rel1 === "assets/sample.png", `首次复制应原名，实际 ${rel1}`);
  const rel2 = await vault.copyAsset(root, srcImg, "assets/sample.png");
  check(rel2 === "assets/sample-1.png", `第二次应自动改名，实际 ${rel2}`);
  const rel3 = await vault.copyAsset(root, srcImg, "assets/sample.png");
  check(rel3 === "assets/sample-2.png", `第三次应自动改名，实际 ${rel3}`);

  const url = await vault.readImageDataUrl(root, "assets/sample.png");
  check(url && url.startsWith("data:image/png;base64,"), "图片应读成 data URL");
  check(
    url === `data:image/png;base64,${Buffer.from("fake-png-data").toString("base64")}`,
    "data URL 的 base64 内容应一致",
  );
  check((await vault.readImageDataUrl(root, "chapter.md")) === null, "非图片返回 null");
  check((await vault.readImageDataUrl(root, "assets/not-exist.png")) === null, "不存在返回 null");
  check(
    (await throws(() => vault.readImageDataUrl(root, "../sample.png"), "越界读图")) !== null,
    "越出工作区读图应报错",
  );
  check(
    (await throws(() => vault.copyAsset(root, srcImg, "../sample.png"), "越界复制")) !== null,
    "越出工作区复制应报错",
  );

  const validB64 = Buffer.from("PK\x03\x04test-docx-payload", "binary").toString("base64");
  const binExport = path.join(outside, "export", "test.docx");
  await vault.writeBinaryAbs(binExport, validB64);
  check(
    fs.readFileSync(binExport).toString("binary") === "PK\x03\x04test-docx-payload",
    "docx 导出内容应正确",
  );
  check(
    (await throws(() => vault.writeBinaryAbs("relative/path.docx", validB64), "相对路径")) !== null,
    "相对路径必须被拒绝",
  );
  check(
    (await throws(() => vault.writeBinaryAbs(binExport, "bad*characters"), "非法 base64")) !== null,
    "非法 base64 字符必须被拒绝",
  );
  const manuscript = path.join(outside, "chapter01.md");
  fs.writeFileSync(manuscript, "# 珍贵手稿");
  check(
    (await throws(() => vault.writeBinaryAbs(manuscript, validB64), "覆盖手稿")) !== null,
    "导出绝不允许覆盖 .md 手稿",
  );
  check(fs.readFileSync(manuscript, "utf8") === "# 珍贵手稿", "手稿内容必须原封不动");
  check(
    (await throws(() => vault.writeBinaryAbs(path.join(outside, "export"), validB64), "写入目录")) !==
      null,
    "目标是目录必须被拒绝",
  );

  ok("图片 data URL / 素材复制 / 二进制导出");
  cleanup(root, outside);
}

/* ------------------------------------------------------------------ 5. base64 严格解码 */

{
  const enc = (s) => Buffer.from(s, "utf8").toString("base64");
  check((await throws(() => vault.base64Decode(enc("")), "空内容")) !== null, "空内容应拒绝");
  for (const s of ["f", "fo", "foo", "foob", "fooba", "foobar"]) {
    const got = vault.base64Decode(enc(s));
    check(got.toString("utf8") === s, `roundtrip ${s}`);
  }
  // 中文（多字节）也要能回来
  const cn = "夜里落了一场很轻的雨";
  check(vault.base64Decode(enc(cn)).toString("utf8") === cn, "多字节内容 roundtrip");

  check((await throws(() => vault.base64Decode("abc"), "长度 3")) !== null, "长度不是 4 的倍数应拒绝");
  check((await throws(() => vault.base64Decode("===="), "全填充")) !== null, "全填充应拒绝");
  check((await throws(() => vault.base64Decode("Zm=8"), "中间填充")) !== null, "填充在中间应拒绝");
  check((await throws(() => vault.base64Decode("ab-_"), "URL-safe")) !== null, "URL-safe 字母表应拒绝");

  ok("base64 严格解码");
}

/* ------------------------------------------------------------------ 6. 原子写入 */

{
  const dir = tempDir();
  const full = path.join(dir, "out.epub");

  // 临时名：同目录、不可预测、两次不同
  const a = vault.tempSibling(full);
  const b = vault.tempSibling(full);
  check(a !== b, "两次取到的临时名必须不同（否则并发会撞在一起）");
  check(path.dirname(a) === path.dirname(full), "临时文件必须与目标同目录（rename 才原子）");
  check(path.basename(a).startsWith(".out.epub"), `临时名应能看出属于哪个目标: ${path.basename(a)}`);
  check(path.basename(a).includes("mynovel-tmp"), `临时名应带固定前缀: ${path.basename(a)}`);

  // 失败必须清干净并把真实错误传出来
  const err = await rejects(
    vault.atomicReplace(full, async () => {
      throw new Error("boom-write");
    }),
    "写入失败",
  );
  check(err && err.includes("boom-write"), `真实错误必须原样上报: ${err}`);
  check(!fs.existsSync(full), "写入失败时绝不能留下目标文件");
  check(fs.readdirSync(dir).length === 0, `失败后必须清理临时文件: ${fs.readdirSync(dir)}`);

  // 预置的「可预测临时路径」符号链接绝不能被跟随
  const victim = path.join(dir, "受害文件.docx");
  fs.writeFileSync(victim, "ORIGINAL-VICTIM");
  const target = path.join(dir, "book.epub");
  const predictable = target.replace(/\.epub$/, `.tmp-${process.pid}`);
  const predictableDot = path.join(dir, `.book.epub.tmp-${process.pid}`);
  fs.symlinkSync(victim, predictable);
  fs.symlinkSync(victim, predictableDot);
  const payload = Buffer.from("PK\x03\x04-new-epub-payload", "binary");
  await vault.writeBinaryAbs(target, payload.toString("base64"));
  check(fs.readFileSync(target).toString("binary") === payload.toString("binary"), "导出目标应写入完整数据");
  check(fs.readFileSync(victim, "utf8") === "ORIGINAL-VICTIM", "绝不能跟随预置的临时符号链接写到受害文件");
  check(fs.lstatSync(predictable).isSymbolicLink(), "预置链接应原样留着");
  check(
    fs.readdirSync(dir).filter((n) => n.includes("mynovel-tmp")).length === 0,
    "不应留下临时文件",
  );

  // 同进程并发写同一目标：结果必须是某一个写手的完整内容，不能混写
  const concDir = tempDir();
  const concTarget = path.join(concDir, "并发导出.epub");
  fs.writeFileSync(concTarget, "OLD-CONTENT");
  const WRITERS = 8;
  const LEN = 4096;
  const payloads = [];
  for (let i = 0; i < WRITERS; i++) {
    const p = Buffer.alloc(LEN);
    for (let k = 0; k < LEN; k++) p[k] = (i * 37 + k * 13) % 251;
    payloads.push(p);
  }
  await Promise.all(payloads.map((p) => vault.writeBinaryAbs(concTarget, p.toString("base64"))));
  const finalBytes = fs.readFileSync(concTarget);
  check(
    payloads.some((p) => p.equals(finalBytes)),
    "最终内容必须是某一个写手的完整内容（不能混写、不能半截）",
  );
  check(
    fs.readdirSync(concDir).length === 1,
    `并发写入不应留下临时文件: ${fs.readdirSync(concDir)}`,
  );

  ok("原子写入（临时名 / 失败清理 / 预置链接 / 并发）");
  cleanup(dir, concDir);
}

/* ------------------------------------------------------------------ 7. 读 / 改名的边界 */

{
  const root = tempDir();
  const outsideDir = tempDir();
  const outsideFile = path.join(outsideDir, "secret.md");
  fs.writeFileSync(outsideFile, "工作区外的机密");

  // 工作区里的「章节」其实是指向工作区外的软链接
  fs.symlinkSync(outsideFile, path.join(root, "第一章.md"));
  check(
    (await throws(() => vault.readFile(root, "第一章.md"), "读越界链接")) !== null,
    "读取越界软链接必须报错，而不是照读内容",
  );

  // 工作区内的正常软链接仍可读
  const insideTarget = path.join(root, "真章.md");
  fs.writeFileSync(insideTarget, "正常内容");
  fs.symlinkSync(insideTarget, path.join(root, "别名.md"));
  const good = await vault.readFile(root, "别名.md");
  check(good && good.content === "正常内容", "工作区内的软链接应当仍可读");

  // 改名不能借父目录软链接跨界
  const outside2 = tempDir();
  const outsideFile2 = path.join(outside2, "外部.md");
  fs.writeFileSync(outsideFile2, "外部内容");
  fs.symlinkSync(outside2, path.join(root, "link_outside"));
  await vault.createFile(root, "我的章.md", "我的正文");
  check(
    (await throws(() => vault.renameEntry(root, "link_outside/外部.md", "偷来的.md"), "跨界移入")) !==
      null,
    "经软链接的跨边界重命名必须被拒绝",
  );
  check(!fs.existsSync(path.join(root, "偷来的.md")), "不该出现偷来的文件");
  check(
    (await throws(() => vault.renameEntry(root, "我的章.md", "link_outside/搬走.md"), "跨界移出")) !==
      null,
    "把正文搬到工作区外必须被拒绝",
  );
  check(fs.existsSync(path.join(root, "我的章.md")), "正文必须还在原处");

  ok("读取与改名的符号链接边界");
  cleanup(root, outsideDir, outside2);
}

/* ------------------------------------------------------------------ 8. 导出出口 */

{
  const dir = tempDir();
  const payload = Buffer.from("<html>").toString("base64");
  for (const ext of ["md", "markdown", "mdx", "txt", "MD"]) {
    const target = path.join(dir, `稿.${ext}`);
    fs.writeFileSync(target, "原稿");
    const e = await rejects(vault.writeBinaryAbs(target, payload), `${ext} 覆盖`);
    check(e && e.includes("拒绝覆盖源文件"), `${ext} 应被拒绝，实际: ${e}`);
    check(fs.readFileSync(target, "utf8") === "原稿", `${ext} 内容应原封不动`);
  }
  const html = path.join(dir, "导出.html");
  await vault.writeBinaryAbs(html, payload);
  check(fs.readFileSync(html, "utf8") === "<html>", "正常的 .html 出口照常可写");

  const victim = path.join(dir, "victim.html");
  fs.writeFileSync(victim, "别动");
  const link = path.join(dir, "link.html");
  fs.symlinkSync(victim, link);
  check(
    (await throws(() => vault.writeBinaryAbs(link, payload), "写链接")) !== null,
    "符号链接一律拒绝",
  );
  check(fs.readFileSync(victim, "utf8") === "别动", "受害文件内容不该变");

  ok("导出出口不许覆盖手稿 / 符号链接");
  cleanup(dir);
}

/* ------------------------------------------------------------------ 9. 侧车路径 */

{
  const root = tempDir();
  check(
    vault.sidecarPath(root, "", "plot") === path.join(root, ".novel", "plot.json"),
    "work 为空应落在工作区根的 .novel/",
  );
  check(
    vault.sidecarPath(root, "第一卷", "timeline") ===
      path.join(root, "第一卷", ".novel", "timeline.json"),
    "常规作品目录",
  );
  const bad = [
    ["..", "plot"],
    ["../..", "plot"],
    ["/etc", "plot"],
    ["", "../plot"],
    ["", "a/b"],
    ["", ".."],
    ["", ""],
  ];
  for (const [work, name] of bad) {
    check(
      (await throws(() => vault.sidecarPath(root, work, name), `侧车 ${work}/${name}`)) !== null,
      `侧车路径必须拒绝 work=${JSON.stringify(work)} name=${JSON.stringify(name)}`,
    );
  }
  await vault.writeSidecar(root, "", "plot", '{"items":[]}');
  check(
    (await vault.readSidecar(root, "", "plot")) === '{"items":[]}',
    "work='' 时读写应真正落到工作区根",
  );
  ok("侧车路径始终经过校验");
  cleanup(root);
}

/* ------------------------------------------------------------------ 10. 拆章不覆盖 */

{
  const root = tempDir();
  await vault.createFile(root, "第一章.md", "上半段\n下半段\n");
  await vault.createFile(root, "第一章-上.md", "既有的上");
  check(await vault.fileExists(root, "第一章-上.md"), "已存在的文件应当报 true");
  check(!(await vault.fileExists(root, "不存在的.md")), "不存在应当报 false");

  /*
   * Rust 侧那个同名用例其实只验了 file_exists，没真的跑拆分（名不副实）。
   * 这里把真正的行为补上：目标 -上.md 已存在时必须拒绝，且原文完好。
   */
  const before = fs.readFileSync(path.join(root, "第一章.md"), "utf8");
  const e = await rejects(vault.splitAtCursor(root, "第一章.md", 3, "下"), "拆到已存在目标");
  check(e && e.includes("拆分目标已存在"), `目标已存在时应当拒绝，实际: ${e}`);
  check(!fs.existsSync(path.join(root, "第一章-下.md")), "失败时不该写出 -下.md");
  check(fs.readFileSync(path.join(root, "第一章.md"), "utf8") === before, "失败时原文必须完好");

  // 目标不冲突时应当拆成功
  const root2 = tempDir();
  await vault.createFile(root2, "第二章.md", "上半段\n下半段\n");
  const res = await vault.splitAtCursor(root2, "第二章.md", 3, "下");
  check(res.firstPath === "第二章-上.md", `上篇路径，实际 ${res.firstPath}`);
  check(res.secondPath === "第二章-下.md", `下篇路径，实际 ${res.secondPath}`);
  check(res.firstTitle === "第二章-上" && res.secondTitle === "第二章-下", "标题应带 -上/-下");
  check(!fs.existsSync(path.join(root2, "第二章.md")), "拆完原文件应当被删除");
  const up = fs.readFileSync(path.join(root2, "第二章-上.md"), "utf8");
  const down = fs.readFileSync(path.join(root2, "第二章-下.md"), "utf8");
  check(up + down.replace(/^\n/, "") === "上半段\n下半段\n", `拆出来的两半合起来应等于原文：${JSON.stringify(up)} + ${JSON.stringify(down)}`);

  ok("拆章不覆盖既有文件");
  cleanup(root, root2);
}

/* ------------------------------------------------------------------ 11. 搜索 */

{
  const root = tempDir();
  await vault.createFile(root, "a.md", "第一行\n夜里落了一场雨\n第三行\n");
  await vault.createFile(root, "b.txt", "另一个文件\n雨停了\n");
  await vault.createDir(root, ".hidden");
  await vault.createFile(root, ".hidden/c.md", "夜里\n");

  const plain = await vault.searchText(root, "夜里", false, true);
  check(plain.length === 1, `普通搜索应命中 1 条，实际 ${plain.length}`);
  check(plain[0].path === "a.md" && plain[0].line === 2, `命中位置应为 a.md:2，实际 ${JSON.stringify(plain[0])}`);

  const ci = await vault.searchText(root, "雨", false, true);
  check(ci.length === 2, `「雨」应命中两处（含 b.txt），实际 ${ci.length}`);
  check(!ci.some((h) => h.path.includes(".hidden")), "隐藏目录不该被搜到");

  // 锚点要真的生效：^夜里 只该命中第 2 行（第 1、3 行都不以「夜里」开头）
  const anchored = await vault.searchText(root, "^夜里", true, true);
  check(
    anchored.length === 1 && anchored[0].line === 2,
    `正则锚点搜索应只命中第 2 行，实际 ${JSON.stringify(anchored)}`,
  );
  // ^第.行$ 头尾两行都符合（第一行 / 第三行），用来验一条正则能命中多行
  const re = await vault.searchText(root, "^第.行$", true, true);
  check(
    re.length === 2 && re[0].line === 1 && re[1].line === 3,
    `^第.行$ 应命中第 1、3 行，实际 ${JSON.stringify(re.map((h) => h.line))}`,
  );
  check(
    (await throws(() => vault.searchText(root, "([", true, true), "坏正则")) !== null,
    "非法正则应当报错",
  );
  ok("全文搜索");
  cleanup(root);
}

/* ------------------------------------------------------------------ 12. 前端命令 ↔ 后端命令 */

{
  /*
   * 换引擎时最容易犯的错：前端 `api.ts` 里调了一个后端没实现的命令名，
   * 而这类错只有真的点到那个功能才会暴露（比如「全屏」要按 F11 才知道）。
   * 这里把两边的命令名都抠出来对一遍，一次把 18 个命令全兜住。
   */
  const apiSrc = readFileSync(new URL("../src/api.ts", import.meta.url), "utf8");
  const mainSrc = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");

  const frontend = new Set(
    [...apiSrc.matchAll(/(?:call|invoke)(?:<[^>]*>)?\(\s*"([a-z_]+)"/g)].map((m) => m[1]),
  );
  const block = mainSrc.slice(mainSrc.indexOf("const commands = {"), mainSrc.indexOf("ipcMain.handle("));
  // 只认 commands 对象里**顶格两格缩进**的条目：再深一层的都是对话框选项之类的字段
  // （filters / properties…），放宽了会把它们也当成命令名，掩盖真正的缺漏。
  const backend = new Set(
    [...block.matchAll(/(?:^|\n)  (?:async\s+)?([a-z_]+)\s*[:(]/g)].map((m) => m[1]),
  );

  check(frontend.size >= 15, `应当从前端抠出十几个命令名，实际 ${frontend.size}`);
  check(backend.size >= 15, `应当从后端抠出十几个命令名，实际 ${backend.size}`);

  for (const cmd of frontend) {
    check(backend.has(cmd), `前端调用了后端没有的命令：${cmd}（后端有：${[...backend].sort().join(", ")}）`);
  }
  // 后端多出来的命令不算错（可能是给测试或未来用的），但打出来提醒一句
  const orphans = [...backend].filter((c) => !frontend.has(c));
  if (orphans.length) console.log(`  · 后端有而前端没调的命令：${orphans.sort().join(", ")}`);
  ok(`前端命令 ↔ 后端命令（${frontend.size} 个）`);
}

/* ------------------------------------------------------------------ 13. 换行归一 */

{
  /*
   * 编辑器（CodeMirror）的文档模型里没有 `\r`：给它 "a\r\nb"，它存的是 "a\nb"。
   * 所以 CRLF 的手稿必须在读入口就归一，否则：① 一打开就被标成「未保存」，
   * 顺手按 Ctrl+S 会白重写整份稿子；② 拆章拿光标的 UTF-16 偏移去切字节，
   * 偏移会少掉前面每一个 `\r`，切点落进汉字中间。Windows 上手稿基本都是 CRLF。
   */
  const root = tempDir();
  const crlf = "# 第一章\r\n\r\n她在雨里站了很久。\r\n第二行\r\n";
  fs.writeFileSync(path.join(root, "crlf.md"), crlf);

  const fc = await vault.readFile(root, "crlf.md");
  check(fc.content === "# 第一章\n\n她在雨里站了很久。\n第二行\n", `CRLF 应归一到 LF：${JSON.stringify(fc.content)}`);
  check(!fc.content.includes("\r"), "读出来的正文里不该还有 \\r");
  check(
    fs.readFileSync(path.join(root, "crlf.md"), "utf8") === crlf,
    "只读不能动盘上的文件（字节原样）",
  );
  check(vault.toLF("a\rb") === "a\nb", "单独的 \\r 也要归一");
  check(vault.toLF("# 标题\n") === "# 标题\n", "LF 原样返回，不做多余改动");

  // 拆章：光标偏移是编辑器（LF 文档）给的，落到 CRLF 文件上也必须切在同一个字后面
  await vault.createFile(root, "第二章.md", "# 第二章\r\n\r\n上半段\r\n下半段\r\n");
  const res = await vault.splitAtCursor(root, "第二章.md", "# 第二章\n\n上半段".length, "下");
  const up = fs.readFileSync(vault.safeJoin(root, res.firstPath), "utf8");
  const down = fs.readFileSync(vault.safeJoin(root, res.secondPath), "utf8");
  check(up.includes("上半段") && !up.includes("下半段"), `切点不该跑进下半段：${JSON.stringify(up)}`);
  check(down.startsWith("\n下半段"), `下篇应以「下半段」开头：${JSON.stringify(down)}`);

  ok("CRLF 手稿的换行归一");
  cleanup(root);
}

/* ------------------------------------------------------------------ */

if (failed > 0) {
  console.error(`\n✗ 工作区后端安全不变量：${failed} 项失败`);
  process.exit(1);
}
console.log("=== 所有 工作区后端安全不变量 测试通过 ===");
