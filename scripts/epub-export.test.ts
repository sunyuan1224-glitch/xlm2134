/*
 * EPUB 离线导出的行为测试（纯 Node，复用既有 esbuild）。
 *
 * 覆盖：
 *   1. OCF 容器硬性要求：mimetype 是第一个条目、未压缩（method 0）、内容正确；
 *      META-INF/container.xml 指向 OPF；
 *   2. OPF：dc:identifier / dc:title / dc:language / dcterms:modified 齐全；
 *      manifest 里每一项都真实存在于包里；spine 的 idref 都在 manifest 里；nav 有 properties="nav"；
 *   3. 章节 XHTML：标签配对、& 已转义、没有脚本/事件属性/外部网络引用，图片 src 都能在包里找到；
 *   4. 图片资源：data URL 落成真实文件（image-N.png），manifest 有对应 media-type，封面单独登记一次；
 *   5. 降级：远程图不下载、缺失图明确报错、复杂块源码完整保留；
 *   6. 恶意输入：章节标题里的路径穿越、<script>、控制字符都不会破坏包结构；
 *   7. 可复现：同样输入 + 固定 identifier/modified 产出完全相同的字节；
 *   8. 目录：nav.xhtml 的锚点在章节里真实存在，toc.ncx（EPUB2 兼容）章节顺序与输入一致。
 */
import assert from "node:assert/strict";
import { buildEpub, isoTimestamp, randomUuid } from "../src/lib/epubExport";
import { validateExportTarget, saveEpubExport } from "../src/lib/exportActions";
import {
  PNG_2X3,
  assertZipMagic,
  assertBalancedXml,
  assertNoBareAmpersand,
  findIllegalXmlChars,
  assertNoScriptTraces,
  firstEntry,
  textOf,
  unzip,
} from "./export-test-kit";

console.log("=== EPUB 离线导出测试开始 ===");

const ID = "11111111-2222-4333-8444-555555555555";
const MODIFIED = "2026-10-06T00:00:00Z";

const chapter1 = `# 第一章 启程

清晨的微光洒在石阶上。这一段包含[外链](https://example.com/a)与[内锚](#section)。

## 第一节 出发

![本地插画](assets/pic.png)

![远程图片](https://example.com/remote.png)

![缺失图片](assets/missing.png)

- 装备
  - 短剑
  - 干粮

> 引用一段。

| 地点 | 距离 |
| --- | --- |
| 营地 | 10km |

\`\`\`js
const x = 1 < 2;
\`\`\`

公式 $E = mc^2$ 与脚注[^1]。

[^1]: 这是脚注内容。

\`\`\`mermaid
graph TD
  A --> B
\`\`\`
`;

const chapter2 = `# 第二章 夜宿

夜里下起了雨。
`;

const fakeReadImage = async (_root: string, path: string) =>
  path === "ch/assets/pic.png" ? PNG_2X3 : null;

const epub = await buildEpub({
  title: "测试之书",
  author: "测试作者",
  root: "/fake/root",
  readImage: fakeReadImage,
  identifier: ID,
  modified: MODIFIED,
  chapters: [
    { title: "第一章 启程", markdown: chapter1, path: "ch/ch01.md" },
    { title: "第二章 夜宿", markdown: chapter2, path: "ch/ch02.md" },
  ],
});

/* ------------------------------------------------------------------ *
 * 1. OCF 容器结构
 * ------------------------------------------------------------------ */

assertZipMagic(epub.bytes, "EPUB");
const first = firstEntry(epub.bytes);
assert.equal(first.name, "mimetype", "EPUB 的第一个条目必须是 mimetype");
assert.equal(first.method, 0, "mimetype 必须不压缩（stored）");
assert.equal(textOf(unzip(epub.bytes), "mimetype"), "application/epub+zip", "mimetype 内容必须是 application/epub+zip");

const zip = unzip(epub.bytes);
for (const entry of ["META-INF/container.xml", "OEBPS/content.opf", "OEBPS/nav.xhtml", "OEBPS/toc.ncx", "OEBPS/css/style.css"]) {
  assert.ok(entry in zip, `应包含 ${entry}`);
}
assert.ok("OEBPS/text/chapter-1.xhtml" in zip && "OEBPS/text/chapter-2.xhtml" in zip, "两章都要生成 XHTML");

