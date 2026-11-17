# 2026-11-02 · Flowform sign-in + import

| File | What it shows |
|---|---|
| `cli-run.txt` | `npm run import:flowform` on the fixture backup (packed like Flowform's `current.tar.gz`). The dry run writes nothing. Run 1 imports 2 boards: 3 members, 3 sections, 13 cards, 4 files (1 archived), 1 missing media. Run 2 is all `unchanged` and makes no board writes. The extraction is removed afterwards. The import refuses to run while the server is up |
| `access.txt` | Over HTTP against the running server. Sam (editor) lists, syncs (101), reads and searches the imported board. Rin (allowlisted, not a member) gets 404 / 401, 0 files and no search hits |
| `signin.txt` | The live hand-off: Foundation → `server.formresearch.ai/auth/google/start` → Google with PKCE. Google's own page is the person's |
| `01-overview-night.jpg` | The imported "Overview" canvas: the sticky (with the edit from `updates.log`), rich text flattened (lists, link, quote, code), the image (source rendition), the Parts table (labels → header row) and the to-do list |
| `02-shop-floor-night.jpg` | "Shop floor": the late note, video, STEP card with its header text, the app and link panels, and the missing-media note |
| `03-overview-day.jpg` | Overview in day mode |

The fixture rooms (`apps/server/test/fixtures/flowform/data/rooms`) were written by Flowform's own card writers with yrs 0.28; the generator stays outside this public repo. `flowform.db` holds just the tables and columns the importer reads (`backup.ts`). The video is black because the fixture bytes aren't a real MP4.
