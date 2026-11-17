# Offline edits (2026-11-03)

Isolated copy, with the API (:4420, a `.backup` of `data/foundation.db`) and the web app (:1440) run separately so the server could be taken down and brought back. Test person: Kai Test on `kai.localhost:1440`, dev login.

**Edits made offline survive a reload, and reach the server.**
1. Kai opened the board. It went live, and this device kept a copy (IndexedDB `foundation-board:company`) and remembered who Kai is.
2. API stopped. The tab went offline. Kai renamed a section and added a line to a note. The board tab showed **Saved on this device** (00).
3. Reloaded with the server still down. The app opened as Kai (not the sign-in page) with the board from the device copy, both edits there, and the board's real name from the kept list. The pill still read Saved on this device (01).
4. API started. Within 10 ms the tab went connecting → live. The server's `read_board` had both offline edits (the rename and the note line). The pill went away.

**A copy of a board that was made again is not merged into it.**
- First try (02): I reset the company board on the server copy (deleted its updates; the seed made it again with a new epoch). The new-code tabs checked the epoch and set their copies aside. But two tabs still open from an earlier test, running code from before this change, reconnected and poured the old board into the new one: 20 sections. **Fixed on the server:** the client now sends the epoch it holds when it connects. A different epoch is refused (close 4002, and the client sets its copy aside). A client that sends none (a build from before epochs) can read but not write until it reloads (`syncAccess`, tested).
- Second try, with the server enforcing it: Kai's tab held the old copy plus a new offline edit. The board was reset and the server restarted. Kai's tab and Josh's tab (the pane's own sign-in, left untouched) set their copies aside and reloaded onto the fresh 9-section board. The server's board had none of the old edits.

Night (03): the pill reads well. This also caught a wrong message: offline, the side pane said "Vision Code isn't on this machine". It now keeps what it last knew.

**Not checked:** the Tauri desktop app (the web build needs its page served, so "opening with no server" here means the API is down while the page is served). Two devices both offline editing the same thing, then reconnecting: the Yjs merge rules apply (notes and cells merge per character and per cell; everything else last-writer-wins per card), covered by the earlier convergence tests rather than here.
