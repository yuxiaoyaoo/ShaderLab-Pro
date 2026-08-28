use base64::Engine;
use std::path::PathBuf;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

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
fn write_text_file(path: String, contents: String) -> Result<(), String> {
  if let Some(parent) = PathBuf::from(&path).parent() {
    std::fs::create_dir_all(parent).map_err(|e| format!("{}: {:?}", e, parent))?;
  }
  std::fs::write(&path, contents).map_err(|e| format!("{}: {}", e, path))
}

#[tauri::command]
fn write_binary_file(path: String, data_base64: String) -> Result<(), String> {
  let bytes = base64::engine::general_purpose::STANDARD
    .decode(&data_base64)
    .map_err(|e| format!("base64 decode failed: {}", e))?;
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
      write_text_file,
      write_binary_file,
      create_dir,
      delete_file,
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
      let mut win_builder = WebviewWindowBuilder::new(
        app,
        "main",
        WebviewUrl::App("index.html".into()),
      )
      .title("ShaderLab Pro")
      .inner_size(1440.0, 960.0)
      .min_inner_size(960.0, 600.0)
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
