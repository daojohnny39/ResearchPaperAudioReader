mod commands;

use commands::SidecarState;
use tauri::{Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(SidecarState::default())
        .invoke_handler(tauri::generate_handler![
            commands::read_file_bytes,
            commands::doc_hash,
            commands::hash_file,
            commands::audio_cache_get,
            commands::audio_cache_put,
            commands::cache_get,
            commands::cache_put,
            commands::start_kokoro_sidecar
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // Kill the Kokoro Node sidecar when the app exits (drops the child
            // and waits on it) so we never leak a Node process.
            if let RunEvent::Exit = event {
                if let Some(state) = app.try_state::<SidecarState>() {
                    if let Ok(mut guard) = state.0.lock() {
                        *guard = None; // SidecarProcess::drop kills the child
                    }
                }
            }
        });
}
