pub mod agents;
mod files;
mod pty;
mod store;

use std::sync::Arc;

use pty::PtyManager;
use store::Store;
use tauri::{Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            app.manage(Arc::new(PtyManager::default()));

            let db_path = app
                .path()
                .app_data_dir()
                .expect("sin directorio de datos de la aplicacion")
                .join("sesiones.sqlite3");
            app.manage(Arc::new(Store::open(db_path)?));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_list,
            pty::which,
            agents::conversations_for,
            agents::create_conversation,
            files::list_dir,
            files::available_editors,
            files::open_in_editor,
            files::create_entry,
            files::rename_entry,
            files::duplicate_entry,
            files::trash_entry,
            store::sessions_load,
            store::session_output,
            store::session_save,
            store::session_delete,
            store::session_clear_output,
            store::sessions_set_order,
            store::session_set_active,
        ])
        .build(tauri::generate_context!())
        .expect("error al iniciar la aplicacion")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                pty::shutdown(app);
                if let Some(store) = app.try_state::<Arc<Store>>() {
                    store.flush();
                }
            }
        });
}
