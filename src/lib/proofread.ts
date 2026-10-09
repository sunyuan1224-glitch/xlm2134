/**
 * 本地校对引擎核心（P2）
 *
 * 纯函数、零依赖、不触碰 DOM / store / Tauri，可直接在浏览器或测试里跑。
 *
 * 能力：
 *  1. 词典规则：错词（错别字 / 异形词）、敏感词，词典可扩展、可替换
 *  2. 中文标点规则：中文语境里的半角标点、重复标点、省略号、括号、引号、标点旁空格
 *  3. 中英文标点规则：中英混排里的全角标点、中英之间缺空格、括号内纯英文
 *  4. 的/地/得规则：可选（默认关闭），保守启发式 + 白名单
 *  5. 近义词一致性检测：同一篇（或整个作品）里「好像 / 好象」这类异形词混用
 *
 * 输出问题统一为 ProofreadIssue：line / from / to / kind / message / suggestion
 *   - line 从 1 开始；from / to 是相对整篇文本的 UTF-16 偏移（与 CodeMirror 一致），区间为 [from, to)
 *   - suggestion 是「把 [from, to) 替换成什么」，空串表示建议删除；applyFix 可直接套用
 *
 * 忽略匹配：
 *  - issueKey(issue) 得到稳定键 kind|ruleId|text，用于忽略某一次命中
 *  - IgnoreRule { ruleId?, text?, kind?, line? } 可忽略某条规则的某类文本（字段越多越精确）
 *  - 通过 options.ignore 传入，或用 filterIgnored / isIgnored 事后过滤
 */

export type IssueKind = "typo" | "sensitive" | "punctuation" | "mixed" | "dede" | "synonym";

export type Severity = "error" | "warn" | "info";

export interface ProofreadIssue {
  /** 1 起的行号 */
  line: number;
  /** 起始偏移（含） */
  from: number;
  /** 结束偏移（不含） */
  to: number;
  kind: IssueKind;
  message: string;
  /** 建议替换 [from, to) 的文本；"" 表示建议删除 */
  suggestion: string;
  /** 规则 id，如 "typo" / "punct.halfwidth" / "synonym.好像" */
  ruleId: string;
  /** 命中的原文 */
  text: string;
  severity: Severity;
}

/* ------------------------------------------------------------------ */
/* 词典                                                                */
/* ------------------------------------------------------------------ */

export interface DictEntry {
  /** 要匹配的文本；regex 为 true 时是正则源码 */
  from: string;
  /** 建议替换成什么；省略表示「无可替换建议」（如敏感词，需人工改写） */
  to?: string;
  kind?: "typo" | "sensitive";
  severity?: Severity;
  note?: string;
  regex?: boolean;
  caseSensitive?: boolean;
}

/** 近义词 / 异形词一致性分组：同一篇里混用则提示统一到 preferred */
export interface SynonymGroup {
  name: string;
  variants: string[];
  preferred?: string;
  note?: string;
}

export interface ProofreadDictionary {
  typos: DictEntry[];
  sensitives: DictEntry[];
  synonyms: SynonymGroup[];
}

