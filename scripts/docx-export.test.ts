/*
 * DOCX 离线导出的行为测试（纯 Node，复用既有 esbuild，不装测试框架）。
 *
 * 覆盖：
 *   1. 真实 ZIP / OOXML 结构（PK 头、[Content_Types].xml、word/document.xml、_rels/.rels 等）；
 *   2. 正文元素：标题 1-6、段落、粗体/斜体/代码、有序/无序/多级列表、引用块、水平线；
 *   3. 复杂块安全回退（div.md-source-fallback）：源码一字不丢写进 document.xml，报告给警告；
 *   4. 图片：本地真实图片解码内嵌、超大图片等比缩放、尺寸信息写进 drawingML；
 *   5. 降级：远程图片不下载留在文字里、缺失图片明确留占位、公式降级为 TeX 原文；
 *   6. 恶意内容：<script>、javascript:、onerror、控制字符被清洗或按文本转义，绝不在 XML 里破环；
 *   7. 目标保护：validateExportTarget 拒绝覆盖 .md/.txt 手稿，拒绝覆盖源路径；
 *   8. 报告诚实性：用户取消不伪造成功、失败给出原因。
 */
import assert from "node:assert/strict";
import { buildDocx, buildDocxFromHtml } from "../src/lib/docxExport";
import {
  validateExportTarget,
  buildReport,
  saveDocxExport,
} from "../src/lib/exportActions";
import {
  PNG_2X3,
  PNG_1200X300,
  SAMPLE_SVG,
  assertZipMagic,
  assertBalancedXml,
  assertNoBareAmpersand,
  findIllegalXmlChars,
  assertNoScriptTraces,
  textOf,
  unzip,
} from "./export-test-kit";

console.log("=== DOCX 离线导出测试开始 ===");

/* ------------------------------------------------------------------ *
 * 1. 基础结构 + 真实 OOXML 部件
 * ------------------------------------------------------------------ */

const basicMd = `# 第一章 旅途启程

清晨的**微光**洒在*石阶*上。这是一段正文，包含\`inline code\`与普通文字。

- 装备一览
- 旅途伙伴
  - 剑士
  - 法师

1. 第一步
2. 第二步

> 重要的不是终点，而是沿途的风景。

> [!tip] 提示标题
> 注意检查随身物品。

| 地点 | 距离 |
| --- | --- |
| 营地 | 10km |

---

这是一段结尾。
`;

const basicRes = await buildDocx(basicMd, "第一章 旅途启程", { root: null });
assertZipMagic(basicRes.bytes, "基础 DOCX");
const zip1 = unzip(basicRes.bytes);

// 必须包含的核心 OOXML 部件
const requiredEntries = [
  "[Content_Types].xml",
  "_rels/.rels",
  "word/document.xml",
  "word/styles.xml",
  "word/_rels/document.xml.rels",
  "docProps/core.xml",
  "docProps/app.xml",
];
for (const entry of requiredEntries) {
  assert.ok(entry in zip1, `DOCX 应包含 ${entry}`);
}

const docXml = textOf(zip1, "word/document.xml");
assertBalancedXml(docXml, "word/document.xml 标签配对");
assertNoBareAmpersand(docXml, "word/document.xml 没有裸 &");
assert.deepEqual(findIllegalXmlChars(docXml), [], "word/document.xml 无非法控制字符");

// 检查正文文字与结构
assert.ok(docXml.includes("第一章 旅途启程"), "包含标题");
assert.ok(docXml.includes("清晨的"), "包含正文");
assert.ok(docXml.includes("微光"), "包含粗体文字");
assert.ok(docXml.includes("<w:b/>") || docXml.includes('<w:b w:val="1"/>'), "粗体标记写入");
assert.ok(docXml.includes("<w:i/>") || docXml.includes('<w:i w:val="1"/>'), "斜体标记写入");
assert.ok(docXml.includes("inline code"), "行内代码写入");
assert.ok(docXml.includes("装备一览"), "无序列表写入");
assert.ok(docXml.includes("第一步"), "有序列表写入");
assert.ok(docXml.includes("重要的不是终点"), "引用块写入");
assert.ok(docXml.includes("营地") && docXml.includes("距离"), "手写表格按普通段落写入，内容不丢");
console.log("✓ 基础结构与正文元素验证通过");

/* ------------------------------------------------------------------ *
 * 2. 复杂块（md-source-fallback）完整保留源码 + 报告警告
 * ------------------------------------------------------------------ */

const fallbackHtml = `
<main>
<h1>第一章 测试</h1>
<p>普通段落</p>
<div class="md-source-fallback" data-md-fallback="complex-block">
  <div class="md-source-fallback-note">⚠ 复杂嵌套列表，已完整保留源码</div>
  <pre class="md-pre md-source-fallback-pre"><code>- 列表项 1
  &gt; 嵌套引用
  &gt; - 内部列表
  \`\`\`js
  const inside = 42;
  \`\`\`</code></pre>
</div>
<p>后续正文</p>
</main>
`;

