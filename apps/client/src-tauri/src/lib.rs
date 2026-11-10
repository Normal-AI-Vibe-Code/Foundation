//! Foundation's desktop shell.
//!
//! In `tauri dev` the window shows the Vite dev server (:1430), which proxies the
//! Foundation server, so everything is same-origin.
//!
//! Packaged, the window is served by the app itself from http://localhost:31440
//! (tauri-plugin-localhost) instead of Tauri's own scheme (http://tauri.localhost
//! on Windows, tauri://localhost on macOS). Cookies are matched by host, not port,
//! so a Foundation server on http://localhost:4410 is the same site: its
//! SameSite=Lax session cookie, the sync WebSocket and SSE all reach it, and its
//! CORS already admits http://localhost:<port>. The bundled client still opens when
//! the server is down, so the device's board copies keep working offline.
//!
//! Packaged, the app also runs that server itself (server.rs): a fresh install works
//! with nothing else on the computer. The window is told where it is before the page
//! loads (`window.__FOUNDATION_SERVER__`, read in apps/client/src/lib/api.ts), and why
//! it isn't there if it couldn't start (`window.__FOUNDATION_SERVER_ERROR__`).

mod server;

use std::net::TcpListener;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

/// The packaged window's origin. Fixed, because the origin keys the device's offline
/// board copies (IndexedDB) and localStorage: change it and they're left behind.
/// Above 15000 and below 32768 on purpose: Windows reserves blocks of its dynamic
/// port range for Hyper-V and WSL at boot (bind fails with WSAEACCES), and that range
/// is 49152+ by default but 1024–15000 on some machines; Linux and macOS hand out
/// ephemeral ports from 32768 and 49152.
/// `FOUNDATION_DESKTOP_PORT` at build time moves it, for a check build installed beside
/// the real app (its own origin, so its own offline copies); release builds never set it.
const PORT: u16 = match option_env!("FOUNDATION_DESKTOP_PORT") {
    Some(p) => parse_port(p),
    None => 31440,
};

pub(crate) const fn parse_port(s: &str) -> u16 {
    let b = s.as_bytes();
    let mut i = 0;
    let mut n: u32 = 0;
    while i < b.len() {
        assert!(b[i] >= b'0' && b[i] <= b'9', "FOUNDATION_DESKTOP_PORT must be a number");
        n = n * 10 + (b[i] - b'0') as u32;
        i += 1;
    }
    assert!(n > 0 && n < 65536, "FOUNDATION_DESKTOP_PORT must be a port");
    n as u16
}

/// Whether nothing else serves http://localhost:PORT. "localhost" can mean 127.0.0.1 or
/// ::1, and a server on one family doesn't stop a bind on the other: the window would
/// then load whichever the WebView resolves first, which can be another app's page (an
/// installed Foundation of another version did exactly that, 2026-11-08). So both must
/// be free; a family this computer doesn't have (no IPv6) doesn't count against it.
pub(crate) fn port_free(port: u16) -> bool {
    use std::io::ErrorKind::{AddrInUse, PermissionDenied};
    for host in ["127.0.0.1", "::1"] {
        if let Err(e) = TcpListener::bind((host, port)) {
            if matches!(e.kind(), AddrInUse | PermissionDenied) {
                return false;
            }
        }
    }
    true
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let dev = tauri::is_dev();
    let mut builder = tauri::Builder::default()
        // a second launch shows the open window: two copies can't share the port
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        // updates (SPEC: Desktop updates): the page asks the signed feed and a person presses Update
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());
    // the plugin's server panics on its own thread if it can't bind; check first and say why instead
    let port_free = dev || port_free(PORT);
    if !dev && port_free {
        builder = builder.plugin(tauri_plugin_localhost::Builder::new(PORT).build());
    }
    builder
        .manage(server::Sidecar::default())
        .setup(move |app| {
            // the server first, so the page's first request has someone to answer it (dev: scripts/dev.mjs runs it)
            let started = if !dev && port_free {
                let resources = app.path().resource_dir()?;
                // its data lives in the app's own folder (%APPDATA%\co.normallab.foundation on Windows);
                // FOUNDATION_DESKTOP_HOME moves it, for a check run that mustn't touch the real one
                let home = match std::env::var_os("FOUNDATION_DESKTOP_HOME") {
                    Some(dir) if !dir.is_empty() => std::path::PathBuf::from(dir),
                    _ => app.path().app_data_dir()?,
                };
                Some(app.state::<server::Sidecar>().start(&resources, &home, PORT))
            } else {
                None
            };
            let url = if dev {
                WebviewUrl::App("index.html".into())
            } else if port_free {
                WebviewUrl::External(format!("http://localhost:{PORT}").parse().expect("loopback url"))
            } else {
                WebviewUrl::External(port_taken_page().parse().expect("data url"))
            };
            let mut window = WebviewWindowBuilder::new(app, "main", url);
            if let Some(s) = &started {
                window = window.initialization_script(&format!(
                    "window.__FOUNDATION_SERVER__ = {}; window.__FOUNDATION_SERVER_ERROR__ = {};",
                    serde_json::to_string(&s.url)?,
                    serde_json::to_string(&s.error)?
                ));
            }
            window
                .title("Foundation")
                .inner_size(1440.0, 900.0)
                .min_inner_size(960.0, 600.0)
                .center()
                // files dropped on the window go to the page (uploads), not to Tauri
                .disable_drag_drop_handler()
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running Foundation")
        .run(|app, event| {
            // quitting: the server goes with the app (server.rs says what covers a crash)
            if let RunEvent::Exit = event {
                app.state::<server::Sidecar>().stop();
            }
        });
}

/// Shown when another program holds the window's port (or Windows has reserved it).
fn port_taken_page() -> String {
    let html = format!(
        "<!doctype html><meta charset=utf-8><title>Foundation</title>\
         <body style=\"font:15px/1.5 system-ui,sans-serif;background:#0f1729;color:#dfe6f3;display:grid;place-items:center;height:100vh;margin:0\">\
         <div style=\"max-width:34em\"><h1 style=\"font-size:20px;font-weight:600\">Foundation can't open its window</h1>\
         <p>It serves its page from <code>http://localhost:{PORT}</code>, and something else on this computer is using that port.</p>\
         <p>Close the other program and start Foundation again. On Windows, <code>netstat -ano | findstr :{PORT}</code> shows what holds it, \
         and <code>netsh int ipv4 show excludedportrange protocol=tcp</code> shows ports Windows has reserved.</p></div>"
    );
    format!("data:text/html;charset=utf-8,{}", html.replace('%', "%25").replace('#', "%23").replace(' ', "%20").replace('"', "%22").replace('<', "%3C").replace('>', "%3E"))
}
