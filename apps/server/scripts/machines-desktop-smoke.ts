/**
 * A machine's desktop, an agent using it, and its pipes, against the real
 * engine on this computer (Kiri or Docker, whichever answers). It runs
 * third-party code (an image, and the desktop's packages installed into it),
 * so a person runs it:
 *
 *   npm run machines:desktop-smoke -w @foundation/server                # Ubuntu, first engine that answers
 *   npm run machines:desktop-smoke -w @foundation/server -- alpine kiri # Alpine, only Kiri
 *   npm run machines:desktop-smoke -w @foundation/server -- ubuntu "" shot.png   # keep what the agent saw
 *
 * It starts a machine as a person; checks Ctrl+C interrupts in its shell
 * (where the image has perl or python3: see machines.ts UNBLOCK_FN); wires a
 * note into it, upper-cases /foundation/in to /foundation/out there, and sees
 * the result in another note; adds a desktop (a few minutes the first time);
 * opens its VNC through Foundation's relay and reads the RFB greeting, as a
 * person who can edit and as a viewer; shows an agent is refused without
 * leave, gives it, lets the agent look (a 1280×800 PNG), click and type; takes
 * the leave back; removes the machine. Its own data folder is thrown away.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

const dir = mkdtempSync(join(tmpdir(), "foundation-desktop-smoke-"));
process.env.FOUNDATION_DATA_DIR = dir;
process.env.FOUNDATION_MACHINE_IO_MS = "500";
const image = process.argv[2] || "ubuntu";
const want = process.argv[3] || undefined;
const keep = process.argv[4];

const m = await import("../src/machines.ts");
const desk = await import("../src/machinedesktop.ts");
const mio = await import("../src/machineio.ts");
const { editBoard, getBoard, closeBoards } = await import("../src/boards.ts");
const { appendSection, boardMaps, noteTextOf } = await import("@foundation/protocol");
const { runTool } = await import("../src/tools.ts");
const { upsertUser } = await import("../src/auth.ts");

class Ws extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  bytes = Buffer.alloc(0);
  closed = "";
  send(d: Buffer | string) {
    if (Buffer.isBuffer(d)) this.bytes = Buffer.concat([this.bytes, d]);
  }
  close(_code?: number, reason = "") {
    this.readyState = 3;
    this.closed = reason;
    this.emit("close");
  }
  type(s: string | Buffer) {
    this.emit("message", Buffer.isBuffer(s) ? s : Buffer.from(s), true);
  }
  get out() {
    return this.bytes.toString("latin1");
  }
}

const step = (s: string) => console.log(`· ${s}`);
const fail = (s: string): never => {
  console.error(`✗ ${s}`);
  process.exitCode = 1;
  throw new Error(s);
};
const until = async (what: string, ok: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) fail(`never saw ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

const B = "smoke";
let card = "";
try {
  const engines = await m.engineStatus(true);
  const engine = engines.find((e) => e.up && (!want || e.id === want));
  if (!engine) fail(want ? `${want} isn't answering here` : "no engine answers here");
  step(`${engine!.name} ${engine!.version} at ${engine!.at}`);
  const who = upsertUser("smoke@formindustries.com", "Smoke");
  const person = { boardId: B, actor: "Smoke", userId: who.id, person: true };
  const agent = { boardId: B, actor: "Smoke's agent", userId: who.id };
  editBoard(B, "smoke", (d) => appendSection(d, "Machines"));
  const name = `desk-smoke-${Date.now().toString(36)}`;
  ({ card } = (await runTool(person, "propose_machine", { name, image })) as { card: string });
  const started = await m.startMachine(B, card, "Smoke", { engine: engine!.id });
  if (started.state !== "running") fail(`expected running, got ${started.state}: ${started.detail}`);
  step(`started machine-${started.name} (${started.image})`);

  // ---- the shell: Ctrl+C ----
  const tty = new Ws();
  await m.attachTerminal(B, card, tty as never, { name: "Smoke" }, true);
  await until("a prompt", () => /[#$] ?$/.test(tty.out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").trimEnd() + " "), 8000).catch(() => {});
  tty.type("sleep 40\n");
  await new Promise((r) => setTimeout(r, 800));
  tty.type("\x03");
  await new Promise((r) => setTimeout(r, 500));
  tty.type("echo after-$?\n");
  const t0 = Date.now();
  await until("the shell to answer", () => /after-\d+/.test(tty.out), 45_000);
  const code = /after-(\d+)/.exec(tty.out)![1];
  if (code === "130" && Date.now() - t0 < 5000) step("Ctrl+C interrupted sleep (exit 130)");
  else step(`Ctrl+C did NOT interrupt (the shell answered after ${Math.round((Date.now() - t0) / 1000)} s with ${code}): this engine blocks SIGINT and the image has no perl or python3 to clear it`);
  tty.close();

  // ---- pipes ----
  const input = (await runTool(person, "add_note", { section: "Machines", title: "Input", markdown: "hello from a note" })) as { id: string };
  const result = (await runTool(person, "add_note", { section: "Machines", title: "Result", markdown: "(nothing yet)" })) as { id: string };
  await runTool(person, "connect", { from_panel: input.id, from_port: "text", to_panel: card, to_port: "in" });
  await runTool(person, "connect", { from_panel: card, from_port: "out", to_panel: result.id, to_port: "text" });
  const doc = getBoard(B).doc;
  const noteOf = (id: string) => noteTextOf(doc, boardMaps(doc).objects.get(id) as never);
  const ioOf = () => (boardMaps(doc).objects.get(card) as { machine?: { io?: { inAt?: number; error?: string } } }).machine?.io;
  await until("/foundation/in to be written", () => {
    if (ioOf()?.error) fail(`the pipes said: ${ioOf()!.error}`);
    return Boolean(ioOf()?.inAt);
  });
  const had = await m.execSh(B, card, "cat /foundation/in");
  if (had !== "hello from a note") fail(`/foundation/in holds ${JSON.stringify(had)}`);
  await m.execSh(B, card, "tr a-z A-Z </foundation/in >/foundation/out");
  await until("the result note", () => noteOf(result.id) === "HELLO FROM A NOTE");
  step(`piped: note “Input” → /foundation/in → tr a-z A-Z → /foundation/out → note “Result” = ${JSON.stringify(noteOf(result.id))}`);
  await m.execSh(B, card, `echo '{"parts": 3}' >/foundation/out`);
  await until("JSON on out", () => {
    const p = boardMaps(doc).objects.get(card) as { ports: Array<{ id: string; name: string }>; outputs?: Record<string, unknown> };
    return JSON.stringify(p.outputs?.[p.ports.find((x) => x.name === "out")!.id]) === '{"parts":3}';
  });
  step("JSON written to /foundation/out arrives on the out port as JSON");

  // ---- the desktop ----
  let last = "";
  const onUpdate = () => {
    const d = (boardMaps(doc).objects.get(card) as { machine?: { desktop?: { state: string; detail?: string } } }).machine?.desktop;
    const line = d ? `${d.state}${d.detail ? `: ${d.detail}` : ""}` : "";
    if (line && line !== last && /of \d+\)|ready|error|Reading|Starting/.test(line) && (!/\((\d+) of/.test(line) || Number(/\((\d+) of/.exec(line)![1]) % 40 === 0)) console.log(`    ${line}`);
    last = line;
  };
  doc.on("update", onUpdate);
  const t1 = Date.now();
  const ready = await desk.addDesktop(B, card, who).done;
  doc.off("update", onUpdate);
  step(`added a desktop in ${Math.round((Date.now() - t1) / 1000)} s: ${ready.desktop?.w}×${ready.desktop?.h}`);

  // RFB by hand, as noVNC speaks it: the greeting, no password, then a pointer move. An editor's moves the
  // machine's pointer; a viewer's is dropped by the view-only VNC, so their screen is only for watching.
  const pointer = async () => (await m.execSh(B, card, "xdotool getmouselocation", { env: ["DISPLAY=:1"] })).replace(/ screen.*$/, "");
  for (const [who2, canType, to] of [["a person who can edit", true, [500, 300]], ["a viewer", false, [900, 600]]] as const) {
    const vnc = new Ws();
    await desk.attachDesktop(B, card, vnc as never, { name: "Smoke" }, canType);
    await until(`VNC's greeting for ${who2} (${vnc.closed})`, () => /^RFB 003\.\d{3}\n/.test(vnc.out), 20_000);
    vnc.type("RFB 003.008\n");
    await until("its security types", () => vnc.bytes.length >= 14, 5000);
    vnc.type(Buffer.from([1])); // security: none
    await until("the security result", () => vnc.bytes.length >= 12 + 2 + 4, 5000);
    vnc.type(Buffer.from([1])); // ClientInit: shared
    await until("ServerInit", () => vnc.bytes.length >= 12 + 2 + 4 + 24, 5000);
    const w = vnc.bytes.readUInt16BE(18);
    const h = vnc.bytes.readUInt16BE(20);
    const before = await pointer();
    vnc.type(Buffer.from([5, 0, to[0] >> 8, to[0] & 255, to[1] >> 8, to[1] & 255])); // PointerEvent, no buttons
    await new Promise((r) => setTimeout(r, 700));
    const after = await pointer();
    vnc.close();
    const moved = after === `x:${to[0]} y:${to[1]}`;
    if (canType && !moved) fail(`an editor's pointer move didn't reach the machine: ${before} → ${after}`);
    if (!canType && after !== before) fail(`a viewer's pointer move reached the machine: ${before} → ${after}`);
    step(`VNC through Foundation's relay, ${who2}: a ${w}×${h} screen; a pointer move to (${to.join(", ")}) ${canType ? `moved the machine's pointer (${after})` : `was dropped (still ${after})`}`);
  }

  // ---- an agent ----
  const refused = await Promise.resolve()
    .then(() => runTool(agent, "desktop_screenshot", { machine: name }))
    .then(() => "", (e: Error) => e.message);
  if (!/hasn't let agents use/.test(refused)) fail(`an agent without leave wasn't refused: ${refused || "it ran"}`);
  step("an agent without leave is refused, and the card says it asked");
  desk.setAgentsMay(B, card, who, true);
  const shot = (await runTool(agent, "desktop_screenshot", { machine: name })) as { screen: string; _image: { base64: string } };
  const png = Buffer.from(shot._image.base64, "base64");
  if (shot.screen !== "1280x800" || png.length < 2000) fail(`the screenshot is ${shot.screen}, ${png.length} bytes`);
  step(`with leave, the agent sees the screen: ${shot.screen}, a ${Math.round(png.length / 1024)} KB PNG`);
  await runTool(agent, "desktop_mouse", { machine: name, action: "double_click", x: 69, y: 180, look: false });
  await new Promise((r) => setTimeout(r, 2500));
  await runTool(agent, "desktop_key", { machine: name, keys: ["ctrl+l"], look: false });
  const after = (await runTool(agent, "desktop_type", { machine: name, text: "/foundation\n" })) as { _image: { base64: string } };
  const windows = await m.execSh(B, card, "xdotool search --onlyvisible --name foundation getwindowname 2>/dev/null | head -3 || true", { env: ["DISPLAY=:1"] });
  step(`the agent double-clicked Home, pressed ctrl+l and typed /foundation: window titles now ${JSON.stringify(windows)}`);
  if (keep) {
    writeFileSync(keep, Buffer.from(after._image.base64, "base64"));
    step(`what the agent saw afterwards is in ${keep}`);
  }
  desk.setAgentsMay(B, card, who, false);
  const again = await Promise.resolve()
    .then(() => runTool(agent, "desktop_mouse", { machine: name, action: "click", x: 5, y: 5 }))
    .then(() => "", (e: Error) => e.message);
  if (!/hasn't let agents use/.test(again)) fail("the agent still used the desktop after the leave was taken back");
  step("the leave taken back: refused again");
  console.log("✓ desktop, agent and pipes work on this engine");
} catch (e) {
  if (!process.exitCode) {
    console.error(`✗ ${(e as Error).message}`);
    process.exitCode = 1;
  }
} finally {
  if (card) await m.removeMachine(B, card, "Smoke", true).then(() => step("removed the machine and its disk"), (e: Error) => console.error(`  (couldn't remove it: ${e.message})`));
  mio.stopMachineIo();
  desk.closeDesktops();
  m.closeTerminals();
  closeBoards();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows keeps the database open until the process ends */
  }
  setTimeout(() => process.exit(), 200).unref();
}
