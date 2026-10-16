/*
 * 「今日已写」与「平均速度」——挂件气泡里那两个数。
 *
 * 今日已写：今天**字数净增的累加**。每次全文总字数比上次多，就把多出来的累加进去；
 *   变少（删了东西）不动它。不采用「当前总数 − 今天开始时的总数」，那个有两个毛病：
 *   删掉一段再写回来就不算了；而且中途重开、换工作区会把基准冲掉，一下算出个天文数字。
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
  days: Record<string, DayStat>;
  /** 上次看到的全书字数；用来算净增。null = 还没建立基准 */
  seen: number | null;
  /** 上次输入的时间戳；0 = 本段还没开始 */
  lastAt: number;
  /** 基准所属的工作区。换工作区要重建基准，否则总字数会跳变、算出假的「今日已写」 */
  root: string | null;
}

const STORAGE_KEY = "mynovel:writing-stats";
/** 两次输入间隔超过这个数就算停顿，不计入活跃时长 */
const IDLE_GAP_MS = 90_000;
/** 落盘节流 */
const PERSIST_EVERY_MS = 2_000;
/** 活跃时长少于这个数就不显示速度：刚写两秒会算出几万字/时这种荒唐数 */
const MIN_ACTIVE_MS = 60_000;
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
  const empty: Stats = { days: {}, seen: null, lastAt: 0, root: null };
  try {
    if (typeof window === "undefined" || !window.localStorage) return empty;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<Stats>;
    if (!parsed || typeof parsed !== "object" || typeof parsed.days !== "object" || !parsed.days) {
      return empty;
    }
    const days: Record<string, DayStat> = {};
    for (const [k, v] of Object.entries(parsed.days)) {
      const added = Number((v as DayStat)?.added);
      const activeMs = Number((v as DayStat)?.activeMs);
      if (Number.isFinite(added) && Number.isFinite(activeMs)) {
        days[k] = { added: Math.max(0, added), activeMs: Math.max(0, activeMs) };
      }
    }
    return {
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
 * 记一次「全书总字数」。由 StatusBar 在总数变化时调（那里已经有这个数，不必另算）。
 *
 * root 用来识别换工作区：换了就把基准重建、**不**把差值算成今日已写
 * （否则从 10 万字的工作区切到 5 千字的那个，再切回来就凭空多出 9 万字）。
 *
 * ⚠️ 已知口径差（实测，暂时不动）：喂进来的这个「全书字数」里，**当前章**用的是
 * wordcount.ts 的 countWords，**其他章**用的是 store.ts 的 countQuick（或存档里的值）。
 * 两者对中文正文逐字一致（带 frontmatter、代码块、中英混排都验过），但有两处会分叉：
 *   · `<!-- nw:no -->` 屏蔽区：countQuick 不剔除（差几十字量级）
 *   · 假名 / 韩文：countQuick 不按「每字一个」算（差得多）
 * 真分叉时，加载后**第一次输入**会把这个差值一次性记成「今日已写」。中文正文下不会发生。
 * 想根治要去改 countQuick 与 countWords 的口径（那是另一个话题：文件树里的字数与状态栏
 * 本来就会在这些内容上对不上），不在这里顺手改。
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
  const perHour = activeMs >= MIN_ACTIVE_MS && added > 0 ? Math.round((added / activeMs) * 3_600_000) : null;
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
