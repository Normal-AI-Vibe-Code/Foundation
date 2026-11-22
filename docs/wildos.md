# WildOS on this Windows computer

WildOS's Docker container **builds an ISO**; it does not run the desktop.
Boot the ISO in a virtual machine to use the complete OS. Upstream's
Windows entry point is `build-iso.ps1`, and its builder needs privileged
Docker access. Foundation's ordinary Kiri/Docker machines deliberately do
not grant that access. Do not change that rule to build an ISO.

## Find the host fault first

From **PowerShell 7 on the Windows host**, in `C:\Dev\Foundation`:

```powershell
npm run wildos
```

This is read only. It shows WSL's actual errors, distributions, firmware
virtualization, hypervisor state, Windows features, services, Docker's CLI
and server, and Kiri. Queries denied by permissions are **unknown**, not
evidence that a component is absent. Docker Desktop can be installed even
when `docker` is missing from PATH; the helper checks its usual paths too.
Diagnostic commands time out instead of waiting forever on a broken WSL.
There are no keys or application environment dumps. Distribution names and
computer details can still be private; read the output before sharing it.

If the features are disabled, run this from **PowerShell 7 as Administrator**:

```powershell
npm run wildos -- -Action RepairWsl -WhatIf
npm run wildos -- -Action RepairWsl
```

Repair enables the WSL and Virtual Machine Platform features if missing,
updates WSL using Microsoft's web download, selects WSL 2 for *new*
distributions, and starts an installed WSL service if stopped. A pending
Windows-feature restart stops the workflow and asks you to restart yourself.
An explicitly disabled hypervisor boot setting is reported with its repair
command. BIOS/UEFI virtualization needs to be enabled in firmware separately.
It does not convert existing WSL 1 distributions, unregister anything, reset
Docker, stop running distributions, change firewall/antivirus settings, or
reboot. Run Diagnose afterwards; successful feature updates alone do not
prove a distribution can boot.

After a restart, if needed, start Docker Desktop and wait for its engine.
It must be in **Linux containers** mode. Run Diagnose again. Docker's Hyper-V
backend is another option on supported Windows installations, but changing
backends is not part of this helper. Kiri on Windows also uses WSL 2; switching
from Docker to Kiri does not bypass a broken WSL host.

## Get the ISO

