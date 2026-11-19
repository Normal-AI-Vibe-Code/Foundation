/**
 * A machine's graphical desktop, and agents using it (Josh, 2026-11-15: "a
 * very clear option to see the VM's desktop", "the agent council to clearly
 * manipulate the VM and have computer use over it").
 *
 * The desktop is a real one, inside the machine: an X server (Xvfb, 1280×800),
 * the XFCE session (window manager, panel, file manager, terminal) and VNC
 * (x11vnc, listening on the machine's own loopback). Nothing is published:
 * the machine's ports stay as they were. Foundation reaches VNC the way it
 * reaches the shell, through the engine: an exec of `socat` whose stream is
 * relayed to browsers over /machines/:board/:panel/vnc, where noVNC draws it
 * (apps/client/desktop.html). So it works on a machine that is already
 * running, for someone on another computer, and by the board's roles: people
 * who can edit get the pointer and keys; viewers get a second, view-only VNC
 * (x11vnc -viewonly on another loopback port) and can only watch.
 *
 * Rules:
 *  - **Add a desktop** installs packages into the machine (apt on Ubuntu and
 *    Debian, apk on Alpine; all three tried on Kiri 0.1.18). Any other image
 *    is told so at once, by name; a machine that can't reach its package
 *    servers, or isn't root, is told that. A person can Stop an install. That is third-party
 *    code, so only a person does it, from their browser session, never a
 *    bearer (the route asks requirePerson). Progress is the package manager's
 *    own lines. The desktop lives on the machine's disk: Stop keeps it, Remove
 *    takes it.
 *  - Agents use a desktop (desktop_screenshot, desktop_mouse, desktop_type,
 *    desktop_key in tools.ts) only where a person pressed **Let agents use
 *    this desktop**: a grant on that machine, with who and when, off by
 *    default, taken away by anyone who can edit. A person whose computer-use
 *    preference is "never" (prefs.ts) can't grant, and their agents don't use
 *    desktops. A viewer can't grant; a bearer can't grant.
 *  - Every action an agent takes is on the card (who is using the desktop and
 *    what it just did), in the board's activity under the agent's name, and
 *    under its crew cursor.
 */

import type { Socket } from "node:net";
import type { WebSocket } from "ws";
import { boardMaps, desktopLeaveOf, logActivity, MACHINE_AGENT_ACTIVE_MS, type DesktopLeave, type MachineAgentAct, type MachineState, type PanelDoc } from "@foundation/protocol";
import { HttpError } from "./http.ts";
import { canWrite } from "./roles.ts";
import { editBoard, getBoard } from "./boards.ts";
import { demux, engineJson, execRaw, execSh, findContainer, hijack, machineHooks, machinePanel, UNBLOCK_FN, writeMachine } from "./machines.ts";
import { findMachineCard } from "./machineasks.ts";
import { aim, crewMember } from "./crew.ts";
import { computerUseDefault } from "./prefs.ts";

export const DESKTOP_SCREEN = { w: 1280, h: 800 };
const DIR = "/tmp/foundation-desktop";
const ENV = ["DISPLAY=:1"];
/** VNC inside the machine, on its loopback only: people who can edit, and a view-only one for viewers */
const VNC_PORT = 5900;
const VNC_VIEW_PORT = 5901;

const key = (b: string, p: string) => `${b}/${p}`;

// ---------- installing it (a person's press) ----------

const APT = "xvfb x11vnc xfce4-session xfwm4 xfce4-panel xfdesktop4 xfce4-terminal thunar dbus-x11 xdotool scrot socat procps fonts-dejavu-core";
const APK = "xvfb x11vnc xfce4 xfce4-terminal dbus dbus-x11 xdotool scrot socat font-dejavu adwaita-icon-theme";
const NEEDS = "Xvfb x11vnc xfce4-session xdotool scrot socat";

/** a process and everything under it, children first (no pkill in a bare Ubuntu; /proc, grep and sed are everywhere) */
const TREE_FN = `tree() { for c in $(grep -l "^PPid:[[:space:]]*$1\$" /proc/[0-9]*/status 2>/dev/null | sed 's#^/proc/##; s#/status$##'); do tree "$c"; done; echo "$1"; }`;
const PID_FILE = `${DIR}/install.pid`;
/** end the install whose pid is on file, if it is still one of ours (its command line names the pid file) */
const END_INSTALL = `
${TREE_FN}
old=$(cat ${PID_FILE} 2>/dev/null)
if [ -n "$old" ] && [ "$old" != "$$" ] && grep -q install.pid "/proc/$old/cmdline" 2>/dev/null; then kill -KILL $(tree "$old") 2>/dev/null; echo "Stopped an install that was still going"; fi
`;

