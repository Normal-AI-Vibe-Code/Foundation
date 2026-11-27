# Rune holds the web renderer's frames on 300 notes (2026-11-27, plan *rune-frame-cost*)

`apps/client/e2e/rune-frames.spec.ts`, headed Edge on this machine's GPU, 1440 × 900 at 2x, Rune's release
build. Before (2026-11-13, `../2026-11-13_rune-frames/`): on 300 markdown notes Rune's p95 was 83 to 150 ms
panning, pinching or dragging, and its view ran about 200 times in a 3 s pan though only the camera moved.

```sh
npm run rune:build
PERF_OUT=2026-11-27_rune-frames PERF_GPU=1 E2E_CLIENT_PORT=15450 E2E_SERVER_PORT=15630 E2E_SLACK_PORT=15640 E2E_MESHY_PORT=15645   npx playwright test -c e2e/playwright.config.ts rune-frames      # from apps/client
```

Frames in ms (requestAnimationFrame intervals); *long* is the share over 20.8 ms; LoAF counts Long Animation
Frames; *travel* is the path the camera went (px) and how much it zoomed (summed |log|); for Rune, frames drawn / view runs.

| Board | Engine | Measure | p50 | p95 | longest | long | LoAF | travel / zoom | Rune frames / views |
|---|---|---|---|---|---|---|---|---|---|
| 300 notes | web | at rest, fitted (3 s) | 16.6 | 16.7 | 16.8 | 0 % | 0 | 0 px / 0 |  |
| 300 notes | web | fitted: pan (3 s) | 16.6 | 16.7 | 33.3 | 0.2 % | 2 | 4448 px / 0 |  |
| 300 notes | web | fitted: pinch (3 s) | 16.6 | 16.7 | 66.6 | 0.7 % | 2 | 28923 px / 8.45 |  |
| 300 notes | web | framed on a note: pan (3 s) | 16.6 | 16.7 | 16.8 | 0 % | 0 | 4448 px / 0 |  |
| 300 notes | web | framed on a note: pinch (3 s) | 16.6 | 16.7 | 16.9 | 0 % | 0 | 38859 px / 6.76 |  |
| 300 notes | web | a note dragged (2 s) | 16.6 | 16.7 | 83.2 | 2.2 % | 2 | 0 px / 0 |  |
| 300 notes | rune | at rest, fitted (3 s) | 16.6 | 16.7 | 16.8 | 0 % | 0 | 0 px / 0 | 8 / 1 |
| 300 notes | rune | fitted: pan (3 s) | 16.6 | 16.7 | 16.8 | 0 % | 1 | 4448 px / 0 | 729 / 0 |
| 300 notes | rune | fitted: pinch (3 s) | 16.6 | 16.7 | 50 | 0.3 % | 2 | 28923 px / 8.45 | 641 / 4 |
| 300 notes | rune | framed on a note: pan (3 s) | 16.6 | 16.7 | 16.8 | 0 % | 0 | 4448 px / 0 | 631 / 0 |
| 300 notes | rune | framed on a note: pinch (3 s) | 16.6 | 16.7 | 66.6 | 0.3 % | 1 | 38859 px / 6.76 | 524 / 3 |
| 300 notes | rune | a note dragged (2 s) | 16.6 | 16.7 | 16.8 | 0 % | 0 | 0 px / 0 | 138 / 4 |
| heavy board | web | at rest, fitted (3 s) | 16.6 | 16.7 | 16.8 | 0 % | 0 | 0 px / 0 |  |
| heavy board | web | fitted: pan (3 s) | 16.6 | 16.7 | 33.3 | 0.4 % | 1 | 4448 px / 0 |  |
| heavy board | web | fitted: pinch (3 s) | 16.6 | 16.7 | 83.2 | 0.2 % | 1 | 28923 px / 8.45 |  |
| heavy board | web | framed on a note: pan (3 s) | 16.6 | 16.7 | 16.8 | 0 % | 0 | 4448 px / 0 |  |
| heavy board | web | framed on a note: pinch (3 s) | 16.6 | 16.7 | 16.8 | 0 % | 0 | 8484 px / 6.76 |  |
| heavy board | web | a note dragged (2 s) | 16.6 | 16.7 | 16.8 | 0 % | 0 | 0 px / 0 |  |
| heavy board | rune | at rest, fitted (3 s) | 16.6 | 16.7 | 16.8 | 0 % | 0 | 0 px / 0 | 8 / 1 |
| heavy board | rune | fitted: pan (3 s) | 16.6 | 16.7 | 16.8 | 0 % | 1 | 4448 px / 0 | 552 / 0 |
| heavy board | rune | fitted: pinch (3 s) | 16.6 | 16.7 | 33.3 | 0.2 % | 0 | 28923 px / 8.45 | 489 / 4 |
| heavy board | rune | framed on a note: pan (3 s) | 16.6 | 16.7 | 16.8 | 0 % | 0 | 4448 px / 0 | 563 / 0 |
| heavy board | rune | framed on a note: pinch (3 s) | 16.6 | 16.7 | 16.8 | 0 % | 0 | 8484 px / 6.76 | 403 / 3 |
| heavy board | rune | a note dragged (2 s) | 16.6 | 16.7 | 33.3 | 0.4 % | 1 | 0 px / 0 | 143 / 0 |

The spec now holds this: each Rune measure's p95 within 4 ms of the web's on the same board, and at most one
view run in a pan. `300-rune-fitted.png` is far zoom, a note's lines drawn as bars; `300-web-fitted.png` caught
the web page before it had drawn (no bar, no cards), so it is no comparison.

## What it was, found and fixed

1. **Rune's view ran on every live value set from outside a handler, on the web only.** A probe build of Rune
   counting why each commit ran (`CommitWhy`) said every one was `dirty`: the web host's app wake, with no
   update queued, called `invalidate()`, so the camera, the paper's nudge and the grain tick each rebuilt the
   300 notes' view. Headless runs (`apps/rune/tests/frames.rs`) never showed it. Upstream fixed it on 2026-11-23
   (`c860a86c`, "a live value draws once"): Rune's pin moved from `a3669283` to it, with no change to our code.
2. **The accessibility mirror** was rebuilt up to ten times a second while things moved, every markdown span
   and every unlabelled tool button on 300 cards serialised and restyled. A card at rest is now one item (an
   article, its name, its words as the description); the card in hand or being written keeps all its inside.
3. **A note carried** re-ran the view on every move (its offset was state). It follows a live value
   (`Board::hand`) and the view runs as it lifts.
4. **Far out, every glyph was set every frame.** Past `FAR_ZOOM` (0.35) a note's lines are bars (`Scene.far`,
   SCENE_VERSION 6), which the client flips only when the camera crosses: a pinch across it costs one longer frame.

A profile of the fitted pan after (1) alone: 25.6 s sampled, 3.5 s in `syncA11y` and about as much again
serialising the mirror, 2.6 s in Rune's `build`; after (2) the mirror was 0.4 s and `build` (glyphs) led,
which (4) took off. `RUNE_FRAMES_PROFILE=1` prints it.
