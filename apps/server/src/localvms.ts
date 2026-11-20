/** Native full-system QEMU VMs. Host paths/configuration live only in SQLite, never in writable cards.
 * No downloads, host mounts, engine socket, elevated process or auto-start. All starts/inputs require a person.
 */
import { randomBytes, createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync, realpathSync } from "node:fs";
import { join, delimiter, dirname } from "node:path";
import { freemem, totalmem, availableParallelism } from "node:os";
import { createServer, connect, type Server, type Socket } from "node:net";
import type { WebSocket } from "ws";
import { boardMaps, logActivity, type LocalVmState, type PanelDoc, type UserInfo } from "@foundation/protocol";
import { db, one, run } from "./db.ts";
import { config } from "./config.ts";
import { editBoard, getBoard, onBoardChange } from "./boards.ts";
import { childOptions, execFileChild, spawnChild, type ChildProcess } from "./child.ts";
import { HttpError } from "./http.ts";
import { VmChannel } from "./vmchannel.ts";
import { canWrite } from "./roles.ts";
import { canSeeBoard } from "./members.ts";
import { audit } from "./audit.ts";

db.exec(`create table if not exists local_vms (
 id text primary key, board_id text not null, panel_id text not null,
 request_id text not null, settings text not null, pid integer,
 state text not null, detail text, archived integer not null default 0,
 unique(board_id, panel_id), unique(board_id, request_id)
);
create table if not exists vm_command_requests (
 vm_id text not null, request_id text not null, command_hash text not null,
 generation text not null, pid integer, primary key(vm_id, request_id)
);`);

interface Settings { name: string; os: string; fileId: string; memoryMB: number; cpus: number; diskGB: number; acceleration: "native" | "software"; bootIso: boolean }
interface Row { id: string; board_id: string; panel_id: string; request_id: string; settings: string; pid: number | null; state: LocalVmState["state"]; detail: string | null; archived: number }
interface Running { child: ChildProcess; qmp: VmChannel; password: string; port: number; log: string; generation: string; guest?: VmChannel; guestSocket?: Socket; listener: Server; clients: Set<WebSocket>; commands: Map<string, number>; results: Map<string, unknown>; finished?: boolean; orphanShutdown?: boolean }
const running = new Map<string, Running>();
const locks = new Map<string, Promise<unknown>>();
const root = () => join(config.workDir, "vms");
const diskOf = (r: Row) => join(root(), r.id, "system.qcow2");
onBoardChange((boardId, doc) => {
  for (const [id, rt] of running) {
    if (rt.orphanShutdown) continue;
    const r = one<Row>("select * from local_vms where id = ? and board_id = ?", id, boardId);
    if (r && !boardMaps(doc).objects.has(r.panel_id)) {
      rt.orphanShutdown = true;
      for (const ws of rt.clients) ws.close(4004, "The VM card was removed");
      void rt.qmp.call("system_powerdown").catch(() => {});
    }
  }
});

