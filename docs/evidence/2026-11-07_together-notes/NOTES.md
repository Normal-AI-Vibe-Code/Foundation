# Writing together: carets in notes, your own undo, cursors verified (2026-11-07)

`e2e/together.spec.ts` (Ada and Kai, two browser contexts, one fresh board). Headless Chromium, night.

- **Pointer cursors** (SPEC §3 had this as *partial*: code done, never seen by a second person). Ada moves her pointer and Kai's board shows a cursor named "Ada Test", and the other way round. Now checked on every e2e run.
- **Named carets in a note.** While a person writes in a note, their caret (and selection) rides on awareness as Yjs *relative* positions, so it stays on the same characters while others type around it. The other editor draws it with an invisible copy of the text laid over the textarea: a 2 px bar in the person's colour, named while it moves and faded after 1.8 s so the line above stays readable; a selection is a 22 % tint. Both editors show the other's caret (01, 02).
- **⌘Z takes back only your own words.** Each note has a `Y.UndoManager` that tracks only this person's edits (keystrokes within 0.5 s are one step). Ada typed "- tooling" and Kai "- late resin"; Ada's ⌘Z removed her line in both editors and left Kai's; ⇧⌘Z put it back. Before this, the browser's own undo stack reset whenever someone else's text landed. The app menu's Edit → Undo (Tauri) arrives as a `historyUndo` input event and takes the same path.
- **A closed note names who's writing in it**: a chip at the bottom right (clear of the bar that drops in at the top), with a breathing dot in the person's colour, gone when they stop (03).
- `#/design` → *Writing together* shows both, day and night (`design-light.png`, `design-dark.png`).

Not done: two people editing the very same word can still interleave letters (each keystroke is rebased as one contiguous change). A CodeMirror + y-codemirror editor would fix that and give syntax-aware editing; this change keeps the plain textarea.
