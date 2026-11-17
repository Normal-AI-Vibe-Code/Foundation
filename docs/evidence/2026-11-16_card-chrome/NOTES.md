# Card chrome, 2026-11-16

Josh: "I attempted to delete Taro and couldn't … Allow me to remove Taro. The Cards roll over menu covers up the card contents, it should push it down. also there needs to be a ctrl+scroll feature to scroll through a card. make the scroll bar much thinner and basically 2px line next to the edge of the card and light colored. Make the re-size handles much thinner and really just a gleam on the card corner, and don't show it until hovering over."

This folder holds the evidence and the text for `DESIGN.md`, `SPEC.md` and the plan, which this branch does not edit.

## What was found and built

### 1. Removing a character

**What I could reproduce, and what I couldn't.** In Chromium (Playwright, a real pointer walked onto the ✕, with the starter set on a fresh studio so the card was the real Taro, a mesh avatar on the second row of *Characters · Animals*) the ✕ in a character card's hover bar **worked**: the button was the top element under the pointer, the click removed the card, the server's `GET /api/characters` dropped Taro, and it stayed gone after a reload. I tried it framed on the card, with the section framed (the ✕ is 13 px there), with the press held 240 ms, and with the mesh avatar live. I did not find a way to make the click itself fail, and I have not tried the packaged desktop window.

**What was broken.** The card went and the character didn't, in every open browser:

- The character's state lives in the board's `characters` map, which only the server writes (`boards.ts` SERVER_MAPS). A person removing the card deletes the card from `objects`; nothing took the character out of `characters`.
- The client's roster (`characters/roster.ts`: the council's seats, the bench, the pickers) re-reads `/api/characters` only when that map changes. So after the card was removed, **no request was made** (measured: 0 in 8 s) and Taro stayed on the council, on agents, and in every picker until the page was reloaded. An agent's `delete_card` left the same stale entry.

That matches "attempted to delete Taro and couldn't": the card is gone and Taro is still there. If Josh's ✕ itself did nothing, that is a different fault and it is still open; I'd want to know where he pressed (the card's bar, the council, Settings).

**Built.**

- `apps/server/src/characters.ts` `followCards`: the server watches each board's cards. A card that goes takes its character out of the `characters` map (whoever removed it: a person, an agent, a tool); a card that comes back (a device that was offline) gets its character back from its row. Rows and files are never deleted. Every open browser's roster follows within half a second, with no client change.
- `components/ObjectFrame.tsx` `confirmRemove`: a card that would lose something asks first, on the card, under its bar: "Remove **Taro**? Its pictures and files stay in the archive." **Remove** (the bad colour) and **Keep**. Esc and a click elsewhere keep it. `panels/PanelView.tsx` asks for character cards only; every other card's ✕ is as it was.
- A viewer has no ✕ (unchanged: `body.is-viewer .frame-header .header-actions`), and the server refuses a viewer's socket writes (unchanged, `roles.test.ts`).

### 2. The hover bar makes room

The bar (30 px, 5 px in) no longer lies on the content. While it shows, what's in the card sits **38 px lower** (5 + 30 + 3), on the bar's curve (`--ease-out-soft`, `--dur-pane`) and its 140 ms linger.

- The card's box never changes, so nothing else in the section moves (checked: card, the card beside it, the section, the resize corner are pixel-identical before and after).
- Two ways, by what the card holds: `.bar-reflow` (notes, characters, kanban, design chapters, Slack, huddles, connectors, asks, agents, stages, grid links, crew) gets **shorter from the top** (`margin-top` + `height`, inside the card only), so its last line and its bottom controls stay in the card and a list can still be scrolled to its end; `.bar-slide` (apps, links, machines, files) only **slides** (`translate`, clipped by the body), so a page, a terminal or a model is never resized for a hover.
- The note editor used to start 42 px down to clear the bar; it now starts 14 px down and is pushed once like everything else.
- Images and videos have no bar and are untouched. Tables and maps keep their own headers and are untouched. Ports and the resize corner sit outside the body and don't move. No bar (and no push) while a wire is being dragged or the card is full screen.

### 3. Ctrl-wheel scrolls through a card

`lib/cardScroll.ts`. The rule:

- The wheel alone is the grid's, everywhere, as before.
- ⌘/Ctrl-wheel over a card with more in it than fits scrolls that content: the nearest scrolling pane under the pointer that has room that way, then the ones around it, inside the card. ⇧ turns it sideways.
- At the end the wheel is **held** (nothing moves) for as long as the turning goes on, and zooms the grid again after 350 ms of quiet. Reaching the end of a list never lurches into a zoom.
- Over the paper, or a card with nothing to scroll, it zooms as before.
- A trackpad pinch (a Ctrl-wheel with no key down) is always the grid's zoom: `cardUse.ts` tracks the real key (keydown, and any pointer move).
- Live pages are unchanged: a wheel can't be handed into a frame, so they still need "in use".
- A mouse wheel's step glides (a third of what's left per frame); a trackpad follows 1:1; `prefers-reduced-motion` jumps.

