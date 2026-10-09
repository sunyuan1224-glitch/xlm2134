/**
 * 输入法（IME）组合态加固。
 *
 * 编辑器里有三处在 CodeMirror 组合期间仍然会 action 的路径：
 *   1) 打字机模式用 requestAnimationFrame 排队 scrollIntoView；
 *   2) sourceMode 切换通过 Compartment.reconfigure 换掉整块装饰；
 *   3) 外部正文同步（例如其它入口 / 排版重写回写 store）整篇替换文档。
 * 它们在组合态里 dispatch 会打断 WebKit 的预编辑（preedit）：轻则候选窗跟着光标乱跳、
 * 重则组合被取消 / 提交文本被覆盖，用户正在拼的字直接丢。
 *
 * 本模块只做两件事，都不依赖 CodeMirror 内部实现：
 *   - installImeGuard：监听 contentDOM 上的组合事件，给出「现在能不能安全 dispatch」，
 *     并把组合期间被推迟的动作排到组合真正结束、提交文本落盘之后再执行；
 *   - planExternalSync：本地与外部内容都改过时，算出「不丢本地文字」的最小同步方案，
 *     算不出来就明确拒绝覆盖本地（keepLocal），绝不静默吞掉用户刚输入的文字。
 *
 * 注意：CodeMirror 的 `view.composing` 是 `inputState.composing > 0`，而 compositionstart
 * 只把它置为 0，要等第一个 input 事件才自增；也就是说**组合刚开始的那一瞬间
 * view.composing 是 false**。同理，compositionend 之后提交文本可能还在异步落盘，
 * 此时 view.composing 已经是 false。所以判定不能只看 view.composing。
 */

/**
 * 组合态判定只用得到这几个成员，方便在没有 DOM 的地方用桩对象驱动测试。
 * 真实的 `EditorView` 直接满足这个结构。
 */
export interface ImeHost {
  readonly contentDOM: EventTarget;
  /** CodeMirror EditorView.composing（注意上面注释里的时序坑） */
  readonly composing: boolean;
  /** CodeMirror EditorView.compositionStarted */
  readonly compositionStarted: boolean;
}

/** 这些 inputType 意味着事件属于一次组合，即使 compositionstart 没被监听到。 */
/** 这些 inputType 意味着正在发生预编辑输入（未上屏），必须锁定组合态 */
const PREEDIT_INPUT_TYPES = new Set([
  "insertCompositionText",
  "deleteCompositionText",
]);

/** 组合结束后等多久：这段时间里 WebKit 可能还会补一个 input 事件把提交文本送进来。 */
const LATE_COMMIT_MS = 250;
/** 迟到 input 事件反复顺延时的封顶，避免外部同步被无限推迟。 */
const MAX_SETTLE_MS = 600;

export interface ImeGuard {
  /** 组合中（含 CodeMirror 认为仍在组合态的情况） */
  readonly composing: boolean;
  /** 组合刚结束、提交文本可能还在异步落盘 */
  readonly settling: boolean;
  /** 现在可以安全 dispatch / 重配 / 滚动 */
  idle(): boolean;
  /** 空闲时立即执行；组合期间排队，等同名任务被后来的替换（最新的诉求胜出）。 */
  whenIdle(fn: () => void, key?: string): void;
  dispose(): void;
}

