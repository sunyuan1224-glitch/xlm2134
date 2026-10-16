/*
 * 桌面后端的唯一出口。
 *
 * 原来这里是 Tauri 的 invoke；现在换成 Electron 预加载桥（electron/preload.js 注入的
 * `window.mynovel`）。**前端其它文件一行都不用改**——当初把后端调用都收在这个文件里，
 * 换引擎的代价就只有这一份。命令名与参数名保持和 Rust 侧一致，方便两边对着看。
 *
 * 没有桥（浏览器预览、或 scripts/ 下的 WebKit 用例）= isDesktop() 为 false，
 * 上层（store.init 等）会自动跳过，不会因为拿不到后端而炸。
 */

interface MyNovelBridge {
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  onFullscreenChange: (cb: (value: boolean) => void) => () => void;
}

function bridge(): MyNovelBridge | null {
  return (globalThis as unknown as { mynovel?: MyNovelBridge }).mynovel ?? null;
}

/** 是否跑在桌面壳里（有原生后端可用） */
export const isDesktop = (): boolean => bridge() !== null;

/** 订阅全屏状态变化；返回退订函数。没有桥时给一个空退订 */
export function onFullscreenChange(cb: (value: boolean) => void): () => void {
  const b = bridge();
  if (!b) return () => {};
  return b.onFullscreenChange(cb);
}

async function isFullscreen(): Promise<boolean> {
  const b = bridge();
  if (!b) return false;
  return b.invoke<boolean>("is_fullscreen");
}

async function setFullscreen(value: boolean): Promise<void> {
  const b = bridge();
  if (!b) return;
  await b.invoke("set_fullscreen", { value });
}

function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const b = bridge();
  if (!b) {
    return Promise.reject(new Error("没有桌面后端（浏览器预览或测试环境）"));
  }
  return b.invoke<T>(cmd, args);
}

export interface FileNode {
  path: string;
  name: string;
  is_dir: boolean;
  children: FileNode[];
}

export interface Workspace {
  root: string;
  tree: FileNode[];
  files: string[];
}

export interface FileContent {
  path: string;
  content: string;
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export interface SplitResult {
  path: string;
  firstPath: string;
  secondPath: string;
  firstTitle: string;
  secondTitle: string;
}

export const api = {
  pickDirectory: () => call<string | null>("pick_directory"),
  /** 本机已安装的字体族（设置面板的字体下拉用）；取不到时后端返回空表 */
  listFonts: (): Promise<string[]> => call<string[]>("list_fonts"),
  scan: (root: string) => call<Workspace>("scan_workspace", { root }),
  readFile: (root: string, path: string) => call<FileContent | null>("read_file", { root, path }),
  writeFile: (root: string, path: string, content: string) =>
    call<void>("write_file", { root, path, content }),
  createFile: (root: string, path: string, content: string) =>
    call<void>("create_file", { root, path, content }),
  deleteEntry: (root: string, path: string) => call<void>("delete_entry", { root, path }),
  renameEntry: (root: string, path: string, newPath: string) =>
    call<void>("rename_entry", { root, path, newPath }),
  createDir: (root: string, path: string) => call<void>("create_dir", { root, path }),
  readSidecar: (root: string, work: string, name: string) =>
    call<string | null>("read_sidecar", { root, work, name }),
  writeSidecar: (root: string, work: string, name: string, data: string) =>
    call<void>("write_sidecar", { root, work, name, data }),
  searchText: (root: string, query: string, regex: boolean, caseSensitive: boolean) =>
    call<SearchHit[]>("search_text", { root, query, regex, caseSensitive }),
  splitAtCursor: (root: string, path: string, offset: number, suffix: string) =>
    call<SplitResult>("split_at_cursor", { root, path, offset, suffix }),
  configDir: () => call<string>("app_config_dir"),
  readImageDataUrl: (root: string, path: string) =>
    call<string | null>("read_image_data_url", { root, path }),
  copyAsset: (root: string, srcAbs: string, destRel: string) =>
    call<string>("copy_asset", { root, srcAbs, destRel }),
  /** 把 base64 编码的二进制写进绝对路径（DOCX / EPUB 导出用；后端会拒绝覆盖 .md/.txt 手稿） */
  writeBinaryAbs: (path: string, dataBase64: string) =>
    call<void>("write_binary_abs", { path, dataBase64 }),
  isFullscreen,
  setFullscreen,
  pickImageFiles: (): Promise<string[] | null> => call<string[] | null>("pick_image_files"),
  saveExportFile: (
    defaultName: string,
    filters: { name: string; extensions: string[] }[],
  ): Promise<string | null> => call<string | null>("save_export_file", { defaultName, filters }),
  openUrl: (url: string) => call<null>("open_url", { url }),
};
