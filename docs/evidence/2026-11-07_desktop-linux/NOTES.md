# The desktop app, built and run on Linux (2026-11-07)

On a cloud Linux box (Ubuntu 24.04, no display): installed Tauri's Linux dependencies (`libwebkit2gtk-4.1-dev`, `libappindicator3-dev`, `librsvg2-dev`, `patchelf`, `libxdo-dev`), ran `cargo build` in `apps/client/src-tauri` (debug, 2 min 20 s), started `npm run dev`, and ran the binary on a virtual display (Xvfb, 1600×1000).

- 01: the sign-in, with the ASCII wind running in WebKitGTK.
- 02: signed in with dev login (Ada, `ada@normal.dev`), on the company board. The connectors say *Offline* and why: FactoryForm, Vision, Creation and the Data Room don't run on this box. Foundation itself is Live.

Seen in 02: the empty *Apps* section's "Bring work here" welcome sits under the search and talk pills at the bottom of the window. The pills float over the board by design; it only reads oddly when a welcome happens to sit right behind them.

**The latest, in the desktop app** (after the writing-together change, rebuilt with `npm run build` and `cargo build`). A second person (Kai, a headless browser on the same server) typed in a note while the desktop window (Ada) watched:
- 03: Kai's words arrive live, along with his pointer, the **Kai Test** chip on the closed note and his avatar in the top bar.
- 04: Ada opens the note. Kai's caret sits at the end of "late resin", named in his colour (the name fades after 1.8 s). Seen in WebKitGTK, so the mirror's text metrics match the textarea there too.
