/**
 * The parity ledger: every part of the board the web renderer draws or does,
 * and where the Rune renderer stands on it. Honest by construction — Settings
 * → Renderer shows it, and a row only turns to "same" when it has been
 * checked side by side (docs/evidence).
 *
 * - same:    drawn and behaves as the web renderer does
 * - partial: there, with a named difference
 * - web:     still the web layer's, drawn over Rune's canvas (it works, it just isn't Rune's yet)
 * - missing: not available while Rune is on
 */

export type Parity = "same" | "partial" | "web" | "missing";

export interface ParityRow {
  what: string;
  status: Parity;
  /** the difference, or what it rests on */
  note?: string;
}

export interface ParityGroup {
  name: string;
  rows: ParityRow[];
}

export const PARITY: ParityGroup[] = [
  {
    name: "The grid",
    rows: [
      { what: "Paper: grain, dot grid, the light that follows the pointer, vignette, night", status: "same", note: "The web paper's own shader, drawn inside Rune's frame (its canvas can't be see-through on the web); a section's dots too" },
      { what: "Camera: pan, wheel, pinch, throw, zoom keys, framing (0, F, arrows), double-click zoom", status: "same", note: "One camera for both engines: the same springs and the same code" },
      { what: "The floor: cards cut clean at a pane's edge and under the top bar", status: "partial", note: "The edge moves at once when a pane opens; the web's glides 0.42 s" },
      { what: "Grid frame, track labels", status: "same" },
      { what: "Track lines between sections", status: "partial", note: "Solid, where the web's are dashed" },
      { what: "Empty cells and + Section", status: "partial", note: "No right-click menu; no + in the gaps beside a section" },
      { what: "Track resize gutters", status: "missing" },
    ],
  },
  {
    name: "Sections",
    rows: [
      { what: "Paper, hairline, shadow, the selected look", status: "same" },
      { what: "Header: name, coordinates, count", status: "partial", note: "No Slack mark, no ✦ Agents chip or ⤢ at rest (the toolbar's ✦ and the menu open the section's agents), and an app section has no glyph or app buttons (repo, MCP, open)" },
      { what: "Rename in place", status: "partial", note: "Rune's own field: a press on the name, Enter or a press elsewhere names it, Esc leaves it. The name isn't selected when it opens" },
      { what: "Select by pressing", status: "same" },
      { what: "Tools on call (add, split, open, agent, remove)", status: "partial", note: "Rune draws them, with its own line icons. They show while the pointer is on the section's paper, not while it's on a card, and have no roll-over labels" },
      { what: "Remove, asking first", status: "same" },
      { what: "Right-click menu", status: "same", note: "The web section's own list, opened where Rune says the right-click was" },
      { what: "Drag to another cell or past an edge", status: "partial", note: "It follows the pointer with its cards and shows where it would land; it doesn't ease into place, and past an edge is unchecked in a browser" },
      { what: "Open as its own grid; a grid section's miniature", status: "partial", note: "Opens and goes back up; a grid section shows its count, not its sections in miniature" },
      { what: "Fit: cards scaled to the body; n more · Expand", status: "partial", note: "The pill is there; the fit lands at once where the web's glides" },
      { what: "Empty section: Bring work here", status: "missing" },
      { what: "Dropping files in", status: "missing" },
    ],
  },
  {
    name: "Cards",
    rows: [
      { what: "Note at rest", status: "partial", note: "Markdown by Rune's kit, in the web note's sizes, tokens and margins. Bullets are smaller, a task's box doesn't tick, and code is IBM Plex Mono where the web's is the system's code face; tables and pictures in a note are unchecked" },
      { what: "Note: writing", status: "partial", note: "Rune's own field (caret, selection, undo, IME, clipboard), each keystroke to the board; no markdown highlighting, no shared carets" },
      { what: "Image", status: "partial", note: "Bare, at rest; no hover icons, no invert on dark. One Rune can't fetch by address (a hosted server's file) stays the web's" },
      { what: "Move within its section", status: "partial", note: "Lifts and follows; no lean, and it can't be carried to another section or tab" },
      { what: "Select; the selection ring", status: "same" },
      { what: "An agent's ✦ pill", status: "same" },
      { what: "A note's bar, an image's buttons, and the resize corner", status: "partial", note: "Title, float or dock, remove, and the corner. No full screen, no mute or invert on an image, whose button sits inside its edge; the whole note is its handle, where the web's is the bar" },
      { what: "Table", status: "partial", note: "Rune draws it at rest: header, heads, ruling and what each cell shows. Pressed, the web's live sheet takes its place (cells, formulas, ranges, menus), so the first press picks the table up, not a cell" },
      { what: "Live apps, web pages, machines, huddles, Slack, connectors, files, asks", status: "web", note: "Web content, and it stays web: the same components, as islands over Rune's canvas in the section Rune drew" },
      { what: "Text box; the agents card; a section's agents panel", status: "web", note: "A text box is written in the page's own editing surface and the agents card is a panel, so both are islands; the panel stands over the canvas at screen size. Not checked under Rune in a browser yet" },
      { what: "Map, video, CAD", status: "web", note: "Islands, like the apps" },
      { what: "Use a card (Ctrl+click), full screen", status: "web", note: "The islands' own; not checked under Rune yet" },
      { what: "Stacking", status: "partial", note: "An island is always over what Rune draws: a note can't float over an app or a map" },
    ],
  },
  {
    name: "Above the grid",
    rows: [
      { what: "Wires (sheet and app), ports and their roads", status: "web", note: "A table at rest has no wire handle: pick it up first" },
      { what: "People's cursors, the crew's cursors and rings", status: "web" },
      { what: "Top bar, panes, search, the bottom bar, ⌘K, toasts", status: "web" },
      { what: "A result or a card in the hand; the clipboard", status: "web", note: "A result can be dropped on the grid; a card can't be picked up from it" },
      { what: "Presentation", status: "web" },
    ],
  },
  {
    name: "Everywhere",
    rows: [
      { what: "Tokens: every colour from tokens.css, day and night", status: "partial", note: "Night fades on Rune's colour spring, not the tokens' 1.4 s mix" },
      { what: "Type: Hanken Grotesk", status: "partial", note: "Latin and Latin Extended, upright and italic. Cyrillic and Vietnamese fall back to Inter, and so does everything for the moment before the face arrives" },
      { what: "Speed", status: "partial", note: "On 300 notes the web renderer holds 60 fps and Rune doesn't: panning fitted, half its frames run long (p95 100 ms against 16.7). Level on a board of web content. Measured, not yet fixed" },
      { what: "View only", status: "same", note: "Nothing moves and nothing opens for writing" },
      { what: "Accessibility: the board to a screen reader", status: "missing", note: "Rune's web target mirrors only whole-page documents" },
      { what: "Where it runs", status: "partial", note: "Chromium (checked in Edge). A desktop build carries it where it was built with the Rust toolchain; the Windows and Mac apps with Rune on are unchecked, and Linux's webview has no WebGPU" },
    ],
  },
];

export const PARITY_WORD: Record<Parity, string> = { same: "Same", partial: "Partly", web: "Web layer", missing: "Not yet" };

export function parityCounts(groups: ParityGroup[] = PARITY): Record<Parity, number> {
  const n: Record<Parity, number> = { same: 0, partial: 0, web: 0, missing: 0 };
  for (const g of groups) for (const r of g.rows) n[r.status]++;
  return n;
}
