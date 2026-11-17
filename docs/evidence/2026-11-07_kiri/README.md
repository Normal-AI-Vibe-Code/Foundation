# Kiri as part of Foundation's build — 2026-11-07

Windows 11, WSL 3.0.3, Docker Desktop 28.3 alongside. Node 22.22.

## Install (`npm run kiri:install`)

```
kiri: downloading https://github.com/libracoder/kiri/releases/download/v0.1.18/Kiri-0.1.18-x86_64.msi
kiri: Kiri-0.1.18-x86_64.msi matches the release's SHA-256 (6ea27a576198065d…)
kiri: installing 0.1.18 for this user into C:\Users\…\AppData\Local\Kiri
kiri: adding Kiri Linux to WSL as 'kiri' (C:\Users\…\AppData\Local\Kiri\wsl\kiri)
kiri: starting (engine on \\.\pipe\kiri)
kiri: pinned 0.1.18; installed 0.1.18; WSL distro 'kiri' present
kiri: engine up on \\.\pipe\kiri: Kiri 0.1.18 (API 1.47, linux/amd64)
```

No administrator prompt. Docker Desktop stayed docker's default engine.

## Smoke (`npm run machines:smoke -w @foundation/server -- kiri`)

`smoke-kiri.txt`: Kiri and Docker both up. Started `machine-smoke-…` on Kiri in 1990 ms (port 8000 → 40561), typed into the shared terminal, an agent's read saw the screen, stopped, started again in 151 ms with the disk kept, then removed it with its disk. `✓ machines work on this engine`.

## In the browser (`npm run dev`, which logged `kiri │ already running`)

| | What | How it was checked |
|---|---|---|
| 01 | Kiri quit (`kiri-win` stopped): the card says **Kiri · asleep** and offers **Start alpine:3.22 on Kiri**, *Wakes Kiri first*. Not "No engine", and not Docker, though Docker was up | DOM text and screenshot |
| — | Pressed Start: *Waking Kiri…* → *Pulling alpine:3.22…* → **Running** in about 1.5 s | polled the pill |
| 02 | In the shared terminal: `Alpine Linux v3.22 on 6.18.54.1-microsoft-standard-WSL2`. A one-line server on port 8000 | typed in xterm |
| — | `curl http://127.0.0.1:37541` → `hello from a Kiri machine`; the Wi-Fi (172.16.0.46) and WSL (172.20.208.1) addresses refused it (curl exit 7) | curl from Windows |
| — | `docker -H npipe:////./pipe/kiri inspect`: Foundation's and Kiri's labels, no mounts, not privileged. Inside, the cgroup has `memory.max` 2147483648, `cpu.max` 200000 100000, `pids.max` 1024 | the engine itself |
| 03 | Kiri quit while the machine ran: **Out of reach**, "Kiri isn't answering here… Its disk is kept". Before this change the card would have said "removed outside Foundation" | screenshot |
| 04 | Start woke Kiri: the same container `b372b8744b08` running again (Kiri's engine in WSL had kept it up, "Up 2 minutes") | container id before and after |
| — | Kiri quit again, then Remove pressed twice: Kiri woke, the machine was removed, and neither Kiri nor Docker has a container for the board | `docker ps -a` on both engines |
| 05, 06 | `#/design` → Machines: the new **Kiri · asleep** and **Out of reach** specimens, day and night | screenshots |

## Tests

`npm test`: client 33/33; server 65 pass, 0 fail, 6 skipped (the flowform fixtures, SPEC §7). `machines.test.ts` is 9/9, two of them new: an engine that stops answering leaves its machines Out of reach, not removed; and Kiri is found where its installer puts it (`setup.json`'s distro, else `kiri`; never when `FOUNDATION_ENGINES` names the engines). `npm run typecheck` is clean. The e2e suite wasn't rerun: it doesn't cover machines, and this change touches only the machine card.

## Kiri outlives Foundation

Stopping my preview server also stopped a Kiri the server had woken: `kiri-win` was in the server's process tree, and `npm run dev` stops its children with `taskkill /T`. Both launchers now go through `cmd /c start`, which cuts the parent link. Checked by quitting Kiri, starting it from a parent process, killing that parent's whole tree with `taskkill /T /F`, and looking for `kiri-win`:

```
[script] kiri: engine up on \\.\pipe\kiri: Kiri 0.1.18 (API 1.47, linux/amd64)
[script] after taskkill /T of the launcher: kiri-win alive = True
[server] kiriApp {"exe":"…\\Kiri\\kiri-win.exe","args":["--background","--distro","kiri"]} | woke true
[server] after taskkill /T of the launcher: kiri-win alive = True
```

## Found and corrected

- SPEC §0.2 said Kiri drops per-container caps (from reading `hostopts.rs`). Kiri 0.1.18 applies them: see the cgroup above.
- A machine on an engine that stopped answering was marked removed whenever any other engine was up. It now shows Out of reach, keeps its container id, and Start finds it again.
