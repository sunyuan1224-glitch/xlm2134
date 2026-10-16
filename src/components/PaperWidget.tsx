/*
 * 右下角的欧金金挂件。版式参考 DeepSeek-Balance-Whale-Widget：一个常驻方块，
 * 右上角悬停淡出「菜单」按钮，点开是一列基础设置（大小 / 音量 / 音效开关…）。
 *
 * v1 的交互就一条：**左键点一下 → 压扁一下 + 叫一声**。
 * 原版点一下还会弹气泡（余额、今日用量、每轮消耗），这里先不做；菜单的行是
 * 数据驱动的（见 MENU_ROWS / renderRow），将来加「余额」这类行 = 往 sections
 * 里加一项，不用动渲染骨架，也不用动布局。
 *
 * 指针事件：宿主 .pw-root 是 pointer-events:none（那是 200px 见方的方块，
 * 透明角落不能挡住正文），只有人物本体、菜单按钮和菜单自己收事件。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import girlUrl from "../assets/widget-girl.png";
import { COMPANION_EDGE } from "../lib/paperCompanion";
import { formatNumber } from "../lib/wordcount";
import { SPEED_MIN_ACTIVE_MS, getToday, resetToday } from "../lib/writingStats";
import {
  WIDGET_LEVEL_MAX,
  WIDGET_LEVEL_MIN,
  WIDGET_SCALE_MAX,
  WIDGET_SCALE_MIN,
  levelToScale,
  resetWidget,
  scaleToLevel,
  setWidget,
  fromFraction,
  settleWidgetPos,
  toFraction,
  useWidget,
  type WidgetBounds,
  type WidgetPos,
} from "../lib/paperWidget";
import {
  getAudioDiagnostics,
  playSqueak,
  setSoundEnabled,
  setSoundVolume,
  warmSound,
} from "../lib/widgetAudio";
import "../widget.css";

/*
 * 气泡里「平均速度」那行字。
 *
 * 活跃时长不够时不给数（分母太小会算出荒唐数，见 SPEED_MIN_ACTIVE_MS），但**不要只留一条
 * 横线**：用户刚重置完（或者刚换到这个版本、基准归零）会以为功能坏了，问「速度怎么显示不出来」。
 * 所以等的时候把「还要再写几秒」写出来 —— 让那条横线自己解释自己。
 */
function speedText(stats: { added: number; activeMs: number; perHour: number | null }): string {
  if (stats.perHour !== null) return `${formatNumber(stats.perHour)} 字/时`;
  if (stats.added === 0) return "—（今天还没写）";
  const seconds = Math.max(1, Math.ceil((SPEED_MIN_ACTIVE_MS - stats.activeMs) / 1000));
  return `—（再写 ${seconds} 秒）`;
}

/** 菜单行：加新功能就往这张表里加，渲染骨架不用改 */
type MenuRow =
  | {
      kind: "range";
      label: string;
      min: number;
      max: number;
      step: number;
      value: number;
      /** 右侧那个数字框：当前档位、量程与「档位 → 真实值」的换算 */
      box?: { value: number; min: number; max: number; onChange: (v: number) => void };
      /** 数值框右边的单位/百分比 */
      suffix?: string;
      onInput: (raw: string) => void;
    }
  | { kind: "toggle"; label: string; checked: boolean; onChange: (v: boolean) => void }
  | { kind: "button"; label: string; onClick: () => void };

interface MenuSection {
  title?: string;
  rows: MenuRow[];
}

/** 菜单与挂件之间的间距 */
const MENU_GAP = 8;
/** 移动超过这么多像素才算「拖动」，否则算「点击」（否则手抖一下就叫一声） */
const DRAG_SLOP = 4;
/** 点一下的压扁时长 */
const MIN_PRESS_MS = 70;
/** 气泡自动收起的时间，与参考项目一致（BUBBLE_MS = 5000） */
const BUBBLE_MS = 5000;
/** 气泡宽度，用来判断它放左边还是右边（放不下就翻到另一侧） */
const BUBBLE_W = 176;
/** 气泡与人物之间的间距 */
const BUBBLE_GAP = 10;

