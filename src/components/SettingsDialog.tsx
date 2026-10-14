/*
 * 「字体与排版」设置对话框。
 * 外观复用 styles.css 的 .modal-mask / .modal / .modal-title / .field /
 * .panel-input / .modal-actions / .btn(.btn.accent/.btn-xs)，只补一点控件布局。
 */
import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { ModalStage } from "./ModalStage";
import { FontPicker } from "./FontPicker";
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  LINE_HEIGHT_MAX,
  LINE_HEIGHT_MIN,
  resetTypography,
  setTypography,
  useTypography,
} from "../lib/typography";
import "../settings.css";

const PREVIEW_LINES = [
  "夜里落了一场很轻的雨。她推开门，听见檐水滴在青石板上，一声，又一声。",
  "“你回来得正好。”老人把茶推过来，杯口还浮着热气，“稿子我读过了，第三段该慢一点。”",
  "她点头，把伞靠在门边。雨声从窗缝里钻进来，像一句没写完的对白，等着人去续。",
];

/** 行距显示：去掉浮点尾巴，1.9 → "1.9" */
function formatLine(value: number): string {
  return String(Number(value.toFixed(2)));
}

export function SettingsDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const typography = useTypography();
  // 数字输入框允许中间态（清空、只敲了一半），失焦时丢掉草稿回到真实值
  const [sizeDraft, setSizeDraft] = useState<string | null>(null);
  const [lineDraft, setLineDraft] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Esc 关闭；用捕获阶段抢在沉浸模式的 Esc（退出沉浸）之前处理
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // 打开时把焦点收进对话框，关闭后还给原来的入口按钮
  useEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    boxRef.current?.focus();
    return () => {
      if (prev && document.contains(prev)) prev.focus();
    };
  }, []);

  // 简单的 Tab 循环，避免焦点跑到对话框背后的编辑区
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const box = boxRef.current;
    if (!box) return;
    const items = Array.from(box.querySelectorAll<HTMLElement>("button, input, select")).filter(
      (el) => !el.hasAttribute("disabled") && el.getClientRects().length > 0,
    );
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === box)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  /** 字体下拉：预设写整条字体栈，具体字体已由 FontPicker 拼成带引号的族名 */
  const onFont = (family: string) => setTypography({ fontFamily: family });

  const onSize = (value: string) => {
    setSizeDraft(value);
    const n = Number(value);
    if (value.trim() !== "" && Number.isFinite(n)) setTypography({ fontSize: n });
  };

  const onLine = (value: string) => {
    setLineDraft(value);
    const n = Number(value);
    if (value.trim() !== "" && Number.isFinite(n)) setTypography({ lineHeight: n });
  };

  const onReset = () => {
    resetTypography();
    setSizeDraft(null);
    setLineDraft(null);
  };

  const previewStyle: CSSProperties = {
    fontFamily: typography.fontFamily || undefined,
    fontSize: `${typography.fontSize}px`,
    lineHeight: typography.lineHeight,
  };

  return (
    <div
      className="modal-mask settings-mask"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <ModalStage>
      <div
        className="modal settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={boxRef}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="modal-title" id={titleId}>
          字体与排版
        </div>
        <p className="set-hint">改动即时生效，常规编辑器与沉浸写作模式共用同一套设置。</p>

        <div className="field">
          <span>字体</span>
          <FontPicker value={typography.fontFamily} onChange={onFont} />
        </div>

        <div className="field">
          <span>
            字号<b className="set-value">{typography.fontSize} px</b>
          </span>
          <div className="set-row">
            <button
              type="button"
              className="btn btn-xs set-step"
              aria-label="减小字号"
              onClick={() => setTypography({ fontSize: typography.fontSize - 1 })}
            >
              −
            </button>
            <input
              className="panel-input set-num"
              type="number"
              min={FONT_SIZE_MIN}
              max={FONT_SIZE_MAX}
              step={1}
              value={sizeDraft ?? String(typography.fontSize)}
              aria-label="字号数值（像素）"
              onChange={(e) => onSize(e.target.value)}
              onBlur={() => setSizeDraft(null)}
            />
            <button
              type="button"
              className="btn btn-xs set-step"
              aria-label="增大字号"
              onClick={() => setTypography({ fontSize: typography.fontSize + 1 })}
            >
              +
            </button>
          </div>
        </div>

        <div className="field">
          <span>
            行距<b className="set-value">{formatLine(typography.lineHeight)} 倍</b>
          </span>
          <div className="set-row">
            <input
              className="set-range"
              type="range"
              min={LINE_HEIGHT_MIN}
              max={LINE_HEIGHT_MAX}
              step={0.05}
              value={typography.lineHeight}
              aria-label="行距（倍数）"
              onChange={(e) => {
                setLineDraft(null);
                setTypography({ lineHeight: Number(e.target.value) });
              }}
            />
            <button
              type="button"
              className="btn btn-xs set-step"
              aria-label="减小行距"
              onClick={() => setTypography({ lineHeight: typography.lineHeight - 0.1 })}
            >
              −
            </button>
            <input
              className="panel-input set-num"
              type="number"
              min={LINE_HEIGHT_MIN}
              max={LINE_HEIGHT_MAX}
              step={0.05}
              value={lineDraft ?? formatLine(typography.lineHeight)}
              aria-label="行距数值（倍数）"
              onChange={(e) => onLine(e.target.value)}
              onBlur={() => setLineDraft(null)}
            />
            <button
              type="button"
              className="btn btn-xs set-step"
              aria-label="增大行距"
              onClick={() => setTypography({ lineHeight: typography.lineHeight + 0.1 })}
            >
              +
            </button>
          </div>
        </div>

        <div className="field">
          <span>预览</span>
          <div className="set-preview" style={previewStyle}>
            {PREVIEW_LINES.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
          <p className="set-meta" title={typography.fontFamily}>
            当前字体：{typography.fontFamily || "（主题默认）"}
          </p>
        </div>

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onReset}>
            恢复默认
          </button>
          <button type="button" className="btn accent" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
      </ModalStage>
    </div>
  );
}

export default SettingsDialog;
