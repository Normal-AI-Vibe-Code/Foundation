# Two people, two browsers (2026-11-03, Phase 1)

`e2e/together.spec.ts`: Ada and Kai each have their own browser context (own cookies) on a fresh board.

- **One first section.** The server now lays a new board's first section itself. Before, the first browser to sync seeded it, and two people opening a new board together could each lay one.
- **One note, typed at once.** Ada had her caret under "Goals:", Kai his at the end. Keystrokes were interleaved one by one. Both editors ended on `Goals:\n- ship the fan\n\nRisks:\n- supplier slip\n` (01, 02).
- **One table, cells written at once.** Both wrote three cells at the same instant into a table Ada had just added. Both ended with all six, and `=B2*3` worked out.
  - **This found a real bug.** A new table's cell map was made lazily on the first write. Two people's first writes made two maps, and one was lost: Ada lost her own column. Maps are now made with their table, in the same change (board schema 5 gives every existing table one). The earlier two-replica test had missed it because one side always wrote first. `tables.test.ts` now shows both the race and the fix.
- **A rename by Ada reached Kai, and both boards matched.**
