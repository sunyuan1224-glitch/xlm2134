/*
 * 「今日已写」与「平均速度」——挂件气泡里那两个数。
 *
 * 今日已写：今天**字数净增的累加**。每次全文总字数比上次多，就把多出来的累加进去；
 *   变少（删了东西）不动它。不采用「当前总数 − 今天开始时的总数」，那个有两个毛病：
 *   删掉一段再写回来就不算了；而且中途重开、换工作区会把基准冲掉，一下算出个天文数字。
 *   这个「全文总字数」只该由正文改动推动（store 那边喂，见 noteTotalWords）——
 *   界面上的数字（切章节、切统计模式）一变就想喂的话，会把界面抖动记成今天写的字。
 *
 * 平均速度：今日已写 ÷ 活跃时长。活跃时长按「两次输入间隔不超过 IDLE_GAP 就累加，
 *   超过就当停顿、不计入」来记——不然开着窗口去吃个饭，速度就被摊平了。
 *
 * 存 localStorage 的 `mynovel:writing-stats`，按天分桶（顺便为以后做连续天数/热力图留了路）。
 *
 * 性能：每次按键都会调 noteEdit()，所以
 *   · 状态只在模块里驻留一份、懒加载，按键路径上不碰 localStorage（不 JSON.parse）；
 *   · 落盘节流到 2 秒一次，并在 pagehide / 页面隐藏时补一次。
 *   这个项目对按键手感很敏感（即时预览曾经 107ms/键），别在这里加同步 IO。
 */
export interface DayStat {
  /** 当天字数净增 */
  added: number;
  /** 当天活跃输入时长（毫秒） */
  activeMs: number;
}

interface Stats {
  /** 存档版本（也算字数口径的版本）；对不上就整份作废，见 load() */
  version: number;
  days: Record<string, DayStat>;
  /** 上次看到的全书字数；用来算净增。null = 还没建立基准 */
  seen: number | null;
  /** 上次输入的时间戳；0 = 本段还没开始 */
  lastAt: number;
  /** 基准所属的工作区。换工作区要重建基准，否则总字数会跳变、算出假的「今日已写」 */
  root: string | null;
}

const STORAGE_KEY = "mynovel:writing-stats";
/*
 * 存档版本。**改了字数口径就要 +1**（v1 → v2：英文、数字、标点也算进字数了）。
 * 口径一变，「用旧口径攒出来的今日已写」与「新口径算出来的全书字数」就不可比：
 * 升级后第一次喂数会把整本书多出来的那部分（标点、西文多算的字）记成「今天写的」，
 * 一开应用白涨一两千。宁可整份丢掉，从 0 重新开始。
 */
const STATS_VERSION = 2;
/** 两次输入间隔超过这个数就算停顿，不计入活跃时长 */
const IDLE_GAP_MS = 90_000;
/** 落盘节流 */
const PERSIST_EVERY_MS = 2_000;
/**
 * 活跃时长少于这个数就不显示速度：分母只有几秒时，敲三个字就能算出「5400 字/时」这种
 * 没意义的数，那条横线是在拦这个。
 *
 * 30 秒是**够用又不会让人以为坏了**的下限：实测 30~60 秒的窗口里算出来的数已经在正常
 * 范围（写一会儿就是几百到一两千字/时）。原来定 60 秒，结果刚重置完 / 刚换版本
 * （基准归零）的人盯着横线问「速度是不是显示不出来」—— 所以挂件那边在等的时候会把
 * 「还要再写几秒」写出来，别让它成为一条没头没尾的横线。
 */
export const SPEED_MIN_ACTIVE_MS = 30_000;
/** 只留最近这么多天，免得 key 无限长下去 */
const KEEP_DAYS = 60;

let state: Stats | null = null;
let lastPersist = 0;

function dayKey(now: number): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function load(): Stats {
  const empty: Stats = { version: STATS_VERSION, days: {}, seen: null, lastAt: 0, root: null };
  try {
    if (typeof window === "undefined" || !window.localStorage) return empty;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<Stats>;
    if (!parsed || typeof parsed !== "object" || typeof parsed.days !== "object" || !parsed.days) {
      return empty;
    }
    // 旧版本的存档（没有 version 的算 v1）：口径不同，整份丢掉重新开始（理由见 STATS_VERSION）
    if (parsed.version !== STATS_VERSION) return empty;
    const days: Record<string, DayStat> = {};
    for (const [k, v] of Object.entries(parsed.days)) {
      const added = Number((v as DayStat)?.added);
      const activeMs = Number((v as DayStat)?.activeMs);
      if (Number.isFinite(added) && Number.isFinite(activeMs)) {
        days[k] = { added: Math.max(0, added), activeMs: Math.max(0, activeMs) };
      }
    }
    return {
      version: STATS_VERSION,
      days,
      seen: Number.isFinite(parsed.seen) ? Number(parsed.seen) : null,
      lastAt: Number.isFinite(parsed.lastAt) ? Number(parsed.lastAt) : 0,
      root: typeof parsed.root === "string" ? parsed.root : null,
    };
  } catch {
    return empty; // 坏存档当没有，别让统计把启动搞崩
  }
}

