# Kiri 0.1.18 → 0.2.1 — 2026-11-17

Windows 11 desk PC, WSL 2 (kernel 6.18.58.1), no Docker Desktop. Josh said yes to the upgrade from a HomeForm session, where the FarmBot OS runs in a container on Kiri.

## Upgrade (`npm run kiri:install`)

First try, with only VERSION and the hashes changed: the MSI installed and the app came up as 0.2.1, but the engine in WSL stayed 0.1.18. Kiri's log said why:

```
engine: not answering; starting it in WSL
engine: could not copy the engine into WSL (Kiri's Linux is not set up); starting the one there
```

Kiri's app reads its distro from `%LOCALAPPDATA%\Kiri\setup.json`, which its setup window writes and our headless install never had. With that file written, the copy still did nothing: Kiri 0.2.1 runs `wsl.exe -d kiri -u root -- sh -c '<script>'`, and after `--` wsl.exe hands the line to the distro's shell, which expands the script's `$f` and `$s` to nothing before `sh -c` runs it. A reproduction printed `f= s=` and `sh: kiri: unknown operand`. Kiri's main already runs `wsl.exe -e sh -c` (`crates/kiri-win/src/wslsync.rs`, after PR #264), so nothing was filed. Until a release has it, `kiri.mjs` copies `kiri` and `kiri-init` itself (with `-e`) when the engine is older than the pin.

```
kiri: 0.2.1 is installed (C:\Users\…\AppData\Local\Kiri)
kiri: the engine in WSL is 0.1.18; copying 0.2.1's in and restarting Kiri
kiri: copied kiri, kiri-init into 'kiri'
kiri: starting (engine on \\.\pipe\kiri)
kiri: pinned 0.2.1; installed 0.2.1; WSL distro 'kiri' present
kiri: engine up on \\.\pipe\kiri: Kiri 0.2.1 (API 1.47, linux/amd64)
```

Run again, it changes nothing and says the same last two lines. The MSI matched GitHub's sha256 digest for `Kiri-0.2.1-x86_64.msi` (`784314423a5f4723…`); the release has no `SHA256SUMS`.

## Machines on 0.2.1 (`npm run machines:smoke` in apps/server)

```
· Kiri at \\.\pipe\kiri: up, 0.2.1 (API 1.47)
· started machine-smoke-… on Kiri in 1840 ms; ports [{"port":8000,"host":41660}]
· typed into the shared terminal: foundation-42
· an agent's read sees the screen
· stopped
· started again in 177 ms, the disk kept
· removed, with its disk
✓ machines work on this engine
```

Before the status fix the first line said `27.5.1`: Kiri 0.2.x answers `Version` with the Docker version it matches and its own in `Components`. `test/machines*.test.ts`: 26 pass.

## Not checked

- The Machines card in the browser (the status change is the version string only).
- A fresh install on a machine with no Kiri (the import path did not change).
- macOS and Linux; 0.2.1 has no full `.deb`.
