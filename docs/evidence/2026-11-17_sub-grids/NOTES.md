# Sub-grids: "Open as its own grid" makes a real grid (2026-11-17)

Josh, 2026-11-17: "Open as its own grid doesn't work, it should create a sub-grid that can be pulled out of the grid collection and moved to other grids, but still maintain a preview in the Grid it used to be in, and maintain a link to the new location."

This file holds what SPEC.md, DESIGN.md and docs/plan.json should say (this branch does not edit them), and what the screenshots here show.

## What "doesn't work" was (reproduced before changing anything; `before/`)

A throwaway Playwright run on a fresh server (ports 15931/15951), one grid with a section of two notes, an empty section and a section hosting an app:

| Pressed | What happened | Shot |
|---|---|---|
| ⤢ on the section with cards | The same section, alone, filling the screen, with a pill *grid › Section 1*. `level` set in this window's store; **nothing was made**: no grid on the server (`GET /api/boards` unchanged, no children), nothing in All Grids, the address unchanged | `before/2-Section-1-opened.png` |
| ⤢ on the empty section | The same: the empty section's welcome, alone | `before/2-Empty-opened.png` |
| ⤢ on the hosted-app section | There is no "Open as its own grid" there at all: ⤢ is *Fill the screen with this section* (a camera move) | `before/1-App-hover.png` |
| Reload while "open" | Back on the whole grid: the view was never kept | log |
| A second person on the grid | Sees nothing: no level, no sections inside sections | log |
| The ⤢ at rest in the header | Hidden the moment the pointer is on the section (the tools take that corner), so the press is always the toolbar's ⤢ | log |

So it worked as built on 2026-11-11 (a view of the section, local to the window), and that is not what the words say: nothing a person could call "its own grid" existed afterwards. It could not be found in All Grids, linked, moved, shared or reopened.

## What was built

