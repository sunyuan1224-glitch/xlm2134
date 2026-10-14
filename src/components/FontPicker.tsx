/*
 * 字体选择器：Word 那种下拉 —— 点开一个可搜索的列表，每一项都用**该字体自己**渲染预览。
 *
 * 列表 = 主题预设（几条多字体回退栈，固定几项）+ 本机已安装字体（Tauri 命令 fc-list 取回）。
 * 拿不到字体列表（浏览器里预览、或本机没有 fc-list）时只显示预设，不报错、也不挡设置面板。
 * 选择结果写回 typography.fontFamily：预设写整条字体栈，具体字体写成带引号的族名 + 兜底。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { FONT_PRESETS } from "../lib/typography";

interface Props {
  /** 当前 fontFamily（空串 = 主题默认） */
  value: string;
  onChange: (family: string) => void;
}

/** 族名含空格或逗号时 CSS 需要引号，否则整条 font-family 会被解析坏 */
function cssFamily(name: string): string {
  return /[\s,']/.test(name) ? `"${name.replace(/"/g, "")}", serif` : `${name}, serif`;
}

/** 下拉框上显示的名字：去掉引号与逗号后面的兜底字体 */
function displayName(value: string): string {
  if (!value) return "主题默认";
  const preset = FONT_PRESETS.find((p) => p.stack === value);
  if (preset) return preset.label;
  return value.replace(/^["']/, "").split(",")[0].replace(/["']$/, "").trim();
}

export function FontPicker({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [fonts, setFonts] = useState<string[] | null>(null); // null = 还没取过
  const wrapRef = useRef<HTMLDivElement>(null);

  // 首次打开才去取字体列表：设置面板一打开就 spawn 一个进程没必要
  useEffect(() => {
    if (!open || fonts !== null) return;
    let alive = true;
    void api
      .listFonts()
      .then((list) => {
        if (alive) setFonts(Array.isArray(list) ? list.filter((f) => f.trim() !== "") : []);
      })
      .catch(() => {
        if (alive) setFonts([]);
      });
    return () => {
      alive = false;
    };
  }, [open, fonts]);

  // 点外面 / Esc 关掉
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const q = query.trim().toLowerCase();
  const shown = useMemo(() => (fonts ?? []).filter((f) => (q ? f.toLowerCase().includes(q) : true)), [fonts, q]);

  const pick = (family: string) => {
    onChange(family);
    setOpen(false);
  };

  return (
    <div className="font-picker" ref={wrapRef}>
      <button
        type="button"
        className={"font-combo" + (open ? " open" : "")}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="字体"
        onClick={() => {
          setOpen((v) => !v);
          setQuery("");
        }}
      >
        <span className="font-combo-name" style={{ fontFamily: value || undefined }}>
          {displayName(value)}
        </span>
        <span className="font-combo-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div className="font-drop" role="listbox" aria-label="字体">
          <input
            className="font-search panel-input"
            autoFocus
            value={query}
            spellCheck={false}
            placeholder="搜索已安装的字体…"
            aria-label="搜索字体"
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="font-list">
            <button
              type="button"
              className={"font-opt" + (value === "" ? " on" : "")}
              onClick={() => pick("")}
            >
              主题默认
            </button>
            {FONT_PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                className={"font-opt" + (value === p.stack ? " on" : "")}
                style={{ fontFamily: p.stack }}
                onClick={() => pick(p.stack)}
              >
                {p.label}
              </button>
            ))}
            {fonts === null ? (
              <div className="font-empty">正在读取已安装的字体…</div>
            ) : shown.length === 0 ? (
              <div className="font-empty">{q ? "没有匹配的字体" : "没读到本机字体列表"}</div>
            ) : (
              shown.map((f) => (
                <button
                  key={f}
                  type="button"
                  className={"font-opt" + (value === cssFamily(f) ? " on" : "")}
                  style={{ fontFamily: cssFamily(f) }}
                  title={f}
                  onClick={() => pick(cssFamily(f))}
                >
                  {f}
                </button>
              ))
            )}
          </div>
          <p className="font-note">列表来自本机已安装字体，预览就是用该字体渲染的。</p>
        </div>
      )}
    </div>
  );
}

export default FontPicker;
