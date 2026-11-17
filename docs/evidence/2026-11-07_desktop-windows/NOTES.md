# Desktop on Windows — 2026-11-07

Windows 11 Pro (26300), WebView2 157, Rust 1.94 (MSVC), Node 22.22. The window was driven over
WebView2's DevTools port (`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`)
by `scripts/desktop-probe.mjs`. Sign-in was dev login with a test identity.

## dev/ — `npm run desktop`

- `01_window.png`: the window on http://localhost:1430 (Vite, proxying the server).
- `02_signed-in.png`: after signing in through the form. `/api/me` 200, `ws://localhost:1430/sync/company` open and receiving, no failed requests.

## packaged/ — `npm run tauri build`, then `target/release/tauri-app.exe`

The same exe the installers ship (`bundle/nsis/Foundation_0.1.0_x64-setup.exe`, 6.2 MB; `bundle/msi/…msi`, 7.4 MB). The installers themselves weren't run.

- `01_window.png`: http://localhost:31440 after clearing cookies and site data, so signed out.
- `02_signed-in.png`: signed in through the form. `/api/me` against http://localhost:4410 returned 200 with the cookie, `ws://localhost:4410/sync/company` opened and received, no failed requests.
- `03_server-down.png`: server stopped, window reloaded. The board opens from **This device's copy**.
- `04_server-back.png`: server started again. The window reconnected without a reload (the device-copy pill cleared).
- A second launch of the exe left one process (single instance).

## Found on the way

- The first packaged origin, :1440, failed to bind with WSAEACCES. This machine's dynamic port range is 1024–15000, and Hyper-V/WSL had reserved 1437–1536. Moved to :31440, and the app now says so if the port is taken instead of showing a dead page.
- Node 22.13 has no FTS5 in `node:sqlite` (22.16 is the first that does), so every server test failed. `engines` is now `>=22.16`.
- Killing the launcher from outside left the server, Vite and the window running (SPEC §7).
