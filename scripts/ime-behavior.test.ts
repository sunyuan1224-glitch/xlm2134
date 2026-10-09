/*
 * 输入法组合态加固的进程内测试（node，无 DOM 依赖）：
 *
 *  1) 组合态判定不再只看 view.composing：compositionstart 那一刻 CodeMirror 的
 *     view.composing 仍是 false，必须由守卫自身的事件监听来判定；
 *  2) 组合期间 whenIdle 的排队、组合结束 + 提交落盘（宽限窗口）后才执行；
 *  3) 组合提交后迟到的 input 事件会顺延执行，但不超过封顶；
 *  4) 同名任务只保留最新一个；dispose 后队列清空、事件不再响应；
 *  5) planExternalSync：本地未改动照旧整篇采用外部内容；本地与外部改在不同位置时
 *     把外部改动映射到当前正文（保住用户刚提交的字）；改动重叠或外部内容更旧时
 *     保留本地正文，绝不静默覆盖。
 */
import assert from 'node:assert/strict';
import { installImeGuard, planExternalSync, type ImeHost } from '../src/editor/ime.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class StubHost implements ImeHost {
  readonly contentDOM = new EventTarget();
  composing = false;
  compositionStarted = false;

  start() {
    // 真实顺序：CodeMirror 的 compositionstart 处理器把 inputState.composing 置 0，
    // 于是 view.composing（>0 才为真）此刻还是 false，compositionStarted 才是 true。
    this.composing = false;
    this.compositionStarted = true;
    this.contentDOM.dispatchEvent(new Event('compositionstart'));
  }

  end() {
    this.composing = false;
    this.compositionStarted = false;
    this.contentDOM.dispatchEvent(new Event('compositionend'));
  }

  input(inputType?: string) {
    const event = new Event(inputType ? 'beforeinput' : 'input');
    if (inputType) Object.assign(event, { inputType });
    this.contentDOM.dispatchEvent(event);
  }

  /** 模拟 CodeMirror 仍在组合态（守卫自身没看到 compositionstart 的情况）。 */
  setCmComposing(on: boolean) {
    this.composing = on;
    this.compositionStarted = on;
  }
}

/* ------------------------------------------------------------------ *
 * 断言 1: 组合态期间的动作排队与「结束后合理同步」
 * ------------------------------------------------------------------ */
{
  const host = new StubHost();
  const guard = installImeGuard(host);
  const ran: string[] = [];

  assert.equal(guard.idle(), true, 'idle host must be dispatch-safe');
  guard.whenIdle(() => ran.push('idle-now'), 'now');
  assert.deepEqual(ran, ['idle-now'], 'whenIdle must run immediately while idle');

  host.start();
  assert.equal(guard.composing, true, 'compositionstart must count as composing even though view.composing is false');
  assert.equal(guard.idle(), false, 'must not be dispatch-safe during composition');
  guard.whenIdle(() => ran.push('scroll'), 'typewriter');
  guard.whenIdle(() => ran.push('mode-a'), 'mode');
  guard.whenIdle(() => ran.push('mode-b'), 'mode');
  assert.deepEqual(ran, ['idle-now'], 'nothing may run while composing');

  await sleep(60);
  assert.deepEqual(ran, ['idle-now'], 'still nothing while the composition is open');

  host.end();
  // 组合结束后还有提交落盘的宽限窗口，此时依旧不能 dispatch。
  assert.equal(guard.composing, false, 'composition ended');
  assert.equal(guard.idle(), false, 'settling window must not be dispatch-safe');
  await sleep(30);
  assert.deepEqual(ran, ['idle-now'], 'queued work must wait for the commit to land');

  await sleep(300);
  assert.deepEqual(ran, ['idle-now', 'scroll', 'mode-b'], 'queued work runs after settle, same key keeps only the latest');
  await guard.dispose();
  console.log('PASS: ime guard, composition window deferral, same-key replacement, post-composition sync');
}

/* ------------------------------------------------------------------ *
 * 断言 2: 迟到的提交事件顺延，但不超过封顶
 * ------------------------------------------------------------------ */
{
  const host = new StubHost();
  const guard = installImeGuard(host);
  let ranAt = -1;

  host.start();
  host.input('insertCompositionText');
  guard.whenIdle(() => { ranAt = Date.now(); }, 'external');
  const ended = Date.now();
  host.end();
  // WebKit 有时把提交拆成 compositionend 之后的 input 事件：反复顺延执行。
  const ticker = setInterval(() => host.input(), 120);
  await sleep(300);
  assert.equal(ranAt, -1, 'late commit input events must keep the deferral alive');
  clearInterval(ticker);
  await sleep(500);
  assert.ok(ranAt > 0, 'deferred work must still run');
  const waited = ranAt - ended;
  assert.ok(waited <= 700, 'late-input deferral must be capped, waited ' + waited + 'ms');
  await guard.dispose();
  console.log('PASS: late commit input events extend the deferral, capped at ' + waited + 'ms');
}

