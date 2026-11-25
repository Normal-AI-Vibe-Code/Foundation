# One note (2026-11-24)

**The ask (Josh).** "I think the note object and the markdown object should be the same object. Although we should add the WYSIWYG features for the primary interface to the markdown note object which automatically converts it into markdown, there should be a markdown option at the top right to change it to markdown or see the markdown that is generated. Also one WYSIWYG feature from the Note as well is the size of the text, there should be an icon as well that allows you to make the background invisible. Please convert any note or markdown note to this format."

## What was built

| Asked | Built | Where |
|---|---|---|
| One object | The *Text box* and the *Markdown note* are one **Note**. `NoteDoc.rich`, which told them apart, is retired; one maker (`addNote`), one menu entry, one word for it | `packages/protocol`, `state/store.ts`, `components/sectionMenu.ts` |
| WYSIWYG first, kept as markdown | Every note is written as formatted text with the toolbar and written back as markdown into the note's shared text | `components/RichText.tsx` |
| Markdown at the top right | A **Markdown** button in the card's bar turns the card to its markdown (CodeMirror on the same shared text) and back. It stays up until the button, Esc or Ctrl/⌘+Enter. A viewer can look, not write | `components/NoteView.tsx`, `components/noteEditor.ts` |
| Text size | Two As in the toolbar: a step smaller, a step larger; five sizes; the whole note's; kept on the card (`size`) | `RichText.tsx`, `tokens.css` (`--note-scale-*`), `App.css` |
| Invisible background | A **Background** button (a sheet) beside Markdown: no paper, edge or shadow (`bare`); a dashed edge under the pointer | `NoteView.tsx`, `App.css` |
| Convert existing notes | Nothing to rewrite: both kinds already kept markdown, so every existing note opens as this note. A note is not rewritten by being clicked in | `RichText.tsx` (`drawn` / `wrote`) |
| Agents | `add_note` takes `text_size` and `background: false`; `text_box` is still accepted and ignored | `apps/server/src/tools.ts` |

## How it was checked

- `npm test` and `npm run typecheck`: green. The server's `add_note` test covers size, background and the old `text_box`; the menu's tests name the one entry.
- Two people in two real browsers, on the e2e harness's own server and data (`E2E_*_PORT` above 15000):
  `e2e/section-agents.spec.ts`, 6 of 6. The new check: text size from the toolbar (the type doubles at extra large, for Kai too, the caret stays, it stops at the largest, the markdown is untouched); the background off for Kai too; Markdown on shows the note's own markdown, what Ada writes there arrives formatted on Kai's side, it stays up when the caret leaves and Esc goes back; size and background taken off leave nothing on the card; a note an agent wrote with `*stars*` and `1)` is read formatted, is not rewritten by a click in and out, and is kept as the note's markdown once someone writes in it.
  It also holds a regression found on the way: a drag across a note's words selects them (the words used to jump 28 px when the press put the caret in; the extra top padding while writing is gone).
- The other specs that write in notes were moved from a double-click to the Markdown button: `card-chrome` 7 of 7, `together` 7 of 7 (two people in one note's markdown, carets, own undo), `renders` 1 of 1.
- `pointer`: **not passing in this checkout today, and not finished.** Its first check failed on the selection regression above (fixed, and now checked in `section-agents`); on the rerun it stopped earlier, building a wheel event (`deltaY` not finite), in wheel code another session was changing in the same checkout at the time. Its menu check, which now expects the one **Note**, did not get to run. To do: rerun `pointer` once that work has landed.
- `#/design` → Note, day and night (the pictures below). The design page's check passed; a later rerun could not load the page while another session's edit to it was half-written.

## Pictures

| File | What |
|---|---|
| `01_large-no-background-night.png` | Kai's window: the note at extra large with its paper off (chosen, so it wears the ring) |
| `02_as-markdown-night.png` | Ada's window: Markdown on, the line she wrote there, both bar buttons on |
| `03_formatted-at-rest-night.png` | The same note back as formatted text, paper on, usual size |
| `09_design-note-day.png`, `09_design-note-night.png` | `#/design` → Note: at rest, writing (the two As), Markdown on, background off at extra large |

## Not done, or not checked

1. **Rune** (the opt-in GPU renderer) still draws a plain note itself and opens it in its own field as markdown. A note with a size, without its paper, or made as a text box before this is drawn by the web (an island). Not looked at under Rune in a browser.
2. Not looked at in the desktop app, only in Chromium through the e2e harness.
3. Once someone writes in a note's formatted side, the whole note is kept as that side reads it back: `*x*` becomes `_x_`, `*` bullets become `-`, a nested list comes back flat. Until then it is as it was written.
4. Text size is the card's, not a word's (markdown has none); the markdown side is always the editor's size.
5. No board was migrated and the schema number didn't move: older cards still carry `rich`, which nothing reads but Rune's island rule.
