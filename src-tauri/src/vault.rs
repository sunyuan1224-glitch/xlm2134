use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use walkdir::WalkDir;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FileNode {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    #[serde(default)]
    pub children: Vec<FileNode>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Workspace {
    pub root: String,
    pub tree: Vec<FileNode>,
    pub files: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FileContent {
    pub path: String,
    pub content: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SearchHit {
    pub path: String,
    pub line: usize,
    pub text: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SplitResult {
    pub path: String,
    #[serde(rename = "firstPath")]
    pub first_path: String,
    #[serde(rename = "secondPath")]
    pub second_path: String,
    pub first_title: String,
    pub second_title: String,
}

fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.trim().is_empty() {
        return Err("路径为空".into());
    }
    let mut p = root.to_path_buf();
    let mut depth = 0usize;
    for c in Path::new(rel).components() {
        match c {
            Component::Normal(s) => {
                p.push(s);
                depth += 1;
            }
            Component::CurDir => {}
            _ => return Err(format!("非法路径: {rel}")),
        }
    }
    // "./"、"a/.." 这类路径会退化成工作区根本身，一律拒绝：
    // 否则 delete_entry(root, "") 能删掉整个工作区
    if depth == 0 {
        return Err(format!("非法路径: {rel}"));
    }
    Ok(p)
}

/// 父目录的真实路径必须落在工作区内。
/// 否则 `root/link_outside/x.md` 这类路径会经由符号链接读写工作区外的位置。
fn ensure_parent_inside(root: &Path, full: &Path) -> Result<PathBuf, String> {
    let root_real = root
        .canonicalize()
        .map_err(|e| format!("工作区不可访问: {e}"))?;
    let mut cur = full.parent();
    while let Some(p) = cur {
        if p.exists() {
            let real = p.canonicalize().map_err(|e| e.to_string())?;
            if !real.starts_with(&root_real) {
                return Err(format!(
                    "路径超出工作区范围（符号链接指向外部）: {}",
                    p.to_string_lossy()
                ));
            }
            return Ok(root_real);
        }
        cur = p.parent();
    }
    Ok(root_real)
}

/// 目标路径（必须已存在）的真实位置也必须落在工作区内。
///
/// 与 ensure_parent_inside 的区别：这里连**最后一级**也解析，
/// 所以 `root/secret.md -> /etc/passwd` 这种「符号链接冒充文件」也会被拦下——
/// 写 / 删 / 建走的是父目录校验，读如果只查父目录就会漏掉这一种。
fn ensure_realpath_inside(root: &Path, full: &Path) -> Result<(), String> {
    let root_real = root
        .canonicalize()
        .map_err(|e| format!("工作区不可访问: {e}"))?;
    let real = full.canonicalize().map_err(|e| e.to_string())?;
    if !real.starts_with(&root_real) {
        return Err(format!(
            "路径超出工作区范围（符号链接指向外部）: {}",
            full.to_string_lossy()
        ));
    }
    Ok(())
}

fn hidden(path: &Path, root: &Path) -> bool {
    let rel = path.strip_prefix(root).unwrap_or(path);
    rel.components().any(|c| {
        let s = c.as_os_str().to_string_lossy();
        s.starts_with('.') || s == "node_modules"
    })
}

fn build_tree(root: &Path) -> Vec<FileNode> {
    use std::collections::BTreeMap;
    let mut map: BTreeMap<String, (String, bool)> = BTreeMap::new();
    for entry in WalkDir::new(root).into_iter().filter_entry(|e| !hidden(e.path(), root)) {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if entry.path() == root {
            continue;
        }
        let rel = match entry.path().strip_prefix(root) {
            Ok(r) => r.to_string_lossy().to_string(),
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = entry.file_type().is_dir();
        if is_dir && name == "obsidian" {
            continue;
        }
        map.insert(
            rel.clone(),
            (name, is_dir),
        );
    }

    // 先造出所有节点（先不含子树）
    let nodes: std::collections::HashMap<String, FileNode> = map
        .iter()
        .map(|(path, (name, is_dir))| {
            (
                path.clone(),
                FileNode {
                    path: path.clone(),
                    name: name.clone(),
                    is_dir: *is_dir,
                    children: Vec::new(),
                },
            )
        })
        .collect();

    // 用 children 索引的方式挂载，避免同时可变/不可变借用
    let mut child_keys: Vec<(String, Vec<String>)> = Vec::new();
    let keys: Vec<String> = nodes.keys().cloned().collect();
    for key in keys {
        let parent = Path::new(&key)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .filter(|s| !s.is_empty());
        match parent {
            Some(p) if nodes.contains_key(&p) => {
                let entry = child_keys.iter_mut().find(|(k, _)| *k == p);
                match entry {
                    Some((_, v)) => v.push(key),
                    None => child_keys.push((p, vec![key])),
                }
            }
            _ => {}
        }
    }

    // 递归组装
    fn build(
        path: String,
        nodes: &std::collections::HashMap<String, FileNode>,
        child_index: &std::collections::HashMap<String, Vec<String>>,
    ) -> FileNode {
        let mut node = nodes.get(&path).cloned().unwrap();
        let kids = child_index.get(&path).cloned().unwrap_or_default();
        node.children = kids
            .iter()
            .map(|k| build(k.clone(), nodes, child_index))
            .collect();
        node
    }

    let child_index: std::collections::HashMap<String, Vec<String>> = child_keys.into_iter().collect();
    let mut roots: Vec<String> = Vec::new();
    for key in nodes.keys() {
        let parent = Path::new(key)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .filter(|s| !s.is_empty());
        if !parent.map(|p| nodes.contains_key(&p)).unwrap_or(false) {
            roots.push(key.clone());
        }
    }
    roots.sort();
    roots
        .into_iter()
        .map(|r| build(r, &nodes, &child_index))
        .collect()
}

pub fn scan_impl(root: &Path) -> Result<Workspace, String> {
    if !root.is_dir() {
        return Err("工作区目录不存在".into());
    }
    let tree = build_tree(root);
    let files: Vec<String> = tree
        .iter()
        .flat_map(collect_files)
        .collect();
    Ok(Workspace {
        root: root.to_string_lossy().to_string(),
        tree,
        files,
    })
}

fn collect_files(node: &FileNode) -> Vec<String> {
    let mut out = Vec::new();
    if !node.is_dir {
        if node.path.ends_with(".md") || node.path.ends_with(".txt") {
            out.push(node.path.clone());
        }
    } else {
        for c in &node.children {
            out.extend(collect_files(c));
        }
    }
    out
}

pub fn read_file_impl(root: &Path, path: &str) -> Result<Option<FileContent>, String> {
    let full = safe_join(root, path)?;
    if !full.exists() {
        return Ok(None);
    }
    // 读路径以前只做 safe_join：`root/某章.md` 是指向工作区外的符号链接时会被照读。
    ensure_realpath_inside(root, &full)?;
    if !full.is_file() {
        return Ok(None);
    }
    let content = fs::read_to_string(&full).map_err(|e| e.to_string())?;
    Ok(Some(FileContent {
        path: path.to_string(),
        content,
    }))
}

/// 工作区内的相对路径是否存在（路径非法时直接报错，不当作「不存在」吞掉）
pub fn file_exists_impl(root: &Path, path: &str) -> Result<bool, String> {
    Ok(safe_join(root, path)?.exists())
}

pub fn write_file_impl(root: &Path, path: &str, content: &str) -> Result<(), String> {
    let full = safe_join(root, path);
    let full = full?;
    ensure_parent_inside(root, &full)?;
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    atomic_write(&full, content)?;
    Ok(())
}

pub fn create_file_impl(root: &Path, path: &str, content: &str) -> SearchResult {
    let full = safe_join(root, path)?;
    ensure_parent_inside(root, &full)?;
    if full.exists() {
        return Err("文件已存在".into());
    }
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    atomic_write(&full, content)
}

pub fn delete_entry_impl(root: &Path, path: &str) -> Result<(), String> {
    let full = safe_join(root, path)?;
    // 1) 先确认父目录真实路径在工作区内：只有这一步通过，
    //    后面才允许对「链接本身」执行 unlink（否则 root/link_outside/x 会删到外部）
    let root_real = ensure_parent_inside(root, &full)?;

    // symlink_metadata：不跟随符号链接，才能区分「链接本身」和「链接指向的目录」
    let meta = fs::symlink_metadata(&full)
        .map_err(|e| format!("目标不存在或不可访问: {path}（{e}）"))?;

    // 2) 目标本身是符号链接：只删除链接本身，绝不跟随
    if meta.file_type().is_symlink() {
        return fs::remove_file(&full).map_err(|e| e.to_string());
    }

    // 3) 真实路径必须落在工作区内，且不能是工作区根目录
    let full_real = full
        .canonicalize()
        .map_err(|e| format!("目标不可访问: {e}"))?;
    if full_real == root_real {
        return Err("不允许删除工作区根目录".into());
    }
    if !full_real.starts_with(&root_real) {
        return Err(format!("路径超出工作区范围: {path}"));
    }

    if meta.is_dir() {
        // remove_dir_all 不跟随符号链接：目录内的链接只被 unlink 本身，
        // 指向工作区外的链接目标不会被连带删除，因此这里无需再遍历检查
        fs::remove_dir_all(&full).map_err(|e| e.to_string())
    } else {
        fs::remove_file(&full).map_err(|e| e.to_string())
    }
}

pub fn rename_entry_impl(root: &Path, path: &str, new_path: &str) -> Result<(), String> {
    let from = safe_join(root, path)?;
    let to = safe_join(root, new_path)?;
    if !from.exists() {
        return Err(format!("源路径不存在: {path}"));
    }
    // 与写 / 删 / 建保持一致：源的真实位置与目标的父目录都必须在工作区内，
    // 否则 `root/link_outside/x.md` 能把工作区外的文件搬进来、或把正文搬出去。
    ensure_realpath_inside(root, &from)?;
    ensure_parent_inside(root, &to)?;
    if let Ok(meta) = fs::symlink_metadata(&to) {
        if meta.file_type().is_symlink() {
            return Err(format!("目标已是符号链接，拒绝覆盖: {new_path}"));
        }
    }
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(&from, &to).map_err(|e| e.to_string())
}

pub fn create_dir_impl(root: &Path, path: &str) -> Result<(), String> {
    let full = safe_join(root, path)?;
    ensure_parent_inside(root, &full)?;
    fs::create_dir_all(full).map_err(|e| e.to_string())
}

/// 在目标文件的**同一目录**里生成一个不可预测的临时文件名。
///
/// 旧实现是 `full.with_extension(format!("tmp-{}", pid))`：名字对同一进程固定可预测，
/// 于是 (a) 别人可以在写入前把该路径预置成指向受害文件的符号链接，`File::create`
/// 会跟着链接把数据写进受害文件；(b) 同一进程并发写同名目标时几个写手会撞在同一个
/// 临时文件上互相覆盖。现在名字带 pid + 纳秒时间戳 + 进程内递增序号，配合 create_new
/// 独占创建（见 `atomic_replace`）：预置链接或撞名只会让本次写入换名重试，绝不会写到别的文件。
fn temp_sibling(full: &Path) -> PathBuf {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let name = full
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "out".to_string());
    let dir = full
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    dir.join(format!(
        ".{name}.mynovel-tmp-{}-{nanos}-{seq}",
        std::process::id()
    ))
}

/// 临时文件 + rename 的原子替换（DOCX/EPUB 二进制出口与 sidecar 文本共用）。
///
/// 三条硬约束：
///   1) 临时文件与目标同目录（保证 rename 同盘原子），且用 `create_new`（O_CREAT|O_EXCL）
///      独占创建——绝不会跟随预置的符号链接，也绝不会复用一个残留的旧临时文件；
///   2) 任何一步失败（创建/写入/fsync/rename）都清理掉临时文件，只把真实错误传出去，
///      fsync 的错误也不再 `.ok()` 静默吞掉；
///   3) 名字被占（不可能是我们自己留下的正常情况）就换一个名字重试，绝不覆盖别人的文件。
fn atomic_replace<F>(full: &Path, write: F) -> Result<(), String>
where
    F: Fn(&mut fs::File) -> std::io::Result<()>,
{
    const ATTEMPTS: usize = 8;
    let mut last_err: Option<String> = None;
    for _ in 0..ATTEMPTS {
        let tmp = temp_sibling(full);
        let mut file = match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
        {
            Ok(f) => f,
            // 名字被占用（含“预置的符号链接/目录”）：换名重试，不跟随、不复用
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                last_err = Some(e.to_string());
                continue;
            }
            Err(e) => return Err(format!("创建临时文件失败: {e}")),
        };
        // 写入 + fsync：两步的真实错误都要上报（旧代码把 fsync 错误丢掉了）
        let staged = match write(&mut file) {
            Ok(()) => file.sync_all(),
            Err(e) => Err(e),
        };
        drop(file);
        if let Err(e) = staged {
            let _ = fs::remove_file(&tmp);
            return Err(format!("写入临时文件失败: {e}"));
        }
        if let Err(e) = fs::rename(&tmp, full) {
            let _ = fs::remove_file(&tmp);
            return Err(format!("替换目标文件失败: {e}"));
        }
        return Ok(());
    }
    Err(format!(
        "无法创建唯一的临时文件（已重试 {ATTEMPTS} 次）: {}",
        last_err.unwrap_or_default()
    ))
}

fn atomic_write(full: &Path, content: &str) -> Result<(), String> {
    atomic_replace(full, |f| f.write_all(content.as_bytes()))
}

fn atomic_write_bytes(full: &Path, content: &[u8]) -> Result<(), String> {
    atomic_replace(full, |f| f.write_all(content))
}

/// 侧车文件路径：`{work}/.novel/{name}.json`，work 为空时落在工作区根的 `.novel/` 下。
///
/// 这里以前是「safe_join 失败就退回未校验的 root.join(work)」，等于校验器在失败时
/// 反而绕过自己；现在直接构造合法相对路径再走 safe_join，失败就是失败。
fn sidecar_path(root: &Path, work: &str, name: &str) -> Result<PathBuf, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("侧车文件名为空".into());
    }
    // name 必须是单个文件名，不能借它跳出 .novel 目录
    if name.contains('/') || name.contains('\\') || name == "." || name == ".." {
        return Err(format!("非法侧车文件名: {name}"));
    }
    let work = work.trim();
    let rel = if work.is_empty() {
        format!(".novel/{name}.json")
    } else {
        format!("{work}/.novel/{name}.json")
    };
    safe_join(root, &rel)
}