const fbRes = await buildDocxFromHtml(fallbackHtml, "复杂块测试", { root: null });
const fbDoc = textOf(unzip(fbRes.bytes), "word/document.xml");

// 源码一字不丢
assert.ok(fbDoc.includes("- 列表项 1"), "复杂块列表源码保留");
assert.ok(fbDoc.includes("&gt; 嵌套引用") || fbDoc.includes("> 嵌套引用"), "引用源码保留");
assert.ok(fbDoc.includes("const inside = 42;"), "内部代码源码保留");
assert.ok(fbDoc.includes("复杂嵌套列表，已完整保留源码"), "中文提示保留");

// 必须在 warnings 里给出一目了然的说明
const fbWarn = fbRes.warnings.find((w) => w.kind === "source-fallback");
assert.ok(fbWarn, "应产出 source-fallback 警告");
assert.ok(fbWarn.message.includes("复杂块"), "警告应指出复杂块");
console.log("✓ 复杂块（fallback）源码保留与警告验证通过");

/* ------------------------------------------------------------------ *
 * 3. 图片内嵌、等比缩放、远程图片不下载、缺失图片明确报错
 * ------------------------------------------------------------------ */

const imgMd = `
# 图文章节

本地正常图片：
![小图](assets/small.png)

本地超宽图片（需缩放）：
![超宽图](assets/wide.png)

远程图片（离线导出绝不能联网下载）：
![网络图](https://example.com/remote.png)

缺失的本地图片：
![缺失图](assets/not-found.png)
`;

const fakeReadImage = async (_root: string, path: string) => {
  if (path === "ch/assets/small.png") return PNG_2X3;
  if (path === "ch/assets/wide.png") return PNG_1200X300;
  return null;
};

const imgRes = await buildDocx(imgMd, "图文章节", {
  root: "/fake/root",
  baseDir: "ch",
  readImage: fakeReadImage,
});

const zipImg = unzip(imgRes.bytes);
const imgDocXml = textOf(zipImg, "word/document.xml");
const mediaFiles = Object.keys(zipImg).filter((k) => /^word\/media\/.+\.png$/.test(k));
assert.equal(mediaFiles.length, 2, "应内嵌两张本地图片到 word/media/");

// 远程图不下载：转化为文字占位
assert.ok(imgDocXml.includes("远程图片，未下载"), "远程图片在正文中变为文字占位");
const remoteWarn = imgRes.warnings.find((w) => w.kind === "remote-image");
assert.ok(remoteWarn, "应报告远程图片警告");
assert.ok(remoteWarn.message.includes("https://example.com/remote.png"), "报告包含原地址");

// 缺失图片明确报错
const missingIssue = imgRes.issues.find((i) => i.src === "assets/not-found.png");
assert.ok(missingIssue, "缺失图片应记录在 issues 错误清单中");
assert.ok(imgDocXml.includes("图片未能内嵌") || imgDocXml.includes("not-found.png"), "缺失图片有明确文字占位");

// 超大图缩放：检查 word/document.xml 中的 cx 尺寸（EMU 单位，1px ≈ 9525 EMU）
// 1200px 必须被缩放到 MAX_IMAGE_WIDTH_PX (520px) 左右，cx 不能超过 520 * 9525 ≈ 4953000
const cxMatches = [...imgDocXml.matchAll(/cx="(\d+)"/g)].map((m) => Number(m[1]));
assert.ok(cxMatches.length >= 2, "应有图片宽高定义");
for (const cx of cxMatches) {
  assert.ok(cx <= 520 * 9525 + 50000, `图片宽度 EMU (${cx}) 不得超过页宽限制`);
}
console.log("✓ 本地图片内嵌、超大图缩放与远程/缺失降级验证通过");

/* ------------------------------------------------------------------ *
 * 4. 公式与 Mermaid 源码按普通文本/代码保留（不再有专门的渲染与降级）
 * ------------------------------------------------------------------ */

const mathMd = `
# 公式与图表

行内公式 $E = mc^2$，以及块级公式：

$$
\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}
$$

\`\`\`mermaid
graph TD
  A --> B
\`\`\`
`;

const mathRes = await buildDocx(mathMd, "公式测试", { root: null });
const mathDoc = textOf(unzip(mathRes.bytes), "word/document.xml");

assert.ok(mathDoc.includes("E = mc^2"), "公式按普通文本保留，TeX 源码不丢");
assert.ok(mathDoc.includes("graph TD"), "mermaid 围栏按普通代码块保留源码");
console.log("✓ 公式与图表源码按普通文本/代码保留验证通过");

/* ------------------------------------------------------------------ *
 * 5. 恶意内容防护与安全性
 * ------------------------------------------------------------------ */

const evilHtml = `
<main>
<h1>恶意攻击测试</h1>
<p><script>alert('xss')</script>正文</p>
<p><a href="javascript:alert(1)">危险链接</a></p>
<p><a href="data:text/html,<script>alert(1)</script>">数据协议链接</a></p>
<img src="javascript:evil()" alt="坏图">
<p>控制字符测试：\u0000\u0008\u000b\u000c\u000e\u001f合法文字</p>
</main>
`;

