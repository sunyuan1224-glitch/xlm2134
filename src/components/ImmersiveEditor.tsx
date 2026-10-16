import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { EditorView } from "@codemirror/view";
import { Editor } from "../editor/Editor";
import { PaperCompanion } from "./PaperCompanion";
import { countWords, formatNumber, type CountMode } from "../lib/wordcount";
import { DEFAULT_TYPOGRAPHY, setTypography, useTypography } from "../lib/typography";
import "../immersive.css";

export interface ImmersiveEditorProps {
  /** 当前文件路径，用作编辑器实例的 key */
  activePath?: string | null;
  /** 文档内容（受控） */
  content: string;
  /** 正文变化；imePending = 输入法还没落定（拼音未上屏 / 提交未落盘，见 Editor 的同名参数） */
  onChange: (content: string, imePending: boolean) => void;
  onSave: () => void;
  onExit: () => void;
  /** 顶栏右侧插槽（自定义按钮等） */
  headerSlot?: ReactNode;
  /** 统计区插槽；传了就不再渲染内置字数/计时 */
  statsSlot?: ReactNode;
  /** 底栏右侧插槽 */
  footerSlot?: ReactNode;
  /** 内置统计里是否显示字数 */
  showWordCount?: boolean;
  /** 内置统计里是否显示计时 */
  showTimer?: boolean;
  countMode?: CountMode;
  /** 初始是否开启打字机居中（用户切换后会记在 localStorage） */
  defaultTypewriter?: boolean;
  /** 用 Fullscreen API 真全屏；false 则退化为隐藏工具栏的浮层极简模式 */
  useBrowserFullscreen?: boolean;
  className?: string;
  /** 想自己建 CodeMirror 实例时使用；默认复用 src/editor/Editor */
  renderEditor?: (api: {
    initialContent: string;
    registerView: (view: EditorView | null) => void;
  }) => ReactNode;
}

/** 沉浸模式自己的设置：只留打字机居中，字号走统一的排版设置（src/lib/typography.ts） */
type Settings = { typewriter: boolean };

const STORE_KEY = "novel.immersive";
const SETTINGS_EVENT = "novel:immersive-settings";

function loadSettings(fallbackTypewriter: boolean): Settings {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { typewriter: fallbackTypewriter };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      typewriter: typeof parsed.typewriter === "boolean" ? parsed.typewriter : fallbackTypewriter,
    };
  } catch {
    return { typewriter: fallbackTypewriter };
  }
}

function saveSettings(next: Settings) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(next));
  } catch {
    /* 隐私模式等场景直接忽略 */
  }
  // 同一页面可能挂了多个沉浸式实例，用事件把设置同步过去
  window.dispatchEvent(new CustomEvent<Settings>(SETTINGS_EVENT, { detail: next }));
}