export function vmTools() {
  const find = (name: string, explicit?: string) => {
    if (explicit) return existsSync(explicit) ? explicit : undefined;
    const file = name + (process.platform === "win32" ? ".exe" : "");
    const dirs = (process.env.PATH ?? process.env.Path ?? "").split(delimiter);
    if (process.platform === "win32") dirs.push(join(process.env.ProgramFiles ?? "C:/Program Files", "qemu"));
    return dirs.map((d) => join(d, file)).find((p) => existsSync(p));
  };
  const qemu = find("qemu-system-x86_64", process.env.FOUNDATION_QEMU);
  const image = find("qemu-img", process.env.FOUNDATION_QEMU_IMG ?? (qemu ? join(dirname(qemu), process.platform === "win32" ? "qemu-img.exe" : "qemu-img") : undefined));
  return { qemu, image };
}
export function vmHost() {
  const tools = vmTools();
  return { available: Boolean(tools.qemu && tools.image), platform: process.platform, maxMemoryMB: Math.max(512, Math.min(16384, Math.floor(totalmem() / 2 / 1048576))), freeMemoryMB: Math.floor(freemem() / 1048576), maxCpus: Math.min(16, availableParallelism()), note: tools.qemu && tools.image ? "Native QEMU; no WSL or Docker required" : "Install QEMU on the Foundation server's computer, or set FOUNDATION_QEMU and FOUNDATION_QEMU_IMG to its installed executables. Restart the server after installing." };
}
function card(board: string, panel: string): PanelDoc {
  const p = boardMaps(getBoard(board).doc).objects.get(panel);
  if (!p || p.kind !== "panel" || p.panel !== "machine") throw new HttpError(404, "No machine card here");
  return p;
}
function row(board: string, panel: string): Row {
  card(board, panel);
  const r = one<Row>("select * from local_vms where board_id = ? and panel_id = ?", board, panel);
  if (!r) throw new HttpError(404, "No configured VM on this card");
  return r;
}
function projection(r: Row): LocalVmState {
  const s: Settings = JSON.parse(r.settings);
  const f = one<{ name: string }>("select name from files where id = ?", s.fileId);
  return { name: s.name, os: s.os, state: r.archived ? "archived" : r.state, isoName: f?.name ?? "Archived ISO", memoryMB: s.memoryMB, cpus: s.cpus, diskGB: s.diskGB, acceleration: s.acceleration, bootIso: s.bootIso, ...(r.detail ? { detail: r.detail } : {}), guestAgent: Boolean(running.get(r.id)?.guest) };
}
function publish(r: Row, state = r.state, detail: string | null = r.detail) {
  if (r.state !== state || r.detail !== detail) run("update local_vms set state = ?, detail = ? where id = ?", state, detail, r.id);
  r = { ...r, state, detail };
  const vm = projection(r);
  editBoard(r.board_id, "local-vms", (doc) => {
    const m = boardMaps(doc), p = m.objects.get(r.panel_id);
    if (!p || p.kind !== "panel") return;
    const next = { ...p, vm, status: state === "running" ? "running" as const : state === "error" ? "error" as const : "idle" as const };
    delete next.machine;
    if (JSON.stringify(p) !== JSON.stringify(next)) m.objects.set(p.id, next);
  });
  return vm;
}
function record(r: Row, who: UserInfo, action: string, args?: unknown) {
  audit({ actor_kind: "person", actor_id: who.id, actor_name: who.name, board_id: r.board_id, door: "route", action: `vm.${action}`, target: r.panel_id, decision: "allowed", approved_by: who.id, provenance: "ours-local", args });
  if (action !== "command") editBoard(r.board_id, "local-vms", (doc) => logActivity(doc, { who: who.name, role: "human", text: `${action}: ${JSON.parse(r.settings).name}`, objectId: r.panel_id }));
}
function isoOf(r: Row) {
  const s: Settings = JSON.parse(r.settings);
  const f = one<{ sha256: string; board_id: string; name: string; size: number }>("select sha256, board_id, name, size from files where id = ?", s.fileId);
  if (!f || f.board_id !== r.board_id || !/\.iso$/i.test(f.name) || !/^[a-f0-9]{64}$/.test(f.sha256)) throw new HttpError(400, "Choose an ISO archived on this board");
  const actual = join(config.dataDir, "files", f.sha256);
  if (!existsSync(actual) || statSync(actual).size !== f.size) throw new HttpError(404, "The archived ISO's bytes are missing or incomplete");
  return realpathSync(actual);
}
export function configureVm(board: string, panel: string, body: Record<string, unknown>, who: UserInfo) {
  const p = card(board, panel);
  if (typeof body.request_id !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(body.request_id)) throw new HttpError(400, "request_id is required");
  const existing = one<Row>("select * from local_vms where board_id = ? and (panel_id = ? or request_id = ?)", board, panel, body.request_id);
  if (existing) {
    if (existing.panel_id !== panel || existing.request_id !== body.request_id) throw new HttpError(409, "This card or request already configures a VM");
    return publish(existing);
  }
  if (p.machine && p.machine.state !== "absent") throw new HttpError(409, "Use a new machine card; this one has a container");
  const host = vmHost();
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const n = body[name] ?? fallback;
    if (!Number.isInteger(n) || Number(n) < min || Number(n) > max) throw new HttpError(400, `${name} must be ${min}–${max}`);
    return Number(n);
  };
  if (body.acceleration !== undefined && body.acceleration !== "native" && body.acceleration !== "software") throw new HttpError(400, "Choose native or software acceleration");
  const settings: Settings = { name: String(body.name ?? "WildOS").slice(0, 80), os: "WildOS / Linux x86-64", fileId: String(body.fileId ?? ""), memoryMB: integer("memoryMB", 4096, 512, host.maxMemoryMB), cpus: integer("cpus", 2, 1, host.maxCpus), diskGB: integer("diskGB", 64, 40, 512), acceleration: body.acceleration === "software" ? "software" : "native", bootIso: true };
  const r: Row = { id: randomBytes(16).toString("hex"), board_id: board, panel_id: panel, request_id: body.request_id, settings: JSON.stringify(settings), pid: null, state: "ready", detail: null, archived: 0 };
  isoOf(r);
  run("insert into local_vms (id,board_id,panel_id,request_id,settings,state) values (?,?,?,?,?,?)", r.id, board, panel, r.request_id, r.settings, r.state);
  record(r, who, "configured", { ...settings, fileId: settings.fileId });
  return publish(r);
}

