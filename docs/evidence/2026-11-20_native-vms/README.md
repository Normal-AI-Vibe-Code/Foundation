# Native full OS VMs — 2026-11-20

Josh supplied Docker's WSL bootstrap error (allocation failed reading
`docker-wsl-cli.iso`) and asked to add and use a full WildOS VM inside a
Foundation section, including commands.

## Implemented

- Section tools, right-click menu and command menu: add a full OS / WildOS VM.
- ISO setup card, also rendered on the design page at 260/400/560 px.
- Streaming ISO/UDF import up to 16 GB, SHA-256, content-addressed archive,
  board scoping and deduplication. Completed uploads are never deleted.
- Server-owned SQLite VM configuration, server-generated private disk path,
  native QEMU, bounded RAM/CPU, explicit TCG or host acceleration. No WSL,
  Docker, auto-download, host mounts or elevated process.
- Separate person-only creation/start. Persistent sparse disks, installer
  versus installed boot, stopped resource changes, graceful shutdown,
  confirmed power off, confirmed disk-preserving archive and restore.
- Embedded noVNC desktop through Foundation's authenticated socket. QEMU VNC
  is loopback-only with a random per-run password; no session or password in
  URLs. People with board write rights get input; agents/viewers do not.
- Guest-agent commands with explicit Run, persistent request claims to avoid
  replay, opaque command IDs independent of reused guest PIDs, output and exit
  status. Guest setup command shown in the UI. No host shell execution.
- Programs start through the existing child environment door, no server keys.
  Lifecycle/command audit. A previous live PID blocks another copy; server
  shutdown and card removal request graceful guest shutdown.

## Checks actually run

| Check | Outcome |
|---|---|
| npm install | Passed, already up to date |
| Full baseline npm test | Not green: avatars local Git fixture failed; suite then stalled under sandbox restrictions and was stopped |
| New VM tests plus child-door regression | 18/18 passed |
| Client token and machine-page regressions | 11/11 passed |
| Workspace TypeScript checks | Passed |
| Client production build | Passed; existing large-bundle warning |
| Security scan | Clean; eight existing allowlist waivers |
| Plan validation and diff whitespace | Passed |
| Host browser acceptance spec discovery | Two tests discovered successfully; not executed |

The VM tests invoke production router handlers, archive streaming, board
storage, auth/person gates, socket authorization and relay logic. QMP, VNC
and guest-agent host transports and child processes are simulated. They test
fragmented replies, duplicate commands, guest PID reuse, rejected credentials,
forged card state, resource bounds, preserved disks, startup failures and the
previous-process guard. They do **not** establish that a real guest boots.

## Blocked checks — no screenshots or real OS claim

`npm run dev` started the isolated client on 15330 and server on 15331, with
fresh data under `work/vm-browser` and no agent runtime. Shell loopback TCP
connections return `connect EACCES`; the first attempt at HTTP integration
tests failed for that reason. In-app browser and connected Chrome both timed
out opening that server (`net::ERR_CONNECTION_TIMED_OUT`). No day/night
visual inspection or screenshot was obtained. Dev processes were stopped.

No QEMU installation or verified WildOS ISO was available to this session.
No ISO was downloaded, no real OS was started, and no Docker/WSL settings,
distributions or data were reset. Readable WSL configuration had a 16 GB
memory ceiling on a roughly 64 GB host; that alone does not explain ENOMEM.

For host acceptance, run Foundation's current source and the browser spec:

```powershell
npm run e2e -w @foundation/client -- local-vms.spec.ts
```

Set `VM_E2E_ISO` to a verified WildOS ISO to opt into the real-QEMU test.
That test checks a real console/framebuffer, not arrival at a usable desktop;
complete installation and a real guest command still need to be observed.

Open limitations: crashed-server VM reattachment, view-only desktop streaming,
audio, device passthrough, snapshots and nested Windows mode. The feature is
in **Review**, not marked Done. Prior `.codex/config.toml` changes untouched.

Repository hand-off: `plan:push` could not connect to GitHub. Commit/staging
was denied creating `.git/index.lock`; this session has read-only repository
metadata. The implementation remains in the working tree, uncommitted.
