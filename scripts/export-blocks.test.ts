/*
 * 导出中间层测试：HTML → 块模型解析器、XHTML 序列化、字节/XML 工具、报告与目标校验。
 *
 * 这些是 DOCX / EPUB 两个导出器的共同底座，坏在这里会同时坏掉两种格式，
 * 所以单独测：
 *   - 解析器不依赖 DOM，遇到畸形/恶意 HTML 既不抛异常也不丢内容；
 *   - 复杂块源码回退（.md-source-fallback）与远程/缺失图片都会转成
 *     「可见降级 + 明确警告」，这是「不静默丢内容」的关键；
 *   - 序列化出的 XHTML 一定转义干净（& < > " 与控制字符）；
 *   - 目标校验绝不允许把导出写成 .md/.txt 或覆盖源文件。
 */
import assert from "node:assert/strict";
import {
  isSafeHref,
  parseExportHtml,
  parseHtmlTree,
  renderBlocksToXhtml,
  svgSourceOf,
  type ExportBlock,
} from "../src/lib/exportDoc";
import {
  base64ToBytes,
  bytesToBase64,
  decodeDataUrl,
  decodeImageDataUrl,
  escapeXml,
  escapeXmlAttr,
  imageIntrinsicSize,
  sanitizeXmlText,
  sniffImageKind,
  svgIntrinsicSize,
} from "../src/lib/bytes";
import { buildReport, exportFileName, reportText, validateExportTarget } from "../src/lib/exportActions";
import { buildSelfContainedHtml } from "../src/lib/htmlExport";
import { PNG_2X3, PNG_1200X300, SAMPLE_SVG, assertBalancedXml } from "./export-test-kit";

console.log("=== 导出中间层测试开始 ===");

/* ------------------------------------------------------------------ *
 * 1. 字节 / base64 / data URL
 * ------------------------------------------------------------------ */

const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
const b64 = bytesToBase64(bytes);
assert.equal(b64, "AAEC+vv8/f7/", "base64 编码与标准实现一致");
assert.deepEqual(Array.from(base64ToBytes(b64)!), Array.from(bytes), "base64 往返一致");
assert.equal(base64ToBytes("!!!!"), null, "非法字符必须拒绝");
assert.equal(base64ToBytes("AAA"), null, "长度不是 4 的倍数必须拒绝");
assert.equal(base64ToBytes("A==="), null, "填充过多必须拒绝");
assert.equal(base64ToBytes("AA==")!.length, 1, "合法填充正常解码");
assert.equal(base64ToBytes("AB=="), null, "非规范填充位（尾随非零位）必须拒绝，与 Rust 侧一致");
const all = Uint8Array.from({ length: 256 }, (_, i) => i);
assert.deepEqual(Array.from(base64ToBytes(bytesToBase64(all))!), Array.from(all), "0-255 全字节往返一致");
assert.equal(base64ToBytes(""), null, "空字符串拒绝（不返回空数组混淆调用方）");

const dataUrl = decodeDataUrl(`data:image/png;base64,${bytesToBase64(bytes)}`);
assert.equal(dataUrl?.mime, "image/png");
assert.deepEqual(Array.from(dataUrl!.bytes), Array.from(bytes));
const utf8DataUrl = decodeDataUrl("data:image/svg+xml,%3Csvg%20width%3D%221%22%2F%3E");
assert.equal(utf8DataUrl?.mime, "image/svg+xml");
assert.equal(new TextDecoder().decode(utf8DataUrl!.bytes), '<svg width="1"/>', "百分号编码的 data URL 正确解码");
assert.equal(decodeDataUrl("not-a-data-url"), null);

/* ------------------------------------------------------------------ *
 * 2. XML 文本安全与图片嗅探
 * ------------------------------------------------------------------ */

assert.equal(sanitizeXmlText("a\u0000b\u0008c\u000ed"), "abcd", "控制字符被清除");
assert.equal(sanitizeXmlText("换行\n制表\t回车\r"), "换行\n制表\t回车\r", "合法空白保留");
assert.equal(sanitizeXmlText("emoji😀与汉字"), "emoji😀与汉字", "emoji（代理对）完整保留");
assert.equal(sanitizeXmlText("落单代理\ud800后面"), "落单代理后面", "落单代理被丢弃");
assert.equal(escapeXml("<a & b>"), "&lt;a &amp; b&gt;", "文本转义");
assert.equal(escapeXmlAttr('"x" & <y>'), "&quot;x&quot; &amp; &lt;y&gt;", "属性转义");
assert.equal(findPngDimension(PNG_2X3), "2x3", "PNG 尺寸按头部解析");
assert.equal(findPngDimension(PNG_1200X300), "1200x300", "大图尺寸按头部解析");

