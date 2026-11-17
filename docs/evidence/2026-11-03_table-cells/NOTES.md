# Tables two people can edit (2026-11-03)

Board schema 4: each table's cells are a `Y.Map` ("c,r" → raw), and an edit writes only the cells it changed.

**Browser check.** An isolated copy (client :1440, server :4420, a `.backup` of `data/foundation.db`) with two people signed in: Ada on `localhost:1440`, Kai on `kai.localhost:1440`. The real board had no tables, so the schema 4 migration had nothing to convert there; it upgraded the schema number only. Ada added a table and it appeared in Kai's tab. Cells were written through the real spreadsheet engine (`window.__foundation.workbook`, dev only), taking the real path: engine → per-cell sync → server → the other browser.

- Headers from Ada reached Kai.
- Ada wrote A2/A3 and Kai wrote B2/B3 (B3 `=B2*3` evaluated to 6 in both). Then Ada wrote C2/C3 and Kai wrote D2/D3. Both tabs ended on the same ten cells.
- Both tabs were scheduled for the same clock tick: Kai wrote at :15.004 and Ada at :15.012. Kai wrote without Ada's cell; Ada's tab already had Kai's (localhost delivers in under 8 ms). Both kept both cells.

**Not forced in the browser.** I couldn't get both browsers to write while each lacked the other's edit, because localhost is too fast. That case, which lost a cell before this change, is covered by `apps/server/test/tables.test.ts` with two replicas that exchange updates only after both have written.

**Seen while testing, not fixed (SPEC §7).** "Add a table" from ⌘K put the table in the active section, which was hosting an app, so the table sat hidden behind it. Framing the table after moving it did not bring it into view either.
