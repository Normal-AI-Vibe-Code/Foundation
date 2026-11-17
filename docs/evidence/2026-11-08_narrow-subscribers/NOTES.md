# Narrow store subscribers, and live pages gated on the drawn scale (2026-11-08)

Two plan cards: **narrow-store-subscribers** (#64) and **fitted-frames-posters** (#60).

## 1. The board-wide layers read slices, not the store

`GridViewport`, `WireLayer` (table → map and formula wires), `PortWires` (the agent layer: app wires and agent rings), every `MapView` and `Present` read the whole store (`useAppState`). So did nothing else per card since `useSection` (2026-11-07), but these re-rendered on every change: each keystroke, each remote edit, each press. `PortWires` was worse. It also re-rendered on **every move of your own pointer**, because publishing your cursor to awareness notified every `useBoardTick` subscriber.

**The change**
- `src/state/slices.ts`: `useStoreSlice(select, equal)` runs a selector once per store change and re-renders only when the result changes (shallow by default; strings by value). Selectors:
  - `gridViewSlice`: tracks, sections, focus level, active section, open section, framing request, section-drop highlight.
  - `sheetWiresSlice`: a signature of which tables and maps exist, which table each map reads, and their sections. The per-frame geometry already read the store itself, so its effect now restarts only when the set of wires changes, not on every card move.
  - `portWiresSlice`: links, plus a signature per link (live, port type, both sections) and which apps are running.
  - `tableOptionsSlice`: a map's table picker (ids and names).
- `WireLayer` and `PortWires` are `memo` (they take no props), so a grid render (a press that moves the active section) doesn't render them.
- `PortWires` reads other people's focus as a signature (`usePeerFocus`), not through `useBoardTick`. A wire drag renders on start, snap, unsnap and end, not on every pointer move; the ghost path is already drawn per frame. The hover tip is its own component on `usePanel`, so its value stays live.
- `sync/board.ts` no longer notifies listeners on **local** awareness updates (your own cursor, caret, focus). Nothing in the client draws its own awareness: `peers()` and `noteCarets()` leave it out. Remote updates still notify. This also stops `PeerCursors`, `CrewCursors`, `CrewGuide`, `TopBar`, `Talk` and the side pane's activity from re-rendering on each of your own pointer moves. Those weren't counted, so that part is a reading of the code, not a measurement.
- `Present` subscribes to `sections` only; while presenting it also reads its slides' card counts.

**Counted.** `src/state/renders.ts` keeps `window.__renders` in the dev server and e2e builds; it is a no-op in a shipped build. `e2e/renders.spec.ts` builds 26 notes in two sections, a table bound to a map, and two apps wired together. It counts renders per gesture and now **asserts** that the board-wide layers stay still. Dev server, StrictMode, so each render counts twice. Before = `origin/main` (a0b359b) plus only the counters (a separate worktree); after = this branch. Every run gave the same counts (before: 4 runs; after: 3):

| Gesture | Before | After |
|---|---|---|
| Press a card | GridViewport 2, WireLayer 2, **PortWires 4**, **MapView 4**, Present 2, SectionView 4–10, the card 2 | GridViewport 2, SectionView 4, the card 2 |
| Drag a card (60 moves) | **PortWires 122–128**, GridViewport 6, WireLayer 6, MapView 6, Present 6, SectionView 6, the card 26 | SectionView 6, the card 26 |
| Type 30 characters in a note | **GridViewport 60, WireLayer 60, PortWires 62, MapView 60, Present 60**, SectionView 60, the note 60 | SectionView 60, the note 60 |
| Pan (60 wheel events) | 0 (PortWires 2 once) | 0 |
| Pinch zoom (60 ctrl-wheel) | MapView 12 (its shield as zoom crosses 1), PortWires 0–2 | MapView 12 |
| 10 edits by someone else, a note in another section | **GridViewport 20, WireLayer 20, MapView 22, PortWires 28–34, Present 20**, SectionView 20, the note 20 | SectionView 20, the note 20, PortWires 2 (the server's ring on the card it touched) |

Every keystroke used to render all five board-wide layers; now it renders only its own section and card. A card drag used to render the agent layer about once per pointer move (it was the cursor, not the drag); now it renders nothing outside the section. The renders that remain are the section's and the card's own (`useSection`, unchanged).

`test/slices.test.ts` holds the selectors to this in Node: typing, dragging a note and moving an app leave every slice equal. Pressing changes only the grid's `activeSectionId`, and a second card in the same section doesn't change it. Binding a map, a wire going live and an agent running do change them.

**Frame times (`e2e/perf.spec.ts`, 180 notes + 20 live frames).** Headless Chromium, SwiftShader, dev server, on Josh's Windows machine while other sessions were building and testing. Three runs each, before and after interleaved (`runs/`, plus `before/` and `after/`). Round 2 of the interleave lost its perf run to API timeouts under load.

| Action | Before: p95 / longest / frames > 33 ms (3 runs) | After: p95 / longest / frames > 33 ms (3 runs) |
|---|---|---|
| Pan | 33.4–33.5 / 50–1,217 / 6.3–10.2 % | 33.4 / 50–67 / 5.0–6.6 % |
| Pinch zoom | 33.3–33.4 / 50–2,833 / 1.7–3.6 % | 16.8–33.3 / 83–3,017 / 0.9–2.6 % |
| Drag a card | 33.4 / 50–100 / 4.8–9.9 % | 33.4 / 50–67 / 5.5–8.3 % |
| Pan with live frames | 50.1–66.6 / 83–2,367 / 25–32 % | 50 / 67–2,017 / 26–29 % |

Renders per action in the same runs: the drag went from 246–248 `PortWires` renders plus 6 each for GridViewport, WireLayer and Present, to 0. Pan, zoom and live-frame pan went from 2–8 `PortWires` renders to 0.

**Honest reading:** on this contended machine the frame times are within noise of each other. The multi-second "longest" frames are the box stalling under other sessions' load, and they show up on both sides. p50 is 16.7 ms for both. The render counts are the measurable result; the frame-time win should show on a big board on a real GPU (`PERF_GPU=1 … frames`), which this session did not run. `perf.spec`'s absolute budget failed on both sides here (pan with live frames p95 50 ms against < 34), the same way it failed before this change on the cloud box (2026-11-07).

## 2. Live pages: the gate is the drawn scale (zoom × fit)

**What it was.** `useOnScreen` (PanelView) mounted a live body when it was on screen and the camera's zoom was ≥ 0.3 (0.25 for Slack, huddles and machines; 0.2 for file previews; 0.12 for connectors), whatever its section's fit. Two faults:
1. A page in a crowded section fitted to 49 % ran at zoom 0.52, though it was drawn at 26 %: costly and unreadable.
2. `bigEnough` started `true` and was only corrected on the camera's next move. So at load every page on screen mounted, whatever the zoom.

**The change.** `store.drawnScale(zoom, sectionId)` = zoom × the section's resting fit (`sectionFlow().fit`). A hosted app isn't fitted, so it gets 1, and so does an expanded section. `useOnScreen` finds whether its element sits in a section's flow (`.section-content`) and in which section. It checks at mount, on each camera frame, and on store changes (the fit moves when cards come and go). `test/drawn-scale.test.ts` covers roomy, crowded, hosted and expanded.

**Checked in the browser** (`e2e/fitted-frames.spec.ts`). A roomy section (a note and a page) and a crowded one (the same plus 24 notes, fit 0.488):

| | Zoom | Drawn at | Before | After |
|---|---|---|---|---|
| Crowded page | 0.52 | 0.26 | **live** | poster |
| Roomy page | 0.52 | 0.52 | live | live |
| Crowded page | 0.80 | 0.39 | live | live |

Before fails the check on the first row; after passes (`fitted-before/`, `fitted-after/`, with screenshots).

**The report on the company board** ("a page in a section fitted to about 27 % stays a poster", SPEC §7) was not reproduced; that board's data isn't on this machine. Under the new rule that page *should* be a poster below zoom 1.1 (0.3 / 0.27). Under the old rule it would have been live at any zoom ≥ 0.3, so it most likely really was zoomed out below 0.3 (the card's own guess).

**Seen along the way, not changed:** once a page has loaded, `LiveFrame` keeps it mounted (`everLive && loaded`) when it scrolls off or the zoom drops, so it needn't reload. So "≤ the frames on screen" in SPEC §5 is really "≤ the frames that have been on screen". The perf run's live-frame pan ends with 8 mounted.

## How it was checked
- `npm test` (client 76, server 104 + 6 skipped) and `npm run typecheck`: green.
- `e2e/renders.spec.ts` and `e2e/fitted-frames.spec.ts`: pass on this branch and fail on `origin/main` for the reasons above. The renders check also asserts that both wire layers still draw their wire (`after/board-with-wires.png`).
- The whole e2e suite on this branch (ports 16431/16441/16451): 33 passed, 2 skipped by design (`dragging onto an empty cell after a split`; `frames.spec` without `PERF_GPU`). `perf.spec` failed its absolute budget (pan p95 over 34 ms on that run), as it does on `origin/main` on this machine. Two people's pointers, shared carets, huddles, crew cursors and sections moved and split all pass with local awareness no longer notifying.