function findPngDimension(data: string): string {
  const decoded = decodeImageDataUrl(data);
  return `${decoded?.width}x${decoded?.height}`;
}

assert.equal(sniffImageKind(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])), "png", "PNG 魔数");
assert.equal(sniffImageKind(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), "jpg", "JPEG 魔数");
assert.equal(sniffImageKind(new TextEncoder().encode("GIF89a")), "gif", "GIF 魔数");
assert.equal(sniffImageKind(Uint8Array.from([0x42, 0x4d, 0, 0])), "bmp", "BMP 魔数");
assert.equal(
  sniffImageKind(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])),
  "webp",
  "WEBP 魔数",
);
assert.equal(sniffImageKind(Uint8Array.from([0x3c, 0x73, 0x76, 0x67]), "image/svg+xml"), "svg", "SVG 依声明识别");
assert.equal(sniffImageKind(Uint8Array.from([0x3c, 0x68, 0x74, 0x6d]), "text/html"), null, "伪装成图片的 HTML 不认");

// JPEG SOF0 头（高 2、宽 3）
const jpegHeader = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x03, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
]);
assert.deepEqual(imageIntrinsicSize(jpegHeader, "jpg"), { width: 3, height: 2 }, "JPEG 尺寸解析");
assert.deepEqual(svgIntrinsicSize(SAMPLE_SVG), { width: 200, height: 100 }, "SVG 尺寸解析");
assert.deepEqual(svgIntrinsicSize('<svg viewBox="0 0 640 480"></svg>'), { width: 640, height: 480 }, "SVG viewBox 退回");
assert.equal(svgIntrinsicSize("<svg></svg>"), null, "无尺寸信息时返回 null（由调用方降级）");
assert.equal(decodeImageDataUrl("data:image/png;base64,%%%%"), null, "坏 base64 不认");
assert.equal(decodeImageDataUrl("data:text/html;base64,PGI+"), null, "非图片数据不认");
console.log("✓ 字节 / base64 / XML 安全 / 图片嗅探验证通过");

/* ------------------------------------------------------------------ *
 * 3. HTML → 块模型
 * ------------------------------------------------------------------ */