function get(): Stats {
  if (!state) state = load();
  return state;
}

function persistNow(): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(get()));
  } catch {
    /* 隐私模式等：内存里照常统计，只是这次没落盘 */
  }
}

function persistSoon(now: number): void {
  if (now - lastPersist < PERSIST_EVERY_MS) return;
  lastPersist = now;
  persistNow();
}

function prune(s: Stats): void {
  const keys = Object.keys(s.days).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) delete s.days[k];
}

function ensureDay(s: Stats, key: string): DayStat {
  let d = s.days[key];
  if (!d) {
    d = { added: 0, activeMs: 0 };
    s.days[key] = d;
    prune(s);
  }
  return d;
}

/**
 * 记一次输入。挂在 store 的 setContent 上（所有正文改动都从这里过）。
 * 按键路径上只有几次算术，不读盘不写盘。
 */
export function noteEdit(now: number = Date.now()): void {
  const s = get();
  const day = ensureDay(s, dayKey(now));
  const gap = s.lastAt === 0 ? 0 : now - s.lastAt;
  // 间隔合理就当作在连续写；太久的当停顿，这一段不补
  if (gap > 0 && gap <= IDLE_GAP_MS) day.activeMs += gap;
  s.lastAt = now;
  persistSoon(now);
}

/**
 * 记一次「全书总字数」。**由 store 的 feedBookWords 调**（各章已算好的字数之和），
 * 路径是「正文改动 → 重算那一章 → 把新的和喂进来」，重新读盘后也补一次。
 *
 * ⚠️ 统计只认正文改动，别改回拿界面上那个数字来喂。状态栏的「全书」曾经就是喂数点，
 * 它当时为了让打字即时更新而掺着当前章的实时字数、还跟着显示模式换口径，于是切章节、
 * 点「本章」切模式都会让它抖一下 —— 抖出来的差值被下面的「净增」原样记成了今天写的字
 * （在两篇已写好的文章之间来回切，每切一下白涨几百字，正是在挂件上看到的那种涨）。
 *
 * root 用来识别换工作区：换了就把基准重建、**不**把差值算成今日已写
 * （否则从 10 万字的工作区切到 5 千字的那个，再切回来就凭空多出 9 万字）。
 *
 * ⚠️ 喂进来的必须是「这本书现在的真实字数」。打开工作区时 store 会先把章节列表清空、
 * 读完盘才算得出来 —— 中间那个 0 要是喂进来，基准就被砸到 0，等真数字回来整本书就成了
 * 「今天写的」（挂件上一开工作区就涨一万多）。store 那边用 chaptersComplete 挡住这一段，
 * 别在这里兜底：这一层分不清「书真的是空的」和「还没读出来」。
 */
export function noteTotalWords(total: number, root: string | null, now: number = Date.now()): void {
  if (!Number.isFinite(total)) return;
  const s = get();
  if (s.root !== root) {
    // 第一次建立基准、或换了工作区：只重置基准，不累加
    s.root = root;
    s.seen = total;
    s.lastAt = 0;
    persistSoon(now);
    return;
  }
  if (s.seen !== null && total > s.seen) {
    ensureDay(s, dayKey(now)).added += total - s.seen;
  }
  s.seen = total;
  persistSoon(now);
}

export interface TodayStats {
  /** 今日字数净增 */
  added: number;
  /** 今日活跃输入时长（毫秒） */
  activeMs: number;
  /** 每小时多少字；活跃时长不够时返回 null（调用方显示「—」） */
  perHour: number | null;
}

export function getToday(now: number = Date.now()): TodayStats {
  const d = get().days[dayKey(now)];
  const added = d ? d.added : 0;
  const activeMs = d ? d.activeMs : 0;
  const perHour =
    activeMs >= SPEED_MIN_ACTIVE_MS && added > 0 ? Math.round((added / activeMs) * 3_600_000) : null;
  return { added, activeMs, perHour };
}

/**
 * 把今天的统计清零（挂件菜单里的「重置今日已写」）。
 * 立即落盘、不等节流：这是个明确的用户动作，不该在 2 秒窗口里被别的东西盖掉。
 * 活跃时长一起清 —— 只清字数不清时长的话，速度会被之前那段时长摊平、变得没法看。
 */
export function resetToday(now: number = Date.now()): void {
  const s = get();
  const d = ensureDay(s, dayKey(now));
  d.added = 0;
  d.activeMs = 0;
  s.lastAt = 0; // 断开当前这一段，免得把停顿之前的时间补进来
  persistNow();
}

/** 只给用例用：把模块内的缓存丢掉，下次重新从 localStorage 读 */
export function __resetWritingStatsCache(): void {
  state = null;
  lastPersist = 0;
}

/* 页面隐藏 / 关闭前把还没落盘的那点补上（节流窗口最长 2 秒） */
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", persistNow);
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") persistNow();
  });
}
