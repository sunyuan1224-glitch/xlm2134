import { useEffect, useState } from "react";
import { useStore } from "../store";
import { countWords, formatNumber, type CountMode } from "../lib/wordcount";
import { noteTotalWords } from "../lib/writingStats";

export function StatusBar({ cursor }: { cursor: { line: number; col: number; selLen: number } }) {
  const activePath = useStore((s) => s.activePath);
  const content = useStore((s) => (s.activePath ? s.contents[s.activePath] : undefined));
  const root = useStore((s) => s.root);
  const chapters = useStore((s) => s.chapters);
  const status = useStore((s) => s.status);
  const dirty = useStore((s) => s.dirty);
  const [mode, setMode] = useState<CountMode>("cjk-word");

  const words = useDeferredCount(content, mode);
  /*
   * 全书字数 = 其他章已统计好的旧值 + **当前章的实时字数**。
   *
   * 当前章那部分直接复用上面为「本章」算出来的 words，不额外扫一遍文稿，所以
   * 全书会跟着打字即时更新（滞后一帧，与本章同步），代价为零。
   * 其他章没法实时（内容根本没加载进来），仍用打开 / 保存时记下的值。
   */
  const total = chapters.reduce(
    (sum, c) => sum + (activePath && c.path === activePath ? words : c.words),
    0,
  );

  /*
   * 把全书字数喂给写作统计（挂件气泡里的「今日已写」就是它的净增累加）。
   * 这里是最省事的接缝：全书字数本来就在这一行算好了，统计那边不必再扫一遍文稿。
   */
  useEffect(() => {
    noteTotalWords(total, root);
  }, [total, root]);

  const cycle = () => {
    const order: CountMode[] = ["cjk-word", "char", "paragraph"];
    setMode(order[(order.indexOf(mode) + 1) % order.length]);
  };

  const modeLabel = { "cjk-word": "中+词", char: "字符", paragraph: "段落" }[mode];

  return (
    <div className="statusbar">
      <div className="sb-left">
        <span className="sb-item">{root ? root.split("/").pop() : "未选择工作区"}</span>
        {activePath && <span className="sb-item sb-path">{activePath}</span>}
      </div>
      <div className="sb-right">
        <span className="sb-item">行 {cursor.line} 列 {cursor.col}</span>
        {cursor.selLen > 0 && (
          <span className="sb-item sb-sel">
            选区 {cursor.selLen}
          </span>
        )}
        <span className="sb-item sb-click" onClick={cycle} title="点击切换统计模式">
          本章 {formatNumber(words)} · {modeLabel}
        </span>
        <span className="sb-item">全书 {formatNumber(total)}</span>
        <span className={"sb-item " + (dirty.size > 0 ? "sb-dirty" : "")}>
          {dirty.size > 0 ? "● " + dirty.size + " 未保存" : status}
        </span>
      </div>
    </div>
  );
}

/*
 * 本章字数。
 *
 * 故意用 effect 而不是 useMemo：countWords 要扫整章（几万字），放在渲染里就挡在按键的那一帧上；
 * 放 effect 里是「先按旧字数把界面画出来，回到空闲再算、算完再画一次」，
 * 打字的手感不受章节长度影响，代价只是字数慢一帧。别改成 useMemo。
 */
function useDeferredCount(content: string | undefined, mode: CountMode): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    setV(countWords(content ?? "", mode));
  }, [content, mode]);
  return v;
}
