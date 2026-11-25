# The Character grid: what it cost, and what it costs now (2026-11-25)

Josh: "performance improvements for all the grids, particularly the Character Grid … cache the images of the 3D
characters and be much smarter on progressively rendering them, using fading or animations … fundamental
performance improvements."

## How it was measured

- A **copy** of the real data (`vacuum into` of `foundation.db`, plus `data/files` and `secret.key`), served by this
  worktree's own server on :15511; the client a **production build** (`vite build`, `vite preview` on :15531), one
  build made before any change and one after. The real server and data were never touched.
- Headed **Edge 158** (WebView2's engine) on this machine's **RTX 5080**, 1440×900 at 2×, a fresh profile per run
  (`scripts/measure.mjs`; the raw results are in `numbers/`).
- Frames are `requestAnimationFrame` intervals in the page; "over" is the share above 20.8 ms (a 60 Hz frame + 25 %);
  "long" is long tasks (> 50 ms on the main thread) during the sample; script time is CDP `ScriptDuration`.
  Requests and bytes are the page's own picture and avatar requests (`requestfinished`, body sizes). Layers are CDP
  `LayerTree`. Each sample is one run of 2–5 s: read differences of a frame or two as noise.
- The studio here: 12 sections, 68 cards, 12 character cards. **All 12 are mesh avatars** (the six 3D-model
  characters in the data have no card on the board), so the model path was checked in the e2e harness with the
  stand-in's skinned GLB (`e2e/council.spec.ts`), not on real data.

## What was already there (the merge brought it)

The tiered pictures and the two-level cache were working before any change here: a cold load is **57 requests,
2.99 MB** (6 at 64 px, 38 at 256, 12 at 512, and one 2.07 MB mesh avatar), **no originals**; a reload is **0 requests,
0 bytes**. Pan and zoom on an ordinary grid (`company`, 2,042 nodes, no pictures) hold 60 fps with no long task.
None of that was rebuilt.

## What was wrong

1. **Every character card on screen played, and opening a mesh avatar blocks the page.** The mesh-avatar runtime
   reads its portrait's pixels and builds its mesh in one task: **170–555 ms** each (the long tasks below all name
   its loader). Cards started as they came on screen and were destroyed as they left, so panning to the characters,
   panning over them and zooming each ran several of these: 19–31 WebGL contexts made and thrown away in one pass.
2. **At rest, five live mesh avatars kept the main thread 70 % busy** (1,409 ms of script in a 2 s sample at rest,
   5,687 WebGL draws) for cards nobody was pointing at. It held 60 fps on this GPU; it is the whole frame budget on
   a slower one.
3. **Pictures popped.** A card's pictures and picks, a collection's tiles and a character's still had no stand-in
   and no fade; a grid picture's blurred stand-in jumped to sharp (the transition lived on a class that was removed
   at that moment); pictures showed in the order their fetches landed.
4. **A character's pictures were kept under an address with no version** (`/api/characters/:id/files/front`), so a
   sheet drawn again would be answered from the persistent cache with the old picture.
5. **A still's ground was cut on the page** and held as a `data:` address: about 10 ms each on this machine (not the
   cause of the long tasks), 1.2 MB of `data:` text in the DOM, redone every launch, and the agent's mark shown for a
   beat on every mount.
6. **Two compositor layers per card** (`will-change: transform` on the card and on its anchor): 432 layers on the
   studio, 168 on the company board.

## Before and after

### Loading (Character studio, opening view: the Inspiration section)

| | before | after |
|---|---|---|
| cold: picture requests / bytes | 57 / 2,986 KB | 57 / 2,986 KB |
| cold: first picture / all visible sharp | 1,032 / 1,079 ms | 786 / 900 ms |
| cold: long tasks (count / total / longest) | 7 / 629 ms / 192 ms | 5 / 431 ms / 162 ms |
| warm reload: requests / bytes | 0 / 0 | 0 / 0 |
| warm reload: all visible sharp | 764 ms | 805 ms |
| `data:` pictures in the DOM | 12, 1,227 KB | 0 |
| compositor layers (studio / company) | 432 / 168 | 366 / 152 |
| DOM nodes (studio) | 4,373 | 4,521 |

The load times are one run each and within each other's noise; the requests and bytes are exact. The 150 more nodes
are the pictures' wells and the posters' wrappers.

### Frames (Character studio)

