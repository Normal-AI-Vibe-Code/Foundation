# Machines: Add a desktop that says why, and a ring that is the well's (2026-11-17)

Josh, 2026-11-17: "Add a desktop doesn't work in Kiri, please fix this. Also the selection around the window is still weird, it should be within the section when it's actively being typed into."

This session did not edit SPEC.md, DESIGN.md or docs/plan.json. The text for them is at the end, ready to paste.

## 1. "Add a desktop doesn't work"

### The cause: the server he is running is from before desktops existed

Found by asking his running server, not by guessing (`live-server-probe.txt`, made by `live-server-probe.sh`; nothing is signed in and nothing is changed by it):

| asked of `http://localhost:4410` | answer |
|---|---|
| `POST /api/boards/company/machines/x/stop` (a route from before) | 401 `sign in first` |
| `POST /api/boards/company/machines/x/desktop` (Add a desktop) | **404 `not found`** |
| `POST /api/boards/company/machines/x/agents` (Let agents use this desktop) | **404 `not found`** |
| `GET /api/prefs` | **404 `not found`** |
| the socket `/machines/company/x/tty` | 401 |
| the socket `/machines/company/x/vnc` (the desktop's screen) | **404** |

A route the server has answers 401 to a stranger; one it has never heard of gets its router's 404. That server is `node --import tsx apps/server/src/index.ts` (pid 28840), **started 2026-11-15 19:42:16**. The desktop work was committed at 21:53 that evening (`0be864a`) and merged at 21:57 (`34b7328`). A server started from a checkout runs the code it was started with until it is restarted; the app, meanwhile, updates itself from CI, so the installed app (`tauri-app.exe`, started 2026-11-16 16:25) has the Desktop view and its page is there (`http://localhost:31440/desktop.html` 200 `text/html`, its script `/assets/desktop-DNSJo_Jj.js` 200 `text/javascript`, 170 KB).

So his press went: app → `POST …/desktop` → 404 `{"error":"not found"}` → a red toast reading **"not found"**, and the card stayed on *has no desktop yet*. That is the whole of "doesn't work". The same press through the code as it was is reproduced in the browser check by answering the route with that exact status and body.

His machine is not the cause: `machine-box-a70f` is `ubuntu:24.04` (read from Kiri's container list, nothing else touched), made at 19:47 by that same server. Nothing about how a machine is made changed with the desktop work (`git diff 0be864a^ 0be864a -- apps/server/src/machines.ts`: only execs), and adding a desktop to an Ubuntu 24.04 machine that is already running is exactly what the smoke does.

**What the owner does:** restart the server (the app's server switch, bottom right: Stop, then Start). The checkout it starts from (`C:\Dev\Foundation`) has the desktop code on disk. Then Desktop → Add a desktop on `box-a70f`. To get the fixes below as well, that checkout needs this branch merged first. **I did not restart his server or touch his machine**, so this last step is not verified on his data: it is verified on a server of this code with a machine of the same image, in the app's own transport (below).

### Everything else that was checked, each for real

| | what | result |
|---|---|---|
| the engine | `npm run machines:desktop-smoke -w @foundation/server -- <distro> kiri` on Kiri 0.1.18, before and after the changes | **Ubuntu 24.04, Debian trixie, Alpine 3.22: pass** (a desktop in 40 to 50 s here, VNC through the relay, an agent's look, click and typing). `smoke_kiri-*.txt`, `before/smoke_kiri-*.txt` |
| the other four distros in the Start picker | the same smoke with `fedora`, `rocky`, `arch`, `opensuse` | **refused at once, in words, nothing hangs** (`before/`): *This image has neither apt nor apk…*. Now by name (below). Not fixed: there is still no recipe for them |
| the browser, Vite's dev server, cookie | `e2e/machines-fixes.spec.ts` | pass (4 checks, about 4 minutes) |
| **the packaged app's transport** | the **production build** (`vite build`), served from **another origin** by a server that, like tauri-plugin-localhost, serves the build's files and answers anything else with `index.html`; signed in with a **bearer** kept in localStorage (no cookie at all); Start and Add a desktop pressed with that bearer; `desktop.html` and `/assets/desktop-*.js` served as themselves; the frame same-origin with the app's page; the `/tty` and `/vnc` sockets opened with **one-time tickets**, the session in neither URL; the 1280×800 screen in the card; a click gives it the keys | **pass** (`04_production-build_other-origin_bearer.png`). So a same-origin-frame or cookie-only assumption is not what failed him |
| the installed app | its own page asked for `desktop.html` and its script | both served, right MIME types (`live-server-probe.txt`) |
| Kiri's exec stream staying open | the install's own exec | not waiting on it: `execRaw` asks the engine whether the exec still runs (`untilExecEnds`); the smokes finish within a second of apt finishing |
| the network inside the VM | apt and apk from inside Kiri's machines | fine here (the smokes install ~250 packages) |
| no network | `/etc/resolv.conf` emptied in a real Ubuntu machine, then Add a desktop (`install-failures.mts`) | failed in 8 s. **Before: the card would have read *The install failed (exit 100): E: Unable to locate package xvfb*** (apt's last line: `apt-get update` "succeeds" with warnings, then nothing can be found). Fixed (below) |
| an install that stalls | a mirror that never answers (`archive.ubuntu.com` pointed at a black hole in a real machine) | **before: the card said *Reading the package lists* for up to 25 minutes with no way out but the Terminal.** Fixed (below) |
| a server restart mid-install | by reading the code and on the stand-in | the card already said *The install was interrupted (Foundation restarted)*, but the old apt kept running in the machine and the next press could meet its lock. Fixed (below) |
| a non-root image | Kiri runs an exec as the user it is asked for (`uid 0` for `"0"`, `65534` for `nobody`: `install-failures_kiri-ubuntu.txt`) | the install now asks for root; the words for an engine that ignores that are tested on the stand-in only (no non-root image was started on Kiri) |

### What was fixed

1. **A server older than the app says so, on the card.** `panels/machineWords.ts` `desktopRefusal`: a 404 `not found` for the route itself becomes *The Foundation server at localhost:4410 is older than this app and can't add a desktop yet. Restart it (the server switch at the bottom right: Stop, then Start; or stop and start it where it runs), then try again. Nothing was changed in the machine.* It is in the well where the button is, under *The desktop didn't go in*, with **Try again**, not a toast (`01_an-older-server-says-so-on-the-card.png`). Every other refusal of the press (view only, not running, can't reach the server) is on the card the same way, in the server's words. Let agents use this desktop and Stop say the same in their toast. A desktop whose socket never opens (seven tries) says *Foundation's server didn't open the desktop's connection. It may not be running, or it may be older than this app*, and any final close now has **Try again** (it reloads the frame).
2. **No network says no network.** apt's and apk's own lines for it are recognised (`Temporary failure resolving`, `Failed to fetch`, `Could not connect to`, `temporary error (try again later)`, …) and the card reads *The machine couldn't reach its package servers, so the desktop wasn't installed (Temporary failure resolving 'archive.ubuntu.com'). Check the machine's network from its terminal (apt-get update), then try again.* On real Kiri: `install-failures_kiri-ubuntu.txt`.
3. **An install that goes quiet says for how long, and a person can stop it.** After 60 s without a byte from the package manager the card's line gains *· no word from the package manager for 3 min*. The installing state has a **Stop** (people who can edit; `POST …/desktop { stop: true }`, `stopDesktopInstall`): the install's whole process tree is killed in the machine (found through `/proc`: a bare Ubuntu has no `pkill`), the card goes back to *has no desktop yet*, and the activity says who stopped it. On real Kiri: stopped in under 100 ms both on a stalled `apt-get update` and in the middle of *Setting up perl-base (1 of 247)*; the next Add a desktop finished in 34 s from what was already unpacked. In the browser: `02_installing-with-stop.png`, `03_stopped-back-to-no-desktop.png`. The Terminal view stays one press away throughout (checked).
4. **A second install can't trip over the first.** Each install records its pid in the machine; the next one (after a Foundation restart, or a Stop) ends the old tree first, runs `dpkg --configure -a`, and apt waits up to 2 minutes for a lock instead of failing on it.
5. **Packages go in as root** whatever the image's own user is (`User: "0"` on the install's exec); if they still can't, exit 43 and *Not root: this machine runs its programs as app, and installing a desktop needs root.*
6. **No recipe, by name.** *No recipe: Fedora Linux 42 (Container Image) has neither apt nor apk, and Foundation's desktop installs only on Ubuntu, Debian and Alpine machines. Nothing was changed.* (`smoke_kiri-fedora.txt`, `smoke_kiri-rocky.txt`.)

Tests: `apps/server/test/machines-desktop.test.ts` (15, four new: root and not root; no network in apt's real words; quiet, Stop by a viewer refused, Stop, the next press a new install; an install the server knows nothing about and Stop clearing it), `apps/client/test/machine-words.test.ts` (3), `e2e/machines-fixes.spec.ts` (checks 2 and 3).

### Not done, not verified

- **His server was not restarted and his machine was not touched.** Until that server restarts, Add a desktop will keep answering *not found* there (and, with this branch's client, the words above).
- **The Tauri window itself was not driven.** A cold `tauri build` beside the installed app (another identifier and port, the capability edited) was not practical in this session, and `npm run desktop` uses the default ports. The nearest thing was run instead: the production build, another origin, bearer and tickets, in Chromium; and the installed app's own page was asked for the frame's files. WebView2-only behaviour (if any) is unverified.
- **Fedora, Rocky, Arch and openSUSE still can't have a desktop** (they say so). Three of the Start picker's seven distros can.
- **Killed package managers stay as zombies in a Kiri machine** (`(8 killed, not yet reaped)` in `install-failures_kiri-ubuntu.txt`): Kiri's init does not reap them. They hold no lock and no file; they go when the machine restarts.
- **The quiet line is the only sign of a stall**; nothing stops an install by itself before the 25-minute limit.
- **The pipes on an older server** fail the same silent way (the strip shows, nothing flows). Not looked at.
- **Nothing tells a person the server is older than the app in general.** `/auth/config` says `0.3.0` for both, so only a missing route gives it away.

## 2. "The selection around the window is still weird"

### What it was

Not the in-use ring. **Every running machine wore an agent's ring all the time**: violet, breathing, 8 px *outside* its card, so outside the section's border when the machine fills its section (`before/ring_hosting-a-section_idle.png`: nobody is typing; `before/ring_card-among-others_typing.png`). The wire layer rings every panel whose `status` is `running` as *"<name> is working here"* (`state/slices.ts` `portWiresSlice`), which is right for an agent's panel; `machines.ts` sets a machine card's `status` to `running` when the machine runs. The same reading tinted a machine card's border violet (`.panel-card.status-running`).

Three smaller things, found while measuring:

- **A desktop in use showed no ring at all** (`before/ring_desktop-in-use_2026-11-15.png`): the ring was an inset shadow on the well, and the desktop's frame fills the well and covered it.
- **The ring was 2 px of the card, not of the screen**: 1.3 px at a section's usual fit of 63 %, fatter zoomed in.
- **It doubled with the section's own ring** when the section was the active one (after pressing the card's Terminal · Desktop switch, say), and with the card's selection ring on a card among others.

### What it is now

- A running machine wears no ring and a plain card border. `portWiresSlice` leaves machines out; `.panel-card.kind-machine.status-running` keeps `--color-line-strong`.
- While the shell has the keys the ring is the **terminal well's**: an `::after` inside `.machine-term-wrap`, an inset `--color-pulse` shadow that is never transitioned. While the desktop has them it is round **the machine's screen itself** (`.machine-desk-ring.is-screen`: the 1280×800 picture, letterboxed and centred in its well, sized with container units), not the letterbox.
- **2 px on the screen at any zoom**: `useRingWidth` keeps `--machine-ring` at 2 px over the scale the card is drawn at, measured when the keys arrive, when the camera's zoom changes and on full screen; it runs only while a machine has the keys. (A border was tried first: a browser snaps it to whole pixels of the card's own, 1.2 px on the screen at 122 %.)
- **One ring**: while a machine has the keys, the section's ring and the card's selection ring stand down (`:has(.machine-term-wrap.has-keys, .machine-desk-ring)`).
- **None in full screen** (as an app's); the keys line stays.
- The *Keys go to this machine · Esc Esc to leave* pill is unchanged: at the well's foot for the terminal, in the row under the screen for the desktop.

### How it was checked

`e2e/machines-fixes.spec.ts`, check 1, on two Alpine machines on Kiri (one filling its section, one a card after a note), by day and by night, at the section's fit (63 %), zoomed out and zoomed in (up to 160 %): running and idle there is no `.agent-ring` and no ring; with the keys, the ring's box is inside the well, the card and the section (more than 2 px inside the section's edges), its width times the drawn scale is 2 px ± 0.12, the section's ring is at opacity 0 and the card is not `ctx-active`; it goes with Esc Esc; in full screen there is none and the keys line is there. On the card among others, a press on its head selects it (the 2.5 px selection ring is seen), and with the keys that ring is gone and only the well's is left. Check 2 does the same for the desktop on Ubuntu (the ring's four edges within 2.5 px of the frame's canvas; the section's ring seen at 1 before the click and 0 with the keys). `test/slices.test.ts` holds the wire layer to it; `test/machine-words.test.ts` the width.

Pictures: `ring_hosting-a-section_*`, `ring_card-among-others_*` (`…_corner.png` are close-ups), `ring_desktop_in-use_day.png` / `_night.png`, `ring_hosting-a-section_full-screen_*`, and the specimens `design_day_*` / `design_night_*`.

**Not exact:** a card's edges are not on whole screen pixels under the board's zoom, so the ring's edges are antialiased by a fraction of a pixel (measured in a screenshot at 160 %: two full pixels and a 44 % third). By night `--color-pulse` is near white (#f2f2f2), by design of the token.

## To run it again

```
npm run machines:desktop-smoke -w @foundation/server -- ubuntu kiri
cd apps/server && npx tsx ../../docs/evidence/2026-11-17_machines-fixes/install-failures.mts
cd apps/client && VITE_E2E_HOOKS=1 npx vite build --outDir <somewhere>/dist-bearer --emptyOutDir
E2E_BEARER_DIST=<somewhere>/dist-bearer E2E_SERVER_PORT=16031 E2E_CLIENT_PORT=16051 E2E_SLACK_PORT=16041 E2E_MESHY_PORT=16045 E2E_T3_PORT=16095 npm run e2e -w @foundation/client -- machines-fixes
sh docs/evidence/2026-11-17_machines-fixes/live-server-probe.sh          # is the running server older than the app?
```

Without `E2E_BEARER_DIST` the packaged-transport check skips. Last run here: `npm test` green (156 client, 268 server with 6 skipped as before, 48 + 9 elsewhere), `npm run typecheck` green, `npm run e2e … -- machines` 7 of 7 (the four here and the three of 2026-11-15, whose rewritten screenshots were put back with `git checkout -- docs/evidence`). Every machine these make is removed at the end; Kiri's list held only the owner's `machine-box-a70f` afterwards.

## For SPEC.md

### §3: in the row "Machines: typing, the desktop, agents using it, pipes", add

**Fixed 2026-11-17** (Josh: "Add a desktop doesn't work in Kiri … the selection around the window is still weird"). It didn't work because the server he ran had been started two hours before the desktop was merged and never restarted: the route answered 404 and the app showed a toast reading *not found*. A press the server refuses is now said in the well, with Try again; a server from before desktops is named as that, with how to restart it. No network, no recipe (by the distro's name), not root and an interrupted install each say so; an install that says nothing for a minute says for how long, and **Stop** ends it in the machine and puts the card back to *no desktop yet*. A running machine no longer wears an agent's ring (violet, outside its card and its section); the in-use ring is the terminal well's, or round the desktop's screen, 2 px on the screen at any zoom, and the only ring while it shows. Checked on Kiri 0.1.18 with Ubuntu, Debian and Alpine (smoke), the four distros without a recipe (refused in words), a stalled and an unreachable mirror in a real machine (`install-failures.mts`), in the browser by day and night (`e2e/machines-fixes.spec.ts`), and in the packaged app's transport (the production build on another origin, bearer, tickets). `docs/evidence/2026-11-17_machines-fixes/`

### §7 Known issues: replace "The desktop was not opened in the packaged desktop app…" with

- **The desktop was opened in the packaged app's transport, not in its window.** The production build served from another origin with a bearer and socket tickets shows and uses a desktop (`e2e/machines-fixes.spec.ts`, 2026-11-17), and the installed app serves `desktop.html` and its script. Nobody has pressed it inside the Tauri window (WebView2).

### §7 Known issues: add

- **A server started from a checkout runs what it was started with.** The app updates itself; the server does not until someone restarts it (the server switch: Stop, then Start). On 2026-11-17 that was why Add a desktop "didn't work". A missing desktop route now says so on the card; nothing says in general that the server is older than the app (both report 0.3.0), and the pipes on such a server show their strip and move nothing.
- **A desktop installs on Ubuntu, Debian and Alpine only.** Fedora, Rocky, Arch and openSUSE, four of the Start picker's seven, are refused at once with the distro's name (tried on Kiri).
- **A stalled install is only reported, not ended**: the card says how long the package manager has been quiet; a person presses Stop, or it is ended after 25 minutes.
- **Stopping an install leaves zombies in a Kiri machine** (killed apt and dpkg processes that Kiri's init doesn't reap). They hold nothing and go when the machine restarts. Kiri's to fix.
- **The in-use ring's edges are antialiased** when the card isn't drawn at a whole-pixel scale: 2 px wide to within about a tenth of a pixel, not pixel-sharp.

## For DESIGN.md: the Machine card row

Replace, in **Typing**: "While the shell has the keys the terminal's well wears the 2 px `--color-pulse` in-use ring" with

> While the shell has the keys the terminal's well wears the in-use ring: `--color-pulse`, **2 px on the screen at any zoom**, drawn *inside* the well on an `::after` (an inset shadow, never transitioned), so never on or outside the card's or the section's edge. It is the only ring while it shows: the section's ring and the card's selection ring stand down, and there is none in full screen. A machine that is merely running wears no ring and a plain card border (it is not an agent at work).

Replace, in **Desktop**: "in use, the same ring" with

> in use, the same ring round the machine's screen itself (the 1280×800 picture, not its letterbox)

Replace "installing is the amber breathing dot and the package manager's own line in code type (*Setting up xfwm4 (142 of 245)*); failed says why in its words with *Try again*" with

> installing is the amber breathing dot and the package manager's own line in code type (*Setting up xfwm4 (142 of 245)*), which gains *· no word from the package manager for 3 min* once it has been quiet a minute, and a plain **Stop** pill under it (it ends the install in the machine; the card returns to *no desktop yet*). Failed, or a press the server refused, is the dashed well titled *The desktop didn't go in* with the whole reason in dim (no recipe by the distro's name, no network, not root, a server older than the app and how to restart it) and *Try again*: never a toast. A desktop whose connection has ended for good says why in the raised strip with *Try again*.

`#/design` → Machines shows it: the ring on the well and round the screen, and a fourth row, *when it can't work* (quiet with Stop, no network, an older server).

## Plan cards

- **Restart the server the desktop app runs** (needs-you, machines): after this branch is merged into the checkout it starts from; then Add a desktop on `box-a70f`.
- **Say when the server is older than the app** (next, desktop): the server reports its commit and when it started; the app compares and offers the restart, instead of each feature finding a missing route.
- **A desktop on Fedora, Rocky, Arch and openSUSE** (later, machines): dnf (with EPEL on Rocky), pacman and zypper recipes; or take them out of what Add a desktop offers.
- **Press Add a desktop inside the Tauri window** (next, machines; replaces "Open the desktop in the packaged app"): the transport is checked, the window isn't.
- **Report to Kiri** (needs-you, add to `kiri-exec-bugs`): killed processes in a machine are never reaped.
- **Pipes on an older server say so** (later, machines): the strip shows and nothing flows.

## Files touched

- `apps/server/src/machinedesktop.ts`: the install script (root, the old install ended first, dpkg finished, apt's lock wait, no recipe by name), the network words, the quiet line, `stopDesktopInstall`.
- `apps/server/src/machines.ts`: `execRaw` takes `user`.
- `apps/server/src/index.ts`: the desktop route takes `{ stop: true }` (an import and four lines).
- `apps/server/test/machines-desktop.test.ts`: four tests, and the stand-in plays a non-root image, no network, a mirror that hangs and a Stop.
- `apps/client/src/panels/MachineViewDesktop.tsx`: refusals on the card, Stop, Try again on a final close, the screen's ring.
- `apps/client/src/panels/MachineView.tsx`: the terminal well's ref and `useRingWidth` (three lines).
- `apps/client/src/panels/MachineViewBits.tsx`: `useRingWidth`.
- `apps/client/src/panels/machineWords.ts` (new): `desktopRefusal`, `ringWidth`.
- `apps/client/src/panels/desktopFrame.ts`: a socket that never opened says what that means.
- `apps/client/src/panels/live.css`: the machine block only (the ring, the one-ring rules, a machine's border, the install's line and Stop, the final strip).
- `apps/client/src/state/slices.ts`: machines are not "running" to the wire layer (one line).
- `apps/client/src/design/DesignPage.tsx`: inside `MachineUseDemo` only (the screen's ring, the no-recipe words, a fourth row).
- `apps/client/test/slices.test.ts`, `apps/client/test/machine-words.test.ts` (new), `apps/client/e2e/machines-fixes.spec.ts` (new).
- Not touched: `shell/Shell.tsx`, `shell/shell.css`, `App.css`, `packages/protocol`, and everything on the stay-out list.
