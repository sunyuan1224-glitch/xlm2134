/*
 * 「快捷键」对话框：只列快捷键。
 * 「能做到什么 / 还差什么」这类说明在「关于 MyNovel」里，避免两处重复又不同步。
 */
import { ModalStage } from "./ModalStage";

interface Props {
  onClose: () => void;
}

/**
 * 快捷键的**唯一规格**：scripts/shortcut-ui-webkit.test.tsx 会 import 这份列表，
 * 逐条发真实按键验证「文案里写的键位真的有用例覆盖」，所以这里不能留没实现的假条目。
 */
export const SHORTCUTS: [string, string][] = [
  ["Ctrl+S", "保存当前文档"],
  ["Ctrl+P", "快速打开文件"],
  ["Ctrl+Z / Ctrl+Shift+Z", "撤销 / 重做"],
  ["Ctrl+F", "文档内查找"],
  ["Ctrl+H", "文档内替换"],
  ["Ctrl+Shift+F", "工作区搜索"],
  ["Ctrl+/", "源码模式 ⇄ 即时预览"],
  ["F8", "专注模式（只提亮当前段落）"],
  ["F9", "打字机模式（光标行居中）"],
  ["F11", "全屏"],
  ["Ctrl+Shift+L", "显示 / 折叠左侧栏"],
  ["Ctrl+Shift+B", "显示 / 收起小说工作台"],
  ["Ctrl+B / Ctrl+I / Ctrl+U", "加粗 / 斜体 / 下划线"],
  ["Alt+Shift+5", "删除线"],
  ["Ctrl+Shift+H", "高亮"],
  ["Ctrl+Shift+↑ / Ctrl+Shift+↓", "上标 / 下标"],
  ["Ctrl+1..6 / Ctrl+0", "标题等级：一级到六级 / 变回正文（同级再按一次取消）"],
  ["Ctrl+K", "超链接"],
  ["Ctrl+Shift+I", "插入本地图片（复制进 assets/）"],
  ["Ctrl+Shift+Q", "引用"],
  ["Ctrl+Shift+] / Ctrl+Shift+[", "无序 / 有序列表"],
  ["Alt+↑ / Alt+↓", "当前行上移 / 下移（按整段移动见「段落」菜单）"],
  ["Ctrl+Shift+D", "删除段落"],
  ["Ctrl+,", "字体与排版设置"],
];

export function HelpDialog({ onClose }: Props) {
  return (
    <div className="modal-mask" onClick={onClose}>
      <ModalStage>
      <div className="modal help-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">快捷键</div>
        <div className="help-body">
          <div className="help-keys">
            {SHORTCUTS.map(([k, v]) => (
              <div className="help-key-row" key={k + v}>
                <kbd>{k}</kbd>
                <span>{v}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn accent" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
      </ModalStage>
    </div>
  );
}

export default HelpDialog;