const exec = (file: string, args: string[]) => new Promise<void>((resolve, reject) => execFileChild(file, args, childOptions({ extras: [] }, { windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 }), (error, _out, err) => error ? reject(new Error(err || error.message)) : resolve()));
async function reservePort() {
  const s = createServer();
  await new Promise<void>((resolve, reject) => { s.once("error", reject); s.listen(0, "127.0.0.1", resolve); });
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}
/** Tests replace host transports; production always uses native loopback TCP. */
export const vmIo = {
  reservePort,
  makeServer: () => createServer(),
  connect: (port: number) => connect(port, "127.0.0.1"),
};
export function qemuArgs(s: Settings, disk: string, iso: string, port: number, guestPort: number, platform = process.platform) {
  const accel = s.acceleration === "software" ? "tcg" : platform === "win32" ? "whpx" : platform === "darwin" ? "hvf" : "kvm";
  return ["-name", s.name, "-machine", "q35", "-accel", accel, "-m", String(s.memoryMB), "-smp", String(s.cpus), "-S", "-display", "none", "-qmp", "stdio", "-monitor", "none",
    "-blockdev", JSON.stringify({ driver: "file", filename: disk, "node-name": "disk-file" }), "-blockdev", JSON.stringify({ driver: "qcow2", file: "disk-file", "node-name": "system-disk" }), "-device", "virtio-blk-pci,drive=system-disk",
    ...(s.bootIso ? ["-cdrom", iso, "-boot", "order=c,once=d,menu=on"] : ["-boot", "order=c,menu=on"]), "-vga", "std", "-device", "qemu-xhci", "-device", "usb-tablet", "-nic", "user,model=virtio-net-pci", "-rtc", "base=utc",
    "-vnc", `127.0.0.1:${port - 5900},password=on`, "-device", "virtio-serial-pci", "-chardev", `socket,id=guest,host=127.0.0.1,port=${guestPort},reconnect-ms=1000`, "-device", "virtserialport,chardev=guest,name=org.qemu.guest_agent.0"];
}
async function start(r: Row) {
  if (r.archived) throw new HttpError(409, "Restore this VM before starting it");
  if (running.has(r.id)) return vmStatus(r.board_id, r.panel_id);
  if (r.pid) {
    try { process.kill(r.pid, 0); throw new HttpError(409, "A previous VM process may still be running. Shut it down before starting another copy; its disk is kept."); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
  }
  const tools = vmTools();
  if (!tools.qemu || !tools.image) throw new HttpError(503, vmHost().note);
  const s: Settings = JSON.parse(r.settings), iso = isoOf(r);
  if (s.memoryMB * 1048576 > freemem() - 512 * 1048576) throw new HttpError(409, "Not enough available host memory. Close other VMs/apps or configure a smaller VM.");
  publish(r, "starting", "Preparing the VM disk");
  mkdirSync(join(root(), r.id), { recursive: true });
  const disk = diskOf(r);
  if (!existsSync(disk)) await exec(tools.image, ["create", "-f", "qcow2", disk, `${s.diskGB}G`]);
  const port = await vmIo.reservePort();
  if (port < 5900) throw new Error("Could not allocate a VNC port");
  const listener = vmIo.makeServer();
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const guestPort = (listener.address() as { port: number }).port;
  let child: ChildProcess;
  try { child = spawnChild(tools.qemu, qemuArgs(s, disk, iso, port, guestPort), childOptions({ extras: [] }, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })); }
  catch (e) { listener.close(); throw e; }
  const qmp = new VmChannel(child.stdout!, child.stdin!, true);
  const rt: Running = { child, qmp, port, password: randomBytes(6).toString("base64").slice(0, 8), log: "", generation: randomBytes(16).toString("hex"), listener, clients: new Set(), commands: new Map(), results: new Map() };
  running.set(r.id, rt);
  run("update local_vms set pid = ? where id = ?", child.pid ?? null, r.id);
  listener.on("connection", (socket) => {
    if (rt.guestSocket) { socket.destroy(); return; }
    rt.guestSocket = socket;
    rt.guest = new VmChannel(socket, socket);
    socket.on("close", () => { rt.guest = undefined; rt.guestSocket = undefined; });
  });
  listener.on("error", (e) => { rt.log = (rt.log + e.message).slice(-16000); });
  child.stderr?.on("data", (b) => { rt.log = (rt.log + b.toString()).slice(-16000); });
  const ended = (error?: Error) => {
    if (rt.finished) return;
    rt.finished = true;
    qmp.close(); rt.guest?.close(); rt.guestSocket?.destroy(); listener.close();
    for (const ws of rt.clients) ws.close(4004, "The VM stopped");
    running.delete(r.id);
    run("update local_vms set pid = null where id = ?", r.id);
    const failed = Boolean(error) || (child.exitCode !== null && child.exitCode !== 0);
    publish(r, failed ? "error" : "stopped", failed ? (rt.log || error?.message || "QEMU exited").slice(-2000) : "VM stopped. Its disk is kept.");
  };
  child.once("error", ended);
  child.once("exit", () => ended());
  try {
    await qmp.ready();
    await qmp.call("set_password", { protocol: "vnc", password: rt.password });
    await qmp.call("cont");
    return publish(r, "running", s.bootIso ? "Booting the ISO. Install onto the VM disk to keep your work." : "Booting the installed system");
  } catch (e) {
    // The guest is paused until cont. Failed initialization can be safely ended.
    if (!rt.finished) child.kill();
    throw new HttpError(503, `${(e as Error).message}. ${rt.log.slice(-1000)} Native acceleration requires the host hypervisor; choose Software to use TCG.`);
  }
}
export async function vmStatus(board: string, panel: string) {
  const r = row(board, panel), rt = running.get(r.id);
  if (locks.has(r.id)) return projection(r);
  if (rt) {
    const result = await rt.qmp.call("query-status");
    return publish(r, result.running ? "running" : "stopping", result.running ? null : "The guest has stopped its CPUs; use Power off if it has finished shutting down.");
  }
  if (r.pid) {
    try { process.kill(r.pid, 0); return publish(r, "error", "A VM from the previous server is still shutting down or running. Its disk is locked; finish shutting it down before starting again."); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") return publish(r, "error", "Cannot check the previous VM process. Its disk is kept; another copy will not be started.");
      run("update local_vms set pid = null where id = ?", r.id); r.pid = null;
    }
  }
  if (["running", "starting", "stopping"].includes(r.state)) return publish(r, "stopped", "The server restarted. The disk is kept; nothing starts automatically.");
  return publish(r);
}
export async function vmAction(board: string, panel: string, action: string, body: Record<string, unknown>, who: UserInfo) {
  const r = row(board, panel);
  if (locks.has(r.id)) throw new HttpError(409, "A VM action is already in progress");
  const work = (async () => {
    record(r, who, action);
    const rt = running.get(r.id);
    if (action === "start") return start(r);
    if (action === "shutdown") {
      if (!rt) return publish(r, "stopped");
      await rt.qmp.call("system_powerdown");
      return publish(r, "stopping", "Shutdown requested. Wait for the guest to finish; its disk is kept.");
    }
    if (action === "poweroff") {
      if (body.confirm !== true) throw new HttpError(400, "Force power off can lose unsaved work. Send confirm: true");
      if (!rt && r.pid) throw new HttpError(409, "This VM belongs to the previous server process. Shut it down on the host before starting another copy.");
      if (rt) await rt.qmp.call("quit");
      return projection(row(board, panel));
    }
    if (action === "boot") {
      if (rt) throw new HttpError(409, "Shut down the VM before changing its boot source");
      if (typeof body.iso !== "boolean") throw new HttpError(400, "iso must be true or false");
      const s: Settings = JSON.parse(r.settings); s.bootIso = body.iso === true;
      run("update local_vms set settings = ? where id = ?", JSON.stringify(s), r.id);
      return publish({ ...r, settings: JSON.stringify(s) });
    }
    if (action === "resources") {
      if (rt || r.pid) throw new HttpError(409, "Shut down the VM before changing its resources");
      const s: Settings = JSON.parse(r.settings), host = vmHost();
      const memory = body.memoryMB ?? s.memoryMB, cpus = body.cpus ?? s.cpus, accel = body.acceleration ?? s.acceleration;
      if (!Number.isInteger(memory) || Number(memory) < 512 || Number(memory) > host.maxMemoryMB) throw new HttpError(400, `Memory must be 512–${host.maxMemoryMB} MB`);
      if (!Number.isInteger(cpus) || Number(cpus) < 1 || Number(cpus) > host.maxCpus) throw new HttpError(400, `Processors must be 1–${host.maxCpus}`);
      if (accel !== "native" && accel !== "software") throw new HttpError(400, "Choose native or software acceleration");
      Object.assign(s, { memoryMB: Number(memory), cpus: Number(cpus), acceleration: accel });
      run("update local_vms set settings = ? where id = ?", JSON.stringify(s), r.id);
      return publish({ ...r, settings: JSON.stringify(s) });
    }
    if (action === "archive" || action === "restore") {
      if (rt || r.pid) throw new HttpError(409, "Shut down the VM before archiving/restoring it");
      if (action === "archive" && body.confirm !== true) throw new HttpError(400, "Archiving needs confirm: true. The disk and ISO are kept.");
      const archived = action === "archive" ? 1 : 0;
      run("update local_vms set archived = ? where id = ?", archived, r.id);
      return publish({ ...r, archived }, archived ? "archived" : "stopped");
    }
    throw new HttpError(404, "Unknown VM action");
  })();
  locks.set(r.id, work);
  try { return await work; } catch (e) { if (action === "start") publish(row(board, panel), "error", (e as Error).message); throw e; }
  finally { locks.delete(r.id); }
}
function live(board: string, panel: string) {
  const r = row(board, panel), rt = running.get(r.id);
  if (!rt) throw new HttpError(409, "Start the VM first");
  return { r, rt };
}
export function vmConsole(board: string, panel: string) { return { password: live(board, panel).rt.password }; }
export function attachVmConsole(board: string, panel: string, ws: WebSocket, user: UserInfo) {
  let rt: Running;
  try { rt = live(board, panel).rt; } catch { ws.close(4004, "The VM is not running"); return; }
  const socket = vmIo.connect(rt.port);
  rt.clients.add(ws);
  const close = () => { socket.destroy(); rt.clients.delete(ws); clearInterval(check); };
  const check = setInterval(() => { if (!canWrite(user.id, board) || !canSeeBoard(user, board)) ws.close(4003, "VM access was removed"); }, 1000);
  socket.on("data", (b) => { if (ws.readyState === 1) { if (ws.bufferedAmount > 8 * 1024 * 1024) ws.close(4004, "Console connection is too slow"); else ws.send(b); } });
  ws.on("message", (b, binary) => {
    if ((b as Buffer).byteLength > 1024 * 1024 || socket.writableLength > 1024 * 1024) { ws.close(4004, "Console input is too large"); return; }
    if (binary && canWrite(user.id, board) && canSeeBoard(user, board)) socket.write(b as Buffer);
  });
  ws.once("close", close); ws.once("error", close);
  socket.once("error", () => ws.close(4004, "QEMU's console is unavailable"));
  socket.once("close", () => { if (ws.readyState === 1) ws.close(4004, "QEMU's console closed"); close(); });
}
export const GUEST_SETUP = "sudo apt-get update && sudo apt-get install -y qemu-guest-agent && sudo systemctl start qemu-guest-agent";
export async function runVmCommand(board: string, panel: string, command: unknown, requestId: unknown, who: UserInfo) {
  if (typeof command !== "string" || !command.trim() || command.length > 16000) throw new HttpError(400, "Enter a guest command (up to 16,000 characters)");
  const { r, rt } = live(board, panel);
  if (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(requestId)) throw new HttpError(400, "request_id is required");
  const hash = createHash("sha256").update(command).digest("hex");
  const old = one<{ command_hash: string; generation: string; pid: number | null }>("select * from vm_command_requests where vm_id = ? and request_id = ?", r.id, requestId);
  if (old) {
    if (old.command_hash !== hash) throw new HttpError(409, "request_id was already used for a different command");
    if (old.generation === rt.generation && old.pid !== null) return { pid: old.pid, commandId: requestId };
    throw new HttpError(409, "This command was already submitted and its outcome is unknown. It will not be replayed.");
  }
  if (!rt.guest) throw new HttpError(409, "The guest agent is not connected. Open Terminal in the VM desktop and enable qemu-guest-agent first.");
  if (rt.commands.size >= 32) throw new HttpError(429, "Collect the results of earlier commands first");
  try { await rt.guest.call("guest-ping", undefined, 2000); }
  catch { throw new HttpError(409, `The guest agent has not answered. In the VM desktop's terminal run: ${GUEST_SETUP}`); }
  // Claim before sending. A timeout/crash may lose the answer; it must never run the command twice.
  const claimed = run("insert or ignore into vm_command_requests (vm_id,request_id,command_hash,generation) values (?,?,?,?)", r.id, requestId, hash, rt.generation);
  if (!claimed.changes) throw new HttpError(409, "This command is already being submitted");
  record(r, who, "command", { command });
  const out = await rt.guest.call("guest-exec", { path: "/bin/sh", arg: ["-lc", command], "capture-output": true });
  run("update vm_command_requests set pid = ? where vm_id = ? and request_id = ?", out.pid, r.id, requestId);
  rt.commands.set(requestId, out.pid);
  return { pid: out.pid, commandId: requestId };
}
export async function vmCommandResult(board: string, panel: string, commandId: string) {
  const { rt } = live(board, panel);
  if (rt.results.has(commandId)) return rt.results.get(commandId);
  const pid = rt.commands.get(commandId);
  if (pid === undefined || !rt.guest) throw new HttpError(404, "No command result here");
  const out = await rt.guest.call("guest-exec-status", { pid });
  const decode = (x: unknown) => typeof x === "string" ? Buffer.from(x, "base64").toString("utf8").slice(-200000) : "";
  const result = { exited: Boolean(out.exited), exitCode: out.exitcode ?? null, signal: out.signal ?? null, stdout: decode(out["out-data"]), stderr: decode(out["err-data"]), truncated: Boolean(out["out-truncated"] || out["err-truncated"]) };
  if (out.exited) { rt.commands.delete(commandId); rt.results.set(commandId, result); if (rt.results.size > 32) rt.results.delete(rt.results.keys().next().value!); }
  return result;
}

/** Server shutdown asks guests to shut down, never hard-kills a disk with unsaved work. */
export async function shutdownLocalVms() {
  await Promise.allSettled([...running.values()].map((rt) => rt.qmp.call("system_powerdown", undefined, 2000)));
}
