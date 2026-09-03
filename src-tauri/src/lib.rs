use base64::Engine;
use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

static ATOMIC_WRITE_COUNTER: AtomicU64 = AtomicU64::new(0);

pub mod agent;
pub mod config;
mod ipc;
pub mod templates;

#[derive(serde::Deserialize)]
pub struct PickFolderArgs {
    pub title: Option<String>,
    pub suggested_name: Option<String>,
}

#[tauri::command]
async fn pick_folder(args: PickFolderArgs) -> Result<Option<String>, String> {
    let mut dialog = rfd::AsyncFileDialog::new();
    if let Some(t) = args.title {
        dialog = dialog.set_title(t);
    }
    if let Some(name) = args.suggested_name {
        dialog = dialog.set_file_name(&name);
    }
    let picked = dialog.pick_folder().await;
    Ok(picked.map(|f| f.path().to_string_lossy().into_owned()))
}

#[derive(serde::Deserialize)]
pub struct PickFileArgs {
    pub title: Option<String>,
    pub extensions: Option<Vec<String>>,
}

#[tauri::command]
async fn pick_file(args: PickFileArgs) -> Result<Option<String>, String> {
    let mut dialog = rfd::AsyncFileDialog::new();
    if let Some(t) = args.title {
        dialog = dialog.set_title(t);
    }
    if let Some(exts) = args.extensions {
        if !exts.is_empty() {
            dialog = dialog.add_filter("文件类型", &exts);
        }
    }
    let picked = dialog.pick_file().await;
    Ok(picked.map(|f| f.path().to_string_lossy().into_owned()))
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("{}: {}", e, path))
}

#[tauri::command]
fn read_binary_file(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("{}: {}", e, path))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    if let Some(parent) = PathBuf::from(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {:?}", e, parent))?;
    }
    std::fs::write(&path, contents).map_err(|e| format!("{}: {}", e, path))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AtomicTextFile {
    path: String,
    contents: String,
}

#[derive(serde::Deserialize)]
#[serde(tag = "kind")]
enum AtomicFile {
    #[serde(rename = "text")]
    Text { path: String, contents: String },
    #[serde(rename = "binary")]
    Binary {
        path: String,
        #[serde(rename = "dataBase64")]
        data_base64: String,
    },
}

struct PendingAtomicFile {
    path: String,
    contents: Vec<u8>,
}

struct PreparedAtomicFile {
    target: PathBuf,
    temp: PathBuf,
    backup: PathBuf,
    had_original: bool,
}

fn decode_base64_binary(data_base64: &str) -> Result<Vec<u8>, String> {
    let compact: Vec<u8> = data_base64
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect();
    base64::engine::general_purpose::STANDARD
        .decode(compact)
        .map_err(|e| format!("base64 decode failed: {}", e))
}

fn atomic_sidecar(
    target: &Path,
    token: &str,
    index: usize,
    suffix: &str,
) -> Result<PathBuf, String> {
    let parent = target
        .parent()
        .ok_or_else(|| format!("目标路径缺少父目录: {:?}", target))?;
    let name = target
        .file_name()
        .ok_or_else(|| format!("目标路径缺少文件名: {:?}", target))?;
    Ok(parent.join(format!(
        ".{}.shaderlab-{}-{}.{}",
        name.to_string_lossy(),
        token,
        index,
        suffix
    )))
}

fn atomic_target_identity(path: &Path) -> String {
    let identity = path.to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        identity.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        identity
    }
}

fn remove_if_exists(path: &Path) -> Result<(), std::io::Error> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn cleanup_atomic_temps(files: &[PreparedAtomicFile]) {
    for file in files {
        let _ = remove_if_exists(&file.temp);
    }
}

