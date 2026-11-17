# Machines in a section — Kiri or Docker (2026-11-07)

Windows 11, Docker Desktop 28.3.0 (Engine API 1.51) on `\\.\pipe\docker_engine`. Kiri isn't installed on this machine: the card and the driver found its pipe (`\\.\pipe\kiri`) empty and said so. Kiri's side was checked against its source (libracoder/kiri @ 6447418, `crates/kiri/src/daemon/api.rs`, `machine.rs`): it serves every Engine API call used here (`/version`, `/images/{name}/json`, `/images/create`, `/images/load`, `/containers/json|create|start|stop|restart|DELETE`, `/containers/{id}/exec`, `/exec/{id}/start` with a 101 upgrade, `/exec/{id}/resize`), and its machines are the same shape (`machine-<name>`, label `dev.kiri.machine`).

## What was run

| Check | How | Result |
|---|---|---|
| Invariants, against a stand-in engine on a named pipe | `apps/server/test/machines.test.ts` (7) | pass |
| The driver against the real engine | `npm run machines:smoke -w @foundation/server` → `smoke-docker.txt` | pulled and started alpine in ~0.4 s (cached), typed `foundation-42`, an agent's read saw the screen, stop, start again with the disk kept, removed; 0 containers left |
| A proposal, then a person's Start, in the browser | `propose_machine` over `POST /api/boards/machines-check/tools/…`; **Start alpine:3.22 on Docker** pressed in the card | the card went Not started → Running; `docker inspect machine-build-box`: labels `dev.foundation.board`, `dev.foundation.panel`, `dev.kiri.machine=build-box`; `Binds` null, `Privileged` false, `Memory` 2 GiB, `NanoCpus` 2e9, `PidsLimit` 1024; port `127.0.0.1:11081->8000/tcp` |
| Typing into the machine | the terminal in the card (xterm.js), real key presses | `NAME="Alpine Linux"`, `Machines in Foundation: 42` |
| A port as a page | a 5-line `nc` server on :8000 in the machine; **:8000 ↗** pressed | a new section beside the machine framing `http://127.0.0.1:11081/`: "hello from build-box" (`05-port-opened-as-section.jpg`); `curl` got the same |
| Two people, one shell | Ada on `localhost:1430`, Kai on `kai.localhost:1430` (separate cookies) | Kai's `echo "kai was here … on $(hostname)"` → `kai was here at 04:04 on build-box` in Ada's terminal; the card says **2 here** |
| Reload | reloaded mid-session | the terminal came back on the same shell with its screen |
| An agent can't run it | a bearer token from `/api/agent/token`, `POST …/stop` | **403** "Stopping a machine needs a person: press the button on the card. Agents can propose, not run." |
| Deletes need confirm | `POST …/remove` without `confirm` | **400** "Removing a machine deletes its disk. Send confirm: true to do it." |
| Stop keeps the disk | **Stop** → both browsers: "Stopped by Ada Check. Its disk is kept"; **Start on Docker**; `cat /srv/index.html` | `hello-from-the-box` (`06-terminal-day-disk-kept.jpg`) |
| Remove | **Remove** → "Remove it and its disk?" → pressed again | card back to Not started; `docker ps -a --filter label=dev.foundation.panel` empty |
| Day and night | `#/design` → Machines (`01`, `02`), the board (`03`, `06`, `07`) | on tokens; the terminal's colours are the tokens, resolved through a probe element |

## Not run

- **Kiri itself.** Not installed here (installing it is a person's call: an MSI from runkiri.com). With Kiri running, `npm run machines:smoke -w @foundation/server -- kiri` is the check.
- **A real agent turn** proposing a machine. The tool ran over HTTP as the person; the agent runtimes use the same `runTool`.
- **The terminal at zooms other than 100 %**: xterm measures its cells unscaled, so text renders right, but a mouse selection at another zoom lands off by the zoom factor (SPEC §7).

## The rest of the app, in a real browser

`E2E_CLIENT_PORT=15450 npm run e2e -w @foundation/client` (Windows 11, headless Chromium with software WebGL): **21 passed, 1 skipped by design, 1 failed: the perf trace**. Every functional check passed (two people, sections, voice, layouts, CAD, Vision). The perf trace misses its p95 budget (< 34 ms) by one quantised frame (50 ms) on a different action each run. That isn't this change: the same trace on the code **without** it failed in 2 of 3 runs the same way (pan or zoom p95 50 ms), and passed once. Its frames are an upper bound here (SPEC §5); measure on a GPU.
