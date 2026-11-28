# WebKit frames on a Character studio (2026-11-27, plan *webkit-frames*)

`apps/client/e2e/webkit-frames.spec.ts`: a Character studio seeded with 11 characters, 12 inspiration pictures and the
set's pipeline (nine nodes, their wires), measured in Playwright's WebKit 27.2 at 1440 × 900: at rest, a pan at the
opening zoom, zooming out and in, a pan after the zoom, a pan with the board fitted. **On a Mac it holds them**
(p95 ≤ 25 ms, long frames < 10 %, with `PERF_GPU=1`); elsewhere it records.

```sh
npx playwright install webkit
PERF_GPU=1 npm run e2e -w @foundation/client -- webkit-frames        # on the Mac: this is the run that counts
```

`frames.json` here is this Windows PC's run, and it is not the Mac's:

| measure | p50 | p95 | long frames |
|---|---|---|---|
| at rest | 49 | 58 | 100 % |
| pan, opening zoom | 76 | 104 | 100 % |
| zoom out and in | 16 | 107 | 27 % |
| pan after the zoom | 64 | 116 | 100 % |
| pan, board fitted | 30 | 79 | 56 % |

## Why Windows WebKit isn't the Mac's

Probed on a fresh studio (`p50` / `p95` ms, at rest and panning), one thing hidden at a time:

| hidden | at rest | pan |
|---|---|---|
| nothing | 40 / 46 | 57 / 71 |
| animations, canvases, SVG, wires, images, masks and filters, characters, pipeline nodes, the paper (each alone) | 43–49 / 46–62 | 63–68 / 71–94 |
| box shadows | 31 / 32 | 31 / 45 |
| the sections (their cards and shadows) | 31 / 32 | 18 / 30 |
| the grid's world | **16 / 16** | **16 / 16** |

A plain page in the same WebKit: 16 / 16. Stopping all three animation loops that run at rest (the paper's WebGL, the
agent layer's and the wire layer's ticks; they already skip writing when nothing changed) left the still studio at
42 / 52: on this port every frame composites the whole page in software whether anything changed or not, so its cost is
the amount painted (section shadows are half of it), not Foundation's work. JavaScript was 73 ms of 3 s at rest.
The Mac's WebKit composites unchanged layers for free (2026-11-24, on the Mac's own studio: 58.7 fps at rest, 60 panning).

Not done here: the Mac run, and the card's "last 40 → 60 at far zoom" (it can only be seen on the Mac's WebKit).
