# The ~100 ms frame when a card is picked up (2026-11-07)

SPEC §5 and §7 recorded one long frame (~100 ms on the Mac) when a docked card is picked up.

**What it was.** Not the relayout. A Chrome trace of the press (`EventHandler::handleMousePressEvent` → one 75–110 ms `FunctionCall`) and a CPU profile showed React re-rendering **every section and every card** on the board. Pressing a card sets it active (`setActiveObject`), and:

1. `SectionView` read the whole store (`useAppState()`), so its `memo` never held: any store change (a press, each drag frame's commit, a keystroke in a note) re-rendered all ten sections.
2. Each `PanelView` subscribed to the whole store through `usePortLayout`, so every live app re-rendered too.

Counted per press (a render counter in `ObjectFrame`, dev build, StrictMode doubles): **38 cards** (18 notes + 20 apps) before; **1–2** after (the card pressed and the one that stopped being active).

**The change.**
- `store.useSection(id)`: a section's own slice (its cards, its hosted app, which of them is active, its focus/removal flags), cached by store snapshot, with the same object back when nothing in it changed. Unchanged cards keep the same array, so the section's layout memo holds.
- `SectionView` keeps a card's position object when the card didn't move, so a relayout re-renders only the cards that moved.
- `usePortLayout` subscribes to `links` only. Its memo already recomputed only on panel or links changes, so behaviour is the same.
- `test/section-snap.test.ts` checks that pressing, dragging and typing in one section leave another section's snapshot identical.

**Measured** on a 4-core cloud Linux box (headless Chromium, SwiftShader WebGL, Vite dev build). It is roughly twice as slow as the Mac run in `2026-11-03_perf`, so compare before and after **here**, not with that run:

| Action | Before: p95 / longest / > 33 ms | After: p95 / longest / > 33 ms |
|---|---|---|
| Pan | 50 / 116.7 / 132 | 50 / 66.7 / 101 |
| Pinch zoom | 50 / 116.6 / 150 | 50 / 133.3 / 130 |
| **Drag a card** | 50 / **249.9** / 72 | 50 / **66.7** / 78 |
| Pan with live frames | 50.1 / 100 / 244 | 66.6 / 116.6 / 261 |

The drag's longest frame (the pickup) went from 250 ms to 67 ms. Pan, zoom and live frames don't press anything, so they are unchanged within this box's noise. On this box every frame also spends 20–27 ms in `GLES2::ReadPixels`: the software compositor reads the paper's WebGL canvas back. A GPU doesn't do that, which is why p50 here is 33 ms and the absolute budget can't be judged on this machine. Raw numbers: `frames-after.json`.

**What's left at pickup:** lifting a *docked* card still reflows the cards after it (they move up to close the gap), and those cards render again because they really move. Keeping the gap until the drop would move that cost to the drop; that's a design call.

**The whole e2e suite** on this box after the change: 21 pass, 1 skipped by design (`dragging onto an empty cell after a split`), and `perf.spec` fails its absolute budget (pan p95 50 ms against < 34). It failed the same way before the change, because this box draws at about 30 fps in software. Sections moved and split, layouts, CAD, voice and the Vision hand-off all pass with the per-section store slice.