export function PaperWidget() {
  const { visible, scale, volume, soundOn, menuBtnHidden, pos } = useWidget();
  const [menuOpen, setMenuOpen] = useState(false);
  /** 拖动中的临时状态。**刻意不进 React state**：每帧一次 setState 在 30fps 的帧预算里很贵 */
  const dragRef = useRef<null | { sx: number; sy: number; ox: number; oy: number; moved: boolean }>(null);
  /** 菜单按视口坐标钉死的位置：开菜单那一刻量一次，之后挂件怎么缩放都不动它 */
  const [menuPos, setMenuPos] = useState<{ right: number; bottom: number } | null>(null);
  /** 音效出错时在菜单里说一声：「点了没声」不该只能靠猜 */
  const [audioError, setAudioError] = useState<string | null>(null);
  /** 气泡开没开。**数字不存 state**：渲染时现读 getToday()，这样它才是实时的 */
  const [bubbleOpen, setBubbleOpen] = useState(false);
  /** 气泡被点过之后切到彩蛋文案 */
  const [egg, setEgg] = useState(false);
  /** 气泡挂在人物哪一侧（左边放不下就翻到右边） */
  const [bubbleSide, setBubbleSide] = useState<"left" | "right">("left");
  const bubbleTimer = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const squishRef = useRef<HTMLDivElement>(null);

  // 设置是唯一真源：音量/开关一变就同步给音频层（音频模块不订阅 store）
  useEffect(() => {
    setSoundVolume(volume);
  }, [volume]);

  /*
   * 只同步开关，**不在挂载时预热**。
   * 预热会建 AudioContext：那件事不该在应用启动时做——用户可能根本不碰挂件，
   * 却为此付一次音频设备初始化（实测会把首屏拖慢，App 挂载阶段偶发超过 200ms）。
   * 预热改由鼠标进挂件时触发（下面 .pw-figure 的 onPointerEnter），
   * 也就是「真的要用」的那一刻。
   */
  useEffect(() => {
    setSoundEnabled(soundOn);
  }, [soundOn]);

  /*
   * 隐藏时把菜单一起收掉。
   * 藏起来的这次返回 null 只是「不渲染」，组件本身没卸载，menuOpen 会留着——
   * 不重置的话，下次从「视图」菜单把挂件唤回来，菜单会自己弹出来。
   */
  useEffect(() => {
    if (!visible) setMenuOpen(false);
  }, [visible]);

  // 点菜单外 / Esc 关闭
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      // 目标必须是节点才谈得上「在不在挂件里」；派发到 window/document 上的
      // 事件 target 不是 Node，contains() 会抛，收到就一律当「点在外面」。
      const target = e.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [menuOpen]);

  /*
   * 把菜单钉在当前视口位置上（开菜单那一刻量一次）。
   * 为什么要量一次就定住：菜单本来锚在挂件的左缘，而在菜单里拖「大小」滑块时挂件
   * 正在变宽——左缘一路往左跑，菜单跟着滑，滑块就在光标底下溜走了。
   */
  const pinMenu = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const r = root.getBoundingClientRect();
    setMenuPos({
      right: Math.max(MENU_GAP, window.innerWidth - r.left + MENU_GAP),
      bottom: Math.max(MENU_GAP, window.innerHeight - r.bottom + MENU_GAP),
    });
  }, []);

  // 窗口尺寸变了，钉住的位置就得重新量（否则菜单会飘到窗口外）
  useEffect(() => {
    if (!menuOpen) return;
    window.addEventListener("resize", pinMenu);
    return () => window.removeEventListener("resize", pinMenu);
  }, [menuOpen, pinMenu]);

  /*
   * 落点的应用：**每次都从「比例 + 当前挂件尺寸 + 当前区域」重新算出绝对位置**，
   * 而不是把存下来的像素直接摆上去。
   *
   * 这里就是「半屏拖到右下角、切全屏后不在右下角」那个 bug 的修复点：像素是死的，
   * 窗口一变它就在原地不动；比例是活的，重新算这一步在 resize 时会再跑一次。
   * 三类触发：换了落点比例、挂件尺寸（scale）变化、窗口 resize。
   */
  const applyStoredPos = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    if (!pos || !visible) {
      applyPos(root, null);
      return;
    }
    const r = root.getBoundingClientRect();
    applyPos(root, fromFraction(pos, { w: r.width, h: r.height }, widgetBounds()));
  }, [pos, visible]);

  useLayoutEffect(() => {
    applyStoredPos();
  }, [applyStoredPos, scale]);

  useEffect(() => {
    if (!pos) return;
    window.addEventListener("resize", applyStoredPos);
    return () => window.removeEventListener("resize", applyStoredPos);
  }, [pos, applyStoredPos]);

    /**
   * 把落点写到元素的内联样式上；pos 为 null 就清掉，交回 CSS 的默认右下角。
   *
   * **松手时必须直接调它**，不能只依赖「setWidget 之后那次 effect」：
   * 如果夹取后的结果和存的值一模一样，setWidget 会提前 return（省一次重渲染），
   * effect 就不会重跑 —— 而拖动过程中我们往 DOM 上直接写过「没夹过」的坐标，
   * 于是挂件会停在区域外面。这正是「拖动边界看起来没生效」的成因。
   */
  function applyPos(el: HTMLElement, pos: WidgetPos | null): void {
  if (!pos) {
    el.style.left = "";
    el.style.top = "";
    el.style.right = "";
    el.style.bottom = "";
    return;
  }
  el.style.left = `${pos.left}px`;
  el.style.top = `${pos.top}px`;
  el.style.right = "auto";
  el.style.bottom = "auto";
}

  /*
   * 压扁反馈：**按下就压、松手回弹**（参考项目就是这个手感——按住不放会一直压着）。
   * 直接加/去 class，不走 React state；加在**外壳**（.pw-figure）上而不是图上，
   * 因为气泡也在这一层里，于是它会跟着一起抖。
   */
  const pressStart = useRef(0);
  const squishOn = useCallback(() => {
    pressStart.current = performance.now();
    squishRef.current?.classList.add("is-pressed");
  }, []);
  const squishOff = useCallback(() => {
    const el = squishRef.current;
    if (!el) return;
    const held = performance.now() - pressStart.current;
    const wait = held >= MIN_PRESS_MS ? 0 : MIN_PRESS_MS - held;
    if (wait === 0) el.classList.remove("is-pressed");
    else window.setTimeout(() => el.classList.remove("is-pressed"), wait);
  }, []);

    /**
   * 量出挂件能待的区域。三条边都锚在真实 DOM 上，不写死像素：
   *   · 上界 = .menubar 的下沿（顶部「文件/帮助」那一条）
   *   · 下界 = .statusbar 的上沿（底下「Writing / 字数」那一条）
   *   · 左界 = .editor-area 左缘 + COMPANION_EDGE —— 与伴读立绘同一条线
   *   · 右界 = 视口右缘
   */
  function widgetBounds(): WidgetBounds {
  const viewport = { w: window.innerWidth, h: window.innerHeight };
  const menubar = document.querySelector<HTMLElement>(".menubar");
  const statusbar = document.querySelector<HTMLElement>(".statusbar");
  const area = document.querySelector<HTMLElement>(".editor-area");
  const top = menubar ? menubar.getBoundingClientRect().bottom : 0;
  const bottom = statusbar ? statusbar.getBoundingClientRect().top : viewport.h;
  const left = area ? area.getBoundingClientRect().left + COMPANION_EDGE : 0;
  return { left, top, right: viewport.w, bottom: Math.max(top, bottom) };
}

  /** 点气泡：正文与彩蛋之间交叉淡入淡出，并把自动收起的计时重新起算 */
  const toggleEgg = useCallback(() => {
    setEgg((v) => !v);
    window.clearTimeout(bubbleTimer.current);
    bubbleTimer.current = window.setTimeout(() => setBubbleOpen(false), BUBBLE_MS);
  }, []);

  /*
   * 让气泡里的数字「实时」：它显示期间每 200ms 让组件重渲染一次，渲染时现读 getToday()。
   *
   * 为什么用轮询而不是订阅：数字的更新（noteTotalWords）是 store 在重算章节字数时顺手喂的，
   * 比挂件那次渲染晚一步 —— 只订阅正文的话会永远慢一帧，单次改动甚至看不出来。
   * 而气泡最多活 5 秒（约 25 次 setState，开销可忽略）、关着时一次都不跑
   * （这个项目对按键开销很敏感，绝不能每敲一下就重渲染挂件），所以轮询是这里最划算的做法，
   * 也不必给 writingStats 加一套发布订阅。
   */
  const [, setStatsTick] = useState(0);
  useEffect(() => {
    if (!bubbleOpen) return;
    const timer = window.setInterval(() => setStatsTick((n) => n + 1), 200);
    return () => window.clearInterval(timer);
  }, [bubbleOpen]);

  /** 点一下冒气泡：读当前统计（渲染时现读）、自动收起、左边放不下就翻到另一侧 */
  const showBubble = useCallback(() => {
    const root = rootRef.current;
    if (root) {
      const r = root.getBoundingClientRect();
      const b = widgetBounds();
      setBubbleSide(r.left - BUBBLE_W - BUBBLE_GAP >= b.left ? "left" : "right");
    }
    setBubbleOpen(true);
    setEgg(false);
    window.clearTimeout(bubbleTimer.current);
    bubbleTimer.current = window.setTimeout(() => setBubbleOpen(false), BUBBLE_MS);
  }, []);

  useEffect(() => () => window.clearTimeout(bubbleTimer.current), []);

  const openMenu = useCallback(() => {
    setBubbleOpen(false);
    warmSound();
    pinMenu();
    setMenuOpen(true);
    // 开菜单时顺手把音效状态带出来，失败原因直接摆在菜单里
    setAudioError(getAudioDiagnostics().lastError);
  }, [pinMenu]);

  // 出声与否由音频层自己把关（上面的 effect 把 soundOn 同步给它，它才是唯一真源），
  // 这里不再判断一次 soundOn，免得两处闸门各说各话
  const onPress = useCallback(() => {
    playSqueak();
  }, []);

  if (!visible) return null;

  /*
   * 气泡里的数字**现读**，不存 state —— 配合上面那条「开着才订阅正文」，
   * 打字时它就会跟着涨（一次读三个数，所以只读一次放这儿）。
   */
  const stats = bubbleOpen ? getToday() : null;

  const sections: MenuSection[] = [
    {
      title: "外观",
      rows: [
        {
          kind: "range",
          label: "大小",
          min: WIDGET_SCALE_MIN,
          max: WIDGET_SCALE_MAX,
          step: 0.1,
          value: scale,
          box: {
            value: scaleToLevel(scale),
            min: WIDGET_LEVEL_MIN,
            max: WIDGET_LEVEL_MAX,
            onChange: (v) => setWidget({ scale: levelToScale(v) }),
          },
          onInput: (raw) => setWidget({ scale: Number(raw) }),
        },
      ],
    },
    {
      title: "音效",
      rows: [
        {
          kind: "range",
          label: "音量",
          min: 0,
          max: 1,
          step: 0.05,
          value: volume,
          suffix: `${Math.round(volume * 100)}%`,
          onInput: (raw) => setWidget({ volume: Number(raw) }),
        },
        {
          kind: "toggle",
          label: "点击出声",
          checked: soundOn,
          onChange: (v) => setWidget({ soundOn: v }),
        },
        {
          // 试听：在不点人物的前提下单独验一次音效。真按一下按钮（真手势）就有声，
          // 说明播放链路没问题、问题只在点人物那条路上；两边都没声，那就是编解码/权限。
          kind: "button",
          label: "试听音效",
          onClick: () => {
            playSqueak();
            // 起播失败是异步暴露的，稍等一下再把错误捞出来摆到菜单里
            window.setTimeout(() => setAudioError(getAudioDiagnostics().lastError), 300);
          },
        },
      ],
    },
    {
      title: "菜单",
      rows: [
        {
          kind: "toggle",
          label: "隐藏按钮",
          checked: menuBtnHidden,
          onChange: (v) => setWidget({ menuBtnHidden: v }),
        },
      ],
    },
    {
      rows: [
        { kind: "button", label: "隐藏挂件", onClick: () => setWidget({ visible: false }) },
        { kind: "button", label: "恢复默认", onClick: () => resetWidget() },
        { kind: "button", label: "回到角落", onClick: () => setWidget({ pos: null }) },
      ],
    },
    {
      title: "写作统计",
      rows: [
        {
          kind: "button",
          label: "重置今日已写",
          onClick: () => {
            resetToday();
            // 顺手把气泡叫出来显示 0：不然菜单一关什么都没发生，看不出成没成
            showBubble();
          },
        },
      ],
    },
  ];

  return (
    <div className="pw-root" ref={rootRef}>
      {/* 预热：鼠标一进挂件就把音频拉起来，点下去那一下才贴手 */}
      <div className="pw-figure" ref={squishRef} onPointerEnter={warmSound}>
        <img
          className="pw-img"
          src={girlUrl}
          alt=""
          aria-hidden="true"
          draggable={false}
          /*
           * 按下先不下结论：可能是「点一下叫一声」，也可能是「拖动挪位置」。
           * 超过 DRAG_SLOP 才算拖动——否则手抖一两像素就变成拖了，人会挪位。
           */
          onPointerDown={(e) => {
            if (e.button !== 0) return; // 只认左键；右键走下面的 onContextMenu 唤菜单
            squishOn();
            const root = rootRef.current;
            if (!root) return;
            const r = root.getBoundingClientRect();
            dragRef.current = { sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, moved: false };
            // 捕获指针：拖出挂件外面也还能收到 move/up，不会「拖到一半断了」
            try {
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            } catch {
              /* 忽略 */
            }
          }}
          onPointerMove={(e) => {
            const d = dragRef.current;
            const root = rootRef.current;
            if (!d || !root) return;
            const dx = e.clientX - d.sx;
            const dy = e.clientY - d.sy;
            if (!d.moved) {
              if (Math.hypot(dx, dy) < DRAG_SLOP) return;
              setBubbleOpen(false);
              d.moved = true;
              // 只在「开始拖」这一下进一次 React，之后的每帧都直接写样式
              root.classList.add("is-dragging");
            }
            // 拖动中直接写内联样式：不走 React state，省掉每帧一次重渲染
            root.style.left = `${d.ox + dx}px`;
            root.style.top = `${d.oy + dy}px`;
            root.style.right = "auto";
            root.style.bottom = "auto";
          }}
          onPointerUp={(e) => {
            const d = dragRef.current;
            dragRef.current = null;
            squishOff();
            const root = rootRef.current;
            if (!d || !root) return;
            root.classList.remove("is-dragging");
            try {
              (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
            } catch {
              /* 忽略 */
            }
            if (!d.moved) {
              // 是点击：压扁 + 叫一声 + 冒气泡
              onPress();
              showBubble();
              return;
            }
            setBubbleOpen(false); // 拖动中把气泡收掉，免得挂在半路
            // 落定：吸附 + 夹进窗口，然后写回设置（拖动全程只这一次 React 更新）
            const r = root.getBoundingClientRect();
            const bounds = widgetBounds();
            const size = { w: r.width, h: r.height };
            // 先夹出最终像素位置（吸附贴边 + 不许越界），再换算成比例存起来
            const settled = settleWidgetPos({ left: r.left, top: r.top }, size, bounds);
            applyPos(root, settled);
            setWidget({ pos: toFraction(settled, size, bounds) });
          }}
          onPointerCancel={() => {
            dragRef.current = null;
            rootRef.current?.classList.remove("is-dragging");
            squishOff();
          }}
          /*
           * 右键唤菜单：菜单按钮藏起来之后，这是唯一的入口（参考项目也是这么做的）。
           * preventDefault 是为了不让宿主弹自己的右键菜单。
           */
          onContextMenu={(e) => {
            e.preventDefault();
            if (!menuOpen) openMenu();
          }}
        />

        {/* 气泡放在外壳里（不是外面）：这样压扁外壳时它跟着一起抖 */}
        {bubbleOpen && stats && (
          <div
            className={"pw-bubble is-" + bubbleSide + (egg ? " is-egg" : "")}
            role="status"
            onClick={toggleEgg}
          >
            {/* 正文与彩蛋叠在同一个网格格里：容器高度取两者较高的一边，交叉淡化时不跳尺寸 */}
            <div className="pw-bubble-body">
              <div className="pw-bubble-stat">
                <div className="pw-bubble-label">今日已写</div>
                <div className="pw-bubble-amount">
                  {formatNumber(stats.added)}
                  <span className="pw-bubble-unit">字</span>
                </div>
                <div className="pw-bubble-hint">
                  平均速度 {speedText(stats)}
                </div>
              </div>
              <div className="pw-bubble-egg">欧金金…</div>
            </div>
          </div>
        )}
      </div>

      {!menuBtnHidden && (
        <button
          type="button"
          className={"pw-menu-btn" + (menuOpen ? " is-visible" : "")}
          title="挂件菜单（右键人物也能唤出）"
          aria-label="挂件菜单"
          aria-expanded={menuOpen}
          onClick={(e) => {
            e.stopPropagation();
            if (menuOpen) setMenuOpen(false);
            else openMenu();
          }}
        >
          <span />
          <span />
          <span />
        </button>
      )}

      {menuOpen && (
        <div
          className="pw-menu"
          role="menu"
          style={menuPos ? { right: menuPos.right, bottom: menuPos.bottom } : undefined}
        >
          {sections.map((section, si) => (
            <div className="pw-menu-section" key={section.title ?? si}>
              {section.title && <div className="pw-menu-title">{section.title}</div>}
              {section.rows.map((row) => (
                <div className="pw-menu-row" key={row.label}>
                  {renderRow(row)}
                </div>
              ))}
            </div>
          ))}
          {audioError && <div className="pw-menu-err">音效不可用：{audioError}</div>}
        </div>
      )}
    </div>
  );
}

