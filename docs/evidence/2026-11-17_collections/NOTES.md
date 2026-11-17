# Collections — 2026-11-17

Josh: "I'd still like to add sections and primitives to capture the process we use for generating images and
piping them into the mesh avatar studio system and create a primitive for that, that can output images or
character cards like we have stored in Character studio into a collection, that can be piped into a section that
automatically lays out the products of that into the section. The collector should be able to also be expanded
to be able to drag out copies of those cards onto the grid."

Fable's round earlier the same day (`c288295`, "the pipeline as nodes with Generate") had made the studio's flow
nine wired node cards. No collector, laid-out section or drag-out existed, so this builds them on top.

## What was built

- **Collection** card (`panel: "collection"`, ❖): an input (`collect`) and an output (`items`). The server keeps
  what it holds (`collections` map, server-only like `characters`) and gathers from its wires
  (`apps/server/src/collections.ts`):
  - a stage node: the pictures drawn there (Sheet → sheets; Expressions → expression sheets; Views → portrait, or
    back and side, by the port; Mesh avatar / Moods → stills; Inspiration → its pictures);
  - Output (now with an output of its own, `characters`): the finished characters;
  - another collection: what it holds.
  Each item once; nothing dropped when a source changes; a person takes items out (×).
- **Lay out in** a section (the card's foot, or the card's output dragged onto a section): each item a docked card
  there — a picture an image card 300 wide at its shape, a character a copy of its card — and later items follow.
  A section just made for it ("Section 4") takes the collection's name.
- **Expand**: the card opens to 920 × 700 (moved left to stay inside its section), a grid of tiles. A tile pulled
  out is a copy: into the section where it's let go (kept inside it), onto an empty cell or past an edge into a new
  section.
- **Character copies**: a card and row of their own, `copyOf` the original: shown as a copy, never an avatar a
  second time, nothing to press (the server refuses a stage or a .mavatar on one).
- **Character pipeline** in a section's right-click menu: the whole flow laid into that section with a collection
  after Output, on any grid (tool `add_character_pipeline`).
- Tools for agents: `read_collection`, `collection_lay_out`, `collection_copy`, `collection_put`,
  `collection_take_out` (confirm).
- **Wires**: a press on a port that a wire lands on is now the port's (an output starts another wire; an input lifts
  the wire off). Before, the wire's hit area took the press, so an already-wired output (every node of the flow)
  couldn't be wired on into a collection.

## How it was checked

- `apps/server/test/collections.test.ts` (6): the pipeline primitive's nodes and wire; gathering by node and port,
  once; laying out (docked, shapes kept, later items follow, a removed card isn't laid again); copies (floating at
  x, y or docked; idempotent by `request_id`; marked; not choosable; a stage on one refused); take-out needs confirm
  and leaves the cards; a viewer reads and is refused writes; an older studio's Output gets its port, once.
- `apps/client/e2e/collections.spec.ts` (6), Chromium, its own server and stand-in Meshy on ports above 15000. Each
  step done the way a person does it: the menu item, a wire dragged port to port, stages pressed (stand-in), the
  Expand pill, a tile dragged with the mouse onto another section, the select, the output dragged onto a section.
- Regressions run: `pointer.spec.ts` (7; its pinned menu list now has the two new items), `character-studio.spec.ts`
  (9), `council.spec.ts` (8), `card-chrome.spec.ts` (7), `section-agents.spec.ts` (5), `sub-grid.spec.ts` (5); all
  unit suites; typecheck.

## Shots

| | |
|---|---|
| `01_pipeline-and-collection-night.png` | Character pipeline laid from the menu: nine nodes, the collection after Output |
| `02_folded-stack-night.png` | a sheet (Sheet's wire) and the finished character (Output's), folded |
| `03_opened-night.png` | opened, inside its section, over Output and Moods |
| `04_dragging-a-copy-night.png` | a tile's copy on its way to Moodboard (ringed) |
| `05_copy-on-moodboard-night.png` | the copy, kept inside the section, tagged *copy*, nothing to press |
| `06_laid-out-section-night.png` | laid out in a new section below; Taro's sheet arrived afterwards and followed |
| `07_piped-into-moodboard-night.png` | the output dropped on Moodboard: laid there beside the dragged copy |
| `08_design-night.png`, `08_design-day.png` | `#/design` → Collections: empty, folded, opened |

## Not done / not verified

See SPEC §7 *Collections, as built 2026-11-17*: nothing goes into mesh-avatar-studio itself; Rune doesn't draw a
collection; no wire is drawn to the section it lays out into; not run on the live studio, in the desktop window, on
a trackpad, or as a viewer in a browser. The server on :4410 serves none of it until it restarts.
