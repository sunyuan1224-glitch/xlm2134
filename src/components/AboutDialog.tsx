/*
 * 「关于 MyNovel」对话框。
 *
 * 只回答三个问题：这是什么、能做什么、还差什么。清单是当前版本的实际情况——
 * 做不到的不写进「能做什么」，已知的短板照实写，不粉饰。
 * 快捷键在「快捷键」对话框里，开发 / 测试 / 逐条的问题清单在 README 里，
 * 这里不复述，免得两处不同步。
 */
import appIcon from "../assets/app-icon.png";
import { useStore } from "../store";
import { ModalStage } from "./ModalStage";

interface Props {
  onClose: () => void;
}

// 与 package.json 的 version 保持一致
const VERSION = "0.1.0";

const CAN_DO = [
  "粉白亮色、Typora 式写作：正文栏居中约 752px，光标所在块显示源码、其余块即时渲染，Ctrl+/ 随时切回源码模式",
  "Markdown 常用语法：粗体斜体下划线删除线、行内代码、链接、图片、引用、列表、代码块、分割线、YAML frontmatter、行内 HTML",
  "大纲即文档，而且跟着书走：每本书的纲要是 书/outline/ 下的普通 .md（总纲 / 卷纲 / 章节纲要），左侧「大纲」把它们按 书 → 卷 → 章 列成树，点一行就在正文区打开编辑",
  "卷与章节：新建章节、在光标处拆章、拖拽排序（把章拖到卷行的上/下边缘，就能夹在两卷之间）、新建书 / 新建卷；右键书文件夹可反转卷章显示顺序；删章删卷会连同对应纲要一起清理，确认框里列清单，不留孤儿",
  "三种写作视图（源码 Ctrl+/、专注 F8、打字机 F9）、沉浸写作，以及选中文字后浮出的格式工具栏",
  "快速打开（Ctrl+P）、文档内查找替换（Ctrl+F / Ctrl+H）、工作区搜索（Ctrl+Shift+F，支持正则与区分大小写）",
  "小说工作台：伏笔按状态推进与回收、时间线按时间或类型分组、设定带别名与关系、校对挑出当前章里的错别字与标点空格问题并可逐条替换或忽略",
  "导出 Word (.docx)、EPUB（当前文档或整本书按卷分组）与复制为 Markdown；插入本地图片会复制进工作区 assets/",
];

const SOLID = [
  "本地优先、全程离线：写作、预览、导出都不需要网络和账号，测试里连一次外部资源请求都不允许发生",
  "数据是你能直接看懂的东西：正文就是普通 .md，伏笔 / 时间线 / 设定是 .novel/ 下的人类可读 JSON，拷走目录就是完整备份。内容只存在你选择的工作区里，不收集也不上传",
  "写盘可靠：同目录临时文件独占创建 + 落盘 fsync + 原子替换，写失败会清理；路径逐段白名单校验，拒绝 .. 与绝对路径，指向工作区外的符号链接一律拒绝",
  "不谎报、不静默丢内容：只有字节真的写盘成功才报告「已导出」；渲染不了的复杂结构和读不到的图片不会被丢掉，而是保留源码或留下可见占位，并计入导出报告",
];

const LIMITS = [
  "复杂嵌套 Markdown 尚未完整兼容；不支持的复杂结构会保留 Markdown 源码显示，而不是硬渲染出错",
  "没有自动保存，也没接 Tauri 的关窗请求：关窗时那次异步保存（beforeunload）不保证写得完。离开前请 Ctrl+S",
  "只有一套粉白亮色主题，不能切深色（「主题」菜单目前只有一项）；中文输入法只在合成 composition 事件下验证过，Rime 候选窗定位与实际选词仍需人工验收",
  "这是一款小说写作工具：正文不提供标题层级、表格、公式、脚注等通用编辑器功能，章节名由文件名管理；导入 txt/md 分章、多文件批量查找替换、正则替换预览都没有入口",
  "纲要跟着书文件夹走：散在工作区根目录（或根级卷里）、不属于任何一本书的章没有纲要；EPUB 的封面与作者字段代码里已实现但界面还没有填入口，DOCX 只能导出当前文档",
  "性能：工作区搜索每次都会重扫磁盘、结果没有上限也不能取消，大目录下会慢；超长章节里移动光标仍要重排整篇的块装饰（每块的渲染结果已按文档缓存，不再逐块重跑渲染）",
  "DOCX / EPUB 未在真实 Word、WPS 或专业阅读器中人工验收（本机没有 Office / LibreOffice），结构由容器部件与 XML 解析校验保证",
  "图床、云同步、分享、发布到博客等在线能力：按要求不实现",
];

const TECH =
  "Tauri 2 · React 19 · TypeScript · Rust · CodeMirror 6。Markdown 解析用 @lezer/markdown，" +
  "即时预览与导出共用同一套渲染器，做到所见即所得。当前分发形态是 Arch Linux 上的单文件 AppImage（另有 deb / rpm）。";

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
          <h4>用着放心的地方</h4>
          <ul className="help-list">
            {SOLID.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
          <h4>已知限制</h4>
          <ul className="help-list help-todo">
            {LIMITS.map((t) => (
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
