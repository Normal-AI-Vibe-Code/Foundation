# 2026-11-11 · Flowform rooms and files, live through the link

Josh connected Flowform (Settings → Services) and asked to carry on: bring Flowform's boards in and keep them connected, and drag Flowform's files out.

| File | What it shows |
|---|---|
| `01_flowform-rooms-night.jpg` | Search → **Flowform**: Josh's six rooms as Flowform lists them for him (Engineering Room 265 files … Simulation, owner) |
| `02_room-brought-in.jpg` | Form Industries pressed: it opened as its own board in a tab, and the row says *Here, 57 cards · checked just now* with ↻ |
| `03_board-layout.jpg` | The board: the room's plane as one section, its 57 cards at their Flowform positions |
| `04_contracts-table.jpg` | *Multi-Family Contracts* came across with its cells, and Foundation's search finds it by them. Beside it, a Flowform table of the older kind, which its tools return without rows, as a named note |
| `05_flowform-file-search.jpg` | Typing *stacked airform max loop*: Flowform's own ranking (Slack, Figma), its matches drawn as Foundation's marks |
| `06_dragged-slack-file.jpg` | *STACKED AIRFORM MAX LOOP.jpg* dragged out: a link card to its Slack address |
| `07_flowform-rooms-day.jpg` | The rooms in day |
| `08_pulled-again-day.jpg` | ↻ read the room again: the 27 image notes written before a wording fix updated in place (0 left of the old text) |

## How it was checked

On a **throwaway copy** of Foundation's data (its own server on :24430 and client on :24431, deleted afterwards). Josh's account isn't on the dev-login allowlist and a session wasn't forged, so in the copy only, the test user Ada borrowed Josh's read-only link. Every answer above came from the real `server.formresearch.ai` as Josh. **Nothing was brought into Josh's own Foundation**: that's his press.

Before building, the link's tools were read: 12, all reading (`search`, `list_rooms`, `room_catalog(_v2)`, `read_canvas`, `read_surface_v2`, `read_primitive(_v2)`, `resolve_surface_v2`, `inspect_layout(_v2)`, `read_frame_v2`). Their shapes (rooms; a plane with Grids and pages; cards with center-based rects, text, to-do items, table rows, iframe URLs, media `{file_id, revision_id, byte_size}`) are what `test/flowform-live.test.ts`'s stand-in answers.

## What doesn't come through

The files themselves. Flowform's tools say they never return URLs or storage keys, and `GET /me/files/<file>/revisions/<rev>/url?role=…` answered **401 "missing bearer"** to the link's token (only the status was read). So images, videos and files in a room arrive as a note naming them with their size, and a Flowform file dragged out is a link card (Slack, Figma) or a note. SPEC §7 has the two ways to close it; it's Josh's call (plan card `flowform-file-bytes`).

## Checked with

`npm test` (client 106 pass; server 179: 173 pass, 6 skipped, the backup importer's fixtures), `npm run typecheck`, `node scripts/plan.mjs check`. Not run: the Playwright e2e suite and the GPU frames check.

## Later the same day: file downloads (Josh chose "Keep Flowform session")

| File | What it shows |
|---|---|
| `09_allow-file-downloads-day.jpg` | Settings → Services: under the Flowform row, *Flowform · file downloads*, not allowed, with **Allow file downloads** and what it keeps |
| `10_allow-file-downloads-night.png` | The same at night |

The button's request answered with Flowform's own `https://server.formresearch.ai/auth/google/start`, returning to `/auth/flowform/done/<nonce>` (checked on the throwaway copy, not followed: it needs Josh's Google sign-in). `test/flowformfiles.test.ts` (5) runs the rest against a stand-in. **Not seen against production yet**: which rendition name Flowform's download route takes, and real bytes. `npm test`: client 106; server 184 (178 pass, 6 skipped). Typecheck clean.

## Against production (Josh signed in through Flowform)

| File | What it shows |
|---|---|
| `11_form-industries-with-its-files.jpg` | Form Industries in Josh's own Foundation: its 27 images and 4 videos (158 MB) arrived in about 30 s, and its cards are them |
| `12_matterform-files-arrived-live.jpg` | MatterForm brought in while watching: its images and video replaced the stand-in notes without a reload |

What production said on the way: `426 "Flowform 1.9.0 or newer is required"` until the request named a client version (`x-flowform-client-version`); renditions `source`, `display`, `playback`, `thumbnail` (anything else `400 unsupported asset role`); an older image had no `source` (`404 file rendition not available`) but its `display` was the full 6,560,408-byte file. A file card names its file at the top level, not under `media`. A STEP file came with no filename (no Content-Disposition, and its own header says only "Open CASCADE Shape Model"), so it's *Flowform file d0fb64c9.step*. A 3D model card had no file at all in Flowform.

Also found and fixed: a card whose kind changes (note → image) showed twice in the open board until a reload (`apps/client/src/sync/board.ts`). Checked: `npm test` (client 106; server 184: 178 pass, 6 skipped), typecheck.