/**
 * Everything it prints is progress, in the package manager's words, or the
 * reason it can't go on, in ours. exit 42: no recipe for this image (Fedora,
 * Rocky, Arch and openSUSE, tried on Kiri 2026-11-17: said at once, nothing
 * touched). exit 43: not root. An install left running by a Foundation that
 * restarted is ended first, a dpkg it cut short is finished, and apt waits for
 * a lock instead of failing on it.
 */
const INSTALL = `
have() { for b in ${NEEDS}; do command -v "$b" >/dev/null 2>&1 || return 1; done; }
if have; then echo "Already installed"; exit 0; fi
os=$(. /etc/os-release 2>/dev/null; echo "\${PRETTY_NAME:-This image}")
if [ "$(id -u)" != 0 ]; then
  echo "Not root: this machine runs its programs as $(id -un 2>/dev/null || id -u), and installing a desktop needs root. Nothing was changed."
  exit 43
fi
mkdir -p ${DIR}
${END_INSTALL}
echo $$ > ${PID_FILE}
if command -v apt-get >/dev/null 2>&1; then
  echo "Reading the package lists"
  dpkg --configure -a >/dev/null 2>&1
  apt-get -o DPkg::Lock::Timeout=120 update 2>&1 || exit 1
  apt-get -o DPkg::Lock::Timeout=120 install -y --no-install-recommends ${APT} 2>&1 || exit 1
elif command -v apk >/dev/null 2>&1; then
  apk add --no-cache ${APK} 2>&1 || exit 1
else
  echo "No recipe: $os has neither apt nor apk, and Foundation's desktop installs only on Ubuntu, Debian and Alpine machines. Nothing was changed."
  exit 42
fi
rm -f ${PID_FILE}
have || { echo "The packages went in, but the desktop's programs aren't all there."; exit 1; }
echo "Installed"
`;

/** a person's Stop: end the install's whole tree (the package manager and what it started) */
const STOP_INSTALL = `
${END_INSTALL}
rm -f ${PID_FILE}
`;

/** how long the package manager may say nothing before the card says so, and how often that is looked at */
const QUIET_MS = Number(process.env.FOUNDATION_DESKTOP_QUIET_MS) || 60_000;
const BEAT_MS = Math.min(15_000, Math.max(20, Math.round(QUIET_MS / 4)));
/** lines that mean the machine couldn't reach its package servers (apt's and apk's words) */
const NO_NETWORK = /Temporary failure resolving|Could not resolve|Failed to fetch|Could not connect to|Unable to connect to|Network is unreachable|temporary error \(try again later\)|DNS lookup error|network error|Connection timed out/i;

/**
 * Bring the desktop up if it isn't (after a restart, nothing of it runs) and
 * print the screen's size. Each part is started only if it isn't answering.
 * exit 3: not installed.
 */
const UP = `
D=${DIR}; mkdir -p "$D"
export DISPLAY=:1; export HOME="\${HOME:-/root}"
for b in ${NEEDS}; do command -v "$b" >/dev/null 2>&1 || { echo "no desktop is installed in this machine ($b is missing)" >&2; exit 3; }; done
cat > "$D/run" <<'FOUNDATION_RUN'
#!/bin/sh
${UNBLOCK_FN}
unblocked "$@"
FOUNDATION_RUN
chmod +x "$D/run"
if ! xdotool getdisplaygeometry >/dev/null 2>&1; then
  rm -f /tmp/.X1-lock /tmp/.X11-unix/X1
  setsid nohup "$D/run" Xvfb :1 -screen 0 ${DESKTOP_SCREEN.w}x${DESKTOP_SCREEN.h}x24 -nolisten tcp >"$D/xvfb.log" 2>&1 &
  i=0; while ! xdotool getdisplaygeometry >/dev/null 2>&1 && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done
fi
xdotool getdisplaygeometry >/dev/null 2>&1 || { echo "the X server didn't start: $(tail -n 2 "$D/xvfb.log" 2>/dev/null)" >&2; exit 4; }
if ! pgrep -x xfce4-session >/dev/null 2>&1; then
  (cd "$HOME" && setsid nohup "$D/run" dbus-launch --exit-with-session xfce4-session >"$D/session.log" 2>&1 &)
  i=0; while ! pgrep -x xfwm4 >/dev/null 2>&1 && [ $i -lt 80 ]; do sleep 0.1; i=$((i+1)); done
fi
up() { socat /dev/null "TCP:127.0.0.1:$1,connect-timeout=1" 2>/dev/null; }
up ${VNC_PORT} || setsid nohup "$D/run" x11vnc -display :1 -rfbport ${VNC_PORT} -localhost -forever -shared -nopw -repeat -q -o "$D/vnc.log" >/dev/null 2>&1 &
up ${VNC_VIEW_PORT} || setsid nohup "$D/run" x11vnc -display :1 -rfbport ${VNC_VIEW_PORT} -localhost -forever -shared -nopw -viewonly -q -o "$D/vnc-view.log" >/dev/null 2>&1 &
i=0; while ! { up ${VNC_PORT} && up ${VNC_VIEW_PORT}; } && [ $i -lt 80 ]; do sleep 0.1; i=$((i+1)); done
up ${VNC_PORT} || { echo "VNC didn't start: $(tail -n 2 "$D/vnc.log" 2>/dev/null)" >&2; exit 5; }
xdotool getdisplaygeometry
`;

