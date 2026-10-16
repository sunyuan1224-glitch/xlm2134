import { useEffect, useState } from "react";
import { useStore } from "../store";
import { basename } from "../lib/chapter";
import { countWords, formatNumber, type CountMode } from "../lib/wordcount";

export function StatusBar({ cursor }: { cursor: { line: number; col: number; selLen: number } }) {
  const activePath = useStore((s) => s.activePath);
  const content = useStore((s) => (s.activePath ? s.contents[s.activePath] : undefined));
  const root = useStore((s) => s.root);
  const chapters = useStore((s) => s.chapters);
  const status = useStore((s) => s.status);
  const dirty = useStore((s) => s.dirty);
  const imePending = useStore((s) => s.imePending);
  // 缺省口径与左侧树 / 全书一致（每字符算 1，含标点）：两个数字挨着显示，口径不同会显得像 bug
  const [mode, setMode] = useState<CountMode>("char");

  // 组合中先不动：这会儿正文里是拼音字母，算出来的不是用户写的字（见下面的 useDeferredCount）
  const words = useDeferredCount(content, mode, imePending);
  /*
   * 全书字数 = 各章已算好的字数之和，与左侧文件树逐字一致（每个非空白字符算 1，
   * 汉字 / 英文 / 数字 / 标点都算，见 lib/wordcount）。
   *
   * 这里**不掺当前章的实时字数**。以前为了让全书跟着打字即时更新，当前章那份是拿上面
   * 这个 words 顶替的，于是它成了个混合数：words 随显示模式走（点成「字符」就按字符算），
   * 其他章却还是按字数的旧值 —— 全书写着「字」而数字在两种口径之间跳。而且切章节那一帧
   * words 还是上一章的值（滞后一帧），全书会先虚高再落回来。「今日已写」正是被这个数
   * 喂出来的，于是界面一翻，统计就凭空涨（见 store 的 feedBookWords）。
   *
   * 全书跟着文件树那份章节字数走（正文改动后 100ms 节流一收，连打时数字一路往上爬）。
   * 它是「快照之和」，不是每敲一键都动 —— 要每键都动的数字，看左边那个「本章」。
   */
  const total = chapters.reduce((sum, c) => sum + c.words, 0);

  const cycle = () => {
    const order: CountMode[] = ["char", "cjk-word", "paragraph"];
    setMode(order[(order.indexOf(mode) + 1) % order.length]);
  };

  const modeLabel = { char: "字符", "cjk-word": "中+词", paragraph: "段落" }[mode];

  return (
    <div className="statusbar">
      <div className="sb-left">
        <span className="sb-item">{root ? basename(root) : "未选择工作区"}</span>
        {activePath && <span className="sb-item sb-path">{activePath}</span>}
      </div>
      <div className="sb-right">
        <span className="sb-item">行 {cursor.line} 列 {cursor.col}</span>
        {cursor.selLen > 0 && (
          <span className="sb-item sb-sel">
            选区 {cursor.selLen}
          </span>
        )}
        <span className="sb-item sb-click" onClick={cycle} title="点击切换「本章」的统计模式">
          本章 {formatNumber(words)} · {modeLabel}
        </span>
        <span className="sb-item" title="全书字数：各章之和（每个非空白字符算 1，汉字 / 英文 / 数字 / 标点都算，与左侧文件树同口径）">
          全书 {formatNumber(total)}
        </span>
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
 *
 * hold = 输入法组合中：正文里现在装的是拼音（"nihao"），数字**冻在上一版**别动 ——
 * 否则「本章」会跟着拼音字母涨一下，上屏时又落回来，看着像在乱跳。
 */
function useDeferredCount(content: string | undefined, mode: CountMode, hold: boolean): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (hold) return;
    setV(countWords(content ?? "", mode));
  }, [content, mode, hold]);
  return v;
}
