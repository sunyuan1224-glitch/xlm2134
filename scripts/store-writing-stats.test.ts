/*
 * 「今日已写」的基准口径（纯 Node，复用既有 esbuild，不新增依赖）。
 *
 * 这一层出过两次用户可见的毛病，根子都是同一个：**基准（seen）和真字数分了家**。
 *   A. 往上跳：打开工作区时 store 会先把 chapters 清成 []（上一个工作区的章节名不能留在
 *      屏上），那个 [] 被当成「书里 0 个字」喂进统计 —— 基准砸到 0，等读完盘落回真数字，
 *      整本书就成了「今天写的」（一开工作区就涨一万多）。
 *   B. 被吃掉：某一章的字数停在旧值上（比正文高的那一侧）—— 基准跟着一起高，
 *      接下来敲的字先得白填这个坑，用户看到的就是「打了三个字只涨一个」甚至不动。
 *
 * 这里逐条钉住：打开 / 重开（含重启读存档）/ 切工作区 / 刷新一律不许动统计；读盘途中敲的
 * 字、外部重读之后敲的字、收数窗口撞车之后敲的字，都必须照算；而真打字必须一路往上爬 ——
 * 否则就成了「干脆不统计」的假修。
 *
 * 每条用例单独记失败（不中断），一次跑完能看到「哪几种走法还在漏」。
 * 读盘全由下面的 stub 提供，绝不碰任何真实工作区（尤其 ~/Projects/Writing）。
 */

/* 先摆一层最小的 window / localStorage：store 那条链路（writingStats）要靠它读写统计基准。
 * import 的模块体总是先跑，那会儿 window 还不存在 —— 那里每处都有 typeof / try 兜底，
 * 补上之后本文件里的读写就都走这一份了。 */
const globals = globalThis as unknown as Record<string, unknown>;
const archive = new Map<string, string>();
globals.window = globalThis;
globals.localStorage = {
  getItem: (k: string) => (archive.has(k) ? archive.get(k)! : null),
  setItem: (k: string, v: string) => void archive.set(k, String(v)),
  removeItem: (k: string) => void archive.delete(k),
  clear: () => archive.clear(),
};
globals.addEventListener = () => {};
globals.document = { visibilityState: "visible" };

const { useStore } = await import("../src/store");
const { SPEED_MIN_ACTIVE_MS, getToday, noteEdit, resetToday, __resetWritingStatsCache } = await import(
  "../src/lib/writingStats",
);
const { countWords } = await import("../src/lib/wordcount");

console.log("=== 写作统计基准（打开 / 重开 / 切工作区 / 打字）测试开始 ===");

const failures: string[] = [];
/** 一条用例：失败就记下来接着说，别让第 1 条把后面的全挡住 */
async function step(name: string, body: () => Promise<void> | void): Promise<void> {
  const before = failures.length;
  try {
    await body();
  } catch (e) {
    failures.push(`${name}：${e instanceof Error ? (e.message.split("\n")[0] ?? String(e)) : String(e)}`);
  }
  if (failures.length === before) console.log(`  ✓ ${name}`);
}

