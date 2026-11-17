# legacy-css: dead CSS out, raw colours ratcheted, no colour transitions

After screenshots of the board (`/?rafshim`, side pane open) and the whole `#/design` page (viewport grown to its 7828 px), day and night, 1440 wide, signed in as Ada via `POST /auth/dev` on a fresh data folder (server :16510, Vite :16530).

## How it was checked

The same Playwright script shot before and after the change. A canvas pixel diff (channel difference > 40) compared each pair:

| Shot | Pixels changed | Where |
|---|---|---|
| board-day | 62 | the pulsing "Live" dots (the animation was at a different point) |
| board-night | 0 | |
| design-day | 297 | the agent ring, the moving wire dashes, pulsing dots (animation) |
| design-night | 2655 | the same animations, plus pulsing crew/state dots |

Each changed region was cropped and compared by eye. Every one is an animation caught at a different point, not a change of style. Nothing else differs; the removed rules drew nothing.

An earlier pass changed the port bead's white gloss to `--color-raise`. The diff caught it at night: the beads went flat and dark. That change was reverted, and the gloss is listed in the allowlist, so night ports look as before.

## What changed

- **Dead rules removed (8, plus 1 `@keyframes`):** `.app-bar`, `.logo` with `@keyframes logo-in`, `.app-title` and `.app-hint` (the old toolbar); `.tb-plus`; `.sync-dot`, `.activity-empty` and `.stage-waiting`. A grep over the client's TS/TSX found no use of any of these classes, including in class names built from templates.
- **Raw colours replaced with tokens (6; 25 → 19 in the client):**
  - The background behind media (`#111`) is now `--color-panel`.
  - The lightbox shadow is now `--shadow-pane`.
  - The lightbox caption is now `--color-void` at 85%, so it reads on the frost scrim at night as well.
  - The map pin's shadow is now `--shadow-sheet`, and its pulse is `--color-bad` at 40%.
  - The sign-in inputs' inset shadow is now `--color-frost` at 6%. That is identical, because the sign-in is always day.
- **Colour transitions removed (11 → 0):** `background`/`color` is gone from the transitions on the gutter knob and line, the empty cell, the media-icon rail, the table heads and cells, the map shield, the floor edge, the top-bar buttons, the tabs and the ask body. The media-icon rail used to fade its background; it now fades on `opacity`, with the same 150 ms linger and the same look.
- **Ratchet:** `apps/client/test/design.test.ts` fails on:
  - any raw colour in client CSS/TS/TSX that isn't on the allowlist with a reason;
  - more than `CEILING = 19` raw colours in total;
  - a stale allowlist entry;
  - any component CSS `transition` that names `background`, `color` or `all`.

  Mask gradients are exempt because they only use alpha. The scanner, run on the previous commit's sources, counts 25 raw colours and 11 colour transitions.