/* ------------------------------------------------------------------ *
 * 断言 3: 漏掉 compositionstart / 组合态外仍被 CodeMirror 记为组合
 * ------------------------------------------------------------------ */
{
  const host = new StubHost();
  const guard = installImeGuard(host);
  host.input('insertCompositionText');
  assert.equal(guard.composing, true, 'insertCompositionText without compositionstart must still count as composing');
  await guard.dispose();

  const host2 = new StubHost();
  const guard2 = installImeGuard(host2);
  host2.setCmComposing(true);
  assert.equal(guard2.idle(), false, 'CodeMirror still in composition state must block dispatch');
  let ran = false;
  guard2.whenIdle(() => { ran = true; }, 'mode');
  await sleep(50);
  assert.equal(ran, false, 'queued work must wait while CodeMirror reports composition');
  host2.setCmComposing(false);
  await sleep(50);
  assert.equal(ran, true, 'queued work runs once CodeMirror leaves composition state');
  await guard2.dispose();
  console.log('PASS: composition detection without compositionstart and while CodeMirror reports composing');
}

/* ------------------------------------------------------------------ *
 * 断言 4: dispose 之后不再有任何动作
 * ------------------------------------------------------------------ */
{
  const host = new StubHost();
  const guard = installImeGuard(host);
  host.start();
  let ran = false;
  guard.whenIdle(() => { ran = true; }, 'scroll');
  guard.dispose();
  host.end();
  await sleep(350);
  assert.equal(ran, false, 'disposed guard must drop queued work');
  assert.equal(host.contentDOM.dispatchEvent(new Event('compositionstart')), true, 'listeners removed, events still dispatchable');
  guard.whenIdle(() => { ran = true; }, 'scroll');
  assert.equal(ran, false, 'disposed guard must not accept new work');
  console.log('PASS: dispose drops queued work and detaches listeners');
}

/* ------------------------------------------------------------------ *
 * 断言 4.1: 候选窗长开时 CPU 零空转（无定时器忙轮询）
 * ------------------------------------------------------------------ */
{
  const host = new StubHost();
  const guard = installImeGuard(host);
  host.start();
  let called = false;
  guard.whenIdle(() => { called = true; }, 'job');
  // 预编辑开始后，不应该有任何定时器在持续唤醒 flush
  await sleep(200);
  assert.equal(called, false, 'nothing runs while composing');
  // 保持组合 1 秒，确认完全由事件驱动唤醒
  await sleep(1000);
  assert.equal(called, false, 'candidate window stays open with zero CPU spinning');
  host.end();
  await sleep(350);
  assert.equal(called, true, 'work runs after compositionend triggers schedule');
  guard.dispose();
  console.log('PASS: prolonged candidate window is event-driven with zero CPU timer spin');
}

/* ------------------------------------------------------------------ *
 * 断言 5: 外部内容同步决策（不丢本地文字）
 * ------------------------------------------------------------------ */
{
  // 两边一致 -> 什么都不做
  assert.deepEqual(planExternalSync('abc', 'abc', 'abc'), { kind: 'noop' });
  // 本地没动过 -> 整篇采用外部内容（保持原有行为）
  assert.deepEqual(planExternalSync('abc', 'abc', 'aXc'), { kind: 'replace' });
  // 外部内容比本地还旧 -> 不能把用户刚输入的字回滚掉
  assert.deepEqual(planExternalSync('abc', 'abcd', 'abc'), { kind: 'keepLocal' });

  const apply = (current: string, plan: ReturnType<typeof planExternalSync>) => {
    if (plan.kind !== 'merge') throw new Error('expected a merge plan, got ' + plan.kind);
    return current.slice(0, plan.from) + plan.insert + current.slice(plan.to);
  };
  // 用户把预编辑 "ni" 提交成 "你好"，外部在校对第一段：两处不重叠 -> 合并
  const base = '第一段。\nni\n第三段。\n';
  const current = '第一段。\n你好\n第三段。\n';
  // 外部还是 base（未改），而本地已经提交了新字：必须保留本地，不能回滚回 base
  assert.deepEqual(planExternalSync(base, current, base), { kind: 'keepLocal' });
  const proofread = '第一段，\nni\n第三段。\n'; // 外部把句号改成逗号
  const mergeAfter = planExternalSync(base, current, proofread);
  assert.equal(apply(current, mergeAfter), '第一段，\n你好\n第三段。\n');
  const proofreadTail = '第一段。\nni\n第三段！\n'; // 外部改的是用户编辑之后的部分
  assert.equal(apply(current, planExternalSync(base, current, proofreadTail)), '第一段。\n你好\n第三段！\n');

  // 用户没动、外部动了同一处 -> 直接整篇采用
  assert.deepEqual(planExternalSync(base, base, proofread), { kind: 'replace' });
  // 外部改动跨越用户的提交位置 -> 重叠，保留本地，不能覆盖
  const sweeping = '第一段, x\n第三段。\n';
  assert.deepEqual(planExternalSync(base, current, sweeping), { kind: 'keepLocal' });
  // 同一位置的两次纯插入顺序有歧义 -> 一律保留本地
  assert.deepEqual(planExternalSync('ab', 'aXb', 'aYb'), { kind: 'keepLocal' });
  // 相邻但不重叠（用户替换 [3,6]，外部在 [6,6] 插入）可以合并
  const adjacent = planExternalSync('abcdef', 'abcPQRdef', 'abcdef!');
  assert.deepEqual(adjacent, { kind: 'merge', from: 9, to: 9, insert: '!' });
  assert.equal(apply('abcPQRdef', adjacent), 'abcPQRdef!');
  console.log('PASS: external content sync plan keeps local text, merges disjoint edits, refuses overlapping ones');
}
