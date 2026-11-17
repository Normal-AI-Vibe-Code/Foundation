# A page from a machine's port follows the machine (2026-11-07)

Plan card `machine-port-stale`. A page opened from a machine card's port pill now carries `fromMachine: { panel, port, name }` (optional on `PanelDoc`, so no migration). While the machine runs and publishes that port, the page is the live frame at whatever host port the engine gave it this time. Otherwise the frame is unmounted, the poster dims to a hatched well, and the machine's state stands on it: the card's own state pill, what happened in its words, **Start it** (a person only, through the card's own Start and the server's person-only check) and **Show the machine**. Removed says *Machine gone — … was removed*; a card taken off the board says *… isn't on the board any more*. Running again, the page waits for the port to answer, then loads afresh.

Checked in headless Chromium (Playwright) against a server on :16810 and Vite on :16830, with its own data dir, signed in as Ada (`POST /auth/dev`), on a fresh board, against **Docker Desktop** (`FOUNDATION_ENGINES=docker=npipe:////./pipe/docker_engine`, so Kiri was left alone). `run.log` is the run.

- `01-page-live.png`: `propose_machine` (nginx:alpine, port 80), Start pressed on the card, `:80 ↗` opened the page beside it: "Welcome to nginx!".
- `02-page-stopped-day.png`, `02b-…closeup.png`: Stop on the card. The page dropped its frame (0 iframes) and says *Stopped · Machine stopped — web-box isn't running · Stopped by Ada. Its disk is kept…* with Start it and Show the machine.
- `03-page-stopped-night.png`: the same in a dark browser.
- `04-page-live-again.png`: **Start it** pressed on the page. The engine published :80 on a new host port (4901 → 5714); the page followed it and reloaded by itself.
- `05-page-stopped-outside.png`: `docker stop` outside Foundation with the card's terminal off screen: the page noticed within about a second (it asks the server to read the engine every 5 s while on screen) and says *Exited (0) 1 second ago*. `docker start`: the frame came back by itself at the next host port (14144).
- `06-page-removed.png`: Remove (asks *Remove it and its disk?*, then sends `confirm`): *Not started · Machine gone — web-box was removed*.
- `06b-page-card-gone.png`: the machine card deleted from the board: *Gone · Machine gone — web-box isn't on the board any more*.
- `07-design-*.png`: the `#/design` Machines specimens (stopped for a person, waiting for the port, stopped for a viewer, removed, gone) at 400 and 260 px, day and night.

Engine afterwards: `docker ps -a --filter label=dev.foundation.board` empty (as found); the `nginx:alpine` image this check pulled was removed again.

Not covered here: a viewer in a real browser (unit-tested, and shown on `#/design`); Kiri (the page logic is engine-blind); a slow server inside the machine beyond the 20 s port wait.
