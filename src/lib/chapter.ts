/** 章节排序与编号：支持阿拉伯数字、中文数字与罗马数字 */

const CN_DIGITS: Record<string, number> = {
  零: 0, 一: 1, 壹: 1, 二: 2, 贰: 2, 两: 2, 三: 3, 叁: 3, 四: 4, 肆: 4,
  五: 5, 伍: 5, 六: 6, 陆: 6, 七: 7, 柒: 7, 八: 8, 捌: 8, 九: 9, 玖: 9,
};
const CN_UNITS: Record<string, number> = { 十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000 };

/** 中文数字转阿拉伯数字，支持「一百二十三」「壹佰贰拾叁」 */
export function cnToNumber(s: string): number {
  if (!s) return NaN;
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const ch of s) {
    if (ch in CN_DIGITS) {
      digit = CN_DIGITS[ch];
    } else if (ch in CN_UNITS) {
      const unit = CN_UNITS[ch];
      section += (digit || 1) * unit;
      digit = 0;
      if (unit >= 1000) {
        total += section;
        section = 0;
      }
    } else if (ch === "万") {
      total = (total + section + digit) * 10000;
      section = 0;
      digit = 0;
    } else {
      return NaN;
    }
  }
  const result = total + section + digit;
  return Number.isFinite(result) ? result : NaN;
}

export function formatCnNumber(n: number): string {
  if (n === 0) return "零";
  const d = "零一二三四五六七八九";

  function sectionToCn(val: number): string {
    const units = ["", "十", "百", "千"];
    let str = "";
    let needZero = false;
    // 从千位向个位处理
    const qian = Math.floor(val / 1000);
    const bai = Math.floor((val % 1000) / 100);
    const shi = Math.floor((val % 100) / 10);
    const ge = val % 10;
    const digits = [qian, bai, shi, ge];

    for (let i = 0; i < 4; i++) {
      const v = digits[i];
      const unit = units[3 - i];
      if (v === 0) {
        if (str.length > 0) {
          needZero = true;
        }
      } else {
        if (needZero) {
          str += "零";
          needZero = false;
        }
        str += d[v] + unit;
      }
    }
    return str;
  }

  const yi = Math.floor(n / 100000000);
  const wan = Math.floor((n % 100000000) / 10000);
  const ge = n % 10000;

  let result = "";
  if (yi > 0) {
    result += sectionToCn(yi) + "亿";
  }
  if (wan > 0) {
    if (yi > 0 && wan < 1000) result += "零";
    result += sectionToCn(wan) + "万";
  }
  if (ge > 0) {
    if ((yi > 0 || wan > 0) && ge < 1000) result += "零";
    result += sectionToCn(ge);
  }

  // 中文习惯：十~十九不读“一十”，读“十”
  result = result.replace(/^一十/, "十");
  return result || "零";
}

export function parseNumber(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  const v = cnToNumber(t);
  return Number.isNaN(v) ? null : v;
}

export interface ChapterSortKey {
  index: number;
  number: number | null;
}

/** 从文件名或标题提取章节序号 */
export function extractChapterNumber(name: string): number | null {
  // 优先匹配「第X章」「第X回」「第X节」
  const m = name.match(/第\s*([0-9零一二三四五六七八九十百千两壹贰叁肆伍陆柒捌玖拾佰仟万]+)\s*[章回节集]/);
  if (m) return parseNumber(m[1]);
  // 罗马数字章号（第IX章）要单独认：中文字符类里没有 I/V/X
  const roman = name.match(/第\s*([IVXLCDMivxlcdm]+)\s*[章回节集]/);
  if (roman) {
    const n = romanToNumber(roman[1]);
    if (Number.isFinite(n)) return n;
  }
  // 其次匹配前缀数字 001-xxx
  const m2 = name.match(/^\s*(\d+)/);
  if (m2) return parseInt(m2[1], 10);
  return null;
}

export function extractVolumeNumber(name: string): number | null {
  const m = name.match(/第\s*([0-9零一二三四五六七八九十百千两壹贰叁肆伍陆柒捌玖拾佰仟万]+)\s*[卷部篇]/);
  if (m) return parseNumber(m[1]);
  const prefix = name.match(/^\s*卷\s*([0-9零一二三四五六七八九十百千两壹贰叁肆伍陆柒捌玖拾佰仟万]+)/);
  if (prefix) return parseNumber(prefix[1]);
  const m2 = name.match(/^\s*(\d+)/);
  if (m2) return parseInt(m2[1], 10);
  return null;
}

/** 新建卷以目录表示；兼容「第一卷 xxx」「卷一」「Volume 1」等常见命名。 */
export function isVolumeDirectoryName(name: string): boolean {
  return (
    /^\s*第\s*[0-9零一二三四五六七八九十百千两壹贰叁肆伍陆柒捌玖拾佰仟万]+\s*[卷部篇]/.test(name) ||
    /^\s*卷\s*[0-9零一二三四五六七八九十百千两壹贰叁肆伍陆柒捌玖拾佰仟万]+/.test(name) ||
    /^\s*vol(?:ume)?\s*\d+/i.test(name)
  );
}

/** 纲要文件夹名：书目录下的 outline/，所有纲要（总纲/卷纲/章节纲要）都是它下面的 .md 文件 */
export const OUTLINE_DIR = "outline";

/**
 * 纲要文档不应计入章节列表、字数或章节工具。
 * 新模型：书目录下 outline/ 文件夹里的任何文件都是纲要；
 * 旧模型（兼容既有工作区）：书级 总纲.md、卷级 卷纲.md 仍按纲要处理。
 */
