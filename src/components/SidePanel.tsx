import { useRef, useState } from "react";
import { useStore } from "../store";
import { api } from "../api";

export function SearchPanel() {
  const root = useStore((s) => s.root);
  const openFile = useStore((s) => s.openFile);
  const [q, setQ] = useState("");
  const [isRegex, setIsRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [hits, setHits] = useState<{ path: string; line: number; text: string }[]>([]);
  const [busy, setBusy] = useState(false);
  /** 连按回车会同时有几个搜索在跑，只认最后一次发出的那个结果 */
  const seq = useRef(0);

  const run = async () => {
    if (!root || !q.trim()) return;
    const mine = ++seq.current;
    setBusy(true);
    try {
      const r = await api.searchText(root, q, isRegex, caseSensitive);
      if (seq.current === mine) setHits(r);
    } catch {
      if (seq.current === mine) setHits([]);
    }
    if (seq.current === mine) setBusy(false);
  };

  return (
    <div className="side-panel">
      <div className="panel-head">搜索</div>
      <div className="panel-row">
        <input
          className="panel-input"
          placeholder="搜索…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run()}
          autoFocus
        />
        <button className="btn" onClick={run} disabled={busy}>
          {busy ? "…" : "搜索"}
        </button>
      </div>
      <div className="panel-row panel-toggles">
        <label>
          <input type="checkbox" checked={isRegex} onChange={(e) => setIsRegex(e.target.checked)} />
          正则
        </label>
        <label>
          <input
            type="checkbox"
            checked={caseSensitive}
            onChange={(e) => setCaseSensitive(e.target.checked)}
          />
          区分大小写
        </label>
      </div>
      <div className="panel-list">
        {hits.length === 0 && q && <div className="panel-empty">无结果</div>}
        {hits.slice(0, 300).map((h) => (
          <div
            key={h.path + ":" + h.line}
            className="hit"
            onClick={() => openFile(h.path)}
            title={h.path + ":" + h.line}
          >
            <div className="hit-loc">
              {h.path.split("/").pop()}:{h.line}
            </div>
            <div className="hit-text">{h.text.trim().slice(0, 80)}</div>
          </div>
        ))}
        {hits.length > 300 && <div className="panel-empty">仅显示前 300 条</div>}
      </div>
    </div>
  );
}
