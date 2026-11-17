# Live notes, turns that survive a reload, voice, the floor gives way (2026-11-03)

Isolated copy (client :1440, server :4420, a `.backup` of `data/foundation.db` — so the schema 3 migration ran on the real board: all four notes kept their text, now in Y.Text). Two people: `localhost:1440` (Ada) and `kai.localhost:1440` (Kai), dev login with test addresses. 800×600 pane, night then day.

**Two people in one note.** Both opened "Agent check" at once, Ada's cursor at the start and Kai's at the end, and typed in turns ("Ada" · " Kai" · " was here. " · " too!"). Both editors and both stores ended on `Ada was here. The Foundation agent can reach the board. Kai too!`; Ada's caret stayed at 14, Kai's at the end (64). Then Kai added a line and Ada's rendered note showed it (03, 04). 00 is the bug this fixed: the card's hover bar covered the first line while writing.

**A turn survives a reload.** Started a real subscription turn ("Read the board, then write a note…"), reloaded at 9 s with the plan at 0/3. After the reload the tab reattached by run id: plan 1/3, still streaming, Stop available; it finished 3/3 with the note written (02). **Stop** on a second turn: the server recorded `stopped`, the tab says Stopped (05).

**Read-only steps don't count as touching.** "Read the board" no longer links to (or rings) whatever card ids its output mentions; only the note the agent wrote is ringed. After a reload, links and rings come back once the board syncs.

**The floor gives way.** A layout saved at 1440 wide (session + search + side pane) reopened at 800: the side pane folded and search closed on load (01). Opening a pane explicitly still opens it.

**Voice.** The mic is back in the session composer (02, 05). Not exercised with a real voice here (headless).
