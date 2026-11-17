/**
 * A machine's desktop, agents using it, and its pipes (2026-11-15), against a
 * stand-in Engine API on a named pipe (Windows) or unix socket. The stand-in
 * plays the machine too: it "installs" a desktop, answers VNC with an RFB
 * greeting, records what xdotool was asked to do, hands back a PNG for a
 * screenshot, and keeps the two pipe files.
 *
 * Invariants checked: adding a desktop needs a person who can edit (a viewer
 * is refused; the routes ask requirePerson, so a bearer never gets here);
 * agents can't look at or touch a desktop until a person lets them, per
 * machine, and not after the leave is taken back; a viewer can't give it, and
 * neither can someone whose preference is "never"; a viewer's desktop socket
 * is the view-only one; every agent action is on the card and in the board's
 * activity under the agent's name; a viewer's agent can't use the tools;
 * what is wired to `in` is written to /foundation/in when it changes and what
 * the machine writes to /foundation/out reaches `out`, a note and a table;
 * Remove clears the desktop, the leave and the pipes.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-desk-"));
process.env.FOUNDATION_ADMIN_EMAILS = "";
process.env.FOUNDATION_CREW_TRAVEL_MS = "0";
process.env.FOUNDATION_MACHINE_IO_MS = "3600000"; // the pipes are ticked by hand here
process.env.FOUNDATION_DESKTOP_QUIET_MS = "80"; // an install that says nothing for 80 ms has gone quiet

// ---------- a stand-in Engine API, and the machine behind it ----------

interface Box {
  Id: string;
  Name: string;
  Image: string;
  State: string;
  Labels: Record<string, string>;
  desktop: boolean;
  files: Map<string, Buffer>;
  /** an install that hangs (a mirror that never answers): called to end it */
  hung?: () => void;
}
const engine = {
  boxes: new Map<string, Box>(),
  execs: new Map<string, { box: Box; body: { Tty?: boolean; AttachStdin?: boolean; Cmd?: string[]; User?: string }; exitCode: number | null }>(),
  /** the user each install's exec asked to run as */
  installUsers: [] as Array<string | undefined>,
  stops: 0,
  seq: 0,
  /** what xdotool was asked to do, in order */
  xdo: [] as string[][],
  /** which VNC port each desktop socket reached */
  vnc: [] as string[],
  installs: 0,
  shots: 0,
};

/** a 1280×800 PNG's first bytes: enough for a header to be read */
function png(w = 1280, h = 800) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

/** what a program run without a terminal does in the stand-in machine */
function run(box: Box, argv: string[]): { out: Array<[1 | 2, Buffer | string]>; code: number; hang?: boolean } {
  const script = argv[0] === "/bin/sh" && argv[1] === "-c" ? argv[2] : "";
  const args = argv.slice(4);
  if (argv[0] === "xdotool") {
    engine.xdo.push(argv.slice(1));
    return { out: [], code: 0 };
  }
  // typing: text and keys in order (t, text / k, key), one xdotool call each
  if (script.includes("xdotool type")) {
    engine.xdo.push(["typed", ...args]);
    return { out: [], code: 0 };
  }
  if (script.includes("Reading the package lists")) {
    engine.installs++;
    if (/^fedora/.test(box.Image)) return { out: [[1, "No recipe: Fedora Linux 42 (Container Image) has neither apt nor apk, and Foundation's desktop installs only on Ubuntu, Debian and Alpine machines. Nothing was changed.\n"]], code: 42 };
    // an engine that ignores the user an exec asks for, on an image whose own user isn't root
    if (/rootless/.test(box.Name)) return { out: [[1, "Not root: this machine runs its programs as app, and installing a desktop needs root. Nothing was changed.\n"]], code: 43 };
    // apt with no DNS, in Ubuntu 24.04's words on Kiri (2026-11-17)
    if (/nonet/.test(box.Name)) {
      return {
        out: [[1, "Reading the package lists\nIgn:1 http://archive.ubuntu.com/ubuntu noble InRelease\nErr:1 http://archive.ubuntu.com/ubuntu noble InRelease\n  Temporary failure resolving 'archive.ubuntu.com'\nReading package lists...\nW: Failed to fetch http://archive.ubuntu.com/ubuntu/dists/noble/InRelease  Temporary failure resolving 'archive.ubuntu.com'\nE: Unable to locate package xvfb\n"]],
        code: 100,
      };
    }
    // a mirror that never answers: one line, then nothing, until something ends it
    if (/stuck/.test(box.Name) && !box.files.has("unstuck")) return { out: [[1, "Reading the package lists\n"]], code: 137, hang: true };
    box.desktop = true;
    return {
      out: [[1, "Reading the package lists\nGet:1 http://archive.ubuntu.com/ubuntu noble/main amd64 xvfb amd64 2:21.1 [877 kB]\n0 upgraded, 3 newly installed, 0 to remove\nUnpacking xvfb (2:21.1) ...\nSetting up xvfb (2:21.1) ...\nSetting up x11vnc (0.9.16) ...\nSetting up xfwm4 (4.18) ...\nInstalled\n"]],
      code: 0,
    };
  }
  // a person's Stop: the install's tree is killed
  if (script.includes("kill -KILL") && script.includes("install.pid")) {
    engine.stops++;
    const was = Boolean(box.hung);
    box.hung?.();
    box.hung = undefined;
    return { out: was ? [[1, "Stopped an install that was still going\n"]] : [], code: 0 };
  }
  if (script.includes("getdisplaygeometry") && script.includes("Xvfb")) {
    return box.desktop ? { out: [[1, "1280 800\n"]], code: 0 } : { out: [[2, "no desktop is installed in this machine (Xvfb is missing)\n"]], code: 3 };
  }
  if (script.includes("scrot")) {
    engine.shots++;
    return { out: [[1, png()]], code: 0 };
  }
  if (script.includes("base64 -d")) {
    box.files.set("/foundation/in", Buffer.from(args[0] ?? "", "base64"));
    return { out: [], code: 0 };
  }
  if (script.includes("cksum")) {
    const f = box.files.get("/foundation/out");
    if (!f) return { out: [], code: 0 };
    const sig = `${f.length}.${[...f].reduce((a, c) => (a * 31 + c) >>> 0, 7)}`;
    return { out: [[1, `${sig}\n`], ...(sig === args[0] ? [] : ([[1, f]] as Array<[1, Buffer]>))], code: 0 };
  }
  return { out: [[2, `sh: ${argv[0]}: not found\n`]], code: 127 };
}

