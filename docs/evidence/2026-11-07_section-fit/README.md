# Sections fit; Expand opens one as its own grid — 2026-11-07

Josh: "Scrolling shouldn't be taken over by a section. A section should be able to be expanded into another grid to see more of it; the section will do its best job to present the information within it."

Checked in a real browser (Chromium in the app's pane, 1440×900, `?rafshim`) on a copy of the dev board, on the `feat/section-fit` worktree's own server (:16410) and client (:16430).

| Shot | What it shows |
|---|---|
| 01-fitted-59pct-night | "Asks & agents" with 13 cards: a 1,827 px flow scaled to 59 %, every card inside |
| 02-clipped-15-more-night | 51 cards: it stops at 40 % and says **15 more · ⤢ Expand** |
| 03-expanded-top-night | Expanded: its own width (1,130 px), full size, 8,610 px tall, framed from the top at 89 %; neighbours at 12 %; **Back to the board** in the header |
| 04-expanded-wheel-down-night | The wheel moved the camera down through it (world y −923 from +77) |
| 05-esc-back-fitted-night | Esc: back to 40 % with the pill |
| 06-fitted-day, 07-expanded-day | Day. 07 is wider: a card dragged out in the fitted view floats where it was dropped, and floaters keep their place when the section opens |
| 08-design-day, 09-design-night | `#/design` → Chrome on call: the fitted section with its pill, and the expanded header |
| e2e-01…03 | `e2e/wheel.spec.ts`: clipped, expanded, wheel down |

Numbers:
- Ten wheel events (deltaY 40) over a fitted section moved the world 400 px; the section's content transform didn't change.
- A card dragged by its bar 150 × 50 px moved 150.0 × 50.0 px on screen; the fit held at 0.4 through the drag (a press holds it).
- DOM rect of a fitted card vs `objectWorldRect` through the camera: under 1 px apart (x 559.0 vs 559.3), so wires and ports land on scaled cards.

Tests: `test/section-fit.test.ts` (4), `e2e/wheel.spec.ts` (3), `e2e/sections.spec.ts` (6, unchanged), the client suite (30) and the server suite (53 pass, 6 skipped).
