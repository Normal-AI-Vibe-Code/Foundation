/**
 * A machine's pipes (Josh, 2026-11-15: "piping information into a VM and
 * being clear about its outputs that I can pipe into another application").
 *
 * Every machine card has two ports, `in` and `out`, and two files inside it:
 *
 *   /foundation/in    what arrives on `in`, written when it changes: text as
 *                     text, anything else as one line of JSON
 *   /foundation/out   whatever the machine writes there is read back and
 *                     emitted on `out`: parsed as JSON when it parses, else
 *                     text. Stored in the card's `outputs`, by the server, so
 *                     wires and other apps receive it like any app's output.
 *
 * So `tr a-z A-Z </foundation/in >/foundation/out` in the machine's shell
 * upper-cases whatever is wired in and hands it on.
 *
 * What can be wired: an app's output port into `in`, and `out` into an app's
 * input port (the wires people drag on the agent layer). A note or a table
 * too, though they have no ports: a wire's end that names a note carries its
 * text, one that names a table carries its rows (or one cell, "B2"), and
 * `out` wired to a note or a table writes it there. Those ends are read and
 * written here, on the server.
 *
 * Cheap: a machine is watched only while someone has its card on screen (the
 * card's own poll is the heartbeat; that is also when it gets its two ports),
 * or while it is wired and someone has the board open. A watched machine is asked every 2 s for its out file's size
 * and checksum, and its contents only when those change; `in` is written only
 * when the value changes. Each is one exec through the engine, no terminal.
 */

import * as Y from "yjs";
import {
  boardMaps,
  cellRef,
  MACHINE_IN_PATH,
  MACHINE_IN_PORT,
  MACHINE_OUT_PATH,
  MACHINE_OUT_PORT,
  noteTextOf,
  NOTE_PORT,
  setNoteText,
  tableCellMap,
  tableCellsOf,
  uid,
  type LinkDoc,
  type MachineIo,
  type PanelDoc,
  type Port,
  type TableDoc,
} from "@foundation/protocol";
import { editBoard, getBoard, onBoardOpen } from "./boards.ts";
import { execRaw, execSh, machineHooks } from "./machines.ts";

const POLL_MS = Number(process.env.FOUNDATION_MACHINE_IO_MS ?? 2000);
/** how long one heartbeat keeps a machine watched */
const WATCH_MS = 20_000;
const IN_MAX = 64 * 1024;
const OUT_MAX = 256 * 1024;
const PREVIEW = 160;

const key = (b: string, p: string) => `${b}/${p}`;

// ---------- the two ports ----------

/** a machine card's in and out ports, made if the card doesn't have them */
export function ensureMachinePorts(boardId: string, panelId: string): { in: Port; out: Port } | null {
  const read = () => {
    const o = boardMaps(getBoard(boardId).doc).objects.get(panelId);
    if (!o || o.kind !== "panel" || o.panel !== "machine") return null;
    return { panel: o, in: o.ports.find((p) => p.dir === "in" && p.name === MACHINE_IN_PORT), out: o.ports.find((p) => p.dir === "out" && p.name === MACHINE_OUT_PORT) };
  };
  const had = read();
  if (!had) return null;
  if (had.in && had.out) return { in: had.in, out: had.out };
  return editBoard(boardId, "machines", (doc) => {
    const o = boardMaps(doc).objects.get(panelId) as PanelDoc;
    const inPort = o.ports.find((p) => p.dir === "in" && p.name === MACHINE_IN_PORT) ?? { id: uid("port"), name: MACHINE_IN_PORT, dir: "in" as const, type: "json" };
    // what comes out is text until the machine writes something that parses as JSON (tick sets it then)
    const outPort = o.ports.find((p) => p.dir === "out" && p.name === MACHINE_OUT_PORT) ?? { id: uid("port"), name: MACHINE_OUT_PORT, dir: "out" as const, type: "text" };
    const ports = [...o.ports.filter((p) => p !== inPort && p !== outPort), inPort, outPort];
    boardMaps(doc).objects.set(panelId, { ...o, ports });
    return { in: inPort, out: outPort };
  });
}