const richHtml = `
<main>
<h1 id="第一章-测试">第一章 测试</h1>
<h3>小节标题</h3>
<p>正文含 <strong>粗体</strong>、<em>斜体</em>、<code class="md-code">code</code>、
<a class="md-link" href="https://example.com/a">外链</a> 与 <a class="md-link" href="#anchor">内锚</a>。</p>
<p><span class="md-link-bad" title="不安全的链接已禁用">坏链接</span></p>
<ul>
<li>第一项</li>
<li class="task"><input type="checkbox" disabled checked> 已完成任务</li>
<li>第二项<ul><li>嵌套项</li></ul></li>
</ul>
<ol><li>有序一</li><li>有序二</li></ol>
<blockquote><p>普通引用</p></blockquote>
<blockquote class="md-callout md-callout-warning"><div class="md-callout-title">⚠ WARNING</div><div class="md-callout-body"><p>注意脚下</p></div></blockquote>
<pre class="md-pre" data-lang="js"><code class="language-js">if (a &lt; b &amp;&amp; c &gt; d) {}</code></pre>
<table class="md-table"><thead><tr><th>列A</th><th>列B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>
<hr>
<p><img src="${PNG_2X3}" class="md-img" alt="小图"></p>
<p><span class="md-img-placeholder md-img-remote" data-remote-src="https://example.com/x.png" role="img">🖼 远程图（远程图片，未下载：https://example.com/x.png）</span></p>
<p><span class="md-img-placeholder md-img-error" data-md-error-src="assets/bad.png" data-md-error="找不到 assets/bad.png" role="img">⚠ 缺失图（图片未能内嵌：找不到 assets/bad.png）</span></p>
<p>行内公式 <span class="md-math md-math-inline"><span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>E</mi></mrow><annotation encoding="application/x-tex">E=mc^2</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">E=mc2</span></span></span> 结束</p>
<div class="md-math md-math-block cm-lp-katex-block"><span class="md-math md-math-inline cm-lp-katex cm-lp-katex-display"><span class="katex"><span class="katex-mathml"><math><semantics><annotation encoding="application/x-tex">\\int_0^1 x dx</annotation></semantics></math></span></span></span></div>
<p><span class="md-math md-math-error" data-md-math-error="1" data-md-math-src="\\badcmd{x}"><span class="md-math-error-msg">[公式渲染失败]</span><code class="md-math-error-src">\\badcmd{x}</code></span></p>
<div class="md-source-fallback" data-md-fallback="complex-block"><div class="md-source-fallback-note">⚠ 嵌套列表，已按原文保留</div><pre class="md-pre md-source-fallback-pre"><code>- 项 1\n  &gt; 引用\n  &gt; - 深层项</code></pre></div>
<div class="md-mermaid md-mermaid-rendered" data-mermaid-id="mmd-1" role="img">${SAMPLE_SVG}</div>
<div class="md-mermaid" data-mermaid-id="mmd-2" data-mermaid-status="pending"><pre class="md-mermaid-fallback"><code class="language-mermaid">graph TD; A--&gt;B;</code></pre></div>
<nav class="md-toc"><div class="md-toc-title">目录</div><ul><li class="lvl-1"><a class="md-link" href="#第一章-测试">第一章 测试</a></li><li class="lvl-2"><a class="md-link" href="#小节标题">小节标题</a></li></ul></nav>
<section class="md-footnotes"><hr><ol><li id="fn-1">脚注正文 <a href="#fnref-1" class="md-fnback" role="doc-backlink">↩</a></li></ol></section>
<script>alert('必须在解析阶段被丢弃')</script>
<style>body{display:none}</style>
<div class="weird-container"><p>普通 div 里的文字（应照常展开）</p></div>
<widget><p>未知容器里的文字</p></widget>
<p>&lt;script&gt;alert(1)&lt;/script&gt; 已被转义的文本</p>
</main>
`;

const rich = parseExportHtml(richHtml);
const kinds = rich.blocks.map((b) => b.kind);
assert.deepEqual(
  kinds,
  [
    "heading",
    "heading",
    "para",
    "para",
    "list",
    "list",
    "quote",
    "callout",
    "code",
    "table",
    "rule",
    "para",
    "para",
    "para",
    "para",
    "math",
    "para",
    "code",
    "image",
    "code",
    "nav",
    "footnotes",
    "para",
    "raw",
    "para",
  ],
  "块序列与结构预期一致",
);

const h1 = rich.blocks[0] as Extract<ExportBlock, { kind: "heading" }>;
assert.equal(h1.level, 1);
assert.equal(h1.id, "第一章-测试");
const para = rich.blocks[2] as Extract<ExportBlock, { kind: "para" }>;
assert.ok(para.inlines.some((i) => i.bold && i.text === "粗体"), "粗体标记");
assert.ok(para.inlines.some((i) => i.italic && i.text === "斜体"), "斜体标记");
assert.equal(para.inlines.find((i) => i.kind === "code")?.text, "code", "行内代码文字");
const links = para.inlines.filter((i) => i.kind === "link");
assert.equal(links[0].href, "https://example.com/a", "外链地址");
assert.equal(links[1].internal, true, "内链标记为文档内锚点");
assert.ok(rich.warnings.some((w) => w.kind === "internal-link"), "内链降级有警告");

const badLink = rich.blocks[3] as Extract<ExportBlock, { kind: "para" }>;
assert.equal(badLink.inlines[0].kind, "text", "不安全链接降级为文字");
assert.ok(rich.warnings.some((w) => w.kind === "unsafe-link"), "不安全链接有警告");

const list = rich.blocks[4] as Extract<ExportBlock, { kind: "list" }>;
assert.equal(list.ordered, false);
assert.equal(list.items.length, 3);
assert.equal(list.items[1].inlines[0].text, "☑ ", "任务框勾选显示为 ☑");
assert.equal(list.items[2].blocks[0].kind, "list", "嵌套列表进 item.blocks");
const ordered = rich.blocks[5] as Extract<ExportBlock, { kind: "list" }>;
assert.equal(ordered.ordered, true, "有序列表标记");