const evilRes = await buildDocxFromHtml(evilHtml, "安全测试", { root: null });
const evilDoc = textOf(unzip(evilRes.bytes), "word/document.xml");

assertNoScriptTraces(evilDoc, "DOCX document.xml");
assert.ok(!evilDoc.includes("<script"), "不得包含 script 标签");
assert.ok(!evilDoc.includes("javascript:"), "不得包含 javascript: 伪协议");
assert.ok(evilDoc.includes("合法文字"), "控制字符清除后正常文字保留");
assert.deepEqual(findIllegalXmlChars(evilDoc), [], "清除全部非法控制字符");
console.log("✓ 恶意内容拦截与 XML 安全性验证通过");

/* ------------------------------------------------------------------ *
 * 6. 目标路径保护（保护原始 Markdown 手稿）
 * ------------------------------------------------------------------ */

// 6.1 绝对不能覆盖正在编辑的源文件
assert.notEqual(
  validateExportTarget("/home/user/novel/ch01.md", "ch01.md", "/home/user/novel"),
  "",
  "目标与源文件绝对路径一致时必须拦截",
);

// 6.2 不能把导出格式改成 .md / .txt
assert.notEqual(validateExportTarget("/home/user/export/out.md"), "", "不能导出为 .md");
assert.notEqual(validateExportTarget("/home/user/export/out.txt"), "", "不能导出为 .txt");
assert.notEqual(validateExportTarget("/home/user/export/out.markdown"), "", "不能导出为 .markdown");

// 6.3 合法的 .docx 路径通过
assert.equal(validateExportTarget("/home/user/export/out.docx"), "", "合法的 .docx 允许");
assert.equal(
  validateExportTarget("/home/user/novel/ch01.docx", "ch01.md", "/home/user/novel"),
  "",
  "同名但扩展名为 .docx 允许",
);
console.log("✓ 目标路径校验（手稿防覆盖）验证通过");

/* ------------------------------------------------------------------ *
 * 7. 动作层行为（取消、拦截与报告）
 * ------------------------------------------------------------------ */

// 7.1 用户在文件对话框中点「取消」
const cancelRes = await saveDocxExport({
  markdown: "# 测试",
  title: "取消测试",
  root: null,
  pickTarget: async () => null, // 模拟用户取消
});
assert.equal(cancelRes.cancelled, true, "应标记为取消");
assert.equal(cancelRes.path, null, "取消时路径为 null");
assert.ok(cancelRes.report.summary.includes("已取消"), "诚实报告已取消，不谎报成功");

// 7.2 用户选择了非法目标（例如覆盖当前 md）
const blockedRes = await saveDocxExport({
  markdown: "# 测试",
  title: "拦截测试",
  root: "/ws",
  sourcePath: "ch01.md",
  pickTarget: async () => "/ws/ch01.md", // 用户尝试覆盖当前源文件
});
assert.equal(blockedRes.cancelled, false);
assert.equal(blockedRes.path, null, "拦截后不执行写入");
assert.ok(blockedRes.report.summary.includes("被拒绝"), "明确提示导出被拒绝");

// 7.3 成功流程（注入写盘替身，避免测试真的落盘）
let written: { target: string; base64: string } | null = null;
const okRes = await saveDocxExport({
  markdown: "# 成功章节\n\n正文内容",
  title: "成功章节",
  root: null,
  pickTarget: async () => "/tmp/export-test.docx",
  writeBinaryFile: async (target, base64) => {
    written = { target, base64 };
  },
});
assert.equal(okRes.cancelled, false);
assert.equal(okRes.path, "/tmp/export-test.docx");
assert.ok(okRes.report.summary.includes("/tmp/export-test.docx"), "只有真的写了盘才报路径");
assert.ok(written !== null, "写盘动作应被调用");
const writtenCheck: { target: string; base64: string } = written!;
assert.equal(writtenCheck.target, "/tmp/export-test.docx");
// 写下去的必须是真实 DOCX 容器（PK 头），不是 HTML
const writtenBytes = Buffer.from(writtenCheck.base64, "base64");
assert.equal(writtenBytes[0], 0x50, "写入内容应是 PK 开头的 zip");
assert.equal(writtenBytes[1], 0x4b, "写入内容应是 PK 开头的 zip");
assert.ok(writtenBytes.length > 5000, "DOCX 容器大小合理");

// 7.4 写盘失败必须抛出来（不能悄悄当作成功）
await assert.rejects(
  () =>
    saveDocxExport({
      markdown: "# 失败章节",
      title: "失败章节",
      root: null,
      pickTarget: async () => "/tmp/export-fail.docx",
      writeBinaryFile: async () => {
        throw new Error("磁盘已满");
      },
    }),
  /磁盘已满/,
  "写盘失败必须让调用方看到错误",
);
console.log("✓ 动作层取消/拦截/成功/失败报告验证通过");

console.log("=== 所有 DOCX 导出测试通过 ===");