// ---------- what a wire's end carries ----------

/** a table's rows as typed: an array of rows, each an array of cells, trimmed to what's filled */
export function tableRows(doc: Y.Doc, table: TableDoc): string[][] {
  const cells = tableCellsOf(doc, table.id);
  let maxC = -1;
  let maxR = -1;
  for (const k of Object.keys(cells)) {
    if (!cells[k]) continue;
    const [c, r] = k.split(",").map(Number);
    maxC = Math.max(maxC, c);
    maxR = Math.max(maxR, r);
  }
  const rows: string[][] = [];
  for (let r = 0; r <= maxR; r++) rows.push(Array.from({ length: maxC + 1 }, (_, c) => cells[`${c},${r}`] ?? ""));
  return rows;
}

/** the value at a wire's source end: an app's last output, a note's text, a table's rows or one cell */
export function sourceValue(doc: Y.Doc, end: LinkDoc["from"]): unknown {
  const o = boardMaps(doc).objects.get(end.panel);
  if (!o) return undefined;
  if (o.kind === "panel") return o.outputs?.[end.port];
  if (o.kind === "note") return noteTextOf(doc, o);
  if (o.kind === "table") {
    const ref = cellRef(end.port);
    return ref ? (tableCellsOf(doc, o.id)[`${ref.c},${ref.r}`] ?? "") : tableRows(doc, o);
  }
  return undefined;
}

const asText = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

/** write a value where a wire ends on a note or a table (an app reads its own input through the wire). Call inside a transaction. */
export function deliver(doc: Y.Doc, end: LinkDoc["to"], value: unknown) {
  const m = boardMaps(doc);
  const o = m.objects.get(end.panel);
  if (!o) return;
  if (o.kind === "note") {
    setNoteText(doc, o.id, typeof value === "string" ? value : "```json\n" + JSON.stringify(value, null, 2) + "\n```");
    return;
  }
  if (o.kind !== "table") return;
  const map = tableCellMap(doc, o.id);
  const ref = cellRef(end.port);
  if (ref) {
    const text = asText(value);
    if (text) map.set(`${ref.c},${ref.r}`, text);
    else map.delete(`${ref.c},${ref.r}`);
    return;
  }
  // the whole table: rows of cells, a list of records (their keys head the columns), or one value in A1
  let rows: unknown[][];
  if (Array.isArray(value) && value.every((r) => Array.isArray(r))) rows = value as unknown[][];
  else if (Array.isArray(value) && value.length && value.every((r) => r && typeof r === "object" && !Array.isArray(r))) {
    const keys = [...new Set((value as Array<Record<string, unknown>>).flatMap((r) => Object.keys(r)))];
    rows = [keys, ...(value as Array<Record<string, unknown>>).map((r) => keys.map((k) => r[k]))];
  } else if (Array.isArray(value)) rows = value.map((v) => [v]);
  else rows = [[value]];
  rows = rows.slice(0, 500).map((r) => r.slice(0, 26));
  const want = new Map<string, string>();
  rows.forEach((r, ri) =>
    r.forEach((v, ci) => {
      const text = v === null || v === undefined ? "" : asText(v);
      if (text) want.set(`${ci},${ri}`, text);
    }),
  );
  for (const [k, v] of want) if (map.get(k) !== v) map.set(k, v);
  for (const k of [...map.keys()]) if (!want.has(k)) map.delete(k);
  const cols = Math.max(o.cols, ...rows.map((r) => r.length));
  if (cols !== o.cols || rows.length > o.rows) m.objects.set(o.id, { ...o, cols, rows: Math.max(o.rows, rows.length) });
}

