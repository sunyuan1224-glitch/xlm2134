/*
 * 「关于 MyNovel」对话框：只讲这是什么、能做什么。
 * 快捷键在「快捷键」对话框里，开发与测试在 README 里，这里不复述，免得两处不同步。
 */
import appIcon from "../assets/app-icon.png";
import { useStore } from "../store";
import { ModalStage } from "./ModalStage";

interface Props {
  onClose: () => void;
}

// 与 package.json 的 version 保持一致
const VERSION = "0.3.2";

const CAN_DO = [
  "粉白亮色、Typora 式写作：正文栏居中约 752px，光标所在块显示源码、其余块即时渲染，Ctrl+/ 随时切回源码模式",
  "Markdown 常用语法：粗体斜体下划线删除线、行内代码、链接、图片、引用、列表、代码块、分割线、YAML frontmatter、行内 HTML",
  "大纲即文档，而且跟着书走：每本书的纲要是 书/outline/ 下的普通 .md（总纲 / 卷纲 / 章节纲要），左侧「大纲」把它们按 书 → 卷 → 章 列成树，点一行就在正文区打开编辑",
  "卷与章节：新建章节、在光标处拆章、拖拽排序（把章拖到卷行的上/下边缘，就能夹在两卷之间）、新建书 / 新建卷；右键书文件夹可反转卷章显示顺序；删章删卷会连同对应纲要一起清理，确认框里列清单",
  "三种写作视图（源码 Ctrl+/、专注 F8、打字机 F9）、沉浸写作（全屏、直接调字号、Esc 退出），以及选中文字后浮出的格式工具栏",
  "快速打开（Ctrl+P）、文档内查找替换（Ctrl+F / Ctrl+H）、工作区搜索（Ctrl+Shift+F，支持正则与区分大小写）",
  "导出 Word (.docx)、EPUB（当前文档或整本书按卷分组）与复制为 Markdown；插入本地图片会复制进工作区 assets/",
  "稿纸左侧的伴读人物，贴着左侧栏站、跟着侧栏收起与拖宽一起动；窄窗口下缩到左下角，在「关于」里点应用图标随时开关",
  "欧金金：点一下压扁并叫一声、冒气泡告诉你「今日已写」和「平均速度」，按住可以拖着走（吸附贴边、不会拖丢，窗口变大变小都跟着角落走），悬停或右键唤出菜单，可调尺寸 / 音量 / 音效开关，也能整个隐藏（「视图 → 挂件 → 欧金金」）",
];

const TECH =
  "Electron · React 19 · TypeScript · CodeMirror 6。Markdown 解析用 @lezer/markdown，" +
  "即时预览与导出共用同一套渲染器，做到所见即所得。" +
  "（2026-10 从 Tauri + WebKitGTK 迁到 Electron：那套在这台机器只给 31fps，换 Chromium 后实测 180fps。）" +
  "当前分发形态是 Arch Linux 上的单文件 AppImage。";

export function AboutDialog({ onClose }: Props) {
  const companionVisible = useStore((s) => s.companionVisible);
  const toggleCompanion = useStore((s) => s.toggleCompanion);
  return (
    <div className="modal-mask" onClick={onClose}>
      <ModalStage>
      <div className="modal help-modal about-modal" onClick={(e) => e.stopPropagation()}>
        <div className="about-head">
          <button
            type="button"
            className={"about-icon-btn" + (companionVisible ? " is-on" : "")}
            aria-pressed={companionVisible}
            onClick={toggleCompanion}
          >
            <img className="about-icon" src={appIcon} alt="" />
          </button>
          <div className="about-head-text">
            <div className="about-name">MyNovel</div>
            <div className="about-version">版本 {VERSION}</div>
            <div className="about-tagline">本地优先的小说写作工具，数据即 Markdown 文件</div>
          </div>
        </div>
        <div className="help-body">
          <h4>能做什么</h4>
          <ul className="help-list">
            {CAN_DO.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
          <h4>技术</h4>
          <p className="about-note">{TECH}</p>
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

export default AboutDialog;
