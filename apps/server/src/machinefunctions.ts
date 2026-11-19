/**
 * A machine's functions (2026-11-17, Josh: "the exposing of data outputs and inputs needs a re-design and should
 * have some functions that are able to reach into the VM … it would be good to build an example of that on the
 * Character studio").
 *
 * A function is an executable in the machine at /foundation/functions/<name>, so anyone can add one from its
 * terminal. Its first comment lines say what it is, what it takes and what it gives (`# about:`, `# in:`,
 * `# out:`; images, text, json or files). Foundation reads them while the card is looked at, and gives each a
 * pair of ports on the card, `fn:<name>` in and out, so it is wired like anything else:
 *
 *   - **in**: what's wired there: a collection's pictures, an image card's picture (files go in one each)
 *   - **run**: a person's press (it runs code in the machine): the pictures are copied into a fresh folder
 *     (the Engine API's archive upload), the function runs with IN and OUT set to it, as root, ten minutes at
 *     most, and what it left in OUT is copied back. Only the pictures it hasn't had yet, unless asked for all.
 *   - **out**: pictures it made go into the archive and into every collection wired from its out port;
 *     text or JSON it wrote (out.txt, out.json) is kept on the card with the run.
 *
 * The example (the studio's): **Process in a machine** on a collection lays a machine and a second collection
 * beside it, wired collection → `fn:trim-resize` → collection. Its Start installs ImageMagick and three picture
 * functions (trim-resize, sprite-sheet, describe).
 */

import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { boardMaps, logActivity, uid, type LinkDoc, type MachineFunction, type MachineFunctionKind, type PanelDoc, type Port } from "@foundation/protocol";
import { editBoard, getBoard } from "./boards.ts";
import { COLLECTION_W, collectionOf, collectionPorts, putIn } from "./collections.ts";
import { growForFlow } from "./characters.ts";
import { fileBytesSync, storeFile } from "./files.ts";
import { HttpError } from "./http.ts";
import { engineCall, execRaw, execSh, findContainer, machineHooks, machinePanel, writeMachine } from "./machines.ts";
import { packTar, readTar } from "./tarlite.ts";

export const FN_DIR = "/foundation/functions";
const KINDS: MachineFunctionKind[] = ["images", "text", "json", "files"];
const kindOf = (s: string | undefined, fallback: MachineFunctionKind): MachineFunctionKind => (KINDS.includes(s as MachineFunctionKind) ? (s as MachineFunctionKind) : fallback);

