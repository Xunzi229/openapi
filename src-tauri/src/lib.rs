mod export;
mod import;
mod model;
mod run;
mod store;
mod yapi;

use model::{Library, System};
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
fn load_library(app: tauri::AppHandle) -> Result<Library, String> {
    store::load(&app)
}

#[tauri::command]
fn save_library(app: tauri::AppHandle, library: Library) -> Result<(), String> {
    store::save(&app, &library)
}

#[tauri::command]
fn import_markdown(app: tauri::AppHandle, dir: String) -> Result<Library, String> {
    store::import_dir(&app, std::path::Path::new(&dir))
}

#[tauri::command]
fn parse_curl(text: String) -> Result<import::ParsedCurlCommand, String> {
    import::parse_curl_command(&text)
}

#[tauri::command]
fn data_dir_path(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|error| error.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
fn open_data_dir(app: tauri::AppHandle) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    app.opener()
        .open_path(dir.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn run_command(run_id: String, command: String) -> Result<run::RunResult, String> {
    tauri::async_runtime::spawn_blocking(move || run::run(&run_id, &command))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
fn stop_command(run_id: String) -> bool {
    run::stop(&run_id)
}

#[tauri::command]
async fn import_yapi(base: String, token: String, host: String) -> Result<yapi::YapiProject, String> {
    tauri::async_runtime::spawn_blocking(move || yapi::fetch(&base, &token, &host))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
fn export_system_markdown(path: String, system: System) -> Result<(), String> {
    std::fs::write(&path, export::system_markdown(&system)).map_err(|error| error.to_string())
}

#[tauri::command]
fn backup_library(app: tauri::AppHandle, path: String) -> Result<(), String> {
    store::backup_to(&app, std::path::Path::new(&path))
}

#[tauri::command]
fn restore_library(app: tauri::AppHandle, path: String) -> Result<Library, String> {
    store::restore_from(&app, std::path::Path::new(&path))
}

fn build_menu(app: &tauri::App) -> tauri::Result<()> {
    let import = MenuItemBuilder::with_id("import", "导入 Markdown")
        .accelerator("CmdOrCtrl+Shift+I")
        .build(app)?;
    let import_yapi_item = MenuItemBuilder::with_id("import-yapi", "从 YApi 导入到这个系统…").build(app)?;
    let save = MenuItemBuilder::with_id("save", "保存")
        .accelerator("CmdOrCtrl+S")
        .build(app)?;
    let export_system = MenuItemBuilder::with_id("export-system", "导出这个系统为 Markdown").build(app)?;
    let backup = MenuItemBuilder::with_id("backup", "备份全部…").build(app)?;
    let restore = MenuItemBuilder::with_id("restore", "从备份恢复…").build(app)?;
    let open_dir = MenuItemBuilder::with_id("open-data-dir", "打开数据目录").build(app)?;
    let file = SubmenuBuilder::new(app, "文件")
        .item(&import)
        .item(&import_yapi_item)
        .item(&save)
        .separator()
        .item(&export_system)
        .item(&backup)
        .item(&restore)
        .separator()
        .item(&open_dir)
        .build()?;

    let edit = SubmenuBuilder::new(app, "编辑")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let search = MenuItemBuilder::with_id("search", "搜索")
        .accelerator("CmdOrCtrl+K")
        .build(app)?;
    let palette = MenuItemBuilder::with_id("palette", "快速跳转")
        .accelerator("CmdOrCtrl+P")
        .build(app)?;
    let bigger = MenuItemBuilder::with_id("font-bigger", "放大 curl 字号")
        .accelerator("CmdOrCtrl+=")
        .build(app)?;
    let smaller = MenuItemBuilder::with_id("font-smaller", "缩小 curl 字号")
        .accelerator("CmdOrCtrl+-")
        .build(app)?;
    let expand = MenuItemBuilder::with_id("expand-all", "全部展开")
        .accelerator("CmdOrCtrl+Shift+E")
        .build(app)?;
    let collapse = MenuItemBuilder::with_id("collapse-all", "全部收起")
        .accelerator("CmdOrCtrl+Shift+W")
        .build(app)?;
    let view = SubmenuBuilder::new(app, "视图")
        .item(&search)
        .item(&palette)
        .separator()
        .item(&bigger)
        .item(&smaller)
        .separator()
        .item(&expand)
        .item(&collapse)
        .build()?;

    let shortcuts = MenuItemBuilder::with_id("shortcuts", "快捷键").build(app)?;
    let about = MenuItemBuilder::with_id("about", "关于 OpenApi").build(app)?;
    let help = SubmenuBuilder::new(app, "帮助")
        .item(&shortcuts)
        .item(&about)
        .build()?;

    let mut builder = MenuBuilder::new(app);
    #[cfg(target_os = "macos")]
    {
        let app_menu = SubmenuBuilder::new(app, "OpenApi")
            .about(None)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        builder = builder.item(&app_menu);
    }
    let menu = builder.items(&[&file, &edit, &view, &help]).build()?;
    app.set_menu(menu)?;
    app.on_menu_event(|handle, event| {
        let _ = handle.emit("menu", event.id().0.clone());
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            build_menu(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_library,
            save_library,
            import_markdown,
            parse_curl,
            data_dir_path,
            open_data_dir,
            run_command,
            stop_command,
            import_yapi,
            export_system_markdown,
            backup_library,
            restore_library
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
