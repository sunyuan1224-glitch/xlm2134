/*
 * 右侧「小说工作台」：保留写小说真正会用到的四块——伏笔、时间线、设定、校对。
 *
 * 「章节工具」（新建下一章 / 导入 / 合并 / 状态目标）已移除：这些属于通用写作
 * 工具，且在菜单与文件树里都有入口，工作台里冗余。
 * 校对面板曾经一起被精简掉，现按需求回归：本地校对引擎（lib/proofread）+
 * 面向当前章节的校对面板，忽略记录跟着作品存进 .novel/proof-ignore.json。
 */
import { useEffect, useMemo, useState } from "react";
import { useStore, type WorkTab } from "../store";
import {
  DEFAULT_TAGS,
  STATUS_LABEL,
  addStage,
  fetchForeshadows,
  makeForeshadow,
  persistForeshadows,
  resolveForeshadow,
  subscribeForeshadows,
  sourceLabel,
} from "../lib/foreshadow";
import type { Foreshadow } from "../lib/types";
import { LorePanel, TimelinePanel } from "./TimelineLore";
import ProofreadPanel from "./ProofreadPanel";
import { applyFix, issueKey } from "../lib/proofread";
import { currentWork, loadProofIgnores, saveProofIgnores } from "../lib/sidecar";
import { DropMenu, type DropMenuGroup } from "./DropMenu";
import { ModalStage } from "./ModalStage";

const TAB_LABEL: Record<WorkTab, string> = {
  plot: "伏笔",
  timeline: "时间线",
  lore: "设定",
  proofread: "校对",
};

/** 工作台导航分组 */
const TAB_GROUPS: { title: string; tabs: WorkTab[] }[] = [
  { title: "创作", tabs: ["plot", "timeline", "lore"] },
  { title: "校对", tabs: ["proofread"] },
];

export function Workbench() {
  const tab = useStore((s) => s.workTab);
  const setTab = useStore((s) => s.setWorkTab);

  const groups: DropMenuGroup[] = TAB_GROUPS.map((g) => ({
    title: g.title,
    items: g.tabs.map((t) => ({
      key: t,
      label: TAB_LABEL[t],
      active: t === tab,
      onClick: () => setTab(t),
    })),
  }));

  return (
    <div className="side-panel">
      <div className="panel-head wb-head">
        <span className="wb-title">工作台</span>
        <DropMenu
          className="wb-picker"
          trigger={TAB_LABEL[tab]}
          title="切换工作台视图"
          groups={groups}
        />
      </div>
      {tab === "plot" && <PlotBoard />}
      {tab === "timeline" && <TimelinePanel />}
      {tab === "lore" && <LorePanel />}
      {tab === "proofread" && <ProofreadCurrent />}
    </div>
  );
}

/** 校对当前打开的章节：引擎在 lib/proofread，忽略记录跟着作品持久化 */
function ProofreadCurrent() {
  const activePath = useStore((s) => s.activePath);
  const content = useStore((s) => (s.activePath ? s.contents[s.activePath] : undefined));
  const setContent = useStore((s) => s.setContent);
  const openFile = useStore((s) => s.openFile);
  const saveFile = useStore((s) => s.saveFile);
  const root = useStore((s) => s.root);
  const files = useStore((s) => s.files);
  const work = useMemo(() => currentWork(), [root, files, activePath]);

  // 忽略记录跟着作品走并写进 .novel/proof-ignore.json：
  // 以前它只是面板内部状态，切到别的标签页再回来，忽略过的又全冒出来了。
  const [ignored, setIgnored] = useState<string[]>([]);
  useEffect(() => {
    if (work === null) {
      setIgnored([]);
      return;
    }
    let alive = true;
    void loadProofIgnores(work).then((v) => {
      if (alive) setIgnored(v);
    });
    return () => {
      alive = false;
    };
  }, [work]);

  if (!activePath || content === undefined)
    return <div className="panel-empty">请先打开一个章节</div>;

  const persist = (next: string[]) => {
    setIgnored(next);
    if (work !== null) void saveProofIgnores(next, work);
  };

  return (
    <ProofreadPanel
      text={content}
        path={activePath}
        ignored={ignored}
        // 精确定位：面板已经把每条问题的 [from, to) 算好了，直接让编辑器选中它
        onLocate={(issue) => {
          if (activePath) void useStore.getState().revealAt(activePath, issue.from, issue.to);
        }}
        openFile={(path) => void openFile(path)}
      onIgnore={(issue) => {
        const k = issueKey(issue);
        if (!ignored.includes(k)) persist([...ignored, k]);
      }}
      onIgnoreRule={(rule) => {
        // IgnoreRule 的三个字段都是可选的（引擎那边允许只按行忽略），
        // 缺任何一个就拼不出 issueKey，这种情况不写记录。
        if (!rule.ruleId || !rule.kind || rule.text === undefined) return;
        // issueKey 就是「同规则 + 同词」，和「忽略这一处」是同一个键
        const k = issueKey({ ruleId: rule.ruleId, kind: rule.kind, text: rule.text });
        if (!ignored.includes(k)) persist([...ignored, k]);
      }}
      onUnignore={(key) => persist(ignored.filter((x) => x !== key))}
      onReplace={(issue, replacement) => {
        setContent(activePath, applyFix(content, issue, replacement));
        void saveFile(activePath);
      }}
    />
  );
}

