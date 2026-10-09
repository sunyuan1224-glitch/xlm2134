import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

export const isDesktop = (): boolean => isTauri();

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
  pickDirectory: () => invoke<string | null>("pick_directory"),
  scan: (root: string) => invoke<Workspace>("scan_workspace", { root }),
  readFile: (root: string, path: string) => invoke<FileContent | null>("read_file", { root, path }),
  writeFile: (root: string, path: string, content: string) =>
    invoke<void>("write_file", { root, path, content }),
  createFile: (root: string, path: string, content: string) =>
    invoke<void>("create_file", { root, path, content }),
  deleteEntry: (root: string, path: string) => invoke<void>("delete_entry", { root, path }),
  renameEntry: (root: string, path: string, newPath: string) =>
    invoke<void>("rename_entry", { root, path, newPath }),
  createDir: (root: string, path: string) => invoke<void>("create_dir", { root, path }),
  readSidecar: (root: string, work: string, name: string) =>
    invoke<string | null>("read_sidecar", { root, work, name }),
  writeSidecar: (root: string, work: string, name: string, data: string) =>
    invoke<void>("write_sidecar", { root, work, name, data }),
  searchText: (root: string, query: string, regex: boolean, caseSensitive: boolean) =>
    invoke<SearchHit[]>("search_text", { root, query, regex, caseSensitive }),
  splitAtCursor: (root: string, path: string, offset: number, suffix: string) =>
    invoke<SplitResult>("split_at_cursor", { root, path, offset, suffix }),
  configDir: () => invoke<string>("app_config_dir"),
  readImageDataUrl: (root: string, path: string) =>
    invoke<string | null>("read_image_data_url", { root, path }),
  copyAsset: (root: string, srcAbs: string, destRel: string) =>
    invoke<string>("copy_asset", { root, srcAbs, destRel }),
  /** 把 base64 编码的二进制写进绝对路径（DOCX / EPUB 导出用；Rust 侧会拒绝覆盖 .md/.txt 手稿） */
  writeBinaryAbs: (path: string, dataBase64: string) =>
    invoke<void>("write_binary_abs", { path, dataBase64 }),
  pickImageFiles: async (): Promise<string[] | null> => {
    const res = await open({
      title: "选择图片",
      multiple: true,
      directory: false,
      filters: [
        {
          name: "图片",
          extensions: ["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp"],
        },
      ],
    });
    if (!res) return null;
    return Array.isArray(res) ? res : [res];
  },
  saveExportFile: async (
    defaultName: string,
    filters: { name: string; extensions: string[] }[]
  ): Promise<string | null> => {
    return save({
      defaultPath: defaultName,
      filters,
    });
  },
};