/**
 * 每行自己负责叫出左侧那个标签：按钮行本身就是标签（再放一个就重复了，
 * 早先的版本会在菜单里显示成「隐藏挂件 | 隐藏挂件」）。
 */
function renderRow(row: MenuRow) {
  if (row.kind === "button") {
    return (
      <button type="button" className="pw-btn" onClick={row.onClick}>
        {row.label}
      </button>
    );
  }
  if (row.kind === "toggle") {
    return (
      <>
        <span className="pw-menu-label">{row.label}</span>
        <input
          type="checkbox"
          className="pw-check"
          checked={row.checked}
          onChange={(e) => row.onChange(e.target.checked)}
        />
      </>
    );
  }
  return (
    <>
      <span className="pw-menu-label">{row.label}</span>
      <input
        type="range"
        className="pw-range"
        min={row.min}
        max={row.max}
        step={row.step}
        value={row.value}
        aria-label={row.label}
        onChange={(e) => row.onInput(e.target.value)}
      />
      {row.box && (
        <input
          type="number"
          className="pw-number"
          min={row.box.min}
          max={row.box.max}
          step={1}
          value={row.box.value}
          aria-label={`${row.label}档位`}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (e.target.value.trim() !== "" && Number.isFinite(n)) row.box!.onChange(n);
          }}
        />
      )}
      {row.suffix && <span className="pw-suffix">{row.suffix}</span>}
    </>
  );
}

export default PaperWidget;

