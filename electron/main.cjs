/*
 * Electron 主进程：窗口 + IPC + 原生对话框。
 *
 * 换掉 WebKitGTK 的原因写在 README 的「渲染帧率」一节：同一台机器上 WebKitGTK 只给
 * 31fps，而 Chromium 能跑到 180fps（实测）。这里只负责「壳」和 IO，
 * 所有业务代码（前端 1.5 万行 + electron/vault.js）都原样保留。
 */
"use strict";

const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const vault = require("./vault.cjs");

const DEV_URL = process.env.MYNOVEL_DEV_URL || "";
const isDev = DEV_URL !== "";

/** 配置目录与 Tauri 侧保持一致（那是 identifier，换成 appName 会丢用户已有设置） */
const CONFIG_DIR = path.join(app.getPath("appData"), "com.local.mynovel");

let mainWindow = null;

/* -------------------------------------------------------------- 本机字体族 */

/*
 * 设置面板的字体下拉要用「本机已安装字体」。
 * Linux 有 fontconfig，一条 fc-list 就够了；Windows 没有 fc-list，
 * 改用 PowerShell 问 GDI+ 的字体表——比读注册表准，注册表里的键名是
 * "Arial Bold" 这种带字重的名字，不是族名。
 * 两条路都拿不到就返回空表：FontPicker 会自动只显示预设，不报错也不挡设置面板。
 */
const FONT_EXEC_OPTS = { maxBuffer: 32 * 1024 * 1024, windowsHide: true, timeout: 20000 };

function uniqueSorted(names) {
  const set = new Set();
  for (const n of names) {
    const name = String(n).trim();
    if (name) set.add(name);
  }
  return [...set].sort();
}

/** fc-list 的输出是「族名,别名1,别名2」一行一个字体，只取族名 */
function parseFcList(stdout) {
  return uniqueSorted(String(stdout).split("\n").map((line) => line.split(",")[0] ?? ""));
}

/** 先强制 stdout 走 UTF-8，否则中文族名会被控制台代码页啃成乱码 */
const WIN_FONT_SCRIPT = [
  "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);",
  "Add-Type -AssemblyName System.Drawing;",
  "(New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }",
].join(" ");

function listFontsWindows() {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", WIN_FONT_SCRIPT],
      { ...FONT_EXEC_OPTS, encoding: "utf8" },
      (err, stdout) => resolve(err ? [] : uniqueSorted(String(stdout).split(/\r?\n/))),
    );
  });
}

function listFontsLinux() {
  return new Promise((resolve) => {
    execFile("fc-list", ["--format", "%{family}\n"], FONT_EXEC_OPTS, (err, stdout) =>
      resolve(err ? [] : parseFcList(stdout)),
    );
  });
}

function listFonts() {
  return process.platform === "win32" ? listFontsWindows() : listFontsLinux();
}

/* ------------------------------------------------------------------ 命令表 */

const commands = {
  async pick_directory() {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: "选择小说工作区目录",
      properties: ["openDirectory", "createDirectory"],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0];
  },

  async pick_image_files() {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: "选择图片",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp"] },
      ],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths;
  },

  async save_export_file({ defaultName, filters }) {
    const res = await dialog.showSaveDialog(mainWindow, {
      defaultPath: defaultName,
      filters: filters ?? [],
    });
    if (res.canceled || !res.filePath) return null;
    return res.filePath;
  },

  scan_workspace: ({ root }) => vault.scanWorkspace(root),
  read_file: ({ root, path: p }) => vault.readFile(root, p),
  write_file: ({ root, path: p, content }) => vault.writeFile(root, p, content),
  create_file: ({ root, path: p, content }) => vault.createFile(root, p, content),
  delete_entry: ({ root, path: p }) => vault.deleteEntry(root, p),
  rename_entry: ({ root, path: p, newPath }) => vault.renameEntry(root, p, newPath),
  create_dir: ({ root, path: p }) => vault.createDir(root, p),
  read_sidecar: ({ root, work, name }) => vault.readSidecar(root, work, name),
  write_sidecar: ({ root, work, name, data }) => vault.writeSidecar(root, work, name, data),
  search_text: ({ root, query, regex, caseSensitive }) =>
    vault.searchText(root, query, regex, caseSensitive),
  split_at_cursor: ({ root, path: p, offset, suffix }) =>
    vault.splitAtCursor(root, p, offset, suffix),
  read_image_data_url: ({ root, path: p }) => vault.readImageDataUrl(root, p),
  copy_asset: ({ root, srcAbs, destRel }) => vault.copyAsset(root, srcAbs, destRel),
  write_binary_abs: ({ path: p, dataBase64 }) => vault.writeBinaryAbs(p, dataBase64),

  async app_config_dir() {
    await require("node:fs/promises").mkdir(CONFIG_DIR, { recursive: true });
    return CONFIG_DIR;
  },

  /** 本机字体族：取不到就返回空表，设置里自动退回「只显示预设」 */
  list_fonts: () => listFonts(),

  open_url: async ({ url }) => {
    await shell.openExternal(url);
  },

  is_fullscreen: () => (mainWindow ? mainWindow.isFullScreen() : false),
  set_fullscreen: ({ value }) => {
    if (mainWindow) mainWindow.setFullScreen(!!value);
    return null;
  },
};

ipcMain.handle("mynovel:invoke", async (_event, cmd, args) => {
  const fn = commands[cmd];
  if (!fn) throw new Error(`未知命令: ${cmd}`);
  return fn(args ?? {});
});

/* ------------------------------------------------------------------ 窗口 */

function createWindow() {
  mainWindow = new BrowserWindow({
    title: "MyNovel",
    width: 1280,
    height: 840,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: "#fffafc",
    autoHideMenuBar: true,
    // Windows 认 .ico（标题栏 + 任务栏），Linux 认 .png；macOS 忽略这个字段
    icon: path.join(__dirname, "..", "build", process.platform === "win32" ? "icon.ico" : "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 拼写检查会在编辑正文时给中文加下划线，关掉
      spellcheck: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);

  // 全屏状态变化要告诉前端（沉浸写作的按钮状态跟着走）
  const sendFullscreen = () =>
    mainWindow.webContents.send("mynovel:fullscreen", mainWindow.isFullScreen());
  mainWindow.on("enter-full-screen", sendFullscreen);
  mainWindow.on("leave-full-screen", sendFullscreen);

  if (isDev) {
    mainWindow.loadURL(DEV_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  // 外部链接交给系统浏览器，绝不在应用窗口里导航出去
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const current = mainWindow.webContents.getURL();
    if (url !== current) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// Chromium 的沙箱在 AppImage 里偶尔会因为 setuid helper 缺失而起不来，
// 这两个开关是 Electron 打包 Linux 发行版的常规配置（Windows 上加了没意义）。
if (process.platform === "linux") {
  app.commandLine.appendSwitch("enable-features", "WaylandWindowDecorations");
}
if (process.env.MYNOVEL_DISABLE_SANDBOX === "1") {
  app.commandLine.appendSwitch("no-sandbox");
}

// Windows 要把进程归到同一个 AppUserModelID 上，任务栏图标与通知才不会分裂成两个
if (process.platform === "win32") app.setAppUserModelId("com.local.mynovel");

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// 忽略 --inspect 之外的无用环境提示
void os;
