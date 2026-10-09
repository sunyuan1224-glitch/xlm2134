/**
 * 校对面板（P2）
 *
 * 只负责「展示 + 交互」，引擎在 src/lib/proofread.ts。
 * 面板本身不依赖 store / Tauri，所有副作用通过回调交给外层：
 *   - 定位：优先调用 onLocate(issue)；否则退化为 openFile(path, line)（当前编辑器还没做锚点跳转）
 *   - 替换：onReplace(issue, replacement)，由外层改正文（通常 store.setContent）
 *   - 忽略：onIgnore(issue) 忽略这一次命中；onIgnoreRule(rule) 忽略「同规则 + 同词」的所有命中
 *          不传回调时面板内部维护忽略列表（本地态），方便单独预览
 *
 * 典型接法（App.tsx 里，不在本次改动范围内）：
 *   <ProofreadPanel
 *     text={content}
 *     path={activePath}
 *     openFile={openFile}
 *     onReplace={(issue, rep) => setContent(activePath, applyFix(content, issue, rep))}
 *   />
 */

import { useEffect, useMemo, useState } from "react";
import {
  DEFAULT_RULES,
  KIND_LABEL,
  issueKey,
  issueLocation,
  proofread,
  summarizeIssues,
  type IgnoreRule,
  type IssueKind,
  type ProofreadDictionary,
  type ProofreadIssue,
  type ProofreadOptions,
  type ProofreadRuleFlags,
  type Severity,
} from "../lib/proofread";

/**
 * 正文防抖。
 *
 * 面板贴在编辑器旁边，text 每敲一个字都会变，而校对是全文扫描
 * （逐条词典 + 各条标点规则，见 lib/proofread），几万字的章节逐键重跑会明显卡顿。
 * 换章时不等延迟、立刻按新正文重算：让上一章的问题短暂残留会给出错误的行号，
 * 点「定位」就会跳到错的地方。
 */
function useDebouncedText(text: string, path: string | null | undefined, delay: number): string {
  const [snap, setSnap] = useState({ path, text });
  useEffect(() => {
    const sameFile = snap.path === path;
    if (sameFile && snap.text === text) return;
    const t = window.setTimeout(() => setSnap({ path, text }), sameFile ? delay : 0);
    return () => window.clearTimeout(t);
  }, [snap, path, text, delay]);
  return snap.text;
}

export interface ProofreadPanelProps {
  /** 待校对正文 */
  text: string;
  /** 当前文件路径，配合 openFile 使用 */
  path?: string | null;
  /** 定位到问题：打开文件并（尽可能）跳到某行 */
  openFile?: (path: string, line?: number) => void;
  /** 更精确的定位回调（有编辑器锚点时优先用这个） */
  onLocate?: (issue: ProofreadIssue) => void;
  /** 替换：把 suggestion 应用到正文 */
  onReplace?: (issue: ProofreadIssue, replacement: string) => void;
  /** 忽略某一次命中 */
  onIgnore?: (issue: ProofreadIssue) => void;
  /** 忽略「同规则 + 同词」的所有命中 */
  onIgnoreRule?: (rule: IgnoreRule) => void;
  /** 取消忽略（受控 ignored 时必需） */
  onUnignore?: (key: string) => void;
  /** 一次性应用所有可见问题 */
  onApplyAll?: (issues: ProofreadIssue[]) => void;
  /** 受控忽略键列表（issueKey）；不传则用面板内部状态 */
  ignored?: string[];
  /** 扩展词典，见 createDictionary / mergeDictionaries */
  dictionary?: ProofreadDictionary;
  /** 引擎选项（规则开关、忽略规则、跳读 frontmatter 等） */
  options?: ProofreadOptions;
  /** 外部已算好的问题（如跨篇章校对），传入后不再内部运行引擎 */
  issues?: ProofreadIssue[];
}

const KINDS: IssueKind[] = ["typo", "sensitive", "punctuation", "mixed", "dede", "synonym"];

const SEVERITY_COLOR: Record<Severity, string> = {
  error: "var(--danger)",
  warn: "var(--num)",
  info: "var(--fg-dim)",
};

const FLAG_LABEL: { key: keyof ProofreadRuleFlags; label: string; title: string }[] = [
  { key: "typo", label: "错词", title: "错别字 / 异形词" },
  { key: "sensitive", label: "敏感词", title: "敏感词与平台审核词" },
  { key: "cjkPunctuation", label: "中文标点", title: "半角标点、重复标点、省略号、括号、引号" },
  { key: "mixedPunctuation", label: "中英标点", title: "英文语境里的全角标点、括号内纯英文" },
  { key: "cjkLatinSpace", label: "中英空格", title: "中英文之间建议加空格（信息级）" },
  { key: "dede", label: "的地得", title: "启发式规则，默认关闭，可能误报" },
  { key: "synonym", label: "近义词", title: "同篇内异形词混用（好像/好象 等）" },
];

