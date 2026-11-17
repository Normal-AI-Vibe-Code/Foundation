# What the pointer does (2026-11-17)

Josh, 2026-11-17:

1. "I think part of the reason I can't delete things, is because left mouse is always grabs, where it really [should] only grab on the grid, or a top handle of a section or a menu."
2. "Ctrl Zoom should always zoom and alt+scroll should scroll a card -> show a small icon on roll-over, allow user to dismiss this hint."
3. "I think it might be better for the right mouse click to open add and live next to each other, and make the grid manipulation buttons in a line on the bottom, with roll-over descriptions, instead of words next to them."

Branch `worktree-agent-a27d11090679c0c65`. Nothing here edits SPEC.md, DESIGN.md or docs/plan.json: the rows to paste are below.

## 1 · What a left press grabs

### What was found (before any change, real mouse moves in Chromium, web renderer)

A probe pressed a character card's ✕, its Keep, a button in its body, a kanban button, a note and a table cell at drawn scales 1.0, 0.6 and 0.3 (zoom × the section's fit), moving the real mouse there in steps and pressing where it stood.

- **No press was eaten on a character card.** ✕ asked, Keep kept, Remove removed, the body's buttons got their click, at all three scales. The owner's belief (a grab swallowing the ✕) was **not reproduced** in the web renderer; the same was written on the `card-chrome` card on 2026-11-16.
- What is true and feels like it: at 0.3 the ✕ is **7.8 px** on screen (15.6 at 0.6, 26 at 1.0), and everything round it in the bar is the drag handle. A near miss there picks the card up instead of removing it. In a section fitted below 100 % and zoomed out it is smaller still.
- A card with a bar (notes, panels, characters, kanban, machines) never dragged from its body: only its bar did. Tables and maps drag by their own headers only.
- **Images and videos did drag from anywhere on them** ("the whole card is the drag handle"): the one place a body press was a grab in the web renderer.
- **Under Rune** (opt-in renderer), a note or an image Rune draws is grabbed from anywhere on the card (`apps/rune/src/view.rs`, `frame.cursor(Cursor::Grab).on_drag`). Characters, kanban and every other panel are web islands there and behave as above. Not changed here (Rust, its own toolchain and e2e).

### What was built

- `ObjectFrame`: an image or a video no longer drags from its body. It has a **grip**: a 28 px round, top-left, 8 px in, of the icons' family, there while the pointer is on the card (always, where there is no hover; not for a viewer), `data-tip="Drag to move"`. A click on a video's body still plays or pauses it (now a click on the body, no longer "a drag that didn't move").
- A press in the gap between two of a bar's buttons (`.header-actions`), or on a link in a bar, is no longer a grab.
- Unchanged, and now held by a check: the paper pans, a section's header moves the section, a card's bar moves the card; the middle and right buttons and Space pan from anywhere.

### How it was checked

`e2e/pointer.spec.ts` 1 and 1b (Chromium, `page.mouse` moves, presses and releases; no `dispatchEvent` for anything under test; the camera is set to each scale with a synthetic pinch, which is staging):

