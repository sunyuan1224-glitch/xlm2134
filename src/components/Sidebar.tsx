/*
 * Typora 式左侧栏：文件树 / 大纲 / 搜索 三个标签页。
 * 面板样式：上下左右 12px 留白、14px 圆角、浮动阴影。
 * 点标签只切换、不折叠：反复点当前标签（含双击）都不会把侧栏收起来。
 * 收起侧栏请用视图菜单的「左侧栏」或 Ctrl+Shift+L；右侧有宽度拖拽手柄。
 */
import { memo } from "react";
import { useStore } from "../store";
import { FileTree } from "./FileTree";
import { OutlinePanel } from "./OutlinePanel";
import { SearchPanel } from "./SidePanel";

/*
 * 没有 props，数据全来自 store 的细粒度选择器；包 memo 让 App 重渲染时这一栏不跟着重建。
 * 拖宽度时 App 每帧都在更新 leftWidth，但宽度是加在外层 .pane-left 上的，与这里无关。
 */
export const Sidebar = memo(function Sidebar() {
  const tab = useStore((s) => s.sidebarTab);
  const setTab = useStore((s) => s.openSidebarTab);
  const refresh = useStore((s) => s.refresh);
  const activePath = useStore((s) => s.activePath);

  return (
    <aside
      className="sidebar-capsule"
      /* 兜底：侧栏里任何位置都不弹 WebView 自带的英文右键菜单（文件树自己会开菜单） */
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* 顶部：文件 / 大纲 两个文字标签，搜索收成最右侧的正方形放大镜按钮 */}
      <div className="sidebar-tabs">
        <button
          type="button"
          className={"sidebar-tab " + (tab === "files" ? "on" : "")}
          onClick={() => setTab("files")}
          title="文件树"
        >
          文件
        </button>
        <button
          type="button"
          className={"sidebar-tab " + (tab === "outline" ? "on" : "")}
          onClick={() => setTab("outline")}
          title="大纲（每本书的 总纲 / 卷纲 / 章节纲要，点击在正文区编辑）"
        >
          大纲
        </button>
        <button
          type="button"
          className={"sidebar-search-btn " + (tab === "search" ? "on" : "")}
          onClick={() => setTab("search")}
          title="工作区搜索 (Ctrl+Shift+F)"
          aria-label="工作区搜索"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <circle
              cx="7"
              cy="7"
              r="4.6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
            />
            <line
              x1="10.4"
              y1="10.4"
              x2="14"
              y2="14"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      {/* 内容区域 */}
      <div className="sidebar-body">
        {tab === "files" && (
          <>
            <div className="sidebar-subhead">
              <span>章节与文件</span>
              <button className="mini" onClick={() => void refresh()} title="刷新工作区">
                ⟳
              </button>
            </div>
            <FileTree />
          </>
        )}
        {tab === "outline" && <OutlinePanel />}
        {tab === "search" && <SearchPanel />}
      </div>

      {/* 底栏简短统计 */}
      <div className="sidebar-foot">
        <span className="sidebar-foot-info">
          {activePath ? activePath.split("/").pop() : "未选择文件"}
        </span>
      </div>
    </aside>
  );
});

export default Sidebar;