const callout = rich.blocks[7] as Extract<ExportBlock, { kind: "callout" }>;
assert.equal(callout.variant, "warning", "提示块类型");
assert.ok(callout.title?.includes("WARNING"), "提示块标题");
assert.equal(callout.blocks[0].kind, "para", "提示块正文");

const code = rich.blocks[8] as Extract<ExportBlock, { kind: "code" }>;
assert.equal(code.lang, "js", "代码语言");
assert.equal(code.text, "if (a < b && c > d) {}", "代码实体已还原、保持原样");

const table = rich.blocks[9] as Extract<ExportBlock, { kind: "table" }>;
assert.equal(table.head[0][0].text, "列A", "表头");
assert.equal(table.rows[0][1][0].text, "2", "表体");

const remotePara = rich.blocks[12] as Extract<ExportBlock, { kind: "para" }>;
assert.equal(remotePara.inlines[0].kind, "place", "远程图片变为占位");
assert.ok(rich.warnings.some((w) => w.kind === "remote-image"), "远程图片警告");
const missingPara = rich.blocks[13] as Extract<ExportBlock, { kind: "para" }>;
assert.equal(missingPara.inlines[0].kind, "place", "缺失图片变为占位");
assert.ok(rich.warnings.some((w) => w.kind === "image-error"), "缺失图片警告");

const mathInline = (rich.blocks[14] as Extract<ExportBlock, { kind: "para" }>).inlines.find((i) => i.kind === "math")!;
assert.equal(mathInline.tex, "E=mc^2", "从 KaTeX 的 annotation 取出 TeX");
assert.equal(mathInline.display, false, "行内公式");
const mathBlock = rich.blocks[15] as Extract<ExportBlock, { kind: "math" }>;
assert.equal(mathBlock.display, true, "块公式");
assert.ok(mathBlock.tex.includes("int_0^1"), "块公式 TeX");
const mathFailed = (rich.blocks[16] as Extract<ExportBlock, { kind: "para" }>).inlines.find((i) => i.kind === "math")!;
assert.equal(mathFailed.failed, true, "渲染失败的公式标记为 failed");
assert.equal(mathFailed.tex, "\\badcmd{x}", "失败公式用 data-md-math-src 的原文");
assert.ok(rich.warnings.some((w) => w.kind === "math-failed"), "公式失败警告");

const fb = rich.blocks[17] as Extract<ExportBlock, { kind: "code" }>;
assert.equal(fb.origin, "fallback", "复杂块回退标记");
assert.equal(fb.lang, "markdown");
assert.ok(fb.text.includes("- 项 1") && fb.text.includes("> 引用") && fb.text.includes("> - 深层项"), "回退块源码完整");
assert.ok(fb.note?.includes("嵌套列表"), "回退块带中文提示");
const fbWarn = rich.warnings.find((w) => w.kind === "source-fallback");
assert.ok(fbWarn?.message.includes("源码完整保留"), "回退块有明确警告");

const svgImage = rich.blocks[18] as Extract<ExportBlock, { kind: "image" }>;
assert.equal(svgImage.inlines[0].kind, "image", "内联 SVG 图形解析为图片");
assert.ok(svgImage.inlines[0].svg?.includes("<svg"), "SVG 源码保留");
const mermaidPlain = rich.blocks[19] as Extract<ExportBlock, { kind: "code" }>;
assert.equal(mermaidPlain.lang, "mermaid", "遗留的 mermaid 围栏按普通代码块处理（不再有专门的图表分支）");
assert.ok(mermaidPlain.text.includes("graph TD"), "图表源码保留不丢失");

const nav = rich.blocks[20] as Extract<ExportBlock, { kind: "nav" }>;
assert.equal(nav.items.length, 2);
assert.equal(nav.items[1].level, 2, "目录层级");
const footnotes = rich.blocks[21] as Extract<ExportBlock, { kind: "footnotes" }>;
assert.equal(footnotes.items[0].id, "fn-1");
assert.ok((footnotes.items[0].inlines[0].text ?? "").includes("脚注正文"), "脚注文字");
const plainDiv = rich.blocks[22] as Extract<ExportBlock, { kind: "para" }>;
assert.equal(plainDiv.inlines[0].kind, "text", "普通 div 正常展开成段落");
assert.ok((plainDiv.inlines[0].text ?? "").includes("普通 div 里的文字"), "div 内文字保留");
const unknown = rich.blocks[23] as Extract<ExportBlock, { kind: "raw" }>;
assert.equal(unknown.kind, "raw", "未知容器降级为 raw（保留文字）");
assert.ok(unknown.text.includes("未知容器里的文字"), "未知容器内容不丢");
assert.ok(rich.warnings.some((w) => w.kind === "unsupported-tag"), "未知标签有警告");

