# A machine's tools, its own window, Ctrl+scroll, the wells redrawn, and a server the app adopted (2026-11-17)

Josh: "I tried to add a desktop the to the KIRI vm but it said that the foundation server is older than this app and cannot add a desktop. Can we update the foundation server to be able to do this, and get it working on this local computer at least. I notice sometimes the VM takes over Ctrl+scroll to zoom or scroll, which it shouldn't but also I'm unable to click in and copy the text that I need. I think we should also design the vm start interface and add desktop feature a little better centering, making the text larger, and using icons to indicate the right features, with quality of life terminal tools for copying out text that are standardized, and the ability to full-screen the vm into another tab for direct control without foundation ui shortcuts interfering with it." Then: "merge, push to main, and update foundation when you are done."

## 1. "The server is older than this app"

The card was right. `localhost:4410` was still pid 28840, `node --import tsx apps/server/src/index.ts`, **started 2026-11-15 19:42:16**, two hours before desktops were merged. What was new is why the card's advice ("Stop, then Start") couldn't be followed:

- That server was started by the **previous run** of the desktop app. The app updated and relaunched at 2026-11-16 20:02 (`tauri-app.exe` pid 21944), found something answering on :4410 and used it.
- The server switch shows **Stop only for a server this run started** (`localOurs`). For the adopted one it said *Running* and nothing else. So there was no Stop to press.

What changed:

- **The switch recognises a Foundation server started its own way** and can stop it: the listener's pid from `netstat -ano -p TCP` (then TCPv6), its command line from `Win32_Process` (`ps` elsewhere), accepted only when it is `node --import tsx apps/server/src/index.ts` (a checkout) or the app's own `server/node … server/index.mjs` (built in). `npm run dev` (tsx watch, run from `apps/server`) and anything else on the port is never stopped (`local_server.rs` `foundation_kind`, `listener_in`, `stop_adopted`; `cargo test`: 4 pass, two new). The answer is cached per pid so the status poll doesn't start PowerShell every time.
- **Restart** beside Stop, for a server started here or adopted: stops it and starts the same kind from the folder. *Running · started here earlier* says which it is.
- **Add a desktop's well offers Restart the server** when the route is missing (desktop app only), through the switch (`askRestart` → `foundation:restart-server`), which opens to show it; the page reloads when the server is back. The words now point at the server pill in the side menu's foot (they said "bottom right", where it no longer is).
- The switch's half ships with the next desktop release (it is Rust). Until it is installed the old switch is what the app has.

**And on this computer:** the server on :4410 was restarted from `C:\Dev\Foundation` after this work was merged (see the hand-off for when and how it was checked).

## 2. Ctrl+scroll

Two ways the machine took it:

- **The terminal (or any card) in use**: the grid's wheel handler returned early for anything inside the card in use, ⌘/Ctrl-wheel included, so xterm got it. Now ⌘/Ctrl-wheel is the grid's zoom over the card in use too (`GridViewport.tsx`); only a card in full screen keeps it. A zoom no longer ends the card's use (a pan still does), so the machine keeps the keys.
- **The desktop**: its screen is a frame, and wheel events inside a frame never reach the page. The frame now catches ⌘/Ctrl-wheel before noVNC (window, capture), hands it to the card, and the card dispatches it on the frame's element at the same point on the screen (the frame's pixels are unscaled), where the grid zooms about it.

Checked (`e2e/machines-tools.spec.ts`): the card drawn narrower after Ctrl+scroll over the terminal with the keys, the shell's textarea still focused and *Keys go to this machine* still showing; the same over the desktop with its keys.

## 3. Copy and paste ("unable to click in and copy")

- **Terminal** (`machineTerminal.ts`, shared by the card and the window): Ctrl+C with text selected copies it and clears the selection, and the shell gets no ^C; Ctrl+C with nothing selected is the interrupt as before; Ctrl+Shift+C copies; Ctrl+V and Ctrl+Shift+V paste (the browser's paste, which xterm brackets). ⌘ on a Mac. The key rule is `clipKey` (`machineWords.ts`, unit-tested).
- **Desktop** (`desktopFrame.ts`): what the machine copies (x11vnc sends its selection as cut text) goes to this computer's clipboard while the desktop has the keys; otherwise the card says the machine copied text and Copy puts it there. Ctrl+V hands the machine this computer's clipboard first (`clipboardPasteFrom`), then the V.
- **A card's error and an install's line are selectable** (a press on them selects instead of moving the card).
- **A press on the desktop always gives it the keys.** With the card still in use from an earlier press, a click went into the frame and the keys line never came (the frame had the focus already, so no focus event). The frame now reports the keys on any press inside it. Found by the e2e; the spec now clicks straight in.

## 4. The tools row (standardized)

`MachineTools.tsx`: the same row under the terminal and the desktop, never over the machine's screen. A `--color-panel` pill of 28 px round icon buttons (line icons at the top bar's weight, `shell/glyphs.tsx`): **Copy** (the selection; on the desktop, what the machine copied), **Copy all** (the terminal's scrollback, wrapped rows joined: `joinRows`), **Paste** (into the shell; on the desktop typed where the machine's cursor is, key by key, so it works in any app there, terminals included). What a press did is said beside it for a moment (*Copied 9 characters*, *Pasted 1 lines*, amber when the browser refused). The desktop's row carries the agents' leave and the keys pill, as its foot did. At the right, **⧉ a window of its own**. The row grows with its card (×1.2 from 880 px, ×1.4 from 1240 px) so its buttons stay a good press at a wide section's fit.