The shortest route is the ISO and signed checksums linked by
[WildOS's README](https://github.com/wildorigins/wildos#try-it).
Follow upstream's verification instructions. This session could not fetch
the download endpoints, so no ISO or checksum has been verified here.

Alternatively, explicitly start the source build:

```powershell
npm run wildos -- -Action BuildIso -WhatIf
npm run wildos -- -Action BuildIso
```

The helper clones upstream into `work/wildos/source` only if that folder is
absent, prints its commit, and runs its own Windows build entry point using
Docker. An existing checkout is used as-is, never reset or pulled. Use
`-Checkout C:\path\to\wildos` for one you already have. This executes
upstream code with the privileged access its builder requests; start it only
on your own development computer. The build may take substantial time,
memory and disk. Keep its Docker caches; do not prune them as a repair step.
The helper checks that an ISO actually exists in `out/` before calling the
build complete.

## Boot it without relying on WSL

Install native Windows QEMU using the links on
[QEMU's Windows download page](https://www.qemu.org/download/#windows).
For hardware acceleration, enable **Windows Hypervisor Platform** in Windows
Features and restart if Windows requests it. This is separate from WSL's
Virtual Machine Platform. Then:

```powershell
npm run wildos -- -Action StartVm -Iso C:\path\to\wildos-amd64.iso
```

This launches a native QEMU window with 8 GB RAM, four CPUs, NAT networking,
and a 64 GB sparse disk at `work/wildos/wildos.qcow2`. It shares no host
folders or physical disks and forwards no network ports. `-MemoryGB 4
-Cpus 2` reduces the allocation. If WHPX cannot initialize, explicitly use
`-Software` for slower software emulation, which works without WSL or a
working hardware hypervisor. There is no automatic fallback that could hide
the fault. QEMU's real exit code is checked.

Choose **Try WildOS** for a live desktop. To retain changes, install onto the
VM's disk inside QEMU. On subsequent runs, omit the ISO and use:

```powershell
npm run wildos -- -Action StartVm -Installed
```

This boots the existing disk with no ISO attached. Shut down from inside
WildOS; avoid force-closing a VM with unsaved work. The helper never replaces
an existing disk. Windows mode inside WildOS adds another VM and needs a
separate nested-virtualization check and an appropriate Windows licence;
that is not configured here.

## Opening it inside Foundation

The native VM backend is now implemented. QEMU runs on the **Foundation
server's computer**, independent of Docker, Kiri and WSL. On Windows it uses
WHPX, or explicit software emulation (TCG). This is a full x86-64 VM with its
own kernel, not the container desktop's XFCE installation.

1. Install native QEMU on that computer using its official download links.
   Foundation finds `qemu-system-x86_64.exe` and `qemu-img.exe` on PATH or in
   `C:\Program Files\qemu`. For another location set `FOUNDATION_QEMU` and
   `FOUNDATION_QEMU_IMG` to the two full executable paths in the server's
   settings, then restart Foundation's server. Nothing installs automatically.
2. Restart the server and use the client from this checkout (`npm run dev`
   serves it at `http://localhost:1430`). This work has not been published as
   an installed desktop update. In a section's tools or right-click menu choose **Full operating system /
   WildOS VM**. The command menu has the same action. An ordinary new machine
   also offers **Container / Full OS / WildOS VM**.
3. **Import an ISO** from this computer, or choose one already archived on
   this board. Imports stream to disk (up to 16 GB), validate ISO/UDF media,
   calculate SHA-256 and deduplicate the bytes. No multi-gigabyte in-memory
   upload. Compare the hash with upstream's signed checksums before booting.
4. Set RAM and CPU. **Software emulation** works without WSL or a functioning
   hypervisor and is slower. Press **Add VM to this section**, then **Start
   VM**. They are separate actions: adding a card starts no OS or installer.
5. Use the embedded **Desktop**, or **Full screen**. Click to give the VM the
   keyboard; Esc twice hands it back. In the OS you can open its terminal and
   run commands normally. Install WildOS onto the VM's disk to retain your
   work, then shut down and uncheck **Boot installer ISO** for subsequent runs.
6. The **Commands** tab uses QEMU's guest agent. In the guest's desktop
   terminal enable it once (Debian-based guests with systemd):

   ```sh
   sudo apt-get update && sudo apt-get install -y qemu-guest-agent && sudo systemctl start qemu-guest-agent
   ```

   Then enter a command and press **Run in VM**. It runs as the guest agent's
   account (normally root), inside the VM, not in Windows. Output, exit status
   and truncation are shown. Request IDs prevent retrying a command twice;
   leaving the tab does not kill a running command. Live-session package
   installs disappear unless the OS has been installed on its persistent disk.

Every card has its own sparse qcow2 disk in the server's work folder under
`vms/<server-generated-id>/system.qcow2`. Paths and configuration are held in
SQLite; changing a synced card cannot choose a host disk or executable. There
are no shared host folders, physical disks, elevated processes, forwarded
guest ports or Docker engine sockets. Networking is QEMU user-mode NAT; the
guest can reach the network. Native processes inherit the server's filtered
child environment, never its API keys. Resource choices are bounded and
Start refuses when the host has insufficient free RAM.

**Shut down** asks the guest to finish cleanly. If it ignores that request,
**Power off** needs explicit confirmation and can lose unsaved work. RAM,
CPU, boot source and emulation can be changed while stopped. **Archive VM**
also needs confirmation and keeps the disk and ISO; Restore brings its card
back to a stopped state. Removing the card asks the guest to shut down too,
without deleting its disk.

Console passwords are random per run; the VNC listener is loopback-only and
password protected. The browser reaches it through Foundation's authenticated
socket, using the normal cookie or single-use socket ticket. Starts, changes,
console credentials, console input and guest commands require a person who
can edit the board; agents and viewers cannot acquire input. Board permissions
are rechecked during console input. Viewers see VM status; view-only desktop
streaming is not implemented in this first slice. Lifecycle and commands are
audited without recording command contents in the audit log.

Server shutdown requests graceful guest shutdown. After a server crash a VM
may still be running; Foundation retains its PID and refuses another process
on that disk. It never kills a potentially reused PID. Finish shutting down
that VM on the host before restarting it in Foundation. Reconnecting to a VM
left by a crashed server, Windows mode/nested virtualization, audio, device
passthrough, snapshots and guest-agent auto-install are not implemented.

**Verification as of 2026-11-20:** native VM lifecycle, streaming archive,
permissions, console relay, idempotent commands, resource limits, disk retention
and startup failures checked against simulated QMP/guest-agent transports.
Typecheck, client build and token checks passed. This agent's sandbox blocks
even loopback connections: an attempted HTTP test returned `connect EACCES`,
and in-app/Chrome browsers timed out on the isolated dev server. No browser
screenshots, installed QEMU or real WildOS boot verified. Host acceptance tests
are in `apps/client/e2e/local-vms.spec.ts`; set `VM_E2E_ISO` to verified media
to opt into the real-VM test. Until that passes, this slice is **Review**.

## Docker's reported bootstrap failure

Josh's 2026-11-20 error reached `wsl-bootstrap` and found the existing ext4
filesystem, then failed reading `docker-wsl-cli.iso` with **cannot allocate
memory**. The missing `componentsVersion.json` line was a warning; the fatal
line identifies an allocation failure during CLI ISO caching. This does not
show that the Docker data disk should be reset.

The readable `.wslconfig` has a 16 GB limit on a roughly 64 GB host, with
mirrored networking; it is not an accidentally tiny WSL ceiling. Check actual
WSL memory/swap and Windows committed-memory/page-file pressure from the host
before changing allocations. Nothing in this slice resets Docker, unregisters
its distro, edits `.wslconfig`, changes networking or stops HomeForm's hub.
The native VM path does not depend on Docker bootstrap succeeding.

References: [Microsoft WSL troubleshooting](https://learn.microsoft.com/en-us/windows/wsl/troubleshooting),
[Docker's Windows prerequisites](https://docs.docker.com/desktop/setup/install/windows-install/),
[QEMU WHPX](https://www.qemu.org/docs/master/system/whpx.html),
[WildOS Windows builder](https://github.com/wildorigins/wildos/blob/main/build-iso.ps1).
