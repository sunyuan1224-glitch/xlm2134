export type CountMode = "cjk-word" | "char" | "paragraph";

const CJK = /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af\uf900-\ufaff]/;
const NO_COUNT = /<!--\s*nw:no[\s\S]*?-->/g;
const NO_COUNT_BLOCK = /<!--\s*nw:no:start[\s\S]*?<!--\s*nw:no:end\s*-->/g;
// \r? 是为了兼容 CRLF：别处（volume.ts）已经这么写了，这里漏掉会让
// 「外部编辑器存成 CRLF 的章节」把整段 YAML 头也算进字数。
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;
const CODE_BLOCK = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]*`/g;

/** 剔除不参与统计的区域 */
export function stripNonCount(text: string): string {
  return text
    .replace(NO_COUNT_BLOCK, "")
    .replace(NO_COUNT, "")
    .replace(CODE_BLOCK, "")
    .replace(INLINE_CODE, "");
}

export function countWords(text: string, mode: CountMode = "cjk-word"): number {
  const body = stripNonCount(text.replace(FRONTMATTER, ""));
  switch (mode) {
    case "char":
      return [...body].filter((c) => !/\s/.test(c)).length;
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

export function formatNumber(n: number): string {
  return n.toLocaleString("zh-CN");
}