const findBox = (ref: string) => engine.boxes.get(ref) ?? [...engine.boxes.values()].find((b) => b.Name === ref);

const fake = createServer(async (req, res) => {
  const u = new URL(req.url ?? "/", "http://docker");
  const path = u.pathname;
  const body = await new Promise<Buffer>((ok) => {
    const c: Buffer[] = [];
    req.on("data", (d) => c.push(d));
    req.on("end", () => ok(Buffer.concat(c)));
  });
  const json = (v: unknown, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(v));
  };
  const err = (status: number, message: string) => json({ message }, status);
  let m: RegExpExecArray | null;
  if (req.method === "GET" && path === "/version") return json({ Version: "0.9.0", ApiVersion: "1.47", Os: "linux", Platform: { Name: "Kiri" } });
  if (req.method === "GET" && /^\/images\/.+\/json$/.test(path)) return json({ Id: "sha256:x" });
  if (req.method === "GET" && path === "/containers/json") {
    const f = JSON.parse(u.searchParams.get("filters") ?? "{}") as { label?: string[] };
    const rows = [...engine.boxes.values()].filter((b) => (f.label ?? []).every((l) => b.Labels[l.split("=")[0]] === l.split("=")[1]));
    return json(rows.map((b) => ({ Id: b.Id, Names: [`/${b.Name}`], Image: b.Image, State: b.State, Status: "Up", Labels: b.Labels, Ports: [] })));
  }
  if (req.method === "POST" && path === "/containers/create") {
    const b = JSON.parse(body.toString()) as { Image: string; Labels?: Record<string, string> };
    const Id = randomBytes(32).toString("hex");
    engine.boxes.set(Id, { Id, Name: u.searchParams.get("name")!, Image: b.Image, State: "created", Labels: b.Labels ?? {}, desktop: false, files: new Map() });
    return json({ Id }, 201);
  }
  if ((m = /^\/containers\/([^/]+)\/(start|stop|restart|json)$/.exec(path))) {
    const b = findBox(decodeURIComponent(m[1]));
    if (!b) return err(404, "No such container");
    if (m[2] === "json") return json({ Id: b.Id });
    b.State = m[2] === "stop" ? "exited" : "running";
    return res.writeHead(204).end();
  }
  if (req.method === "DELETE" && (m = /^\/containers\/([^/]+)$/.exec(path))) {
    const b = findBox(m[1]);
    if (!b) return err(404, "No such container");
    engine.boxes.delete(b.Id);
    return res.writeHead(204).end();
  }
  if (req.method === "POST" && (m = /^\/containers\/([^/]+)\/exec$/.exec(path))) {
    const b = findBox(m[1]);
    if (!b || b.State !== "running") return err(409, "container is not running");
    const Id = `exec-${++engine.seq}`;
    engine.execs.set(Id, { box: b, body: JSON.parse(body.toString()), exitCode: null });
    return json({ Id }, 201);
  }
  if (req.method === "GET" && (m = /^\/exec\/([^/]+)\/json$/.exec(path))) {
    const x = engine.execs.get(m[1]);
    return x ? json({ ID: m[1], Running: x.exitCode === null, ExitCode: x.exitCode ?? 0 }) : err(404, "No such exec instance");
  }
  return err(404, `stand-in engine has no ${req.method} ${path}`);
});
const frame = (stream: number, data: Buffer) => {
  const h = Buffer.alloc(8);
  h[0] = stream;
  h.writeUInt32BE(data.length, 4);
  return Buffer.concat([h, data]);
};
fake.on("upgrade", (req: IncomingMessage, sock: Socket) => {
  const x = engine.execs.get(/^\/exec\/([^/]+)\/start/.exec(req.url ?? "")?.[1] ?? "");
  // Kiri's way: it calls the stream raw and frames it all the same
  sock.write("HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n");
  if (!x) return sock.end();
  const cmd = x.body.Cmd ?? [];
  if (cmd[0] === "socat") {
    // VNC: the server speaks first; then every byte the client sends comes back, so the relay is seen both ways
    engine.vnc.push(cmd[2]);
    sock.write(frame(1, Buffer.from("RFB 003.008\n")));
    sock.on("data", (d: Buffer) => sock.write(frame(1, Buffer.concat([Buffer.from("got:"), d]))));
    sock.on("error", () => {});
    return;
  }
  // execRaw's wrapper: sh -c '<timeout…>' <secs> argv…
  if ((cmd[6] ?? "").includes("Reading the package lists")) engine.installUsers.push(x.body.User);
  const r = run(x.box, cmd.slice(4));
  for (const [stream, data] of r.out) {
    const f = frame(stream, Buffer.isBuffer(data) ? data : Buffer.from(data));
    // a frame split across writes, the way a socket can deliver it
    sock.write(f.subarray(0, 5));
    sock.write(f.subarray(5));
  }
  if (r.hang) {
    // still running, saying nothing, until it is killed
    sock.on("error", () => {});
    x.box.hung = () => {
      x.exitCode = r.code;
      sock.end();
    };
    return;
  }
  x.exitCode = r.code;
  sock.end();
});