const installing = new Map<string, Promise<MachineState>>();
/** the installs going on in this server, so a person's Stop can mark one as theirs to end */
const running = new Map<string, { stopped: boolean }>();
const STOPPED = "The install was stopped.";
const quietFor = (ms: number) => (ms < 120_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);

function runningCard(boardId: string, panelId: string): PanelDoc & { machine: MachineState } {
  const panel = machinePanel(boardId, panelId);
  if (!panel.machine) throw new HttpError(404, "this card has no machine");
  if (panel.machine.state !== "running") throw new HttpError(409, `${panel.machine.name} isn't running. Start it first.`);
  return panel as PanelDoc & { machine: MachineState };
}

/** one line of what the package manager is doing, for the card */
export function installProgress(line: string, seen: { total?: number; done: number; noNetwork?: string }): string | null {
  const l = line.trim();
  if (!l) return null;
  let m: RegExpExecArray | null;
  if (!seen.noNetwork && NO_NETWORK.test(l)) seen.noNetwork = l.replace(/^(W|E|Err:\d+|WARNING|ERROR):?\s*/, "").slice(0, 160);
  if ((m = /(\d+) newly installed/.exec(l))) seen.total = Number(m[1]);
  if ((m = /^\((\d+)\/(\d+)\) Installing (\S+)/.exec(l))) {
    seen.total = Number(m[2]);
    seen.done = Number(m[1]);
    return `Installing ${m[3]} (${m[1]} of ${m[2]})`;
  }
  if ((m = /^Setting up (\S+)/.exec(l))) {
    seen.done++;
    return `Setting up ${m[1].replace(/:.*$/, "")}${seen.total ? ` (${Math.min(seen.done, seen.total)} of ${seen.total})` : ""}`;
  }
  if ((m = /^Get:\d+ \S+ \S+ \S+ (\S+)/.exec(l))) return `Downloading ${m[1]}${seen.total ? ` (${seen.total} packages)` : ""}`;
  if ((m = /^Unpacking (\S+)/.exec(l))) return `Unpacking ${m[1].replace(/:.*$/, "")}`;
  if (/^(Reading the package lists|Already installed|Installed|No recipe:|Not root:|Stopped an install|The packages went in)/.test(l)) return l;
  if (/^(E:|ERROR:|Err:)/.test(l)) return l.slice(0, 200);
  return null;
}

/**
 * A person pressed Add a desktop: install it in the running machine and bring
 * it up. Returns at once with the card's state and `done`, which settles when
 * the desktop is ready (or says why not); a second press while one installs
 * joins the first.
 */
export function addDesktop(boardId: string, panelId: string, person: { id: string; name: string }): { machine: MachineState; done: Promise<MachineState> } {
  if (!canWrite(person.id, boardId)) throw new HttpError(403, `View only: someone who can edit “${boardId}” adds a desktop`);
  return install(boardId, panelId, person);
}

