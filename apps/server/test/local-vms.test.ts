import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { Readable, PassThrough, Writable, Duplex } from "node:stream";
import type { Req } from "../src/http.ts";
import { boardMaps, appendSection, type PanelDoc } from "@foundation/protocol";

const home = mkdtempSync(join(tmpdir(), "foundation-local-vms-"));
process.env.FOUNDATION_ROOT = home;
process.env.FOUNDATION_DATA_DIR = join(home, "data");
process.env.FOUNDATION_QEMU = process.execPath;
process.env.FOUNDATION_QEMU_IMG = process.execPath;
process.env.FOUNDATION_ADMIN_EMAILS = "boss@example.test";
process.env.FOUNDATION_SERVICE_TOKEN = "s".repeat(40);
process.env.ANTHROPIC_API_KEY = "never-give-this-to-qemu";
const { config } = await import("../src/config.ts");
const { db, one } = await import("../src/db.ts");
const auth = await import("../src/auth.ts");
const { editBoard, closeBoards } = await import("../src/boards.ts");
const { setBoardRole } = await import("../src/roles.ts");
const { Router, HttpError } = await import("../src/http.ts");
const { registerVmRoutes } = await import("../src/vmroutes.ts");
const { handleUpgrade } = await import("../src/sockets.ts");
const { setChildDeps } = await import("../src/child.ts");
const { VmChannel } = await import("../src/vmchannel.ts");
const { shutdownLocalVms, vmIo, attachVmConsole } = await import("../src/localvms.ts");
const boss = auth.upsertUser("boss@example.test", "Boss"), viewer = auth.upsertUser("viewer@example.test", "Viewer");
setBoardRole(boss, "vmboard", viewer.id, "viewer");
const cookie = `foundation_session=${auth.createSession(boss.id)}`;
const viewerCookie = `foundation_session=${auth.createSession(viewer.id)}`;
const agent = auth.createSession(boss.id, 100000, "agent");
for (const b of ["vmboard", "otherboard"]) editBoard(b, "test", (doc) => {
  const sec = appendSection(doc, "VMs");
  for (const id of ["vm1", "vm2"]) boardMaps(doc).objects.set(id, { id, kind: "panel", panel: "machine", sectionId: sec.id, name: "Machine", x: 0, y: 0, w: 640, h: 600, float: false, bornAt: 1, ports: [], machine: { name: "new", state: "absent" } } as PanelDoc);
});
const router = new Router(); registerVmRoutes(router);
// Exercise the actual registered HTTP handlers with streaming request bodies.
// No TCP here: this agent's sandbox denies even loopback connects.
const fetch = async (address: string, init: { method?: string; headers?: object; body?: any } = {}) => {
  const url = new URL(address), route = router.match(init.method ?? "GET", url.pathname);
  const req = Object.assign(Readable.from(init.body ? [Buffer.from(init.body)] : []), { method: init.method ?? "GET", headers: init.headers ?? {}, url: url.pathname, query: url.searchParams, params: route?.params ?? {} }) as unknown as Req;
  try { const out = await route!.handler(req, {} as never); return { status: 200, json: async () => out as any }; }
  catch (e) { return { status: e instanceof HttpError ? e.status : 500, json: async () => ({ error: (e as Error).message }) as any }; }
};
let base = "http://local", isoId: string, disk = "", launches = 0;
const log = join(home, "protocol.jsonl");
const record = (x: object) => appendFileSync(log, JSON.stringify(x) + "\n");
class Guest extends Duplex {
  executions = 0;
  _read() {}
  _write(chunk: Buffer, _encoding: string, done: () => void) {
    for (const line of chunk.toString().trim().split("\n")) {
      const m = JSON.parse(line); record({ guest: m });
      if (m.execute === "guest-exec") this.executions++;
      const out = m.execute === "guest-exec" ? { pid: 77 } : m.execute === "guest-exec-status" ? { exited: true, exitcode: 0, "out-data": Buffer.from(`Linux protocol stand-in ${this.executions}\n`).toString("base64") } : {};
      this.push(JSON.stringify({ return: out, id: m.id }) + "\n");
    } done();
  }
}
class GuestListener extends EventEmitter {
  listen(_port: number, _host: string, done: () => void) { queueMicrotask(done); }
  address() { return { port: 64101 }; }
  close() {}
  on(event: string, fn: (...args: any[]) => void) { super.on(event, fn); if (event === "connection") queueMicrotask(() => fn(new Guest())); return this; }
}
class Qemu extends EventEmitter {
  pid = 999991; exitCode: number | null = null; stdout = new PassThrough(); stderr = new PassThrough();
  stdin = new Writable({ write: (chunk, _encoding, done) => {
    const m = JSON.parse(chunk.toString()); record({ qmp: m });
    this.stdout.write(JSON.stringify({ return: m.execute === "query-status" ? { running: true } : {}, id: m.id }) + "\n");
    if (["quit", "system_powerdown"].includes(m.execute)) setImmediate(() => { this.exitCode = 0; this.emit("exit", 0); });
    done();
  } });
  constructor() { super(); setImmediate(() => this.stdout.write('{"QMP":{"capabilities":[]}}\n')); }
  kill() { this.exitCode = 1; this.emit("exit", 1); return true; }
}
const oldIo = { ...vmIo };
vmIo.reservePort = async () => 64100;
vmIo.makeServer = () => new GuestListener() as never;
const undo = setChildDeps({
  execFile: (_file, args, options, done) => { assert.equal(options.env?.ANTHROPIC_API_KEY, undefined); assert.deepEqual(args.slice(0, 3), ["create", "-f", "qcow2"]); disk = String(args[3]); writeFileSync(disk, "kept disk"); setImmediate(() => done(null, "", "")); return {} as never; },
  spawn: (_file, args, options) => { launches++; assert.equal(options.env?.ANTHROPIC_API_KEY, undefined); assert.equal(options.shell, undefined); record({ args, env: Object.keys(options.env ?? {}).filter((k) => /TOKEN|KEY|SECRET|PASSWORD/.test(k)) }); return new Qemu() as never; },
});
after(async () => { await shutdownLocalVms(); await new Promise((done) => setTimeout(done, 30)); undo(); Object.assign(vmIo, oldIo); closeBoards(); db.close(); });
const api = async (path: string, body?: object, headers = { cookie }) => { const r = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: r.status, body: await r.json() as any }; };
const p = "/api/boards/vmboard/vms/vm1";