export function isOutlineFile(path: string): boolean {
  const norm = path.replace(/\\/g, "/");
  if (norm.split("/").includes(OUTLINE_DIR)) return true;
  return /(?:^|[\\/])(?:总纲|卷纲)\.md$/i.test(path);
}

export function isLoreFile(path: string): boolean {
  return path.includes("_设定") || /[\\/](设定|角色|世界观|地点|组织|道具|能力)[^\\/]*\.md$/i.test(path);
}

export function isChapterFile(path: string): boolean {
  if (isLoreFile(path)) return false;
  if (path.split("/").some((s) => s.startsWith("."))) return false;
  return path.endsWith(".md") && !isOutlineFile(path) && !/(作品信息|伏笔|时间线|任务|便签)\.md$/.test(path);
}

/** 获取完整父目录路径，例如 "a/b/c.md" -> "a/b"，根目录文件返回 "" */
export function dirName(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(0, idx) : "";
}

/** 最后一段。先把反斜杠折成斜杠：Windows 上的工作区根是 `D:\小说` 这种绝对路径，
 *  只按 "/" 切会把整条路径原样吐回来（状态栏、EPUB 书名都会跟着一起错）。 */
export function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1];
}

/** 文件名清洗：把路径分隔符等在部分平台上非法的字符换成「、」，避免写出非法路径 */
export function sanitizeFileName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]/g, "、")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 新建文件/文件夹的名称校验。返回错误文案，合法时返回空串。
 * 重点拦住「创建成功但树里看不见」的名称：`.`、`..` 与 `.` 开头的隐藏名
 * （scan 会过滤掉隐藏文件），以及控制字符。
 */
export function validateEntryName(raw: string): string {
  const name = raw.trim();
  if (!name) return "请输入名称";
  if (name === "." || name === "..") return "不能使用 . 或 .. 作为名称";
  if (name.startsWith(".")) return "以 . 开头的名称会被工作区隐藏，请换一个名称";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return "名称不能包含控制字符";
  if (!sanitizeFileName(name)) return "名称包含非法字符";
  return "";
}

/** 罗马数字的字形表，从大到小；同时用来解析和生成 */
const ROMAN_UNITS: [string, number][] = [
  ["M", 1000], ["CM", 900], ["D", 500], ["CD", 400], ["C", 100], ["XC", 90],
  ["L", 50], ["XL", 40], ["X", 10], ["IX", 9], ["V", 5], ["IV", 4], ["I", 1],
];

export function romanToNumber(text: string): number {
  const s = text.toUpperCase();
  if (!/^[IVXLCDM]+$/.test(s)) return NaN;
  let n = 0;
  for (let i = 0; i < s.length; ) {
    const pair = s.slice(i, i + 2);
    const two = ROMAN_UNITS.find(([sym]) => sym.length === 2 && sym === pair);
    if (two) {
      n += two[1];
      i += 2;
      continue;
    }
    const one = ROMAN_UNITS.find(([sym]) => sym.length === 1 && sym === s[i]);
    if (!one) return NaN;
    n += one[1];
    i += 1;
  }
  return n;
}

export function formatRomanNumber(n: number): string {
  if (!Number.isInteger(n) || n <= 0 || n > 3999) return String(n);
  let rest = n;
  let out = "";
  for (const [sym, v] of ROMAN_UNITS) {
    for (; rest >= v; rest -= v) out += sym;
  }
  return out;
}

/** 「第X章」的头部：章号可以是中文数字、阿拉伯数字或罗马数字 */
const CHAPTER_NAME_RE =
  /^第\s*([0-9]+|[零一二三四五六七八九十百千两壹贰叁肆伍陆柒捌玖拾佰仟万]+|[IVXLCDMivxlcdm]+)\s*章/;

/** 章号后面允许出现的东西：空着，或者「分隔符 / 空白 + 标题」 */
const CHAPTER_TITLE_SEP_RE = /^[\s·、,，.。:：;；\-—_/|]/;

/**
 * 新建章节的默认名：接着**前一章**的章号往下排，数字体系跟着前一章走。
 *
 *   第一章 → 第二章    第十章 → 第十一章    第 3 章 → 第4章
 *   第IX章 → 第X章     第一章 启程 → 第二章
 *
 * 只看前一章叫什么，不检查全书编号是否连着：前一章是「第四章」时默认名就是「第五章」，
 * 哪怕目录里缺了第二、三章——顺序乱了宁可让用户自己改，也不替用户猜。
 *
 * 章号后面的标题不会被带过来（应用只认数字，标题得自己写）；「第一章 启程」「第三章：群星」
 * 都算第X章，「第一章后记」不算（那是另一个词），「第X回 / 第X节」也不算。
 * 前一章不是「第X章」这个格式、或者根本没有前一章时返回 null，由调用方回落到 Untitled。
 */
export function nextChapterName(prevName: string | null | undefined): string | null {
  if (!prevName) return null;
  const stem = prevName.trim().replace(/\.md$/i, "");
  const m = CHAPTER_NAME_RE.exec(stem);
  if (!m) return null;
  const tail = stem.slice(m[0].length);
  if (tail && !CHAPTER_TITLE_SEP_RE.test(tail)) return null;
  const raw = m[1];
  if (/^[0-9]+$/.test(raw)) return `第${Number(raw) + 1}章`;
  if (/^[IVXLCDM]+$/i.test(raw)) {
    const n = romanToNumber(raw);
    return Number.isFinite(n) ? `第${formatRomanNumber(n + 1)}章` : null;
  }
  const n = parseNumber(raw);
  return n === null ? null : `第${formatCnNumber(n + 1)}章`;
}