// script / style 的内容必须彻底消失（不能变成正文）
const allText = JSON.stringify(rich.blocks);
assert.ok(!allText.includes("必须在解析阶段被丢弃"), "script 内容被丢弃");
assert.ok(!allText.includes("display:none"), "style 内容被丢弃");
assert.ok(allText.includes("已被转义的文本"), "转义后的脚本文本按普通文字保留");
console.log("✓ HTML → 块模型（含降级与安全）验证通过");

/* ------------------------------------------------------------------ *
 * 4. 畸形 HTML 不崩、不丢内容
 * ------------------------------------------------------------------ */

const broken = parseExportHtml("<main><p>未闭合段落<p>第二段<div>块里<b>加粗未闭合</div><ul><li>项</ul></main>");
const brokenText = JSON.stringify(broken.blocks);
assert.ok(brokenText.includes("未闭合段落") && brokenText.includes("第二段"), "畸形嵌套仍保留全部文字");
assert.ok(brokenText.includes("加粗未闭合") && brokenText.includes("项"), "未闭合标签内容保留");
assert.doesNotThrow(() => parseHtmlTree("<p><<>>"), "畸形尖括号不抛异常");
assert.ok(svgSourceOf(parseHtmlTree("<div><svg><script>alert(1)</script></svg></div>") as never) === null, "含脚本的 SVG 被拒绝");
console.log("✓ 畸形输入容错验证通过");

/* ------------------------------------------------------------------ *
 * 5. 块模型 → XHTML（转义与图片解析）
 * ------------------------------------------------------------------ */

const xhtml = renderBlocksToXhtml(rich.blocks, {
  resolveImage: (inline) => (inline.svg ? "../images/diagram.svg" : inline.alt === "小图" ? "../images/img-1.png" : null),
  headingId: (text, index) => `h-${index}-${text.replace(/\s+/g, "-")}`,
});
assertBalancedXml(xhtml, "块模型序列化的 XHTML");
assert.ok(xhtml.includes("<strong>"), "粗体序列化");
assert.ok(xhtml.includes('id="h-999"') === false, "ids 正常生成");
assert.ok(xhtml.includes("<table>") && xhtml.includes("<th>列A</th>"), "表格序列化");
assert.ok(xhtml.includes("☑"), "任务框序列化");
assert.ok(xhtml.includes('src="../images/diagram.svg"'), "SVG 解析为包内地址");
assert.ok(xhtml.includes('src="../images/img-1.png"'), "位图解析为包内地址");
assert.ok(xhtml.includes("md-img-missing"), "解析失败的图片降级为可见文字");
assert.ok(!xhtml.includes("data:image"), "序列化结果里不再有 data URL");
console.log("✓ 块模型 → XHTML 验证通过");

/* ------------------------------------------------------------------ *
 * 6. 与真实渲染管线的联调（buildSelfContainedHtml → 解析 → 序列化）
 * ------------------------------------------------------------------ */

const realMd = `# 真实管线

段落 **加粗** 与 [链接](https://example.com)。

- 甲
- 乙

> [!note] 注意
> 提示正文

\`\`\`
plain code
\`\`\`

| a | b |
| - | - |
| 1 | 2 |

$E=mc^2$
`;
const selfContained = await buildSelfContainedHtml(realMd, "真实管线", { root: null, standalone: false });
const parsedReal = parseExportHtml(selfContained.html);
assert.ok(parsedReal.blocks.length >= 6, "真实渲染输出能解析出块");
assert.ok(parsedReal.blocks.some((b) => b.kind === "heading"), "含标题块");
assert.ok(parsedReal.blocks.some((b) => b.kind === "code"), "含代码块");
// 手写表格与提示块不再是独立块：表格按普通段落进入块模型，文本不丢，导出仍可见
assert.ok(
  parsedReal.blocks.some((b) => b.kind === "para" && JSON.stringify(b).includes("| a | b |")),
  "表格文本按普通段落保留，内容不丢",
);
const realXhtml = renderBlocksToXhtml(parsedReal.blocks);
assertBalancedXml(realXhtml, "真实管线 XHTML");
assertNoIllegal(realXhtml);
console.log("✓ 与 buildSelfContainedHtml 真实管线联调通过");

