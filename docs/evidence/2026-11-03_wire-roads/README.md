# Wire roads: clipped to their section, longer diagonals, round bends — 2026-11-03

Josh: "the connection in the rim drive is missing a connection to something, or it's loose … the connections should be taking longer 45 degree angles … some rounding added to the corner."

## What was wrong

The Rim-drive fan v3 pipeline lays its six stages out 3 × 2 (1,500 px wide), but column G is now 1,080 px, so CAD and Release sit in the scrolled-off part of the section. The wire layer wasn't clipped, so Concept → CAD ran out of the section to nothing, and CAD → Simulate looped round outside the section from a card nobody could see (1).

## What changed

- **Wires inside a section are seen through its body.** When both ends sit in one section's scrolling body, the wire is clipped to that body and only that section's cards are obstacles. The body's walls are obstacles too, except a wall one of the wire's own cards is scrolled behind. Unscrolled (2): Concept's wire runs to the edge, and the wire from CAD comes in along the gap and turns down into Simulate, all inside the section. Scrolled right (3): Concept → CAD and Review → Release join up, and CAD's wire takes a long diagonal into the gap towards Simulate.
- **Longer 45° runs.** When a diagonal would enter a card, the router now searches for the longest one that clears it rather than halving (480 → 240 → 120). A corner also takes whatever part of a shared run its neighbour can't use, so a step onto a short lead is one diagonal rather than diagonal, vertical, diagonal.
- **Round bends.** `polyline` draws each bend as an arc of radius 20, kept within half of either run. Every wire layer and the design page use it (5).

## Measured

- CAD → Simulate, unscrolled: before, diagonals of 34 / 166 / 47 / 24 px and a loop outside the section. After: 24 / 202 px and a hook into Simulate, all inside the section body (x ≥ 4,550).
- Scrolled to CAD: diagonals of 57 / 176 / 57 px.
- Path data now carries `A 20.0 20.0 …` arcs at every bend.
- `apps/client/test/wires.test.ts`: 18 pass, including three new tests. A hemmed-in turn now reaches 295–300 px, where halving gave 240. A step onto a short lead is one 45° run. Arcs stay within half a run. Server: 37 pass. Typecheck is clean.
- Night (4) was checked with the orb's `setNight`.
