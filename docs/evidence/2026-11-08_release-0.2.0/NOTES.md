# Foundation 0.2.0 (2026-11-08)

`main` at `v0.2.0`: the plan board and overnight fixes, the ⌘/Ctrl key labels, and main's crew and Kiri work.

Before the build: `npm test` (client 69, server 104 + 6 skipped), typecheck, and the e2e suite (31 pass, 2 skipped by design; `perf.spec` fails on this machine exactly as it did on the previous `main`: pan with live frames p95 ≈ 50 ms against a 34 ms budget, headless with software WebGL).

`npm run tauri build` on Windows 11 (Rust 1.94, WebView2 157):

- `bundle/nsis/Foundation_0.2.0_x64-setup.exe` (6.28 MiB)
- `bundle/msi/Foundation_0.2.0_x64_en-US.msi` (7.55 MiB)

Smoke test of the packaged `tauri-app.exe` against a server from the same commit on :4410 (temp data, dev login as Ada), driven over WebView2's DevTools port (`scripts/desktop-probe.mjs`):

1. `01_window.png`: the window serves its page from http://localhost:31440.
2. `02_signed-in.png`: signed in; the company board loads and the sync socket is open (`ws://localhost:4410/sync/company`, frames received); no failed requests. Key chips read Ctrl+F (the platform labels).
3. `03_settings-plan.png`: Settings → Plan in the packaged app: 82 cards (Needs you 13, Backlog 39, Done 30), "synced" from GitHub, no page errors.

Not done: the installers weren't run (they'd install over the machine's app), and nothing is signed. macOS and Linux weren't built.