function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function useIsFullscreen(): boolean {
  const [full, setFull] = useState(false);
  useEffect(() => {
    const sync = () => setFull(!!document.fullscreenElement);
    sync();
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);
  return full;
}

export function ImmersiveEditor(props: ImmersiveEditorProps) {
  const {
    activePath,
    content,
    onChange,
    onSave,
    onExit,
    headerSlot,
    statsSlot,
    footerSlot,
    showWordCount = true,
    showTimer = true,
    countMode = "char",
    defaultTypewriter = true,
    useBrowserFullscreen = true,
    className,
    renderEditor,
  } = props;

  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const settingsRef = useRef<Settings>(loadSettings(defaultTypewriter));
  // 用户主动退出全屏（点按钮）时不要再退出沉浸模式；浏览器里按 Esc 则会落回退出沉浸
  const userExitedFullscreen = useRef(false);
  const requestedFullscreen = useRef(false);

  const [typewriter, setTypewriter] = useState(settingsRef.current.typewriter);
  const [barHidden, setBarHidden] = useState(false);
  const isFullscreen = useIsFullscreen();

  const typewriterRef = useRef(typewriter);
  typewriterRef.current = typewriter;

  useEffect(() => {
    const onSettings = (e: Event) => {
      const detail = (e as CustomEvent<Settings>).detail;
      if (!detail) return;
      settingsRef.current = detail;
      setTypewriter(detail.typewriter);
    };
    window.addEventListener(SETTINGS_EVENT, onSettings);
    return () => window.removeEventListener(SETTINGS_EVENT, onSettings);
  }, []);

  const patchSettings = useCallback((patch: Partial<Settings>) => {
    const next = { ...settingsRef.current, ...patch };
    settingsRef.current = next;
    saveSettings(next);
    setTypewriter(next.typewriter);
  }, []);

  // 进入时聚焦编辑器（CodeMirror 实例由 Editor 组件建立，这里等它出现）
  useEffect(() => {
    let tries = 0;
    const timer = window.setInterval(() => {
      tries += 1;
      const view = viewRef.current;
      if (view) {
        view.focus();
        window.clearInterval(timer);
      } else if (tries > 40) {
        window.clearInterval(timer);
      }
    }, 40);
    return () => window.clearInterval(timer);
  }, [activePath]);

  const registerView = useCallback((view: EditorView | null) => {
    viewRef.current = view;
    const host = hostRef.current;
    if (!host) return;
    if (view) host.setAttribute("data-cm-ready", "1");
    else host.removeAttribute("data-cm-ready");
  }, []);

  /**
   * 打字机居中的「进入 / 聚焦 / 改窗口大小」三种时机。
   * 输入过程中的持续居中由 Editor 负责（它拿到 typewriterMode 后会在每次
   * 文档变化后把光标行滚到中线），这里不重复绑输入。
   * 用的是 EditorView.scrollIntoView 的滚动 effect，只改滚动位置，
   * 不写回文档，因此不会进 undo 历史，也不会和输入法组合过程打架。
   */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const center = () => {
      const view = viewRef.current;
      if (!view) return;
      const head = view.state.selection.main.head;
      view.dispatch({ effects: EditorView.scrollIntoView(head, { y: "center", yMargin: 0 }) });
    };
    const onFocus = () => {
      if (typewriterRef.current) center();
    };
    const onResize = () => {
      if (typewriterRef.current) center();
    };
    host.addEventListener("focusin", onFocus);
    window.addEventListener("resize", onResize);
    if (typewriter) center();
    return () => {
      host.removeEventListener("focusin", onFocus);
      window.removeEventListener("resize", onResize);
    };
  }, [typewriter]);

  // 浏览器全屏被退出时（多半是 Esc，按键事件会被浏览器吞掉）：结束沉浸模式
  useEffect(() => {
    const onFullscreenChange = () => {
      if (document.fullscreenElement) return;
      if (requestedFullscreen.current && !userExitedFullscreen.current) onExit();
      requestedFullscreen.current = false;
      userExitedFullscreen.current = false;
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, [onExit]);

  const toggleFullscreen = useCallback(() => {
    if (!useBrowserFullscreen) {
      setBarHidden((v) => !v);
      return;
    }
    if (document.fullscreenElement) {
      userExitedFullscreen.current = true;
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    requestedFullscreen.current = true;
    void document.documentElement.requestFullscreen().catch(() => {
      // 浏览器拒绝时退化为窗口内极简模式
      requestedFullscreen.current = false;
      setBarHidden(true);
    });
  }, [useBrowserFullscreen]);

  const saveOnExit = useCallback(() => {
    onSave();
    onExit();
  }, [onSave, onExit]);

  // Esc 退出；Ctrl+S 由 Editor 自己的 keymap 处理，这里不重复绑
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (document.fullscreenElement) {
          userExitedFullscreen.current = true;
          void document.exitFullscreen().catch(() => undefined);
        }
        saveOnExit();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        patchSettings({ typewriter: !settingsRef.current.typewriter });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [patchSettings, saveOnExit]);

  const onCursor = useCallback(() => undefined, []);

  const editorNode = useMemo(() => {
    if (renderEditor) return renderEditor({ initialContent: content, registerView });
    return (
      <Editor
        key={activePath ?? "__immersive__"}
        path={activePath ?? ""}
        initialContent={content}
        // 打字机居中由 Editor 自己在每次文档变化后做（见 Editor 里的 whenImeIdle 分支），
        // 这里把开关传下去，别再靠一个从没被派发过的事件去补。
        typewriterMode={typewriter}
        onChange={onChange}
        onSave={onSave}
        onCursor={onCursor}
        registerView={registerView}
      />
    );
  }, [activePath, content, onChange, onSave, onCursor, registerView, renderEditor, typewriter]);

  const words = showWordCount ? countWords(content, countMode) : 0;
  const bare = barHidden || isFullscreen;
  const hostClass = ["immersive", className, bare ? "immersive-bare" : ""].filter(Boolean).join(" ");

  const defaultStats = (
    <div className="im-stats">
      {showWordCount && (
        <span className="im-stat" title="字数">
          <b>{formatNumber(words)}</b> 字
        </span>
      )}
      {showTimer && <ImmersiveTimer />}
    </div>
  );

  return (
    <div className={hostClass} ref={hostRef} role="dialog" aria-label="沉浸写作模式">
      <header className="im-bar">
        <div className="im-bar-left">
          <span className="im-dot" aria-hidden="true" />
          <span className="im-title" title={activePath ?? ""}>
            {activePath ? activePath.split("/").pop() : "沉浸写作"}
          </span>
        </div>
        <div className="im-bar-right">
          <button
            type="button"
            className={"im-btn " + (typewriter ? "on" : "")}
            aria-pressed={typewriter}
            title="打字机居中（Ctrl+Shift+T，双击正文也可切换）"
            onClick={() => patchSettings({ typewriter: !typewriter })}
          >
            居中
          </button>
          <ImmersiveFontControl />
          <button
            type="button"
            className={"im-btn " + (isFullscreen ? "on" : "")}
            title="全屏"
            onClick={toggleFullscreen}
          >
            全屏
          </button>
          <button type="button" className="im-btn" title="保存（Ctrl+S）" onClick={onSave}>
            保存
          </button>
          <button type="button" className="im-btn im-btn-primary" title="退出（Esc）" onClick={saveOnExit}>
            退出 Esc
          </button>
          {headerSlot}
        </div>
      </header>

      <div className="im-stage" onDoubleClick={() => patchSettings({ typewriter: !typewriter })}>
        <div className="im-editor">{editorNode}</div>
        <PaperCompanion />
      </div>

      <footer className="im-foot">
        <div className="im-slot im-slot-stats">{statsSlot ?? defaultStats}</div>
        <span className="im-hint">Esc 退出 · Ctrl+S 保存 · Ctrl+Shift+T 居中</span>
        <div className="im-slot im-slot-footer">{footerSlot}</div>
      </footer>
    </div>
  );
}

export interface ImmersiveTimerProps {
  /** 传 false 可让计时器停住（例如失焦暂停） */
  running?: boolean;
  idleLabel?: string;
  className?: string;
  /** 统计区插槽里可以自己接管，比如把用时写进 sidecar */
  onIdleClick?: () => void;
}

/** 写作计时：点击开始，可暂停/重置；纯前端，不落盘 */
export function ImmersiveTimer({
  running = true,
  idleLabel = "计时",
  className,
  onIdleClick,
}: ImmersiveTimerProps) {
  const [startAt, setStartAt] = useState<number | null>(null);
  const [endAt, setEndAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [paused, setPaused] = useState(false);

  const started = startAt !== null;
  const ticking = started && !paused && running;

  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [ticking]);

  if (startAt === null) {
    return (
      <button
        type="button"
        className={"im-stat im-stat-timer " + (className ?? "")}
        onClick={() => {
          setStartAt(Date.now());
          setNow(Date.now());
          onIdleClick?.();
        }}
      >
        {idleLabel}
      </button>
    );
  }

  const text = formatClock((endAt ?? now) - startAt);

  const setPause = (next: boolean) => {
    setPaused(next);
    setEndAt(next ? Date.now() : null);
    setNow(Date.now());
  };

  return (
    <span className={"im-stat im-stat-timer " + (className ?? "")}>
      <b>{text}</b>
      <button type="button" className="im-mini" title={paused ? "继续计时" : "暂停计时"} onClick={() => setPause(!paused)}>
        {paused ? "▶" : "⏸"}
      </button>
      <button
        type="button"
        className="im-mini"
        title="重置计时"
        onClick={() => {
          setStartAt(null);
          setEndAt(null);
          setPaused(false);
        }}
      >
        ⟲
      </button>
    </span>
  );
}

function ImmersiveFontControl() {
  const { fontSize } = useTypography();
  return (
    <span className="im-font">
      <button
        type="button"
        className="im-mini"
        title="减小字号"
        onClick={() => setTypography({ fontSize: fontSize - 1 })}
      >
        A−
      </button>
      <button
        type="button"
        className="im-mini"
        title="增大字号"
        onClick={() => setTypography({ fontSize: fontSize + 1 })}
      >
        A+
      </button>
      <button
        type="button"
        className="im-mini"
        title="恢复默认字号"
        onClick={() => setTypography({ fontSize: DEFAULT_TYPOGRAPHY.fontSize })}
      >
        A0
      </button>
    </span>
  );
}

export default ImmersiveEditor;
