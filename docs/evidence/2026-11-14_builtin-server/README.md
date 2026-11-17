# The built-in server, merged into the server switch (2026-11-14)

Josh: "merge everything push to main". The Nov 9 branch `claude/friendly-chatterjee-1b5f69` made the
installed app carry its own server (a pinned Node 22.22.0 and `apps/server` bundled by esbuild) and
start it by itself before the window, on :31441. Main had since gained the server switch (bottom right),
which starts a checkout's server on :4410 when a person presses Start. Merged, the switch's
**This computer** offers both: **Built in** (that bundled server, its data in the app's own folder) or
**From a checkout**, both on :4410. Nothing starts without a person; a server a person started and
didn't Stop starts again when the app opens.

## Checked

- `01-design-day.png`, `02-design-night.png`: `#/design` → Server switch, every state, day and night.
  The pick is tinted like the In use tag so **Start the server** stays the one blue action.
- A check build of the app (`tauri build --no-bundle`, its own name and identifier, window on :31450,
  `FOUNDATION_DESKTOP_HOME` on a throwaway folder; driven over WebView2's debugging port by `drive.mjs`).
  Your installed Foundation and its data weren't touched.
  - `03`: a fresh profile offers **Built in** first. The status says this build carries its server.
  - Start: the server answered `/api/health` (`"name":"foundation"`) 1.3 s after the press, running
    `target/release/server/node.exe … server/index.mjs` as the app's child, its database in the
    throwaway folder; the page reloaded onto it. Signed in with dev login and Today opened (`04`).
  - `05`: running, with where its data is. **Stop**: the process gone, :4410 closed, and the
    "start again" flag cleared.
  - Started again, then `taskkill /F` on the app alone: the server was gone 16 ms later (the Job
    Object), :4410 free.
  - Relaunched without pressing Stop first: the app started the built-in server by itself and it
    answered 1.8 s after launch; Today opened still signed in (`06`).
  - `07`: **From a checkout** pointed at this worktree (its own empty `data/`, not Josh's): its server
    started (`node --import tsx apps/server/src/index.ts`, the app's child). Closing the window: app
    and server both gone, :4410 closed.
- `npm test` (144 + 9 + 226 + 48, 6 skipped as before; `test/desktop-server.test.ts` included),
  `npm run typecheck`, `cargo test` in `src-tauri` (4), `npm run desktop:server` (bundle answered in
  228 ms, left 184 ms after stdin closed).

## Not checked

- The NSIS installer from CI with the server inside (the release after this push); an install on a
  computer that has never had Foundation or Node; the MSI; macOS and Linux.
- An agent turn on the built-in server (it was run on the Nov 9 build, not this one).
- The check build had :31450 added to its window's permissions for the test only; the shipped file
  admits :31440 alone, as before.