/** 基础错词表：常见错别字与异形词（可继续追加） */
const DEFAULT_TYPOS: DictEntry[] = [
  { from: "因该", to: "应该" },
  { from: "即然", to: "既然" },
  { from: "竞然", to: "竟然" },
  { from: "必竟", to: "毕竟" },
  { from: "决对", to: "绝对" },
  { from: "竟争", to: "竞争" },
  { from: "部置", to: "布置" },
  { from: "布署", to: "部署" },
  { from: "按耐不住", to: "按捺不住" },
  { from: "按步就班", to: "按部就班" },
  { from: "安份守己", to: "安分守己" },
  { from: "变本加利", to: "变本加厉" },
  { from: "变换莫测", to: "变幻莫测" },
  { from: "迫不急待", to: "迫不及待" },
  { from: "迫在眉梢", to: "迫在眉睫" },
  { from: "一如继往", to: "一如既往" },
  { from: "再所不惜", to: "在所不惜" },
  { from: "走头无路", to: "走投无路" },
  { from: "谈笑风声", to: "谈笑风生" },
  { from: "震憾", to: "震撼" },
  { from: "渲泄", to: "宣泄" },
  { from: "松驰", to: "松弛" },
  { from: "渡假", to: "度假" },
  { from: "严竣", to: "严峻" },
  { from: "慢延", to: "蔓延" },
  { from: "病入膏盲", to: "病入膏肓" },
  { from: "分道扬镖", to: "分道扬镳" },
  { from: "甘败下风", to: "甘拜下风" },
  { from: "天翻地复", to: "天翻地覆" },
  { from: "重蹈复辙", to: "重蹈覆辙" },
  { from: "言简意骇", to: "言简意赅" },
  { from: "默守成规", to: "墨守成规" },
  { from: "浮想连翩", to: "浮想联翩" },
  { from: "空前决后", to: "空前绝后" },
  { from: "声名雀起", to: "声名鹊起" },
  { from: "老俩口", to: "老两口" },
  { from: "亲睐", to: "青睐" },
  { from: "冒然", to: "贸然" },
  { from: "对恃", to: "对峙" },
  { from: "兴高彩烈", to: "兴高采烈" },
  { from: "神彩奕奕", to: "神采奕奕" },
  { from: "出奇不意", to: "出其不意" },
  { from: "精减", to: "精简" },
  { from: "取谛", to: "取缔" },
  { from: "重迭", to: "重叠" },
  { from: "冷不妨", to: "冷不防" },
  { from: "鬼计", to: "诡计" },
  { from: "阴谋鬼计", to: "阴谋诡计" },
  { from: "修茸", to: "修葺" },
  { from: "及及可危", to: "岌岌可危" },
  { from: "含辛如苦", to: "含辛茹苦" },
  { from: "相形见拙", to: "相形见绌" },
  { from: "九宵", to: "九霄" },
  { from: "争辨", to: "争辩" },
  { from: "陈词烂调", to: "陈词滥调" },
  { from: "妥贴", to: "妥帖" },
  { from: "一愁莫展", to: "一筹莫展" },
  { from: "仗义直言", to: "仗义执言" },
  { from: "各行其事", to: "各行其是" },
  { from: "莫明其妙", to: "莫名其妙" },
  { from: "涕笑皆非", to: "啼笑皆非" },
  { from: "相儒以沫", to: "相濡以沫" },
  { from: "金榜提名", to: "金榜题名" },
  { from: "顾名思意", to: "顾名思义" },
  { from: "稳操胜卷", to: "稳操胜券" },
  { from: "坐阵", to: "坐镇" },
  { from: "具乐部", to: "俱乐部" },
  { from: "决窍", to: "诀窍" },
  { from: "寒喧", to: "寒暄" },
  { from: "融汇贯通", to: "融会贯通" },
  { from: "弱不经风", to: "弱不禁风" },
  { from: "愤发图强", to: "奋发图强" },
  { from: "黄梁美梦", to: "黄粱美梦" },
  { from: "再接再励", to: "再接再厉" },
  { from: "出人投地", to: "出人头地" },
  { from: "破斧沉舟", to: "破釜沉舟" },
  { from: "顶礼莫拜", to: "顶礼膜拜" },
  { from: "名符其实", to: "名副其实" },
  { from: "惹事生非", to: "惹是生非" },
  { from: "直接了当", to: "直截了当" },
  { from: "无动于中", to: "无动于衷" },
  { from: "义气用事", to: "意气用事" },
  { from: "轻歌慢舞", to: "轻歌曼舞" },
  { from: "有持无恐", to: "有恃无恐" },
  { from: "永往直前", to: "勇往直前" },
  { from: "不加思索", to: "不假思索" },
  { from: "禁若寒蝉", to: "噤若寒蝉" },
  { from: "另辟溪径", to: "另辟蹊径" },
  { from: "不落巢臼", to: "不落窠臼" },
  { from: "水乳交溶", to: "水乳交融" },
  { from: "张灯结采", to: "张灯结彩" },
  { from: "白璧无暇", to: "白璧无瑕" },
  { from: "不记其数", to: "不计其数" },
  { from: "蜂涌而至", to: "蜂拥而至" },
  { from: "星罗其布", to: "星罗棋布" },
  { from: "翻云复雨", to: "翻云覆雨" },
  { from: "萎糜不振", to: "萎靡不振" },
  { from: "恰如其份", to: "恰如其分" },
  { from: "神密", to: "神秘" },
  { from: "盘据", to: "盘踞" },
  { from: "致关重要", to: "至关重要" },
  { from: "波光鳞鳞", to: "波光粼粼" },
  { from: "大雨如柱", to: "大雨如注" },
  { from: "气慨", to: "气概" },
  { from: "提心掉胆", to: "提心吊胆" },
  { from: "大姆指", to: "大拇指" },
  { from: "罗嗦", to: "啰嗦" },
  { from: "混身", to: "浑身" },
  { from: "甜言密语", to: "甜言蜜语" },
  { from: "通霄", to: "通宵" },
  { from: "严惩不怠", to: "严惩不贷" },
  { from: "指手划脚", to: "指手画脚" },
  { from: "明辩是非", to: "明辨是非" },
  { from: "见风驶舵", to: "见风使舵" },
  { from: "珠光宝器", to: "珠光宝气" },
  { from: "不可就药", to: "不可救药" },
  { from: "蜇伏", to: "蛰伏" },
  { from: "坐收鱼利", to: "坐收渔利" },
  { from: "心恢意冷", to: "心灰意冷" },
  { from: "垂手可得", to: "唾手可得" },
  { from: "曲指可数", to: "屈指可数" },
  { from: "彷彿", to: "仿佛" },
  { from: "招骋", to: "招聘" },
  { from: "规距", to: "规矩" },
  { from: "按装", to: "安装" },
  { from: "帐号", to: "账号" },
  { from: "帐本", to: "账本" },
  { from: "帐目", to: "账目" },
  { from: "帐单", to: "账单" },
  { from: "结帐", to: "结账" },
  { from: "记帐", to: "记账" },
  { from: "对帐", to: "对账" },
  { from: "报帐", to: "报账" },
  { from: "觉的", to: "觉得" },
  { from: "值的", to: "值得" },
  { from: "懂的", to: "懂得" },
  { from: "记的", to: "记得" },
  { from: "显的", to: "显得" },
];

/** 基础敏感词表（平台审核常见拦截词 · 示例，请按需要增删） */
const DEFAULT_SENSITIVES: DictEntry[] = [
  { from: "自杀", severity: "warn", note: "平台审核敏感词，请确认是否需要改写" },
  { from: "毒品", severity: "warn", note: "平台审核敏感词，请确认是否需要改写" },
  { from: "赌博", severity: "warn", note: "平台审核敏感词，请确认是否需要改写" },
  { from: "枪支", severity: "warn", note: "平台审核敏感词，请确认是否需要改写" },
  { from: "炸弹", severity: "warn", note: "平台审核敏感词，请确认是否需要改写" },
];