- at 1.0, 0.6 and 0.3: a drag started on a character's body moves neither the card nor the grid; a button in the character's card and one in a kanban get the click (the click event's target is that button); ✕ asks and Keep keeps; a drag across a note's line selects its words and moves nothing; a click picks a table's cell, and another picks another. Then at 0.3: ✕, Remove, and the character is gone.
- a note dragged by its bar floats and moves; a press between two bar buttons moves nothing; a drag on a picture moves neither it nor the grid; its grip is at 8, 8, 28 px round, hidden at rest and there on hover, and moves it; a tap on a video flips `autoplay` both ways, its grip moves it without a tap; a drag on bare paper pans.
- `e2e -- sections` still drags sections by their headers (swap, past an edge).

### Not done / not verified

- **Rune's own cards** (notes, images it draws) still grab from anywhere.
- **The ✕ is still 7.8 px at 0.3.** Nothing was done about the size of a bar's buttons when a card is drawn small; that is the likelier cause of "couldn't remove it" than a swallowed press. See the plan card below.
- Touch, the desktop window (WebView2), a Mac: not run. A real video file was not played (the check uses a video card with no file and reads the `autoplay` flag a tap sets).
- Machine cards were not opened in this check (no engine in e2e): their body is `ObjectFrame`'s like every panel's, and their files were another session's.
- `DesignPage.tsx` has an older image specimen (≈ line 583, "On call") with no grip; it was left alone as asked.

## 2 · Wheel keys

### What was built

- `lib/cardScroll.ts`: **⌘/Ctrl-wheel always zooms the grid.** **Alt-wheel** (⌥ on a Mac) scrolls the card under the pointer: the nearest scrolling pane with room, then the ones around it; ⇧ turns it sideways; at the card's end the wheel is **held** (no pan, no zoom, however long the pause); over the paper or a card with nothing to scroll, Alt changes nothing and the wheel pans. Ctrl+Alt is a zoom. The 350 ms "beat" is gone.
- `lib/scrollHint.ts`: when the pointer rests 320 ms on a card with more in it than fits, **a mark** comes up on the card's right edge (8 px in, mid-height, by the scroll line): a 20 px light round with a wheel glyph, "Alt" under it as a key (⌥ on a Mac), solid fills, no blur. Roll-over label (`data-tip`): "Alt + scroll to scroll through this card" ("Option + scroll…" on a Mac). Its ✕ (on roll-over of the mark; tip "Got it") puts it away for good on this device (`localStorage` `foundation-scroll-hint` `{off, used}`); it also stops by itself after three Alt-scrolls (wheel events within 600 ms are one scroll). One element for the page, moved onto the card; nothing in React state.

### How it was checked

- `test/card-scroll.test.ts` (9): the verdicts (scroll / hold / pass), deltas and ⇧; the hint's memory (wanted until dismissed or 3; round trip; rubbish reads as new; one turn is one scroll; counting never revives a dismissed hint); the mark's markup has the key, the ✕ with `data-tip`, and no `title`.
- `e2e/pointer.spec.ts` 2: over a long note Ctrl-wheel zooms and the note's `scrollTop` stays 0; Alt-wheel scrolls it and the world transform is unchanged; to the end and four turns past: unchanged; Ctrl+Alt zooms; no key pans; Alt over a short note pans without zooming.
- 2b, on a new device: no mark until the pointer rests; then it is on that card, 20 × 20, within 16 px of the right edge, "Alt", no backdrop-filter, no `title`; rolling over it shows the app's tip with the label and the ✕; not on a short card; gone when the pointer leaves. Three Alt-scrolls (memory reads 1, 2, 3; two wheel events per turn count once) and it no longer comes up, nor after a reload. On another new device: ✕ (tip "Got it") dismisses it, memory is `{off: true, used: 0}`, nothing moved, it never comes back (rest again; reload), and Alt-scroll still works.
- `e2e/card-chrome.spec.ts` 3, 3b, 4 and its day/night check were moved to Alt (a note, a character, a design chapter scroll with Alt; Ctrl over the long note zooms; a pinch zooms).

### Not done / not verified

- **⇧ sideways** is covered by the unit test only: no card on the e2e board is wider than its pane.
- Not run on a Mac (⌥), a real trackpad, Firefox (Alt-wheel is history there unless prevented: it is `preventDefault`ed, untested), or the desktop window. On Windows a bare Alt press can focus the window menu in some shells; not seen in Chromium.
- A live page or a terminal still can't be given the wheel this way (they need "in use"); the mark doesn't appear on them because their scrolling isn't the page's.
- The mark is in the zoomed world, so at 0.3 it is 6 px: readable only from about 0.6 up.
- `#/design`'s "Using a card" **note** still says ⌘/Ctrl-wheel scrolls a card (DesignPage.tsx was not to be touched beyond one mount line). Replace in that `note`: `over a card with more in it than fits, ${IS_MAC ? "⌘" : "Ctrl"}-wheel scrolls through that card instead, and zooms again a beat after it reaches the end.` with `${IS_MAC ? "⌥" : "Alt"}-wheel scrolls through a card with more in it than fits (a small mark on the card says so until it's dismissed or learnt).`

## 3 · A section's right-click menu

### What was built

- `components/menuLayout.ts` (new, pure): `MenuItem.group?: "add" | "live" | "grid"`; `layoutMenu` (zones: top rows, two columns, an icon row with the dangerous one last); `nextSpot` (the arrow keys).
- `components/ContextMenu.tsx`: a menu whose items name a group is drawn as: the council across the top; **Add** and **Live** as two columns side by side under their captions; under a hairline, **the grid's own actions as a row of 30 px icon buttons, no words**, each with `data-tip` and `aria-label` (never `title`): open as its own grid / open its grid / back up a level / fill the screen (as before, by case), insert left, right, above, below, split column, split row, *Show X as a card* / *Let X fill the section* (moved here from Live), and **Remove section…** last, in the bad colour, behind its own hairline. A menu with no groups is the list it was (an empty cell's, a table cell's).
- Keys (new: the menu had only Esc): ↑ ↓ within a column and on to the zone above or below (round at the ends), ← → between the columns keeping the row, and along the icon row; ↑ from the icon row returns to the column last in; Home, End; Enter or Space acts; the grid doesn't pan under the arrows while a menu is open. What has the keyboard wears the pointer's fill.
- It is measured after layout and kept 12 px inside the window (it was estimated, and 248 px wide was assumed); `width: max-content` so opening near the right edge doesn't stack the columns; on a window too narrow for two columns they stack and the icon row wraps; longer than the window, it scrolls inside itself as before.
- `sectionMenu.ts`: the same items, ids and labels; only tagged with their group (the "Sections" caption and the dividers are gone). Rune opens the same list through the same component.

### How it was checked

- `test/menu.test.ts` (8): layout; a plain menu stays a list; the section's list has every label in its group (read from the source); the arrow keys in all directions, the round trips, a plain list, an empty menu.
- `e2e/pointer.spec.ts` 3: the council first and full width; two columns at the same top with exactly the Add and the Live labels; the icon row under them, one line, under a 1 px rule; eight icons with `data-tip` = `aria-label`, no `title`, at most one glyph of text; Remove last, `--danger`, more than 10 px apart; rolling over shows "Insert section left" and "Remove section…" in the app's tip; inside 1440 × 900. Keys: ↓ council, ↓ Text box, ↓ Markdown note, → Huddle, ↑ Agents card, ← Text box, End Remove, ← Split row, ↑ App or web page…, round to the top; the grid didn't pan; Enter on Markdown note added a note and closed it; Esc closes. A real click on the Split column icon split the section. Opened at the bottom-right-most section corner it stays inside the window. A table cell's menu is still a list and ↓ walks it.
- 3b: at 420 × 640 the menu is inside the window (columns stacked or side by side within it) and scrolls inside itself; an empty cell's menu is the two-row list (*Create section at …*, and the violet one), and ↓ ↓ lands on the second.
- `e2e -- section-agents` (5) and `sections` pass with the icon row; `rune.spec.ts`'s two menu assertions were rewritten to the icons' labels but **Rune's e2e was not run** (no wasm build in this worktree).

### Not done / not verified

- **Rune**: the menu is the same component, but its spec wasn't run here.
- Glyphs are the ones the list already had (⤢ ← → ↑ ↓ ◫ ⬓ ◱ ◳); only Remove got a drawn bin (an emoji wouldn't take the bad colour). Drawn icons for insert/split would read better.
- A disabled Remove (the last section) is `aria-disabled`, not `disabled`, so it can still name itself on roll-over; not checked in the browser.
- No type-ahead; Tab still walks the buttons in DOM order.

## Evidence (this folder)

| File | What |
|---|---|
| `01_remove-asks-at-0.3-night.png` | a character drawn at 0.3: ✕ pressed with the real mouse, the card asks |
| `02_image-grip-night.png`, `12_image-grip-{day,night}.png` | an image under the pointer: the grip top-left, the icons on the right |
| `03_`, `04_`, `10_`, `11_scroll-hint…` | the mark on a long note, and its label and ✕ under the pointer, day and night |
| `05_`, `13_`, `14_section-menu…` | the section's menu on the board with an icon's label up, day and night |
| `06_section-menu-narrow-night.png` | the menu at 420 × 640 |
| `20_design-cards-{day,night}.png`, `22_design-menus-{day,night}.png`, `21_design-menu-…` | `#/design` → Using a card: the specimens |
| `30_`, `31_alt-wheel…` | from `card-chrome`: Alt-wheel scrolling a note and a character |