/** what the listing script prints, read into functions: "@@ name" then its header lines */
export function parseFunctions(text: string): MachineFunction[] {
  const out: MachineFunction[] = [];
  let cur: { name: string; about?: string; in?: string; out?: string } | null = null;
  const done = () => cur && out.push({ name: cur.name, ...(cur.about ? { about: cur.about } : {}), in: kindOf(cur.in, "files"), out: kindOf(cur.out, "files") });
  for (const line of text.split("\n")) {
    const at = /^@@ (\S+)\s*$/.exec(line);
    if (at) {
      done();
      cur = /^[A-Za-z0-9._-]{1,48}$/.test(at[1]) ? { name: at[1] } : null;
      continue;
    }
    const h = /^#\s*(about|in|out)\s*:\s*(.*)$/i.exec(line.trim());
    if (cur && h) cur[h[1].toLowerCase() as "about" | "in" | "out"] = h[2].trim().slice(0, 200);
  }
  done();
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const LIST = `d=${FN_DIR}; [ -d "$d" ] || exit 0
for f in "$d"/*; do [ -f "$f" ] && [ -x "$f" ] || continue; echo "@@ $(basename "$f")"; head -n 12 "$f" | grep -E '^#[[:space:]]*(about|in|out)[[:space:]]*:' || true; done`;

/** the ports a function has on the card: `fn:<name>` in and out */
export const fnPortName = (name: string) => `fn:${name}`;

/** each function's ports made (kept for one that went, so its wires stay until a person takes them off) */
export function ensureFunctionPorts(boardId: string, panelId: string, fns: Array<Pick<MachineFunction, "name">>): void {
  const o = boardMaps(getBoard(boardId).doc).objects.get(panelId);
  if (!o || o.kind !== "panel") return;
  const missing = fns.filter((f) => !o.ports.some((p) => p.name === fnPortName(f.name) && p.dir === "in") || !o.ports.some((p) => p.name === fnPortName(f.name) && p.dir === "out"));
  if (!missing.length) return;
  editBoard(boardId, "machines", (doc) => {
    const cur = boardMaps(doc).objects.get(panelId) as PanelDoc;
    const ports = [...cur.ports];
    for (const f of missing) {
      for (const dir of ["in", "out"] as const) if (!ports.some((p) => p.name === fnPortName(f.name) && p.dir === dir)) ports.push({ id: uid("port"), name: fnPortName(f.name), dir, type: "any" });
    }
    boardMaps(doc).objects.set(panelId, { ...cur, ports });
  });
}

const lastRead = new Map<string, number>();

/** reads the machine's functions and writes them on the card when they changed (at most every 10 s a card) */
export async function readFunctions(boardId: string, panelId: string, force = false): Promise<MachineFunction[]> {
  const k = `${boardId}/${panelId}`;
  const m = machinePanel(boardId, panelId).machine;
  if (!force && Date.now() - (lastRead.get(k) ?? 0) < 10_000) return m?.functions ?? [];
  lastRead.set(k, Date.now());
  const found = parseFunctions(await execSh(boardId, panelId, LIST, { timeoutS: 15 }));
  // a run's record stays with its function
  const was = new Map((m?.functions ?? []).map((f) => [f.name, f]));
  const next = found.map((f) => ({ ...f, ...(was.get(f.name)?.last ? { last: was.get(f.name)!.last } : {}) }));
  if (JSON.stringify(next) !== JSON.stringify(m?.functions ?? [])) writeMachine(boardId, panelId, { functions: next.length ? next : undefined });
  ensureFunctionPorts(boardId, panelId, next);
  return next;
}

// ---------- what's wired in, and where it goes ----------

interface Wired {
  key: string;
  fileId: string;
  name: string;
}

/** the pictures wired into a function: a collection's, an image card's */
export function wiredInto(boardId: string, panelId: string, fn: string): Wired[] {
  const doc = getBoard(boardId).doc;
  const m = boardMaps(doc);
  const card = m.objects.get(panelId);
  if (!card || card.kind !== "panel") return [];
  const port = card.ports.find((p) => p.dir === "in" && p.name === fnPortName(fn));
  if (!port) return [];
  const out: Wired[] = [];
  for (const l of m.links.values()) {
    if (l.to.panel !== panelId || l.to.port !== port.id) continue;
    const from = m.objects.get(l.from.panel);
    if (!from || from.kind !== "panel") continue;
    if (from.panel === "collection") for (const it of collectionOf(doc, from.id).items) if (it.fileId) out.push({ key: it.key, fileId: it.fileId, name: it.name });
    if (from.fileId && /^image\//.test(from.mime ?? "")) out.push({ key: `file:${from.fileId}`, fileId: from.fileId, name: from.name });
  }
  const seen = new Set<string>();
  return out.filter((w) => !seen.has(w.key) && seen.add(w.key));
}


/** per function, what's wired: how many pictures in (and how many it hasn't had), and the cards on each end */
export function functionWiring(boardId: string, panelId: string): Record<string, { total: number; fresh: number; from: string[]; to: string[] }> {
  const m = boardMaps(getBoard(boardId).doc);
  const card = m.objects.get(panelId);
  if (!card || card.kind !== "panel") return {};
  const out: Record<string, { total: number; fresh: number; from: string[]; to: string[] }> = {};
  const names = new Set(card.ports.filter((p) => p.name.startsWith("fn:")).map((p) => p.name.slice(3)));
  for (const fn of names) {
    const done = new Set(card.machine?.fnDone?.[fn] ?? []);
    const wired = wiredInto(boardId, panelId, fn);
    const inPort = card.ports.find((p) => p.dir === "in" && p.name === fnPortName(fn));
    const from = [...m.links.values()].filter((l) => l.to.panel === panelId && l.to.port === inPort?.id).map((l) => m.objects.get(l.from.panel)?.name ?? "a card");
    const to = wiredFrom(boardId, panelId, fn).map((id) => m.objects.get(id)?.name ?? "a collection");
    out[fn] = { total: wired.length, fresh: wired.filter((w) => !done.has(w.key)).length, from, to };
  }
  return out;
}

/** the collections a function's out port is wired to */
function wiredFrom(boardId: string, panelId: string, fn: string): string[] {
  const m = boardMaps(getBoard(boardId).doc);
  const card = m.objects.get(panelId);
  if (!card || card.kind !== "panel") return [];
  const port = card.ports.find((p) => p.dir === "out" && p.name === fnPortName(fn));
  if (!port) return [];
  return [...m.links.values()].filter((l) => l.from.panel === panelId && l.from.port === port.id).map((l) => l.to.panel).filter((id) => {
    const o = m.objects.get(id);
    return o?.kind === "panel" && o.panel === "collection";
  });
}

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml", json: "application/json", txt: "text/plain", csv: "text/csv", glb: "model/gltf-binary", zip: "application/zip" };
export const mimeOf = (name: string) => MIME[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
/** a file name safe in the machine's folder: letters, digits, . _ -, at most 80 */
export const safeName = (name: string, i: number) => `${String(i + 1).padStart(3, "0")}-${name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+/, "").slice(-72) || "file"}`;

export interface FunctionRun {
  ok: boolean;
  /** what went in */
  took: number;
  /** files it made, kept in the archive */
  made: Array<{ id: string; name: string; mime: string }>;
  /** what it wrote as text or JSON (out.txt / out.json), the start of it */
  text?: string;
  /** its last words on stderr, or why it failed */
  said?: string;
  /** collections the pictures went into */
  into: string[];
}

const running = new Set<string>();

/** runs a function on what's wired into it (a person's press; the route checks) */
export async function runFunction(boardId: string, panelId: string, name: string, opts: { all?: boolean; text?: string }, person: { name: string; id: string }): Promise<FunctionRun> {
  const card = machinePanel(boardId, panelId);
  const m = card.machine;
  if (m?.state !== "running") throw new HttpError(409, `${m?.name ?? "The machine"} isn't running.`);
  const fns = await readFunctions(boardId, panelId, true);
  const fn = fns.find((f) => f.name === name);
  if (!fn) throw new HttpError(404, `${m.name} has no function ${name} (an executable in ${FN_DIR}).`);
  const k = `${boardId}/${panelId}/${name}`;
  if (running.has(k)) throw new HttpError(409, `${name} is running already.`);
  running.add(k);
  try {
    const found = await findContainer(boardId, panelId, m.engine);
    if (!found) throw new HttpError(409, `${m.name} isn't on its engine.`);
    const { engine, c } = found;
    const done = new Set(m.fnDone?.[name] ?? []);
    const wired = wiredInto(boardId, panelId, name);
    const todo = opts.all ? wired : wired.filter((w) => !done.has(w.key));
    if (!todo.length && opts.text === undefined) throw new HttpError(409, wired.length ? `${name} has had every picture wired into it. Run it on all of them again, or wire in more.` : `Nothing is wired into ${name} yet: wire a collection (or an image) into its in port.`);
    const id = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
    const base = `foundation/runs/${id}`;
    const files = todo.map((w, i) => ({ w, f: fileBytesSync(w.fileId) })).filter((x) => x.f);
    const tar = packTar([
      { name: "foundation/", dir: true },
      { name: "foundation/runs/", dir: true },
      { name: `${base}/`, dir: true },
      { name: `${base}/in/`, dir: true },
      { name: `${base}/out/`, dir: true },
      ...files.map(({ w, f }, i) => ({ name: `${base}/in/${safeName(f!.row.name || w.name, i)}`, body: f!.body })),
      ...(opts.text !== undefined ? [{ name: `${base}/in/in.txt`, body: Buffer.from(opts.text, "utf8") }] : []),
    ]);
    const put = await engineCall(engine, "PUT", `/containers/${c.Id}/archive?path=/`, { upload: Readable.from(tar), timeoutMs: 120_000 });
    if (put.status >= 400) throw new HttpError(502, `${engine.name} wouldn't take the files: ${put.body.toString("utf8").slice(0, 200)}`);
    const t0 = Date.now();
    const r = await execRaw(boardId, panelId, ["/bin/sh", "-c", 'cd "$IN" && exec "$0"', `${FN_DIR}/${name}`], { env: [`IN=/${base}/in`, `OUT=/${base}/out`], timeoutS: 600, user: "0", maxBytes: 64 * 1024 });
    // what it left, back as a tar made in the machine: Kiri never ends the Engine API's archive download (2026-11-17)
    const got = await execRaw(boardId, panelId, ["tar", "-cf", "-", "-C", `/${base}/out`, "."], { timeoutS: 120, user: "0", maxBytes: 256 * 1024 * 1024 });
    void execRaw(boardId, panelId, ["rm", "-rf", `/${base}`], { timeoutS: 30, user: "0" }).catch(() => {});
    if (got.cut) throw new HttpError(413, `${name} made more than 256 MB: too much to bring back`);
    const outs = got.exitCode === 0 ? readTar(got.stdout).map((e) => ({ name: e.name.split("/").pop()!, body: e.body })).filter((e) => e.name) : [];
    const ok = r.exitCode === 0;
    const said = (r.stderr.trim() || r.stdout.toString("utf8").trim()).split("\n").slice(-3).join(" ").slice(-300) || undefined;
    let text: string | undefined;
    const made: FunctionRun["made"] = [];
    for (const o of outs) {
      if (o.name === "out.txt" || o.name === "out.json") {
        text = o.body.toString("utf8").slice(0, 4000);
        continue;
      }
      const row = await storeFile(o.body, { name: o.name, mime: mimeOf(o.name), boardId, userId: person.id, about: `made by ${name} in the machine ${m.name}` });
      made.push({ id: row.id, name: row.name, mime: row.mime });
    }
    const into = wiredFrom(boardId, panelId, name);
    for (const coll of into) for (const f of made) if (/^image\//.test(f.mime)) putIn(boardId, coll, { file: f.id }, person.name);
    // what it has had, so the next press takes only what's new (the last 400)
    const nextDone = ok ? [...new Set([...(m.fnDone?.[name] ?? []), ...todo.map((w) => w.key)])].slice(-400) : m.fnDone?.[name];
    const cur = machinePanel(boardId, panelId).machine!;
    const last = { at: Date.now(), by: person.name, ok, took: files.length, made: made.length, ms: Date.now() - t0, ...(said && !ok ? { said } : {}), ...(text ? { text: text.slice(0, 600) } : {}) };
    writeMachine(
      boardId,
      panelId,
      { functions: (cur.functions ?? []).map((f) => (f.name === name ? { ...f, last } : f)), fnDone: { ...(cur.fnDone ?? {}), ...(nextDone ? { [name]: nextDone } : {}) } },
      { who: person.name, role: "human", text: ok ? `ran ${name} in ${m.name} on ${files.length} picture${files.length === 1 ? "" : "s"}: ${made.length} made` : `ran ${name} in ${m.name}: it failed (${r.timedOut ? "it ran out of time" : `exit ${r.exitCode}`})` },
    );
    if (!ok) throw new HttpError(502, `${name} failed (${r.timedOut ? "ten minutes passed" : `exit ${r.exitCode ?? "unknown"}`})${said ? `: ${said}` : ""}`);
    return { ok, took: files.length, made, text, said, into };
  } finally {
    running.delete(k);
  }
}

// ---------- the example: ImageMagick and three picture functions ----------

const EXAMPLES: Record<string, string> = {
  "trim-resize": `#!/bin/sh
# about: Trims the empty edges off each picture and fits it in 1024 × 1024
# in: images
# out: images
set -e
M=$(command -v magick || command -v convert)
for f in "$IN"/*; do
  [ -f "$f" ] || continue
  n=$(basename "$f"); n=\${n%.*}
  "$M" "$f" -trim +repage -resize '1024x1024>' "$OUT/$n.png"
done
`,
  "sprite-sheet": `#!/bin/sh
# about: Lays every picture side by side in one sheet, 512 px tall, in the order they came
# in: images
# out: images
set -e
ls "$IN"/* >/dev/null 2>&1 || { echo "nothing came in" >&2; exit 1; }
M=$(command -v magick || command -v convert)
"$M" "$IN"/* -resize 'x512>' -background none +append "$OUT/sheet.png"
`,
  describe: `#!/bin/sh
# about: Says each picture's size and how many colours it has, as JSON
# in: images
# out: json
set -e
if command -v identify >/dev/null 2>&1; then I=identify; else I="magick identify"; fi
first=1
printf '[' > "$OUT/out.json"
for f in "$IN"/*; do
  [ -f "$f" ] || continue
  [ $first = 1 ] || printf ',' >> "$OUT/out.json"; first=0
  $I -format '{"name":"%f","w":%w,"h":%h,"colors":%k}' "$f" >> "$OUT/out.json"
done
printf ']\\n' >> "$OUT/out.json"
`,
};

export const EXAMPLE_NAMES = Object.keys(EXAMPLES);

/** the install script: ImageMagick by apt or apk, then the three functions */
export function examplesScript(): string {
  const writes = Object.entries(EXAMPLES)
    .map(([n, body]) => `cat > ${FN_DIR}/${n} <<'FOUNDATION_FN'\n${body}FOUNDATION_FN\nchmod +x ${FN_DIR}/${n}`)
    .join("\n");
  return `set -e
if command -v magick >/dev/null 2>&1 || command -v convert >/dev/null 2>&1; then :
elif command -v apt-get >/dev/null 2>&1; then apt-get update -qq >/dev/null 2>&1 || true; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends imagemagick >/dev/null
elif command -v apk >/dev/null 2>&1; then apk add --no-cache imagemagick >/dev/null
else echo "No recipe: this image has neither apt nor apk, so ImageMagick can't go in. Add your own functions in ${FN_DIR}." >&2; exit 42
fi
mkdir -p ${FN_DIR}
${writes}
echo installed`;
}

const installing = new Set<string>();

/** installs ImageMagick and the example functions (a person's press, or the Start of a machine laid for it) */
export function installExamples(boardId: string, panelId: string, person: string): { started: boolean } {
  const k = `${boardId}/${panelId}`;
  if (installing.has(k)) return { started: false };
  const m = machinePanel(boardId, panelId).machine;
  if (m?.state !== "running") throw new HttpError(409, `${m?.name ?? "The machine"} isn't running.`);
  installing.add(k);
  writeMachine(boardId, panelId, { fnSetup: { state: "installing", by: person, at: Date.now() } }, { who: person, role: "human", text: `is putting ImageMagick and three picture functions into ${m.name}` });
  void execSh(boardId, panelId, examplesScript(), { timeoutS: 900 })
    .then(async () => {
      writeMachine(boardId, panelId, { fnSetup: undefined, wantFunctions: undefined });
      await readFunctions(boardId, panelId, true);
    })
    .catch((e: Error) => writeMachine(boardId, panelId, { fnSetup: { state: "error", by: person, at: Date.now(), detail: e.message.slice(0, 400) } }))
    .finally(() => installing.delete(k));
  return { started: true };
}

// read a machine's functions while its card is looked at; a machine laid for the example gets them when it runs
machineHooks.seen.push((b, p) => void readFunctions(b, p).catch(() => {}));
machineHooks.started.push((b, p, person) => {
  try {
    if (machinePanel(b, p).machine?.wantFunctions) installExamples(b, p, person);
  } catch {
    /* the card is gone */
  }
});

// ---------- the studio's example: Process in a machine ----------

const MACHINE_W = 680;
const MACHINE_H = 520;

/**
 * Beside a collection: a machine (Ubuntu; its Start installs the example functions) and a second collection,
 * wired collection → fn:trim-resize → collection. The cards float in the collection's section, to its right.
 */
export function addMachineStep(boardId: string, collectionId: string, by: string): { machine: string; collection: string } {
  return editBoard(boardId, "machines", (doc) => {
    const m = boardMaps(doc);
    const coll = m.objects.get(collectionId);
    if (!coll || coll.kind !== "panel" || coll.panel !== "collection") throw new HttpError(404, "no such collection on this board");
    const fn = "trim-resize";
    const x0 = (coll.x ?? 0) + (coll.w ?? COLLECTION_W) + 56;
    const name = `${coll.name.replace(/^(Collected|Processed) · /, "")}`.slice(0, 30) || "pictures";
    const inPort: Port = { id: uid("port"), name: fnPortName(fn), dir: "in", type: "any" };
    const outPort: Port = { id: uid("port"), name: fnPortName(fn), dir: "out", type: "any" };
    const machine: PanelDoc = {
      id: uid("pnl"),
      kind: "panel",
      panel: "machine",
      sectionId: coll.sectionId,
      name: `picture box`,
      x: x0,
      y: coll.y ?? 0,
      float: true,
      bornAt: Date.now(),
      w: MACHINE_W,
      h: MACHINE_H,
      ports: [inPort, outPort],
      text: `Processes the pictures of ${coll.name}`,
      createdBy: by,
      machine: { name: `picture-box-${randomBytes(2).toString("hex")}`, image: "ubuntu:24.04", state: "absent", wantFunctions: true, detail: "Start runs it and puts ImageMagick and three picture functions in it (trim-resize, sprite-sheet, describe)." },
    };
    const out: PanelDoc = { id: uid("pnl"), kind: "panel", panel: "collection", sectionId: coll.sectionId, name: `Processed · ${name}`, x: x0 + MACHINE_W + 56, y: coll.y ?? 0, float: true, bornAt: Date.now(), w: COLLECTION_W, h: coll.h ?? 420, ports: collectionPorts(), createdBy: by };
    m.objects.set(machine.id, machine);
    m.objects.set(out.id, out);
    m.collections.set(out.id, { items: [] });
    const fromColl = coll.ports.find((p) => p.dir === "out")!;
    const toColl = out.ports.find((p) => p.dir === "in")!;
    const l1: LinkDoc = { id: uid("lnk"), from: { panel: coll.id, port: fromColl.id }, to: { panel: machine.id, port: inPort.id }, label: fn, createdBy: by };
    const l2: LinkDoc = { id: uid("lnk"), from: { panel: machine.id, port: outPort.id }, to: { panel: out.id, port: toColl.id }, label: fn, createdBy: by };
    m.links.set(l1.id, l1);
    m.links.set(l2.id, l2);
    const sec = m.sections.get(coll.sectionId);
    if (sec) growForFlow(doc, sec, x0 + MACHINE_W + 56 + COLLECTION_W + 56);
    logActivity(doc, { who: by, role: "human", text: `laid a machine after ${coll.name} to process its pictures (${fn}), into ${out.name}`, objectId: machine.id });
    return { machine: machine.id, collection: out.id };
  });
}