/** the install itself; its callers have checked who is asking (the button's route, or Start's) */
function install(boardId: string, panelId: string, person: { name: string }): { machine: MachineState; done: Promise<MachineState> } {
  const panel = runningCard(boardId, panelId);
  const k = key(boardId, panelId);
  const going = installing.get(k);
  if (going) return { machine: panel.machine, done: going };
  writeMachine(boardId, panelId, { desktop: { state: "installing", detail: "Starting…", by: person.name, at: Date.now() }, wantDesktop: undefined });
  const run = { stopped: false };
  running.set(k, run);
  const done = (async () => {
    const seen: { total?: number; done: number; noNetwork?: string } = { done: 0 };
    let last = 0;
    let said = "";
    let partial = "";
    let heard = Date.now();
    const started = machinePanel(boardId, panelId).machine?.desktop?.at ?? Date.now();
    const show = (detail: string) => writeMachine(boardId, panelId, { desktop: { state: "installing", detail, by: person.name, at: started } });
    const say = (line: string) => {
      const p = installProgress(line, seen);
      if (!p) return;
      said = p;
      if (Date.now() - last < 700) return;
      last = Date.now();
      show(p);
    };
    // a package manager that has gone quiet (a mirror that stopped answering, a lock): the card says for how long
    const beat = setInterval(() => {
      const quiet = Date.now() - heard;
      if (quiet < QUIET_MS || run.stopped) return;
      try {
        show(`${said || "Starting…"} · no word from the package manager for ${quietFor(quiet)}`);
      } catch {
        /* the card is gone */
      }
    }, BEAT_MS);
    try {
      const r = await execRaw(boardId, panelId, ["/bin/sh", "-c", INSTALL], {
        timeoutS: 1500,
        maxBytes: 64 * 1024,
        // packages go in as root, whoever the image's own user is
        user: "0",
        onStdout: (b) => {
          heard = Date.now();
          partial += b.toString("utf8");
          const lines = partial.split(/\r?\n/);
          partial = lines.pop() ?? "";
          lines.forEach(say);
        },
      }).finally(() => clearInterval(beat));
      if (run.stopped) throw new Error(STOPPED);
      if (r.exitCode !== 0) {
        const code = r.exitCode === null ? "no exit code" : `exit ${r.exitCode}`;
        const why =
          r.exitCode === 42 || r.exitCode === 43
            ? said
            : r.timedOut
              ? "The install was still going after 25 minutes and was stopped."
              : seen.noNetwork
                ? `The machine couldn't reach its package servers, so the desktop wasn't installed (${seen.noNetwork}). Check the machine's network from its terminal (${/apk|alpine/i.test(seen.noNetwork) ? "apk update" : "apt-get update"}), then try again.`
                : `The install failed (${code}): ${said || r.stderr.trim().split("\n").at(-1) || "the package manager said nothing"}`;
        throw new Error(why);
      }
      writeMachine(boardId, panelId, { desktop: { state: "installing", detail: "Starting the desktop…", by: person.name, at: Date.now() } });
      const size = await bringUp(boardId, panelId);
      writeMachine(boardId, panelId, { desktop: { state: "ready", by: person.name, at: Date.now(), ...size } }, { who: person.name, role: "human", text: `added a desktop to the machine ${panel.machine.name}` });
    } catch (e) {
      clearInterval(beat);
      const why = (e as Error).message;
      // the machine may have stopped or gone meanwhile: say so only if its card is still there
      try {
        // a person's Stop has already put the card back to "no desktop yet"
        if (!run.stopped) writeMachine(boardId, panelId, { desktop: { state: "error", detail: why.slice(0, 400), by: person.name, at: Date.now() } }, { who: person.name, role: "human", text: `couldn't add a desktop to ${panel.machine.name}: ${why.slice(0, 140)}` });
      } catch {
        /* the card is gone */
      }
      throw e;
    }
    return machinePanel(boardId, panelId).machine!;
  })().finally(() => {
    // a stopped install has already been let go (a press after the Stop starts a new one)
    if (installing.get(k) === done) installing.delete(k);
    if (running.get(k) === run) running.delete(k);
  });
  installing.set(k, done);
  done.catch(() => {});
  return { machine: machinePanel(boardId, panelId).machine!, done };
}

/**
 * A person pressed Stop on an install: end it in the machine (the package
 * manager and everything it started) and put the card back to "no desktop
 * yet". What was already unpacked stays on the machine's disk; Add a desktop
 * picks up from there. Also the way out of an "installing" this server knows
 * nothing about.
 */
export async function stopDesktopInstall(boardId: string, panelId: string, person: { id: string; name: string }): Promise<MachineState> {
  if (!canWrite(person.id, boardId)) throw new HttpError(403, `View only: someone who can edit “${boardId}” stops an install`);
  const panel = machinePanel(boardId, panelId);
  if (!panel.machine) throw new HttpError(404, "this card has no machine");
  if (panel.machine.desktop?.state !== "installing") return panel.machine;
  const run = running.get(key(boardId, panelId));
  if (run) run.stopped = true;
  // let go of it now: the engine takes a moment to notice its exec has ended, and a press meanwhile must start afresh
  installing.delete(key(boardId, panelId));
  running.delete(key(boardId, panelId));
  if (panel.machine.state === "running") await execRaw(boardId, panelId, ["/bin/sh", "-c", STOP_INSTALL], { timeoutS: 15, maxBytes: 4096, user: "0" }).catch(() => {});
  writeMachine(boardId, panelId, { desktop: undefined }, { who: person.name, role: "human", text: `stopped adding a desktop to ${panel.machine.name}` });
  return machinePanel(boardId, panelId).machine!;
}

const upAt = new Map<string, number>();
const bringing = new Map<string, Promise<{ w: number; h: number }>>();