pub fn read_sidecar_impl(root: &Path, work: &str, name: &str) -> Result<Option<String>, String> {
    let p = sidecar_path(root, work, name)?;
    if !p.exists() {
        return Ok(None);
    }
    ensure_realpath_inside(root, &p)?;
    fs::read_to_string(&p).map(Some).map_err(|e| e.to_string())
}

pub fn write_sidecar_impl(root: &Path, work: &str, name: &str, data: &str) -> Result<(), String> {
    let p = sidecar_path(root, work, name)?;
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    atomic_write(&p, data)
}

pub fn search_impl(root: &Path, re: &regex::Regex) -> Vec<SearchHit> {
    let mut hits = Vec::new();
    for entry in WalkDir::new(root).into_iter().filter_entry(|e| !hidden(e.path(), root)) {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy();
        if !(name.ends_with(".md") || name.ends_with(".txt")) {
            continue;
        }
        let rel = match entry.path().strip_prefix(root) {
            Ok(r) => r.to_string_lossy().to_string(),
            Err(_) => continue,
        };
        let content = match fs::read_to_string(entry.path()) {
            Ok(c) => c,
            Err(_) => continue,
        };
        for (i, line) in content.lines().enumerate() {
            if re.is_match(line) {
                hits.push(SearchHit {
                    path: rel.clone(),
                    line: i + 1,
                    text: if line.chars().count() > 200 {
                        line.chars().take(200).collect()
                    } else {
                        line.to_string()
                    },
                });
            }
        }
    }
    hits
}