function check(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 真读盘不是瞬时的：让「还没读完盘」那个时间窗在用例里真实存在 */
const DISK_MS = 20;
/** 字数重算是 100ms 节流（见 store.scheduleChapterWords），等一个周期再看数 */
const COUNT_TICK_MS = 250;

const BOOK = "夜色";
const LORE = `${BOOK}/outline/总纲.md`;
const chapterPath = (i: number) => `${BOOK}/第${i}章.md`;
const chapterText = (i: number) =>
  `# 第${i}章\n\n` + "雨落在青石板上，她把伞靠在门边，听了一会儿。\n\n".repeat(40);

interface Fixture {
  root: string;
  files: string[];
  /** 「磁盘」：路径 → 正文。write_file 也写回这里，保存后重读才能对上 */
  disk: Map<string, string>;
}

function makeWorkspace(id: string, chapterCount: number): Fixture {
  const files = [LORE]; // 有总纲 → 打开时不会去自动创建它
  const disk = new Map<string, string>([[LORE, `# ${BOOK}\n\n`]]);
  for (let i = 1; i <= chapterCount; i++) {
    files.push(chapterPath(i));
    disk.set(chapterPath(i), chapterText(i));
  }
  return { root: `/tmp/mynovel-stats-fixture/${id}`, files, disk };
}

/** 两本书：字数量级差得远，好让「切工作区把 A 的字数搬给 B」这种错一眼看出来 */
const wsA = makeWorkspace("书甲", 8);
const wsB = makeWorkspace("书乙", 2);
const byRoot = new Map([[wsA.root, wsA], [wsB.root, wsB]]);

const writes: string[] = [];
function fixtureOf(root: unknown): Fixture {
  const f = byRoot.get(String(root));
  if (!f) throw new Error(`用例里没有这个工作区：${root}`);
  return f;
}

globals.mynovel = {
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case "scan_workspace": {
        const f = fixtureOf(args.root);
        // 树只用来排章的顺序（sortTreeNodes / chapterFilesInTreeOrder），结构给全即可
        return {
          root: f.root,
          files: f.files,
          tree: [
            {
              path: BOOK,
              name: BOOK,
              is_dir: true,
              children: f.files.map((p) => ({
                path: p,
                name: p.split("/").pop()!,
                is_dir: false, // 这里只有章与总纲，没有卷目录
                children: [],
              })),
            },
          ],
        };
      }
      case "read_file": {
        const f = fixtureOf(args.root);
        const path = String(args.path);
        await wait(DISK_MS);
        const content = f.disk.get(path);
        return content === undefined ? null : { path, content };
      }
      case "write_file": {
        const f = fixtureOf(args.root);
        const path = String(args.path);
        f.disk.set(path, String(args.content));
        writes.push(path);
        return null;
      }
      case "read_sidecar":
        return null; // 老工作区：还没写过侧车
      case "write_sidecar":
        return null;
      default:
        // 漏 stub / 打错命令名要立刻炸，别让它悄悄变成「什么都没发生」
        throw new Error(`用例没预料到的后端命令：${cmd}`);
    }
  },
  onFullscreenChange: () => () => {},
};

const store = () => useStore.getState();
/** 全书字数：状态栏「全书」、写作统计的喂数都是这个和（见 store.feedBookWords） */
const bookWords = () => store().chapters.reduce((sum, c) => sum + c.words, 0);
/** 那几个字按应用的口径该算多少 —— 直接问被测的那份实现，别在用例里另写一套 */
const chars = (s: string) => countWords(s);
/**
 * 存档里那份统计（就是 writingStats 落盘的那个格式，这里按字段拼出来当「上次退出时存的」）。
 * version 缺省给当前的 2；传 null 就是「老版本留下的、没有版本号的那份存档」。
 */
function seedArchive(added: number, seen: number, root: string, version: number | null = 2): void {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const raw: Record<string, unknown> = { days: { [day]: { added, activeMs: 0 } }, seen, lastAt: 0, root };
  if (version !== null) raw.version = version;
  archive.set("mynovel:writing-stats", JSON.stringify(raw));
  __resetWritingStatsCache();
}

/* ------------------------------------------------------------------ *
 * 1. 首次打开工作区：只建立基准
 * ------------------------------------------------------------------ */
archive.clear();
__resetWritingStatsCache();
let totalA = 0;
await step("打开工作区只建立基准，不算成今天写的", async () => {
  await store().setRoot(wsA.root);
  totalA = bookWords();
  check(totalA > 3000, `夹具要是一本「一万多字」那种书，实际全书 ${totalA} 字`);
  check(
    getToday().added === 0,
    `打开工作区把整本书记成了今天写的：+${getToday().added}（A 类：载入中的空快照被当成「书是空的」）`,
  );
});