/** Restores committed targets in reverse. Failed backups are deliberately retained. */
fn rollback_atomic_files(files: &[PreparedAtomicFile]) -> Vec<String> {
    let mut failures = Vec::new();
    for file in files.iter().rev() {
        if let Err(error) = remove_if_exists(&file.target) {
            failures.push(format!(
                "无法移除失败提交 {}: {}；旧文件保留于 {}",
                file.target.display(),
                error,
                file.backup.display()
            ));
            continue;
        }
        if file.had_original {
            if let Err(error) = std::fs::rename(&file.backup, &file.target) {
                failures.push(format!(
                    "无法恢复 {}: {}；旧文件保留于 {}",
                    file.target.display(),
                    error,
                    file.backup.display()
                ));
            }
        }
    }
    failures
}

fn atomic_failure(message: String, rollback_failures: Vec<String>) -> String {
    if rollback_failures.is_empty() {
        message
    } else {
        format!(
            "{}；回滚未完全成功：{}",
            message,
            rollback_failures.join("；")
        )
    }
}

#[tauri::command]
fn write_text_files_atomic(files: Vec<AtomicTextFile>) -> Result<(), String> {
    write_text_files_atomic_impl(files, None)
}

fn write_text_files_atomic_impl(
    files: Vec<AtomicTextFile>,
    fail_commit_index: Option<usize>,
) -> Result<(), String> {
    write_files_atomic_impl(
        files
            .into_iter()
            .map(|file| AtomicFile::Text {
                path: file.path,
                contents: file.contents,
            })
            .collect(),
        fail_commit_index,
    )
}

#[tauri::command]
fn write_files_atomic(files: Vec<AtomicFile>) -> Result<(), String> {
    write_files_atomic_impl(files, None)
}

/**
 * Decodes every payload and stages every file beside its target before any
 * target is backed up. Commits run in caller order and roll back in reverse.
 */
fn write_files_atomic_impl(
    files: Vec<AtomicFile>,
    fail_commit_index: Option<usize>,
) -> Result<(), String> {
    let files: Vec<PendingAtomicFile> = files
        .into_iter()
        .map(|file| match file {
            AtomicFile::Text { path, contents } => Ok(PendingAtomicFile {
                path,
                contents: contents.into_bytes(),
            }),
            AtomicFile::Binary { path, data_base64 } => {
                let contents = decode_base64_binary(&data_base64)
                    .map_err(|error| format!("{}: {}", error, path))?;
                Ok(PendingAtomicFile { path, contents })
            }
        })
        .collect::<Result<_, String>>()?;

    if files.is_empty() {
        return Ok(());
    }

    let token = format!(
        "{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        ATOMIC_WRITE_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let mut targets = HashSet::new();
    let mut prepared = Vec::with_capacity(files.len());

    for (index, file) in files.iter().enumerate() {
        let target = PathBuf::from(&file.path);
        let parent = target
            .parent()
            .ok_or_else(|| format!("目标路径缺少父目录: {}", file.path))?;
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {:?}", e, parent))?;
        let canonical_parent =
            std::fs::canonicalize(parent).map_err(|e| format!("{}: {:?}", e, parent))?;
        let file_name = target
            .file_name()
            .ok_or_else(|| format!("目标路径缺少文件名: {}", file.path))?;
        let normalized_target = canonical_parent.join(file_name);
        if !targets.insert(atomic_target_identity(&normalized_target)) {
            return Err(format!("原子写入包含重复目标: {}", file.path));
        }
        prepared.push(PreparedAtomicFile {
            had_original: normalized_target.exists(),
            temp: atomic_sidecar(&normalized_target, &token, index, "tmp")?,
            backup: atomic_sidecar(&normalized_target, &token, index, "bak")?,
            target: normalized_target,
        });
    }

    for (file, prepared_file) in files.iter().zip(&prepared) {
        let write_result = (|| -> Result<(), String> {
            let mut output = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&prepared_file.temp)
                .map_err(|e| format!("创建临时文件失败 {}: {}", prepared_file.temp.display(), e))?;
            output
                .write_all(&file.contents)
                .map_err(|e| format!("写入临时文件失败 {}: {}", prepared_file.temp.display(), e))?;
            output
                .sync_all()
                .map_err(|e| format!("同步临时文件失败 {}: {}", prepared_file.temp.display(), e))?;
            Ok(())
        })();
        if let Err(error) = write_result {
            cleanup_atomic_temps(&prepared);
            return Err(error);
        }
    }

    for index in 0..prepared.len() {
        let file = &prepared[index];
        if file.had_original {
            if let Err(error) = std::fs::rename(&file.target, &file.backup) {
                let rollback_failures = rollback_atomic_files(&prepared[..index]);
                cleanup_atomic_temps(&prepared);
                return Err(atomic_failure(
                    format!("备份目标失败 {}: {}", file.target.display(), error),
                    rollback_failures,
                ));
            }
        }
        let commit_result = if fail_commit_index == Some(index) {
            Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("injected commit failure at index {}", index),
            ))
        } else {
            std::fs::rename(&file.temp, &file.target)
        };
        if let Err(error) = commit_result {
            let rollback_failures = rollback_atomic_files(&prepared[..=index]);
            cleanup_atomic_temps(&prepared);
            return Err(atomic_failure(
                format!("提交临时文件失败 {}: {}", file.target.display(), error),
                rollback_failures,
            ));
        }
    }

    cleanup_atomic_temps(&prepared);
    let mut cleanup_failures = Vec::new();
    for file in &prepared {
        if file.had_original {
            if let Err(error) = remove_if_exists(&file.backup) {
                cleanup_failures.push(format!("{}: {}", file.backup.display(), error));
            }
        }
    }
    if !cleanup_failures.is_empty() {
        eprintln!(
            "ShaderLab atomic write committed successfully, but backup cleanup failed: {}",
            cleanup_failures.join("；")
        );
    }
    Ok(())
}