Runs (all green, Chromium headless, ports above 15000): `pointer` 7; `card-chrome` 7; `card-use` 1; `wheel` 3; `sections` 6 (1 skips itself as before); `section-agents` 5; `fitted-frames` 1; `together` 7. `npm test` (every workspace, 0 failures; the client's 165 include `card-scroll` 9 and `menu` 8) and `npm run typecheck` green.

## DESIGN.md: replacement rows (§5)

**Card (frame)**: change one clause. Replace `actions (repo, MCP, open, dock/float, ✕); it is the drag handle.` with:

> actions (repo, MCP, open, dock/float, ✕); **it is the card's one drag handle** (2026-11-17, Josh: "left mouse is always grabs, where it really should only grab on the grid, or a top handle of a section or a menu"): a left press on a card's body never picks it up and never takes the click (a button, a link, a caret, a selection are the body's own); a press on one of the bar's buttons, or in the gap between two, isn't a grab either.

**Media card**: replace the last sentence `The whole card is the drag handle; a tap on a video plays/pauses it` with:

> **It moves by a grip** (2026-11-17): a 28 px round of the icons' family in the top-left corner (8 px in; the two grip lines), there while the pointer is on the card and a beat (150 ms) after, always where there's no pointer to hover with, not offered to a viewer; `data-tip` *Drag to move*. The picture itself is not a handle; a click on a video plays/pauses it

**Carrying a card**: change the opening `Drag a card (any kind) out of its section` to `Drag a card (any kind) by its bar, or an image or video by its grip, out of its section`. The rest stands.

**Using a card**: replace from `**⌘/Ctrl-wheel** zooms the grid, except over a card…` through `…a pinch (no key down) always zooms.` with:

> **⌘/Ctrl-wheel always zooms the grid** (2026-11-17, Josh: "Ctrl Zoom should always zoom and alt+scroll should scroll a card"). **Alt-wheel** (⌥) **scrolls through the card under the pointer** when it has more in it than fits: the nearest scrolling pane with room, then the ones around it; ⇧ turns it sideways; at the end the wheel is held (Alt means the card: no pan, no zoom); over the paper or a card with nothing to scroll, Alt changes nothing. **The mark that says so**: when the pointer rests (320 ms) on a card with more than fits, a 20 px round in `--color-frost` with a wheel glyph in `--color-void`, and *Alt* under it as an 11 px key, sits on the card's right edge (8 px in, mid-height, by the scroll line); solid fills, fades on opacity; roll-over label *Alt + scroll to scroll through this card*. A 14 px ✕ at its corner (on roll-over; *Got it*) puts it away for good on this device, and it stops by itself after three Alt-scrolls.

and in the row's last sentence add `lib/scrollHint.ts` after `lib/cardScroll.ts`.

**Right-click menu**: replace the row with:

> | **Right-click menu** | Raised paper at 94 % with one blur, card radius, 30 px rows (13/500; ink fill under the pointer, and on what has the keyboard). **A section's menu is laid out in three bands** (2026-11-17, Josh: "open add and live next to each other, and make the grid manipulation buttons in a line on the bottom, with roll-over descriptions, instead of words next to them"; `components/menuLayout.ts`): it **leads with ⚇ Council: ask this section's agents…** in `--color-agent`, across the top; then **Add** (Text box, Markdown note, Table, Map, Image, video or file…, App or web page…) and **Live** (Agents card in violet, Huddle, Slack channel, Machine, Character: 3D, Character: mesh avatar, All agents on this grid) as **two columns side by side** (196 px at least each) under 11/600 uppercase captions in dim (`.menu-heading`, 24 tall); then, under a hairline, **the grid's own actions as a row of 30 px icon buttons with no words**: open as its own grid (or open its grid / back up a level / fill the screen), insert section left / right / above / below, split column, split row, show a hosted app as a card or let the one app fill the section, and **Remove section…** last, in `--color-bad`, set apart behind a hairline of its own. Each names itself on roll-over (`data-tip`) and to a screen reader. **Keys**: ↑ ↓ within a column and on to the band above or below, ← → between the columns and along the icon row, Home / End, Enter does it, Esc closes; the grid doesn't pan under the arrows while a menu is open. It is as wide as its columns wherever it's opened and is kept 12 px inside the window; on a window too narrow for two columns they stack and the row wraps; longer than the window, it scrolls inside itself. A menu with no bands is a plain list, 208 wide at least: an empty cell's (Create section, and *Create it and ask an agent to build it…* in violet), a table cell's |

**Section header**, **Resize corner**: no change. (The header was already the section's only handle; the corner is unchanged.)

**§9 checklist**: no change; this slice was held to it (tokens only; `#/design` first; day and night; the hint and the grip fade on opacity and come in on a margin, never a transform; no blur in the world; `data-tip`, never `title`).

## SPEC.md

**§3, the row "⌘/Ctrl-wheel scrolls through a card; a 2 px scroll line" (2026-11-16)**: retitle it `**Alt-wheel scrolls through a card; a 2 px scroll line**` and replace its first sentence group (through "a terminal and a live page still need "in use".") with:

> **⌘/Ctrl-wheel always zooms; Alt-wheel scrolls through a card** (2026-11-17, Josh: "Ctrl Zoom should always zoom and alt+scroll should scroll a card -> show a small icon on roll-over, allow user to dismiss this hint"; it was ⌘/Ctrl-wheel for a day): over a card with more in it than fits, Alt-wheel scrolls that content (nearest pane with room, then outward; ⇧ sideways) and holds at its end; elsewhere Alt changes nothing (`lib/cardScroll.ts`). A 20 px mark on such a card says so when the pointer rests on it; its ✕ dismisses it for good on the device and it stops after three Alt-scrolls (`lib/scrollHint.ts`). Checked in Chromium on notes, a character and a design chapter (`e2e/pointer.spec.ts`, `e2e/card-chrome.spec.ts`, `test/card-scroll.test.ts`); **not** on a Mac, a real trackpad, Firefox, the desktop window, or sideways in a browser; a terminal and a live page still need "in use".

status stays `done in Chromium`.

**§3, new rows:**

> | **A left press grabs only a handle** (2026-11-17, Josh: "left mouse is always grabs, where it really should only grab on the grid, or a top handle of a section or a menu") | A plain left drag moves something only from the paper (pans), a section's header, or a card's own bar; an image or a video, which has no bar, by a 28 px grip that comes up in its top-left corner (it used to drag from anywhere on it). A press on a card's body is the body's: buttons, ✕, links, a note's words (they select), a table's cells. A press between two of a bar's buttons isn't a grab. Middle, right and Space panning are as they were. `components/ObjectFrame.tsx`, on `#/design` | done on the web renderer; **not under Rune** (a note or image Rune draws still grabs from anywhere) | `e2e/pointer.spec.ts` 1, 1b: real mouse moves at drawn scales 1.0, 0.6 and 0.3 on a character (✕, Keep, Remove, a body button, a body drag that moves nothing), a kanban's button, a note's words, a table's cells; bar, grip, video tap and paper. Before the change no press on a character's ✕ was found to be eaten at any of the three scales; the ✕ is 7.8 px at 0.3. `docs/evidence/2026-11-17_pointer/`. Not run: touch, the desktop window, a Mac, a real video file |
> | **A section's menu in three bands** (2026-11-17, Josh: "open add and live next to each other, and make the grid manipulation buttons in a line on the bottom, with roll-over descriptions") | The council across the top; Add and Live as two columns; the grid's own actions (open / back up, insert ×4, split ×2, fill or show-as-card, Remove last and apart in the bad colour) as a row of icons named on roll-over. Arrow keys move through it (new: it had only Esc), Enter acts. Measured and kept inside the window; stacks on a narrow one. `components/menuLayout.ts`, `ContextMenu.tsx`, `sectionMenu.ts` (same items and labels, regrouped; Rune opens the same list) | done on the web renderer; Rune not run | `test/menu.test.ts` (8); `e2e/pointer.spec.ts` 3, 3b; `e2e -- section-agents sections` pass. `e2e/rune.spec.ts`'s two menu assertions were rewritten for the icons and not run |

**§7**: replace the bullet `**⌘/Ctrl-wheel over a long card can't zoom the grid** until the card is at its end and the wheel has rested 350 ms. …` with:

> - **Alt-wheel through a card** (2026-11-17) is checked in Chromium only: not on a Mac (⌥), a trackpad, Firefox or the desktop window; ⇧ sideways has a unit test and no browser check. The mark that teaches it is drawn in the zoomed world, so below about 0.6 it is too small to read.

and add:

> - **A card's ✕ is small when the card is.** At a drawn scale of 0.3 a bar's ✕ is 7.8 px, and the bar round it is the drag handle: a near miss picks the card up. No press on a character's ✕ was found to be swallowed (2026-11-16 and again 2026-11-17, real mouse, 1.0 / 0.6 / 0.3), so this is the likelier reason a card "couldn't be removed". Not fixed.
> - **Under Rune a note or an image is still grabbed from anywhere on it** (`apps/rune/src/view.rs`): the 2026-11-17 grab rule is the web renderer's only. Rune's e2e was not run against the new menu.
> - **`#/design` → Using a card**: its paragraph still describes ⌘/Ctrl-wheel scrolling a card, and its older "On call" image specimen has no grip (DesignPage.tsx was left to another session; the replacement sentence is in `docs/evidence/2026-11-17_pointer/NOTES.md`).

## Plan cards (docs/plan.json)

Move `card-chrome` as it is (its Ctrl-wheel is superseded; add to its body: "Ctrl-wheel through a card became Alt-wheel on 2026-11-17, `pointer`.").

```json
{
  "id": "pointer",
  "title": "The pointer: a left press grabs only a handle, Alt-wheel scrolls a card (with a hint), the section menu in three bands",
  "kind": "plan",
  "milestone": "polish",
  "area": "panels",
  "status": "review",
  "body": "Built 2026-11-17 (`docs/evidence/2026-11-17_pointer/NOTES.md`). A left drag moves only from the paper, a section's header or a card's bar; images and videos move by a grip in their corner. Ctrl/⌘-wheel always zooms; Alt-wheel scrolls the card under the pointer, and a small mark on such a card says so until dismissed or learnt. A section's right-click menu: the council, Add and Live side by side, the grid's actions as a row of icons with roll-over names; arrow keys. No swallowed press on a character's ✕ was found."
},
{
  "id": "card-x-when-small",
  "title": "A card's ✕ is 8 px when the card is drawn at 30 %",
  "kind": "bug",
  "milestone": "polish",
  "area": "panels",
  "status": "next",
  "body": "The bar's buttons scale with the card, and the bar round them is the drag handle, so a near miss grabs. Likelier than a swallowed press as why a character 'couldn't be removed'. Options: keep the bar at screen size below some scale (a screen-space bar, like the tip), or offer Remove on the card's right-click."
},
{
  "id": "pointer-rune",
  "title": "Rune: cards grab only by their bar or grip; run its e2e on the new menu",
  "kind": "plan",
  "milestone": "polish",
  "area": "rune",
  "status": "backlog",
  "body": "`apps/rune/src/view.rs` drags a note or an image from anywhere on it. Bring it to the 2026-11-17 rule, and run `e2e -- rune` (its two menu assertions were rewritten for the icon row, unrun)."
},
{
  "id": "pointer-elsewhere",
  "title": "The pointer rules on a Mac, a trackpad, touch and in the desktop window",
  "kind": "plan",
  "milestone": "polish",
  "area": "panels",
  "status": "backlog",
  "body": "Alt/⌥-wheel, ⇧ sideways in a browser, the grip with no hover, the menu's keys, and the `#/design` Using-a-card paragraph and its old image specimen (DesignPage.tsx)."
}
```