/* ------------------------------------------------------------------ *
 * 2. 真打字照涨（防「干脆不统计」的假修）
 * ------------------------------------------------------------------ */
const FIRST_LINE = "她又坐了回去，把灯拨亮了一点。\n";
let afterTyping = 0;
await step("真打字照涨（连打中一路往上爬）", async () => {
  check(totalA > 0, "第 1 条没拿到基准，跳过意义不大");
  store().setContent(chapterPath(1), chapterText(1) + FIRST_LINE);
  await wait(COUNT_TICK_MS);
  afterTyping = getToday().added;
  check(afterTyping === chars(FIRST_LINE), `刚敲一句该涨 ${chars(FIRST_LINE)} 字，实际 +${afterTyping}`);
  check(bookWords() === totalA + afterTyping, "全书字数应当等于原字数 + 今日净增");
});

/* ------------------------------------------------------------------ *
 * 3. 重开同一个工作区（基准还在）：一个字没敲，不许动
 * ------------------------------------------------------------------ */
await step("重开同一个工作区不动统计（含先落盘）", async () => {
  await store().setRoot(wsA.root);
  check(
    getToday().added === afterTyping,
    `重开把整本书记成了今天写的：+${getToday().added - afterTyping}（A 类）`,
  );
  check(bookWords() === totalA + afterTyping, "重开后全书字数不该变（刚才那句已经存盘了）");
  check(writes.length > 0, "切工作区前有过未保存内容，应当先落盘再重开");
});

/* ------------------------------------------------------------------ *
 * 4. 重启应用（基准从存档里读回来）
 * ------------------------------------------------------------------ */
await step("重启后读回存档基准，不把全书再算一次", async () => {
  seedArchive(afterTyping, bookWords(), wsA.root);
  await store().setRoot(wsA.root);
  check(
    getToday().added === afterTyping,
    `重启后把全书再算了一次：+${getToday().added - afterTyping}（A 类）`,
  );
});

/* ------------------------------------------------------------------ *
 * 5. 切工作区（字数量级差很远）再切回来：各自重建基准，不许搬运
 * ------------------------------------------------------------------ */
let beforeSwitch = 0;
let totalB = 0;
await step("切工作区各自重建基准，切回来也不许搬运", async () => {
  beforeSwitch = getToday().added;
  await store().setRoot(wsB.root);
  totalB = bookWords();
  check(totalB * 3 < totalA, `两本书要差得够远（书甲 ${totalA} / 书乙 ${totalB}）`);
  check(
    getToday().added === beforeSwitch,
    `切到小工作区应当只重建基准：+${getToday().added - beforeSwitch}`,
  );
  await store().setRoot(wsA.root);
  check(
    getToday().added === beforeSwitch,
    `从 ${totalB} 字的书切回 ${totalA} 字的书，差值被记成了今天写的：+${getToday().added + beforeSwitch}`,
  );
});

/* ------------------------------------------------------------------ *
 * 6. 刷新工作区：字数没变就不动统计
 * ------------------------------------------------------------------ */
await step("刷新工作区不动统计", async () => {
  await store().refresh();
  check(
    getToday().added === beforeSwitch,
    `刷新（读盘重算）动了统计：+${getToday().added - beforeSwitch}`,
  );
});

/* ------------------------------------------------------------------ *
 * 7. 打开工作区的读盘途中就敲了一个字 —— 用户报的那一下
 * ------------------------------------------------------------------ */
const MID_LOAD = "她把伞立在门后。\n";
let duringLoad = 0;
await step("读盘途中敲的字照算，且不把整本书一起算进来", async () => {
  const loading = store().setRoot(wsA.root); // 不等它读完盘
  await wait(DISK_MS / 2); // 读盘进行中
  store().setContent(chapterPath(2), chapterText(2) + MID_LOAD);
  await loading;
  await wait(COUNT_TICK_MS);
  duringLoad = getToday().added - beforeSwitch;
  check(duringLoad > 0, `读盘途中敲的字也要算（它是真写进去的），实际 +${duringLoad}`);
  check(
    duringLoad < 100,
    `读盘途中敲的那一下只该算那几个字（${chars(MID_LOAD)} 字），实际 +${duringLoad}`,
  );
});

