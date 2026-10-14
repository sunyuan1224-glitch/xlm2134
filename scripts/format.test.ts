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

/* ------------------------------------------------------------------ *
 * 6. 标题等级（Ctrl+1..6 / Ctrl+0）：设置、同级取消、跨行、摘掉旧标记
 * ------------------------------------------------------------------ */
{
  const doc = "# 第一章\n\n正文一。\n\n- 列表项\n";

  // 光标所在段落升为标题；段落外（前后空行、别的段落）一律不动
  assert.equal(
    run(doc, at(doc, "正文一。"), { k: "heading", level: 1 }),
    "# 第一章\n\n# 正文一。\n\n- 列表项\n",
    "光标所在段落升为一级标题",
  );

  // 同级再按一次 = 取消标题（Ctrl+1 因而兼作开关）
  assert.equal(run("# 正文一。", 0, { k: "heading", level: 1 }), "正文一。", "同级再按一次取消标题");

  // 换级别就是直接改（不是叠加）
  assert.equal(run("## 正文一。", 0, { k: "heading", level: 4 }), "#### 正文一。", "二级标题改成四级");
  assert.equal(run("#### 正文一。", 0, { k: "heading", level: 2 }), "## 正文一。", "四级标题改成二级");

  // Ctrl+0：显式变回正文；对本来就是正文的段落不变
  assert.equal(run("###### 正文一。", 0, { k: "heading", level: 0 }), "正文一。", "Ctrl+0 变回正文");
  assert.equal(run("正文一。", 0, { k: "heading", level: 0 }), "正文一。", "普通段落按 Ctrl+0 无变化");

  // 列表 / 引用行升为标题时，原标记要摘掉，不留 `# - 内容` 这种混血行
  assert.equal(run("- 列表项", 0, { k: "heading", level: 2 }), "## 列表项", "列表项升标题时摘掉列表标记");
  assert.equal(run("> 引用", 0, { k: "heading", level: 3 }), "### 引用", "引用升标题时摘掉引用标记");
  assert.equal(run("- [ ] 待办", 0, { k: "heading", level: 1 }), "# 待办", "任务框升标题时整条摘掉，不剩 [ ]");

  // 选区覆盖多行 → 整块都设成同一级
  const two = "甲。\n乙。\n";
  assert.equal(sel(two, 0, two.length - 1, { k: "heading", level: 2 }), "## 甲。\n## 乙。\n", "选区覆盖的两行一起设标题");

  // 连续非空行算一个段落（Markdown 的软换行），整段一起升
  const soft = "甲。\n乙。";
  assert.equal(run(soft, at(soft, "甲。"), { k: "heading", level: 1 }), "# 甲。\n# 乙。", "软换行的整段一起升为标题");

  // 光标位置：设置后仍落在同一行里（不会跑到文首/文末）
  const r = applyFormatToText("正文一。\n\n正文二。", 6, 6, { k: "heading", level: 1 });
  assert.equal(r.text, "正文一。\n\n# 正文二。", "只改光标所在段");
  assert.equal(r.text.slice(0, r.from).split("\n").length, 3, "光标仍停在第 3 行（原标题行）");
}

console.log("=== 所有 富文本 命令测试通过 ===");
