/**
 * The machines driver against the real engine on this computer — Kiri or
 * Docker, whichever answers (or FOUNDATION_ENGINES=kiri=<socket> to pick).
 * It runs third-party code (an alpine image), so a person runs it:
 *
 *   npm run machines:smoke -w @foundation/server            # first engine that answers, Kiri first
 *   npm run machines:smoke -w @foundation/server -- kiri    # only Kiri
 *
 * It proposes a machine as an agent would, starts it as a person, types into
 * its shared terminal, reads the screen back as an agent would, stops it,
 * starts it again (the disk kept), removes it, and checks the engine has
 * nothing left. Its own data folder is thrown away; it touches no board of yours.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

const dir = mkdtempSync(join(tmpdir(), "foundation-machines-smoke-"));
process.env.FOUNDATION_DATA_DIR = dir;
const want = process.argv[2];

const m = await import("../src/machines.ts");
const { editBoard, closeBoards } = await import("../src/boards.ts");
const { appendSection } = await import("@foundation/protocol");
const { runTool } = await import("../src/tools.ts");
const { upsertUser } = await import("../src/auth.ts");

class Ws extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  out = "";
  send(d: Buffer | string) {
    if (Buffer.isBuffer(d)) this.out += d.toString();
  }
  close() {
    this.readyState = 3;
    this.emit("close");
  }
  type(s: string) {
    this.emit("message", Buffer.from(s), true);
  }
}

const step = (s: string) => console.log(`· ${s}`);
const fail = (s: string): never => {
  console.error(`✗ ${s}`);
  process.exit(1);
};
const until = async (ws: Ws, re: RegExp, ms = 8000) => {
  const end = Date.now() + ms;
  while (!re.test(ws.out)) {
    if (Date.now() > end) fail(`never saw ${re} on the terminal:\n${ws.out.slice(-600)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

let card = "";
try {
  const engines = await m.engineStatus(true);
  for (const e of engines) step(`${e.name} at ${e.at}: ${e.up ? `up, ${e.version} (API ${e.api})` : e.error}`);
  const engine = engines.find((e) => e.up && (!want || e.id === want));
  if (!engine) fail(want ? `${want} isn't answering here` : "no engine answers here");
  const who = upsertUser("smoke@formindustries.com", "Smoke");
  editBoard("smoke", "smoke", (d) => appendSection(d, "Machines"));

  ({ card } = (await runTool({ boardId: "smoke", actor: "Agent", userId: who.id }, "propose_machine", { name: `smoke ${Date.now().toString(36)}`, image: "alpine", ports: [8000] })) as { card: string });
  step(`proposed ${card} (nothing started)`);
  let t0 = Date.now();
  const started = await m.startMachine("smoke", card, "Smoke", { engine: engine.id });
  if (started.state !== "running") fail(`expected running, got ${started.state}: ${started.detail}`);
  step(`started machine-${started.name} on ${engine.name} in ${Date.now() - t0} ms; ports ${JSON.stringify(started.ports)}`);

  const ws = new Ws();
  await m.attachTerminal("smoke", card, ws as never, { name: "Smoke" }, true);
  ws.type("cat /etc/os-release | head -1; echo foundation-$((6*7)); echo kept > /root/kept\n");
  await until(ws, /foundation-42/);
  step("typed into the shared terminal: foundation-42");
  const read = (await runTool({ boardId: "smoke", actor: "Agent", userId: who.id }, "machines", {})) as { machines: Array<{ terminal: string | null }> };
  if (!read.machines[0].terminal?.includes("foundation-42")) fail("the agent's read didn't see the screen");
  step("an agent's read sees the screen");

  if ((await m.stopMachine("smoke", card, "Smoke")).state !== "stopped") fail("stop didn't stop it");
  step("stopped");
  t0 = Date.now();
  await m.startMachine("smoke", card, "Smoke");
  const ws2 = new Ws();
  await m.attachTerminal("smoke", card, ws2 as never, { name: "Smoke" }, true);
  ws2.type("cat /root/kept\n");
  await until(ws2, /\nkept/);
  step(`started again in ${Date.now() - t0} ms, the disk kept`);
} finally {
  if (card) {
    const gone = await m.removeMachine("smoke", card, "Smoke", true).catch((e: Error) => e);
    if (gone instanceof Error) console.error(`! remove: ${gone.message}`);
    else step("removed, with its disk");
    const left = await m.reconcileMachine("smoke", card).catch(() => null);
    if (left?.machine?.containerId) fail("the engine still has it");
  }
  m.closeTerminals();
  closeBoards();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows holds the open database; it is a temp folder */
  }
}
console.log("✓ machines work on this engine");
process.exit(0);
