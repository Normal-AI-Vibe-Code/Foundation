# The Mac: the Character studio in WebKit, and the top-left corner (2026-11-24)

SPEC §0.16. Measured with Playwright's WebKit 27.2 (the engine of the Mac app's WKWebView), headed, 1440×900 at
2×, on a `sqlite3 .backup` copy of this Mac's installed-app data (the Character studio: 11 characters, 30
inspiration pictures, 30 wires), served by a checkout on :4420/:1440. Frames are rAF intervals from the page.

## Frames (fps; worst frame in ms)

| | WebKit before | WebKit after | Chromium after |
|---|---|---|---|
| at rest | 57.5 (89) | 58.7 (63) | 107 |
| pan, opening zoom | 60 (31) | 60 (20) | 120 |
| zoom out and in | **4.7 (742)** | **44.5 (104)** | 117 |
| pan after the zoom | **1.7 (679)** | **60 (26)** | 117 |
| pan at 12 % (fresh page) | **2.6 (559)** | **40 (112)** | — |

How it was found (`scripts/fresh.mjs`, one fresh page per variant, panning at 12 %): hiding images, canvases,
shadows or the character cards changed nothing; hiding `.port-layer` gave 45 fps and turning off masks 36. Inside
the wire layer, only the SVG mask mattered once the flag feedback loop was gone. `scripts/v7.mjs` + `instr.js`
showed 43 ms of JavaScript in a 2.5 s run of 2 fps: the cost was WebKit's own rendering.

## Loading and caching (`scripts/relaunch.mjs`, a persistent WebKit profile)

| | requests | bytes |
|---|---|---|
| first load, before | 94 | 4.3 MB |
| first load, after | 46 | 3.0 MB |
| relaunch, before | 46 + the 2 MB mesh avatar | all of it again (Cache Storage: 79 caches named v2, the one opened empty) |
| relaunch, after | 0 pictures or avatars from the network | 0 |

## Screenshots

`webkit-studio-rest-*.jpg` at 61 %: pulses running, the one tunnelled wire masked. `webkit-studio-far-*.jpg` at
12 %: pulses paused, mask off. Day and night.

The top-left corner on a Mac is held by `e2e/today-corner.spec.ts` (screens in `../2026-11-24_mac-corner/`).