- **Server** (`apps/server/src/subgrids.ts`): `extractSection`, behind the board tool `extract_section` and `POST /api/boards/:id/sections/:section/extract` (`{request_id?}`; the route runs the tool, so a viewer is refused and a repeated `request_id` answers with the first result). It makes a grid named after the section inside this grid, writes the section's cards into it (ids kept; note text, table cells, files shared to the new grid, the wires among them, a map's table when both moved), then takes them off this grid and leaves the section where it was, the same size, hosting the `grid` card. A grid section (one that held sections) becomes a grid with those sections at their places and its own tracks.
- **What can't move**: a machine, a huddle and a pipeline stage stay (the same three `send_to_board` keeps). They stay **in the section**, beside the grid's card, which then sits in the flow instead of filling the section; the result names them and so does the log. A section that follows a Slack channel is **refused in words** (Slack's own tables hold a channel's section to its grid). Presentations and Foundation's own grids (plan, design language) are refused in words.
- **Wires** that crossed the section's edge are let go; the log on the parent says how many ("the ends that stayed are still here, unwired").
- **Server-kept state** goes with what moved: a character's row and its `characters` entry (`moveCharacter` in `characters.ts`, the only change there), a section's council (`agents`; the council of a grid section becomes the new grid's own), an ask's row (so its answer finds the card). `machineAsks` and `huddles` belong to cards that stay. `slack`: refused, above.
- **Who can see it**: `board_members` and `board_roles` are copied, so a members-only grid's sub-grid is members-only and a viewer stays a viewer.
- **Leftover link** (`boards.ts`): `setBoardParent` no longer takes the card off the grid a child leaves. To the top, or from A into B, the old parent keeps the card and its section; `grid_leftovers` remembers which grids hold such a card so a rename reaches them; a grid dragged back onto a card that was left reuses it. The card works out "moved" itself from the outline's `parent`, so it is right for everyone and after any number of moves.
- **Outline** (`GET /api/boards/:id/outline`): now also `id`, `name`, `parent`, `parentName` (null when this person can't see it), `tracks`, and per top-level section its span, `host` and up to 18 `items` (kind, name, size, float, an image's file as `thumb`).
- **Search index**: a board now unindexes only its own entries. Before, a card moved to another grid (by this or by `send_to_board`) could be dropped from search when the grid it left re-indexed.
- **Client**: ⤢ / the menu's *Open as its own grid* on an ordinary section asks in place (*Make **Name** its own grid? Its cards move into a new grid inside this one; this section keeps a preview of it.* and, when it applies, *The machine “Bench” stays here.*) with **Make it a grid** / Cancel; then the server does it and this window opens the new grid. On a section that stands for a grid, ⤢ opens it. Viewers don't get the ⤢ that makes one. The card (`panels/GridLinkCard.tsx`) draws the grid in miniature and asks again every 4 s while on screen. The pill under the top bar (`shell/LevelBar.tsx`) shows the grids above a grid that sits inside another; ⤡ or a step opens that grid framed on the section that stands for the one you came from.
- **The old in-window level** stays where it was not the thing being asked for: *n more · Expand*, a grid section's ⤢ (*Open its grid*) and the miniature's double-click still open a level in this window, and existing grid sections keep working. While one is open the pill offers **Make it a grid…** (asked once, in the pill), which runs the same extract.

## How each part was checked

| Part | Check | Result |
|---|---|---|
| Extract: cards, note text, cells, image file, map, wires, character, council, the section's place and size, the log | `apps/server/test/subgrids.test.ts` test 1 | pass |
| Twice is once (`request_id`; a section that already stands for a grid; one whose only movable card is the grid's) | tests 1, 2; e2e test 3 over HTTP | pass |
| Empty section; an ask's answer finds its card | test 2 | pass |
| Grid section → grid with its sections; a huddle stays; an agent's line says who for | test 3 | pass |
| Refused: viewer, Slack section, missing section, presentation | test 4; viewer also over HTTP in e2e test 3 (403, *View only*) | pass |
| Members-only stays members-only; outline hides a parent you can't see | test 5 | pass |
| Outline: tracks, spans, card kinds, thumb | test 6 | pass |
| Leftover link: to the top, A→B, rename, back again, removed by a person | test 7; `grids.test.ts` (two tests rewritten) | pass |
| A grid's card inside the section: that grid is inside the new one | test 8 | pass |
| Two people in real browsers: the question, Cancel, Make it a grid, the child's content, All Grids, the other person's card and miniature (image loaded), the preview following the child, ⤡ back up, ⤢ on the standing section | `apps/client/e2e/sub-grid.spec.ts` test 1 | pass |
| Dragged to the top and into another grid: both people see where it went; the named grid is a press; the card opens it; *Remove this link* leaves the grid alone | test 2 | pass |
| A section open in this window (Expand): the pill's *Make it a grid…*, its question, Cancel, then the grid | test 4 | pass |
| `#/design` day and night; no miniature section outside its preview | test 5 | pass |
| Old specs | `one-interface` (5; the end of the grids test rewritten: the card stays, marked moved), `section-agents` (5; ⤢ now asks, then Cancel), `sections` (6 and one that skips itself when there is no empty cell, as before), `wheel` (3; Expand still opens the in-window level) | pass, on ports 15931/15951 |
| Unit | `npm test` (client 153 with the token ratchet, server with `subgrids.test.ts`), `npm run typecheck` | pass |

Not verified: the Rune renderer (opt-in) and the packaged desktop app were not run. Rune's own ⤢ still opens the in-window level; its right-click menu shares `sectionMenu.ts`, so *Open as its own grid* there sets the question, which only the web section draws.

## Shots

`01_ask-night` the question on the section · `02_child-grid-night` the new grid, under its parent in All Grids, with the way back up · `03_parent-preview-night` the other person's view: the section holding the grid's card and miniature · `04_moved-to-top-night` · `05_moved-into-another-night` / `-day` · `06_design-day` / `-night` the `#/design` pieces · `07_level-make-it-a-grid-night` the pill's question on a section open in this window · `before/` the reproduction.

## DESIGN.md: row replacements

**Sections are grids** — replace the first sentences up to "…just opening one changes nothing on the board." with:

> 2026-11-11, Josh: "The individual sections are actually grids within themselves, so opening them up to fullscreen opens up a full other grid." 2026-11-17, Josh: "Open as its own grid doesn't work, it should create a sub-grid that can be pulled out of the grid collection and moved to other grids, but still maintain a preview in the Grid it used to be in, and maintain a link to the new location." **⤢ Open as its own grid** (the tool, the mark at rest, the menu) on a section of cards **makes it a grid**: it asks once, in place, on the remove popover's paper (440 wide at most, the words wrapping): *Make **Name** its own grid? Its cards move into a new grid inside this one; this section keeps a preview of it.* and, when something can't go, *The machine “Bench” stays here.*; **Make it a grid** is the one blue action (pulse fill, on-fill ink; *Making it…* while the server works), then Cancel. The window then opens the new grid; a toast says what stayed or which wires were let go. The section keeps its place and size and holds *A grid inside this one* (below). A viewer has no ⤢ that makes a grid. A section that already stands for a grid: ⤢ is *Open the grid* and just opens it. **In this window only**: *n more · Expand*, a grid section's ⤢ (*Open its grid*) and a double-click in a miniature still take the view into the section's own grid without changing anything for anyone; there the section shows **⤡ Back up a level** where ⤢ was.

Keep the rest of the row (split, grid sections, the miniature, cards added to a grid section, removing). Replace its last part, from "**Where you are**:", with:

> **Where you are**: a glass pill (36 tall, pill radius) centred under the top bar, on a grid that sits inside another and while a section is open in this window: **⤡** (up one step: Esc inside a section; on a grid inside another, its parent) · the grids above this one, outermost first, each a press that opens it framed on the section that stands for the grid you came from · this grid's name · › each open section on the way, the current place in frost 600 with ▦. With a section open in this window, at the right: **Make it a grid…** (26 tall, pill, a 1 px strong hairline, mist 12/500); pressed, the pill asks *Its cards move into a new grid inside this one.* with **Make it a grid** (pulse fill) and Cancel. Opening a section this way never moves anyone else.

**A grid inside this one (`panel: "grid"`)** — replace the row's text with:

> The section that stands for another grid, put there by the server when a grid is dragged into another or a section is made a grid of its own. The card fills its section (it sits in the flow instead when a machine, a huddle or a pipeline stage had to stay beside it): a moss eyebrow *A grid inside this one*, the grid's glyph in pulse and its name in display 32/600, what it holds in mist 14 tabular (*3 sections · 14 cards · 1 grid inside*) — that head is one press — then **Open the grid →** as the accent pill, then **the grid in miniature** taking the rest of the card: a panel-well box in the grid's own proportions (card radius, a 1 px hairline, pulse on hover, `zoom-in`), its top-level sections at their places as raised paper with a strong hairline (name in frost 11/600, the card count in dim at the right, ▦ n in pulse for one that is a grid), and in each its first 18 cards as blocks in proportion to their size (abyss, a hairline, the kind's glyph in dim and the name in mist 11; an image is the image, up to 8 a card; a hosted app fills its section). Small sections say less: under 120 px the cards' names go, under 56 px the section's. It asks what the grid holds every 4 s while it's on screen. Under it, the grid's own child grids as plain pills. **A grid that was here**: when the grid has moved (to the top of All Grids, or into another grid) the card stays: the eyebrow reads *A grid that was here* in dim, the glyph in mist, and a quiet line under what it holds, mist 13 with a dim ↗: *Moved out: now at the top of All Grids. This is a preview of it.* or *…now inside **Motors**…* (the name in frost 600, underlined with the strong hairline, a press that opens that grid framed on this one's card there); at the line's right, dim 12, **Remove this link** (bad red on hover; not shown to a viewer), which takes the card off this grid and nothing else. Open and the miniature work as before. A grid that's gone, or that you can't open, says so in dim.

**Side menu** — one sentence changes. Replace "…and a dashed box under the list (and the All Grids half of the pill) takes it back to the top." with:

> …and a dashed box under the list (and the All Grids half of the pill) takes it back to the top. The grid it leaves keeps its card (*A grid that was here*), so nothing on that grid moves.

`#/design`: *Settings, and grids inside grids* now also shows the question, the pill both ways, and the card in its three states (`design/SubGridDemo.tsx`).

## SPEC.md lines

**§0.7 (new)** — *Sub-grids (Josh, 2026-11-17)*: the ask verbatim; what a professional adds (one server move, written to the new grid before anything is taken off the old; ids kept so search, links and logs still point at the cards; what can't move stays and is named; membership copied; the old parent's card is the server's, and the card reads where the grid is rather than being told); what shows it's right (the two test files and `docs/evidence/2026-11-17_sub-grids/`).

**§2** — add after the grids-of-grids paragraph:

> **Sub-grids (2026-11-17).** No new fields. `extract_section` turns a section into a board whose `parent` is this one; the section then hosts a `grid` panel (`board`: the new grid). A `grid` panel whose board's `parent` is not the board it sits on is a link left behind (`grid_leftovers` in SQLite lists them); nothing on the card says so, the outline does.

**§3**, row *Sections are grids within themselves* — append to the description: "Since 2026-11-17 ⤢ on a section of cards makes a real sub-grid (row *Sub-grids*); the in-window level remains for *n more · Expand*, grid sections and the miniature, and offers *Make it a grid…*". Status stays **done**.

**§3**, row *Grids of grids* — replace "renames it with the child and takes it away when the child leaves" with "renames it with the child, and **keeps it when the child leaves** (to the top or into another grid): a preview and a link to where it is now, which a person can remove". Checked by: `test/grids.test.ts`, `test/subgrids.test.ts`, `e2e/one-interface.spec.ts`, `e2e/sub-grid.spec.ts`.

**§3**, new row:

> | **Sub-grids** (2026-11-17, Josh: "Open as its own grid … should create a sub-grid that can be pulled out of the grid collection and moved to other grids, but still maintain a preview in the Grid it used to be in, and maintain a link to the new location") | ⤢ on a section asks once, then `POST /api/boards/:id/sections/:section/extract` (tool `extract_section`) makes a grid inside this one from it: cards with their text, cells, files and inner wires; characters, councils and asks follow; machines, huddles and stages stay in the section; a Slack section is refused; crossing wires are let go and logged; membership copied; idempotent. The section keeps its place and hosts the grid's card, which draws the grid in miniature from `/outline` (asked every 4 s on screen). Moved to the top or into another grid, the old parent keeps the card, saying where it went. A pill shows the way up from a grid inside another | **done** on the web renderer; **partial**: hosted-app sections have no ⤢ for it (the tool and route take them); Rune's menu sets the question but Rune doesn't draw it; **not verified** in the packaged desktop app | `apps/server/test/subgrids.test.ts` (8), `apps/client/e2e/sub-grid.spec.ts` (5), `docs/evidence/2026-11-17_sub-grids/` |

**§4** — add to the tool list:

> `extract_section` `{section, request_id?}` (write): make a section a grid of its own inside this one; returns `{board, name, section, card, moved, sections, stayed[], wires{moved,dropped}, already?}`. Also `POST /api/boards/:id/sections/:section/extract`. `GET /api/boards/:id/outline` returns the grid's tracks, sections' spans and cards for a preview, and its `parent`.

Also in `send_to_board`'s line: its search entry now survives the move (the index only drops a board's own entries).

**§7** — add:

> - **Sub-grids: a card edited offline can come back.** Extract deletes the moved cards from the parent's document. A device that was offline and changed one of them (moved it, renamed it) can bring it back onto the parent when it reconnects, so it would exist on both grids. Text typed into a moved note in the instant of the move can be lost. Not seen in tests; not guarded.
> - **Sub-grids: no undo.** Putting a sub-grid's cards back into the section is by hand (`send_to_board`, card by card). There is no "dissolve this grid into its parent".
> - **Sub-grids: hosted-app sections** have no ⤢ that makes a grid (⤢ there is *Fill the screen*); *Show … as a card* first, or use the tool.
> - **Sub-grids: Vision hand-offs and running agent sessions** that named the section keep pointing at the parent grid; what they bring back lands there, not in the new grid.
> - **Sub-grids: a leftover card's section keeps the name** it had only while the card fills it; a person who renamed that section keeps their name.
> - **Rune**: ⤢ still opens the in-window level; the question isn't drawn.
> - **Sub-grids: the question can be off screen.** It sits at the section's top right (where the remove question does). Asked from the right-click menu low in a section taller than the window, it is above the view; the same is true of *Remove section…*.
> - **Preview cost**: every grid card on screen asks its outline every 4 s. Fine for a handful; a grid of many child cards would want one request or a change signal.

## Plan cards (docs/plan.json)

- **Review**: "Open as its own grid makes a real sub-grid; the old grid keeps a preview and a link" (this branch).
- **Next**: "Dissolve a sub-grid back into its parent section (the undo of Open as its own grid)".
- **Next**: "Hosted-app sections: offer Open as its own grid".
- **Later**: "Sub-grid previews: one change signal instead of a 4 s poll per card".
- **Later**: "Rune: draw the make-it-a-grid question; ⤢ makes a sub-grid".
- **Later**: "Guard a moved card against an offline device bringing it back".