/** 「关联章节」输入框共用的候选列表 id；整块只渲染一次，见 PlotBoard 里的 datalist */
const CHAP_LIST_ID = "nw-chap-list";

function PlotBoard() {
  const [items, setItems] = useState<Foreshadow[]>([]);
  const [q, setQ] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const activePath = useStore((s) => s.activePath);
  const chapters = useStore((s) => s.chapters);

  useEffect(() => {
    let alive = true;
    const apply = (v: Foreshadow[]) => {
      if (alive) setItems(v);
    };
    fetchForeshadows().then(apply);
    const unsubscribe = subscribeForeshadows(apply);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [activePath]);

  const save = async (next: Foreshadow[]) => {
    setItems(next);
    await persistForeshadows(next);
  };

  const patch = async (id: string, fn: (f: Foreshadow) => Foreshadow) => {
    await save(items.map((f) => (f.id === id ? fn(f) : f)));
  };

  const remove = async (id: string) => {
    await save(items.filter((f) => f.id !== id));
  };

  const match = (f: Foreshadow) =>
    (!q || f.description.includes(q) || f.sourceText.includes(q)) &&
    (!tag || f.tags.includes(tag));

  const allTags = Array.from(new Set(items.flatMap((f) => f.tags)));
  const groups: [string, Foreshadow[]][] = [
    [STATUS_LABEL.open, items.filter((f) => f.status === "open" && match(f))],
    [STATUS_LABEL.done, items.filter((f) => f.status === "done" && match(f))],
    [STATUS_LABEL.abandoned, items.filter((f) => f.status === "abandoned" && match(f))],
  ];

  return (
    <>
      {/* 每张伏笔卡片都带一个「关联章节」输入框；datalist 必须只出现一次，
          否则重复 id 既不合规，list= 也只会绑到第一份上。 */}
      <datalist id={CHAP_LIST_ID}>
        {chapters.map((c) => (
          <option key={c.path} value={c.title} />
        ))}
      </datalist>
      <div className="panel-row">
        <input
          className="panel-input"
          placeholder="搜索伏笔..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {allTags.length > 0 && (
        <div className="tag-row">
          {allTags.map((t) => (
            <button
              key={t}
              className={"tag-chip " + (tag === t ? "on" : "")}
              onClick={() => setTag(tag === t ? null : t)}
            >
              {t}
            </button>
          ))}
        </div>
      )}
      <div className="panel-list">
        {groups.map(([title, list]) =>
          list.length === 0 ? null : (
            <PlotGroup key={title} title={title} items={list} onPatch={patch} onRemove={remove} />
          ),
        )}
        {items.length === 0 && (
          <div className="panel-empty">
            还没有伏笔
            <br />
            在正文选中文字，然后右键「标注为伏笔」
          </div>
        )}
      </div>
    </>
  );
}

function PlotGroup({
  title,
  items,
  onPatch,
  onRemove,
}: {
  title: string;
  items: Foreshadow[];
  onPatch: (id: string, fn: (f: Foreshadow) => Foreshadow) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="board-group">
      <div className="group-head" onClick={() => setOpen(!open)}>
        <span className={"twisty " + (open ? "open" : "")} />
        {title}
        <span className="group-count">{items.length}</span>
      </div>
      {open && items.map((f) => <PlotCard key={f.id} f={f} onPatch={onPatch} onRemove={onRemove} />)}
    </div>
  );
}

