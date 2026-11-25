# WildOS / WSL host setup — 2026-11-19 (Honolulu)

Request: diagnose this PC's WSL problem, use WildOS locally, and assess a
WildOS VM or local Docker engine in Foundation.

## Observed

- `npm install`: passed, up to date.
- `npm run typecheck`: passed for client and server.
- `npm test`: baseline is red. Client: 237/238; crowded-board routing took
  640 ms for 20 routes. Isolated wires rerun: 18/19; same assertion, 560 ms.
  Extension: 9/9. Server avatars fixture failed cloning its temporary local
  bare Git repository (`fatal: Could not read from remote repository`). The
  server suite then made no further progress; no complete server pass claimed.
- `npm run wildos`: passed as a diagnostic command (exit 0). WSL version
  3.0.5.0, kernel 6.18.58.1-1, Windows 10.0.26300.9974 were readable.
  Status and distro queries: `Wsl/E_ACCESSDENIED`. CIM: access unavailable.
  Windows features: elevation required. Services and local engines were not
  visible/reachable in the sandbox. A denied query is unknown host state.
- Docker Desktop exists in the desktop app inventory. Launching its settings
  through computer use ended in `Computer Use app approval timed out`.
  No Docker UI settings were changed or inspected.
- `git ls-remote https://github.com/wildorigins/wildos.git HEAD`: failed with
  `getaddrinfo() thread failed to start`. No upstream checkout fetched.
- Upstream README and Windows build entry point read through web retrieval:
  Docker builds an ISO, with `--privileged`; the ISO is booted as a VM.
- PowerShell parser: no errors in `scripts/wildos.ps1`.
- RepairWsl, BuildIso, StartVm (ISO), StartVm (installed disk), all with
  `-WhatIf`: passed; no VM disk created. Actual changing actions were not run.
- `npm run plan:check`: passed. `npm run plan:push`: blocked connecting to
  `api.github.com`.
- Commit attempt: blocked creating `.git/index.lock` (`Permission denied`);
  the repository metadata is read only to this session. Changes are uncommitted.

## Changes and limits

Added a read-only diagnostic entry point and explicit host-side recovery,
upstream ISO build and native-QEMU boot actions. Repair never unregisters a
distro, resets Docker, deletes a disk, stops distributions or reboots. QEMU
uses its own sparse disk and no shared host directories or forwarded ports.
No new dependencies, app UI, server routes, privileges or console listeners.

**Not done:** determine the real host WSL error; repair host WSL; obtain and
verify an ISO; observe a usable WildOS desktop; integrate a VM console with
Foundation's board permissions. No screenshot of a working VM exists.

Existing unrelated change in `.codex/config.toml` left untouched.