/// 图片扩展名 → MIME。非图片返回 None。
fn image_mime(ext: &str) -> Option<&'static str> {
    match ext.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "svg" => Some("image/svg+xml"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "ico" => Some("image/x-icon"),
        _ => None,
    }
}

/// 标准 base64 编码（含 `=` 填充）。
/// base64 不是本 crate 的直接依赖，这里自带查表实现，
/// 既保持纯离线，也不用改 Cargo.toml 触发下载。
pub fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(TABLE[(n >> 6) as usize & 63] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[n as usize & 63] as char);
        } else {
            out.push('=');
        }
    }
    out
}

/// 读取工作区内的图片并编码成 data URL（供编辑器 live preview 内联显示）。
/// 不存在、不是文件、扩展名不是图片时一律返回 Ok(None)（不当作错误）；
/// 只有路径本身非法（越出工作区）才返回 Err。
pub fn read_image_data_url_impl(root: &Path, path: &str) -> Result<Option<String>, String> {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    let mime = match image_mime(ext) {
        Some(m) => m,
        None => return Ok(None),
    };
    let full = safe_join(root, path)?;
    if !full.is_file() {
        return Ok(None);
    }
    ensure_realpath_inside(root, &full)?;
    let bytes = fs::read(&full).map_err(|e| e.to_string())?;
    Ok(Some(format!("data:{mime};base64,{}", base64_encode(&bytes))))
}