function PlotCard({
  f,
  onPatch,
  onRemove,
}: {
  f: Foreshadow;
  onPatch: (id: string, fn: (x: Foreshadow) => Foreshadow) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}) {
  const openFile = useStore((s) => s.openFile);
  const [note, setNote] = useState("");
  const [chapter, setChapter] = useState("");

  const submit = async (kind: "stage" | "resolve") => {
    if (kind === "resolve") {
      await onPatch(f.id, (x) => resolveForeshadow(x, chapter));
    } else {
      if (!note.trim()) return;
      await onPatch(f.id, (x) => addStage(x, note, chapter));
    }
    setNote("");
    setChapter("");
  };

  return (
    <div className="card fs-card">
      <div className="fs-desc">{f.description || f.sourceText.slice(0, 80)}</div>
      <div className="fs-src" onClick={() => openFile(f.sourcePath)}>
        {sourceLabel(f)}
      </div>
      {f.tags.length > 0 && (
        <div className="fs-tags">
          {f.tags.map((t) => (
            <span key={t} className="tag-mini">
              {t}
            </span>
          ))}
        </div>
      )}
      {f.stages.map((s, i) => (
        <div key={"s" + i} className="fs-stage">
          <span className="fs-badge">阶段</span>
          {s.note}
          {s.chapter && <span className="fs-ch"> · {s.chapter}</span>}
        </div>
      ))}
      {f.resolvedChapters.map((c, i) => (
        <div key={"r" + i} className="fs-stage">
          <span className="fs-badge done">回收</span>
          {c}
        </div>
      ))}
      {f.status === "open" ? (
        <div className="fs-form">
          <input
            className="panel-input"
            placeholder="进展说明..."
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <input
            className="panel-input"
            placeholder="关联章节"
            list={CHAP_LIST_ID}
            value={chapter}
            onChange={(e) => setChapter(e.target.value)}
          />
          <div className="fs-form-btns">
            <button className="btn btn-xs" disabled={!note.trim()} onClick={() => submit("stage")}>
              阶段推进
            </button>
            <button className="btn btn-xs accent" onClick={() => submit("resolve")}>
              彻底回收
            </button>
          </div>
        </div>
      ) : (
        <div className="fs-form-btns">
          <button
            className="btn btn-xs"
            onClick={() => onPatch(f.id, (x) => ({ ...x, status: "open" }))}
          >
            恢复
          </button>
          <button
            className="btn btn-xs"
            onClick={() =>
              onPatch(f.id, (x) => ({
                ...x,
                status: x.status === "abandoned" ? "done" : "abandoned",
              }))
            }
          >
            {f.status === "abandoned" ? "标为已回收" : "废弃"}
          </button>
          <button className="btn btn-xs danger" onClick={() => onRemove(f.id)}>
            删除
          </button>
        </div>
      )}
    </div>
  );
}

export function MarkForeshadowDialog({
  path,
  line,
  text,
  onClose,
}: {
  path: string;
  line: number;
  text: string;
  onClose: () => void;
}) {
  const [desc, setDesc] = useState(text.slice(0, 60));
  const [tags, setTags] = useState<string[]>([]);
  const [custom, setCustom] = useState("");
  const [existing, setExisting] = useState<Foreshadow[]>([]);

  useEffect(() => {
    fetchForeshadows().then(setExisting);
  }, []);

  const toggleTag = (t: string) =>
    setTags((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));

  const submit = async () => {
    const all = [...existing];
    all.unshift(
      makeForeshadow({
        description: desc.trim() || text.slice(0, 60),
        tags,
        sourcePath: path,
        sourceLine: line,
        sourceText: text,
      }),
    );
    await persistForeshadows(all);
    useStore.getState().setStatus("已标注伏笔");
    onClose();
  };

  const mergeInto = async (id: string) => {
    const target = existing.find((x) => x.id === id);
    if (!target) return;
    const all = existing.filter((x) => x.id !== id);
    all.unshift({
      ...target,
      tags: Array.from(new Set([...target.tags, ...tags])),
      stages: [
        ...target.stages,
        { at: new Date().toISOString(), note: desc || text.slice(0, 60), chapter: "" },
      ],
    });
    await persistForeshadows(all);
    useStore.getState().setStatus("已合并到已有伏笔");
    onClose();
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <ModalStage>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">标注为伏笔</div>
        <div className="modal-quote">{text.slice(0, 120)}</div>
        <label className="field">
          <span>伏笔描述</span>
          <input
            className="panel-input"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            autoFocus
          />
        </label>
        <div className="field">
          <span>标签</span>
          <div className="tag-row">
            {DEFAULT_TAGS.map((t) => (
              <button
                key={t}
                className={"tag-chip " + (tags.includes(t) ? "on" : "")}
                onClick={() => toggleTag(t)}
              >
                {t}
              </button>
            ))}
            <input
              className="tag-input"
              placeholder="自定义..."
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && custom.trim()) {
                  toggleTag(custom.trim());
                  setCustom("");
                }
              }}
            />
          </div>
        </div>
        {existing.length > 0 && (
          <label className="field">
            <span>合并到已有伏笔</span>
            <select className="panel-input" value="" onChange={(e) => mergeInto(e.target.value)}>
              <option value="">选择...</option>
              {existing.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.description.slice(0, 40)}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn accent" onClick={submit}>
            保存
          </button>
        </div>
      </div>
      </ModalStage>
    </div>
  );
}