const pipe = process.platform === "win32" ? `\\\\.\\pipe\\foundation-engine-${randomBytes(4).toString("hex")}` : join(mkdtempSync(join(tmpdir(), "fe-")), "docker.sock");
await new Promise<void>((ok) => fake.listen(pipe, ok));
process.env.FOUNDATION_ENGINES = `kiri=${pipe}`;

const { upsertUser, createSession, requirePerson } = await import("../src/auth.ts");
const { setBoardRole } = await import("../src/roles.ts");
const { runTool, toolContent, TOOLS } = await import("../src/tools.ts");
const { editBoard, getBoard, closeBoards } = await import("../src/boards.ts");
const { boardMaps, appendSection, noteTextOf, tableCellsOf, cellRef } = await import("@foundation/protocol");
type PanelDoc = import("@foundation/protocol").PanelDoc;
const machines = await import("../src/machines.ts");
const desk = await import("../src/machinedesktop.ts");
const mio = await import("../src/machineio.ts");
const prefs = await import("../src/prefs.ts");
const { joinCrew, leaveCrew } = await import("../src/crew.ts");

after(async () => {
  mio.stopMachineIo();
  desk.closeDesktops();
  machines.closeTerminals();
  closeBoards();
  await new Promise((ok) => fake.close(ok));
});

const ada = upsertUser("ada@formindustries.com", "Ada");
const vic = upsertUser("vic@formindustries.com", "Vic");
const noa = upsertUser("noa@formindustries.com", "Noa");
const BOARD = "deskb";
editBoard(BOARD, "test", (doc) => appendSection(doc, "Machines"));
setBoardRole({ ...ada, role: "admin" }, BOARD, vic.id, "viewer");

const panelOf = (id: string) => {
  const o = boardMaps(getBoard(BOARD).doc).objects.get(id);
  assert.ok(o && o.kind === "panel");
  return o as PanelDoc;
};
const activity = () => boardMaps(getBoard(BOARD).doc).activity.toArray();
const fakeReq = (headers: Record<string, string>) => ({ headers, query: new URLSearchParams() }) as never;
const agentCtx = { boardId: BOARD, actor: "Ada's agent", userId: ada.id };

async function machine(name: string, image = "ubuntu") {
  const out = (await runTool({ boardId: BOARD, actor: "Ada", userId: ada.id, person: true }, "propose_machine", { name, image })) as { card: string };
  await machines.startMachine(BOARD, out.card, "Ada");
  return out.card;
}
const boxOf = (card: string) => [...engine.boxes.values()].find((b) => b.Labels["dev.foundation.panel"] === card)!;

let box = "";

test("raw exec: bytes come back whole, stdout apart from stderr, with the exit code", async () => {
  box = await machine("Desk box");
  const r = await machines.execRaw(BOARD, box, ["/bin/sh", "-c", "scrot -o x.png && cat x.png"]);
  assert.equal(r.exitCode, 0);
  assert.deepEqual(desk.pngSize(r.stdout), { w: 1280, h: 800 });
  const bad = await machines.execRaw(BOARD, box, ["nope"]);
  assert.equal(bad.exitCode, 127);
  assert.equal(bad.stdout.length, 0);
  assert.match(bad.stderr, /not found/);
  await assert.rejects(() => machines.execSh(BOARD, box, "nope"), /not found/);
});

test("a desktop is added by a person who can edit; the card shows the package manager's progress, then ready", async () => {
  // the routes ask for a person at a browser: a bearer (an agent, MCP, the service token) never reaches addDesktop
  const token = createSession(ada.id);
  assert.throws(() => requirePerson(fakeReq({ authorization: `Bearer ${token}` }), "Adding a desktop to a machine"), /needs a person/);
  assert.throws(() => requirePerson(fakeReq({ authorization: `Bearer ${token}` }), "Letting agents use a desktop"), /needs a person/);
  // a viewer can't
  assert.throws(() => desk.addDesktop(BOARD, box, vic), /View only/);
  assert.equal(engine.installs, 0);
  assert.equal(panelOf(box).machine?.desktop, undefined);
  // agents can't use what isn't there
  await assert.rejects(() => runTool(agentCtx, "desktop_screenshot", { machine: "desk-box" }), /has no desktop.*A person adds one/);

  const seen: string[] = [];
  const doc = getBoard(BOARD).doc;
  const watch = () => {
    const d = panelOf(box).machine?.desktop;
    if (d) seen.push(`${d.state}: ${d.detail ?? ""}`);
  };
  doc.on("update", watch);
  const first = desk.addDesktop(BOARD, box, ada);
  assert.equal(first.machine.desktop?.state, "installing");
  const second = desk.addDesktop(BOARD, box, ada);
  assert.equal(await first.done, await second.done, "a second press joins the first install");
  doc.off("update", watch);
  assert.equal(engine.installs, 1);
  const d = panelOf(box).machine!.desktop!;
  assert.deepEqual([d.state, d.w, d.h, d.by], ["ready", 1280, 800, "Ada"]);
  assert.ok(seen.some((s) => /^installing: (Reading the package lists|Downloading xvfb|Setting up)/.test(s)), `progress in the package manager's words: ${seen.join(" | ")}`);
  assert.ok(activity().some((a) => a.who === "Ada" && a.role === "human" && a.text === "added a desktop to the machine desk-box"));
  // a line of apt's, a line of apk's, and noise
  const count = { done: 0 };
  assert.equal(desk.installProgress("0 upgraded, 245 newly installed, 0 to remove and 2 not upgraded.", count), null);
  assert.equal(desk.installProgress("Setting up xfwm4 (4.18.0-1build3) ...", count), "Setting up xfwm4 (1 of 245)");
  assert.equal(desk.installProgress("(12/180) Installing xfce4-panel (4.20.0-r0)", count), "Installing xfce4-panel (12 of 180)");
  assert.equal(desk.installProgress("debconf: delaying package configuration", count), null);
});