const container = textOf(zip, "META-INF/container.xml");
assertBalancedXml(container, "container.xml");
assert.ok(container.includes('full-path="OEBPS/content.opf"'), "container.xml 必须指向 OPF");
assert.ok(container.includes('media-type="application/oebps-package+xml"'), "rootfile media-type 正确");
console.log("✓ OCF 容器结构（mimetype 第一且未压缩）验证通过");

/* ------------------------------------------------------------------ *
 * 2. OPF 包文档
 * ------------------------------------------------------------------ */

const opf = textOf(zip, "OEBPS/content.opf");
assertBalancedXml(opf, "content.opf");
assertNoBareAmpersand(opf, "content.opf");
assert.ok(opf.includes(`<dc:identifier id="pub-id">urn:uuid:${ID}</dc:identifier>`), "有唯一标识");
assert.ok(opf.includes("<dc:title>测试之书</dc:title>"), "有书名");
assert.ok(opf.includes("<dc:language>zh-CN</dc:language>"), "有语言");
assert.ok(opf.includes("<dc:creator"), "有作者");
assert.ok(opf.includes(`<meta property="dcterms:modified">${MODIFIED}</meta>`), "有 dcterms:modified");
assert.ok(opf.includes('properties="nav"'), "nav 文档要标 properties=nav");

// manifest 每一项的 href 必须真实存在
const manifestHrefs = [...opf.matchAll(/<item\b[^>]*href="([^"]+)"/g)].map((m) => m[1]);
assert.ok(manifestHrefs.length >= 6, "manifest 条目数量合理");
for (const href of manifestHrefs) {
  assert.ok(`OEBPS/${href}` in zip, `manifest 声明的 ${href} 必须真实存在于包内`);
}

// spine 的 idref 必须在 manifest 里
const manifestIds = [...opf.matchAll(/<item\b[^>]*id="([^"]+)"/g)].map((m) => m[1]);
const spineIds = [...opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)].map((m) => m[1]);
assert.equal(spineIds.length, 2, "两章都在 spine 里");
for (const id of spineIds) assert.ok(manifestIds.includes(id), `spine 引用的 ${id} 必须在 manifest 中`);
assert.deepEqual(spineIds, ["chapter-1", "chapter-2"], "spine 顺序必须与传入章节顺序一致");

// media-type 与真实文件类型一致
const imageItems = [...opf.matchAll(/<item\b[^>]*href="(images\/[^"]+)"[^>]*media-type="([^"]+)"/g)];
assert.equal(imageItems.length, 1, "本章只有一张可内嵌的图片（远程/缺失的都不进包）");
assert.equal(imageItems[0][2], "image/png", "图片 media-type 应为 image/png");
console.log("✓ OPF 元数据、manifest 与 spine 验证通过");

/* ------------------------------------------------------------------ *
 * 3. 章节 XHTML 与资源引用
 * ------------------------------------------------------------------ */

const ch1 = textOf(zip, "OEBPS/text/chapter-1.xhtml");
assertBalancedXml(ch1, "chapter-1.xhtml");
assertNoBareAmpersand(ch1, "chapter-1.xhtml");
assertNoScriptTraces(ch1, "chapter-1.xhtml");
assert.deepEqual(findIllegalXmlChars(ch1), [], "章节 XHTML 无非法控制字符");
assert.ok(ch1.startsWith('<?xml version="1.0" encoding="utf-8"?>'), "XHTML 必须有 XML 声明");
assert.ok(ch1.includes('xmlns="http://www.w3.org/1999/xhtml"'), "XHTML 命名空间");
assert.ok(ch1.includes("清晨的微光"), "正文写入");
assert.ok(ch1.includes('href="https://example.com/a"'), "外链保留为真实链接");
assert.ok(ch1.includes("营地") && ch1.includes("10km"), "手写表格按普通段落写入，内容不丢");
assert.ok(ch1.includes("<blockquote>"), "引用写入");
assert.ok(ch1.includes("E = mc^2"), "公式按普通文本保留，源码不丢");
assert.ok(ch1.includes("这是脚注内容。"), "脚注定义按普通文本保留，内容不丢");

