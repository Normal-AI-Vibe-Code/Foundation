fn main() {
    // the app's own commands (the server switch, src/local_server.rs). The window is the app's
    // http://localhost:31440 page, a remote origin to Tauri, so each command needs a permission
    // the capability grants (capabilities/default.json)
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["local_server_status", "start_local_server", "stop_local_server"]),
    ))
    .expect("failed to run tauri-build");
}
