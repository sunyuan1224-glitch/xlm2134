/*
 * 富文本命令的纯文本层测试（applyFormatToText），不依赖 DOM/CodeMirror。
 *
 * 覆盖小说写作里仍然保留的命令：行内加粗/斜体/下划线/删除线、引用、无序/有序列表、
 * 分割线、超链接/图片插入、段落删除/复制/下移、清除格式、原样插入文本。
 * （表格命令与「通用 Markdown 编辑器」一起删除了，这里不再覆盖。）
 *
 * 所有命令的共同约束：不损坏 Markdown 原文；同一命令执行两次回到原状。
 */
import assert from "node:assert/strict";
import { applyFormatToText } from "../src/lib/format";

/** 在某段文字里定位一次（找不到就报错，避免探针自己写错位置） */
function at(text: string, needle: string, offset = 0): number {
  const i = text.indexOf(needle);
  assert.ok(i >= 0, `测试用例里找不到锚点：${needle}`);
  return i + offset;
}

/** 在光标处（空选区）执行命令，返回整篇文本 */
const run = (text: string, pos: number, cmd: Parameters<typeof applyFormatToText>[3]) =>
  applyFormatToText(text, pos, pos, cmd).text;

/** 对一段选区执行命令，返回整篇文本 */
const sel = (text: string, from: number, to: number, cmd: Parameters<typeof applyFormatToText>[3]) =>
  applyFormatToText(text, from, to, cmd).text;

/* ------------------------------------------------------------------ *
 * 1. 行内格式：加标记；同一命令再作用于整段带标记文本 = 取消
 * ------------------------------------------------------------------ */
{
  const bold = sel("正文。", 0, 3, { k: "inline", style: "bold" });
  assert.equal(bold, "**正文。**", "加粗包裹选区");
  assert.equal(sel(bold, 0, bold.length, { k: "inline", style: "bold" }), "正文。", "对已加粗文本再加粗 = 取消加粗");

  assert.equal(sel("正文。", 0, 3, { k: "inline", style: "italic" }), "*正文。*", "斜体");
  assert.equal(sel("正文。", 0, 3, { k: "inline", style: "underline" }), "<u>正文。</u>", "下划线");
  assert.equal(sel("正文。", 0, 3, { k: "inline", style: "strike" }), "~~正文。~~", "删除线");

  // 空选区也会插入一对标记，光标落在中间
  const empty = applyFormatToText("正文。", 1, 1, { k: "inline", style: "bold" });
  assert.equal(empty.text, "正****文。", "空选区插入成对标记");
  assert.equal(empty.from, 3, "光标落在标记中间");
  assert.equal(empty.to, 3);
}

/* ------------------------------------------------------------------ *
 * 2. 引用 / 列表：加行首标记；再执行一次取消
 * ------------------------------------------------------------------ */
{
  const quoted = run("正文。", 0, { k: "quote" });
  assert.equal(quoted, "> 正文。", "引用加 > 前缀");
  assert.equal(run(quoted, 2, { k: "quote" }), "正文。", "对已引用段落再执行 = 取消引用");

  const ul = run("正文。", 0, { k: "list", kind: "ul" });
  assert.equal(ul, "- 正文。", "无序列表");
  assert.equal(run(ul, 2, { k: "list", kind: "ul" }), "正文。", "对已是无序列表的段落再执行 = 取消");

  assert.equal(run("正文。", 0, { k: "list", kind: "ol" }), "1. 正文。", "有序列表");
}

/* ------------------------------------------------------------------ *
 * 3. 分割线 / 链接 / 图片 / 原样插入
 * ------------------------------------------------------------------ */
{
  const hr = run("正文。", 1, { k: "hr" });
  assert.ok(hr.includes("正文。") && hr.includes("---"), `分割线插在段落之后且不吞正文：${JSON.stringify(hr)}`);

  assert.equal(sel("正文。", 0, 3, { k: "link" }), "[正文。](url)", "超链接包裹选区");
  assert.equal(sel("正文。", 0, 3, { k: "image" }), "![正文。](src)", "图片包裹选区");

  const inserted = run("正文。", 1, { k: "insertText", text: "XY" });
  assert.equal(inserted, "正XY文。", "在光标处原样插入文本");
}

/* ------------------------------------------------------------------ *
 * 4. 段落删除 / 复制 / 下移
 * ------------------------------------------------------------------ */
{
  const doc = "甲段。\n\n乙段。\n\n丙段。";
  assert.equal(run(doc, at(doc, "乙段。"), { k: "paraDelete" }), "甲段。\n\n丙段。", "删除当前段落，保留相邻段落");

  const two = "甲段。\n\n乙段。";
  assert.equal(run(two, 0, { k: "paraDuplicate" }), "甲段。\n\n甲段。\n\n乙段。", "复制当前段落");

  assert.equal(run(doc, at(doc, "乙段。"), { k: "paraMove", dir: 1 }), "甲段。\n\n丙段。\n\n乙段。", "段落下移与后一段互换");
  assert.equal(run(doc, 0, { k: "paraMove", dir: -1 }), doc, "第一段不能再上移（原样返回）");
}

/* ------------------------------------------------------------------ *
 * 5. 清除格式：摘掉标题 / 引用 / 列表标记与行内标记
 * ------------------------------------------------------------------ */
{
  assert.equal(run("# 标题 **粗** `码`", 0, { k: "clearFormat" }), "标题 粗 码", "去掉标题与行内标记，正文保留");
  assert.equal(run("- 项目", 1, { k: "clearFormat" }), "项目", "去掉列表标记");
  assert.equal(run("> 引用 ~~删~~", 0, { k: "clearFormat" }), "引用 删", "去掉引用与删除线标记");
}

console.log("=== 所有 富文本 命令测试通过 ===");
