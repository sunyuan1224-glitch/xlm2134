import { memo } from "react";
import { useStore } from "../store";

/*
 * 没有 props，数据全来自 store 的细粒度选择器；包 memo 让 App 重渲染时这一栏不跟着重建。
 * 注意它自己订阅了 openTabs / dirty——这两个切片一变，memo 也拦不住，也不需要拦。
 */
export const TabBar = memo(function TabBar() {
  const openTabs = useStore((s) => s.openTabs);
  const activePath = useStore((s) => s.activePath);
  const setActive = useStore((s) => s.setActive);
  const closeTab = useStore((s) => s.closeTab);
  const dirty = useStore((s) => s.dirty);
  const saveFile = useStore((s) => s.saveFile);
  const saveAll = useStore((s) => s.saveAll);

  if (openTabs.length === 0) return null;

  /**
   * 保存是「当前文档」的动作，所以从顶栏移到这里：只在当前文件 dirty 时
   * 出现，视觉上是标签栏右侧的 action，不与顶栏全局功能并列。
   * 若同时还有其他未保存的标签，则一次全部保存（等价于原顶栏「保存」）。
   */
  const isCurrentDirty = !!activePath && dirty.has(activePath);
  const otherDirty = dirty.size - (isCurrentDirty ? 1 : 0);
  const savePath = activePath;

  const handleSave = () => {
    if (savePath && otherDirty <= 0) void saveFile(savePath);
    else void saveAll();
  };

  return (
    <div className="tabbar">
      <div className="tabbar-list">
        {openTabs.map((p) => (
          <div
            key={p}
            className={"tab " + (activePath === p ? "active" : "")}
            onClick={() => setActive(p)}
            title={p}
          >
            <span className="tab-name">{p.split("/").pop()?.replace(/\.md$/, "")}</span>
            {dirty.has(p) && <span className="tab-dot" />}
            <span
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(p);
              }}
            >
              ×
            </span>
          </div>
        ))}
      </div>
      {isCurrentDirty && (
        <div className="tabbar-actions">
          <button
            type="button"
            className="tab-save-btn"
            onClick={handleSave}
            title={
              otherDirty > 0 ? "保存当前文档，并写回其他未保存标签 (Ctrl+S)" : "保存当前文档 (Ctrl+S)"
            }
          >
            保存
          </button>
        </div>
      )}
    </div>
  );
});
