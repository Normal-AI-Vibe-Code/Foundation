# Moving and splitting sections, checked (2026-11-03)

`npm run e2e -w @foundation/client` → `e2e/sections.spec.ts`, on the seeded company board in headless Chromium at 1440×900. It runs its own server on a fresh data folder, so it never touches the dev board. Every step is photographed and checked for what would look wrong (`e2e/helpers.ts → layoutProblems`):

- two sections claiming one grid cell;
- two section cards overlapping on screen;
- a docked card spilling out of its section's width;
- a section off the grid;
- an empty section's welcome not fitting inside it.

Moves are also checked so they never leave more empty cells than before.

| Shot | Step |
|---|---|
| 00 | The board at rest |
| 01 | Design split into two columns: the column halves, and "Asks & agents" above widens across both |
| 02 | The Vision app section split into two rows: the new short section shows a compact welcome (four glyphs) instead of a clipped one |
| 03a/b | Section 2 dragged by its name onto Design (the drop target rings); they swap |
| 04a/b | "Asks & agents" dragged past the board's right edge (the band says where); it gets a column of its own. Data Room and FactoryForm, which together line its left side, grow into the space it left |
| 09 | `#/design` → the HUD with the talk pill, and the talking state, day and night |

**Found and fixed:**
- **Dragging a section by its name did nothing.** The name is a button (click to rename) and the header ignored presses on buttons, though its tip said "Rename · drag to move". The name now drags, and a drag doesn't also open rename. The first test run "passed" while nothing moved, which is why every step now has a photograph.
- **A section moved away left a void** unless exactly one neighbour lined up with the whole gap. `fillHole` now grows any set of neighbours that together line one side of it (fewest sections wins). It's used for edge drops and for moves to an empty cell (`test/sections.test.ts`).
- **An empty section made short or narrow by a split clipped its welcome.** The welcome now steps down with container queries: no explanations or app shelf when short, then just the four glyphs, named on hover.

**Not fixed (SPEC §7):**
- A wire from a split app section can run tight along a neighbour's edge.
- Framing a section zooms to its cards, so its top-right tools can be off screen.