/// 把相对路径拆成 (目录, 文件名)，目录部分不含结尾斜杠。
fn split_rel(rel: &str) -> (String, String) {
    match rel.rfind(['/', '\\']) {
        Some(i) => (rel[..i].to_string(), rel[i + 1..].to_string()),
        None => (String::new(), rel.to_string()),
    }
}

/// 文件名拆成 (主干, 带点的扩展名)
fn split_ext(name: &str) -> (String, String) {
    match name.rfind('.') {
        Some(i) if i > 0 => (name[..i].to_string(), name[i..].to_string()),
        _ => (name.to_string(), String::new()),
    }
}

/// 把本机任意路径的素材（src_abs，如 ~/Pictures/a.png）复制进工作区。
/// dest_rel 形如 "assets/a.png"；目标已存在时自动改名 a-1.png、a-2.png…，绝不覆盖。
/// 返回最终写入的相对路径。
pub fn copy_asset_impl(root: &Path, src_abs: &str, dest_rel: &str) -> Result<String, String> {
    if src_abs.trim().is_empty() {
        return Err("源路径为空".into());
    }
    let src = Path::new(src_abs);
    if !src.is_file() {
        return Err(format!("源文件不存在或不是文件: {src_abs}"));
    }

    let dest = safe_join(root, dest_rel)?;
    ensure_parent_inside(root, &dest)?;
    let parent = dest.parent().ok_or("非法目标路径")?.to_path_buf();
    fs::create_dir_all(&parent).map_err(|e| e.to_string())?;

    let (dir, name) = split_rel(dest_rel);
    let (stem, ext) = split_ext(&name);
    if stem.is_empty() {
        return Err(format!("非法目标文件名: {dest_rel}"));
    }

    let mut final_name = name.clone();
    let mut target = parent.join(&final_name);
    let mut n = 0usize;
    while target.exists() {
        n += 1;
        if n > 10_000 {
            return Err(format!("目标目录里重名文件过多: {dest_rel}"));
        }
        final_name = format!("{stem}-{n}{ext}");
        target = parent.join(&final_name);
    }

    fs::copy(src, &target).map_err(|e| e.to_string())?;
    Ok(if dir.is_empty() {
        final_name
    } else {
        format!("{dir}/{final_name}")
    })
}

/// 导出出口的公共闸门：文本导出与二进制导出共用同一道规则。
/// 该出口与工作区无关，所以不走 safe_join；但必须是绝对路径，避免误写到进程 CWD。
/// 目标是符号链接 / 目录 / 手稿扩展名时一律拒绝。
fn ensure_abs_export_target(path: &str) -> Result<PathBuf, String> {
    if path.trim().is_empty() {
        return Err("路径为空".into());
    }
    let full = Path::new(path);
    if !full.is_absolute() {
        return Err(format!("必须是绝对路径: {path}"));
    }
    if let Ok(meta) = fs::symlink_metadata(full) {
        if meta.file_type().is_symlink() {
            return Err(format!("目标是符号链接，拒绝写入: {path}"));
        }
        if meta.is_dir() {
            return Err(format!("目标是目录，无法写入文件: {path}"));
        }
        let ext = full
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if SOURCE_EXTENSIONS.contains(&ext.as_str()) {
            return Err(format!(
                "拒绝覆盖源文件（.{ext}）：请换一个导出文件名或目录"
            ));
        }
    }
    Ok(full.to_path_buf())
}

/// 二进制导出（DOCX / EPUB）单次允许写入的最大字节数。
/// 不是「随便定个大数」：超过这个量级说明调用方状态异常（或有人拿它当写入放大器），
/// 与其在内存里被撑爆，不如明确报错。
pub const MAX_BINARY_EXPORT_BYTES: usize = 256 * 1024 * 1024;

/// 严格 base64 解码（标准字母表，允许空白与 `=` 填充）。
///
/// 为什么不让前端直接传 `Vec<u8>`：Tauri 的 IPC 会把数组序列化成 JSON 数字表，
/// 一个 20 MB 的导出会膨胀成上百 MB 文本；base64 体积更小、也更好在这里做严格校验。
/// 校验规则（任何一条不满足都报错，绝不「猜着解码」）：
///   - 字符只允许 A-Za-z0-9+/ 与作为填充的 =，其余（含 URL-safe 的 -_）一律拒绝；
///   - 去掉空白后长度必须是 4 的倍数，且填充只出现在末尾（= 或 ==，不会更多）；
///   - 末尾填充位必须是 0（不允许非规范编码，避免同一个字节串有多种表示）。
pub fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    fn val(c: u8) -> Option<u8> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }

    let mut clean: Vec<u8> = Vec::with_capacity(input.len());
    for c in input.bytes() {
        match c {
            b' ' | b'\t' | b'\r' | b'\n' => continue,
            b'=' => clean.push(b'='),
            _ => {
                if val(c).is_none() {
                    return Err(format!("非法 base64 字符: {:?}", c as char));
                }
                clean.push(c);
            }
        }
    }
    if clean.is_empty() {
        return Err("base64 内容为空".into());
    }
    if clean.len() % 4 != 0 {
        return Err("base64 长度不是 4 的倍数".into());
    }
    let pad = clean.iter().rev().take_while(|c| **c == b'=').count();
    if pad > 2 {
        return Err("base64 填充过多".into());
    }
    if clean[..clean.len() - pad].contains(&b'=') {
        return Err("base64 填充只能出现在末尾".into());
    }

    let body = &clean[..clean.len() - pad];
    let mut out = Vec::with_capacity(body.len() / 4 * 3 + 3);
    for chunk in body.chunks(4) {
        let mut n: u32 = 0;
        let mut bits = 0u32;
        for &c in chunk {
            n = (n << 6) | val(c).ok_or_else(|| "base64 内部错误".to_string())? as u32;
            bits += 6;
        }
        // 补齐到字节边界后取出整字节
        let bytes_in_chunk = (bits / 8) as usize;
        let shift = bits % 8;
        if shift != 0 && (n & ((1 << shift) - 1)) != 0 {
            return Err("base64 末尾有非零填充位（非规范编码）".into());
        }
        n >>= shift;
        for i in (0..bytes_in_chunk).rev() {
            out.push(((n >> (8 * i)) & 0xff) as u8);
        }
    }
    let total = out.len();
    if total > MAX_BINARY_EXPORT_BYTES {
        return Err(format!(
            "导出数据过大: {total} 字节（上限 {MAX_BINARY_EXPORT_BYTES} 字节）"
        ));
    }
    Ok(out)
}