test("JSON channels match fragmented/out-of-order replies, ignore events, and fail promptly on disconnect", async () => {
  const input = new PassThrough(), output = new PassThrough(), ch = new VmChannel(input, output);
  const a = ch.call("a"), b = ch.call("b");
  input.write('{"event":"RESET"}\n{"return":2,"id":2}\n{"ret'); input.write('urn":1,"id":1}\n');
  assert.deepEqual(await Promise.all([a, b]), [1, 2]);
  const lost = ch.call("lost"); input.end(); await assert.rejects(lost, /closed/);
});
test("ISO uploads stream, validate media, hash/deduplicate and remain archived", async () => {
  const bad = await fetch(base + "/api/boards/vmboard/vm-isos?name=bad.iso", { method: "POST", headers: { cookie }, body: "not an ISO" }); assert.equal(bad.status, 400);
  const bytes = Buffer.alloc(128 * 1024); bytes.write("CD001", 32769);
  const send = () => fetch(base + "/api/boards/vmboard/vm-isos?name=wildos.iso", { method: "POST", headers: { cookie }, body: bytes });
  const r = await send(); assert.equal(r.status, 200); const file = (await r.json() as any).file; isoId = file.id;
  assert.equal(file.size, bytes.length); assert.match(file.sha256, /^[a-f0-9]{64}$/);
  assert.equal((await (await send()).json() as any).file.id, isoId);
  assert.ok(existsSync(join(config.dataDir, "files", file.sha256)));
});
test("every mutating VM route refuses agents and viewers, including console credentials", async () => {
  for (const verb of ["configure", "start", "shutdown", "poweroff", "boot", "resources", "archive", "restore", "console", "commands"]) {
    assert.equal((await api(`${p}/${verb}`, {}, { authorization: `Bearer ${agent}` } as never)).status, 403, verb);
    assert.equal((await api(`${p}/${verb}`, {}, { cookie: viewerCookie })).status, 403, verb);
  }
  assert.equal(launches, 0);
});
test("configuration is board scoped and request-idempotent; client paths and resource excesses cannot configure a host", async () => {
  assert.equal((await api(p + "/configure", { fileId: isoId })).status, 400);
  assert.equal((await api("/api/boards/otherboard/vms/vm1/configure", { fileId: isoId, request_id: "request-other" })).status, 400);
  const body = { request_id: "request-vm1", fileId: isoId, memoryMB: 512, cpus: 1, diskGB: 40, acceleration: "software", path: "C:/Windows", name: "Test WildOS" };
  assert.equal((await api(p + "/configure", { ...body, memoryMB: 999999 })).status, 400);
  assert.equal((await api(p + "/configure", body)).body.vm.state, "ready");
  assert.equal((await api(p + "/configure", body)).status, 200);
  assert.equal((await api("/api/boards/vmboard/vms/vm2/configure", body)).status, 409);
  assert.equal(launches, 0);
});
test("a person's start runs native QEMU once, boots its ISO, streams the console and executes commands only in the guest", { timeout: 15000 }, async () => {
  // Forging the synced card must not change the host's memory allocation or disk path.
  editBoard("vmboard", "test", (doc) => { const m = boardMaps(doc), p = m.objects.get("vm1") as PanelDoc; m.objects.set(p.id, { ...p, vm: { ...p.vm!, memoryMB: 999999 } }); });
  const r = await api(p + "/start", {}); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.vm.state, "running");
  assert.equal((await api(p + "/start", {})).status, 200); assert.equal(launches, 1);
  const credentials = await api(p + "/console", {}); assert.equal(credentials.body.password.length, 8);
  for (const headers of [{ cookie: viewerCookie }, { authorization: `Bearer ${agent}` }]) {
    let refused = "";
    handleUpgrade({ handleUpgrade() { throw new Error("unauthorized console admitted"); } } as never, { url: "/vms/vmboard/vm1/vnc", headers: { ...headers, origin: config.clientUrl } } as never, { write(s: string) { refused += s; }, destroy() {} } as never, Buffer.alloc(0));
    assert.match(refused, /403 Forbidden/);
  }
  const socket = new EventEmitter() as any; socket.write = (b: Buffer) => { assert.deepEqual([...b], [1, 2]); }; socket.destroy = () => {};
  vmIo.connect = () => socket;
  const ws = new EventEmitter() as any; ws.readyState = 1; ws.bufferedAmount = 0; let frame = ""; ws.send = (b: Buffer) => { frame = b.toString(); }; ws.close = () => ws.emit("close");
  attachVmConsole("vmboard", "vm1", ws, boss); socket.emit("data", Buffer.from("RFB 003.008\n")); assert.equal(frame, "RFB 003.008\n"); ws.emit("message", Buffer.from([1, 2]), true); ws.emit("close");
  const command = { command: "uname -a", request_id: "command-first" };
  const a = await api(p + "/commands", command), b = await api(p + "/commands", command); assert.equal(a.status, 200, JSON.stringify(a.body)); assert.equal(a.body.pid, b.body.pid);
  assert.equal((await api(p + "/commands", { ...command, command: "different" })).status, 409);
  const out = await api(p + `/commands/${a.body.commandId}`); assert.match(out.body.stdout, /protocol stand-in/);
  assert.deepEqual((await api(p + `/commands/${a.body.commandId}`)).body, out.body);
  const seen = readFileSync(log, "utf8").trim().split("\n").map((x) => JSON.parse(x));
  assert.equal(seen.filter((x) => x.guest?.execute === "guest-exec").length, 1);
  const second = await api(p + "/commands", { ...command, request_id: "command-second" });
  assert.equal(second.body.pid, a.body.pid); // guest PIDs can be reused; public command IDs cannot.
  const secondOut = await api(p + `/commands/${second.body.commandId}`);
  assert.notEqual(secondOut.body.stdout, out.body.stdout);
  assert.deepEqual((await api(p + `/commands/${a.body.commandId}`)).body, out.body);
  assert.ok(seen[0].args.includes("tcg")); assert.ok(seen[0].args.includes("-cdrom")); assert.deepEqual(seen[0].env, []);
  assert.equal(seen[0].args[seen[0].args.indexOf("-m") + 1], "512");
  assert.equal(JSON.parse(seen[0].args[seen[0].args.indexOf("-blockdev") + 1]).filename, disk);
  assert.equal((await api(p + "/poweroff", {})).status, 400);
});
test("shutdown preserves the disk, installed boot omits ISO, and archive needs confirmation and retains all bytes", { timeout: 15000 }, async () => {
  await api(p + "/shutdown", {}); await new Promise((done) => setTimeout(done, 300));
  assert.equal((await api(p)).body.vm.state, "stopped");
  const first = readFileSync(disk, "utf8"); assert.equal(first, "kept disk");
  await api(p + "/boot", { iso: false });
  assert.equal((await api(p + "/start", {})).body.vm.state, "running");
  assert.equal(readFileSync(disk, "utf8"), first);
  const starts = readFileSync(log, "utf8").trim().split("\n").map((x) => JSON.parse(x)).filter((x) => x.args);
  assert.ok(!starts[1].args.includes("-cdrom"));
  await api(p + "/shutdown", {}); await new Promise((done) => setTimeout(done, 300));
  assert.equal((await api(p + "/archive", {})).status, 400);
  assert.equal((await api(p + "/archive", { confirm: true })).body.vm.state, "archived");
  assert.equal((await api(p + "/start", {})).status, 409);
  assert.equal(readFileSync(disk, "utf8"), first);
  assert.equal(one<{ archived_at: number | null }>("select archived_at from files where id = ?", isoId)?.archived_at, null);
  assert.equal((await api(p + "/restore", {})).body.vm.state, "stopped");
  assert.equal((await api(p + "/resources", { memoryMB: 999999 })).status, 400);
  assert.equal((await api(p + "/resources", { acceleration: "software", memoryMB: 512 })).body.vm.memoryMB, 512);
});

test("a previous live PID cannot be replaced or killed, and failed native startup keeps the disk", async () => {
  db.prepare("update local_vms set pid = ? where board_id = ? and panel_id = ?").run(process.pid, "vmboard", "vm1");
  assert.equal((await api(p + "/start", {})).status, 409);
  assert.equal((await api(p + "/poweroff", { confirm: true })).status, 409);
  assert.equal((await api(p + "/archive", { confirm: true })).status, 409);
  db.prepare("update local_vms set pid = null where board_id = ? and panel_id = ?").run("vmboard", "vm1");
  const fail = setChildDeps({ spawn() { throw new Error("native launch refused"); } });
  try { assert.equal((await api(p + "/start", {})).status, 500); assert.match((await api(p)).body.vm.detail, /native launch refused/); assert.equal(readFileSync(disk, "utf8"), "kept disk"); }
  finally { fail(); }
});