/* ------------------------------------------------------------------ *
 * 8. 正文被外部改写后重读（拆章 / 在别的编辑器里改盘）：
 *    这一章的字数得跟着新正文落下，接着打字要照算（B 类：基准高着、正文矮着）
 * ------------------------------------------------------------------ */
const RELOADED = chapterPath(3);
const AFTER_RELOAD = "她又翻过一页。\n";
let swallowed = 0;
await step("外部重读之后打的字照算（不被基准吃掉）", async () => {
  const before = getToday().added;
  // 先在内存里多写一句（盘上还没有，模拟写了没存的状态）
  const inMemory = chapterText(3) + "夜里又下了一场雨，屋檐滴答作响。\n";
  store().setContent(RELOADED, inMemory);
  await wait(COUNT_TICK_MS);
  const afterInMemory = getToday().added;
  check(afterInMemory > before, `内存里写的字也要算，实际 +${afterInMemory - before}`);

  // 外部改写：盘上这一章还是原样（比内存里少一句），照拆章流程那样重读
  wsA.disk.set(RELOADED, chapterText(3));
  await store().reloadFromDisk(RELOADED);
  store().setContent(RELOADED, chapterText(3) + AFTER_RELOAD);
  await wait(COUNT_TICK_MS);
  swallowed = getToday().added - afterInMemory;
  check(
    swallowed === chars(AFTER_RELOAD),
    `外部重读之后打的字该算 ${chars(AFTER_RELOAD)} 个，实际 +${swallowed}（B 类：重读换掉了正文，基准没跟着落）`,
  );
});

/* ------------------------------------------------------------------ *
 * 9. 一个收数窗口里改了两个文件（正文 + 总纲）：两个都得重算
 *    只收最后一个的话，另一个的字数会停在旧值上 —— B 类的另一种走法
 * ------------------------------------------------------------------ */
const COLLIDED = chapterPath(4);
const AFTER_COLLISION = "她合上书。\n";
let collided = 0;
await step("收数窗口撞车后打的字照算（两个文件都要重算）", async () => {
  // 先在这一章里多写一段（给它的字数留出可减的量），并等收数落定
  store().setContent(COLLIDED, chapterText(4) + "这一段待会儿要删掉。\n");
  await wait(COUNT_TICK_MS);
  const before = getToday().added; // 从这里起算：上面那句「写了又删」的进账不算这一条
  // 同一个窗口里：先删正文，紧接着改总纲（收数一个周期只会收一次）
  store().setContent(COLLIDED, chapterText(4));
  store().setContent(LORE, "# 夜色\n\n总纲里也改一笔。\n");
  await wait(COUNT_TICK_MS);
  // 接着在这一章里敲字：必须照算
  store().setContent(COLLIDED, chapterText(4) + AFTER_COLLISION);
  await wait(COUNT_TICK_MS);
  collided = getToday().added - before;
  check(
    collided === chars(AFTER_COLLISION),
    `删正文的那个窗口被总纲挤掉后，接着敲的字被吃掉了：+${collided}（B 类：字数停在旧值）`,
  );
});

/* ------------------------------------------------------------------ *
 * 10. 口径：每个非空白字符算 1 —— 汉字 / 英文 / 数字 / 标点都算，空格不算
 *     （用户报过：左侧栏把这些「非汉字字符」漏掉了，挂件的「今日已写」跟着一起少）
 * ------------------------------------------------------------------ */
