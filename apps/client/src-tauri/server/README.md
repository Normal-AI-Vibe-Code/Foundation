# The server the desktop app carries

Built here by `node scripts/desktop-server.mjs` (run by `npm run build:desktop`, so by `tauri build`):

- `index.mjs`, `extract-worker.mjs`: `apps/server` bundled by esbuild
- `node` / `node.exe`: the pinned Node, checked against nodejs.org's SHA-256

Tauri ships this folder as a resource and `src/server.rs` starts it with the window. Only this
file is in git: the folder has to exist for `tauri dev` to build, where nothing here is used
(`scripts/dev.mjs` runs the server from source).
