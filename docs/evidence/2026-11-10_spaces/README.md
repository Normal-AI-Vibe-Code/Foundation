# 2026-11-10 · Spaces: what a tab is, where things are filed, what belongs to a space

Josh: the architecture was disorganized. The tab system should only make new grid spaces, or canvases that aren't a grid (presentations, web page apps). The left panel should file them by most recent or in project folders. What is specific to a grid (people, activity) should be a different panel with its own icon, attached to the tab. A new session should be the AI conversation, opened from the bottom bar. Scroll bars should be invisible until used: thin half-opacity rectangles.

| File | What it shows |
|---|---|
| `01_spaces-pane-folders-day.jpg` | Five spaces open as tabs (the company, grids, a web page). The spaces pane on **Folders**: *Fans* holding a grid, the rest under *Not in a folder*. ＋ and its caret after the tabs; ✦ Ask in the bottom bar |
| `02_space-info-and-session-night.jpg` | The open space's own pane (name, canvas, folder, counts; here now; who can change it; activity) and, beside it, the agent's conversation opened from **Ask** (ringed violet), with its ◷ ＋ ✕ tools. Still three tabs: the session isn't one |
| `03_web-page-space-night.jpg` | A web page space: the page fills the canvas, the pane shows its address, the bottom bar keeps its strip |
| `04_design-floor-demo-day.jpg` | `#/design` → The floor, redrawn: space tabs with the ⓘ, the Folders tree |

## Checked in the browser (a test server with its own data, :24430)

- ＋ twice: two new grid spaces, each opened in its own tab, ids `untitled-grid`, `untitled-grid-2`; one section each
- a folder *Fans* made, the open space moved into it with ▱: the tree shows it one level in, and `/api/boards` returns `folder: "Fans"`
- ⓘ on the tab: the space's pane replaces the spaces pane (This space, Here now, Who can change it, Activity); renaming there renamed the tab
- Ask: the session column opened (no tab added), ◷ listed this space's sessions and Vision Code's threads, ✕ put it away
- caret → Web page: a page space opened with the iframe in the app sandbox
- scroll bars on the side pane: thumb clear at rest, `frost / 0.5` with radius 0 while scrolling (`.is-scrolling`), clear again 0.9 s later
- day and night

## Checked with

`npm test` on Node 22.22 (client 102; server 167: 161 pass, 6 skipped), `npm run typecheck`.

`E2E_CLIENT_PORT=15450 npm run e2e -w @foundation/client`: 40 passed, 2 skipped (the GPU frames check, which needs `PERF_GPU=1`; a drop with no empty cell), after two specs were edited to the new shape (`build.spec`, `crew.spec`). **Not re-run:** the GPU frames check, the desktop window. **Stubs and gaps** are in SPEC §7: a presentation is a seeded grid; a page that forbids framing shows blank.