const MIXED = "Chapter 1 那天雨很大，2026 年 10 月 16 日。\n";
let mixed = 0;
await step("英文 / 数字 / 标点都算进字数，空格不算", async () => {
  // ① 规则本身：只剔空白，其余一律算 1
  check(
    countWords("Hello,世界！ 123") === 12,
    `「Hello,世界！ 123」该算 12 个字符（Hello=5、,=1、世界=2、！=1、123=3；空格不算），` +
      `实际 ${countWords("Hello,世界！ 123")}`,
  );
  check(countWords(" \t\n　 ") === 0, "只有空白时应当是 0（含全角空格）");
  check(countWords("a😀b") === 3, "emoji 按一个字符算，不是两个 UTF-16 单元");

  // 这段按新口径该算 26：Chapter 7 + 1 + 那天雨很大 5 + ，1 + 2026 4 + 年月日 3 + 10 2 + 16 2 + 。1
  // （旧口径只给 8 个汉字 + 5 个西文词 = 13，英文数字标点全漏）
  check(chars(MIXED) === 26, `夹具本身要能说明问题：该算 26 个，实际 ${chars(MIXED)}`);

  // ② 打字：挂件那份（今日已写）按整段涨，标点 / 英文 / 数字一个不少
  const before = getToday().added;
  const path = chapterPath(5);
  store().setContent(path, chapterText(5) + MIXED);
  await wait(COUNT_TICK_MS);
  mixed = getToday().added - before;
  check(mixed === 26, `这一段该让今日已写涨 26，实际 +${mixed}`);

  // ③ 左侧树那一份数字是同一个口径
  const meta = store().chapters.find((c) => c.path === path);
  check(meta, "第 5 章应当在章列表里");
  check(
    meta!.words === countWords(chapterText(5) + MIXED),
    `左侧树的字数要用同一口径：预期 ${countWords(chapterText(5) + MIXED)}，实际 ${meta!.words}`,
  );
});

/* ------------------------------------------------------------------ *
 * 11. 老存档（口径改过的那版）整份作废，不许把口径差记成今天写的
 *     实测：装上「标点也算字数」的那版之后，旧基准比新总数矮一大截，
 *     第一次喂数就会把整本书多出来的部分记进今日已写。
 * ------------------------------------------------------------------ */
await step("老口径的存档整份作废，不从它接着算", async () => {
  const totalNow = bookWords();
  // 老存档：seen 是旧口径的数（比新口径小一大截），added 停在 7
  seedArchive(7, Math.floor(totalNow / 2), wsA.root, null);
  await store().setRoot(wsA.root);
  check(
    getToday().added === 0,
    `老口径的存档该整份丢掉重新开始，实际今日已写 = ${getToday().added}`,
  );
  // 丢掉之后照样能正常记：接着敲的字要算
  const before = getToday().added;
  store().setContent(chapterPath(6), chapterText(6) + "雨停了。\n");
  await wait(COUNT_TICK_MS);
  check(getToday().added === before + 4, `作废之后打字要照算，实际 +${getToday().added - before}`);
});

/* ------------------------------------------------------------------ *
 * 12. 输入法没落定的那些正文不算字数
 *     用户报的：打汉字是打拼音，拼音字母被当成了正文 —— 挂件的「今日已写」按拼音涨，
 *     上屏之后真正的汉字数反而少算（"nihao" → "你好" 在统计眼里是净减少，不退回来）。
 *     编辑器（CodeMirror）组合期间确实会把预编辑文本同步进文档，所以 store 收得到这个状态：
 *     imePending=true 的那几次只收正文、不算字数；落定那一刻编辑器再报一次（false），
 *     字数在那里落定。「哪一次算落定」是时序问题，钉在 WebKit 那条 test-ime-count 里。
 * ------------------------------------------------------------------ */