function assertNoIllegal(content: string): void {
  for (const ch of content) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 && code !== 0x9 && code !== 0xa && code !== 0xd) {
      throw new Error(`序列化结果里出现控制字符 U+${code.toString(16)}`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 7. 链接安全与导出目标校验
 * ------------------------------------------------------------------ */

assert.equal(isSafeHref("https://example.com"), true);
assert.equal(isSafeHref("mailto:a@b.c"), true);
assert.equal(isSafeHref("#section"), true);
assert.equal(isSafeHref("images/a.png"), true);
assert.equal(isSafeHref("javascript:alert(1)"), false);
assert.equal(isSafeHref("JavaScript:alert(1)"), false);
assert.equal(isSafeHref("vbscript:msgbox"), false);
assert.equal(isSafeHref("data:text/html,<script>"), false);
assert.equal(isSafeHref("file:///etc/passwd"), false);
assert.equal(isSafeHref("  "), false);

assert.equal(validateExportTarget("/a/b.docx"), "", ".docx 通过");
assert.equal(validateExportTarget("/a/b.EPUB"), "", "大小写不敏感通过");
assert.match(validateExportTarget("/a/b.md"), /md/, "禁止导出为 .md");
assert.match(validateExportTarget("   "), /空/, "空路径拒绝");
assert.match(
  validateExportTarget("/ws/ch/第 1 章.docx", "ch/第 1 章.docx", "/ws"),
  /原始 Markdown/,
  "同一文件的相对路径写法也要拦下",
);
assert.match(validateExportTarget("/ws/ch01.md", "ch01.md", "/ws"), /手稿/, "源文件名与目标一致时拦下");
assert.equal(validateExportTarget("/ws/out/ch01.docx", "ch01.md", "/ws"), "", "不同目录下的 .docx 放行");
assert.match(validateExportTarget("/ws/../ws/ch01.md", "ch01.md", "/ws"), /手稿|原始/, "路径规范化后仍能拦下");

assert.equal(exportFileName("第 1 章：启程/夜晚", "docx"), "第 1 章：启程、夜晚.docx", "文件名清洗非法字符");
assert.equal(exportFileName("ch01.md", "docx"), "ch01.docx", "去掉 .md 后缀再加 .docx");
assert.equal(exportFileName("   ", "epub"), "未命名.epub", "空标题有兜底名");
assert.ok(!exportFileName("a\nb", "docx").includes("\n"), "换行被清洗");

/* ------------------------------------------------------------------ *
 * 8. 报告诚实性
 * ------------------------------------------------------------------ */

const okReport = buildReport({ summary: "已生成 DOCX（第 1 章）", warnings: [], issues: [] });
assert.equal(okReport.hasIssues, false);
assert.equal(okReport.summary, "已生成 DOCX（第 1 章）", "没有写盘就不能出现「已写入」");
assert.equal(reportText(okReport), "已生成 DOCX（第 1 章）");

const problemReport = buildReport({
  writtenPath: "/out/a.docx",
  summary: "已生成 DOCX（第 1 章）",
  warnings: [{ kind: "remote-image", message: "远程图片未下载：https://x/y.png", detail: "https://x/y.png" }],
  issues: [{ src: "assets/missing.png", path: "ch/assets/missing.png", reason: "找不到该图片文件" }],
  notes: ["公式以 TeX 原文导出"],
});
assert.equal(problemReport.hasIssues, true);
assert.ok(problemReport.summary.includes("已写入 /out/a.docx"), "真的写盘后才报告路径");
const problemText = reportText(problemReport);
assert.ok(problemText.includes("图片问题共 1 处"), "报告图片问题");
assert.ok(problemText.includes("格式降级/警告共 1 条"), "报告降级条数");
assert.ok(problemText.includes("https://x/y.png"), "报告包含具体地址");
assert.ok(problemText.includes("公式以 TeX 原文导出"), "报告包含补充说明");
console.log("✓ 链接安全 / 目标校验 / 报告验证通过");

console.log("=== 所有导出中间层测试通过 ===");