test("an image with no recipe says so; the card keeps the reason and the button", async () => {
  const fed = await machine("Fed box", "fedora");
  await assert.rejects(desk.addDesktop(BOARD, fed, ada).done, /neither apt nor apk/);
  const d = panelOf(fed).machine!.desktop!;
  assert.equal(d.state, "error");
  // by name, and what it does install on: the card's words are the whole reason
  assert.equal(d.detail, "No recipe: Fedora Linux 42 (Container Image) has neither apt nor apk, and Foundation's desktop installs only on Ubuntu, Debian and Alpine machines. Nothing was changed.");
  // a machine that isn't running can't take one
  await machines.stopMachine(BOARD, fed, "Ada");
  assert.throws(() => desk.addDesktop(BOARD, fed, ada), /isn't running/);
});

test("packages go in as root; where they can't, the card says the machine isn't root", async () => {
  // every install so far asked the engine for root, whatever the image's own user is
  assert.ok(engine.installUsers.length > 0);
  assert.ok(engine.installUsers.every((u) => u === "0"), `installs ran as ${JSON.stringify(engine.installUsers)}`);
  const card = await machine("Rootless box");
  await assert.rejects(desk.addDesktop(BOARD, card, ada).done, /Not root/);
  const d = panelOf(card).machine!.desktop!;
  assert.equal(d.state, "error");
  assert.equal(d.detail, "Not root: this machine runs its programs as app, and installing a desktop needs root. Nothing was changed.");
  await machines.removeMachine(BOARD, card, "Ada", true);
});

test("a machine that can't reach its package servers: the card says that, not the package it couldn't find", async () => {
  const card = await machine("Nonet box");
  await assert.rejects(desk.addDesktop(BOARD, card, ada).done, /couldn't reach its package servers/);
  const d = panelOf(card).machine!.desktop!;
  assert.equal(d.state, "error");
  assert.equal(d.detail, "The machine couldn't reach its package servers, so the desktop wasn't installed (Temporary failure resolving 'archive.ubuntu.com'). Check the machine's network from its terminal (apt-get update), then try again.");
  assert.doesNotMatch(d.detail ?? "", /Unable to locate package/);
  // apk's words for the same thing
  const seen: { done: number; noNetwork?: string } = { done: 0 };
  desk.installProgress("WARNING: fetching https://dl-cdn.alpinelinux.org/alpine/v3.22/main: temporary error (try again later)", seen);
  assert.match(seen.noNetwork ?? "", /temporary error/);
  await machines.removeMachine(BOARD, card, "Ada", true);
});

test("an install that goes quiet says for how long; a person stops it, and the next press starts afresh", async () => {
  const card = await machine("Stuck box");
  const first = desk.addDesktop(BOARD, card, ada);
  let failed = "";
  first.done.catch((e: Error) => (failed = e.message));
  // nothing from the package manager: the card says so, with what it last said
  for (let i = 0; i < 300 && !/no word from the package manager/.test(panelOf(card).machine?.desktop?.detail ?? ""); i++) await new Promise((r) => setTimeout(r, 10));
  const quiet = panelOf(card).machine!.desktop!;
  assert.equal(quiet.state, "installing");
  assert.match(quiet.detail ?? "", /^Reading the package lists · no word from the package manager for \d+ s$/);
  // a viewer can't stop it
  await assert.rejects(() => desk.stopDesktopInstall(BOARD, card, vic), /View only/);
  assert.equal(engine.stops, 0);
  // a person who can edit does: the install's processes are ended in the machine, and the card is back to no desktop
  await desk.stopDesktopInstall(BOARD, card, ada);
  assert.equal(engine.stops, 1);
  assert.equal(panelOf(card).machine?.desktop, undefined, "back to “no desktop yet”, not an error");
  assert.equal(activity().at(-1)!.text, "stopped adding a desktop to stuck-box");
  for (let i = 0; i < 300 && !failed; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(failed, "The install was stopped.");
  assert.equal(panelOf(card).machine?.desktop, undefined, "the stopped install wrote no error over the card");
  // Stop again is nothing; a press now is a new install (the mirror answers this time)
  await desk.stopDesktopInstall(BOARD, card, ada);
  assert.equal(engine.stops, 1);
  boxOf(card).files.set("unstuck", Buffer.alloc(0));
  const before = engine.installs;
  const again = await desk.addDesktop(BOARD, card, ada).done;
  assert.equal(engine.installs, before + 1);
  assert.equal(again.desktop?.state, "ready");
  await machines.removeMachine(BOARD, card, "Ada", true);
});

test("an install this server knows nothing about (it restarted): the card says so, and Stop clears it too", async () => {
  const card = await machine("Orphan box");
  machines.writeMachine(BOARD, card, { desktop: { state: "installing", detail: "Setting up xfwm4 (142 of 245)", by: "Ada", at: Date.now() - 60_000 } });
  await machines.machineSeen(BOARD, card);
  const d = panelOf(card).machine!.desktop!;
  assert.equal(d.state, "error");
  assert.match(d.detail ?? "", /interrupted \(Foundation restarted\)/);
  machines.writeMachine(BOARD, card, { desktop: { state: "installing", detail: "Setting up xfwm4 (142 of 245)", by: "Ada", at: Date.now() } });
  await desk.stopDesktopInstall(BOARD, card, ada);
  assert.equal(panelOf(card).machine?.desktop, undefined);
  await machines.removeMachine(BOARD, card, "Ada", true);
});

test("Start with a desktop: it is added once the machine runs", async () => {
  const out = (await runTool({ boardId: BOARD, actor: "Ada", userId: ada.id, person: true }, "propose_machine", { name: "With desk", image: "ubuntu" })) as { card: string };
  await machines.startMachine(BOARD, out.card, "Ada", { desktop: true });
  for (let i = 0; i < 200 && panelOf(out.card).machine?.desktop?.state !== "ready"; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(panelOf(out.card).machine?.desktop?.state, "ready");
  assert.equal(panelOf(out.card).machine?.wantDesktop, undefined);
  await machines.removeMachine(BOARD, out.card, "Ada", true);
});

test("the desktop's socket: people who can edit get the pointer and keys, viewers the view-only screen", async () => {
  const a = new FakeWs();
  await desk.attachDesktop(BOARD, box, a as never, { name: "Ada" }, true);
  await a.until(/RFB 003\.008\n/);
  a.key("\x01hello");
  await a.until(/got:\x01hello/);
  const v = new FakeWs();
  await desk.attachDesktop(BOARD, box, v as never, { name: "Vic" }, false);
  await v.until(/RFB 003\.008\n/);
  assert.deepEqual(engine.vnc.slice(-2), ["TCP:127.0.0.1:5900", "TCP:127.0.0.1:5901"], "a viewer reaches x11vnc -viewonly");
  // text frames are never relayed (noVNC reads every frame as RFB) and never sent
  a.emit("message", Buffer.from(JSON.stringify({ t: "resize" })), false);
  assert.ok(a.frames.every((f) => Buffer.isBuffer(f)));
  // a machine with no desktop refuses in words, as the close reason
  const none = await machine("Bare box");
  const n = new FakeWs();
  await desk.attachDesktop(BOARD, none, n as never, { name: "Ada" }, true);
  assert.equal(n.closed?.code, 4004);
  assert.match(n.closed?.reason ?? "", /has no desktop/);
  // stopping the machine ends the sockets
  await machines.stopMachine(BOARD, box, "Ada");
  assert.equal(a.closed?.code, 4004);
  assert.match(a.closed?.reason ?? "", /stopped/);
  await machines.startMachine(BOARD, box, "Ada");
});

test("agents use a desktop only with a person's leave: asked for on the card, given by a person who can edit, taken back", async () => {
  const before = engine.xdo.length + engine.shots;
  // no leave: nothing runs, the agent is told what to ask for, and the card says it asked
  await assert.rejects(() => runTool(agentCtx, "desktop_screenshot", { machine: "desk-box" }), /hasn't let agents use desk-box's desktop.*Nothing was done/s);
  await assert.rejects(() => runTool(agentCtx, "desktop_mouse", { machine: box, action: "click", x: 5, y: 5 }), /hasn't let agents use/);
  assert.equal(engine.xdo.length + engine.shots, before, "nothing reached the machine");
  assert.deepEqual([panelOf(box).machine?.agentAsked?.by, panelOf(box).machine?.agentAsked?.for], ["Ada's agent", "Ada"]);
  assert.equal(activity().filter((a) => a.text === "asked to use desk-box's desktop").length, 1, "said once, not per attempt");
  // a viewer can't give it; a viewer's agent can't even ask
  assert.throws(() => desk.setAgentsMay(BOARD, box, vic, true), /View only/);
  await assert.rejects(() => runTool({ boardId: BOARD, actor: "Vic's agent", userId: vic.id }, "desktop_screenshot", { machine: box }), /View only/);
  // a person whose preference is "never" can't give it either, and their agents don't use desktops
  assert.equal(prefs.computerUseDefault(noa.id), "ask", "the default: agents may ask, a person grants per machine");
  prefs.setPref(noa.id, "computer_use", "never");
  assert.equal(prefs.computerUseDefault(noa.id), "never");
  assert.throws(() => desk.setAgentsMay(BOARD, box, noa, true), /Never/);
  assert.equal(panelOf(box).machine?.agentsMay, undefined);
  // a person does
  const m = desk.setAgentsMay(BOARD, box, ada, true);
  assert.equal(m.agentsMay?.by, "Ada");
  assert.ok(Math.abs((m.agentsMay?.at ?? 0) - Date.now()) < 2000);
  assert.equal(m.agentAsked, undefined);
  assert.equal(activity().at(-1)!.text, "let agents use desk-box's desktop");
  await assert.rejects(() => runTool({ boardId: BOARD, actor: "Noa's agent", userId: noa.id }, "desktop_screenshot", { machine: box }), /set to Never/);

  // look: the screen comes back as a picture for the model
  const shot = (await runTool(agentCtx, "desktop_screenshot", { machine: "desk-box" })) as { did: string; screen: string; _image: { mime: string; base64: string } };
  assert.deepEqual([shot.did, shot.screen, shot._image.mime], ["looked at the screen", "1280x800", "image/png"]);
  assert.deepEqual(desk.pngSize(Buffer.from(shot._image.base64, "base64")), { w: 1280, h: 800 });
  const content = toolContent(shot);
  assert.equal(content.image?.mime, "image/png");
  assert.doesNotMatch(content.text, /base64|_image/, "the picture goes as a picture, not as text");
  assert.match(content.text, /"did": "looked at the screen"/);

  // act: each lands on the machine as xdotool, in order, and on the card and in the activity under the agent's name
  const from = engine.xdo.length;
  const clicked = (await runTool(agentCtx, "desktop_mouse", { machine: box, action: "click", x: 640, y: 400 })) as { did: string; _image?: object };
  assert.equal(clicked.did, "clicked (640, 400)");
  assert.ok(clicked._image, "the screen afterwards comes back too");
  const typed = (await runTool(agentCtx, "desktop_type", { machine: box, text: "echo hi; rm -rf \"$HOME\"\n", look: false })) as { did: string; _image?: object };
  assert.equal(typed._image, undefined);
  await runTool(agentCtx, "desktop_key", { machine: box, keys: ["Ctrl+Shift+T", "enter"], look: false });
  await runTool(agentCtx, "desktop_mouse", { machine: box, action: "drag", x: 10, y: 20, to_x: 300, to_y: 200, look: false });
  await runTool(agentCtx, "desktop_mouse", { machine: box, action: "scroll_down", x: 640, y: 400, amount: 5, look: false });
  assert.deepEqual(engine.xdo.slice(from), [
    ["mousemove", "640", "400", "click", "1"],
    ["typed", "t", "echo hi; rm -rf \"$HOME\"", "k", "Return"],
    ["key", "--clearmodifiers", "--delay", "40", "--", "ctrl+shift+T", "Return"],
    ["mousemove", "10", "20", "mousedown", "1", "sleep", "0.15", "mousemove", "300", "200", "sleep", "0.15", "mouseup", "1"],
    ["mousemove", "640", "400", "click", "--repeat", "5", "--delay", "30", "5"],
  ]);
  const acts = panelOf(box).machine!.agentActs!;
  assert.equal(acts.length, 5, "the last few are kept");
  assert.deepEqual([acts.at(-1)!.by, acts.at(-1)!.for, acts.at(-1)!.did], ["Ada's agent", "Ada", "scrolled down at (640, 400)"]);
  assert.ok(desk.drivingNow(panelOf(box).machine));
  assert.equal(desk.drivingNow(panelOf(box).machine, Date.now() + 60_000), null);
  const log = activity().filter((a) => / on desk-box's desktop$/.test(a.text));
  assert.deepEqual(log.map((a) => a.text.replace(" on desk-box's desktop", "")), ["looked at the screen", "clicked (640, 400)", "typed “echo hi; rm -rf \"$HOME\"”", "pressed ctrl+shift+T, Return", "dragged (10, 20) to (300, 200)", "scrolled down at (640, 400)"]);
  assert.ok(log.every((a) => a.who === "Ada's agent" && a.role === "agent" && a.for === "Ada" && a.objectId === box));

  // what can't be a pointer position or a key is refused before anything runs
  const n = engine.xdo.length;
  await assert.rejects(() => runTool(agentCtx, "desktop_mouse", { machine: box, action: "click", x: 1280, y: 10 }), /off the screen, which is 1280×800/);
  await assert.rejects(() => runTool(agentCtx, "desktop_key", { machine: box, keys: ["ctrl+c; reboot"] }), /isn't a key/);
  await assert.rejects(() => runTool(agentCtx, "desktop_mouse", { machine: box, action: "drag", x: 1, y: 1 }), /needs to_x and to_y/);
  assert.equal(engine.xdo.length, n);

  // a crew member: by its own name, its cursor on the card
  const member = joinCrew({ boardId: BOARD, userId: ada.id, userName: "Ada", runId: "run_d1", task: "open the file manager" });
  await runTool({ boardId: BOARD, actor: member.name, userId: ada.id, crew: member.id }, "desktop_mouse", { machine: "desk-box", action: "double_click", x: 69, y: 180, look: false });
  assert.deepEqual(member.state.crew.target, { id: box, kind: "object" });
  assert.match(member.state.crew.doing, /desk-box's desktop: double-clicked \(69, 180\)/);
  assert.deepEqual([activity().at(-1)!.who, activity().at(-1)!.for], [member.name, "Ada"]);
  leaveCrew(member, "done", 0);

  // taken back (by anyone who can edit): refused again, and it says so on the card once more
  assert.throws(() => desk.setAgentsMay(BOARD, box, vic, false), /View only/);
  desk.setAgentsMay(BOARD, box, ada, false);
  assert.equal(panelOf(box).machine?.agentsMay, undefined);
  assert.equal(activity().at(-1)!.text, "stopped agents using desk-box's desktop");
  const k = engine.xdo.length;
  await assert.rejects(() => runTool(agentCtx, "desktop_type", { machine: box, text: "x" }), /hasn't let agents use/);
  assert.equal(engine.xdo.length, k);
  // the tools are writes: none is in a viewer's set, all are offered to agents
  for (const name of ["desktop_screenshot", "desktop_mouse", "desktop_type", "desktop_key"]) assert.ok(TOOLS.find((t) => t.name === name)?.write, name);
});

test("keys and pointer actions, as xdotool is asked", () => {
  assert.equal(desk.keyChord("Ctrl+C"), "ctrl+C");
  assert.equal(desk.keyChord("alt+f4"), "alt+F4");
  assert.equal(desk.keyChord("PageDown"), "Next");
  assert.equal(desk.keyChord("cmd+space"), "super+space");
  assert.equal(desk.keyChord("a"), "a");
  assert.throws(() => desk.keyChord("ctrl+"), /isn't a key/);
  assert.throws(() => desk.keyChord("$(reboot)"), /isn't a key/);
  assert.deepEqual(desk.desktopCommand({ kind: "mouse", action: "right_click", x: 12.4, y: 7.6 }).argv, ["xdotool", "mousemove", "12", "8", "click", "3"]);
  assert.equal(desk.desktopCommand({ kind: "screenshot" }).argv, null);
  assert.throws(() => desk.desktopCommand({ kind: "mouse", action: "click", x: -1, y: 0 }), /off the screen/);
});

test("preferences: a person's own, named keys and values only", () => {
  assert.deepEqual(prefs.prefsOf(ada.id), { computer_use: "ask" });
  assert.deepEqual(prefs.setPref(ada.id, "computer_use", "never"), { computer_use: "never" });
  assert.deepEqual(prefs.setPref(ada.id, "computer_use", "ask"), { computer_use: "ask" });
  assert.throws(() => prefs.setPref(ada.id, "computer_use", "always"), /one of: ask, never/);
  assert.throws(() => prefs.setPref(ada.id, "theme", "dark"), /no preference called/);
  assert.equal(prefs.computerUseDefault("nobody"), "ask");
  // changing them is a person's, from their browser
  const token = createSession(ada.id);
  assert.throws(() => requirePerson(fakeReq({ authorization: `Bearer ${token}` }), "Changing your preferences"), /needs a person/);
});

test("pipes: what's wired to in is written to /foundation/in; what the machine writes to /foundation/out goes on", async () => {
  const person = { boardId: BOARD, actor: "Ada", userId: ada.id, person: true };
  const note = (await runTool(person, "add_note", { section: "Machines", title: "Input", markdown: "hello from a note" })) as { id: string };
  const result = (await runTool(person, "add_note", { section: "Machines", title: "Result", markdown: "(nothing yet)" })) as { id: string };
  const table = (await runTool(person, "add_table", { section: "Machines", name: "Rows", columns: ["a"], rows: [] })) as { id: string };
  // a machine card has its two ports as soon as it is wired (or seen running)
  const l1 = (await runTool(person, "connect", { from_panel: note.id, from_port: "text", to_panel: box, to_port: "in" })) as { from: { port: string }; to: { port: string } };
  const ports = panelOf(box).ports;
  assert.deepEqual(ports.map((p) => `${p.dir}:${p.name}`), ["in:in", "out:out"]);
  assert.deepEqual([l1.from.port, l1.to.port], ["text", ports[0].id]);
  await runTool(person, "connect", { from_panel: box, from_port: "out", to_panel: result.id, to_port: "text" });
  await runTool(person, "connect", { from_panel: box, from_port: "out", to_panel: table.id, to_port: "rows" });
  // a note can't be wired to an app: nothing would carry it
  const app = (await runTool(person, "add_panel", { section: "Machines", panel: "app", name: "Chart", url: "http://localhost:9", ports: [{ name: "data", dir: "in" }] })) as { id: string };
  await assert.rejects(() => runTool(person, "connect", { from_panel: note.id, from_port: "text", to_panel: app.id, to_port: "data" }), /can be wired to a machine's in or out/);
  await runTool(person, "connect", { from_panel: box, from_port: "out", to_panel: app.id, to_port: "data" });

  const files = boxOf(box).files;
  // wiring a machine starts the watch on its pipes (its first look is already under way); after that they're looked at by hand here
  const look = () => mio.lookNow(BOARD, box);
  await look();
  assert.equal(files.get("/foundation/in")?.toString(), "hello from a note\n", "text as text, with a newline at the end");
  let io = panelOf(box).machine!.io!;
  assert.deepEqual([io.inPreview, io.inBytes], ["hello from a note", 18]);
  assert.equal(io.outAt, undefined, "nothing written yet");

  // the machine upper-cases it (what `tr a-z A-Z </foundation/in >/foundation/out` does)
  files.set("/foundation/out", Buffer.from(files.get("/foundation/in")!.toString().toUpperCase()));
  await look();
  const out = panelOf(box).ports.find((p) => p.name === "out")!;
  assert.equal(panelOf(box).outputs?.[out.id], "HELLO FROM A NOTE", "on the card's out port, where wires and apps read it");
  const doc = getBoard(BOARD).doc;
  const noteOf = (id: string) => noteTextOf(doc, boardMaps(doc).objects.get(id) as never);
  assert.equal(noteOf(result.id), "HELLO FROM A NOTE", "and in the note it's wired to");
  assert.equal(tableCellsOf(doc, table.id)["0,0"], "HELLO FROM A NOTE", "a single value lands in A1");
  io = panelOf(box).machine!.io!;
  assert.deepEqual([io.outPreview, io.outBytes], ["HELLO FROM A NOTE", 18]);

  // unchanged: nothing is rewritten, nothing re-emitted
  const stamp = { inAt: io.inAt, outAt: io.outAt };
  await new Promise((r) => setTimeout(r, 5));
  await look();
  assert.deepEqual({ inAt: panelOf(box).machine!.io!.inAt, outAt: panelOf(box).machine!.io!.outAt }, stamp);

  // the note changes: the file follows
  await runTool(person, "update_card", { id: note.id, markdown: "second" });
  await look();
  assert.equal(files.get("/foundation/in")?.toString(), "second\n");

  // JSON out is JSON on the port; rows fill the table; a note gets it as a code block
  files.set("/foundation/out", Buffer.from('[["part","qty"],["vane",12]]\n'));
  await look();
  assert.deepEqual(panelOf(box).outputs?.[out.id], [["part", "qty"], ["vane", 12]]);
  assert.deepEqual(tableCellsOf(doc, table.id), { "0,0": "part", "1,0": "qty", "0,1": "vane", "1,1": "12" });
  assert.match(noteOf(result.id), /^```json\n\[\n/);
  files.set("/foundation/out", Buffer.from('[{"part":"hub","qty":2}]'));
  await look();
  assert.deepEqual(tableCellsOf(doc, table.id), { "0,0": "part", "1,0": "qty", "0,1": "hub", "1,1": "2" }, "records: their keys head the columns");

  // a table wired in arrives as its rows, as JSON; one cell as its text
  for (const l of [...boardMaps(doc).links.values()]) if (l.to.panel === box) editBoard(BOARD, "test", (d) => boardMaps(d).links.delete(l.id));
  await runTool(person, "connect", { from_panel: table.id, from_port: "rows", to_panel: box, to_port: "in" });
  await look();
  assert.equal(files.get("/foundation/in")?.toString(), '[["part","qty"],["hub","2"]]\n');
  for (const l of [...boardMaps(doc).links.values()]) if (l.to.panel === box) editBoard(BOARD, "test", (d) => boardMaps(d).links.delete(l.id));
  const cell = (await runTool(person, "connect", { from_panel: table.id, from_port: "a2", to_panel: box, to_port: "in" })) as { from: { port: string } };
  assert.equal(cell.from.port, "A2");
  await look();
  assert.equal(files.get("/foundation/in")?.toString(), "hub\n");

  // an agent's read names both ends
  const seen = (await runTool(agentCtx, "machines", {})) as { machines: Array<{ id: string; desktop: unknown; pipes: { in: { path: string; from: string[]; last: string }; out: { path: string; to: string[]; last: string } } }> };
  const mine = seen.machines.find((x) => x.id === box)!;
  assert.deepEqual(mine.pipes.in, { path: "/foundation/in", from: ["Rows"], last: "hub" });
  assert.deepEqual([mine.pipes.out.path, mine.pipes.out.to.sort()], ["/foundation/out", ["Chart", "Result", "Rows"]]);
  assert.deepEqual(mine.desktop, { screen: "1280x800", agents_may_use_it: false, note: "a person lets agents use it on the card: Let agents use this desktop" });
});

test("values in and out of the two files", () => {
  assert.equal(mio.inFile("plain"), "plain\n");
  assert.equal(mio.inFile("ends\n"), "ends\n");
  assert.equal(mio.inFile({ a: 1 }), '{"a":1}\n');
  assert.equal(mio.inFile(42), "42\n");
  assert.equal(mio.parseOut("HELLO\n"), "HELLO");
  assert.deepEqual(mio.parseOut('{"ok": true}\n'), { ok: true });
  assert.equal(mio.parseOut("42\n"), 42);
  assert.equal(mio.parseOut("two\nlines\n"), "two\nlines");
  assert.equal(mio.parseOut("{not json"), "{not json");
  assert.equal(mio.parseOut(""), "");
  assert.deepEqual(cellRef("B2"), { c: 1, r: 1 });
  assert.deepEqual(cellRef("aa10"), { c: 26, r: 9 });
  assert.equal(cellRef("rows"), null);
});

test("Remove takes the desktop, the leave and the pipes' last values with the disk", async () => {
  desk.setAgentsMay(BOARD, box, ada, true);
  await machines.removeMachine(BOARD, box, "Ada", true);
  const p = panelOf(box);
  assert.deepEqual([p.machine?.state, p.machine?.desktop, p.machine?.agentsMay, p.machine?.agentActs, p.machine?.io], ["absent", undefined, undefined, undefined, undefined]);
  assert.equal(p.outputs?.[p.ports.find((x) => x.name === "out")!.id], undefined);
  await assert.rejects(() => runTool(agentCtx, "desktop_screenshot", { machine: box }), /isn't running/);
});

// ---------- a WebSocket stand-in ----------

class FakeWs extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  frames: Array<Buffer | string> = [];
  closed: { code: number; reason: string } | null = null;
  send(d: Buffer | string) {
    this.frames.push(d);
    this.emit("_frame");
  }
  close(code = 1000, reason = "") {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closed = { code, reason };
    this.emit("close");
  }
  key(s: string) {
    this.emit("message", Buffer.from(s, "latin1"), true);
  }
  text() {
    return this.frames.filter((f): f is Buffer => Buffer.isBuffer(f)).map((b) => b.toString("latin1")).join("");
  }
  until(re: RegExp) {
    return new Promise<void>((ok, fail) => {
      const t = setTimeout(() => fail(new Error(`never saw ${re} in ${JSON.stringify(this.text())}`)), 2000);
      const check = () => {
        if (re.test(this.text())) {
          clearTimeout(t);
          this.off("_frame", check);
          ok();
        }
      };
      this.on("_frame", check);
      check();
    });
  }
}
