/*
 * 挂件音效。走 <audio> 元素 —— 这是**实测在工作环境里真能出声**的那条路。
 *
 * ⚠️ 别再改成 Web Audio 了（我走过这段弯路，记在这里免得重犯）：
 * 为了修「连续快速点按」，我曾把播放换成 Web Audio（预取 + decodeAudioData +
 * 每次新建 AudioBufferSourceNode），在本机无头 WebKit 里「20 连点零报错」，看着没问题；
 * 结果装到真实应用里**一点声音都没有**——那边 AudioContext 根本起不来（resume() 的
 * Promise 一直不落定，context 永远停在 suspended），而 <audio> 是好的。
 * 更要命的是当时的「零报错」什么也证明不了：那个无头环境**本来就放不出声**
 * （<audio> 的 play() 直接被 NotAllowedError 挡掉），在没有声音的地方测音频，
 * 「没报错」≠「有声」。教训：音频这层只能以「真机上听得到」为准。
 *
 * 素材保持**打包成独立文件、按相对 URL 引用**，也不要用 ?inline 打成 data: URL：
 * 那同样是在无头环境里看着没事、换到 data: 就多一层不确定的东西，而独立文件这条路
 * 是实测有声音的。
 *
 * 按「槽位」组织：参考项目里按下响一声、松开接另一声（duck 组 = Ya1 / Ya2），
 * 所以这里留了 press / release 两个槽；v1 两个槽指向同一个素材。
 */
import squeakUrl from "../assets/duck-squeak.mp3";

/** 音效槽。v1 两个槽指向同一个素材；将来分开时改这张表 */
export const SOUND_SLOTS = {
  press: squeakUrl,
  release: squeakUrl,
} as const;

export type SoundSlot = keyof typeof SOUND_SLOTS;

const SLOT_NAMES = Object.keys(SOUND_SLOTS) as SoundSlot[];

let volume = 0.9;
let enabled = true;

/** 每个槽一个播放器，懒建：没点过就不碰音频栈 */
const players = new Map<SoundSlot, HTMLAudioElement>();
/** 每个素材只 warn 一次，免得连点时刷屏 */
const warned = new Set<string>();
/** 最近一次真正的失败（不含连点时的正常打断）。参考项目也会把最后一次错误留在外面供排障 */
let lastError: string | null = null;

/** 素材 URL 可能很长（打包成 data: 时尤其夸张），日志里截断显示 */
function shorten(url: string): string {
  return url.length > 40 ? url.slice(0, 40) + "…" : url;
}

function warnOnce(key: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  lastError = `${shorten(key)} → ${msg}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[小鸭挂件] 音效不可用：${lastError}`);
}

export interface AudioDiagnostics {
  /** 音效总开关 */
  enabled: boolean;
  /** 每个槽的播放器状态；还没建起来就是空表 */
  players: {
    slot: string;
    /** 0=什么都没有 1=有元数据 2=有当前帧 3=有部分数据 4=够播了 */
    readyState: number;
    duration: number;
    paused: boolean;
  }[];
  /** 素材是否已经加载到能播（readyState ≥ 1 且时长有效） */
  ready: boolean;
  lastError: string | null;
}

/**
 * 诊断快照。给排障和用例用：光看「点了没报错」是分辨不出「真响了」和
 * 「静默地什么都没做」的，得能问出「素材到底加载了没有」。
 */
export function getAudioDiagnostics(): AudioDiagnostics {
  const list = SLOT_NAMES.map((slot) => {
    const el = players.get(slot);
    return {
      slot,
      readyState: el ? el.readyState : 0,
      duration: el && Number.isFinite(el.duration) ? el.duration : 0,
      paused: el ? el.paused : true,
    };
  });
  return {
    enabled,
    players: list,
    ready: list.some((p) => p.readyState >= 1 && p.duration > 0),
    lastError,
  };
}

/** 取（或建）某槽的播放器。建元素就等于开始预取，所以预热就是把它建出来 */
function player(slot: SoundSlot): HTMLAudioElement | null {
  const cached = players.get(slot);
  if (cached) return cached;
  const url = SOUND_SLOTS[slot];
  if (!url) return null; // 该槽显式留空 = 静音
  try {
    const el = new Audio(url);
    el.preload = "auto";
    el.volume = volume;
    el.addEventListener("error", () => {
      // 元素级错误（拿不到资源 / 解不了码）——这条必须看得见，否则就是「静默无声」
      const code = el.error ? el.error.code : "?";
      warnOnce(url, new Error(`音频元素报错 code=${code}`));
    });
    players.set(slot, el);
    return el;
  } catch (err) {
    warnOnce("Audio", err);
    return null;
  }
}

/** 预热：鼠标一进挂件就把音频拉起来，点下去那一下才不用等 */
export function warmSound(): void {
  if (!enabled) return;
  for (const slot of SLOT_NAMES) player(slot);
}

export function setSoundVolume(v: number): void {
  volume = Math.min(1, Math.max(0, v));
  for (const el of players.values()) el.volume = volume;
}

export function setSoundEnabled(on: boolean): void {
  enabled = on;
  if (!on) {
    // 关掉时把在响的都掐断，否则「取消勾选」要等这一声播完才生效
    for (const el of players.values()) {
      try {
        el.pause();
        el.currentTime = 0;
      } catch {
        /* 忽略 */
      }
    }
  }
}

export function playSlot(slot: SoundSlot): void {
  if (!enabled) return;
  const el = player(slot);
  if (!el) return;
  try {
    /*
     * 连点修复：**先 pause() 再改 currentTime**。
     * 原来的写法是直接 `currentTime = 0; play()`——在播放中改 currentTime 会打断
     * 正在飞的那次 play()，快速连点时下一次又被再下一次打断，元素最后会卡在
     * paused=true 上再也响不了。先 pause() 把在飞的那次结算掉，再复位、再起播，
     * 就是「快速重置」该有的样子（参考项目也是把 currentTime=0 当成「停掉在播的那份」）。
     */
    el.pause();
    el.currentTime = 0;
    const p = el.play();
    if (p && typeof p.catch === "function") {
      p.catch((err: unknown) => {
        // 连点时被打断是正常的，不算故障，不要因此弹错误提示
        if (err instanceof Error && err.name === "AbortError") return;
        warnOnce(SOUND_SLOTS[slot], err);
      });
    }
  } catch (err) {
    warnOnce(SOUND_SLOTS[slot], err);
  }
}

/** 挂件被点一下：v1 就这一声 */
export function playSqueak(): void {
  playSlot("press");
}