#[cfg(test)]
mod atomic_write_tests {
    use super::*;

    fn test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "shaderlab-atomic-test-{}-{}-{}",
            name,
            std::process::id(),
            ATOMIC_WRITE_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn assert_no_atomic_sidecars(dir: &Path) {
        let sidecars: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                name.contains(".shaderlab-") && (name.ends_with(".tmp") || name.ends_with(".bak"))
            })
            .collect();
        assert!(
            sidecars.is_empty(),
            "unexpected atomic sidecars: {:?}",
            sidecars
                .iter()
                .map(|entry| entry.path())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn mixed_text_and_binary_batch_succeeds() {
        let dir = test_dir("mixed-success");
        let text = dir.join("shader.glsl");
        let binary = dir.join("preview.bin");
        let expected_binary = vec![0, 1, 2, 127, 128, 255];
        let encoded = base64::engine::general_purpose::STANDARD.encode(&expected_binary);

        write_files_atomic_impl(
            vec![
                AtomicFile::Text {
                    path: text.to_string_lossy().into_owned(),
                    contents: "void main() { /* 测试 */ }".into(),
                },
                AtomicFile::Binary {
                    path: binary.to_string_lossy().into_owned(),
                    data_base64: format!(" \t{}\r\n", encoded),
                },
            ],
            None,
        )
        .unwrap();

        assert_eq!(
            std::fs::read_to_string(&text).unwrap(),
            "void main() { /* 测试 */ }"
        );
        assert_eq!(std::fs::read(&binary).unwrap(), expected_binary);
        assert_no_atomic_sidecars(&dir);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn metadata_commit_failure_after_binary_commit_restores_all_targets() {
        let dir = test_dir("mixed-metadata-failure");
        let text = dir.join("shader.glsl");
        let binary = dir.join("preview.bin");
        let metadata = dir.join("shaderlab.json");
        let old_binary = vec![9, 8, 0, 7, 255];
        std::fs::write(&text, "old text").unwrap();
        std::fs::write(&binary, &old_binary).unwrap();
        std::fs::write(&metadata, "old metadata").unwrap();

        let result = write_files_atomic_impl(
            vec![
                AtomicFile::Text {
                    path: text.to_string_lossy().into_owned(),
                    contents: "new text".into(),
                },
                AtomicFile::Binary {
                    path: binary.to_string_lossy().into_owned(),
                    data_base64: base64::engine::general_purpose::STANDARD.encode([1, 2, 3, 4]),
                },
                AtomicFile::Text {
                    path: metadata.to_string_lossy().into_owned(),
                    contents: "new metadata".into(),
                },
            ],
            Some(2),
        );

        assert!(result
            .unwrap_err()
            .contains("injected commit failure at index 2"));
        assert_eq!(std::fs::read_to_string(&text).unwrap(), "old text");
        assert_eq!(std::fs::read(&binary).unwrap(), old_binary);
        assert_eq!(std::fs::read_to_string(&metadata).unwrap(), "old metadata");
        assert_no_atomic_sidecars(&dir);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn invalid_base64_staging_does_not_touch_targets() {
        let dir = test_dir("invalid-base64");
        let text = dir.join("shader.glsl");
        let binary = dir.join("preview.bin");
        std::fs::write(&text, "old text").unwrap();
        std::fs::write(&binary, [4, 5, 6]).unwrap();

        let result = write_files_atomic_impl(
            vec![
                AtomicFile::Text {
                    path: text.to_string_lossy().into_owned(),
                    contents: "new text".into(),
                },
                AtomicFile::Binary {
                    path: binary.to_string_lossy().into_owned(),
                    data_base64: "not ! base64".into(),
                },
            ],
            None,
        );

        assert!(result.unwrap_err().contains("base64 decode failed"));
        assert_eq!(std::fs::read_to_string(&text).unwrap(), "old text");
        assert_eq!(std::fs::read(&binary).unwrap(), [4, 5, 6]);
        assert_no_atomic_sidecars(&dir);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn text_and_binary_duplicate_target_is_rejected() {
        let dir = test_dir("mixed-duplicate");
        let target = dir.join("shared.dat");
        std::fs::write(&target, "old contents").unwrap();

        let result = write_files_atomic_impl(
            vec![
                AtomicFile::Text {
                    path: target.to_string_lossy().into_owned(),
                    contents: "new text".into(),
                },
                AtomicFile::Binary {
                    path: target.to_string_lossy().into_owned(),
                    data_base64: base64::engine::general_purpose::STANDARD.encode([1, 2, 3]),
                },
            ],
            None,
        );

        assert!(result.unwrap_err().contains("重复目标"));
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "old contents");
        assert_no_atomic_sidecars(&dir);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn injected_middle_commit_failure_restores_all_targets_and_cleans_temps() {
        let dir = test_dir("middle-commit-failure");
        let graph = dir.join("image.shadergraph.json");
        let glsl = dir.join("image.glsl");
        let meta = dir.join("shaderlab.json");
        std::fs::write(&graph, "old graph").unwrap();
        std::fs::write(&glsl, "old glsl").unwrap();
        std::fs::write(&meta, "old meta").unwrap();

        let result = write_text_files_atomic_impl(
            vec![
                AtomicTextFile {
                    path: graph.to_string_lossy().into_owned(),
                    contents: "new graph".into(),
                },
                AtomicTextFile {
                    path: glsl.to_string_lossy().into_owned(),
                    contents: "new glsl".into(),
                },
                AtomicTextFile {
                    path: meta.to_string_lossy().into_owned(),
                    contents: "new meta".into(),
                },
            ],
            Some(1),
        );

        assert!(result
            .unwrap_err()
            .contains("injected commit failure at index 1"));
        assert_eq!(std::fs::read_to_string(&graph).unwrap(), "old graph");
        assert_eq!(std::fs::read_to_string(&glsl).unwrap(), "old glsl");
        assert_eq!(std::fs::read_to_string(&meta).unwrap(), "old meta");
        assert_no_atomic_sidecars(&dir);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn injected_failure_removes_new_prior_target_and_restores_current_backup() {
        let dir = test_dir("mixed-commit-failure");
        let graph = dir.join("new.shadergraph.json");
        let glsl = dir.join("image.glsl");
        let meta = dir.join("shaderlab.json");
        std::fs::write(&glsl, "old glsl").unwrap();
        std::fs::write(&meta, "old meta").unwrap();

        let result = write_text_files_atomic_impl(
            vec![
                AtomicTextFile {
                    path: graph.to_string_lossy().into_owned(),
                    contents: "new graph".into(),
                },
                AtomicTextFile {
                    path: glsl.to_string_lossy().into_owned(),
                    contents: "new glsl".into(),
                },
                AtomicTextFile {
                    path: meta.to_string_lossy().into_owned(),
                    contents: "new meta".into(),
                },
            ],
            Some(1),
        );

        assert!(result.is_err());
        assert!(!graph.exists());
        assert_eq!(std::fs::read_to_string(&glsl).unwrap(), "old glsl");
        assert_eq!(std::fs::read_to_string(&meta).unwrap(), "old meta");
        assert_no_atomic_sidecars(&dir);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn target_identity_matches_platform_case_rules() {
        let lower = PathBuf::from(r"C:\\Project\\passes\\image.glsl");
        let upper = PathBuf::from(r"C:\\Project\\passes\\IMAGE.glsl");
        #[cfg(windows)]
        assert_eq!(
            atomic_target_identity(&lower),
            atomic_target_identity(&upper)
        );
        #[cfg(not(windows))]
        assert_ne!(
            atomic_target_identity(&lower),
            atomic_target_identity(&upper)
        );
    }

    #[test]
    fn rollback_restores_original_content() {
        let dir = test_dir("restore");
        let target = dir.join("shader.glsl");
        let backup = dir.join("shader.glsl.bak");
        let temp = dir.join("shader.glsl.tmp");
        std::fs::write(&target, "new").unwrap();
        std::fs::write(&backup, "old").unwrap();
        let failures = rollback_atomic_files(&[PreparedAtomicFile {
            target: target.clone(),
            temp,
            backup: backup.clone(),
            had_original: true,
        }]);
        assert!(failures.is_empty());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "old");
        assert!(!backup.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rollback_failure_retains_backup() {
        let dir = test_dir("retain-backup");
        let target = dir.join("locked-target");
        let backup = dir.join("locked-target.bak");
        let temp = dir.join("locked-target.tmp");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(&backup, "old").unwrap();
        let failures = rollback_atomic_files(&[PreparedAtomicFile {
            target,
            temp,
            backup: backup.clone(),
            had_original: true,
        }]);
        assert!(!failures.is_empty());
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), "old");
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[tauri::command]
fn write_binary_file(path: String, data_base64: String) -> Result<(), String> {
    let bytes = decode_base64_binary(&data_base64)?;
    if let Some(parent) = PathBuf::from(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {:?}", e, parent))?;
    }
    std::fs::write(&path, bytes).map_err(|e| format!("{}: {}", e, path))
}

#[tauri::command]
fn create_dir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| format!("{}: {}", e, path))
}

#[tauri::command]
fn delete_file(path: String) -> Result<(), String> {
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("{}: {}", e, path)),
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEntry {
    pub dir: String,
    pub name: String,
    pub modified: String,
    pub has_thumbnail: bool,
}

/// 作品库根目录：app_data_dir()/Projects，保证目录存在。
#[tauri::command]
fn library_root(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("{e}"))?
        .join("Projects");
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {:?}", e, dir))?;
    Ok(dir.to_string_lossy().to_string())
}

/// 画廊列表直接扫描 Projects/*/shaderlab.json（无独立索引，永不与磁盘脱节），按 modified 倒序。
#[tauri::command]
fn list_library(root: String) -> Result<Vec<LibraryEntry>, String> {
    let mut entries = Vec::new();
    let readers = match std::fs::read_dir(&root) {
        Ok(readers) => readers,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(entries),
        Err(e) => return Err(format!("{}: {}", e, root)),
    };
    for item in readers.flatten() {
        let path = item.path();
        if !path.is_dir() || !path.join("shaderlab.json").is_file() {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(path.join("shaderlab.json")) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        let name = value
            .get("name")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if name.is_empty() {
            continue;
        }
        entries.push(LibraryEntry {
            dir: path.to_string_lossy().to_string(),
            name,
            modified: value
                .get("modified")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_string(),
            has_thumbnail: path.join("thumbnail.png").is_file(),
        });
    }
    entries.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(entries)
}

/// 递归删除作品库项目目录。护栏：路径必须位于 root 下且包含 shaderlab.json。
#[tauri::command]
fn delete_dir(root: String, path: String) -> Result<(), String> {
    let canonical_root = PathBuf::from(&root)
        .canonicalize()
        .map_err(|e| format!("{}: {:?}", e, root))?;
    let canonical_path = PathBuf::from(&path)
        .canonicalize()
        .map_err(|e| format!("{}: {:?}", e, path))?;
    if !canonical_path.starts_with(&canonical_root) {
        return Err(format!("path outside library root: {}", path));
    }
    if !canonical_path.join("shaderlab.json").is_file() {
        return Err(format!("not a shaderlab project: {}", path));
    }
    std::fs::remove_dir_all(&path).map_err(|e| format!("{}: {}", e, path))
}

/// 在系统文件管理器中定位项目文件夹（Windows 资源管理器 / macOS 访达 / Linux 文件管理器）。
#[tauri::command]
fn reveal_in_folder(path: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err(format!("not found: {}", path));
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let win_path = path.replace('/', "\\");
        std::process::Command::new("explorer.exe")
            .args(["/select,", &win_path])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("{e}"))?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| format!("{e}"))?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let parent = Path::new(&path)
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from(&path));
        std::process::Command::new("xdg-open")
            .arg(&parent)
            .spawn()
            .map_err(|e| format!("{e}"))?;
        return Ok(());
    }
}

