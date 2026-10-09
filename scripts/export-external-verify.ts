/*
 * 外部合规性体检（不是自证）：把真实产物写到临时目录，交给**系统工具**独立验证。
 *
 *   - python3 zipfile：ZIP 结构完整、每个 XML 部件都能被 expat 解析、
 *     EPUB 的 mimetype 是第一个条目且 compress_type == 0（OCF 硬性要求）；
 *   - xmllint（libxml2）：nav.xhtml / 章节 XHTML / content.opf / toc.ncx 真的能通过 XML 解析。
 *
 * 为什么要有这一步：自家写的字符串断言再严也只是「我同意我自己」，
 * 用另一套实现的解析器再验一遍，才算真的证明「文件打得开」。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildDocx } from "../src/lib/docxExport";
import { buildEpub } from "../src/lib/epubExport";
import { PNG_2X3 } from "./export-test-kit";

console.log("=== 外部合规性体检（python3 zipfile + xmllint）开始 ===");

const dir = await mkdtemp(join(tmpdir(), "mynovel-verify-"));
try {
  const docxFile = join(dir, "sample.docx");
  const epubFile = join(dir, "sample.epub");

  const docxRes = await buildDocx(
    "# 外部验证章节\n\n正文含 **加粗**、`代码` 与表格：\n\n| 列A | 列B |\n| --- | --- |\n| 1 | 2 |\n\n![插图](assets/pic.png)\n\n> 引用\n\n```js\nconst a = 1 < 2;\n```\n",
    "外部验证章节",
    { root: "/ws", baseDir: "ch", readImage: async () => PNG_2X3 },
  );
  await writeFile(docxFile, docxRes.bytes);

  const epubRes = await buildEpub({
    title: "EPUB 外部验证",
    author: "验证者",
    root: "/ws",
    identifier: "11111111-2222-4333-8444-555555555555",
    modified: "2026-10-06T00:00:00Z",
    readImage: async () => PNG_2X3,
    chapters: [
      { title: "第 1 章", markdown: "# 第 1 章\n\n正文。\n\n![插图](assets/pic.png)\n", path: "ch/01.md" },
      { title: "第 2 章", markdown: "# 第 2 章\n\n- 甲\n- 乙\n", path: "ch/02.md" },
    ],
  });
  await writeFile(epubFile, epubRes.bytes);
  assert.ok(docxRes.bytes.length > 5000, "DOCX 体积合理（不是空壳）");
  assert.ok(epubRes.bytes.length > 3000, "EPUB 体积合理（不是空壳）");

  const pyCode = `
import zipfile, xml.etree.ElementTree as ET

with zipfile.ZipFile(${JSON.stringify(docxFile)}) as z:
    bad = z.testzip()
    assert bad is None, f"DOCX zip 完整性失败: {bad}"
    entries = z.namelist()
    assert "word/document.xml" in entries, "缺少 word/document.xml"
    assert "[Content_Types].xml" in entries, "缺少 [Content_Types].xml"
    assert "_rels/.rels" in entries, "缺少 _rels/.rels"
    for name in entries:
        if name.endswith(".xml") or name.endswith(".rels"):
            ET.fromstring(z.read(name))
print("Python: DOCX ZIP 完整性 + 全部 XML 部件语法合规")

with zipfile.ZipFile(${JSON.stringify(epubFile)}) as z:
    bad = z.testzip()
    assert bad is None, f"EPUB zip 完整性失败: {bad}"
    entries = z.namelist()
    assert entries[0] == "mimetype", f"mimetype 必须是第一个条目，实际第一个是 {entries[0]}"
    info = z.getinfo("mimetype")
    assert info.compress_type == 0, f"mimetype 必须 stored，实际 compress_type={info.compress_type}"
    assert z.read("mimetype") == b"application/epub+zip"
    assert z.read("META-INF/container.xml").count(b"OEBPS/content.opf") == 1
    for name in entries:
        if name.endswith((".xml", ".opf", ".ncx", ".xhtml")):
            ET.fromstring(z.read(name))
    assert "OEBPS/images/image-1.png" in entries, "图片资源应写进包内"
print("Python: EPUB 完整性 + mimetype 位置/压缩方式 + 全部 XML/XHTML 语法合规")
`;
  const py = spawnSync("python3", ["-c", pyCode], { encoding: "utf-8" });
  if (py.status !== 0) {
    console.error(py.stdout);
    console.error(py.stderr);
    throw new Error("python3 校验失败");
  }
  console.log(py.stdout.trim());

  const unzip = spawnSync("unzip", ["-q", epubFile, "-d", join(dir, "epub")], { encoding: "utf-8" });
  assert.equal(unzip.status, 0, `unzip 解包失败：${unzip.stderr}`);
  for (const rel of ["OEBPS/nav.xhtml", "OEBPS/content.opf", "OEBPS/toc.ncx", "OEBPS/text/chapter-1.xhtml"]) {
    const lint = spawnSync("xmllint", ["--noout", join(dir, "epub", rel)], { encoding: "utf-8" });
    if (lint.status !== 0) throw new Error(`xmllint ${rel} 报错：${lint.stderr}`);
  }

  const docxDir = join(dir, "docx");
  assert.equal(spawnSync("unzip", ["-q", docxFile, "-d", docxDir]).status, 0);
  for (const rel of ["word/document.xml", "word/styles.xml", "[Content_Types].xml"]) {
    const lint = spawnSync("xmllint", ["--noout", join(docxDir, rel)], { encoding: "utf-8" });
    if (lint.status !== 0) throw new Error(`xmllint ${rel} 报错：${lint.stderr}`);
  }
  console.log("xmllint: DOCX/EPUB 的关键 XML/XHTML 经 libxml2 独立解析通过");
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log("=== 外部合规性体检全部通过 ===");
