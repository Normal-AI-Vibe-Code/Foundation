# The floor, session tabs, search on the right (2026-11-02)

Checked in the built-in browser at 1440×900 on an isolated copy (client :1440, server :4420, a `sqlite3 .backup` of `data/foundation.db`), signed in with dev login as a test user. Night and day.

| Shot | What it shows |
|---|---|
| 00 | The top bar on the paper: fold · the board tab · ＋ · tools on the right. No glass, no capsule |
| 01 | The side pane open: drawn on the dots, the cards fade out at its edge (mask), and the view slid right by half the pane |
| 02 | ⌘J: a new agent session tab. The session column sits on the floor beside the grid; the grid moves over |
| 03 | A real turn (Claude Code on the subscription, against the backup board): the agent called `set_plan`, the Goal card shows 0/3 with the active step, tool steps stream in, the tab took the ask as its title, and the session is listed in the side pane while it runs |
| 04 | Done: 3/3, every step listed (each ↗ names a card), the answer under it |
| 05 | Clicking "Wrote a note ↗" framed that note; the section and both notes the session touched wear violet rings |
| 06 | A Vision Code thread (LessCad MCP visibility) opened from the side pane: messages and steps read from T3's own store, "Open in Vision Code ↗", read-only note at the foot |
| 07 | ⌘F: search on the right. Before typing: recent files on the board (images as tiles) and the known apps. The grid masked and pushed left |
| 08 | "fan": board cards and files, matches highlighted, counts per filter |
| 09 | Dragged `fan-v3-shroud.step` onto the Floor test section: a file card lands where it was dropped (section count 2 → 3) |
| 10 | Day: a session and a widened search pane (edge dragged) at once, the grid between them |
| 11, 12 | `#/design` → The floor, composed from the real classes, day and night |

Not checked: a real trackpad; Vision Code links open T3's web UI, which asks for its own sign-in in a plain browser (the Vision desktop app opens threads natively). Screenshots in the browser pane lag a second or two behind springs and the floor's CSS transitions; every shot here was taken after it settled.

The mask needed its own compositor layer (`will-change: transform` on `.world-mask`): without it Chrome drew the cards unmasked under the pane.