## 5. A window of its own

`machine.html` (`machineWindow.tsx`), a third page in the build. A tab in a browser; in the desktop app a `WebviewWindow` of its own, one per machine (a second press brings it forward; capability `core:webview:allow-create-webview-window` and `core:window:allow-unminimize`; an app from before falls back to `window.open`). Nothing of Foundation's on it but a 36 px head (glyph, name, `Terminal · Desktop`, *Every key goes to the machine here · Foundation's shortcuts are off*) and the same tools with **Full screen**, which also asks the browser's Keyboard Lock so Esc and the browser's own keys reach the machine (hold Esc to leave). The terminal there is 13.5 px; the desktop takes the keys as soon as it's up; no ring. Signed in as the app's page is (cookie, or this origin's bearer); ids only in the address.

## 6. The wells redrawn

Start and Add a desktop (and installing, and didn't go in) are one centred column: a 48 px round mark, an 18/650 title, 13.5 text, then

- **Start**: the seven distros as tiles (name, image in code, and icons for what each can have: a terminal always, a desktop for Ubuntu, Debian, Alpine: `desktopRecipe`), the engine's images and saved images as chips, a centred field, **With a desktop** as an iconed row that greys and says why for an image with no recipe (Fedora, Arch, Rocky, openSUSE; it said nothing before and the install then failed), and Start 36 px tall with its terms as icon-led chips.
- **Add a desktop**: what you get as three icon-led rows (use it here · a window of its own · agents, once you let them), Add a desktop 36 px, its terms as icon-led chips.
- The column, its type and its controls grow with the card (`--hero-k`), so a machine filling a section at the section's 63 % fit still reads large.

`#/design` → Machines shows them (`MachinePickerView`, `StartLine`, `DesktopWell`, `MachineTools` are the real components).

## How it was checked

- `e2e/machines-tools.spec.ts`, 2 tests, on Kiri 0.1.18 with a fresh Ubuntu 24.04 machine (made and removed by the test), Chromium, its own server and data:
  1. Start by night and by day (`01_start_*`): 7 tiles, desktop icons on exactly Ubuntu, Debian, Alpine; *With a desktop* off with its reason for Fedora and back for Ubuntu; the column and Start centred within 2 px; title 18 px or more at the 18 : 13.5 ratio; Start 36 px or more. The card's own Start, then the terminal: `echo copyme-$((6*7))`, a double-click on its output and Ctrl+C → the clipboard is `copyme-42`, *Copied 9 characters*, no `^C` (`02_…`); `sleep 30` and Ctrl+C with nothing selected → `^C`; Copy all → the clipboard holds the command and its output, *Copied n lines*; Paste → `pasted-5`; Ctrl+V → `keyed-7` (`03_…`). Ctrl+scroll over the terminal with the keys zooms and keeps them. ⧉ → `machine.html#board=…` in a new tab: the name, the keys line, focus in the shell, `from-window-25` typed there shows on the card's terminal too (one shell), 4 tools (`04_…`). Desktop: Add a desktop measured as Start was, day and night (`05_…`), installing (`06_…`), the screen; a click straight on the screen (card still in use) gives it the keys; Ctrl+scroll over it zooms the grid and keeps the keys; an `xfce4-terminal` opened on its display, Paste types `echo typed-in-$((8*8)) > /tmp/typed.txt⏎` into it and the machine's shell reads back `typed-in-64` (`07_…`); ⧉ → its desktop in a window of its own, no ring (`08_…`, `09_…`).
  2. `#/design` by night and day (`design_*`): the start picker, the wells, the tools; the older-server well has *Restart the server*.
- `test/machine-words.test.ts`: 7 (4 new: which refusals are an older server, the recipe per image, the copy keys on Windows and a Mac, Copy all's rows).
- `cargo test --lib local_server` in `apps/client/src-tauri`: 4 (2 new: which command lines may be stopped from here, using the exact one pid 28840 had; the listener from netstat's lines).
- `npm test` (172 client, 282 + 6 skipped server, 48, 9) and `npm run typecheck`: green.

## Not done, not verified

- **The Tauri window was not driven.** Restart/Stop for an adopted server, Restart the server on the card, and the window of its own as an app window are built and unit-tested, and the switch's recognition was tested on the exact command line of the live server, but none was pressed inside the desktop app: they reach it with the next release CI publishes from main (one press on the update card).
- **Copying out of the desktop by itself** (the machine's selection arriving on this computer's clipboard) was not exercised end to end: it needs text selected inside the machine, which the test didn't do. The Copy button's path, Paste and Ctrl+V into the machine were. Viewers get no clipboard (their VNC is view-only).
- **Keyboard Lock in the window's full screen** is Chromium's; WebView2 was not checked.
- **The general "server older than the app" check** (commit and start time compared) is still a plan card; this work offers the restart where a missing route shows it.