// 章节里所有 src 都必须指向包内真实资源（不允许网络地址、不允许悬空引用）
const srcs = [...ch1.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
assert.equal(srcs.length, 1, "只有一张图片的 src");
for (const src of srcs) {
  assert.ok(src.startsWith("../images/"), `图片地址应为包内相对地址：${src}`);
  const resolved = `OEBPS/${src.replace(/^\.\.\//, "")}`;
  assert.ok(resolved in zip, `图片 ${resolved} 必须在包内`);
}
assert.ok(!/https?:\/\//.test(srcs.join(" ")), "图片绝不能指向网络");

// 降级内容可见：远程图与缺失图都以文字留下
assert.ok(ch1.includes("远程图片，未下载"), "远程图片降级文字在正文里");
assert.ok(ch1.includes("图片未能内嵌") || ch1.includes("missing.png"), "缺失图片提示在正文里");
assert.ok(ch1.includes("graph TD"), "mermaid 围栏按普通代码块保留源码");
const warnKinds = new Set(epub.warnings.map((w) => w.kind));
assert.ok(warnKinds.has("remote-image"), "报告远程图片");
assert.ok(warnKinds.has("image-error"), "报告缺失图片");
assert.ok(epub.issues.some((i) => i.src === "assets/missing.png"), "issues 记录缺失图片");
console.log("✓ 章节 XHTML、资源引用与降级内容验证通过");

/* ------------------------------------------------------------------ *
 * 4. 目录（nav + ncx）
 * ------------------------------------------------------------------ */

const nav = textOf(zip, "OEBPS/nav.xhtml");
assertBalancedXml(nav, "nav.xhtml");
assert.ok(nav.includes('epub:type="toc"'), "nav 必须声明 toc");
assert.ok(nav.includes("第一章 启程") && nav.includes("第二章 夜宿"), "目录包含两章标题");
const navAnchors = [...nav.matchAll(/href="(text\/chapter-\d+\.xhtml#([^"]+))"/g)].map((m) => ({
  href: m[1],
  anchor: m[2],
}));
assert.ok(navAnchors.length >= 2, "章节内的标题应生成二级目录锚点");
for (const { href, anchor } of navAnchors) {
  const file = textOf(zip, `OEBPS/${href.split("#")[0]}`);
  assert.ok(file.includes(`id="${anchor}"`), `目录锚点 ${anchor} 必须在 ${href} 里存在`);
}
const ncx = textOf(zip, "OEBPS/toc.ncx");
assertBalancedXml(ncx, "toc.ncx");
assert.ok(ncx.includes("urn:uuid:" + ID), "ncx 的 dtb:uid 与 OPF 一致");
assert.ok(ncx.indexOf("第一章 启程") < ncx.indexOf("第二章 夜宿"), "ncx 章节顺序与输入一致");
console.log("✓ 目录（nav + ncx）验证通过");

/* ------------------------------------------------------------------ *
 * 5. 封面
 * ------------------------------------------------------------------ */

const withCover = await buildEpub({
  title: "带封面的书",
  cover: PNG_2X3,
  root: null,
  identifier: ID,
  modified: MODIFIED,
  chapters: [{ title: "第一章", markdown: "# 第一章\n\n正文。" }],
});
const coverZip = unzip(withCover.bytes);
const coverOpf = textOf(coverZip, "OEBPS/content.opf");
assert.ok("OEBPS/images/cover.png" in coverZip, "封面图片写入包内");
assert.ok("OEBPS/text/cover.xhtml" in coverZip, "生成封面页");
assert.equal((coverOpf.match(/properties="cover-image"/g) ?? []).length, 1, "cover-image 只能登记一次");
const coverSpine = [...coverOpf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)].map((m) => m[1]);
assert.equal(coverSpine[0], "cover", "封面必须是 spine 第一项");
const coverPage = textOf(coverZip, "OEBPS/text/cover.xhtml");
assertBalancedXml(coverPage, "cover.xhtml");
assert.ok(coverPage.includes('src="../images/cover.png"'), "封面页引用封面图");
console.log("✓ 封面处理验证通过");

/* ------------------------------------------------------------------ *
 * 6. 恶意输入（标题穿越、脚本、控制字符）
 * ------------------------------------------------------------------ */

