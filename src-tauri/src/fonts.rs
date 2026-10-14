//! 本机字体列表。
//!
//! 只做一件事：把 fontconfig 认识的字体族取回来给设置面板的下拉用。
//! 取不到（没装 fc-list、进程起不来）时返回空表，前端自动退回「只显示预设」，
//! 不因为拿不到字体列表而影响打开设置。
use std::collections::BTreeSet;
use std::process::Command;

/// 列出已安装的字体族：去重 + 排序。
///
/// fc-list 的 family 字段可能是「主名,别名1,别名2」这种逗号分隔的列表，
/// 这里只取第一个（也就是字体真正的族名），和浏览器里写 font-family 的习惯一致。
#[tauri::command]
pub fn list_fonts() -> Vec<String> {
    let Ok(out) = Command::new("fc-list").args(["--format", "%{family}\n"]).output() else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut set: BTreeSet<String> = BTreeSet::new();
    for line in text.lines() {
        if let Some(first) = line.split(',').next() {
            let name = first.trim();
            if !name.is_empty() {
                set.insert(name.to_string());
            }
        }
    }
    set.into_iter().collect()
}
