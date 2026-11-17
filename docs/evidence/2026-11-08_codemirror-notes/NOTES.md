# Notes in CodeMirror with y-codemirror (2026-11-08)

Plan card `codemirror-notes` (issue #63, SPEC §7 "Note editing is a plain textarea…").

## What changed

- **The open note is CodeMirror 6 bound to the note's `Y.Text`** through `y-codemirror.next`
  (`apps/client/src/components/noteEditor.ts`). Each keystroke is its own Yjs insert or delete at
  the caret, so two people typing into the very same word keep two whole runs. The textarea, its
  hand-rolled rebasing (`rebaseEdit`, removed from `packages/protocol`) and the caret mirror are gone.
- **Carets keep the board's awareness shape.** The editor publishes the same `caret: {note, anchor,
  head}` field (Yjs relative positions) through `BoardSync.setCaret`, and draws others' carets and
  selections as CodeMirror decorations from `BoardSync.noteCarets`. The board's pointer `cursor`
  field is untouched (y-codemirror's own remote-selection plugin would have overwritten it, so it isn't
  used). The closed-note chip ("Kai Test") still reads the same field.
- **Undo** is the board's per-note `Y.UndoManager` (now `BoardSync.noteUndoManager`), passed to
  `yCollab`, which adds the editor's origin while it's open. ⌘Z / ⇧⌘Z / Ctrl+Y are read by a
  highest-precedence key handler the way the textarea read them (a CodeMirror keymap takes a
  lower-case "z" with Shift for Ctrl+Z, which is how Playwright sends it); the app menu's Edit → Undo
  arrives as `historyUndo` and is handled by `yCollab`. The history still lasts while the board is open.
- **Markdown is highlighted while writing** from `@lezer/markdown` with GFM (tables, strikethrough),
  classes on tokens only in `App.css`. `@codemirror/lang-markdown` was tried first and dropped: it
  pulls in lang-html, CSS and JavaScript (the chunk was 501 kB / 175 kB gzipped; now 307 kB / 101 kB).
  Its Enter keymap (list continuation) is off: Enter is a plain newline. Ligatures are off in the
  editor, so `|---|` reads as typed.
- **Mounted only while open, loaded only when needed.** `NoteView` renders markdown at rest; a
  double-click mounts one editor. The chunk is fetched when a pointer rests on a note, or at idle once a
  board shows a note; a failed fetch is retried next time and says so in a toast.
- `#/design` → Writing together now shows two live editors on one `Y.Text` (type in either) beside the
  rendered note with its table and the writer chip.
- `AgentLayer`'s Delete-removes-a-wire key now stands down in any contenteditable, not only inputs.

## How it was checked

- `npm test` (client 69, server 104 + 6 skipped) and `npm run typecheck` green before and after.
- `apps/server/test/notes.test.ts` (5): writers type the way the editor does (one insert per key at a
  caret mapped like CodeMirror maps a cursor). New: two people typing into one word, delivered after
  every key, every 2, 3, 5 keys or only at the end: always `sup[ada words](kai words)plier` or the
  reverse. The old textarea path replayed in the same scenario (a scratch model of `rebaseEdit` + the
  caret splice) gave `- sup([kaadia  wwoorrddss)]plier slip` (every key), `- sup[(adkaa i wowordrds]s)plier slip` (every 2).
- `e2e/together.spec.ts` 7/7 on its own servers (:17450/:17430/:17440): the old cases on CodeMirror
  (two typing at once, named carets in both, Ada's ⌘Z takes only her line, redo, the chip after Esc)
  and the new same-word case (keystrokes interleaved one by one; both browsers identical; each person's
  ⌘Z takes back only their own run). Screenshots `01`, `02`, `05`–`09` here are from that run (night).
- Full e2e (`E2E_CLIENT_PORT=17450 E2E_SERVER_PORT=17430 E2E_SLACK_PORT=17440`): 32 pass, 2 skipped by
  design, 1 fail: `perf.spec`, which fails on this machine on `main` too (the 0.2.0 release evidence:
  "pan with live frames p95 ≈ 50 ms against a 34 ms budget"). Rerun alone here: pan 33.4 ms, pan with
  live frames 50.1 ms, the same numbers. The 83 ms pan in the full run was this shared machine under load.
  The suite rewrites other slices' screenshots; those were put back, not committed.
- `08_same-word_*` (from that run): the note reads `sup(kai words)[ada words]plier slip` in both.
- Two browsers (Playwright, Ada and Kai, day and night, `?rafshim`, dev servers on :17420/:17410):
  - `12_note-at-rest_*`: the note with its markdown table at rest.
  - `13_ada-writing-with-kai_*`, `14_kai-writing-with-ada_*`: both writing, Kai's caret named in Ada's
    editor with his selection on "Hub" tinted, Ada's named in Kai's. Both editors held the same text.
  - `15_agent-line-landed_*`: an agent's `update_card` put a line above both carets; Ada's caret stayed
    after "the 14th ✓" (index 63 → 89) and Kai's selection stayed on "Hub" (160 → 186).
  - `16_ada-at-rest-kai-writing_*`: Ada pressed Esc; the rendered note names Kai, still writing.
  - Editors on the board: 0 before a note opened, 1 while one was open, 0 after Esc.
- `#/design` Writing together, day and night (`10_design_*`), and after typing a table row into Ada's
  editor (`11_design_typed_*`): Kai's editor and the rendered table followed.
- Bundle: `vite build` puts CodeMirror in `noteEditor-*.js` (306.7 kB, 100.7 kB gzipped); the main
  chunk has no CodeMirror code (only the plan card's text matched).

## Open

- Undo history doesn't survive a reload (unchanged).
- Not seen in the packaged desktop window, with a real trackpad, or with IME composition.
- A page that never fetched the editor chunk and then loses its network can't open a note until it's
  back (it says so). There's no service worker.
