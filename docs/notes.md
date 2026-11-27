# Notes as pages: one Note primitive, in the side pane and on the grid

Josh, 2026-11-26: "Notion-like notes … as first-class objects, unified with the existing markdown note into one Note primitive." A note is listed in the left pane as a page tree that nests, opens full size there, and the same note can be placed on any grid as a card. An edit in either place shows in both, live.

This is the plan written before building (the data model, the editor, the migration), kept as the architecture afterwards.

## 1. What a note is today

- A note card is `NoteDoc` (`kind: "note"`) in a board's `objects` map. Its words are a `Y.Text` in the board's `noteText` map under the card's id (schema 3). The words are **markdown**: search, agents (`read_board`, `read_card`, `update_card`), the timeline, Rune and wires all read that text.
- The card is written as formatted text: one `contenteditable` surface (`components/RichText.tsx` `RichNote`). Markdown is drawn to HTML (`utils/markdown.ts` `renderMarkdown`), and after each change the surface is read back as markdown (`htmlToMarkdown`) and written as the smallest edit to the `Y.Text` (`setNoteText`). The card's **Markdown** button shows the same text in CodeMirror (`noteEditor.ts`).
- There is one note kind since 2026-11-24 (`rich` is retired). That is the primitive this extends.

## 2. Data model

**A note's home is a space of kind `note`.** Spaces are already board rows (`boards`: grid, deck, page, app), each with its own board document, sync socket, roles, members, timeline and search. A note page is one more kind:

| | Where | What it holds |
|---|---|---|
| A note page | a `boards` row with `kind = 'note'`, `parent` = the note it sits inside (or null) | its board document holds one `NoteDoc`, id `NOTE_BODY` (`"body"`), and that note's `Y.Text` in `noteText`: the page's markdown |
| A note on a grid | a `NoteDoc` card on the grid's board with `ref: <note page id>` | position, size, text size, background. **No words of its own**: the card shows the page's `Y.Text`, live |
| A note that lives on its grid (every note before this) | a `NoteDoc` card with no `ref` | its words in its own grid's `noteText`, as today |

So there is one `NoteDoc`, one markdown `Y.Text`, one editor. A card either *is* its note (no `ref`, home is the grid) or *shows* one (`ref`, home is the page). "Make it a page" moves a grid note's words into a new note page and leaves the card showing it, so the card stays where it was.

**Nesting.** A note page's `parent` is another note page. Notes nest under notes only: a note can't hold a grid and a grid doesn't hold notes in the tree (the side pane's Notes tree is separate from All Grids). A loop is refused as for grids. A child page also appears in its parent's text as a page line, `[Title](note:<id>)`, so the tree and the page agree.

**Who sees and edits it.** A note page is a board, so every existing gate applies unchanged:
- A members-only page is seen only by its members (and admins). A grid card showing a page someone can't see is a locked card ("A note you can't open"); the grid holds only the id.
- A viewer of a page can't write it by any door (socket, tools, HTTP), even through a card on a grid they can edit: the card's words sync over the page's own socket, under the page's role.
- Placing a page on a grid is a write to the **grid** (the writer must be able to write the grid and see the page); writing the words is a write to the **page**.

**Writes name their board, and the tool surface.** All through `runTool` (request_id idempotency, viewer refusal, audit):
- `add_note_page {title, markdown?, parent?, place?, section?}` on board B: makes a note page (inside `parent`), and with `place` puts it on B as a card. Returns the page id.
- `place_note {note, section?}` on board B: a card on B showing the page.
- `make_note_page {id}` on board B: the grid note `id` becomes a page; its card now shows it.
- `update_card {id: "body", markdown}` on the page's own board writes a page's words (no new tool). `read_card` on a grid's `ref` card reads the page's words if the caller can see it.
- `archive_note_page {note, confirm: true}`: a page is archived, never deleted (its row and document stay; it leaves the pane; cards showing it say it was archived). Without `confirm` nothing happens.
- `remove_card` on a grid's `ref` card takes the card off the grid only; the page stays.

**Board schema.** `NoteDoc.ref?: string` and `NOTE_BODY` in `packages/protocol`. No schema bump: older clients ignore `ref` and show an empty note (the words never go into the grid's `noteText`).

## 3. Editor

The note's editor stays **one formatted-text surface over markdown** (`RichNote`), extended into a block editor, rather than a second editor beside it (TipTap / ProseMirror would keep the words as an XML tree, not markdown, and fork the primitive). Each top-level element of the surface is a block.

- **Blocks**: text, title / heading / subheading, bulleted, numbered and to-do lists (nested by Tab), quote, callout (note, tip, warning, caution), toggle (its body folds), code, divider, image, link (a bookmark card), and a page (a sub-page, opened in the pane).
- **Slash menu**: `/` in a block opens a menu of the blocks, filtered as you type (name, then aliases such as `/h2`, `/todo`), Enter or a click turns the block into it. Recently used first.
- **Markdown shortcuts** at a block's start: `# `, `## `, `### `, `- `, `1. `, `[] `, `> `, `>> ` (toggle), `! ` (callout), ```` ``` ````, `---`.
- **Drag handle**: a ⋮⋮ beside the block under the pointer. Drag it to move the block; press it for the block's menu (Turn into, Duplicate, Delete, Move up and down).
- **Kept as readable markdown**: to-dos `- [ ]` / `- [x]`, callouts GitHub's `> [!NOTE]`, toggles `<details><summary>…</summary> … </details>`, a page `[Title](note:<id>)`, a link block a URL alone on its line, nested list items indented two spaces. Everything else is the markdown notes already used.
- **Nothing runs or loads on sight**: an embed is a bookmark card that opens in a new tab on a press, never a frame; a picture from elsewhere still waits for a press (`renderMarkdown`'s rule).
- Two people at once: unchanged. Each change is the smallest edit to the `Y.Text`; someone else's words land without moving the caret.
- Ideas (not code) from flowplan (yannicschuller/flowplan, **AGPL-3.0**, so nothing is copied): the ranked slash menu with recents, callout kinds as a second level, the hover handle with a block menu.

**Where it shows.** The full-size page is the note space's canvas (`notes/NotePage.tsx`), its body is the active board's `NOTE_BODY` note. A grid card with `ref` opens a small second sync to the page's board (`notes/noteSync.ts`, its own Y.Doc and socket, shared by every card showing that page, closed when the last one goes). The page's title is the space's name.

## 4. Migration

- **Nothing is rewritten.** Every existing note card keeps its words where they are; it opens in the block editor because its stored form is the same markdown. Markdown written by hand isn't rewritten until someone changes the words (`RichNote`'s rule).
- **Grid notes are not moved into the pane by themselves.** The pane lists note pages; a grid note becomes one when a person (or an agent, `make_note_page`) asks. Moving every grid note (the daily digests, agents' notes on every grid) would flood the pane and fork every reader of `noteText`. This is the one choice that is Josh's (§5).
- Old clients: a `ref` card shows empty on a build without this; the page itself is a board they can open.

## 5. Josh's call

1. **Grid notes in the pane**: lazily (only pages, a grid note becomes one on "Make it a page"; built) or every existing grid note listed. Built lazily; listing them all is a later migration that only adds pages.
2. **A new note page is open to everyone on the server**, like a new grid; making it members-only is the space's ⓘ → People, as for any grid. A private-by-default page would be a change to how spaces are made.
