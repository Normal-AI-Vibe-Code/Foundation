# 2026-11-18: themes, the built-in browser, the release page, sheets, a card's menu

How each part was checked. The screenshots 01–11 are written by `apps/client/e2e/look.spec.ts` (Chromium, its own
server on fresh data, ports above 15000, day); 12 was taken by hand in a browser against a second fresh instance.

    E2E_SERVER_PORT=15630 E2E_CLIENT_PORT=15650 E2E_SLACK_PORT=15640 E2E_MESHY_PORT=15645 npm run e2e -w @foundation/client -- look

| Shot | What it shows | Measured |
|---|---|---|
| 01 | Today, the Changes pane open: the release page in white | `data-theme` is `room`; the title's ink is above 95 % white, the tile text above 75 %, the full notes' bold above 95 % |
| 02 | The same pane after going to a grid | `data-theme` is `paper`; the same three are below 25 % |
| 03, 04 | The terminal on Today, then on the grid, same shell | its ink above 90 % white, then below 30 %; `echo one`, `one`, one empty line, the prompt, `echo two`, `two`; never two empty lines together |
| 05 | A section just added: its table, pinned | the table's left edge and width within 1.5 px of the section body's; no border, no shadow, a clear fill; more than 80 % of the body's height and not past its foot; a cell takes typing |
| 06 | A note added there lies over the sheet | the table is still pinned; the note is in the flow |
| 07 | A card's right-click menu | Frame it, Full screen, Minimize, Float freely, Copy a link to it, Remove this note |
| 08 | The note minimized | `folded` in the store; the card 40 px tall; its bar at opacity 1 |
| 09 | The table unpinned: a card in the flow | no `.pinned-slot`; pinned again afterwards |
| 10 | T3 as a tab | the tab's kind is `app`, the theme is `paper`, its row in All Grids carries an svg mark; asking for it again returns the same tab |
| 11 | A grid pinned to Always night | `data-theme` `night` and `.is-night` on; the company grid after it: `paper`, day |
| 12 | github.com/login in the tools pane | the page drew (a framed page of it is blank: it refuses framing); nothing was typed into it |

Also in that spec, without a shot: a wheel notch zooms in and two out; Shift+wheel moves the paper and not the zoom; a
gesture that starts as fingers (4 px, both ways) pans and stays a pan when a 120 px event follows; the orb is right of
the name and within 24 px of the foot's right edge; every exterior column grab area on the company grid matches a
section's top and height within 2 px.

Not from a browser: `apps/server/test/hostbrowser.test.ts` runs the real Chrome on this machine against a page served
by the test (a frame arrives; `file:` is refused; an agent's read, click by ref, type and submit; a `confirm()` answered;
keys and paste; a 2× sharp frame with the pointer still on the link; the process gone at the end).

Not checked: the desktop window; Josh's own grids (the "section adjuster" fault on older grids was not reproduced);
T3 running (its frame's light/dark was not seen); night on Today; a viewer; Rune; the older e2e specs (they keep the
wheel on *Pans* through `e2e/helpers.ts` and were not re-run).
