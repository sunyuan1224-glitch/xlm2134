/**
 * M3 时间线 + 设定面板。
 *
 * 入口：
 *  - <TimelinePanel />  时间线：事件增删改、类型筛选、按时间/类型分组、章节与设定关联
 *  - <LorePanel />      设定：词条增删改、类型/关键词筛选、关系编辑 + 简单关系图谱列表
 *  - <TimelineLore />   上面两个的带页签外壳（时间线 / 设定）
 *
 * 数据全部走 src/lib/sidecar.ts 的 loadTimeline/saveTimeline/loadLore/saveLore，
 * 落在作品目录的 .novel/timeline.json、.novel/lore.json。引用解析规则见 src/lib/refs.ts。
 */

import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { currentWork } from "../lib/foreshadow";
import { parseNumber } from "../lib/chapter";
import {
  UNMATCHED,
  buildLoreIndex,
  chapterLabel,
  eventLabel,
  joinTokens,
  loreByRef,
  loreIdOf,
  loreLabel,
  matchChapter,
  splitTokens,
  tokensOf,
  type ChapterRef,
  type LoreIndex,
} from "../lib/refs";
import { loadLore, loadTimeline, saveLore, saveTimeline, uid } from "../lib/sidecar";
import type { LoreEntry, TimelineEvent } from "../lib/types";

const EVENT_TYPES = ["开场", "主线", "支线", "转折", "高潮", "结尾", "背景"];
const LORE_TYPES = ["人物", "地点", "组织", "物品", "能力", "概念", "事件", "其它"];

// ---------------- 共用小工具 ----------------

function useWork(): string | null {
  const root = useStore((s) => s.root);
  const files = useStore((s) => s.files);
  const activePath = useStore((s) => s.activePath);
  return useMemo(() => currentWork(), [root, files, activePath]);
}

/** 可关联的章节：store 里解析好的章节 + 其它 md/txt 文件（兼容路径引用） */
function useChapterRefs(): ChapterRef[] {
  const chapters = useStore((s) => s.chapters);
  const files = useStore((s) => s.files);
  return useMemo(() => {
    const out: ChapterRef[] = chapters.map((c) => ({ path: c.path, title: c.title, name: c.name }));
    const seen = new Set(out.map((c) => c.path));
    for (const f of files) {
      if (seen.has(f) || !/\.(md|markdown|txt)$/i.test(f)) continue;
      seen.add(f);
      const base = f.split("/").pop() ?? f;
      out.push({ path: f, title: base.replace(/\.(md|markdown|txt)$/i, ""), name: base });
    }
    return out;
  }, [chapters, files]);
}

function usePersist<T>(
  work: string | null,
  setter: (v: T[]) => void,
  save: (v: T[], work: string | null) => Promise<void>,
): (items: T[], msg: string) => Promise<void> {
  return useMemo(
    () => async (items: T[], msg: string) => {
      setter(items);
      if (work === null) {
        useStore.getState().setStatus("没有作品目录，改动没有写入磁盘");
        return;
      }
      await save(items, work);
      useStore.getState().setStatus(msg);
    },
    [work, setter, save],
  );
}

