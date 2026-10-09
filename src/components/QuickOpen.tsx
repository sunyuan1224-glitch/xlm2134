/*
 * 快速打开（Ctrl+P）：输入关键词模糊匹配工作区文件，回车打开。
 * 支持子序列匹配（例如输入 "diyi" 或 "1-2" 都能命中），方向键选择。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ModalStage } from "./ModalStage";

interface Props {
  files: string[];
  onOpen: (path: string) => void;
  onClose: () => void;
}

/** 返回匹配分数（越小越好）；不匹配返回 null */
export function fuzzyScore(text: string, query: string): number | null {
  if (!query) return text.length;
  const lower = text.toLowerCase();
  let pos = 0;
  let score = 0;
  let lastHit = -1;
  for (const ch of query.toLowerCase()) {
    const idx = lower.indexOf(ch, pos);
    if (idx === -1) return null;
    if (idx !== lastHit + 1) score += 1;
    score += idx - pos > 0 ? idx - pos : 0;
    lastHit = idx;
    pos = idx + 1;
  }
  return score + text.length * 0.01;
}

export function QuickOpen({ files, onOpen, onClose }: Props) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const results = useMemo(() => {
    const scored: { path: string; score: number }[] = [];
    for (const f of files) {
      const s = fuzzyScore(f, q.trim());
      if (s !== null) scored.push({ path: f, score: s });
    }
    scored.sort((a, b) => a.score - b.score || a.path.localeCompare(b.path));
    return scored.slice(0, 200).map((s) => s.path);
  }, [files, q]);

  useEffect(() => {
    setIdx(0);
  }, [q]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(".qo-item.on");
    el?.scrollIntoView({ block: "nearest" });
  }, [idx, results]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const p = results[idx];
      if (p) {
        onOpen(p);
        onClose();
      }
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  return (
    <div className="modal-mask qo-mask" onClick={onClose}>
      <ModalStage>
      <div className="qo-modal" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="qo-input"
          placeholder="快速打开文件…（输入章节名或路径片段）"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="qo-list" ref={listRef}>
          {results.length === 0 && <div className="qo-empty">没有匹配的文件</div>}
          {results.map((p, i) => (
            <div
              key={p}
              className={"qo-item " + (i === idx ? "on" : "")}
              onMouseEnter={() => setIdx(i)}
              onClick={() => {
                onOpen(p);
                onClose();
              }}
              title={p}
            >
              <span className="qo-name">{p.split("/").pop()?.replace(/\.md$/, "")}</span>
              <span className="qo-path">{p}</span>
            </div>
          ))}
        </div>
        <div className="qo-foot">↑↓ 选择 · Enter 打开 · Esc 关闭</div>
      </div>
      </ModalStage>
    </div>
  );
}

export default QuickOpen;
