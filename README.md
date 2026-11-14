# Foundation

The company brain of Form Industries. It is one shared grid where people, the apps we build, and the agents that work with us meet.

- **Today:** home, before the boards. The Shiba (the agent's face) answers questions about your day, while beside it sit what wants you (asks, notes that tag you, stages you own, new files on your boards, work matching your job), your goals, and every company app. In Chrome, the extension makes it every new tab.
- **The grid:** sections hold tables, maps, notes and media, plus live panels: running apps (with their GitHub repo, MCP tools and input/output ports), web pages, machines, uploaded files and CAD, live company systems, agent jobs, and asks to teammates.
- **The agent layer:** sits above the grid and shows how apps are wired, where agents are working, and what everyone just did.
- **The agent:** runs the whole interface. It runs on your Claude Code subscription or on API credits. It can organize the board, open and wire apps, find repos, read BomForm and FactoryForm, brief Vision, chase people for CAD (Hermes), and queue reverse-engineering (REA).
- **The company board:** shows Vision, BomForm, FactoryForm, the Data Room, Creation and Foundation live, wired by how data actually flows between them.

**[SPEC.md](SPEC.md)** is the plan, with status, the hookups you need to do, known issues and phases. **[DESIGN.md](DESIGN.md)** is the design language. Inside the app, `#/design` renders it live.

## Run it locally

```sh
npm install
npm run dev            # server :4410 + client :1430 → open http://localhost:1430
```

Sign in with **Continue with Google**, the same Google sign-in as the flowform client, through flowform-server (`FLOWFORM_URL`, default https://server.formresearch.ai), or with your name and an allowlisted email (dev login). To configure Slack, BomForm, API credits and more, copy `.env.example` to `.env`; see SPEC §6.

```sh
npm test               # server invariants (node:test)
npm run typecheck      # every workspace
npm run desktop        # the server + the desktop window (needs Rust; see below)
```

### On Windows

1. Install **Node 22.16 or newer** (nodejs.org, LTS) and **Git for Windows**. Older Node 22 releases ship a SQLite without full-text search (FTS5), and the server won't start on them.
2. Clone and run, in PowerShell:
   ```powershell
   git clone https://github.com/joshleong/Foundation.git
   cd Foundation
   copy .env.example .env
   npm install
   npm run dev
   ```
   Open http://localhost:1430. Sign in with Google, or with your name and an allowlisted email (`.env` sets `FOUNDATION_ALLOWLIST`). Every ⌘ shortcut is Ctrl on Windows and Linux, and the app labels it that way there.
3. **The desktop window** also needs the Tauri toolchain: **Visual Studio Build Tools** with the *Desktop development with C++* workload, **Rust** from rustup.rs (the default MSVC toolchain), and **WebView2** (already on Windows 10 and 11). Then `npm run desktop`. The first build compiles the Rust side, which takes a few minutes.
   **An installer:** `npm run tauri build` writes `apps/client/src-tauri/target/release/bundle/nsis/Foundation_<version>_x64-setup.exe` (and an `.msi`). The installed app carries its own server and Node (`scripts/desktop-server.mjs` builds them into the installer): the server switch, bottom right, starts it on http://localhost:4410 when you pick **Built in** and press **Start**, with its data in `%APPDATA%\co.normallab.foundation`, so nothing else needs to be installed. **From a checkout** runs a Foundation checkout's server there instead, and a server already answering on :4410 (`npm run dev`) is simply used. It serves its own page from http://localhost:31440, and boards opened before still open when the server is down. To use a hosted server, the sign-in page's **Server** line.
   **Updates:** an installed Foundation checks `latest.json` on the newest GitHub release a few seconds after it opens, and offers a newer version on a card; it installs only when you press **Update and restart**, and only an installer signed with Foundation's updater key. Releasing (on the machine that holds the key, `~/.tauri/foundation-updater.key`): write `docs/blog/<version>.md`, then `npm run release -- bump <version>`, `npm run release -- build`, push `main` and the tag, and `npm run release -- publish`.
4. **The agent** runs on Claude Code: install it with Anthropic's native Windows installer so `claude.exe` is on your PATH (an npm-installed `claude.cmd` can't be started without a shell; point `FOUNDATION_CLAUDE_CLI` at a `claude.exe` instead), or set `ANTHROPIC_API_KEY` for the API runtime.

Vision Code hand-offs look for Vision on macOS paths, and the reverse-engineering job starts `npx` directly, so neither starts on Windows yet (SPEC §7).

Connect Claude Code (or Codex) to a board: press **⌘K**, choose **Connect Claude Code**, and paste the command it copies.

## Keys

⌘ is Ctrl on Windows and Linux, where the app shows its shortcuts as Ctrl+K, Ctrl+J and so on.

| Key | Action |
|---|---|
| **⌘K** | Search everything, paste a link to open it as a live app, or run an action |
| **⌘J** | The agent (🎙 to talk) |
| **A** | Agent layer |
| **P** | Present |
| **⌘U** | Upload |
| **Esc** | Release an app and step up the grid |

On the grid itself:
- Drag empty space to pan; Ctrl + scroll to zoom.
- Drag a card header to float it.
- Drag from an output port to wire it.

## Layout

```
apps/client       React 19 + Vite grid and shell (Tauri desktop in src-tauri)
apps/server       Node 22 + TypeScript: SQLite, Yjs sync, auth, files, search, MCP, agent, connectors, Today
apps/extension    Foundation for Chrome: every new tab opens Today (npm run build -w @foundation/extension)
packages/protocol the board schema every side shares
packages/ui       design tokens, springs and the night engine
```

Foundation also takes in the work of `flowform-client` and `flowform-server` (see SPEC §3.1). The Gantt and digital-twin features were dropped.