| step | before | after |
|---|---|---|
| at rest, opening view | 60.1 fps, worst 16.8 ms | 60.1 fps, worst 16.8 ms |
| pan, opening zoom | 58.1 fps, worst 116 ms, 0 long | 58.4 fps, worst 100 ms, 0 long |
| **arriving at the character cards** (pan there, 5 s) | **38.1 fps**, p99 300 ms, worst 449 ms, 6.3 % over, 6 long | **54.3 fps**, p99 83 ms, worst 233 ms, 1.8 % over, 1 long |
| at rest over the characters (script in 2 s) | 60.1 fps, **1,409 ms**, 5 live | 60.1 fps, **381 ms**, 1 live (the one under the pointer) |
| **pan over the characters** | **47.2 fps**, p99 183 ms, worst 266 ms, 3 long | **60.1 fps**, p99 16.8 ms, worst 16.8 ms, 0 long |
| the pointer rests on a character (its first wake) | already playing | 55.4 fps, **one 250 ms frame** (the runtime's loader) |
| the pointer comes back (it wakes again) | already playing | 60.1 fps, worst 16.8 ms, 0 long |
| **zoom out and in** | **42.1 fps**, p99 216 ms, worst 233 ms, 8 long | **59.3 fps**, p99 33 ms, worst 33 ms, 0 long |
| **pan after the zoom** | **46.7 fps**, 12.6 % over, worst 233 ms | **59.8 fps**, 0.6 % over, worst 33 ms |
| pan, zoomed in | 55.1 fps, worst 150 ms, 2 long | 58.8 fps, worst 83 ms, 0 long |
| pan, zoomed all the way out (12 %) | 59.4 fps, worst 50 ms | 60.1 fps, worst 16.8 ms |
| zoom in from far and back | 60.1 fps, worst 16.8 ms | 60.1 fps, worst 16.8 ms |
| WebGL contexts made over the whole pass | 31 | 4 |
| live avatar canvases at rest over the characters | 5 (5,687 draws in 2 s) | 0 with the pointer away; 1 under it (1,080 draws) |

An ordinary grid (`company`): 60 fps on every step before and after, no long task; layers 168 → 152.

### The repo's frames check (`PERF_GPU=1 … frames`, its own 200-card board, both on production builds)

| surface | before | after |
|---|---|---|
| board at rest / pan / pinch zoom / pan with live frames / panes | 0 % over, worst 16.8 ms | 0 % over, worst 16.8 ms |
| drag a card | 0.7 % over (2 frames), worst 33 ms | 1.0 % over (3 frames), worst 67 ms |
| framing glides | 1.0 % over, worst 183 ms | 0.5 % over, worst 133 ms |
| the board loading behind the sign-in | one 549 ms frame (a 568 ms task: React rendering 200 cards) | the same |

Passed both times (`frames-before/frames.json`, `frames-after/frames.json`). The drag's one extra frame is inside
what a single run varies by, but the card's layer is now made when it is picked up, so it is worth a look on a
slower GPU.

## What changed

- **A card rests on a picture and plays when it is used** (`characters/stagePolicy.ts`, `panels/CharacterView.tsx`):
  live when the pointer is on it (and for 1.4 s after), or when it is drawn at 80 % of its size or more; started only
  once the camera is calm; the stage budget still caps how many. The picture cross-fades to the live character and
  back over `--dur-lift`, opacity only (`characters/Avatar.tsx` `PosterAvatar`, `council.css`).
- **A 3D character's still is the model itself, drawn once** (`characters/portrait.ts`): first frame of its idle clip,
  the stage's own lights and camera, clear ground, 640 px; kept in the image cache (memory and Cache Storage) under
  the character, **the clips file's id**, the framing and the size. One renderer, one at a time, only for cards that
  have come near, only while the camera is calm. The ground is clear and the lights fixed, so the picture is the
  same day and night: theme is deliberately not in the key.
- **A mesh avatar that stops playing is kept ready** (`Avatar.tsx` `meshKept`, three at most): opened in the
  runtime's manual mode, advanced only by the card showing it, so the second wake is instant and a waiting one costs
  nothing.
- **Stills are cut in a worker and kept** (`characters/cutout.ts`, `cutoutCore.ts`, `cutoutWorker.ts`): under the
  picture's own versioned address in the image cache; one in memory is there on the first frame.
- **Versions in the address** (`lib/imageCache.ts` `withVersion`, `roster.ts` `characterFilePath(id, role, version)`).
- **Arrival** (`lib/arrival.ts`, `components/progressive-image.css`): a cold picture fades in from its well; the
  stand-in comes into focus instead of jumping; each waits `--arrive-step` × half of `--dur-press` (six steps at
  most, 240 ms) by its distance from the middle of the screen, so a section fills from the centre outward. On grid
  pictures (`MediaView.tsx`), a character card's pictures and picks (`ProgressiveImage` `stagger`), collection tiles
  and stills. Opacity, blur and a 3–4 % scale only; nothing transitions colour; reduced motion turns it off.
- **One layer per card** (`App.css`): the card inside its anchor is no longer its own layer at rest (it is while it
  is carried); `isolation: isolate` keeps it a stacking context.

## What still falls short

- **A mesh avatar's first wake is one 170–555 ms task** inside `mesh-avatar`'s loader (250 ms in the run above). It
  now happens once per character per page, when you rest on it or zoom in to it, not as you pan; it is still a
  dropped beat. The fix is in the runtime (decode and mesh in a worker) or a pre-made mesh in the `.mavatar`.
- **The board's first render is one long task** (162–192 ms on the studio's build, 568 ms on the 200-card test
  board): React rendering every section at once. Not changed here.
- **A live mesh avatar costs about 20 % of the main thread** by itself (381 ms of script in 2 s). One or two are
  fine; a screen of large ones would not be.
- **WebKit (the Mac) was not measured** with these changes, and `@starting-style` (the fade from the well) needs
  Safari 17.5: older ones show the picture without the fade.
- **3D-model cards were not measured on real data** (none on this board): the model's still and the cross-fade were
  checked on the stand-in's GLB in `e2e/council.spec.ts`.

## Pictures

`studio-{day,night}-1…5`: the Inspiration section mid-load (wells, blurred stand-ins, sharp), the characters
mid-load, filling, loaded (no canvas on the board), and one in use (live). The network was slowed for these (120 ms a
request, 1.5 Mbit/s: `scripts/shots.mjs`). `design-*`: the `#/design` specimen with the wave, day and night.
`e2e-card-at-rest.png`: a 3D character's card resting on its model's still (the stand-in's figure).