const evil = await buildEpub({
  title: "恶意内容测试</dc:title><script>alert(1)</script>",
  author: "<script>alert('author')</script>",
  root: null,
  identifier: ID,
  modified: MODIFIED,
  chapters: [
    {
      title: "../../etc/passwd",
      markdown: "# 正常标题\n\n正文 \u0001\u0008 与 <script>alert(9)</script> 与 [坏链](javascript:alert(2))",
    },
  ],
});
const evilZip = unzip(evil.bytes);
for (const name of Object.keys(evilZip)) {
  assert.ok(!name.includes(".."), `包内条目名不得含 ..：${name}`);
  assert.ok(!name.startsWith("/"), `包内条目名不得是绝对路径：${name}`);
}
const evilOpf = textOf(evilZip, "OEBPS/content.opf");
assertBalancedXml(evilOpf, "content.opf（恶意输入下）");
assert.ok(!evilOpf.includes("<script>"), "OPF 里不得出现脚本");
assert.ok(evilOpf.includes("&lt;script&gt;"), "标题里的标签必须被转义成文本");
const evilNav = textOf(evilZip, "OEBPS/nav.xhtml");
assertBalancedXml(evilNav, "nav.xhtml（恶意输入下）");
assertNoScriptTraces(evilNav, "nav.xhtml");
assert.ok(evilNav.includes("../../etc/passwd"), "恶意标题作为纯文本显示（文件名仍是 chapter-1.xhtml）");
for (const [name, data] of Object.entries(evilZip)) {
  if (!/\.(xhtml|opf|xml|ncx)$/.test(name)) continue;
  assert.deepEqual(findIllegalXmlChars(new TextDecoder().decode(data)), [], `${name} 不得含非法控制字符`);
}
console.log("✓ 恶意输入（路径穿越 / 脚本 / 控制字符）验证通过");

/* ------------------------------------------------------------------ *
 * 7. 可复现性与错误处理
 * ------------------------------------------------------------------ */

const again = await buildEpub({
  title: "测试之书",
  author: "测试作者",
  root: "/fake/root",
  readImage: fakeReadImage,
  identifier: ID,
  modified: MODIFIED,
  chapters: [
    { title: "第一章 启程", markdown: chapter1, path: "ch/ch01.md" },
    { title: "第二章 夜宿", markdown: chapter2, path: "ch/ch02.md" },
  ],
});
assert.equal(again.bytes.length, epub.bytes.length, "同样输入应产出同样大小的包");
assert.deepEqual(Array.from(again.bytes), Array.from(epub.bytes), "固定 identifier/modified 时输出应逐字节一致");

await assert.rejects(
  () => buildEpub({ title: "空书", root: null, chapters: [] }),
  /至少需要一个章节/,
  "没有章节时应明确报错",
);

assert.equal(isoTimestamp(new Date(Date.UTC(2026, 9, 6, 0, 0, 0))), "2026-10-06T00:00:00Z", "ISO 时间戳格式");
assert.match(randomUuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "UUID v4 格式");

/* ------------------------------------------------------------------ *
 * 8. 动作层：EPUB 保存的取消 / 拦截
 * ------------------------------------------------------------------ */

const cancel = await saveEpubExport({
  title: "书",
  root: null,
  chapters: [{ title: "第一章", markdown: "# 第一章" }],
  pickTarget: async () => null,
});
assert.equal(cancel.cancelled, true, "取消时标记 cancelled");
assert.equal(cancel.path, null);
assert.ok(cancel.report.summary.includes("已取消"), "取消不谎报成功");

const blocked = await saveEpubExport({
  title: "书",
  root: "/ws",
  sourcePath: "ch01.md",
  chapters: [{ title: "第一章", markdown: "# 第一章" }],
  pickTarget: async () => "/ws/ch01.md",
});
assert.equal(blocked.path, null, "拒绝覆盖源文件");
assert.ok(blocked.report.summary.includes("被拒绝"));
assert.equal(validateExportTarget("/ws/book.epub", "ch01.md", "/ws"), "", "正常 .epub 目标放行");

console.log("=== 所有 EPUB 导出测试通过 ===");