/** what /foundation/out holds, as a value: JSON when it parses, else its text (one trailing newline dropped) */
export function parseOut(text: string): unknown {
  const t = text.replace(/\r?\n$/, "");
  const s = t.trim();
  if (s && /^[[{"\-0-9tfn]/.test(s)) {
    try {
      return JSON.parse(s);
    } catch {
      /* text */
    }
  }
  return t;
}

/** what goes in /foundation/in for a value: text as it is, anything else as one line of JSON; always ends with a newline */
export function inFile(value: unknown): string {
  const body = typeof value === "string" ? value : JSON.stringify(value);
  return body.endsWith("\n") ? body : `${body}\n`;
}

const preview = (s: string) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > PREVIEW ? `${t.slice(0, PREVIEW - 1)}…` : t;
};

// ---------- watching a machine ----------

interface Watch {
  boardId: string;
  panelId: string;
  until: number;
  timer: ReturnType<typeof setInterval>;
  busy: boolean;
  /** what was last written to /foundation/in */
  lastIn?: string;
  /** size.checksum of /foundation/out when it was last read */
  lastOutSig?: string;
}
const watches = new Map<string, Watch>();

function stop(w: Watch) {
  clearInterval(w.timer);
  watches.delete(key(w.boardId, w.panelId));
}

/** watch this machine's pipes for a while (a heartbeat: its card is on screen, or something was just wired to it) */
export function watchMachine(boardId: string, panelId: string, forMs = WATCH_MS) {
  const k = key(boardId, panelId);
  let w = watches.get(k);
  if (w) {
    w.until = Math.max(w.until, Date.now() + forMs);
    return;
  }
  w = { boardId, panelId, until: Date.now() + forMs, busy: false, timer: setInterval(() => void tick(k), POLL_MS) };
  w.timer.unref?.();
  watches.set(k, w);
  void tick(k);
}

function writeIo(boardId: string, panelId: string, patch: Partial<MachineIo>, more?: (doc: Y.Doc, panel: PanelDoc) => PanelDoc | void) {
  editBoard(boardId, "machines", (doc) => {
    const m = boardMaps(doc);
    const o = m.objects.get(panelId);
    if (!o || o.kind !== "panel" || !o.machine) return;
    const io: MachineIo = { ...(o.machine.io ?? {}), ...patch };
    for (const k of Object.keys(io) as Array<keyof MachineIo>) if (io[k] === undefined) delete io[k];
    let next: PanelDoc = { ...o, machine: { ...o.machine, io } };
    next = more?.(doc, next) ?? next;
    m.objects.set(panelId, next);
  });
}

/** for tests and the smoke script: one whole look, after any look already under way */
export async function lookNow(boardId: string, panelId: string): Promise<void> {
  const k = key(boardId, panelId);
  while (watches.get(k)?.busy) await new Promise((r) => setTimeout(r, 5));
  await tick(k);
}

/** one look at a watched machine: write `in` if what's wired to it changed, read `out` if the file changed */
async function tick(k: string): Promise<void> {
  const w = watches.get(k);
  if (!w || w.busy) return;
  w.busy = true;
  try {
    const board = getBoard(w.boardId);
    const m = boardMaps(board.doc);
    const panel = m.objects.get(w.panelId);
    if (!panel || panel.kind !== "panel" || panel.panel !== "machine" || panel.machine?.state !== "running") return stop(w);
    const ports = ensureMachinePorts(w.boardId, w.panelId);
    if (!ports) return stop(w);
    const links = [...m.links.values()];
    const into = links.filter((l) => l.to.panel === w.panelId && l.to.port === ports.in.id).sort((a, b) => a.id.localeCompare(b.id));
    const outOf = links.filter((l) => l.from.panel === w.panelId && l.from.port === ports.out.id);
    // nobody looking: keep going only while it's wired and someone has the board open
    if (Date.now() > w.until && !((into.length || outOf.length) && board.conns.size > 0)) return stop(w);

    // in: the first wire's value (one source feeds a machine), written when it changes
    const value = into.length ? sourceValue(board.doc, into[0].from) : undefined;
    if (value !== undefined) {
      let body = inFile(value);
      let note: string | undefined;
      if (Buffer.byteLength(body) > IN_MAX) {
        body = Buffer.from(body).subarray(0, IN_MAX).toString("utf8");
        note = `What's wired to in is larger than ${IN_MAX / 1024} KB: the first ${IN_MAX / 1024} KB were written.`;
      }
      if (body !== w.lastIn) {
        const dir = MACHINE_IN_PATH.slice(0, MACHINE_IN_PATH.lastIndexOf("/"));
        await execSh(w.boardId, w.panelId, `mkdir -p ${dir} && printf %s "$1" | base64 -d > ${MACHINE_IN_PATH}.tmp && mv -f ${MACHINE_IN_PATH}.tmp ${MACHINE_IN_PATH}`, { args: [Buffer.from(body).toString("base64")], timeoutS: 15 });
        w.lastIn = body;
        writeIo(w.boardId, w.panelId, { inPreview: preview(body), inBytes: Buffer.byteLength(body), inAt: Date.now(), error: note });
      }
    }

    // out: its size and checksum each time; its contents when those change
    const r = await execRaw(
      w.boardId,
      w.panelId,
      ["/bin/sh", "-c", `f=${MACHINE_OUT_PATH}; [ -f "$f" ] || exit 0; s="$(wc -c <"$f" | tr -d ' ').$(head -c ${OUT_MAX} "$f" | cksum | cut -d' ' -f1)"; echo "$s"; [ "$s" = "$1" ] || head -c ${OUT_MAX} "$f"`, "foundation", w.lastOutSig ?? ""],
      { timeoutS: 15, maxBytes: OUT_MAX + 256 },
    );
    if (r.exitCode !== 0) throw new Error(r.stderr.trim().split("\n").at(-1) || `reading ${MACHINE_OUT_PATH}: exit ${r.exitCode ?? "unknown"}`);
    const nl = r.stdout.indexOf(0x0a);
    if (nl < 0) return; // no out file yet
    const sig = r.stdout.subarray(0, nl).toString("utf8").trim();
    if (!sig || sig === w.lastOutSig) return;
    const text = r.stdout.subarray(nl + 1).toString("utf8");
    const bytes = Number(sig.split(".")[0]) || Buffer.byteLength(text);
    const out = parseOut(text);
    w.lastOutSig = sig;
    writeIo(
      w.boardId,
      w.panelId,
      { outPreview: preview(text), outBytes: bytes, outAt: Date.now(), error: bytes > OUT_MAX ? `${MACHINE_OUT_PATH} is larger than ${OUT_MAX / 1024} KB: the first ${OUT_MAX / 1024} KB were read.` : undefined },
      (doc, p) => {
        // a note or a table at the other end is written here; an app reads the card's output through its wire
        for (const l of outOf) deliver(doc, l.to, out);
        // the port says what came out (2026-11-17): text, or JSON when what it wrote parses as more than a string
        const type = typeof out === "string" ? "text" : "json";
        const typed = p.ports.map((x) => (x.id === ports.out.id && x.type !== type ? { ...x, type } : x));
        return { ...p, ports: typed, outputs: { ...(p.outputs ?? {}), [ports.out.id]: out } };
      },
    );
  } catch (e) {
    const why = (e as Error).message.slice(0, 200);
    try {
      const cur = boardMaps(getBoard(w.boardId).doc).objects.get(w.panelId);
      if (cur && cur.kind === "panel" && cur.machine && cur.machine.io?.error !== why && cur.machine.state === "running") writeIo(w.boardId, w.panelId, { error: why });
    } catch {
      /* the board went */
    }
  } finally {
    w.busy = false;
  }
}

// a card on screen: its pipes are watched, and it has its ports
machineHooks.seen.push((boardId, panelId) => {
  ensureMachinePorts(boardId, panelId);
  watchMachine(boardId, panelId);
});
machineHooks.ended.push((boardId, panelId, why) => {
  const w = watches.get(key(boardId, panelId));
  if (w) stop(w);
  // a removed machine's files went with its disk
  if (why === "removed") {
    try {
      editBoard(boardId, "machines", (doc) => {
        const o = boardMaps(doc).objects.get(panelId);
        if (!o || o.kind !== "panel") return;
        const out = o.ports.find((p) => p.dir === "out" && p.name === MACHINE_OUT_PORT);
        if (!out || o.outputs?.[out.id] === undefined) return;
        const { [out.id]: _gone, ...rest } = o.outputs;
        boardMaps(doc).objects.set(panelId, { ...o, outputs: rest });
      });
    } catch {
      /* the card went too */
    }
  }
});

/** a board that opens with running, wired machines: watch them (they stop by themselves when nobody has the board open) */
export function startMachineIo() {
  onBoardOpen((b) =>
    queueMicrotask(() => {
      const m = boardMaps(b.doc);
      const wired = new Set([...m.links.values()].flatMap((l) => [l.from.panel, l.to.panel]));
      for (const o of m.objects.values()) if (o.kind === "panel" && o.panel === "machine" && o.machine?.state === "running" && wired.has(o.id)) watchMachine(b.id, o.id);
    }),
  );
}

/** the wires at a machine's ports, named for an agent's read: where `in` comes from, where `out` goes */
export function describeIo(boardId: string, panel: PanelDoc) {
  const doc = getBoard(boardId).doc;
  const m = boardMaps(doc);
  const inPort = panel.ports.find((p) => p.dir === "in" && p.name === MACHINE_IN_PORT);
  const outPort = panel.ports.find((p) => p.dir === "out" && p.name === MACHINE_OUT_PORT);
  const name = (id: string) => (m.objects.get(id) as { name?: string } | undefined)?.name ?? id;
  const links = [...m.links.values()];
  return {
    in: { path: MACHINE_IN_PATH, from: inPort ? links.filter((l) => l.to.panel === panel.id && l.to.port === inPort.id).map((l) => name(l.from.panel)) : [], last: panel.machine?.io?.inPreview ?? null },
    out: { path: MACHINE_OUT_PATH, to: outPort ? links.filter((l) => l.from.panel === panel.id && l.from.port === outPort.id).map((l) => name(l.to.panel)) : [], last: panel.machine?.io?.outPreview ?? null },
    ...(panel.machine?.io?.error ? { error: panel.machine.io.error } : {}),
  };
}

/** for tests and shutdown */
export function stopMachineIo() {
  for (const w of [...watches.values()]) stop(w);
}

export { NOTE_PORT };

/**
 * A person's press on the card's Ins & outs (2026-11-17, Josh: "try to get that vm to output something and pipe it into
 * a card"): the machine writes one line to /foundation/out (its name and the time, from inside it), and the server reads
 * it back at once, so whatever `out` is wired to shows it. It runs a command in the machine: index.ts lets only a
 * person who can write the board press it.
 */
export async function tryOut(boardId: string, panelId: string): Promise<MachineIo | undefined> {
  const dir = MACHINE_OUT_PATH.slice(0, MACHINE_OUT_PATH.lastIndexOf("/")) || "/";
  await execSh(boardId, panelId, `mkdir -p ${dir} && printf 'Hello from %s at %s\n' "$(hostname)" "$(date -u +%H:%M:%S) UTC" > ${MACHINE_OUT_PATH}`, { timeoutS: 15 });
  watchMachine(boardId, panelId);
  await lookNow(boardId, panelId);
  const p = boardMaps(getBoard(boardId).doc).objects.get(panelId) as PanelDoc | undefined;
  return p?.machine?.io;
}