async function bringUp(boardId: string, panelId: string): Promise<{ w: number; h: number }> {
  const k = key(boardId, panelId);
  const going = bringing.get(k);
  if (going) return going;
  const p = (async () => {
    const out = await execSh(boardId, panelId, UP, { timeoutS: 60 });
    const m = /(\d+)\s+(\d+)\s*$/.exec(out);
    upAt.set(k, Date.now());
    return m ? { w: Number(m[1]), h: Number(m[2]) } : { ...DESKTOP_SCREEN };
  })().finally(() => bringing.delete(k));
  bringing.set(k, p);
  return p;
}

/** the desktop of a running machine that has one, up and answering (checked at most every 10 s) */
async function ensureUp(boardId: string, panelId: string): Promise<PanelDoc & { machine: MachineState }> {
  const panel = runningCard(boardId, panelId);
  const d = panel.machine.desktop;
  if (!d || d.state !== "ready") {
    throw new HttpError(409, d?.state === "installing" ? `${panel.machine.name}'s desktop is still being installed` : `${panel.machine.name} has no desktop. A person adds one on the machine's card (Desktop, then Add a desktop).`);
  }
  if (Date.now() - (upAt.get(key(boardId, panelId)) ?? 0) > 10_000) await bringUp(boardId, panelId);
  return panel;
}

// a person's Start that asked for a desktop: add it once the machine runs (Start's route took them as a person who can edit)
machineHooks.started.push((boardId, panelId, person) => {
  const m = machinePanel(boardId, panelId).machine;
  if (!m?.wantDesktop || m.desktop) return;
  install(boardId, panelId, { name: person });
});

machineHooks.ended.push((boardId, panelId, why) => {
  const k = key(boardId, panelId);
  upAt.delete(k);
  // Remove takes the disk and the desktop on it, and with them agents' leave to use it
  if (why === "removed" && Object.keys(desktopLeave(boardId, panelId)).length) writeDesktopLeave(boardId, panelId, { agentsMay: undefined, agentAsked: undefined });
  for (const r of relays.get(k) ?? []) r.end("The machine stopped.");
});

/**
 * A board that loads showing a desktop as still installing, with no install
 * running in this server (it restarted mid-install): say so, so the button
 * comes back. Called when a card is seen.
 */
machineHooks.seen.push((boardId, panelId) => {
  const m = machinePanel(boardId, panelId).machine;
  if (m?.desktop?.state === "installing" && !installing.has(key(boardId, panelId)) && Date.now() - (m.desktop.at ?? 0) > 15_000) {
    writeMachine(boardId, panelId, { desktop: { state: "error", detail: "The install was interrupted (Foundation restarted). Add a desktop picks up where it left off.", by: m.desktop.by, at: Date.now() } });
  }
});

// ---------- seeing it: VNC, relayed ----------

interface Relay {
  ws: WebSocket;
  sock?: Socket;
  end(why: string): void;
}
const relays = new Map<string, Set<Relay>>();

/**
 * A browser opened a machine's desktop. People who can edit get the pointer
 * and keys; viewers get the view-only VNC. The socket carries RFB bytes and
 * nothing else (noVNC reads every frame as RFB), so a refusal is the close
 * reason.
 */
export async function attachDesktop(boardId: string, panelId: string, ws: WebSocket, _who: { name: string }, canType: boolean) {
  const k = key(boardId, panelId);
  const early: Buffer[] = [];
  let relay: Relay | null = null;
  let closed = false;
  ws.on("message", (data, isBinary) => {
    if (!isBinary) return;
    if (relay?.sock) relay.sock.write(data as Buffer);
    else early.push(data as Buffer);
  });
  ws.on("close", () => {
    closed = true;
    relay?.sock?.destroy();
    if (relay) relays.get(k)?.delete(relay);
  });
  const refuse = (why: string) => {
    if (ws.readyState === ws.OPEN) ws.close(4004, why.slice(0, 120));
  };
  try {
    const panel = await ensureUp(boardId, panelId);
    if (closed) return;
    const found = await findContainer(boardId, panelId, panel.machine.engine);
    if (!found || found.c.State !== "running") return refuse("The machine isn't running.");
    const exec = await engineJson<{ Id: string }>(found.engine, "POST", `/containers/${found.c.Id}/exec`, {
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Cmd: ["socat", "-", `TCP:127.0.0.1:${canType ? VNC_PORT : VNC_VIEW_PORT}`],
    });
    const { sock, head, type } = await hijack(found.engine, `/exec/${exec.Id}/start`, { Detach: false, Tty: false });
    if (closed) return void sock.destroy();
    const r: Relay = {
      ws,
      sock,
      end: (why) => {
        sock.destroy();
        refuse(why);
      },
    };
    relay = r;
    if (!relays.has(k)) relays.set(k, new Set());
    relays.get(k)!.add(r);
    const out = demux(type, (b) => {
      if (ws.readyState === ws.OPEN) ws.send(b, { binary: true });
    });
    out(head);
    sock.on("data", out);
    sock.on("close", () => {
      relays.get(k)?.delete(r);
      refuse("The desktop's connection ended.");
    });
    sock.on("error", () => sock.destroy());
    for (const b of early) sock.write(b);
    early.length = 0;
  } catch (e) {
    refuse((e as Error).message);
  }
}

