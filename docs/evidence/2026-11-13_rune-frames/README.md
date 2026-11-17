# Frame times: Rune beside the web renderer (2026-11-13)

`apps/client/e2e/rune-frames.spec.ts`, headed in Edge on this machine's GPU, 1440 × 900 at 2x, the
release build of Rune (`opt-level = 3`, 10.7 MB), each board drawn by each engine through the same
camera and the same input:

```sh
npm run rune:build
PERF_GPU=1 E2E_CLIENT_PORT=15450 npm run e2e -w @foundation/client -- rune-frames
```

Page frames are `requestAnimationFrame` intervals in ms; *long* is the share over one 60 Hz frame
(+25 %); LoAF counts Long Animation Frames. For Rune, the last column is the frames it drew and the
times its view ran during the measure.

| Board | Engine | Measure | p50 | p95 | longest | long | LoAF | Rune frames / view runs |
|---|---|---|---|---|---|---|---|---|
| 300 notes | web | at rest, fitted (3 s) | 16.6 | 16.7 | 16.8 | 0 % | 0 |  |
| 300 notes | web | fitted: pan (3 s) | 16.6 | 16.7 | 33.3 | 0.2 % | 0 |  |
| 300 notes | web | fitted: pinch (3 s) | 16.6 | 16.7 | 16.8 | 0 % | 0 |  |
| 300 notes | web | framed on a note: pan (3 s) | 16.6 | 16.7 | 33.3 | 0.2 % | 0 |  |
| 300 notes | web | framed on a note: pinch (3 s) | 16.6 | 16.7 | 16.8 | 0 % | 0 |  |
| 300 notes | web | a note dragged (2 s) | 16.6 | 16.7 | 16.8 | 0 % | 0 |  |
| 300 notes | rune | at rest, fitted (3 s) | 16.6 | 16.8 | 66.5 | 4.1 % | 6 | 7 / 8 |
| 300 notes | rune | fitted: pan (3 s) | 16.8 | 100 | 166.5 | 48.9 % | 181 | 434 / 206 |
| 300 notes | rune | fitted: pinch (3 s) | 33.2 | 149.8 | 166.5 | 51.5 % | 171 | 422 / 191 |
| 300 notes | rune | framed on a note: pan (3 s) | 16.7 | 83.3 | 116.6 | 36.3 % | 183 | 487 / 190 |
| 300 notes | rune | framed on a note: pinch (3 s) | 16.7 | 133.2 | 183 | 34.5 % | 138 | 366 / 147 |
| 300 notes | rune | a note dragged (2 s) | 16.7 | 83.2 | 116.6 | 34.6 % | 132 | 285 / 151 |
| heavy board (56 cards, 15 live apps) | web | at rest, fitted (3 s) | 16.6 | 16.7 | 16.8 | 0 % | 0 |  |
| heavy board (56 cards, 15 live apps) | web | fitted: pan (3 s) | 16.6 | 16.7 | 33.4 | 1.2 % | 0 |  |
| heavy board (56 cards, 15 live apps) | web | fitted: pinch (3 s) | 16.6 | 16.7 | 16.8 | 0 % | 0 |  |
| heavy board (56 cards, 15 live apps) | web | framed on a note: pan (3 s) | 16.6 | 16.7 | 16.8 | 0 % | 0 |  |
| heavy board (56 cards, 15 live apps) | web | framed on a note: pinch (3 s) | 16.7 | 33.4 | 97 | 17.2 % | 5 |  |
| heavy board (56 cards, 15 live apps) | web | a note dragged (2 s) | 16.6 | 16.8 | 18.9 | 0 % | 0 |  |
| heavy board (56 cards, 15 live apps) | rune | at rest, fitted (3 s) | 16.6 | 16.7 | 16.8 | 0 % | 0 | 7 / 7 |
| heavy board (56 cards, 15 live apps) | rune | fitted: pan (3 s) | 16.6 | 16.7 | 16.8 | 0 % | 0 | 568 / 193 |
| heavy board (56 cards, 15 live apps) | rune | fitted: pinch (3 s) | 16.6 | 16.7 | 16.9 | 0 % | 0 | 507 / 172 |
| heavy board (56 cards, 15 live apps) | rune | framed on a note: pan (3 s) | 16.6 | 16.7 | 16.8 | 0 % | 0 | 570 / 194 |
| heavy board (56 cards, 15 live apps) | rune | framed on a note: pinch (3 s) | 16.6 | 16.8 | 83.2 | 3.3 % | 18 | 471 / 146 |
| heavy board (56 cards, 15 live apps) | rune | a note dragged (2 s) | 16.6 | 16.7 | 83.2 | 0.4 % | 1 | 156 / 140 |

**What it says.** On 300 markdown notes the web renderer holds 60 fps through every measure and
Rune does not: a third to a half of its frames run long while panning, pinching or dragging. On the
heavy board, which is web content under either engine, they are level. Rune's view runs about once
for every camera step though only live values moved, and on every grain tick at rest; why is not
found yet (SPEC §7). `300-{web,rune}.png` and `heavy-{web,rune}.png` are the framed boards.

This run records; it holds neither engine to a number.
