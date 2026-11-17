# 2026-11-09 · One line for the window, the orb top right, pan from anywhere

Josh asked for three things: pan everywhere by holding the middle or right mouse button, a light mode switch at the top right, and the top bar redesigned so the menu and tabs share one line with minimize, maximize and close.

| File | What it shows |
|---|---|
| `01_board-night-orb-top-right.jpg` | The board at night: the orb is the last thing in the top bar |
| `02_board-day-orb-top-right.jpg` | After pressing it: day, with its label *Switch to night* |
| `03_design-bar-window-controls-day.jpg` | `#/design` → The floor: fold, tabs, tools, orb, a hairline, then minimize, maximize and close on the same line |
| `04_design-bar-window-controls-night.jpg` | The same at night |

## Pan

Checked in the browser (a test server with its own data, :24430) with pointer events sent to a connector card:

- middle button held and dragged 120 px: the grid moved with it (`.world` transform changed), over the card
- right button the same; `.panning` on while dragging, off after; the menu its release would have opened stayed shut
- right-click without moving: the grid didn't move, the section's menu opened
- left drag on the card: the grid didn't move (unchanged)

## The window

`apps/client/src-tauri/src/lib.rs` opens the window without the system frame (`decorations(false)`; on a Mac, an overlay title bar with the title hidden). The port-taken page, which has no bar of its own, keeps the frame. `shell/WindowControls.tsx` draws the three buttons and moves the window from the top 44 px; the capability gained `allow-minimize`, `allow-toggle-maximize`, `allow-close` and `allow-start-dragging`.

**The real window, on Windows** (2026-11-10): Josh ran it under `tauri dev` and confirmed dragging by the bar, the three buttons and resizing by the edges. Not checked: a Mac and Linux. (`npm run desktop` itself failed here on a stuck port 1430; the window was started on :15430, see SPEC §7.)

## Checked with

`npm test` (client 100; server on Node 22.22: 162, 156 pass, 6 skipped), `npm run typecheck`, `cargo check`. Not re-run: the Playwright e2e suite and the GPU frames check.