/** for tests and shutdown */
export function closeDesktops() {
  for (const set of relays.values()) for (const r of set) r.sock?.destroy();
  relays.clear();
  upAt.clear();
}

// ---------- agents: leave to use it ----------

/** agents' leave for this machine's desktop: the board's `desktopLeave` map, which only the server writes (boards.ts SERVER_MAPS) */
export function desktopLeave(boardId: string, panelId: string): DesktopLeave {
  return desktopLeaveOf(getBoard(boardId).doc, panelId);
}

/** change that leave (undefined clears a field; nothing left clears the entry), with an activity line on the card */
export function writeDesktopLeave(boardId: string, panelId: string, patch: Partial<DesktopLeave>, activity?: { who: string; role: "human" | "agent"; text: string; for?: string }) {
  editBoard(boardId, "desktop-leave", (doc) => {
    const m = boardMaps(doc);
    const next: DesktopLeave = { ...desktopLeaveOf(doc, panelId), ...patch };
    for (const k of Object.keys(next) as Array<keyof DesktopLeave>) if (next[k] === undefined) delete next[k];
    if (Object.keys(next).length) m.desktopLeave.set(panelId, next);
    else m.desktopLeave.delete(panelId);
    if (activity) logActivity(doc, { ...activity, objectId: panelId });
  });
}

/**
 * A person lets agents use this machine's desktop, or takes that back. Only
 * from their browser (the route asks requirePerson) on a board they can edit;
 * a person who set computer use to "never" can't grant it.
 */
export function setAgentsMay(boardId: string, panelId: string, person: { id: string; name: string }, allow: boolean): MachineState {
  if (!canWrite(person.id, boardId)) throw new HttpError(403, `View only: someone who can edit “${boardId}” decides whether agents use this desktop`);
  const panel = machinePanel(boardId, panelId);
  if (!panel.machine) throw new HttpError(404, "this card has no machine");
  const name = panel.machine.name;
  if (!allow) {
    if (desktopLeave(boardId, panelId).agentsMay) writeDesktopLeave(boardId, panelId, { agentsMay: undefined, agentAsked: undefined }, { who: person.name, role: "human", text: `stopped agents using ${name}'s desktop` });
    return machinePanel(boardId, panelId).machine!;
  }
  if (computerUseDefault(person.id) === "never") {
    throw new HttpError(403, "You've set agents' computer use to Never (Settings), so this stays off. Change that first if you mean to let them.");
  }
  if (panel.machine.desktop?.state !== "ready") throw new HttpError(409, `${name} has no desktop for agents to use yet. Add a desktop first.`);
  writeDesktopLeave(boardId, panelId, { agentsMay: { by: person.name, at: Date.now() }, agentAsked: undefined }, { who: person.name, role: "human", text: `let agents use ${name}'s desktop` });
  return machinePanel(boardId, panelId).machine!;
}

// ---------- agents: using it ----------

export type DesktopAction =
  | { kind: "screenshot" }
  | { kind: "mouse"; action: "move" | "click" | "double_click" | "right_click" | "middle_click" | "drag" | "scroll_up" | "scroll_down"; x: number; y: number; to_x?: number; to_y?: number; amount?: number }
  | { kind: "type"; text: string }
  | { kind: "key"; keys: string[] };

export interface DesktopCtx {
  boardId: string;
  actor: string;
  userId: string;
  crew?: string;
  /** the person the agent works for, for the activity line */
  forName?: string;
}

export interface DesktopResult {
  machine: string;
  did: string;
  screen: { w: number; h: number };
  /** the screen after the action, as a PNG (absent when look is false) */
  png?: Buffer;
}

/** names people and models say, as X keysyms */
const KEYSYM: Record<string, string> = {
  enter: "Return",
  return: "Return",
  esc: "Escape",
  escape: "Escape",
  backspace: "BackSpace",
  tab: "Tab",
  space: "space",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "Prior",
  pagedown: "Next",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  shift: "shift",
  super: "super",
  cmd: "super",
  win: "super",
  meta: "super",
};

