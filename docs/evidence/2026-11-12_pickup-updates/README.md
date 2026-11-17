# 2026-11-12 · Out of search into the hand, Flowform's files in search, and what updating needs

Josh: "Foundation needs to be able to read the same things as flowform in terms of the files that it has access too, I'd like to create a high physicality clipboard like experience where you can drag things from the search into Foundation." And: look into Flowform's auto-update and ours, so the client can update itself before it's distributed.

Checked in a browser at 1400×880 on its own server and data (`:24430` / `:24410`, a temp data dir), signed in by dev login as a test person holding a link and a kept session to a **stand-in Flowform** (`:24490`: `/mcp` with `list_rooms`, `room_catalog_v2`, `read_surface_v2` and `search`, the file-address route and the bytes, originals 1.8 s slow). Production Flowform was not touched: Josh's link and session were not borrowed.

| | |
|---|---|
| `01_design-out-of-search-night.jpg` | `#/design` → Out of search, into the hand: live rows and a tile to clip and pull, and the held card drawn still (lifted, over the grid, a stack of three, waiting) |
| `02_one-search-finds-flowform-files.jpg` | "hyperform" in the pane's one search (All): two Flowform pictures as tiles from Flowform's own thumbnails, a PDF tagged *flowform*, a Slack file tagged *slack*; the Flowform chip counts 4 |
| `03_picture-in-the-hand.jpg` | a picture pulled out of search: the card in the hand over the grid, its tile dimmed behind it |
| `04_landed-as-the-image.jpg` | let go over *Apps*: the file came from Flowform into the archive and the image card landed there |
| `05_put-down-waiting-for-its-file.png` | a second picture, 0.8 s after it was let go: flat on the board where it was put, waiting for its bytes |
| `06_three-on-the-clipboard.jpg` | three results clipped with Ctrl-click (✓ on each): the clipboard at the pane's foot, *All 3* and the cards |
| `07_stack-of-three-put-down.png` | the stack carried from the handle and let go: fanned, counted, waiting |
| `08_dealt-onto-the-board.jpg` | dealt: an image, a file card (PDF) and a link card; the clipboard is empty again |
| `09_a-rooms-files-in-place.jpg` | Search → Flowform: › on *Shop floor* opens its files in place, without bringing the room in |
| `10_day-clipped-from-a-room.jpg` | day: two clipped out of the room's files |
| `11_server-needs-a-newer-client-day.jpg` | the server set to `FOUNDATION_MIN_CLIENT=0.9.0`: the card stays up with Reload only; the board's tab reads *This device's copy* (its sync socket was closed 4426) |
| `12_needed-card-beside-search-night.jpg` | night, with search open: the card sits beside the pane, its tile in warn |

## What reading the two updaters found

**Flowform** (from the installed client's own strings, `C:\Program Files\Flowform\Flowform.exe`; its source isn't on this machine): it asks its own server for the feed (`/update/latest?platform=windows-x64|macos-arm64`, which answers 401 without its sign-in), checks at startup before the app is usable, downloads and runs its installer elevated and silently (`/S /UPDATEPID=<pid>`), relaunches with `--skip-startup-update`, keeps the old executable if the installer fails, and its server refuses clients under a minimum ("… is no longer supported. Update to the latest version to keep working."; the file routes answered 426 under 1.9.0 on 2026-11-11). An older Tauri build of it is also installed (`%LOCALAPPDATA%\FlowForm`), on `tauri-plugin-updater` 2.10.1, as Foundation is.

**Foundation**: `tauri-plugin-updater` against `https://github.com/joshleong/Foundation/releases/latest/download/latest.json`, minisign-checked, a person presses Update. The loop ran end to end on 2026-11-08 against a local feed. Today:

```
404 https://github.com/joshleong/Foundation/releases/latest/download/latest.json
404 https://github.com/Normal-AI-Vibe-Code/Foundation/releases/latest/download/latest.json
gh release list   (both)  → none
```

So no installed copy can update yet. What this session added is the piece Flowform has and Foundation lacked: a server can name the oldest client it still works with (`FOUNDATION_MIN_CLIENT`), and under it the update can't be put off. What only Josh can do is in SPEC.md, *Waiting on a person*.

## Tests

`npm test` on Node 22.22: client 112, server 186 (+6 skipped: the importer's uncommitted fixtures). New: `apps/client/test/pickup.test.ts` (5), `apps/server/test/clientversion.test.ts` (5, real sockets), `apps/server/test/flowformfiles.test.ts` (+3), `apps/client/test/update.test.ts` (+1). `npm run typecheck` clean.