/** 近义词一致性分组（现代规范写法放在 preferred） */
const DEFAULT_SYNONYMS: SynonymGroup[] = [
  { name: "好像", variants: ["好像", "好象"], preferred: "好像" },
  { name: "部分", variants: ["部分", "部份"], preferred: "部分" },
  { name: "其他", variants: ["其他", "其它"], preferred: "其他" },
  { name: "想象", variants: ["想象", "想像"], preferred: "想象" },
  { name: "交代", variants: ["交代", "交待"], preferred: "交代" },
  { name: "给予", variants: ["给予", "给与"], preferred: "给予" },
  { name: "一味", variants: ["一味", "一昧"], preferred: "一味" },
  { name: "刹那", variants: ["刹那", "霎那"], preferred: "刹那" },
  { name: "精彩", variants: ["精彩", "精采"], preferred: "精彩" },
  { name: "坐落", variants: ["坐落", "座落"], preferred: "坐落" },
  { name: "身份", variants: ["身份", "身分"], preferred: "身份" },
  { name: "过分", variants: ["过分", "过份"], preferred: "过分" },
  { name: "分量", variants: ["分量", "份量"], preferred: "分量" },
  { name: "唯一", variants: ["唯一", "惟一"], preferred: "唯一" },
  { name: "萎靡", variants: ["萎靡", "委靡"], preferred: "萎靡" },
  { name: "模拟", variants: ["模拟", "摹拟"], preferred: "模拟" },
  { name: "朦胧", variants: ["朦胧", "蒙胧", "矇眬"], preferred: "朦胧" },
  { name: "啰嗦", variants: ["啰嗦", "罗嗦", "噜苏"], preferred: "啰嗦" },
  { name: "搭档", variants: ["搭档", "搭挡"], preferred: "搭档" },
  { name: "缘故", variants: ["缘故", "原故"], preferred: "缘故" },
  { name: "姿势", variants: ["姿势", "姿式"], preferred: "姿势" },
];

export const DEFAULT_DICTIONARY: ProofreadDictionary = {
  typos: DEFAULT_TYPOS,
  sensitives: DEFAULT_SENSITIVES,
  synonyms: DEFAULT_SYNONYMS,
};

export function emptyDictionary(): ProofreadDictionary {
  return { typos: [], sensitives: [], synonyms: [] };
}

/**
 * 纯合并（不含默认词典）：后传入的词条覆盖同 from / 同 name 的旧词条，其余追加。
 */
export function mergeDictionaries(
  ...dicts: Partial<ProofreadDictionary>[]
): ProofreadDictionary {
  const out = emptyDictionary();
  for (const d of dicts) {
    for (const e of d.typos ?? []) {
      const i = out.typos.findIndex((x) => x.from === e.from && !!x.regex === !!e.regex);
      if (i >= 0) out.typos[i] = { ...out.typos[i], ...e };
      else out.typos.push({ ...e });
    }
    for (const e of d.sensitives ?? []) {
      const i = out.sensitives.findIndex((x) => x.from === e.from);
      if (i >= 0) out.sensitives[i] = { ...out.sensitives[i], ...e };
      else out.sensitives.push({ ...e });
    }
    for (const g of d.synonyms ?? []) {
      const i = out.synonyms.findIndex((x) => x.name === g.name);
      if (i >= 0) out.synonyms[i] = { ...out.synonyms[i], ...g };
      else out.synonyms.push({ ...g, variants: [...g.variants] });
    }
  }
  return out;
}

/** 在默认词典基础上扩展（最常用的入口） */
export function createDictionary(partial: Partial<ProofreadDictionary> = {}): ProofreadDictionary {
  return mergeDictionaries(DEFAULT_DICTIONARY, partial);
}

/* ------------------------------------------------------------------ */
/* 选项 / 忽略                                                          */
/* ------------------------------------------------------------------ */

export interface ProofreadRuleFlags {
  /** 错词（错别字 / 异形词） */
  typo: boolean;
  /** 敏感词 */
  sensitive: boolean;
  /** 中文标点规则 */
  cjkPunctuation: boolean;
  /** 中英文标点 / 混排规则 */
  mixedPunctuation: boolean;
  /** 中英文之间缺空格（信息级） */
  cjkLatinSpace: boolean;
  /** 的 / 地 / 得（可选，默认关闭：启发式，可能误报） */
  dede: boolean;
  /** 近义词一致性 */
  synonym: boolean;
}

export const DEFAULT_RULES: ProofreadRuleFlags = {
  typo: true,
  sensitive: true,
  cjkPunctuation: true,
  mixedPunctuation: true,
  cjkLatinSpace: true,
  dede: false,
  synonym: true,
};

export interface IgnoreRule {
  /** 只忽略该规则，如 "punct.halfwidth" */
  ruleId?: string;
  /** 只忽略该命中文本 */
  text?: string;
  kind?: IssueKind;
  /** 只忽略该行 */
  line?: number;
}

export interface IgnoreSpec {
  /** 按 [规则 + 文本] 忽略（面板的「忽略同类」） */
  rules?: IgnoreRule[];
  /** 按 issueKey 忽略（面板的「忽略」） */
  keys?: string[];
}

export interface ProofreadOptions extends Partial<ProofreadRuleFlags> {
  /** 词典；省略则用 DEFAULT_DICTIONARY；可用 createDictionary() 扩展 */
  dictionary?: ProofreadDictionary;
  ignore?: IgnoreSpec;
  /** 跳过 YAML frontmatter（默认 true，小说文件头部元数据不该被校对） */
  skipFrontmatter?: boolean;
  /** 跳过 ``` 代码块与 `行内代码`（默认 true） */
  skipCode?: boolean;
  /** 中文与阿拉伯数字之间也要求空格（默认 false，「第3章」不算问题） */
  cjkDigitSpace?: boolean;
  /** 近义词一致性的统计范围（默认 document，单篇内一致即可） */
  synonymScope?: "document" | "work";
  /** 单次最多返回多少条（默认 1000） */
  maxIssues?: number;
}

/** 稳定键：同一条规则命中同一段文本视为同一种问题 */
export function issueKey(issue: Pick<ProofreadIssue, "kind" | "ruleId" | "text">): string {
  return `${issue.kind}|${issue.ruleId}|${issue.text}`;
}

