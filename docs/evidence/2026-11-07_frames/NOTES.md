# Every surface at 60 fps, measured on a real GPU (2026-11-07)

Josh: "The ascii loading performance is very slow on the login … optimize the
speed so that every interface is at 60fps minimum."

## How it was measured

`apps/client/e2e/frames.spec.ts`, new. Headed Edge 157 (the engine WebView2,
and so the desktop app, runs on), on this machine's own GPU, at 2× pixels:

- Windows 11, AMD Ryzen 7 7800X3D, **NVIDIA RTX 5080** (the wind's context
  reported `ANGLE (NVIDIA … RTX 5080 … Direct3D11)`), one 3008×1692 @2×
  display at 60 Hz.
- The browser's own clocks, not ours: `requestAnimationFrame` intervals for
  the page, Long Animation Frames (LoAF) for what blocked it, and the wind's
  own glyph-pass draws (a wind can draw at 10 fps while the page holds 60,
  which reads as slow; the old perf trace couldn't see that).
- The same 200-card board as `perf.spec.ts` (10 sections × 18 notes + 2 live
  frames), and the sign-in signed out: arriving, at rest, the cursor stirring,
  presses, typing, the board loading behind, the dissolve.
- Budget: p95 frame ≤ 16.7 ms × 1.25 and ≤ 5 % of frames over; the wind
  ≥ 55 fps while it runs.

```
PERF_GPU=1 npm run e2e -w @foundation/client -- frames               # dev server
E2E_BUILD=1 PERF_GPU=1 npm run e2e -w @foundation/client -- frames   # production build
# here: E2E_SERVER_PORT=24430 E2E_CLIENT_PORT=21450 E2E_SLACK_PORT=24440 (Windows reserved :1450)
```

| Folder | What |
|---|---|
| `before/` | `main` (with the build fix), dev server, 1440×900 @2× |
| `after-dev/` | this change, dev server, 1440×900 @2× |
| `after-build/` | this change, production build, 1440×900 @2× (+ screenshots) |
| `after-build-2560/` | this change, production build, 2560×1400 @2× (canvas 6149×3380) |
| `after-merge-build/` | the same on `main` after merging the per-section store slice and machines: 0 frames over on every board surface, wind 60 fps |
| `profile-before.json` | CPU profiles (CDP, 100 µs sampling) of the slow interactions on `before` |

## What was wrong, and the evidence for each

1. **The wind ran at 10 fps** (at rest, stirred, pressed) and ~1 fps while
   typing, while the page held 60 (`before/frames.json`). One wind frame costs
   this GPU ≈ 0.1 ms, so it wasn't the GPU: the pacing drew at 25 fps on a
   timer, and counted the page's own busy frames (React mounting, the shaders
   linking at boot) as the wind being late. One busy second at sign-in put it
   in a 12 fps backoff it never left; the next one suspended it (it faded
   out). Now: every display frame; it backs off (30 → 15 fps → suspended) only
   on its own GPU fence still unsignalled three frames on, or its draws
   costing > 4 ms; and it steps back up after 180 drawn frames of keeping
   up (6 s at 30 fps). `state()`
   reports its level and why it last backed off; the check records it.
   - A false alarm on the way: reading the fence one frame on said "behind"
     of a GPU that wasn't (fence status only updates between tasks). Read
     three frames on.
2. **Opening the side pane, search or ⌘K: one 388 ms task** (LoAF:
   `Shell.tsx onkeydown`). The CPU profile: 377–398 ms self time in
   `getBoundingClientRect`, all under `publishCamera` (`state/camera.ts`),
   which read the viewport's rect on every camera spring frame and forced a
   layout of the whole board each time. Now measured by a ResizeObserver.
3. **The same open/close still dropped 24 % of frames with no long task**:
   rendering, not script. `--floor-l/-t/-r` were registered `inherits: true`
   and transitioned on `.grid-viewport`, so every card restyled on every
   frame of the 0.42 s slide. Now non-inherited and set on `.world-mask`
   only (the only reader). 24 % → 2.6 % (dev) → 0 % (build).
4. **The dissolve dropped frames to the board loading under it** (the sync
   message ~90 ms, then React ~120 ms, mid-animation). It now waits for the
   board to be live and six frames on time (max 2.5 s), with the wind still
   turning; measured apart, the dissolve is 0 frames over.
5. The wind's reveal took 4 s (the Details original's), which read as a slow
   load at 10 fps; now 1.6 s. Page hooks (holes, frame, dissolve) drew at
   once, twice per frame while the frame opened; now once, on the next frame.

## Results (production build, 1440×900 @2×)

Every gated surface: p95 ≤ 16.8 ms. Board pan, zoom, drag, 20 live frames,
panes, framing: **0 frames over**, longest 17.3 ms. Wind at 60 fps in every
state. First wind frame 1.1 s after navigation. At 2560×1400 @2×: ≤ 1.9 %
over, longest 33 ms. Full table in SPEC §5.

## Not covered / still open

- **The board's first load is one 100–150 ms burst** (sync + React rendering
  every section). Reported, not gated; signing in waits for it now. A
  yielding first render would remove it (SPEC §7).
- On the **dev server** React's development build makes a card pick-up
  120–190 ms and a framing key 55–70 ms; the build has neither.
- **Only a fast GPU.** The integrated Radeon here wasn't measured (Edge used
  the RTX), nor a Mac. The backoff is what protects a weak GPU; it's untested
  on one.
- `#/design` wasn't measured (a reference page, not used day to day).
- The check needs a GPU and a display, so it can't run in CI as is.
