# Note pages, 2026-11-26

One Note primitive: a note page in the side menu's Notes, open full size, and the same note on a grid as a card (docs/notes.md).

| File | What it shows |
|---|---|
| `page-night.png` | Kai's page full size at night, after Ada wrote a to-do in the grid card (slash menu) and Kai wrote a heading and a warning callout and ticked the to-do |
| `grid-card-night.png` | Ada's grid, the same note as a card, with Kai's words in it (the page's row in Notes shows Kai is on it) |
| `slash-menu-in-card-night.png` | the slash menu open in the grid card, `/todo` typed, To-do list first |
| `page-day.png` | the same page by day, after the heading was dragged above the to-do by its handle |
| `design-night.jpg`, `design-day.jpg` | `#/design` → Note pages and blocks: every block at rest, the slash menu, a page card and a locked one |

How it was checked:

- `apps/server/test/notepages.test.ts` (8 pass): a page is a board with one note; nesting and loops; place and read through a grid; words written only on the page's board (`update_card` through the grid refused); `request_id` replays; archive needs `confirm` and deletes nothing; a viewer of a page can't write it by a tool or its socket, even from a grid they can edit; a members-only page is locked on a grid.
- `apps/client/test/note-blocks.test.ts` (7 pass): each block's markdown and its HTML, escaping, the slash ranking, the shortcuts.
- `apps/client/e2e/note-pages.spec.ts` (2 pass, Chromium, own server and data): two people, one on the grid card and one on the page, each one's writing on the other's screen within seconds; the page's markdown (`- [x] Balance the rotor`, `## Specs`, `> [!WARNING] Hot when it runs`); a block dragged by its handle; a grid note made a page keeps its words exactly.
- By hand in the browser pane on a throwaway server (:4462) and client (:1462): New note in Notes, `## ` heading shortcut, `/todo`, Tab to nest, `/callout`, `>> ` toggle, rename, Put on a grid → the card on Form Industries shows the page. The stored markdown read back:

```
## Rotor plan

- [ ] Balance the rotor
  - [ ] Ask Acme for a quote

> [!NOTE] Spin it up slowly.

<details open>
<summary>Specs</summary>

12 V, 3 A

</details>
```

Not checked: the desktop app (WebView2), the Mac.