const PINYIN_PATH = chapterPath(7);
const COMMITTED = "她推门进来。\n"; // 上屏之后的正文（11 个字符：她推门进来 + 。）
let typedChinese = 0;
await step("输入法没落定的正文不算字数，落定之后才补算", async () => {
  const before = getToday().added;
  const base = chapterText(7);

  // ① 一路拼音：正文照收（编辑器/保存要它即时），但字数与统计都不许动
  for (const pinyin of ["n", "ni", "nih", "niha", "nihao"]) {
    store().setContent(PINYIN_PATH, base + pinyin, true);
    await wait(COUNT_TICK_MS / 2);
  }
  await wait(COUNT_TICK_MS);
  check(
    store().chapters.find((c) => c.path === PINYIN_PATH)!.words === countWords(base),
    "没落定时左侧树那一章的字数应当停在上一版，不该按拼音涨",
  );
  check(getToday().added === before, `没落定的拼音不该记进今日已写，实际 +${getToday().added - before}`);
  check(
    store().contents[PINYIN_PATH] === base + "nihao",
    "没落定时正文本身要照收（不然编辑器回显 / 保存会丢字）",
  );

  // ② 落定：编辑器补报一次（imePending=false），这一次才重算
  store().setContent(PINYIN_PATH, base + COMMITTED, false);
  await wait(COUNT_TICK_MS);
  typedChinese = getToday().added - before;
  check(
    typedChinese === countWords(COMMITTED),
    `上屏的汉字该算 ${countWords(COMMITTED)} 个，实际 +${typedChinese}`,
  );
  check(
    store().chapters.find((c) => c.path === PINYIN_PATH)!.words === countWords(base + COMMITTED),
    "上屏之后左侧树要跟上真字数",
  );
});

/* ------------------------------------------------------------------ *
 * 13. 平均速度：活跃攒够 SPEED_MIN_ACTIVE_MS 才有数
 *     用户报过「速度显示不出来，是一条横线」—— 那条横线是在拦「分母只有几秒」的荒唐数，
 *     但门槛原来定在 60 秒、重置 / 换版本之后动不动就撞上，看着像坏了（挂件那边现在会把
 *     「还要再写几秒」写出来）。这里钉住门槛两侧的行为与公式。
 * ------------------------------------------------------------------ */
await step("平均速度：活跃不足给 —，攒够之后按 今日已写÷活跃 给数", async () => {
  resetToday();
  const path = chapterPath(8);
  store().setContent(path, chapterText(8) + "又写了一句话。\n");
  await wait(COUNT_TICK_MS);
  const written = getToday().added;
  check(written > 0, "先得真写点东西（速度要有分子）");

  const cold = getToday();
  check(cold.activeMs < SPEED_MIN_ACTIVE_MS, "刚敲两下，活跃时长本来就很少");
  check(cold.perHour === null, `活跃不足该给 —（null），实际 ${cold.perHour}`);

  // 按时间戳把活跃时长推到门槛之上（noteEdit 收显式时间，间隔 ≤90s 会累加）
  const t0 = Date.now();
  noteEdit(t0);
  noteEdit(t0 + 40_000);
  const warm = getToday(t0 + 40_000);
  check(warm.activeMs >= SPEED_MIN_ACTIVE_MS, `活跃应当累加到门槛之上，实际 ${warm.activeMs}`);
  check(warm.perHour !== null, "活跃够久就该给出速度");
  check(
    warm.perHour === Math.round((warm.added / warm.activeMs) * 3_600_000),
    `速度公式 = 今日已写 ÷ 活跃时长 × 3600000，实际 ${warm.perHour}`,
  );
  check(warm.added >= written, "推活跃时长不该影响今日已写");
});

/* ------------------------------------------------------------------ *
 * 结果
 * ------------------------------------------------------------------ */
if (failures.length > 0) {
  console.error(`\n=== ${failures.length} 条用例失败 ===`);
  for (const f of failures) console.error("  ✗ " + f);
  throw new Error(`写作统计基准有 ${failures.length} 条走法不对`);
}

console.log(
  `=== 所有 写作统计基准 测试通过（书甲 ${totalA} 字 / 书乙 ${totalB} 字；` +
    `打字 +${afterTyping}，读盘途中打字 +${duringLoad}，外部重读后打字 +${swallowed}，` +
    `撞窗口后打字 +${collided} —— 打开 / 重开 / 重启 / 切工作区 / 刷新一律 0）===`,
);
