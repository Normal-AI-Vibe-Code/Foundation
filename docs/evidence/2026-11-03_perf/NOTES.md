# The performance budget, measured (2026-11-03)

`e2e/perf.spec.ts`. The board has 10 sections, 180 notes and 20 live app frames (`e2e/frame.html`, a canvas that draws every frame). In each case the page records every frame's time with requestAnimationFrame and counts long tasks. It runs in headless Chromium 156 at 1440×900 @1x, where WebGL is drawn in software, so read these as upper bounds. Raw numbers: `frames.json`. A Chrome trace of the run is written to `docs/evidence/e2e-results/perf-trace.json`; that folder isn't kept in git.

| Action | Frames | p50 | p95 | Longest | Frames > 33 ms | Long tasks | Live frames on screen |
|---|---|---|---|---|---|---|---|
| Pan (trackpad scroll, 3 s) | 712 | 16.7 ms | 16.8 ms | 33.4 ms | 2 | 1 | 4 |
| Pinch zoom (⌃ + wheel, 3 s) | 664 | 16.7 ms | 33.4 ms | 33.5 ms | 30 | 0 | 5 |
| Drag a card (2 s) | 294 | 16.7 ms | 16.8 ms | 99.9 ms | 3 | 2 | 5 |
| Pan with live frames running (3 s) | 678 | 16.7 ms | 33.4 ms | 50.1 ms | 38 | 0 | 8 |

**Reading it:**
- Pan and drag hold 60 fps.
- With live frames running, about 5–6 % of frames drop to 30 fps (p95 33 ms).
- Zooming re-rasterises text at each scale and drops a similar share.
- Picking up a docked card has one long frame (~100 ms): the card leaves the section's flow and the section lays out again.

The check fails if any p95 goes over two frames (34 ms) or any frame over 250 ms. All of these are next steps (SPEC §7), not done.