export function isIgnored(
  issue: Pick<ProofreadIssue, "kind" | "ruleId" | "text" | "line">,
  spec?: IgnoreSpec,
): boolean {
  if (!spec) return false;
  if (spec.keys?.includes(issueKey(issue))) return true;
  for (const r of spec.rules ?? []) {
    if (
      r.ruleId === undefined &&
      r.text === undefined &&
      r.kind === undefined &&
      r.line === undefined
    ) {
      continue; // 空规则忽略一切太危险，直接忽略该规则
    }
    if (r.ruleId !== undefined && r.ruleId !== issue.ruleId) continue;
    if (r.kind !== undefined && r.kind !== issue.kind) continue;
    if (r.line !== undefined && r.line !== issue.line) continue;
    if (r.text !== undefined && r.text !== issue.text) continue;
    return true;
  }
  return false;
}

export function filterIgnored(issues: ProofreadIssue[], spec?: IgnoreSpec): ProofreadIssue[] {
  if (!spec) return issues.slice();
  return issues.filter((i) => !isIgnored(i, spec));
}

/* ------------------------------------------------------------------ */
/* 字符工具                                                            */
/* ------------------------------------------------------------------ */

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

function isCjk(ch: string | undefined): boolean {
  return !!ch && ch.length === 1 && CJK_RE.test(ch);
}