function typeChipsOf(types: string[]): { key: string; label: string; n: number }[] {
  const counts = new Map<string, number>();
  for (const t of types) {
    const k = t.trim() || UNMATCHED;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"))
    .map(([k, n]) => ({ key: k, label: k === UNMATCHED ? "未分类" : k, n }));
}

function NoWork() {
  return (
    <div className="panel-empty">
      还没有可用的作品
      <br />
      先在左栏打开任意一个章节文件，数据会存到作品的 .novel 目录里
    </div>
  );
}

// ---------------- 时间线 ----------------

function emptyEvent(type: string): TimelineEvent {
  return { id: uid(), time: "", title: "", type, chapters: [], lore: [], note: "" };
}

function timeKey(t: string): { n: number | null; s: string } {
  const s = (t ?? "").trim();
  if (!s) return { n: null, s };
  const num = s.match(/\d+(?:\.\d+)?/);
  if (num) return { n: parseFloat(num[0]), s };
  const cn = s.match(/[零一二三四五六七八九十百千两壹贰叁肆伍陆柒捌玖拾佰仟万]+/);
  if (cn) {
    const v = parseNumber(cn[0]);
    if (v !== null) return { n: v, s };
  }
  return { n: null, s };
}

/** 时间值能解析成数字的排前面（第2天 < 第10天），解析不了的按中文排序放后面 */
export function sortEvents(list: TimelineEvent[]): TimelineEvent[] {
  return [...list].sort((a, b) => {
    const ka = timeKey(a.time);
    const kb = timeKey(b.time);
    if (ka.n !== null && kb.n !== null && ka.n !== kb.n) return ka.n - kb.n;
    if (ka.n !== null && kb.n === null) return -1;
    if (ka.n === null && kb.n !== null) return 1;
    const c = ka.s.localeCompare(kb.s, "zh-CN");
    if (c !== 0) return c;
    return (a.title || "").localeCompare(b.title || "", "zh-CN");
  });
}

interface EventGroup {
  key: string;
  label: string;
  items: TimelineEvent[];
}

function groupEvents(list: TimelineEvent[], mode: "time" | "type"): EventGroup[] {
  if (mode === "time") return [{ key: "time", label: "按时间排序", items: list }];
  const keys: string[] = [];
  for (const e of list) {
    const k = e.type.trim() || UNMATCHED;
    if (!keys.includes(k)) keys.push(k);
  }
  keys.sort((a, b) =>
    a === UNMATCHED ? 1 : b === UNMATCHED ? -1 : a.localeCompare(b, "zh-CN"),
  );
  return keys.map((k) => ({
    key: k,
    label: k === UNMATCHED ? "未分类" : k,
    items: list.filter((e) => (e.type.trim() || UNMATCHED) === k),
  }));
}

export function TimelinePanel({ onOpenLore }: { onOpenLore?: (id: string) => void }) {
  const work = useWork();
  const chapters = useChapterRefs();
  const [items, setItems] = useState<TimelineEvent[]>([]);
  const [lore, setLore] = useState<LoreEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const [group, setGroup] = useState<"time" | "type">("time");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoaded(false);
    if (work === null) {
      setItems([]);
      setLore([]);
      setLoaded(true);
      return;
    }
    Promise.all([loadTimeline(work), loadLore(work)])
      .then(([tl, lo]) => {
        if (!alive) return;
        setItems(tl);
        setLore(lo);
        setLoaded(true);
      })
      .catch(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [work]);

  const index = useMemo(() => buildLoreIndex(lore), [lore]);
  const commit = usePersist<TimelineEvent>(work, setItems, saveTimeline);

  const typeOptions = useMemo(
    () => Array.from(new Set([...EVENT_TYPES, ...items.map((e) => e.type.trim()).filter(Boolean)])),
    [items],
  );
  const chips = useMemo(() => typeChipsOf(items.map((e) => e.type)), [items]);
  const filtered = useMemo(() => {
    const needle = q.trim();
    return items.filter((e) => {
      if (type && (e.type.trim() || UNMATCHED) !== type) return false;
      if (!needle) return true;
      return (
        e.title.includes(needle) ||
        e.note.includes(needle) ||
        e.time.includes(needle) ||
        e.chapters.some((c) => c.includes(needle)) ||
        e.lore.some((c) => c.includes(needle))
      );
    });
  }, [items, q, type]);
  const groups = useMemo(() => groupEvents(sortEvents(filtered), group), [filtered, group]);

  const openLore = onOpenLore ?? ((_id: string) => useStore.getState().setWorkTab("lore"));

  const saveEvent = (next: TimelineEvent) => {
    const exists = items.some((e) => e.id === next.id);
    setAdding(false);
    setEditing(null);
    void commit(
      exists ? items.map((e) => (e.id === next.id ? next : e)) : [...items, next],
      exists ? "已更新时间线事件" : "已新增时间线事件",
    );
  };

  const removeEvent = (ev: TimelineEvent) => {
    void commit(items.filter((e) => e.id !== ev.id), "已删除时间线事件");
  };

  return (
    <>
      <div className="panel-row">
        <input
          className="panel-input"
          placeholder="搜索事件 / 时间 / 章节 / 设定…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button
          className="btn"
          onClick={() => {
            setAdding(true);
            setEditing(null);
          }}
        >
          ＋ 新建
        </button>
      </div>

      <div className="tag-row">
        <button
          className={"tag-chip " + (type === "" ? "on" : "")}
          onClick={() => setType("")}
        >
          全部 {items.length}
        </button>
        {chips.map((c) => (
          <button
            key={c.key}
            className={"tag-chip " + (type === c.key ? "on" : "")}
            onClick={() => setType(type === c.key ? "" : c.key)}
          >
            {c.label} {c.n}
          </button>
        ))}
        <button
          className="tag-chip tl-group-toggle"
          title="切换分组方式"
          onClick={() => setGroup(group === "time" ? "type" : "time")}
        >
          {group === "time" ? "分组：时间" : "分组：类型"}
        </button>
      </div>

      <div className="panel-list">
        {!loaded && <div className="panel-empty">读取中…</div>}
        {loaded && work === null && <NoWork />}
        {loaded && work !== null && adding && (
          <EventEditor
            initial={emptyEvent(type && type !== UNMATCHED ? type : "")}
            typeOptions={typeOptions}
            chapters={chapters}
            lore={lore}
            onSave={saveEvent}
            onCancel={() => setAdding(false)}
          />
        )}
        {loaded && work !== null && items.length === 0 && !adding && (
          <div className="panel-empty">
            还没有时间线事件
            <br />
            点右上「＋ 新建」记下第一个事件
          </div>
        )}
        {loaded && work !== null && items.length > 0 && filtered.length === 0 && !adding && (
          <div className="panel-empty">没有匹配的事件</div>
        )}
        {groups.map((g) => (
          <div className="board-group" key={g.key}>
            {group === "type" && (
              <div className="group-head">
                <span>{g.label}</span>
                <span className="group-count">{g.items.length}</span>
              </div>
            )}
            {g.items.map((ev) =>
              editing === ev.id ? (
                <EventEditor
                  key={ev.id}
                  initial={ev}
                  typeOptions={typeOptions}
                  chapters={chapters}
                  lore={lore}
                  onSave={saveEvent}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <EventCard
                  key={ev.id}
                  ev={ev}
                  index={index}
                  chapters={chapters}
                  onEdit={() => {
                    setAdding(false);
                    setEditing(ev.id);
                  }}
                  onRemove={() => removeEvent(ev)}
                  onOpenLore={openLore}
                />
              ),
            )}
          </div>
        ))}
      </div>
    </>
  );
}

function EventCard({
  ev,
  index,
  chapters,
  onEdit,
  onRemove,
  onOpenLore,
}: {
  ev: TimelineEvent;
  index: LoreIndex;
  chapters: ChapterRef[];
  onEdit: () => void;
  onRemove: () => void;
  onOpenLore: (id: string) => void;
}) {
  const openFile = useStore((s) => s.openFile);
  const refs = tokensOf(ev.lore);
  const chapRefs = tokensOf(ev.chapters);
  return (
    <div className="card tl-card">
      <div className="tl-head">
        <span className={"tl-type" + (ev.type.trim() ? "" : " dim")}>{ev.type.trim() || "未分类"}</span>
        <span className="tl-title">{ev.title.trim() || "(无标题)"}</span>
      </div>
      {ev.time.trim() && <div className="tl-time">{ev.time.trim()}</div>}
      {chapRefs.length > 0 && (
        <div className="tl-refs">
          {chapRefs.map((ref) => {
            const c = matchChapter(ref, chapters);
            return (
              <button
                key={ref}
                className={"tag-mini tl-ref" + (c ? " link" : " warn")}
                title={c ? c.path : "未匹配到章节：" + ref}
                onClick={() => {
                  if (c) void openFile(c.path);
                }}
              >
                {chapterLabel(ref, chapters)}
              </button>
            );
          })}
        </div>
      )}
      {refs.length > 0 && (
        <div className="tl-refs">
          {refs.map((ref) => {
            const entry = loreByRef(ref, index);
            return (
              <button
                key={ref}
                className={"tag-mini tl-ref lo" + (entry ? " link" : " warn")}
                title={entry ? "设定：" + entry.name : "未匹配到设定词条：" + ref}
                onClick={() => {
                  if (entry) onOpenLore(entry.id);
                }}
              >
                {loreLabel(ref, index) || "未匹配"}
              </button>
            );
          })}
        </div>
      )}
      {ev.note.trim() && <div className="fs-stage tl-note">{ev.note.trim()}</div>}
      <div className="fs-form-btns">
        <button className="btn btn-xs" onClick={onEdit}>
          编辑
        </button>
        <button className="btn btn-xs danger" onClick={onRemove}>
          删除
        </button>
      </div>
    </div>
  );
}

function EventEditor({
  initial,
  typeOptions,
  chapters,
  lore,
  onSave,
  onCancel,
}: {
  initial: TimelineEvent;
  typeOptions: string[];
  chapters: ChapterRef[];
  lore: LoreEntry[];
  onSave: (ev: TimelineEvent) => void;
  onCancel: () => void;
}) {
  const [time, setTime] = useState(initial.time);
  const [title, setTitle] = useState(initial.title);
  const [type, setType] = useState(initial.type);
  const [notes, setNotes] = useState(initial.note);
  const [refs, setRefs] = useState<string[]>(() => tokensOf(initial.chapters));
  const [loreRefs, setLoreRefs] = useState<string[]>(() => tokensOf(initial.lore));
  const [freeChapter, setFreeChapter] = useState("");
  const [freeLore, setFreeLore] = useState("");
  const index = useMemo(() => buildLoreIndex(lore), [lore]);
  const listId = "tl-types-" + initial.id;
  const loreListId = "tl-lore-" + initial.id;

  const addRef = (ref: string) => {
    const v = ref.trim();
    if (!v) return;
    setRefs((prev) => (prev.includes(v) ? prev : [...prev, v]));
  };
  const addLoreRef = (ref: string) => {
    const v = ref.trim();
    if (!v) return;
    setLoreRefs((prev) => (prev.includes(v) ? prev : [...prev, v]));
  };

  const submit = () => {
    if (!title.trim() && !time.trim()) return;
    onSave({
      id: initial.id,
      time: time.trim(),
      title: title.trim(),
      type: type.trim(),
      chapters: refs,
      lore: loreRefs,
      note: notes.trim(),
    });
  };

  return (
    <div className="card tl-card tl-editing">
      <div className="fs-form">
        <input
          className="panel-input"
          placeholder="时间：第3天 / 卷二·5 / 三年前"
          value={time}
          onChange={(e) => setTime(e.target.value)}
        />
        <input
          className="panel-input"
          placeholder="事件标题"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <input
          className="panel-input"
          placeholder="类型：主线 / 支线 / 转折…"
          list={listId}
          value={type}
          onChange={(e) => setType(e.target.value)}
        />
        <datalist id={listId}>
          {typeOptions.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>

        <div className="tl-sub">
          <span className="tl-sub-label">关联章节</span>
          {refs.length > 0 && (
            <div className="tl-chips">
              {refs.map((ref) => (
                <button
                  key={ref}
                  className="tag-chip on tl-chip"
                  title="点击移除"
                  onClick={() => setRefs(refs.filter((x) => x !== ref))}
                >
                  {chapterLabel(ref, chapters)} ×
                </button>
              ))}
            </div>
          )}
          <div className="tl-pick">
            <select
              className="panel-input"
              value=""
              onChange={(e) => {
                if (e.target.value) addRef(e.target.value);
              }}
            >
              <option value="">选择章节…</option>
              {chapters.map((c) => (
                <option key={c.path} value={c.title || c.name}>
                  {c.title || c.name}
                </option>
              ))}
            </select>
            <input
              className="panel-input"
              placeholder="或手输卷/章名"
              value={freeChapter}
              onChange={(e) => setFreeChapter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  addRef(freeChapter);
                  setFreeChapter("");
                }
              }}
            />
            <button
              className="btn btn-xs"
              disabled={!freeChapter.trim()}
              onClick={() => {
                addRef(freeChapter);
                setFreeChapter("");
              }}
            >
              加
            </button>
          </div>
        </div>

        <div className="tl-sub">
          <span className="tl-sub-label">关联设定</span>
          {loreRefs.length > 0 && (
            <div className="tl-chips">
              {loreRefs.map((ref) => (
                <button
                  key={ref}
                  className="tag-chip on tl-chip lore"
                  title="点击移除"
                  onClick={() => setLoreRefs(loreRefs.filter((x) => x !== ref))}
                >
                  {loreLabel(ref, index) || "未匹配"} ×
                </button>
              ))}
            </div>
          )}
          <div className="tl-pick">
            <select
              className="panel-input"
              value=""
              onChange={(e) => {
                if (e.target.value) addLoreRef(e.target.value);
              }}
            >
              <option value="">选择设定词条…</option>
              {lore.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
            <input
              className="panel-input"
              placeholder="或手输新名词"
              list={loreListId}
              value={freeLore}
              onChange={(e) => setFreeLore(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  addLoreRef(freeLore);
                  setFreeLore("");
                }
              }}
            />
            <datalist id={loreListId}>
              {lore.map((l) => (
                <option key={l.id} value={l.name} />
              ))}
            </datalist>
            <button
              className="btn btn-xs"
              disabled={!freeLore.trim()}
              onClick={() => {
                addLoreRef(freeLore);
                setFreeLore("");
              }}
            >
              加
            </button>
          </div>
        </div>

        <textarea
          className="panel-input tl-area"
          rows={2}
          placeholder="备注：这一段发生了什么…"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
        <div className="fs-form-btns">
          <button className="btn btn-xs accent" disabled={!title.trim() && !time.trim()} onClick={submit}>
            保存
          </button>
          <button className="btn btn-xs" onClick={onCancel}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------- 设定 ----------------

function emptyLore(type: string): LoreEntry {
  return {
    id: uid(),
    name: "",
    type,
    aliases: [],
    content: "",
    sourcePath: "",
    relations: [],
  };
}

export function LorePanel() {
  const work = useWork();
  const [items, setItems] = useState<LoreEntry[]>([]);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const [view, setView] = useState<"list" | "graph">("list");
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoaded(false);
    if (work === null) {
      setItems([]);
      setTimeline([]);
      setLoaded(true);
      return;
    }
    Promise.all([loadLore(work), loadTimeline(work)])
      .then(([lo, tl]) => {
        if (!alive) return;
        setItems(lo);
        setTimeline(tl);
        setLoaded(true);
      })
      .catch(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [work]);

  const index = useMemo(() => buildLoreIndex(items), [items]);
  const commit = usePersist<LoreEntry>(work, setItems, saveLore);

  /** 词条在时间线里被引用的事件 */
  const usage = useMemo(() => {
    const m = new Map<string, TimelineEvent[]>();
    for (const ev of timeline) {
      for (const ref of tokensOf(ev.lore)) {
        const entry = loreByRef(ref, index);
        if (!entry) continue;
        const arr = m.get(entry.id) ?? [];
        if (!arr.some((x) => x.id === ev.id)) arr.push(ev);
        m.set(entry.id, arr);
      }
    }
    return m;
  }, [timeline, index]);

  const typeOptions = useMemo(
    () => Array.from(new Set([...LORE_TYPES, ...items.map((e) => e.type.trim()).filter(Boolean)])),
    [items],
  );
  const chips = useMemo(() => typeChipsOf(items.map((e) => e.type)), [items]);
  const filtered = useMemo(() => {
    const needle = q.trim();
    return items.filter((e) => {
      if (type && (e.type.trim() || UNMATCHED) !== type) return false;
      if (!needle) return true;
      return (
        e.name.includes(needle) ||
        e.aliases.some((a) => a.includes(needle)) ||
        e.content.includes(needle) ||
        e.relations.some((r) => r.target.includes(needle) || r.label.includes(needle))
      );
    });
  }, [items, q, type]);
  const visible = useMemo(() => new Set(filtered.map((e) => e.id)), [filtered]);

  const saveEntry = (next: LoreEntry) => {
    const exists = items.some((e) => e.id === next.id);
    setAdding(false);
    setEditing(null);
    setOpenId(next.id);
    void commit(
      exists ? items.map((e) => (e.id === next.id ? next : e)) : [...items, next],
      exists ? "已更新设定词条" : "已新增设定词条",
    );
  };

  const removeEntry = (entry: LoreEntry) => {
    const used = usage.get(entry.id)?.length ?? 0;
    const back = items.filter((e) => e.id !== entry.id).map((e) => ({
      ...e,
      relations: e.relations.filter((r) => {
        const t = loreByRef(r.target, index);
        return !t || t.id !== entry.id;
      }),
    }));
    if (editing === entry.id) setEditing(null);
    void commit(back, used > 0 ? `已删除词条（${used} 处时间线引用变为未匹配）` : "已删除设定词条");
  };

  const pick = (id: string) => {
    setQ("");
    setType("");
    setOpenId(id);
    setView("list");
  };

  return (
    <>
      <div className="panel-row">
        <input
          className="panel-input"
          placeholder="搜索名称 / 别名 / 正文 / 关系…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button
          className="btn"
          onClick={() => {
            setAdding(true);
            setEditing(null);
            setView("list");
          }}
        >
          ＋ 新建
        </button>
      </div>

      <div className="tag-row">
        <button
          className={"tag-chip " + (view === "list" ? "on" : "")}
          onClick={() => setView("list")}
        >
          词条 {items.length}
        </button>
        <button
          className={"tag-chip " + (view === "graph" ? "on" : "")}
          onClick={() => setView("graph")}
        >
          关系图谱
        </button>
        <button
          className={"tag-chip " + (type === "" ? "on" : "")}
          onClick={() => setType("")}
        >
          全部类型
        </button>
        {chips.map((c) => (
          <button
            key={c.key}
            className={"tag-chip " + (type === c.key ? "on" : "")}
            onClick={() => setType(type === c.key ? "" : c.key)}
          >
            {c.label} {c.n}
          </button>
        ))}
      </div>

      {view === "graph" ? (
        <LoreGraphView
          items={filtered}
          all={items}
          visible={visible}
          index={index}
          usage={usage}
          onPick={pick}
        />
      ) : (
        <div className="panel-list">
          {!loaded && <div className="panel-empty">读取中…</div>}
          {loaded && work === null && <NoWork />}
          {loaded && work !== null && adding && (
            <LoreEditor
              initial={emptyLore(type && type !== UNMATCHED ? type : "")}
              typeOptions={typeOptions}
              others={items}
              onSave={saveEntry}
              onCancel={() => setAdding(false)}
            />
          )}
          {loaded && work !== null && items.length === 0 && !adding && (
            <div className="panel-empty">
              还没有设定词条
              <br />
              人物、地点、组织、能力都可以先建一条
            </div>
          )}
          {loaded && work !== null && items.length > 0 && filtered.length === 0 && !adding && (
            <div className="panel-empty">没有匹配的词条</div>
          )}
          {filtered.map((entry) =>
            editing === entry.id ? (
              <LoreEditor
                key={entry.id}
                initial={entry}
                typeOptions={typeOptions}
                others={items.filter((e) => e.id !== entry.id)}
                onSave={saveEntry}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <LoreCard
                key={entry.id}
                entry={entry}
                index={index}
                usage={usage.get(entry.id) ?? []}
                open={openId === entry.id}
                onToggle={() => setOpenId(openId === entry.id ? null : entry.id)}
                onEdit={() => {
                  setAdding(false);
                  setEditing(entry.id);
                }}
                onRemove={() => removeEntry(entry)}
                onPick={pick}
              />
            ),
          )}
        </div>
      )}
    </>
  );
}

function LoreCard({
  entry,
  index,
  usage,
  open,
  onToggle,
  onEdit,
  onRemove,
  onPick,
}: {
  entry: LoreEntry;
  index: LoreIndex;
  usage: TimelineEvent[];
  open: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onPick: (id: string) => void;
}) {
  const openFile = useStore((s) => s.openFile);
  const rels = entry.relations.filter((r) => r.target.trim());
  return (
    <div className={"card lo-card" + (open ? " card-active" : "")}>
      <div className="tl-head tl-clickable" onClick={onToggle} title="展开 / 收起">
        <span className={"tl-type" + (entry.type.trim() ? "" : " dim")}>
          {entry.type.trim() || "未分类"}
        </span>
        <span className="tl-title">{entry.name.trim() || "(未命名词条)"}</span>
        {usage.length > 0 && <span className="lo-count" title="时间线引用次数">{usage.length}</span>}
      </div>
      {entry.aliases.length > 0 && (
        <div className="fs-tags">
          {entry.aliases.map((a) => (
            <span key={a} className="tag-mini">
              {a}
            </span>
          ))}
        </div>
      )}
      {entry.content.trim() && (
        <div className={"lo-content" + (open ? " open" : "")}>
          {open || entry.content.length <= 80 ? entry.content : entry.content.slice(0, 80) + "…"}
        </div>
      )}
      {rels.length > 0 && (
        <div className="rel-lines">
          {rels.map((r, i) => {
            const target = loreByRef(r.target, index);
            return (
              <div key={i} className="rel-line">
                <span className="rel-arrow">→</span>
                {r.label.trim() && <span className="rel-label">{r.label.trim()}</span>}
                <button
                  className={"rel-node" + (target ? "" : " warn")}
                  title={target ? "查看该词条" : "未匹配到词条"}
                  onClick={() => {
                    if (target) onPick(target.id);
                  }}
                >
                  {target ? target.name : r.target}
                </button>
              </div>
            );
          })}
        </div>
      )}
      {open && usage.length > 0 && (
        <div className="fs-stage">
          出现于时间线：
          {usage.map((ev) => (
            <span key={ev.id} className="lo-usage">
              {eventLabel(ev.time, ev.title)}
            </span>
          ))}
        </div>
      )}
      {entry.sourcePath.trim() && (
        <div className="fs-src" onClick={() => void openFile(entry.sourcePath)}>
          {entry.sourcePath}
        </div>
      )}
      <div className="fs-form-btns">
        <button className="btn btn-xs" onClick={onEdit}>
          编辑
        </button>
        <button className="btn btn-xs danger" onClick={onRemove}>
          删除
        </button>
      </div>
    </div>
  );
}

function LoreEditor({
  initial,
  typeOptions,
  others,
  onSave,
  onCancel,
}: {
  initial: LoreEntry;
  typeOptions: string[];
  others: LoreEntry[];
  onSave: (entry: LoreEntry) => void;
  onCancel: () => void;
}) {
  const activePath = useStore((s) => s.activePath);
  const [name, setName] = useState(initial.name);
  const [type, setType] = useState(initial.type);
  const [aliasText, setAliasText] = useState(() => joinTokens(initial.aliases));
  const [content, setContent] = useState(initial.content);
  const [sourcePath, setSourcePath] = useState(initial.sourcePath);
  const [rels, setRels] = useState<{ target: string; label: string }[]>(() =>
    initial.relations.map((r) => ({ target: r.target, label: r.label })),
  );
  const index = useMemo(() => buildLoreIndex(others), [others]);
  const typeListId = "lo-types-" + initial.id;
  const nodeListId = "lo-nodes-" + initial.id;

  const patchRel = (i: number, patch: Partial<{ target: string; label: string }>) => {
    setRels(rels.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };

  const submit = () => {
    if (!name.trim()) return;
    onSave({
      id: initial.id,
      name: name.trim(),
      type: type.trim(),
      aliases: splitTokens(aliasText),
      content,
      sourcePath: sourcePath.trim(),
      relations: rels
        .map((r) => ({ target: loreIdOf(r.target, index), label: r.label.trim() }))
        .filter((r) => r.target || r.label),
    });
  };

  return (
    <div className="card lo-card tl-editing">
      <div className="fs-form">
        <input
          className="panel-input"
          placeholder="名称"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className="panel-input"
          placeholder="类型：人物 / 地点 / 组织…"
          list={typeListId}
          value={type}
          onChange={(e) => setType(e.target.value)}
        />
        <datalist id={typeListId}>
          {typeOptions.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
        <input
          className="panel-input"
          placeholder="别名，逗号分隔"
          value={aliasText}
          onChange={(e) => setAliasText(e.target.value)}
        />
        <textarea
          className="panel-input tl-area"
          rows={4}
          placeholder="词条正文 / 设定说明"
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />

        <div className="tl-sub">
          <span className="tl-sub-label">关系（→ 目标 · 关系词）</span>
          {rels.map((r, i) => (
            <div key={i} className="tl-pick">
              <input
                className="panel-input"
                placeholder="目标词条"
                list={nodeListId}
                value={r.target}
                onChange={(e) => patchRel(i, { target: e.target.value })}
              />
              <input
                className="panel-input rel-label-input"
                placeholder="关系：师徒 / 位于 / 属于"
                value={r.label}
                onChange={(e) => patchRel(i, { label: e.target.value })}
              />
              <button
                className="btn btn-xs danger"
                title="删除这条关系"
                onClick={() => setRels(rels.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </div>
          ))}
          <datalist id={nodeListId}>
            {others.map((o) => (
              <option key={o.id} value={o.name} />
            ))}
          </datalist>
          <button className="btn btn-xs" onClick={() => setRels([...rels, { target: "", label: "" }])}>
            ＋ 添加关系
          </button>
        </div>

        <div className="tl-pick">
          <input
            className="panel-input"
            placeholder="出处文件（可留空）"
            value={sourcePath}
            onChange={(e) => setSourcePath(e.target.value)}
          />
          <button
            className="btn btn-xs"
            disabled={!activePath}
            title="用当前打开的文件作为出处"
            onClick={() => setSourcePath(activePath ?? "")}
          >
            取当前文件
          </button>
        </div>

        <div className="fs-form-btns">
          <button className="btn btn-xs accent" disabled={!name.trim()} onClick={submit}>
            保存
          </button>
          <button className="btn btn-xs" onClick={onCancel}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------- 关系图谱（列表式） ----------------

interface GraphEdgeOut {
  label: string;
  target: string;
  entry?: LoreEntry;
}

function LoreGraphView({
  items,
  all,
  visible,
  index,
  usage,
  onPick,
}: {
  items: LoreEntry[];
  all: LoreEntry[];
  visible: Set<string>;
  index: LoreIndex;
  usage: Map<string, TimelineEvent[]>;
  onPick: (id: string) => void;
}) {
  const graph = useMemo(() => {
    const out = new Map<string, GraphEdgeOut[]>();
    const inc = new Map<string, { label: string; from: LoreEntry }[]>();
    const dangling: { from: LoreEntry; target: string; label: string }[] = [];
    let edges = 0;
    for (const e of items) {
      for (const r of e.relations) {
        edges++;
        const target = loreByRef(r.target, index);
        const arr = out.get(e.id) ?? [];
        arr.push({ label: r.label.trim(), target: r.target, entry: target });
        out.set(e.id, arr);
        if (target) {
          const iarr = inc.get(target.id) ?? [];
          iarr.push({ label: r.label.trim(), from: e });
          inc.set(target.id, iarr);
        } else {
          dangling.push({ from: e, target: r.target, label: r.label.trim() });
        }
      }
    }
    const rows = all
      .map((entry) => {
        const o = out.get(entry.id) ?? [];
        const i = inc.get(entry.id) ?? [];
        return { entry, out: o, in: i, degree: o.length + i.length };
      })
      .sort((a, b) => b.degree - a.degree || a.entry.name.localeCompare(b.entry.name, "zh-CN"));
    const isolated = rows.filter((r) => r.degree === 0).length;
    return { rows, edges, dangling, isolated };
  }, [items, all, index]);

  return (
    <>
      <div className="panel-head">
        词条 {all.length} · 关系 {graph.edges} · 孤立 {graph.isolated} · 悬空引用{" "}
        {graph.dangling.length}
      </div>
      <div className="panel-list">
        {all.length === 0 && <div className="panel-empty">还没有设定词条，先建几条再来看关系</div>}
        {graph.rows.map((row) => {
          const dim = !visible.has(row.entry.id);
          const used = usage.get(row.entry.id)?.length ?? 0;
          return (
            <div key={row.entry.id} className={"card lo-card" + (dim ? " dim" : "")}>
              <div className="tl-head">
                <span className={"tl-type" + (row.entry.type.trim() ? "" : " dim")}>
                  {row.entry.type.trim() || "未分类"}
                </span>
                <button className="tl-title tl-link" onClick={() => onPick(row.entry.id)}>
                  {row.entry.name || "(未命名词条)"}
                </button>
                <span className="lo-count" title="关联度">
                  {row.degree}
                </span>
              </div>
              {row.out.map((o, i) => (
                <div key={"o" + i} className="rel-line">
                  <span className="rel-arrow">→</span>
                  {o.label && <span className="rel-label">{o.label}</span>}
                  <span className={"rel-node" + (o.entry ? "" : " warn")}>
                    {o.entry ? o.entry.name : o.target || "(空引用)"}
                  </span>
                  {o.entry && !visible.has(o.entry.id) && <span className="rel-dim">已筛选</span>}
                </div>
              ))}
              {row.in.map((n, i) => (
                <div key={"i" + i} className="rel-line">
                  <span className="rel-arrow">←</span>
                  {n.label && <span className="rel-label">{n.label}</span>}
                  <button className="rel-node" onClick={() => onPick(n.from.id)}>
                    {n.from.name || "(未命名词条)"}
                  </button>
                </div>
              ))}
              {row.degree === 0 && <div className="fs-stage">孤立词条：还没有任何关系</div>}
              {used > 0 && <div className="fs-stage">时间线引用 {used} 次</div>}
            </div>
          );
        })}
        {graph.dangling.length > 0 && (
          <div className="card lo-card">
            <div className="tl-head">
              <span className="tl-type warn">悬空引用</span>
              <span className="group-count">{graph.dangling.length}</span>
            </div>
            {graph.dangling.map((d, i) => (
              <div key={i} className="rel-line">
                <span className="rel-arrow">→</span>
                {d.label && <span className="rel-label">{d.label}</span>}
                <span className="rel-node warn">{d.target || "(空)"}</span>
                <span className="rel-dim">来自 {d.from.name || "(未命名词条)"}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ---------------- 带页签的外壳 ----------------

export function TimelineLore() {
  const [view, setView] = useState<"timeline" | "lore">("timeline");
  return (
    <div className="side-panel">
      <div className="panel-tabs">
        <button
          className={"ptab " + (view === "timeline" ? "on" : "")}
          onClick={() => setView("timeline")}
        >
          时间线
        </button>
        <button
          className={"ptab " + (view === "lore" ? "on" : "")}
          onClick={() => setView("lore")}
        >
          设定
        </button>
      </div>
      {view === "timeline" ? (
        <TimelinePanel onOpenLore={() => setView("lore")} />
      ) : (
        <LorePanel />
      )}
    </div>
  );
}

export default TimelineLore;
