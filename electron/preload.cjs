/*
 * 预加载桥。renderer 里**没有** Node 权限（contextIsolation: true、nodeIntegration: false），
 * 所有后端能力都得从这一个口子过——这也是当初把调用都收在 src/api.ts 的回报：
 * 前端只认这些方法名，换掉 Tauri 只需要改那一个文件。
 *
 * 刻意不把 ipcRenderer 整体暴露出去：只放一个固定命令名的 invoke，
 * 免得页面里任何脚本都能拿它去发任意 IPC。
 */
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mynovel", {
  /** 与 Tauri 的 invoke 同名同形：api.ts 里几乎是一对一替换 */
  invoke: (cmd, args) => ipcRenderer.invoke("mynovel:invoke", cmd, args),

  /** 全屏状态变化（沉浸写作要用） */
  onFullscreenChange: (cb) => {
    const handler = (_e, value) => cb(value);
    ipcRenderer.on("mynovel:fullscreen", handler);
    return () => ipcRenderer.removeListener("mynovel:fullscreen", handler);
  },
});