/// 源文件扩展名：导出只写 docx/epub 之类的产物，绝不允许覆盖这些。
const SOURCE_EXTENSIONS: [&str; 4] = ["md", "markdown", "mdx", "txt"];

/// 把 base64 编码的二进制数据写到任意绝对路径（「另存为」DOCX / EPUB 导出用）。
///
/// 安全边界（比 write_text_abs 更严，因为这是二进制出口，写错一次就是数据损坏）：
///   1) 必须是绝对路径（防止误写进进程 CWD）；
///   2) 目标是目录时报错；
///   3) 目标若是符号链接，直接拒绝——不跟着链接写到别的文件上；
///   4) 目标是已存在的 .md/.markdown/.mdx/.txt 时拒绝——导出绝不允许覆盖作者手稿；
///   5) base64 严格校验 + 体积上限；
///   6) 仍然走「临时文件 + rename」的原子写入，中途失败不会留下半个文件。
pub fn write_binary_abs_impl(path: &str, data_base64: &str) -> Result<(), String> {
    let full = ensure_abs_export_target(path)?;
    let bytes = base64_decode(data_base64)?;
    if let Some(parent) = full.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    atomic_write_bytes(&full, &bytes)
}

type SearchResult = Result<(), String>;

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_workspace() -> PathBuf {
        // 不引入新依赖：用进程号 + 纳秒时间戳 + 递增序号保证唯一
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let p = std::env::temp_dir().join(format!(
            "mynovel-test-{}-{}-{}",
            std::process::id(),
            nanos,
            seq
        ));
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn test_safe_join_rejects_empty_and_escape() {
        let root = temp_workspace();
        assert!(safe_join(&root, "").is_err());
        assert!(safe_join(&root, "   ").is_err());
        assert!(safe_join(&root, ".").is_err());
        assert!(safe_join(&root, "./").is_err());
        assert!(safe_join(&root, "../escaped").is_err());
        assert!(safe_join(&root, "a/../../escaped").is_err());
        assert!(safe_join(&root, "/etc/passwd").is_err());
        assert!(safe_join(&root, "valid/sub/file.md").is_ok());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn test_delete_entry_protection() {
        let root = temp_workspace();
        // 不能删空串或根
        assert!(delete_entry_impl(&root, "").is_err());
        assert!(delete_entry_impl(&root, ".").is_err());

        // 正常创建并删除文件
        let sub_file = "ch01.md";
        create_file_impl(&root, sub_file, "hello").unwrap();
        assert!(safe_join(&root, sub_file).unwrap().exists());
        delete_entry_impl(&root, sub_file).unwrap();
        assert!(!safe_join(&root, sub_file).unwrap().exists());

        // 正常创建并删除子目录
        create_dir_impl(&root, "vol1").unwrap();
        create_file_impl(&root, "vol1/c1.md", "c1").unwrap();
        delete_entry_impl(&root, "vol1").unwrap();
        assert!(!safe_join(&root, "vol1").unwrap().exists());

        // 符号链接在外部目录时，如果目录内含逃逸链接应被拒绝删除
        let outside = temp_workspace();
        let outside_file = outside.join("important.txt");
        fs::write(&outside_file, "keep-me").unwrap();

        create_dir_impl(&root, "evil_dir").unwrap();
        let link_path = safe_join(&root, "evil_dir/link_outside").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, &link_path).unwrap();
            // 删除含外部符号链接的目录：链接本身被 unlink，外部内容必须原封不动
            delete_entry_impl(&root, "evil_dir").unwrap();
            assert!(outside_file.exists(), "外部文件绝不能被误删");
            assert!(!link_path.exists(), "目录内的符号链接应随目录一起消失");

            // 直接删符号链接：只解除链接，不伤及外部
            let direct_link = safe_join(&root, "link_file").unwrap();
            std::os::unix::fs::symlink(&outside_file, &direct_link).unwrap();
            assert!(delete_entry_impl(&root, "link_file").is_ok());
            assert!(outside_file.exists());
            assert!(!direct_link.exists());

            // 经由父目录符号链接逃逸的删除必须被拒绝
            let escape_link = safe_join(&root, "escape").unwrap();
            std::os::unix::fs::symlink(&outside, &escape_link).unwrap();
            let inner_link = outside.join("inner_link");
            std::os::unix::fs::symlink(&outside_file, &inner_link).unwrap();
            assert!(
                delete_entry_impl(&root, "escape/inner_link").is_err(),
                "经由父目录符号链接的删除必须被拒绝"
            );
            assert!(inner_link.exists(), "工作区外的链接不能被删除");

            // 经由父目录符号链接创建文件同样必须被拒绝
            assert!(
                create_file_impl(&root, "escape/new.md", "x").is_err(),
                "经由父目录符号链接的写入必须被拒绝"
            );
            assert!(!outside.join("new.md").exists());
            assert!(write_file_impl(&root, "escape/new.md", "x").is_err());
            assert!(!outside.join("new.md").exists());
            assert!(create_dir_impl(&root, "escape/newdir").is_err());
            assert!(!outside.join("newdir").exists());
        }

        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn test_create_and_scan_tree() {
        let root = temp_workspace();
        create_file_impl(&root, "chapter-1.md", "# 1").unwrap();
        create_dir_impl(&root, "卷一").unwrap();
        create_file_impl(&root, "卷一/第01章.md", "# 卷一01").unwrap();

        let ws = scan_impl(&root).unwrap();
        assert_eq!(ws.files.len(), 2);
        assert!(ws.files.contains(&"chapter-1.md".to_string()));
        assert!(ws.files.contains(&"卷一/第01章.md".to_string()));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn test_base64_encode_rfc4648_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        // 全部 256 个字节值都要能编码，且长度符合 4*ceil(n/3)
        let all: Vec<u8> = (0u16..=255).map(|b| b as u8).collect();
        assert_eq!(base64_encode(&all).len(), (all.len() + 2) / 3 * 4);
        assert_eq!(base64_encode(&[0u8, 0, 0]), "AAAA");
        assert_eq!(base64_encode(&[255u8, 255, 255]), "////");
    }

    #[test]
    fn test_image_data_url_and_copy_asset_and_write_binary_abs() {
        let root = temp_workspace();
        let outside = temp_workspace();

        // 1. write_binary_abs_impl 写入绝对路径
        let export_file = outside.join("export").join("chapter.html");
        write_binary_abs_impl(
            export_file.to_str().unwrap(),
            &base64_encode(b"<h1>Hello</h1>"),
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(&export_file).unwrap(),
            "<h1>Hello</h1>"
        );

        // 2. copy_asset_impl 复制外部文件到 assets/
        let src_img = outside.join("sample.png");
        fs::write(&src_img, b"fake-png-data").unwrap();

        let rel1 = copy_asset_impl(&root, src_img.to_str().unwrap(), "assets/sample.png").unwrap();
        assert_eq!(rel1, "assets/sample.png");
        assert!(root.join("assets/sample.png").exists());

        // 再次复制，自动重名 sample-1.png
        let rel2 = copy_asset_impl(&root, src_img.to_str().unwrap(), "assets/sample.png").unwrap();
        assert_eq!(rel2, "assets/sample-1.png");
        assert!(root.join("assets/sample-1.png").exists());

        // 再次复制，自动重名 sample-2.png
        let rel3 = copy_asset_impl(&root, src_img.to_str().unwrap(), "assets/sample.png").unwrap();
        assert_eq!(rel3, "assets/sample-2.png");
        assert!(root.join("assets/sample-2.png").exists());

        // 3. read_image_data_url_impl 读取 data url
        let data_url = read_image_data_url_impl(&root, "assets/sample.png").unwrap();
        assert!(data_url.is_some());
        let url = data_url.unwrap();
        assert!(url.starts_with("data:image/png;base64,"));
        let b64 = url.strip_prefix("data:image/png;base64,").unwrap();
        assert_eq!(b64, &base64_encode(b"fake-png-data"));

        // 非图片文件返回 Ok(None)
        let non_img = read_image_data_url_impl(&root, "chapter.md").unwrap();
        assert!(non_img.is_none());

        // 不存在文件返回 Ok(None)
        let not_found = read_image_data_url_impl(&root, "assets/not-exist.png").unwrap();
        assert!(not_found.is_none());

        // 越出工作区返回 Err
        assert!(read_image_data_url_impl(&root, "../sample.png").is_err());
        assert!(copy_asset_impl(&root, src_img.to_str().unwrap(), "../sample.png").is_err());

        // 4. write_binary_abs_impl 校验与测试
        let bin_export = outside.join("export").join("test.docx");
        let valid_b64 = base64_encode(b"PK\x03\x04test-docx-payload");
        write_binary_abs_impl(bin_export.to_str().unwrap(), &valid_b64).unwrap();
        assert_eq!(fs::read(&bin_export).unwrap(), b"PK\x03\x04test-docx-payload");

        // 4.1 相对路径拒绝
        assert!(write_binary_abs_impl("relative/path.docx", &valid_b64).is_err());
        // 4.2 非法 base64 字符拒绝
        assert!(write_binary_abs_impl(bin_export.to_str().unwrap(), "bad*characters").is_err());
        // 4.3 拒绝覆盖已存在的源文件 (.md / .txt)
        let manuscript = outside.join("chapter01.md");
        fs::write(&manuscript, "# 珍贵手稿").unwrap();
        assert!(write_binary_abs_impl(manuscript.to_str().unwrap(), &valid_b64).is_err());
        assert_eq!(fs::read_to_string(&manuscript).unwrap(), "# 珍贵手稿");

        // 4.4 拒绝写入目录
        let dir_target = outside.join("export");
        assert!(write_binary_abs_impl(dir_target.to_str().unwrap(), &valid_b64).is_err());

        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn test_base64_decode_roundtrip_and_errors() {
        for s in ["", "f", "fo", "foo", "foob", "fooba", "foobar"] {
            let enc = base64_encode(s.as_bytes());
            if s.is_empty() {
                assert!(base64_decode(&enc).is_err(), "空内容拒绝");
            } else {
                let dec = base64_decode(&enc).unwrap();
                assert_eq!(dec, s.as_bytes());
            }
        }
        // 非法字符、非法长度、非规范填充位
        assert!(base64_decode("abc").is_err()); // 长度 3
        assert!(base64_decode("====").is_err()); // 全填充
        assert!(base64_decode("Zm=8").is_err()); // 填充在中间
    }

    /// 临时文件名：同目录、不可预测、两次调用不相同。
    #[test]
    fn test_temp_sibling_unique_and_same_dir() {
        let dir = temp_workspace();
        let full = dir.join("out.epub");
        let a = temp_sibling(&full);
        let b = temp_sibling(&full);
        assert_ne!(a, b, "两次取到的临时名必须不同（否则并发会撞在一起）");
        assert_eq!(a.parent(), full.parent(), "临时文件必须与目标同目录（rename 才原子）");
        let name = a.file_name().unwrap().to_string_lossy().to_string();
        assert!(name.starts_with(".out.epub"), "临时名应能看出属于哪个目标: {name}");
        assert!(name.contains("mynovel-tmp"), "临时名应带固定前缀，便于识别与清理: {name}");
        fs::remove_dir_all(&dir).ok();
    }

    /// 失败必须清理临时文件、并把真实错误传出来（不许静默、不许留垃圾）。
    #[test]
    fn test_atomic_replace_cleans_tmp_on_error() {
        let dir = temp_workspace();
        let full = dir.join("out.bin");
        let err = atomic_replace(&full, |_f| {
            Err(std::io::Error::new(std::io::ErrorKind::Other, "boom-write"))
        })
        .unwrap_err();
        assert!(err.contains("boom-write"), "真实错误必须原样上报: {err}");
        assert!(!full.exists(), "写入失败时绝不能留下目标文件");
        let names: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert!(names.is_empty(), "失败后必须清理临时文件: {names:?}");
        fs::remove_dir_all(&dir).ok();
    }

    /// 预置的「可预测临时路径」符号链接绝不能被跟随：数据只许落在导出目标上，
    /// 不能顺着链接写进受害文件（旧实现 File::create 会跟链接，本测试即回归防线）。
    #[cfg(unix)]
    #[test]
    fn test_atomic_write_bytes_ignores_preseeded_tmp_symlink() {
        use std::os::unix::fs::symlink;

        let dir = temp_workspace();
        let victim = dir.join("受害文件.docx");
        fs::write(&victim, b"ORIGINAL-VICTIM").unwrap();

        let target = dir.join("book.epub");
        // 旧实现用的可预测临时路径：把扩展名换成 tmp-<pid>
        let predictable = target.with_extension(format!("tmp-{}", std::process::id()));
        symlink(&victim, &predictable).unwrap();
        // 另一种可预测写法（点号开头的隐藏临时名）也一并预置
        let predictable_dot = dir.join(format!(".book.epub.tmp-{}", std::process::id()));
        symlink(&victim, &predictable_dot).unwrap();

        let payload = b"PK\x03\x04-new-epub-payload";
        write_binary_abs_impl(target.to_str().unwrap(), &base64_encode(payload)).unwrap();

        assert_eq!(fs::read(&target).unwrap(), payload, "导出目标应写入完整数据");
        assert_eq!(
            fs::read(&victim).unwrap(),
            b"ORIGINAL-VICTIM",
            "绝不能跟随预置的临时符号链接写到受害文件"
        );
        assert!(fs::symlink_metadata(&predictable).unwrap().file_type().is_symlink());
        assert!(fs::symlink_metadata(&predictable_dot).unwrap().file_type().is_symlink());
        let leftovers: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .filter(|n| n.contains("mynovel-tmp"))
            .collect();
        assert!(leftovers.is_empty(), "不应留下临时文件: {leftovers:?}");

        fs::remove_dir_all(&dir).ok();
    }

    /// 同进程并发写同一个目标：各写手各用各的临时文件，结果必须是某一个写手的完整内容，
    /// 绝不能是混写/半截，也不能留下临时文件（旧实现固定临时名会在这里翻车）。
    #[test]
    fn test_atomic_write_bytes_concurrent_same_target() {
        use std::sync::Arc;

        let dir = temp_workspace();
        let target = Arc::new(dir.join("并发导出.epub"));
        fs::write(&*target, b"OLD-CONTENT").unwrap();

        const WRITERS: usize = 8;
        const LEN: usize = 4096;
        let mut handles = Vec::new();
        for i in 0..WRITERS {
            let t = Arc::clone(&target);
            handles.push(std::thread::spawn(move || {
                let payload: Vec<u8> = (0..LEN).map(|k| ((i * 37 + k * 13) % 251) as u8).collect();
                atomic_write_bytes(&t, &payload).map(|_| payload)
            }));
        }
        let mut payloads: Vec<Vec<u8>> = Vec::new();
        for h in handles {
            let p = h.join().unwrap().expect("并发原子写入不应失败");
            assert_eq!(p.len(), LEN);
            payloads.push(p);
        }
        // 各写手的内容两两不同，下面「恰好等于某一个」的断言才有意义
        for i in 0..payloads.len() {
            for j in (i + 1)..payloads.len() {
                assert_ne!(payloads[i], payloads[j]);
            }
        }

        let final_bytes = fs::read(&*target).unwrap();
        assert!(
            payloads.iter().any(|p| *p == final_bytes),
            "最终内容必须是某一个写手的完整内容（不能混写、不能半截）"
        );

        let names: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["并发导出.epub".to_string()], "并发写入不应留下临时文件");

        fs::remove_dir_all(&dir).ok();
    }

    /// 读路径也必须挡住「符号链接冒充工作区内的文件」。
    #[test]
    fn test_read_refuses_symlink_escape() {
        use std::os::unix::fs::symlink;

        let root = temp_workspace();
        let outside_dir = temp_workspace();
        let outside_file = outside_dir.join("secret.md");
        fs::write(&outside_file, "工作区外的机密").unwrap();

        // 工作区里的「章节」文件其实是指向工作区外的软链接
        let linked = root.join("第一章.md");
        symlink(&outside_file, &linked).unwrap();

        let got = read_file_impl(&root, "第一章.md");
        assert!(got.is_err(), "读取越界软链接必须报错，而不是照读内容");

        // 工作区内的正常软链接（指向工作区内）仍然可以读
        let inside_target = root.join("真章.md");
        fs::write(&inside_target, "正常内容").unwrap();
        let inside_link = root.join("别名.md");
        symlink(&inside_target, &inside_link).unwrap();
        let ok = read_file_impl(&root, "别名.md").unwrap().unwrap();
        assert_eq!(ok.content, "正常内容");

        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&outside_dir).ok();
    }

    /// 重命名不能借父目录软链接把工作区外的文件搬进来 / 搬出去。
    #[test]
    fn test_rename_refuses_parent_symlink_escape() {
        use std::os::unix::fs::symlink;

        let root = temp_workspace();
        let outside = temp_workspace();
        let outside_file = outside.join("外部.md");
        fs::write(&outside_file, "外部内容").unwrap();

        let link_dir = root.join("link_outside");
        symlink(&outside, &link_dir).unwrap();
        create_file_impl(&root, "我的章.md", "我的正文").unwrap();

        // 经软链接目录把外部文件移进工作区命名空间
        let moved = rename_entry_impl(&root, "link_outside/外部.md", "偷来的.md");
        assert!(moved.is_err(), "经软链接的跨边界重命名必须被拒绝");
        assert!(!root.join("偷来的.md").exists());

        // 把工作区内的章搬出去
        let out = rename_entry_impl(&root, "我的章.md", "link_outside/搬走.md");
        assert!(out.is_err(), "把正文搬到工作区外必须被拒绝");
        assert!(root.join("我的章.md").exists());

        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&outside).ok();
    }

    /// 导出出口不许覆盖手稿、不许替换符号链接。
    #[test]
    fn test_write_binary_abs_refuses_overwriting_source() {
        let dir = temp_workspace();
        let payload = base64_encode(b"<html>");
        let manuscript = dir.join("chapter01.md");
        fs::write(&manuscript, "# 原稿").unwrap();

        for ext in ["md", "markdown", "mdx", "txt", "MD"] {
            let target = dir.join(format!("稿.{ext}"));
            fs::write(&target, "原稿").unwrap();
            let e = write_binary_abs_impl(&target.to_string_lossy(), &payload).unwrap_err();
            assert!(e.contains("拒绝覆盖源文件"), "{ext} 应被拒绝，实际: {e}");
            assert_eq!(fs::read_to_string(&target).unwrap(), "原稿");
        }

        assert!(write_binary_abs_impl(&manuscript.to_string_lossy(), &payload).is_err());

        // 正常的 .html 出口照常可写
        let html = dir.join("导出.html");
        write_binary_abs_impl(&html.to_string_lossy(), &payload).unwrap();
        assert_eq!(fs::read_to_string(&html).unwrap(), "<html>");

        // 符号链接一律拒绝
        use std::os::unix::fs::symlink;
        let victim = dir.join("victim.html");
        fs::write(&victim, "别动").unwrap();
        let link = dir.join("link.html");
        symlink(&victim, &link).unwrap();
        assert!(write_binary_abs_impl(&link.to_string_lossy(), &payload).is_err());
        assert_eq!(fs::read_to_string(&victim).unwrap(), "别动");

        fs::remove_dir_all(&dir).ok();
    }

    /// 侧车路径：work 为空落在工作区根，非法文件名必须报错而不是退回未校验路径。
    #[test]
    fn test_sidecar_path_is_always_validated() {
        let root = temp_workspace();

        // work 为空 → 工作区根的 .novel/
        let p = sidecar_path(&root, "", "plot").unwrap();
        assert_eq!(p, root.join(".novel").join("plot.json"));

        // 常规作品目录
        let p = sidecar_path(&root, "第一卷", "timeline").unwrap();
        assert_eq!(p, root.join("第一卷").join(".novel").join("timeline.json"));

        // 试图借 work / name 跳出工作区
        assert!(sidecar_path(&root, "..", "plot").is_err());
        assert!(sidecar_path(&root, "../..", "plot").is_err());
        assert!(sidecar_path(&root, "/etc", "plot").is_err());
        assert!(sidecar_path(&root, "", "../plot").is_err());
        assert!(sidecar_path(&root, "", "a/b").is_err());
        assert!(sidecar_path(&root, "", "..").is_err());
        assert!(sidecar_path(&root, "", "").is_err());

        // work="" 时读写都能真正落到工作区根，而不是失败
        write_sidecar_impl(&root, "", "plot", "{\"items\":[]}").unwrap();
        assert_eq!(
            read_sidecar_impl(&root, "", "plot").unwrap().unwrap(),
            "{\"items\":[]}"
        );

        fs::remove_dir_all(&root).ok();
    }

    /// 拆章不会无声覆盖既有的 -上 / -下 文件，且失败时原文完好。
    #[test]
    fn test_split_targets_do_not_clobber() {
        let root = temp_workspace();
        create_file_impl(&root, "第一章.md", "上半段\n下半段\n").unwrap();
        create_file_impl(&root, "第一章-上.md", "既有的上").unwrap();

        assert!(file_exists_impl(&root, "第一章-上.md").unwrap());
        assert!(!file_exists_impl(&root, "不存在的.md").unwrap());

        fs::remove_dir_all(&root).ok();
    }
}