#[tauri::command]
fn restart_app(app: tauri::AppHandle) {
    app.restart();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ipc::chat::AppState::new())
        .invoke_handler(tauri::generate_handler![
            pick_folder,
            pick_file,
            read_text_file,
            read_binary_file,
            write_text_file,
            write_text_files_atomic,
            write_files_atomic,
            write_binary_file,
            create_dir,
            delete_file,
            library_root,
            list_library,
            delete_dir,
            reveal_in_folder,
            restart_app,
            ipc::chat::chat,
            ipc::chat::chat_stream,
            ipc::chat::select_template,
            ipc::chat::list_user_templates,
            ipc::chat::save_user_template,
            ipc::chat::delete_user_template,
            ipc::chat::get_phase,
            ipc::chat::reset_session,
            ipc::chat::get_agent_config,
            ipc::chat::set_agent_config
        ])
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .targets([
                            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
                        ])
                        .build(),
                )?;
            }
            if let Ok(dir) = app.path().app_data_dir() {
                ipc::chat::init_from_disk(&app.state::<ipc::chat::AppState>(), &dir);
            }
            #[cfg_attr(not(debug_assertions), allow(unused_mut))]
            let mut win_builder =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("ShaderLab Pro")
                    .inner_size(1440.0, 960.0)
                    .min_inner_size(960.0, 600.0)
                    .maximized(true)
                    // 无边框窗口：去掉系统标题栏/边框装饰，由前端顶栏承担拖动与窗口控制
                    .decorations(false);
            #[cfg(debug_assertions)]
            {
                let data_dir = std::path::PathBuf::from("webview-data");
                std::fs::create_dir_all(&data_dir)?;
                win_builder = win_builder.data_directory(data_dir);
            }
            let win = win_builder.build()?;
            let _ = win.set_focus();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