/** "Ctrl+Shift+T" → "ctrl+shift+t"; throws on anything that isn't keys joined by + */
export function keyChord(spec: string): string {
  const parts = spec.trim().split("+").map((p) => p.trim());
  if (!parts.length || parts.some((p) => !/^[A-Za-z0-9_]{1,24}$/.test(p))) throw new Error(`“${spec}” isn't a key: write keys joined by +, like ctrl+c, alt+F4, Return, Escape, a`);
  return parts.map((p) => KEYSYM[p.toLowerCase()] ?? (p.length === 1 ? p : /^f\d{1,2}$/i.test(p) ? p.toUpperCase() : p)).join("+");
}

/** pairs of (t, text to type) and (k, key to press), in order */
const TYPE_SH = 'while [ $# -gt 1 ]; do if [ "$1" = k ]; then xdotool key --clearmodifiers "$2"; else xdotool type --clearmodifiers --delay 12 -- "$2"; fi; shift 2; done';

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** the xdotool arguments for an action, and what to say it did */
export function desktopCommand(a: DesktopAction, screen = DESKTOP_SCREEN): { argv: string[] | null; did: string } {
  const pt = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= screen.w || y >= screen.h) throw new Error(`(${x}, ${y}) is off the screen, which is ${screen.w}×${screen.h}: x 0–${screen.w - 1}, y 0–${screen.h - 1}`);
    return [String(Math.round(x)), String(Math.round(y))];
  };
  if (a.kind === "screenshot") return { argv: null, did: "looked at the screen" };
  if (a.kind === "type") {
    if (!a.text) throw new Error("say the text to type");
    // Enter and Tab go as keys: xdotool's `type` sends a newline as a character, which a field doesn't take as Enter
    // (tried on XFCE 2026-11-15: "/foundation\n" in the file manager's location bar went nowhere; the key did)
    const parts = a.text.replace(/\r\n?/g, "\n").split(/(\n|\t)/).filter(Boolean).flatMap((p) => (p === "\n" ? ["k", "Return"] : p === "\t" ? ["k", "Tab"] : ["t", p]));
    return { argv: ["/bin/sh", "-c", TYPE_SH, "foundation", ...parts], did: `typed “${short(a.text.replace(/\s+/g, " ").trim(), 48)}”` };
  }
  if (a.kind === "key") {
    if (!a.keys.length) throw new Error("say the keys to press");
    const chords = a.keys.map(keyChord);
    return { argv: ["xdotool", "key", "--clearmodifiers", "--delay", "40", "--", ...chords], did: `pressed ${chords.join(", ")}` };
  }
  const at = pt(a.x, a.y);
  const where = `(${at[0]}, ${at[1]})`;
  switch (a.action) {
    case "move":
      return { argv: ["xdotool", "mousemove", ...at], did: `moved the pointer to ${where}` };
    case "click":
      return { argv: ["xdotool", "mousemove", ...at, "click", "1"], did: `clicked ${where}` };
    case "double_click":
      return { argv: ["xdotool", "mousemove", ...at, "click", "--repeat", "2", "--delay", "90", "1"], did: `double-clicked ${where}` };
    case "right_click":
      return { argv: ["xdotool", "mousemove", ...at, "click", "3"], did: `right-clicked ${where}` };
    case "middle_click":
      return { argv: ["xdotool", "mousemove", ...at, "click", "2"], did: `middle-clicked ${where}` };
    case "scroll_up":
    case "scroll_down": {
      const n = Math.max(1, Math.min(30, Math.round(a.amount ?? 3)));
      return { argv: ["xdotool", "mousemove", ...at, "click", "--repeat", String(n), "--delay", "30", a.action === "scroll_up" ? "4" : "5"], did: `scrolled ${a.action === "scroll_up" ? "up" : "down"} at ${where}` };
    }
    case "drag": {
      if (a.to_x === undefined || a.to_y === undefined) throw new Error("a drag needs to_x and to_y");
      const to = pt(a.to_x, a.to_y);
      return { argv: ["xdotool", "mousemove", ...at, "mousedown", "1", "sleep", "0.15", "mousemove", ...to, "sleep", "0.15", "mouseup", "1"], did: `dragged ${where} to (${to[0]}, ${to[1]})` };
    }
  }
}

const turn = new Map<string, Promise<unknown>>();
const KEEP_ACTS = 5;

/** a PNG's size, from its header */
export function pngSize(b: Buffer): { w: number; h: number } | null {
  return b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : null;
}

/**
 * An agent looks at, or acts on, a machine's desktop. Refused unless a person
 * let agents use it. One action at a time per machine.
 */
