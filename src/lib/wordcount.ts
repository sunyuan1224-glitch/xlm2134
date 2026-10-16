/*
 * 字数口径。**左侧树的数字、状态栏的「全书」、挂件的「今日已写」和沉浸模式的字数
 * 全都吃这一份**（store 那边也调这里，别再各写一份 —— 两处口径不一致的话，保存 / 刷新
 * 那一刻数字会莫名其妙跳一下，例如从 3200 变成 3222）。
 *
 * 默认口径是「字符」：**每个非空白字符算 1** —— 汉字、英文、数字、标点都算进去，
 * 空格 / 换行 / 制表符不算（中文写作里常说的那个「字数」，就是不计空格的字符数）。
 * 「只算汉字、标点不计、西文按词」的那套见下面的 cjk-word，现在是个可选口径。
 */
export type CountMode = "cjk-word" | "char" | "paragraph";

const CJK = /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af\uf900-\ufaff]/;
const NO_COUNT = /<!--\s*nw:no[\s\S]*?-->/g;
const NO_COUNT_BLOCK = /<!--\s*nw:no:start[\s\S]*?<!--\s*nw:no:end\s*-->/g;
// \r? 是为了兼容 CRLF：别处（volume.ts）已经这么写了，这里漏掉会让
// 「外部编辑器存成 CRLF 的章节」把整段 YAML 头也算进字数。
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;
const CODE_BLOCK = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]*`/g;
/** 「字符」口径里剔掉的：空格 / 换行 / 制表符等一切空白 */
const WHITESPACE_ALL = /\s/g;
/** 代理对（增补平面字符，如 emoji 与生僻字）：有它才需要按码位重算 */
const SURROGATE = /[\uD800-\uDFFF]/;

/** 剔除不参与统计的区域 */
export function stripNonCount(text: string): string {
  return text
    .replace(NO_COUNT_BLOCK, "")
    .replace(NO_COUNT, "")
    .replace(CODE_BLOCK, "")
    .replace(INLINE_CODE, "");
}

export function countWords(text: string, mode: CountMode = "char"): number {
  const body = stripNonCount(text.replace(FRONTMATTER, ""));
  switch (mode) {
    case "char":
      return countChars(body);
    case "paragraph":
      return body.split(/\n\s*\n/).filter((p) => p.trim().length > 0).length;
    case "cjk-word":
    default: {
      let count = 0;
      let inWord = false;
      for (const ch of body) {
        if (CJK.test(ch)) {
          count++;
          inWord = false;
        } else if (/[\p{L}\p{N}]/u.test(ch)) {
          if (!inWord) {
            count++;
            inWord = true;
          }
        } else {
          inWord = false;
        }
      }
      return count;
    }
  }
}

/**
 * 非空白字符数：汉字、英文、数字、标点各算 1，空格 / 换行 / 制表符不算。
 *
 * 按**码位**数而不是 UTF-16 单元 —— emoji 与增补平面的生僻字算一个字符，不是两个。
 * 所以先看这份正文里有没有代理对：没有（绝大多数稿件）就直接用长度，有才逐码位走一遍。
 * 空格一律是 BMP 字符，所以 `replace` 掉它们不影响码位数。
 *
 * 顺手说下开销：单章扫描实测 1 万 0.15ms / 5 万 0.78ms / 20 万 1.55ms，而它最多 100ms
 * 收一次数，打字这一路感觉不到。
 */
function countChars(body: string): number {
  const dense = body.replace(WHITESPACE_ALL, "");
  return SURROGATE.test(dense) ? [...dense].length : dense.length;
}

export function formatNumber(n: number): string {
  return n.toLocaleString("zh-CN");
}