No hint pill mentions the wheel, so none changed. The "Using a card" note on `#/design` says the new rule.

### 4. Scroll bars

`shell/spaces.css`: a **2 px** line, **1 px** in from the pane's edge, `color-mix(in srgb, var(--color-frost) 28%, transparent)`, square, clear at rest, shown under the pointer and for 0.7 s after a scroll. The strip it can be grabbed in is still 8 px. Everywhere: `privacy.css` had its own `scrollbar-width/color` (which, in Chromium, switches the page to the system's thin bar) and now uses the one kind.

### 5. The resize corner

`.map-resize` (cards, images, maps): nothing at rest. With the pointer on the card, a **1 px arc on the card's own bottom-right corner**, 10 px each way, fading out at both ends; under the pointer it is `--color-pulse`. Opacity only (120 ms linger), no transitioned colour. The grab area is the same 22 px square reaching 2 px past the card's edge. On a device with no hover it shows. Sections' gutters already show only under the pointer (a line and a knob, a different look) and are unchanged.

## How it was checked

- `npm test && npm run typecheck`: green. New: `apps/client/test/card-scroll.test.ts` (5: room, nearest pane, hold then zoom, nothing to scroll, deltas), `apps/server/test/characters.test.ts` ("a character goes with its card": off the roster, out of the map, row and files stay, an agent's delete does the same, a card that comes back brings it back).
- `apps/client/e2e/card-chrome.spec.ts`, Chromium, 7 of 7 (scroll bars drawn: headless hides them by default, the spec turns that off):
  1. A character draws its sheet (stand-in Meshy); a viewer sees the bar and no ✕; ✕ asks; Keep, Esc and a click elsewhere keep it; Remove takes the card off for both people, the board's map lets go, the browser re-reads the roster by itself, `GET /api/characters` no longer lists it, its sheet is still served from the archive, and it is still gone after a reload.
  2. A note: content 38 px lower × the card's scale, bar above it, bottom edge unmoved, card / neighbour / section / corner identical; back when the pointer leaves; writing puts the first line 38 + 14 below the card's top. A live app: frame 38 px lower, the page's `innerWidth/innerHeight` and the iframe's size unchanged, 0 reloads, card identical.
  3. Wheel alone pans and the note doesn't scroll; Ctrl-wheel scrolls it and the world's transform is byte-identical; to the end; four more turns don't zoom; after 600 ms the same turn zooms; a short note and the paper zoom; a synthetic pinch zooms and doesn't scroll; a design chapter card scrolls. 3b: a character card scrolls.
  4. Computed `::-webkit-scrollbar-thumb`: borders 5/1 across an 8 px strip (2 px left), square, clear at rest, 28 % under the pointer and while `.is-scrolling`, clear again after.
  5. Corner opacity 0 at rest, 1 with the pointer on the card; arc 10 × 10, 1 px, radius 5; 22 px square past the corner; `--color-pulse` under the pointer; dragging it 8 px in from the corner resizes the card; gone when the pointer leaves.
  6. Day and night: the board and `#/design` ("Using a card": four specimens on the real classes; the live one hovered).
- Neighbours, all green: `card-use` (1), `wheel` (3), `sections` (6, 1 skipped as before: no empty cell), `fitted-frames` (1), `council` (7).
- Run with: `E2E_SERVER_PORT=15731 E2E_CLIENT_PORT=15751 E2E_SLACK_PORT=15741 E2E_MESHY_PORT=15745 E2E_T3_PORT=15795 npm run e2e -w @foundation/client -- card-chrome`.
- `e2e/playwright.config.ts`: `E2E_STARTER=<folder>` brings a starter set onto the e2e server (off by default). It is how the real Taro was tried.

### Pictures

| | |
|---|---|
| `01_remove-asks-night.png`, `12_remove-asks-day.png`, `12_remove-asks-night.png` | the question, on the card |
| `02_note-at-rest-night.png`, `03_note-bar-makes-room-night.png`, `10_note-hovered-day.png`, `10_note-hovered-night.png` | a note at rest, and with the bar in its room |
| `03b_writing-pushed-once-night.png` | writing: one push, not two |
| `04_app-bar-makes-room-night.png` | a live app slid down under its bar |
| `05_ctrl-wheel-scrolls-the-note-night.png`, `06_ctrl-wheel-scrolls-a-character-night.png` | Ctrl-wheel in a note and a character |
| `07_scroll-line-night.png`, `11_corner-and-scroll-line-day.png`, `11_corner-and-scroll-line-night.png`, `24_scroll-line-close-up-day.png`, `24_scroll-line-close-up-night.png` | the scroll line (24: 3×) |
| `08_resize-gleam-night.png`, `22_corner-close-up-day.png`, `22_corner-close-up-night.png`, `23_corner-under-the-pointer-day.png`, `23_corner-under-the-pointer-night.png` | the corner (22, 23: 3×) |
| `20_design-day.png`, `20_design-night.png`, `21_design-live-hovered-day.png`, `21_design-live-hovered-night.png` | `#/design`, "Using a card" |

## Not done, not verified

- **The ✕ that "couldn't"**: not reproduced as a dead click (see 1). Not tried in the packaged desktop window.
- Only Chromium, on Windows, with a mouse wheel. Not checked: a Mac (⌘-wheel), a real trackpad (the pinch check is a synthetic event), Firefox (it gets `scrollbar-width: thin` in the same tone: its thinnest, not 2 px), the Tauri window.
- The bar's room was looked at on notes, a live app, a character and a design chapter. **Not looked at in a browser**: Slack, huddle, kanban, connector, ask, agent, stage, grid link and crew cards (they share `.bar-reflow`), machines and file previews (`.bar-slide`). A machine's terminal slides, so its last 38 px (often the prompt line) are under the card's edge while the pointer is on it.
- Ctrl-wheel was checked on notes, characters and a design chapter. Not checked: kanban (same scroller as the design card), Slack and huddle lists, a terminal's scrollback (I expect it still zooms and needs "in use" as before, since xterm's scroller isn't an ancestor of what the pointer is on; not tried). Tables don't scroll (the sheet grows), so over a table it zooms.
- No frame-rate run (`PERF_GPU=1 … frames`) on the new motion. `.bar-reflow` lays out the inside of one card for the 280 ms the bar moves.
- A character moved to another board with `send_to_board` keeps its row on the old board, as before; it now leaves the old board's map when its card leaves.
- Rune (the GPU renderer) draws its own frames; not checked there.

## Decisions Josh might want differently

1. **Removing asks only for characters.** Every other card's ✕ is still immediate. The same prop (`confirmRemove`) can ask for machines, tables or anything else.
2. **Removal keeps the character's row and files.** It leaves the board and every council; nothing is erased, and there's no "bring it back" in the app yet (the card can't be undone into place).
3. **38 px**, and **two ways to make room** (shorter from the top, or slide). Sliding hides the bottom 38 px of an app, a machine or a file while the pointer is on it.
4. **At the end of a card the wheel holds, then zooms after 350 ms.** A card with a long scroller can't be zoomed over until its end; move off it or let go of Ctrl.
5. **The gleam is not `--color-line-strong`**, which was asked for: the card's edge is that same tone, so the arc couldn't be seen. It is the edge lifted 60 % toward `--color-frost` (bright at night, ink by day), and `--color-pulse` under the pointer.
6. **The scroll line is 28 % frost and doesn't brighten when grabbed.** The grab strip is still 8 px wide.
7. `Remove…` on the ✕'s tip for a card that asks.

## For DESIGN.md (exact replacement rows)

**Scroll bars** (replaces the row):

```
| **Scroll bars** | Everywhere, one kind (2026-11-16, Josh: "much thinner and basically 2px line next to the edge of the card and light colored"): a 2 px line with square corners at 28 % `--color-frost`, 1 px in from the pane's edge, on a clear track (the strip it can be grabbed in stays 8 px). Clear at rest; shown while the pointer is on the pane and for 0.7 s after it scrolls. No arrows, no track, no radius, no second tone |
```

**Card (frame)** (replaces the row):

```
| **Card (frame)** | Paper on the desk, card radius, **no bar at rest** — the card is its content. On hover a bar (30 tall, 5 px inset; solid glass fill, no blur inside the world) drops in at the top edge and lingers 140 ms after the pointer leaves: grip · glyph + title · actions (repo, MCP, open, dock/float, ✕); it is the drag handle. **The bar is given room** (2026-11-16, Josh: "The Cards roll over menu covers up the card contents, it should push it down"): while it shows, what's in the card sits 38 px lower, on the bar's curve and linger. The card's box never changes, so nothing else in the section moves: the body clips, and its content either gets shorter from the top (`.bar-reflow`: notes, lists, characters, anything that lays out again cheaply; its last line and bottom controls stay in the card) or slides (`.bar-slide`: a page, a terminal, a model, which are never resized for a hover). Ports, rings and the resize corner sit outside the body and don't move. **✕ removes at once, except where that would lose something** (a character): then the card asks, under its bar, "Remove **Name**? Its pictures and files stay in the archive." with **Remove** in `--color-bad` and **Keep**; Esc or a click elsewhere keeps it. **No agent button on a card** (2026-11-15, Josh: "agents operate on the section level"): agents are spoken to on the section's council. A card an agent made, or that holds one, says so with the **agent pill**. Cards whose title matters at rest name themselves in their body (pipeline stages). Tables and maps keep their own headers (the sheet needs them) |
| **Resize corner** | 2026-11-16, Josh: "really just a gleam on the card corner, and don't show it until hovering over." Nothing at rest. While the pointer is on the card (images and maps too): a 1 px arc on the card's own bottom-right corner, 10 px each way, fading out at both ends, the edge's tone lifted 60 % toward `--color-frost`; `--color-pulse` under the pointer. It fades on opacity (160 ms, 120 ms linger), never a transitioned colour. The grab area is a 22 px square reaching 2 px past the card's edge. Shown always where there's no pointer to hover with; not offered to a viewer |
```

**Media card**: no change needed ("the resize corner come[s] with the pointer" is now true of every card).

**Using a card** (replaces the row):

```
| **Using a card** | 2026-11-11, Josh: "Don't allow any of the objects to take over scroll, give them a ctrl keyboard command to interact with them, and allow them to be fullscreened." **No card takes the wheel**: over a live app, a map, a terminal or a list, the wheel pans the grid. **⌘/Ctrl-wheel** zooms the grid, except over a card with more in it than fits, where it **scrolls through that card** (2026-11-16, Josh: "there needs to be a ctrl+scroll feature to scroll through a card"): the nearest scrolling pane under the pointer that has room, then the ones around it; ⇧ turns it sideways; at the end the wheel is held while the turning goes on and zooms again after 350 ms of quiet; a pinch (no key down) always zooms. A live page can't be given the wheel this way and still needs to be in use. The pointer on a live app shows a glass pill bottom-right, *Ctrl+click to use · Ctrl+Enter full screen* (⌘ on a Mac); holding the modifier rings the card under the pointer in `--color-pulse` (2 px, inset). **⌘/Ctrl-click** puts it **in use**: the same 2 px ring stays, and it alone takes the pointer and the wheel until Esc, a click elsewhere, or a pan of the grid (so it can't catch a pan as it slides under the pointer). **⌘↵ / Ctrl+Enter** (the card under the pointer, or the one in use) or **⤢** in its hover bar opens it **full screen**: the card itself, in the browser's top layer (an app doesn't reload), on `--color-abyss` under a 44 px `--color-raise` bar (name in frost 600, *Esc to return to the grid* in dim, *Open in a tab ↗* for a page, **Back to the grid**). Images and videos sit contained; a map and an app fill it. `lib/cardUse.ts`, `lib/cardScroll.ts`, `components/Fullscreen.tsx`, on `#/design` |
```

**Character card**: add at the end of the row: `Its ✕ asks first (see Card); removed, the character leaves every council with its card, and what it drew stays in the archive.`

**Huddles and Slack** on `#/design` says its tabs sit along the bottom "because the hover bar covers the top". The bar no longer covers it; that sentence (in `DesignPage.tsx`, outside the section this branch may edit) wants: "tabs and controls along the bottom, clear of the hover bar".

## For SPEC.md

§3, the row that begins **No card takes the wheel; Ctrl-click to use one…**: add to its description

```
**⌘/Ctrl-wheel scrolls through a card** (2026-11-16, Josh: "there needs to be a ctrl+scroll feature to scroll through a card"): over a card with more in it than fits it scrolls that content instead of zooming; at the end it holds, then zooms after 350 ms of quiet; a pinch always zooms (`lib/cardScroll.ts`). Checked in Chromium on notes, a character and a design chapter (`e2e/card-chrome.spec.ts`, `test/card-scroll.test.ts`); not on a Mac, a real trackpad, the desktop window, or Slack/huddle/kanban lists; a terminal and a live page still need "in use".
```

§3, the **Scroll bars** row, replace its description:

```
| | **Scroll bars** (2026-11-10: "invisible, and much more minimal, rectangles with half opacity that go away when not interacted with"; 2026-11-16: "much thinner and basically 2px line next to the edge of the card and light colored") | done | Everywhere: a 2 px square-cornered line at 28 % ink, 1 px in from the edge, shown only under the pointer or for 0.7 s after a scroll (`shell/spaces.css`, `lib/scrollbars.ts`). Chromium, day and night (`docs/evidence/2026-11-16_card-chrome/`); Firefox gets its thin bar in the same tone |
```

§3, new rows (cards):

```
| | **A card's bar is given room** (2026-11-16, Josh: "The Cards roll over menu covers up the card contents, it should push it down") | partial | While the hover bar shows, the card's content sits 38 px lower; the card's box, its section, its ports and its corner don't move. Lists and notes get shorter from the top, pages and terminals slide (`ObjectFrame.tsx`, `.bar-reflow` / `.bar-slide`). Checked in Chromium on a note, a live app (no reload, no resize), a character and a design chapter; Slack, huddle, kanban, machine and file cards not looked at; no frame-rate run |
| | **Resize corner: a gleam, on hover** (2026-11-16) | done | Nothing at rest; a 1 px arc on the card's corner while the pointer is on it, blue under the pointer, the same 22 px to grab (`.map-resize`). Chromium, day and night |
| | **Removing a character** (2026-11-16, Josh: "I attempted to delete Taro and couldn't … Allow me to remove Taro") | partial | The card's ✕ asks first ("Remove Taro? Its pictures and files stay in the archive."); removed, the server takes the character out of the board's map with its card, so every open browser's roster and council drop it at once (before, it stayed until a reload); its row and files stay. Checked in Chromium with two people (one a viewer) and in `characters.test.ts`. The ✕ doing nothing at all was **not reproduced**; not tried in the desktop window |
```

§7, new lines:

```
- **Removing a character, as built 2026-11-16** (`docs/evidence/2026-11-16_card-chrome/`): what was reproduced and fixed is that a removed card's character stayed on every council until a reload (nothing told the browsers). A ✕ that does nothing was not reproduced in Chromium; if it happens again, note where it was pressed. A removed character's row and files stay and there is no way in the app to bring one back.
- **A card's bar slides a page, a terminal or a file down** rather than resizing it, so the bottom 38 px of those cards are under the card's edge while the pointer is on them (a terminal's prompt line, often). Notes, lists and characters get shorter instead and lose nothing.
- **⌘/Ctrl-wheel over a long card can't zoom the grid** until the card is at its end and the wheel has rested 350 ms. Not checked on a Mac, a trackpad or in the desktop window.
```

## For the plan (docs/plan.json)

One card, in **Review**:

```
Card chrome: remove a character, the bar makes room, Ctrl-wheel through a card, 2 px scroll line, resize gleam
— branch worktree-agent-a50c1708652cc8624; evidence docs/evidence/2026-11-16_card-chrome/
```

Two for **Next**, if wanted:

```
Look at the bar's room on Slack, huddle, kanban, machine and file cards; run the frame-rate check on it
Card chrome on the desktop window, a Mac and a trackpad (⌘-wheel, pinch, the ✕ on a character)
```