function isLatin(ch: string | undefined): boolean {
  return !!ch && ((ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z"));
}

function isDigit(ch: string | undefined): boolean {
  return !!ch && ch >= "0" && ch <= "9";
}

function isWordChar(ch: string | undefined): boolean {
  return isLatin(ch) || isDigit(ch);
}

function isSpace(ch: string | undefined): boolean {
  return ch === " " || ch === "\t" || ch === "\u3000";
}

const CJK_PUNCT = "，。！？；：、）“”‘’…—～《》〈〉【】（）·「」『』";

function isCjkPunct(ch: string | undefined): boolean {
  return !!ch && CJK_PUNCT.indexOf(ch) >= 0;
}

const HALF_TO_FULL: Record<string, string> = {
  ",": "，",
  ".": "。",
  "?": "？",
  "!": "！",
  ":": "：",
  ";": "；",
};

const FULL_TO_HALF: Record<string, string> = {
  "，": ",",
  "。": ".",
  "？": "?",
  "！": "!",
  "：": ":",
  "；": ";",
};

/** 重复标点规则处理的标点（中文） */
const REPEATABLE_FULL = "，。！？；：、";
/** 重复标点规则处理的标点（半角，需中文语境） */
const REPEATABLE_HALF = "!?";

/** 规则优先级：数字越小越优先（重叠时保留优先级高的） */
const KIND_PRIORITY: Record<IssueKind, number> = {
  typo: 0,
  sensitive: 0,
  synonym: 1,
  dede: 1,
  punctuation: 2,
  mixed: 3,
};

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warn: 1, info: 2 };

interface Range {
  from: number;
  to: number;
}

export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

export function lineOf(starts: number[], pos: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

export interface IssueLocation {
  line: number;
  /** 1 起的列号（按 UTF-16 计） */
  column: number;
  /** 该行原文（不含换行） */
  lineText: string;
}

/** 计算问题所在的 行/列 与该行文本，供面板展示与外部定位使用 */
export function issueLocation(text: string, issue: { from: number; line?: number }): IssueLocation {
  const starts = lineStarts(text);
  const line = issue.line ?? lineOf(starts, issue.from);
  const start = starts[Math.min(Math.max(line - 1, 0), starts.length - 1)] ?? 0;
  let end = text.indexOf("\n", start);
  if (end < 0) end = text.length;
  return { line, column: issue.from - start + 1, lineText: text.slice(start, end) };
}

/* ------------------------------------------------------------------ */
/* 跳过区域：frontmatter / 代码                                          */
/* ------------------------------------------------------------------ */

function skipRanges(text: string, skipFrontmatter: boolean, skipCode: boolean): Range[] {
  const out: Range[] = [];
  if (skipFrontmatter) {
    const m = /^---[ \t]*\r?\n/.exec(text);
    if (m) {
      const close = text.indexOf("\n---", m[0].length);
      if (close >= 0) {
        const eol = text.indexOf("\n", close + 1);
        out.push({ from: 0, to: eol < 0 ? text.length : eol + 1 });
      }
    }
  }
  if (skipCode) {
    // 围栏代码块
    let fenceStart = -1;
    let pos = 0;
    while (pos <= text.length) {
      let eol = text.indexOf("\n", pos);
      if (eol < 0) eol = text.length;
      const line = text.slice(pos, eol);
      const isFence = /^[ \t]{0,3}(```|~~~)/.test(line);
      if (isFence && fenceStart < 0) fenceStart = pos;
      else if (isFence && fenceStart >= 0) {
        out.push({ from: fenceStart, to: Math.min(text.length, eol + 1) });
        fenceStart = -1;
      }
      if (eol >= text.length) break;
      pos = eol + 1;
    }
    if (fenceStart >= 0) out.push({ from: fenceStart, to: text.length });
    // 行内代码
    const re = /`[^`\n]*`/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) out.push({ from: m.index, to: m.index + m[0].length });
  }
  return out;
}

function inRanges(ranges: Range[], pos: number): boolean {
  for (const r of ranges) if (pos >= r.from && pos < r.to) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* Context                                                             */
/* ------------------------------------------------------------------ */

interface Ctx {
  text: string;
  dictionary: ProofreadDictionary;
  flags: ProofreadRuleFlags;
  cjkDigitSpace: boolean;
  skips: Range[];
  /** 近义词分组 -> 目标写法（跨篇统计时由外部注入） */
  synonymTarget: Map<string, string> | null;
  push: (issue: Omit<ProofreadIssue, "line">) => void;
  skip: (pos: number) => boolean;
}

function makeCtx(
  text: string,
  options: ProofreadOptions,
  synonymTarget: Map<string, string> | null = null,
): { ctx: Ctx; issues: Omit<ProofreadIssue, "line">[] } {
  const skips = skipRanges(
    text,
    options.skipFrontmatter !== false,
    options.skipCode !== false,
  );
  const issues: Omit<ProofreadIssue, "line">[] = [];
  const ctx: Ctx = {
    text,
    dictionary: options.dictionary ?? DEFAULT_DICTIONARY,
    flags: { ...DEFAULT_RULES, ...pickFlags(options) },
    cjkDigitSpace: options.cjkDigitSpace === true,
    skips,
    synonymTarget,
    push: (issue) => issues.push(issue),
    skip: (pos) => inRanges(skips, pos),
  };
  return { ctx, issues };
}

function pickFlags(options: ProofreadOptions): Partial<ProofreadRuleFlags> {
  const out: Partial<ProofreadRuleFlags> = {};
  for (const k of Object.keys(DEFAULT_RULES) as (keyof ProofreadRuleFlags)[]) {
    if (typeof options[k] === "boolean") out[k] = options[k] as boolean;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 规则：词典（错词 / 敏感词）                                            */
/* ------------------------------------------------------------------ */

function scanEntries(ctx: Ctx): void {
  const groups: { entries: DictEntry[]; kind: "typo" | "sensitive" }[] = [];
  if (ctx.flags.typo) groups.push({ entries: ctx.dictionary.typos, kind: "typo" });
  if (ctx.flags.sensitive) groups.push({ entries: ctx.dictionary.sensitives, kind: "sensitive" });

  /* 整篇小写只算一次：默认词典上百条，逐条重复 toLowerCase 等于把全文复制上百遍。
     懒计算，词典全是大小写敏感条目时一次都不做。 */
  let lowerText: string | null = null;
  const lower = () => (lowerText ??= ctx.text.toLowerCase());

  for (const g of groups) {
    for (const entry of g.entries) {
      if (!entry.from) continue;
      const kind = entry.kind ?? g.kind;
      const severity: Severity = entry.severity ?? (kind === "sensitive" ? "warn" : "error");
      const ruleId = kind === "sensitive" ? "sensitive" : "typo";

      if (entry.regex) {
        let re: RegExp;
        try {
          re = new RegExp(entry.from, entry.caseSensitive ? "g" : "gi");
        } catch {
          continue; // 词典里的坏正则不影响其它规则
        }
        let m: RegExpExecArray | null;
        while ((m = re.exec(ctx.text))) {
          if (m[0].length === 0) {
            re.lastIndex++;
            continue;
          }
          emitEntry(ctx, kind, ruleId, severity, entry, m.index, m.index + m[0].length, m[0]);
        }
        continue;
      }

      const hay = entry.caseSensitive ? ctx.text : lower();
      const needle = entry.caseSensitive ? entry.from : entry.from.toLowerCase();
      let idx = hay.indexOf(needle);
      while (idx >= 0) {
        emitEntry(
          ctx,
          kind,
          ruleId,
          severity,
          entry,
          idx,
          idx + entry.from.length,
          ctx.text.slice(idx, idx + entry.from.length),
        );
        idx = hay.indexOf(needle, idx + needle.length);
      }
    }
  }
}

function emitEntry(
  ctx: Ctx,
  kind: "typo" | "sensitive",
  ruleId: string,
  severity: Severity,
  entry: DictEntry,
  from: number,
  to: number,
  text: string,
): void {
  if (ctx.skip(from)) return;
  const suggestion = entry.to ?? "";
  const message =
    kind === "sensitive"
      ? `敏感词「${text}」${entry.note ? "：" + entry.note : "，请人工确认或改写"}`
      : suggestion && suggestion !== text
        ? `疑似错词：「${text}」建议改为「${suggestion}」${entry.note ? "（" + entry.note + "）" : ""}`
        : `疑似错词：「${text}」${entry.note ?? "请人工确认"}`;
  ctx.push({ from, to, kind, ruleId, message, suggestion, text, severity });
}

/* ------------------------------------------------------------------ */
/* 规则：中文标点                                                       */
/* ------------------------------------------------------------------ */

/** 中文语境里的半角标点 → 全角 */
function ruleHalfWidthPunct(ctx: Ctx): void {
  const t = ctx.text;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    const full = HALF_TO_FULL[ch];
    if (!full || ctx.skip(i)) continue;
    const prev = t[i - 1];
    const next = t[i + 1];
    if (!isCjk(prev) && !isCjk(next)) continue;
    if (ch === "," && isDigit(prev) && isDigit(next)) continue;
    if (ch === "." && (prev === "." || next === ".")) continue; // 交给省略号规则
    if (ch === "." && isDigit(prev) && isDigit(next)) continue;
    if ((ch === ":" || ch === ";") && next === "/") continue; // 网址
    if ((ch === ":" || ch === ";") && isDigit(prev) && isDigit(next)) continue; // 时间/比分
    ctx.push({
      from: i,
      to: i + 1,
      kind: "punctuation",
      ruleId: "punct.halfwidth",
      severity: "warn",
      text: ch,
      suggestion: full,
      message: `中文语境建议使用全角标点「${full}」`,
    });
  }
}

/** 半角括号内含中文 → 全角；全角括号内纯英文 → 半角（中英混排） */
function ruleBrackets(ctx: Ctx): void {
  const t = ctx.text;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ctx.skip(i)) continue;
    if (ch !== "(" && ch !== "（") continue;
    const closeCh = ch === "(" ? ")" : "）";
    const close = t.indexOf(closeCh, i + 1);
    if (close < 0) continue;
    const inner = t.slice(i + 1, close);
    if (inner.length === 0 || inner.length > 40) continue;
    if (inner.includes("\n") || inner.includes("(") || inner.includes("（")) continue;
    let hasCjk = false;
    for (let k = 0; k < inner.length; k++) if (isCjk(inner[k])) hasCjk = true;
    const hasLatin = /[A-Za-z]/.test(inner);
    if (ch === "(" && hasCjk && !hasLatin) {
      ctx.push({
        from: i,
        to: i + 1,
        kind: "punctuation",
        ruleId: "punct.bracket",
        severity: "info",
        text: "(",
        suggestion: "（",
        message: "中文语境建议使用全角括号「（）」",
      });
      ctx.push({
        from: close,
        to: close + 1,
        kind: "punctuation",
        ruleId: "punct.bracket",
        severity: "info",
        text: ")",
        suggestion: "）",
        message: "中文语境建议使用全角括号「（）」",
      });
    } else if (ch === "（" && !hasCjk && hasLatin) {
      ctx.push({
        from: i,
        to: i + 1,
        kind: "mixed",
        ruleId: "mixed.paren",
        severity: "info",
        text: "（",
        suggestion: "(",
        message: "括号内为英文，建议使用半角括号「()」",
      });
      ctx.push({
        from: close,
        to: close + 1,
        kind: "mixed",
        ruleId: "mixed.paren",
        severity: "info",
        text: "）",
        suggestion: ")",
        message: "括号内为英文，建议使用半角括号「()」",
      });
    }
  }
}

/** 省略号：... / .. / … / …… 的写法 */
function ruleEllipsis(ctx: Ctx): void {
  const t = ctx.text;
  for (let i = 0; i < t.length; i++) {
    if (ctx.skip(i)) continue;
    if (t[i] === "." && t[i + 1] === ".") {
      let j = i;
      while (t[j] === ".") j++;
      const len = j - i;
      const nearCjk = isCjk(t[i - 1]) || isCjk(t[j]);
      if (len >= 2 && nearCjk && len <= 6) {
        ctx.push({
          from: i,
          to: j,
          kind: "punctuation",
          ruleId: "punct.ellipsis",
          severity: "warn",
          text: t.slice(i, j),
          suggestion: "……",
          message: "中文省略号建议写作「……」",
        });
      }
      i = j - 1;
      continue;
    }
    if (t[i] === "…") {
      let j = i;
      while (t[j] === "…") j++;
      const len = j - i;
      if (len !== 2) {
        ctx.push({
          from: i,
          to: j,
          kind: "punctuation",
          ruleId: "punct.ellipsis",
          severity: len === 1 ? "info" : "warn",
          text: t.slice(i, j),
          suggestion: "……",
          message: "中文省略号通常写作两个「…」，即「……」",
        });
      }
      i = j - 1;
    }
  }
}

/** 重复标点：，，/ ！！/ 。。/ ！！！ */
function ruleRepeatedPunct(ctx: Ctx): void {
  const t = ctx.text;
  for (let i = 0; i < t.length; i++) {
    if (ctx.skip(i)) continue;
    const ch = t[i];
    const isFull = REPEATABLE_FULL.indexOf(ch) >= 0;
    const isHalf = REPEATABLE_HALF.indexOf(ch) >= 0;
    if (!isFull && !isHalf) continue;
    let j = i;
    while (t[j] === ch) j++;
    const len = j - i;
    if (len < 2) continue;
    if (isHalf && !isCjk(t[i - 1]) && !isCjk(t[j])) continue;
    const target = ch === "。" && len >= 2 ? "……" : isHalf ? HALF_TO_FULL[ch] ?? ch : ch;
    const raw = t.slice(i, j);
    ctx.push({
      from: i,
      to: j,
      kind: "punctuation",
      ruleId: "punct.repeat",
      severity: "warn",
      text: raw,
      suggestion: target,
      message:
        target === "……"
          ? "重复句号，建议使用中文省略号「……」"
          : isHalf
            ? `重复标点「${raw}」，中文语境建议只用一个全角标点「${target}」`
            : `重复标点「${raw}」，保留一个即可`,
    });
    i = j - 1;
  }
}

/** 中文标点前后的多余空格 */
function ruleSpaceAroundPunct(ctx: Ctx): void {
  const t = ctx.text;
  for (let i = 0; i < t.length; i++) {
    if (!isSpace(t[i]) || ctx.skip(i)) continue;
    let j = i;
    while (isSpace(t[j])) j++;
    const prev = t[i - 1];
    const next = t[j];
    if (prev !== undefined && !isSpace(prev) && isCjkPunct(next) && next !== "…") {
      ctx.push({
        from: i,
        to: j,
        kind: "punctuation",
        ruleId: "punct.space",
        severity: "info",
        text: t.slice(i, j),
        suggestion: "",
        message: "中文标点前多余空格",
      });
    } else if (isCjkPunct(prev) && prev !== "…" && (isCjk(next) || isCjkPunct(next))) {
      ctx.push({
        from: i,
        to: j,
        kind: "punctuation",
        ruleId: "punct.space",
        severity: "info",
        text: t.slice(i, j),
        suggestion: "",
        message: "中文标点后多余空格",
      });
    }
    i = j - 1;
  }
}

/** 中文内容里用了英文直引号 " " */
function ruleStraightQuotes(ctx: Ctx): void {
  const t = ctx.text;
  let lineStart = 0;
  while (lineStart <= t.length) {
    let lineEnd = t.indexOf("\n", lineStart);
    if (lineEnd < 0) lineEnd = t.length;
    const quotes: number[] = [];
    for (let i = lineStart; i < lineEnd; i++) if (t[i] === '"') quotes.push(i);
    for (let k = 0; k + 1 < quotes.length; k += 2) {
      const a = quotes[k];
      const b = quotes[k + 1];
      if (ctx.skip(a) || ctx.skip(b)) continue;
      const inner = t.slice(a + 1, b);
      if (inner.length === 0 || inner.length > 120) continue;
      let hasCjk = false;
      for (let m = 0; m < inner.length; m++) {
        if (isCjk(inner[m])) {
          hasCjk = true;
          break;
        }
      }
      if (!hasCjk) continue;
      ctx.push({
        from: a,
        to: a + 1,
        kind: "punctuation",
        ruleId: "punct.quote",
        severity: "info",
        text: '"',
        suggestion: "“",
        message: "中文内容建议使用中文引号「“”」",
      });
      ctx.push({
        from: b,
        to: b + 1,
        kind: "punctuation",
        ruleId: "punct.quote",
        severity: "info",
        text: '"',
        suggestion: "”",
        message: "中文内容建议使用中文引号「“”」",
      });
    }
    if (lineEnd >= t.length) break;
    lineStart = lineEnd + 1;
  }
}

/* ------------------------------------------------------------------ */
/* 规则：中英文混排                                                     */
/* ------------------------------------------------------------------ */

/** 中英文之间缺空格（盘古之白） */
function ruleCjkLatinSpace(ctx: Ctx): void {
  const t = ctx.text;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    const next = t[i + 1];
    if (ctx.skip(i)) continue;
    if (isCjk(ch) && (isLatin(next) || (ctx.cjkDigitSpace && isDigit(next)))) {
      ctx.push({
        from: i,
        to: i + 1,
        kind: "mixed",
        ruleId: "mixed.space",
        severity: "info",
        text: ch,
        suggestion: ch + " ",
        message: `中英文之间建议加空格：「${ch}${next}」→「${ch} ${next}」`,
      });
    } else if (isLatin(ch) && isCjk(next)) {
      ctx.push({
        from: i,
        to: i + 1,
        kind: "mixed",
        ruleId: "mixed.space",
        severity: "info",
        text: ch,
        suggestion: ch + " ",
        message: `中英文之间建议加空格：「${ch}${next}」→「${ch} ${next}」`,
      });
    }
  }
}

/** 英文语境里用了全角标点 */
function ruleFullWidthInAscii(ctx: Ctx): void {
  const t = ctx.text;
  // 至少一侧是拉丁字母才算「英文语境」，纯数字（第1，2章 / 1，000）不算
  const latinNear = (prev: string | undefined, next: string | undefined) =>
    isLatin(prev) || isLatin(next);
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    const half = FULL_TO_HALF[ch];
    if (!half || ctx.skip(i)) continue;
    if (!isWordChar(t[i - 1]) || !isWordChar(t[i + 1])) continue;
    if (!latinNear(t[i - 1], t[i + 1])) continue;
    ctx.push({
      from: i,
      to: i + 1,
      kind: "mixed",
      ruleId: "mixed.punct",
      severity: "info",
      text: ch,
      suggestion: half,
      message: `英文字符之间建议使用半角标点「${half}」`,
    });
  }
}

/* ------------------------------------------------------------------ */
/* 规则：的 / 地 / 得（可选）                                            */
/* ------------------------------------------------------------------ */

const DEDE_VERBS =
  "走跑跳说笑看想听唱喊叫哭讲问答做干吃喝睡坐站起飞来去拿放拉推举抱打骂数读写画";

const DEDE_COMPLEMENT_RE =
  /^(很|太|真|挺|极|非常|十分|特别|多|少|好|坏|快|慢|早|晚|对|错|清楚|明白|干净|漂亮|厉害|彻底|利落|要命|不行|不错)/;

/** 形容词/副词样式的词尾，用于判断「地」 */
const DEDE_ADVERBS = [
  "认真",
  "仔细",
  "努力",
  "小心",
  "迅速",
  "快速",
  "高兴",
  "兴奋",
  "大声",
  "小声",
  "用力",
  "拼命",
  "不停",
  "不断",
  "默默",
  "悄悄",
  "轻轻",
  "慢慢",
  "静静",
  "渐渐",
  "缓缓",
  "偷偷",
  "狠狠",
  "死死",
  "呆呆",
  "慢慢",
  "轻盈",
  "随意",
  "无奈",
  "认真",
];

/** 「的」当作「得 / 地」用时的前置字白名单（觉/值/记… 组成的词本身含「得」） */
const DE_WHITELIST_PREV = "觉值懂记显免舍懒晓获使难不目似真有是的";

function ruleDeDe(ctx: Ctx): void {
  const t = ctx.text;
  for (let i = 0; i < t.length; i++) {
    if (ctx.skip(i) || ctx.skip(i - 1)) continue;
    const ch = t[i];
    const prev = t[i - 1];
    const after = t.slice(i + 1, i + 6);

    // 的 → 得：动词 + 的 + 补语（跑的快 / 说的对）
    if (ch === "的" && prev !== undefined && DEDE_VERBS.includes(prev)) {
      if (!DE_WHITELIST_PREV.includes(prev) && DEDE_COMPLEMENT_RE.test(after)) {
        ctx.push({
          from: i,
          to: i + 1,
          kind: "dede",
          ruleId: "dede.de2dei",
          severity: "warn",
          text: t.slice(Math.max(0, i - 1), i + 1),
          suggestion: "得",
          message: `动词后的补语建议用「得」：「${t.slice(Math.max(0, i - 1), i + 1)}…」`,
        });
        continue;
      }
    }

    // 的 → 地：副词 + 的 + 动词（慢慢的走 / 认真的看）
    if (ch === "的" && prev !== undefined && isCjk(prev) && isCjk(t[i + 1])) {
      const two = t.slice(i - 2, i);
      const four = t.slice(i - 4, i);
      const redup = t[i - 1] === t[i - 2] || (t[i - 1] === t[i - 3] && t[i - 2] === t[i - 4]);
      const isAdverb = DEDE_ADVERBS.includes(two) || redup || prev === "然" || DEDE_ADVERBS.includes(four);
      if (isAdverb && DEDE_VERBS.includes(t[i + 1]) && !DE_WHITELIST_PREV.includes(prev)) {
        ctx.push({
          from: i,
          to: i + 1,
          kind: "dede",
          ruleId: "dede.de2di",
          severity: "warn",
          text: two + "的",
          suggestion: "地",
          message: `状语修饰动词建议用「地」：「${two}的${t[i + 1]}」`,
        });
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 规则：近义词一致性                                                    */
/* ------------------------------------------------------------------ */

function countVariant(text: string, skips: Range[], variant: string): number {
  let n = 0;
  let idx = text.indexOf(variant);
  while (idx >= 0) {
    if (!inRanges(skips, idx)) n++;
    idx = text.indexOf(variant, idx + variant.length);
  }
  return n;
}

/** 统计每个近义词组里出现的不同写法，得出目标写法 */
export function synonymTargets(
  texts: string[],
  dictionary: ProofreadDictionary,
  options: ProofreadOptions = {},
): Map<string, string> {
  const targets = new Map<string, string>();
  const skipsAll = texts.map((t) =>
    skipRanges(t, options.skipFrontmatter !== false, options.skipCode !== false),
  );
  for (const group of dictionary.synonyms) {
    const counts = group.variants.map((v) => ({
      v,
      n: texts.reduce((acc, t, i) => acc + countVariant(t, skipsAll[i], v), 0),
    }));
    const present = counts.filter((c) => c.n > 0);
    if (present.length < 2) continue; // 只有一种写法，不算不一致
    const preferred =
      group.preferred && present.some((p) => p.v === group.preferred)
        ? group.preferred
        : present.reduce((a, b) => (b.n > a.n ? b : a)).v;
    targets.set(group.name, preferred);
  }
  return targets;
}

function ruleSynonym(ctx: Ctx): void {
  for (const group of ctx.dictionary.synonyms) {
    const target = ctx.synonymTarget?.get(group.name);
    if (!target) continue;
    for (const variant of group.variants) {
      if (variant === target) continue;
      let idx = ctx.text.indexOf(variant);
      while (idx >= 0) {
        if (!ctx.skip(idx)) {
          ctx.push({
            from: idx,
            to: idx + variant.length,
            kind: "synonym",
            ruleId: "synonym." + group.name,
            severity: "warn",
            text: variant,
            suggestion: target,
            message: `同一篇里「${target}」与「${variant}」混用，建议统一为「${target}」${
              group.note ? "（" + group.note + "）" : ""
            }`,
          });
        }
        idx = ctx.text.indexOf(variant, idx + variant.length);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

function runRules(ctx: Ctx): void {
  if (ctx.flags.typo || ctx.flags.sensitive) scanEntries(ctx);
  if (ctx.flags.cjkPunctuation) {
    ruleHalfWidthPunct(ctx);
    ruleBrackets(ctx);
    ruleEllipsis(ctx);
    ruleRepeatedPunct(ctx);
    ruleSpaceAroundPunct(ctx);
    ruleStraightQuotes(ctx);
  }
  if (ctx.flags.mixedPunctuation) {
    ruleFullWidthInAscii(ctx);
    if (ctx.flags.cjkLatinSpace) ruleCjkLatinSpace(ctx);
  }
  if (ctx.flags.dede) ruleDeDe(ctx);
  if (ctx.flags.synonym) ruleSynonym(ctx);
}

function finalize(
  issues: Omit<ProofreadIssue, "line">[],
  text: string,
  options: ProofreadOptions,
): ProofreadIssue[] {
  const starts = lineStarts(text);
  const sorted = issues.slice().sort((a, b) => {
    if (a.from !== b.from) return a.from - b.from;
    const pa = KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind];
    if (pa !== 0) return pa;
    const sa = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sa !== 0) return sa;
    return b.to - b.from - (a.to - a.from);
  });

  const out: ProofreadIssue[] = [];
  const seen = new Set<string>();
  let cursor = -1;
  for (const raw of sorted) {
    if (raw.to <= raw.from) continue;
    if (raw.from < cursor) continue; // 与更高优先级的问题重叠，丢弃
    const issue: ProofreadIssue = { ...raw, line: lineOf(starts, raw.from) };
    const key = `${raw.from}:${raw.to}:${raw.ruleId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
    cursor = raw.to;
  }

  const kept = filterIgnored(out, options.ignore);
  const max = options.maxIssues ?? 1000;
  return kept.length > max ? kept.slice(0, max) : kept;
}

/** 校对一段文本 */
export function proofread(text: string, options: ProofreadOptions = {}): ProofreadIssue[] {
  if (!text) return [];
  const flags = { ...DEFAULT_RULES, ...pickFlags(options) };
  const dictionary = options.dictionary ?? DEFAULT_DICTIONARY;
  let targets: Map<string, string> | null = null;
  if (flags.synonym) {
    targets = synonymTargets([text], dictionary, options);
  }
  const { ctx, issues } = makeCtx(text, { ...options, dictionary }, targets);
  runRules(ctx);
  return finalize(issues, text, options);
}

/* ------------------------------------------------------------------ */
/* 应用建议 / 汇总                                                      */
/* ------------------------------------------------------------------ */

/** 把单条建议写回文本（replacement 省略时用 issue.suggestion） */
export function applyFix(
  text: string,
  issue: Pick<ProofreadIssue, "from" | "to" | "suggestion">,
  replacement?: string,
): string {
  const rep = replacement ?? issue.suggestion;
  return text.slice(0, issue.from) + rep + text.slice(issue.to);
}

export interface ProofreadSummary {
  total: number;
  byKind: Record<IssueKind, number>;
  bySeverity: Record<Severity, number>;
}

export function summarizeIssues(issues: ProofreadIssue[]): ProofreadSummary {
  const byKind: Record<IssueKind, number> = {
    typo: 0,
    sensitive: 0,
    punctuation: 0,
    mixed: 0,
    dede: 0,
    synonym: 0,
  };
  const bySeverity: Record<Severity, number> = { error: 0, warn: 0, info: 0 };
  for (const i of issues) {
    byKind[i.kind]++;
    bySeverity[i.severity]++;
  }
  return { total: issues.length, byKind, bySeverity };
}

export const KIND_LABEL: Record<IssueKind, string> = {
  typo: "错词",
  sensitive: "敏感词",
  punctuation: "中文标点",
  mixed: "中英混排",
  dede: "的地得",
  synonym: "近义词",
};