export function useDesktop(ctx: DesktopCtx, machineRef: string, action: DesktopAction, opts: { look?: boolean } = {}): Promise<DesktopResult> {
  const card = findMachineCard(ctx.boardId, machineRef);
  if (!card || !card.machine) throw new Error(`no machine called “${machineRef}” on this board (machines lists them)`);
  const m = card.machine;
  const forLine = ctx.forName ? { for: ctx.forName } : {};
  if (ctx.userId !== "agent" && computerUseDefault(ctx.userId) === "never") {
    throw new Error(`${ctx.forName ?? "This person"} has agents' computer use set to Never (Settings), so agents don't use desktops for them.`);
  }
  if (m.state !== "running") throw new Error(`${m.name} isn't running (${m.state}). A person starts it from its card.`);
  if (m.desktop?.state !== "ready") throw new Error(`${m.name} has no desktop${m.desktop?.state === "installing" ? " yet: it's being installed" : ""}. A person adds one on the machine's card (Desktop, then Add a desktop).`);
  const leave = desktopLeave(ctx.boardId, card.id);
  if (!leave.agentsMay) {
    // say so on the card, where the person's button is (once a minute at most)
    if (!leave.agentAsked || leave.agentAsked.by !== ctx.actor || Date.now() - leave.agentAsked.at > 60_000) {
      writeDesktopLeave(ctx.boardId, card.id, { agentAsked: { by: ctx.actor, ...forLine, at: Date.now() } }, { who: ctx.actor, role: "agent", text: `asked to use ${m.name}'s desktop`, ...forLine });
    }
    const member = crewMember(ctx.crew);
    if (member) aim(member, { id: card.id, kind: "object" }, `waiting for leave to use ${m.name}'s desktop`);
    throw new Error(`A person hasn't let agents use ${m.name}'s desktop. It's on the card now: ask them to press “Let agents use this desktop” there, then try again. Nothing was done.`);
  }
  const { argv, did } = desktopCommand(action, { w: m.desktop.w ?? DESKTOP_SCREEN.w, h: m.desktop.h ?? DESKTOP_SCREEN.h });
  const k = key(ctx.boardId, card.id);
  const run = async (): Promise<DesktopResult> => {
    await ensureUp(ctx.boardId, card.id);
    // the leave may have been taken back while this waited its turn
    if (!desktopLeave(ctx.boardId, card.id).agentsMay) throw new Error(`Agents' leave to use ${m.name}'s desktop was taken back. Nothing was done.`);
    const member = crewMember(ctx.crew);
    if (member) aim(member, { id: card.id, kind: "object" }, `${m.name}'s desktop: ${did}`);
    if (argv) {
      const r = await execRaw(ctx.boardId, card.id, argv, { env: ENV, timeoutS: 30, maxBytes: 4096 });
      if (r.exitCode !== 0) throw new Error(`the desktop didn't take it (${r.timedOut ? "it took too long" : r.stderr.trim().split("\n").at(-1) || `exit ${r.exitCode}`})`);
    }
    const act: MachineAgentAct = { by: ctx.actor, ...forLine, did, at: Date.now() };
    const prev = machinePanel(ctx.boardId, card.id).machine?.agentActs ?? [];
    writeMachine(ctx.boardId, card.id, { agentActs: [...prev, act].slice(-KEEP_ACTS) }, { who: ctx.actor, role: "agent", text: `${did} on ${m.name}'s desktop`, ...forLine });
    if (desktopLeave(ctx.boardId, card.id).agentAsked) writeDesktopLeave(ctx.boardId, card.id, { agentAsked: undefined });
    let png: Buffer | undefined;
    let screen = { w: m.desktop!.w ?? DESKTOP_SCREEN.w, h: m.desktop!.h ?? DESKTOP_SCREEN.h };
    if (opts.look !== false || !argv) {
      if (argv) await new Promise((r) => setTimeout(r, 350)); // let the screen answer
      const shot = await execRaw(ctx.boardId, card.id, ["/bin/sh", "-c", `mkdir -p ${DIR} && { scrot -o -p ${DIR}/shot.png 2>/dev/null || scrot -o ${DIR}/shot.png; } && cat ${DIR}/shot.png`], { env: ENV, timeoutS: 20, maxBytes: 12 * 1024 * 1024 });
      const size = pngSize(shot.stdout);
      if (shot.exitCode !== 0 || !size) throw new Error(`${did}, but the screen couldn't be read (${shot.stderr.trim().split("\n").at(-1) || "no picture came back"})`);
      png = shot.stdout;
      screen = size;
    }
    return { machine: m.name, did, screen, ...(png ? { png } : {}) };
  };
  const next = (turn.get(k) ?? Promise.resolve()).catch(() => {}).then(run);
  turn.set(k, next);
  void next.catch(() => {}).finally(() => turn.get(k) === next && turn.delete(k));
  return next;
}

/** who is using the desktop now, if an agent acted within the last few seconds */
export function drivingNow(m: MachineState | undefined, now = Date.now()): MachineAgentAct | null {
  const last = m?.agentActs?.at(-1);
  return last && now - last.at < MACHINE_AGENT_ACTIVE_MS ? last : null;
}