export function installImeGuard(host: ImeHost, opts: { settleMs?: number } = {}): ImeGuard {
  const settleMs = Math.max(0, opts.settleMs ?? 0);
  /** 组合结束后的落盘宽限：默认 settleMs=0 时用 LATE_COMMIT_MS 兜住迟到的提交事件。 */
  const graceMs = settleMs || LATE_COMMIT_MS;
  const queue: Array<{ key: string; fn: () => void }> = [];
  let composing = false;
  /** 排队的动作最早可以执行的时刻（客户端时间轴） */
  let dueAt = 0;
  /** 迟到 input 顺延的封顶时刻 */
  let capAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const cmComposing = () => host.composing || host.compositionStarted;
  const busy = () => composing || cmComposing();
  const idle = () => !disposed && !busy() && Date.now() >= dueAt;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = () => {
    clearTimer();
    if (disposed || queue.length === 0) return;
    const now = Date.now();
    let wait = Math.max(settleMs, dueAt - now);
    if (busy()) {
      // 组合期间绝不使用 0ms 忙轮询：
      // - 若处于 DOM 组合态，以 compositionend 事件驱动唤醒（零定时器开销，候选窗常开不耗 CPU）；
      // - 若仅由 CodeMirror 状态或测试桩报告 busy（无 DOM 事件），以 25ms 安全节拍轮询。
      if (composing) {
        return;
      }
      wait = Math.max(wait, MIN_BUSY_POLL_MS);
    }
    timer = setTimeout(flush, wait);
  };

  function flush() {
    timer = null;
    if (disposed) return;
    // 组合又开始了，或者提交还没落定：继续等，任务留在队列里。
    if (busy() || Date.now() < dueAt) {
      schedule();
      return;
    }
    const items = queue.splice(0, queue.length);
    for (const item of items) {
      if (disposed) return;
      if (busy()) {
        // 执行过程中用户又开始组合：剩下的任务重新排队，不打断新的组合。
        queue.unshift(item);
        schedule();
        return;
      }
      item.fn();
    }
  }

  const onStart = () => {
    composing = true;
    dueAt = 0;
    capAt = 0;
    clearTimer();
  };
  const onUpdate = () => {
    // compositionupdate 单独出现（漏掉 compositionstart）也要算组合中。
    composing = true;
    clearTimer();
  };
  const onEnd = () => {
    composing = false;
    const now = Date.now();
    dueAt = now + graceMs;
    capAt = now + Math.max(graceMs, MAX_SETTLE_MS);
    schedule();
  };
  /**
   * 预编辑输入 / 组合结束后迟到的事件。
   * - 组合已经开始采集（composing）或是全新的一次组合（没有迟到的 capAt）：
   *   预编辑输入按组合处理，锁死到 compositionend；
   * - compositionend 之后宽限期内出现的同类事件：是提交被拆包送来的，
   *   只顺延执行、不再重新上锁（否则守卫会被永久锁死）。
   */
  const onTextInput = (event: Event) => {
    const type = (event as InputEvent).inputType;
    const now = Date.now();
    if (type && PREEDIT_INPUT_TYPES.has(type)) {
      if (!composing && capAt && now <= capAt) {
        dueAt = Math.min(now + graceMs, capAt);
        schedule();
        return;
      }
      composing = true;
      clearTimer();
      return;
    }
    // 组合提交后的迟到 input（例如 WebKit 把 commit 拆成事件）：继续顺延，但不超过封顶。
    if (!capAt || now > capAt) return;
    dueAt = Math.min(now + graceMs, capAt);
    schedule();
  };

  host.contentDOM.addEventListener("compositionstart", onStart, true);
  host.contentDOM.addEventListener("compositionupdate", onUpdate, true);
  host.contentDOM.addEventListener("compositionend", onEnd, true);
  host.contentDOM.addEventListener("beforeinput", onTextInput, true);
  host.contentDOM.addEventListener("input", onTextInput, true);

  return {
    get composing() {
      return busy();
    },
    get settling() {
      return !busy() && Date.now() < dueAt;
    },
    idle,
    whenIdle(fn, key = "default") {
      if (disposed) return;
      if (idle() && queue.length === 0) {
        fn();
        return;
      }
      const at = queue.findIndex((item) => item.key === key);
      if (at >= 0) queue[at] = { key, fn };
      else queue.push({ key, fn });
      schedule();
    },
    dispose() {
      disposed = true;
      clearTimer();
      queue.length = 0;
      host.contentDOM.removeEventListener("compositionstart", onStart, true);
      host.contentDOM.removeEventListener("compositionupdate", onUpdate, true);
      host.contentDOM.removeEventListener("compositionend", onEnd, true);
      host.contentDOM.removeEventListener("beforeinput", onTextInput, true);
      host.contentDOM.removeEventListener("input", onTextInput, true);
    },
  };
}

/** base→other 的单段最小改动（前缀/后缀求交），坐标都在 base 上。 */
interface BaseEdit {
  from: number;
  to: number;
  insert: string;
}

function singleEdit(base: string, other: string): BaseEdit {
  const shared = Math.min(base.length, other.length);
  let from = 0;
  while (from < shared && base[from] === other[from]) from++;
  const room = Math.min(base.length - from, other.length - from);
  let suffix = 0;
  while (suffix < room && base[base.length - 1 - suffix] === other[other.length - 1 - suffix]) suffix++;
  return { from, to: base.length - suffix, insert: other.slice(from, other.length - suffix) };
}

/** a 完全落在 b 之前；两段都是插入（空区间）时一律视为重叠，避免顺序歧义。 */
function strictlyBefore(a: BaseEdit, b: BaseEdit): boolean {
  if (a.to < b.from) return true;
  return a.to === b.from && a.to > a.from && b.to > b.from;
}

export type ExternalSyncPlan =
  /** 两边已经一致，什么都不用做 */
  | { kind: "noop" }
  /** 本地没动过：整篇采用外部内容（保持历史行为） */
  | { kind: "replace" }
  /** 两边改的是不同位置：把外部改动映射到当前文档上，保住本地文字 */
  | { kind: "merge"; from: number; to: number; insert: string }
  /** 改动重叠或无法安全合并：保留本地文字，不覆盖 */
  | { kind: "keepLocal" };

/**
 * 外部内容同步决策。
 * @param base 收到外部内容时文档的样子（组合态里就是含预编辑文本的那份）
 * @param current 现在的文档
 * @param external 外部（store）给过来的正文
 */
export function planExternalSync(base: string, current: string, external: string): ExternalSyncPlan {
  if (current === external) return { kind: "noop" };
  if (current === base) return { kind: "replace" };
  if (external === base) return { kind: "keepLocal" };
  const ours = singleEdit(base, current);
  const theirs = singleEdit(base, external);
  if (strictlyBefore(theirs, ours)) {
    return { kind: "merge", from: theirs.from, to: theirs.to, insert: theirs.insert };
  }
  if (strictlyBefore(ours, theirs)) {
    const delta = ours.insert.length - (ours.to - ours.from);
    return { kind: "merge", from: theirs.from + delta, to: theirs.to + delta, insert: theirs.insert };
  }
  return { kind: "keepLocal" };
}
/** 当仅由外部桩/内部状态报告 busy 时，轮询的最小间隔（毫秒），避免 0ms 忙轮询打满 CPU。 */
const MIN_BUSY_POLL_MS = 25;