export function ProofreadPanel({
  text,
  path,
  openFile,
  onLocate,
  onReplace,
  onIgnore,
  onIgnoreRule,
  onUnignore,
  onApplyAll,
  ignored,
  dictionary,
  options,
  issues,
}: ProofreadPanelProps) {
  const [localIgnored, setLocalIgnored] = useState<string[]>([]);
  const [flagOverride, setFlagOverride] = useState<Partial<ProofreadRuleFlags>>({});
  const [kindFilter, setKindFilter] = useState<IssueKind | "all">("all");
  const [query, setQuery] = useState("");
  const [showIgnored, setShowIgnored] = useState(false);
  const [nonce, setNonce] = useState(0);

  const ignoredKeys = ignored ?? localIgnored;

  const mergedOptions = useMemo<ProofreadOptions>(() => {
    const flags: Partial<ProofreadRuleFlags> = {};
    for (const f of FLAG_LABEL) {
      const base = options?.[f.key] ?? DEFAULT_RULES[f.key];
      flags[f.key] = flagOverride[f.key] ?? base;
    }
    return { ...options, ...flags, dictionary, ignore: options?.ignore };
    // nonce 用于手动「重查」
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options, flagOverride, dictionary, nonce]);

  const settledText = useDebouncedText(text, path, 300);
  const pending = settledText !== text;

  const allIssues = useMemo(() => {
    if (issues) return issues;
    if (!settledText) return [];
    return proofread(settledText, mergedOptions);
  }, [issues, settledText, mergedOptions]);

  const summary = useMemo(() => summarizeIssues(allIssues), [allIssues]);

  const ignoredSet = useMemo(() => new Set(ignoredKeys), [ignoredKeys]);
  const visible = useMemo(() => {
    const q = query.trim();
    return allIssues.filter((i) => {
      if (ignoredSet.has(issueKey(i))) return false;
      if (kindFilter !== "all" && i.kind !== kindFilter) return false;
      if (q && !i.message.includes(q) && !i.text.includes(q)) return false;
      return true;
    });
  }, [allIssues, ignoredSet, kindFilter, query]);

  const ignoredList = useMemo(
    () => allIssues.filter((i) => ignoredSet.has(issueKey(i))),
    [allIssues, ignoredSet],
  );

  const addIgnore = (key: string) => {
    if (!ignored) setLocalIgnored((prev) => (prev.includes(key) ? prev : [...prev, key]));
  };

  const locate = (issue: ProofreadIssue) => {
    if (onLocate) onLocate(issue);
    else if (openFile && path) openFile(path, issue.line);
  };

  const toggleFlag = (key: keyof ProofreadRuleFlags) => {
    const base = options?.[key] ?? DEFAULT_RULES[key];
    setFlagOverride((prev) => {
      const current = prev[key] !== undefined ? prev[key] : base;
      return { ...prev, [key]: !current };
    });
  };

  return (
    <div className="side-panel">
      <div className="panel-head">
        校对
        <span className="pf-count">
          {pending ? "检查中… · " : ""}
          {visible.length} / {allIssues.length} 处
          {ignoredList.length > 0 ? ` · 已忽略 ${ignoredList.length}` : ""}
        </span>
      </div>

      <div className="panel-row panel-toggles">
        {FLAG_LABEL.map((f) => {
          const on = mergedOptions[f.key] ?? DEFAULT_RULES[f.key];
          return (
            <label key={f.key} title={f.title}>
              <input type="checkbox" checked={on} onChange={() => toggleFlag(f.key)} />
              {f.label}
            </label>
          );
        })}
      </div>

      <div className="panel-row">
        <input
          className="panel-input"
          placeholder="过滤问题…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="btn btn-xs" onClick={() => setNonce((n) => n + 1)} title="重新检查">
          ⟳
        </button>
      </div>

      <div className="tag-row">
        <button
          className={"tag-chip " + (kindFilter === "all" ? "on" : "")}
          onClick={() => setKindFilter("all")}
        >
          全部 {summary.total}
        </button>
        {KINDS.filter((k) => summary.byKind[k] > 0).map((k) => (
          <button
            key={k}
            className={"tag-chip " + (kindFilter === k ? "on" : "")}
            onClick={() => setKindFilter(kindFilter === k ? "all" : k)}
          >
            {KIND_LABEL[k]} {summary.byKind[k]}
          </button>
        ))}
      </div>

      <div className="panel-row">
        <button
          className="btn btn-xs"
          disabled={visible.length === 0}
          onClick={() => locate(visible[0])}
        >
          定位首个
        </button>
        <button
          className="btn btn-xs accent"
          disabled={!onApplyAll || visible.length === 0}
          title={onApplyAll ? "应用当前筛选出的全部建议" : "需要 onApplyAll 回调"}
          onClick={() => onApplyAll?.(visible)}
        >
          全部替换
        </button>
        <button
          className={"btn btn-xs " + (showIgnored ? "accent" : "")}
          disabled={ignoredList.length === 0}
          onClick={() => setShowIgnored(!showIgnored)}
        >
          已忽略 {ignoredList.length}
        </button>
      </div>

      <div className="panel-list">
        {!text && !issues && <div className="panel-empty">没有可校对的内容</div>}
        {text && allIssues.length === 0 && <div className="panel-empty">未发现问题 ✓</div>}
        {allIssues.length > 0 && visible.length === 0 && (
          <div className="panel-empty">当前筛选下没有问题</div>
        )}

        {visible.map((issue, idx) => (
          <IssueCard
            key={`${issue.from}:${issue.to}:${issue.ruleId}:${idx}`}
            issue={issue}
            text={text}
            onLocate={() => locate(issue)}
            onReplace={onReplace ? (rep) => onReplace(issue, rep) : undefined}
            onIgnore={() => {
              addIgnore(issueKey(issue));
              onIgnore?.(issue);
            }}
            onIgnoreRule={
              onIgnoreRule
                ? () => {
                    addIgnore(issueKey(issue));
                    onIgnoreRule({ ruleId: issue.ruleId, text: issue.text, kind: issue.kind });
                  }
                : undefined
            }
            canLocate={!!onLocate || !!openFile}
          />
        ))}

        {showIgnored &&
          ignoredList.map((issue, idx) => (
            <div key={`ig${issue.from}:${idx}`} className="hit pf-ignored">
              <div className="hit-loc">
                {KIND_LABEL[issue.kind]} · 第 {issue.line} 行
              </div>
              <div className="hit-text">{issue.message}</div>
              <div className="pf-actions">
                <button
                  className="btn btn-xs"
                  onClick={() => {
                    const key = issueKey(issue);
                    if (onUnignore) onUnignore(key);
                    else setLocalIgnored((prev) => prev.filter((k) => k !== key));
                  }}
                >
                  取消忽略
                </button>
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}

function IssueCard({
  issue,
  text,
  onLocate,
  onReplace,
  onIgnore,
  onIgnoreRule,
  canLocate,
}: {
  issue: ProofreadIssue;
  text: string;
  onLocate: () => void;
  onReplace?: (replacement: string) => void;
  onIgnore: () => void;
  onIgnoreRule?: () => void;
  canLocate: boolean;
}) {
  const loc = useMemo(() => issueLocation(text, issue), [text, issue]);
  const len = issue.to - issue.from;
  const from = Math.max(0, loc.column - 1);
  const lead = Math.max(0, from - 16);
  const tail = Math.min(loc.lineText.length, from + len + 16);
  const before = (lead > 0 ? "…" : "") + loc.lineText.slice(lead, from);
  const hit = loc.lineText.slice(from, from + len) || issue.text;
  const after = loc.lineText.slice(from + len, tail) + (tail < loc.lineText.length ? "…" : "");
  const replaceable = !!onReplace && !!issue.suggestion && issue.suggestion !== hit;

  return (
    <div className="hit pf-hit" onClick={canLocate ? onLocate : undefined}>
      <div className="hit-loc">
        <span className="pf-kind" style={{ color: SEVERITY_COLOR[issue.severity] }}>
          {KIND_LABEL[issue.kind]}
        </span>
        <span className="hit-words">
          第 {loc.line} 行:{loc.column}
        </span>
      </div>
      <div className="hit-text">{issue.message}</div>
      <div className="pf-quote">
        {before}
        <span className="pf-mark">{hit}</span>
        {after}
      </div>
      <div className="pf-actions" onClick={(e) => e.stopPropagation()}>
        <button
          className="btn btn-xs"
          disabled={!canLocate}
          title={canLocate ? "跳到正文位置" : "需要 openFile 或 onLocate 回调"}
          onClick={onLocate}
        >
          定位
        </button>
        <button
          className="btn btn-xs accent"
          disabled={!replaceable}
          title={
            issue.suggestion
              ? `替换为「${issue.suggestion}」`
              : "这条问题没有可自动替换的建议，请人工处理"
          }
          onClick={() => onReplace?.(issue.suggestion)}
        >
          {issue.suggestion ? `替换为「${issue.suggestion}」` : "无可替换建议"}
        </button>
        <button className="btn btn-xs" onClick={onIgnore}>
          忽略
        </button>
        {onIgnoreRule && (
          <button className="btn btn-xs" onClick={onIgnoreRule} title="同规则同词全部忽略">
            忽略同类
          </button>
        )}
      </div>
    </div>
  );
}

export default ProofreadPanel;
