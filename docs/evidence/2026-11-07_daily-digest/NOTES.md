# Daily digest — evidence (2026-11-07)

A note on the company board, once a day, saying what changed on the board and in the company's systems. Built on the server from the activity log, the board and the connectors; no model.

## How it was checked

- **Tests** (`apps/server/test/digest.test.ts`, 6): the exact markdown for a fixed activity log and two connector snapshots; one note a day (a second call the same day updates the same note, a restart doesn't add one, nothing before `FOUNDATION_DIGEST_HOUR`, the next morning's note goes first); the cap (16 days → 14 notes, the oldest two reused, a person's card in the section untouched); `FOUNDATION_DIGEST=0` writes nothing; a viewer's `write_digest` is refused, and a member's `request_id` runs it once.
- **A real browser**: our own server (:16910, fresh data dir) and Vite (:16930). Chromium from `@playwright/test`, signed in as Ada through `POST /auth/dev`.
  1. **Timer.** About 5 s after boot, the server's timer wrote the first digest by itself (`daily digest: wrote What changed · Sat 7 Nov` in the server log; local time 23:12, so after the 07:00 hour).
  2. **Restart.** Editing `digest.ts` made `tsx watch` restart the server, and the timer didn't write a second one, because today's row was already in SQLite.
  3. **Tool and request IDs.** Ada made a section and a note through the tool door. Then `POST /api/boards/company/tools/write_digest` with `request_id`, twice: both answers were `{did:"updated"}` with the same note id, and only one "updated" line went into the activity. A call without a `request_id` updated the same note again. The section holds one note, with `createdBy` unset, and the activity says `Foundation (system): wrote/updated the daily digest for Sat 7 Nov (asked by Ada)`. The full log is in `run.log`.
- Screenshots were framed on the section at 1440×900:
  - `01_digest-section-day.png`
  - `01_digest-section-night.png`

## What the screenshots show

- The first digest on the board: *the last 24 hours*.
- "On the board": Ada's 2 actions, and "nothing to compare yet" (no earlier snapshot).
- Each connector as this machine had it:
  - Vision and Creation live.
  - BomForm offline: no key and no Data Room copy.
  - FactoryForm offline: something on :3001 answered 404.
  - The Data Room reachable.
- First fix found here: italics were written `_…_`, which the note renderer doesn't support (it showed the underscores). They're `*…*` now.

## Not shown here

- A second day's note in the browser (comparisons, "no change", "offline since at least …", newest first): needs the clock moved. The tests cover it.
- **Ada shows as "(agent)"**. `touch()` in `tools.ts` logs every tool call with role `agent`, even a person's over HTTP. The digest reports the log as written, so the fix belongs in `touch()`, not here.
- No close-up of the note: Playwright's element screenshot found no visible `[data-obj-id]` match. The section shots show the whole note.
