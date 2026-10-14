mod vault;
mod fonts;

use std::path::Path;
use tauri::Manager;
use vault::{
    copy_asset_impl, create_dir_impl, create_file_impl, delete_entry_impl, file_exists_impl,
    read_file_impl, read_image_data_url_impl, read_sidecar_impl, rename_entry_impl, scan_impl,
    search_impl, write_file_impl, write_sidecar_impl, write_binary_abs_impl, FileContent,
    SearchHit, SplitResult, Workspace,
};

#[tauri::command]
async fn pick_directory(app: tauri::AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        app.dialog()
            .file()
            .set_title("选择小说工作区目录")
            .blocking_pick_folder()
            .and_then(|p| p.into_path().ok())
            .and_then(|p| p.to_str().map(|s| s.to_string()))
    })
    .await
    .map_err(|e| e.to_string())
}

/// 扫描工作区：返回所有 md 文件与目录结构
#[tauri::command]
fn scan_workspace(root: String) -> Result<Workspace, String> {
    scan_impl(Path::new(&root)).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_file(root: String, path: String) -> Result<Option<FileContent>, String> {
    read_file_impl(Path::new(&root), &path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file(root: String, path: String, content: String) -> Result<(), String> {
    write_file_impl(Path::new(&root), &path, &content).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_file(root: String, path: String, content: String) -> Result<(), String> {
    create_file_impl(Path::new(&root), &path, &content).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_entry(root: String, path: String) -> Result<(), String> {
    delete_entry_impl(Path::new(&root), &path).map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_entry(root: String, path: String, new_path: String) -> Result<(), String> {
    rename_entry_impl(Path::new(&root), &path, &new_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_dir(root: String, path: String) -> Result<(), String> {
    create_dir_impl(Path::new(&root), &path).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_sidecar(root: String, work: String, name: String) -> Result<Option<String>, String> {
    read_sidecar_impl(Path::new(&root), &work, &name).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_sidecar(root: String, work: String, name: String, data: String) -> Result<(), String> {
    write_sidecar_impl(Path::new(&root), &work, &name, &data).map_err(|e| e.to_string())
}

#[tauri::command]
fn search_text(
    root: String,
    query: String,
    regex: bool,
    case_sensitive: bool,
) -> Result<Vec<SearchHit>, String> {
    let re = build_regex(&query, regex, case_sensitive).map_err(|e| e.to_string())?;
    Ok(search_impl(Path::new(&root), &re))
}

fn build_regex(
    pattern: &str,
    is_regex: bool,
    case_sensitive: bool,
) -> Result<regex::Regex, regex::Error> {
    let pat = if is_regex {
        pattern.to_string()
    } else {
        regex::escape(pattern)
    };
    let mut b = regex::RegexBuilder::new(&pat);
    if !case_sensitive {
        b.case_insensitive(true);
    }
    b.build()
}

/// 光标处拆分章节
#[tauri::command]
fn split_at_cursor(
    root: String,
    path: String,
    offset: usize,
    suffix: String,
) -> Result<SplitResult, String> {
    let rootp = Path::new(&root);
    let fc = read_file_impl(rootp, &path)?.ok_or("文件不存在")?;
    let byte_offset = utf16_to_byte_offset(&fc.content, offset).ok_or("光标位置无效")?;
    if byte_offset == 0 || byte_offset >= fc.content.len() {
        return Err("光标位置无效".into());
    }
    let first = fc.content[..byte_offset].to_string();
    let second = fc.content[byte_offset..].to_string();

    let (dir, name) = split_path(&path);
    let stem = name.trim_end_matches(".md").to_string();
    let sfx = if suffix.is_empty() { "下" } else { suffix.as_str() };
    let first_path = join(&dir, &format!("{stem}-上.md"));
    let second_path = join(&dir, &format!("{stem}-{sfx}.md"));
    // 先查再写：拆出来的两个文件都已存在时直接拒绝，避免无声覆盖既有章节。
    // （写在删除原文件之前，所以失败时原文完好。）
    for p in [&first_path, &second_path] {
        if p != &path && file_exists_impl(rootp, p)? {
            return Err(format!("拆分目标已存在，未拆分: {p}"));
        }
    }
    write_file_impl(rootp, &first_path, &(first.trim_end().to_string() + "\n"))?;
    write_file_impl(rootp, &second_path, &("\n".to_string() + second.trim_start()))?;
    delete_entry_impl(rootp, &path)?;
    Ok(SplitResult {
        path: path.clone(),
        first_path,
        second_path,
        first_title: format!("{stem}-上"),
        second_title: format!("{stem}-{sfx}"),
    })
}

fn split_path(path: &str) -> (String, String) {
    match path.rfind('/') {
        Some(i) => (path[..i].to_string(), path[i + 1..].to_string()),
        None => (String::new(), path.to_string()),
    }
}

fn utf16_to_byte_offset(text: &str, wanted: usize) -> Option<usize> {
    if wanted == 0 { return Some(0); }
    let mut units = 0usize;
    for (byte, ch) in text.char_indices() {
        if units == wanted { return Some(byte); }
        units += ch.len_utf16();
        if units == wanted { return Some(byte + ch.len_utf8()); }
        if units > wanted { return None; }
    }
    if units == wanted { Some(text.len()) } else { None }
}

fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_string()
    } else {
        format!("{dir}/{name}")
    }
}

#[tauri::command]
fn app_config_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    dir.to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "路径不可用".into())
}

/// 读工作区内的图片并编码成 data URL（编辑器 live preview 内联显示用）。
/// 非图片或不存在的文件返回 null。
#[tauri::command]
fn read_image_data_url(root: String, path: String) -> Result<Option<String>, String> {
    read_image_data_url_impl(Path::new(&root), &path)
}

/// 把本机任意路径的素材复制进工作区（自动避免覆盖），返回最终相对路径。
#[tauri::command]
fn copy_asset(root: String, src_abs: String, dest_rel: String) -> Result<String, String> {
    copy_asset_impl(Path::new(&root), &src_abs, &dest_rel)
}

  /// 把 base64 编码的二进制数据写入绝对路径（「另存为」DOCX / EPUB 导出用），父目录不存在时自动创建。
  #[tauri::command]
  fn write_binary_abs(path: String, data_base64: String) -> Result<(), String> {
      write_binary_abs_impl(&path, &data_base64)
  }

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            pick_directory,
            scan_workspace,
            read_file,
            write_file,
            create_file,
            delete_entry,
            rename_entry,
            create_dir,
            read_sidecar,
            write_sidecar,
            search_text,
            split_at_cursor,
            app_config_dir,
            read_image_data_url,
              copy_asset,
              write_binary_abs,
              fonts::list_fonts,
          ])
        .run(tauri::generate_context!())
        .expect("启动失败");
}
