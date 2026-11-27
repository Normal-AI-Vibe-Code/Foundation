/**
 * FactoryForm's digital twin, read from Foundation (2026-11-27, Josh: "in Foundation we should be able to see
 * FactoryForm in one of the sections and the digital twin … create a grid for this").
 *
 * FactoryForm serves a read-only twin contract, `factoryform.twin/1` (FactoryForm's docs/TWIN_API.md):
 *
 *   GET /api/twin/v1            the manifest: facilities, stations with twins, links, `ui.stale`
 *   GET /api/twin/v1/state      stations now (with provenance), open alerts, the simulated run, the sim bridge
 *   GET /api/twin/v1/stream     SSE `state`: the same document, on every change (≤ 4 a second)
 *   GET /api/control/v1         (optional) task names and step counts, so a run reads "step 4 of 11"
 *
 * Here:
 *   - `readFactoryTwin` reads the manifest and the state into one `FactoryTwin`: honest when FactoryForm is down
 *     (it throws, and the connector says why) and when it is older (no /api/twin/v1: `{ ok: false, older }`);
 *   - `twinConnectorState` is the `factoryform-twin` connector's answer: its main list is the stations as the
 *     twin has them (provenance included, never hidden), and its detail carries the run, the pages and the CAD;
 *   - the stream's latest state is kept (`takeStreamedState`) so a card refreshing four times a second costs
 *     FactoryForm nothing more than the stream it already sends;
 *   - `startFactoryForm` is the press that runs FactoryForm's own launcher in its sibling checkout, when it isn't
 *     answering: an admin, a person, at the server's own computer (a third-party program never starts without one);
 *   - `layFactoryTwin` lays the FactoryForm section: the floor twin and a station twin as frames, the stations
 *     table wired from the twin, the simulated run, and the CAD downloads.
 *
 * Nothing here writes to FactoryForm. Driving a run is Control's, under FactoryForm's own rules.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appendSection, boardMaps, putNote, TABLE_PORT, uid, type LinkDoc, type NoteDoc, type PanelDoc, type TableDoc } from "@foundation/protocol";
import { siblingDir } from "../../../scripts/siblings.mjs";
import { audit } from "./audit.ts";
import { childOptions, spawnChild } from "./child.ts";
import { listApps, saveApp } from "./apps.ts";
import { editBoard } from "./boards.ts";
import { config } from "./config.ts";
import { requireLocalFeature } from "./hosted.ts";
import { HttpError } from "./http.ts";
import type { UserInfo } from "@foundation/protocol";

export const TWIN_CONNECTOR = "factoryform-twin";
export const TWIN_SCHEMA = "factoryform.twin/1";

/** FactoryForm's address, as the connector reads it (FACTORYFORM_URL) */
export const factoryBase = () => config.connectors.factoryform.replace(/\/$/, "");

export interface TwinStation {
  id: string;
  name: string;
  shortName?: string;
  status: string;
  wip?: number;
  capacity?: number;
  cycleMinutes?: number;
  provenance?: string;
  humanVerified?: boolean;
  lastObservedAt?: string | null;
  equipment?: string | null;
  twin?: boolean;
}

export interface TwinRun {
  id: string;
  station: string;
  task: string;
  state: string;
  t: number;
  seconds: number;
  speed?: number;
  loop?: boolean;
  step: { index: number; id: string; label: string } | null;
  startedAt?: string;
  endedAt?: string | null;
  by?: string | null;
  source?: string | null;
  simulated: true;
}

interface Manifest {
  schema: string;
  revision?: string;
  ui?: { built?: boolean; builtAt?: string | null; sourceAt?: string | null; stale?: boolean };
  facilities?: Array<{ id: string; name: string; floor?: string | null }>;
  stations?: Array<{ id: string; cell?: string; name: string; facility?: string }>;
  links?: Record<string, string>;
}

interface StateDoc {
  schema: string;
  at?: string;
  facility?: { id: string; name: string };
  layout?: { source?: string; revision?: number | null };
  stations?: TwinStation[];
  alerts?: { open?: number };
  run?: (Omit<TwinRun, "simulated"> & { simulated?: boolean; robots?: unknown; io?: unknown; origin?: unknown }) | null;
  sim?: { session?: { id?: string; state?: string; simulator?: string } | null; lastFrameAt?: string | null; stale?: boolean };
}

export type FactoryTwin =
  | {
      ok: true;
      base: string;
      revision: string | null;
      /** the twin page is older than FactoryForm's source (null: FactoryForm didn't say) */
      stale: boolean | null;
      builtAt: string | null;
      facility: { id: string; name: string } | null;
      layout: string | null;
      stations: TwinStation[];
      /** the stations that have a detailed station twin (the manifest's list) */
      twins: Array<{ id: string; name: string; cell?: string }>;
      run: (TwinRun & { taskName?: string; steps?: number }) | null;
      sim: { state: string | null; stale: boolean };
      alertsOpen: number;
      pages: { app: string; floor: string; stations: Array<{ id: string; name: string; url: string }> };
      cad: Array<{ label: string; url: string; format: "glb" | "dxf"; what: string }>;
      /** where the state came from: the stream FactoryForm pushes, or a read */
      via: "stream" | "read";
      at: number;
    }
  | { ok: false; base: string; older: true; reason: string };

// ---------- reading ----------

async function timed<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<T>((_, rej) => (t = setTimeout(() => rej(new Error("timed out")), ms)))]);
  } finally {
    clearTimeout(t);
  }
}

const hostOf = (base: string) => {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
};

/** the manifest (and Control's task list) change rarely: read them at most once a minute */
let manifestCache: { base: string; at: number; manifest: Manifest; tasks: Map<string, { name: string; steps: number }> } | null = null;
const MANIFEST_TTL = 60_000;

/** the stream's latest state document, while the stream is open (connectors.ts follows it) */
let streamed: { base: string; state: StateDoc; at: number } | null = null;

/** what FactoryForm's stream last said (connectors.ts): reads use it while it is fresh instead of asking again */
export function takeStreamedState(base: string, state: unknown) {
  const s = state as StateDoc;
  if (!s || s.schema !== TWIN_SCHEMA) return;
  streamed = { base, state: s, at: Date.now() };
}
/** the stream closed: reads go back to asking */
export function dropStreamedState() {
  streamed = null;
}
/** forget what was read (tests; a start) */
export function forgetTwin() {
  streamed = null;
  manifestCache = null;
}

async function readManifest(base: string): Promise<{ manifest: Manifest; tasks: Map<string, { name: string; steps: number }> } | { older: string }> {
  if (manifestCache && manifestCache.base === base && Date.now() - manifestCache.at < MANIFEST_TTL) return manifestCache;
  const res = await timed(fetch(`${base}/api/twin/v1`, { headers: { accept: "application/json" } }), 3000);
  if (res.status === 404) return { older: `FactoryForm at ${hostOf(base)} answers, but it is an older build with no twin API (/api/twin/v1 answered 404). Stop it and start the current checkout with npm run serve.` };
  if (!res.ok) throw new Error(`FactoryForm's twin API answered ${res.status}`);
  const manifest = (await res.json()) as Manifest;
  if (manifest?.schema !== TWIN_SCHEMA) return { older: `FactoryForm at ${hostOf(base)} answered /api/twin/v1 with ${manifest?.schema ? `schema ${manifest.schema}` : "no schema"}, not ${TWIN_SCHEMA}.` };
  // task names and step counts, when Control's manifest is there (it's optional: a run reads without them)
  const tasks = new Map<string, { name: string; steps: number }>();
  const control = await timed(fetch(`${base}/api/control/v1`), 2000)
    .then((r) => (r.ok ? (r.json() as Promise<{ stations?: Array<{ id: string; tasks?: Array<{ id: string; name: string; steps: number }> }> }>) : null))
    .catch(() => null);
  for (const st of control?.stations ?? []) for (const t of st.tasks ?? []) tasks.set(`${st.id}:${t.id}`, { name: t.name, steps: t.steps });
  manifestCache = { base, at: Date.now(), manifest, tasks };
  return manifestCache;
}

/** fill a link template from the manifest ("/twin/station/{id}") into an address */
function link(base: string, links: Record<string, string> | undefined, key: string, fallback: string, vars: Record<string, string> = {}): string {
  let path = links?.[key] ?? fallback;
  for (const [k, v] of Object.entries(vars)) path = path.replace(`{${k}}`, encodeURIComponent(v));
  return /^https?:\/\//.test(path) ? path : `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}

/**
 * Read FactoryForm's twin. Throws when FactoryForm doesn't answer (the connector says why, in words); answers
 * `{ ok: false, older }` when it answers without the twin API.
 */
export async function readFactoryTwin(base = factoryBase()): Promise<FactoryTwin> {
  const m = await readManifest(base);
  if ("older" in m) return { ok: false, base, older: true, reason: m.older };
  const { manifest, tasks } = m;
  const fresh = streamed && streamed.base === base && Date.now() - streamed.at < 30_000;
  const state: StateDoc = fresh
    ? streamed!.state
    : await timed(fetch(`${base}/api/twin/v1/state`), 3000).then(async (r) => {
        if (!r.ok) throw new Error(`FactoryForm's twin state answered ${r.status}`);
        return (await r.json()) as StateDoc;
      });
  const links = manifest.links;
  const facility = state.facility ?? null;
  const facilityId = facility?.id ?? links?.defaultFacility ?? manifest.facilities?.[0]?.id ?? "facility-kapaa";
  const twins = (manifest.stations ?? []).filter((s) => !s.facility || s.facility === facilityId).map((s) => ({ id: s.id, name: s.name, cell: s.cell }));
  const r = state.run;
  const run = r
    ? {
        id: r.id,
        station: r.station,
        task: r.task,
        state: r.state,
        t: Number(r.t) || 0,
        seconds: Number(r.seconds) || 0,
        speed: r.speed,
        loop: r.loop,
        step: r.step ?? null,
        startedAt: r.startedAt,
        endedAt: r.endedAt ?? null,
        by: r.by ?? null,
        source: r.source ?? null,
        // FactoryForm's runs are always simulated (docs/TWIN_API.md); this side says so whatever arrives
        simulated: true as const,
        taskName: tasks.get(`${r.station}:${r.task}`)?.name,
        steps: tasks.get(`${r.station}:${r.task}`)?.steps,
      }
    : null;
  const cad: Array<{ label: string; url: string; format: "glb" | "dxf"; what: string }> = [];
  const floorName = facility?.name ?? "the floor";
  const hasFloor = manifest.facilities?.find((f) => f.id === facilityId)?.floor != null;
  if (hasFloor) {
    cad.push({ label: `${floorName} floor · glTF`, url: link(base, links, "floorGlb", "/api/twin/v1/facilities/{facility}/floor.glb", { facility: facilityId }), format: "glb", what: "the floor in 3D: slab, equipment, docks" });
    cad.push({ label: `${floorName} floor plan · DXF`, url: link(base, links, "floorDxf", "/api/twin/v1/facilities/{facility}/floor.dxf", { facility: facilityId }), format: "dxf", what: "the plan from above, north up, in metres" });
  }
  for (const s of twins) {
    const glb = link(base, links, "stationGlb", "/api/twin/v1/stations/{id}/cell.glb", { id: s.id });
    cad.push({ label: `${s.name} (${s.id}) · glTF`, url: glb, format: "glb", what: "the cell, arms at home, in its own frame" });
    if (run && run.station === s.id) cad.push({ label: `${s.name} (${s.id}) · glTF, as the run poses it`, url: `${glb}?pose=run`, format: "glb", what: "the cell with the simulated run's joints" });
  }
  return {
    ok: true,
    base,
    revision: manifest.revision ?? null,
    stale: typeof manifest.ui?.stale === "boolean" ? manifest.ui.stale : null,
    builtAt: manifest.ui?.builtAt ?? null,
    facility,
    layout: state.layout?.source ?? null,
    stations: (state.stations ?? []).map((s) => ({ ...s })),
    twins,
    run,
    sim: { state: state.sim?.session?.state ?? null, stale: state.sim?.stale !== false },
    alertsOpen: Number(state.alerts?.open) || 0,
    pages: {
      app: link(base, links, "app", "/"),
      floor: link(base, links, "twin", "/twin"),
      stations: twins.map((s) => ({ id: s.id, name: s.name, url: link(base, links, "stationTwin", "/twin/station/{id}", { id: s.id }) })),
    },
    cad,
    via: fresh ? "stream" : "read",
    at: Date.now(),
  };
}

// ---------- in words ----------

const secs = (n: number) => (n >= 100 ? `${Math.round(n)} s` : `${n.toFixed(1)} s`);

/** "Hipot test cycle on chamber-03 · step 4 of 11, Clamp · 12.4 of 42 s · running" */
export function runWords(run: NonNullable<Extract<FactoryTwin, { ok: true }>["run"]>): string {
  const step = run.step ? `step ${run.step.index + 1}${run.steps ? ` of ${run.steps}` : ""}, ${run.step.label}` : null;
  return [`${run.taskName ?? run.task} on ${run.station}`, step, `${secs(run.t)} of ${secs(run.seconds)}`, run.state].filter(Boolean).join(" · ");
}

/** which records are demo, in words (FactoryForm's rule: provenance is shown, never hidden) */
export function provenanceWords(stations: TwinStation[]): string | undefined {
  const by = new Map<string, number>();
  for (const s of stations) by.set(s.provenance ?? "unknown", (by.get(s.provenance ?? "unknown") ?? 0) + 1);
  if (!by.size || (by.size === 1 && by.has("live"))) return undefined;
  return [...by].map(([p, n]) => `${n} station${n === 1 ? "" : "s"} ${p}`).join(" · ");
}

/** the `factoryform-twin` connector's answer (connectors.ts calls it; throws when FactoryForm is down) */
export async function twinConnectorState(): Promise<{
  id: string;
  name: string;
  ok: boolean;
  url: string;
  summary: string;
  metrics: Array<{ label: string; value: string | number; tone?: "ok" | "warn" | "bad" }>;
  lists?: Array<{ title: string; items: Array<{ text: string; tone?: "ok" | "warn" | "bad" }> }>;
  provenance?: string;
  provenanceLabel?: string;
  detail: unknown;
  checkedAt: number;
}> {
  const twin = await readFactoryTwin();
  const base = { id: TWIN_CONNECTOR, name: "FactoryForm twin", url: twin.base, checkedAt: Date.now() };
  if (!twin.ok) return { ...base, ok: false, summary: `offline — ${twin.reason}`, metrics: [], detail: { twin } };
  const run = twin.run;
  const prov = provenanceWords(twin.stations);
  const going = run && (run.state === "running" || run.state === "paused");
  return {
    ...base,
    ok: true,
    summary: run ? `Simulated run: ${runWords(run)}` : "No simulated run since FactoryForm started",
    metrics: [
      { label: "Simulated run", value: run ? run.state : "none", tone: going ? "ok" : undefined },
      { label: "Step", value: run?.step ? `${run.step.index + 1}${run.steps ? ` / ${run.steps}` : ""}` : "—" },
      { label: "Time", value: run ? `${secs(run.t)} / ${secs(run.seconds)}` : "—" },
      { label: "Station twins", value: twin.twins.length },
      { label: "Open alerts", value: twin.alertsOpen, tone: twin.alertsOpen ? "warn" : "ok" },
      { label: "Twin page", value: twin.stale === null ? "unknown" : twin.stale ? "older than source" : "current", tone: twin.stale ? "warn" : twin.stale === false ? "ok" : undefined },
    ],
    lists: [
      ...(run ? [{ title: "Simulated run", items: [{ text: runWords(run), tone: going ? ("ok" as const) : undefined }] }] : []),
      { title: "CAD", items: twin.cad.map((c) => ({ text: `${c.label}: ${c.url}` })) },
    ],
    provenance: prov,
    provenanceLabel: prov ? (twin.stations.every((s) => s.provenance === "demo") ? "demo stations" : "mixed provenance") : undefined,
    // the main list (flows.ts takes the first list of records): the stations as the twin has them
    detail: { stations: twin.stations, twin },
    checkedAt: Date.now(),
  };
}

// ---------- starting it: a person's press ----------

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/i;
const FF_FOLDER = "FactoryForm";

export interface StartResult {
  /** "started": the launcher started it; "running": it already answered (the launcher reused it) */
  state: "started" | "running";
  url: string;
  pid?: number;
  twin?: string;
  /** what the launcher said, last lines */
  said: string;
}

/** where FactoryForm is checked out on this computer (scripts/siblings.mjs: next to Foundation, or FOUNDATION_SIBLINGS) */
export function factoryFormDir(env = process.env): string {
  return siblingDir(FF_FOLDER, env);
}

/** the launcher run in flight: a second press waits for the first */
let starting: Promise<StartResult> | null = null;
/** how the launcher is run (tests put a stand-in here) */
let launcher: (cwd: string, args: string[]) => Promise<{ code: number; out: string }> = runLauncher;
export function setLauncher(fn: typeof launcher | null) {
  launcher = fn ?? runLauncher;
}

function runLauncher(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    // npm is a .cmd on Windows, which Node starts only through a shell; every argument is fixed or a checked number.
    // Through the one door (child.ts): FactoryForm gets the base environment and none of Foundation's keys
    const p = spawnChild("npm", ["run", "serve", "--", ...args], childOptions({ extras: [] }, { cwd, shell: process.platform === "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"] }));
    let out = "";
    const take = (b: Buffer) => {
      out = (out + b.toString()).slice(-8000);
    };
    p.stdout?.on("data", take);
    p.stderr?.on("data", take);
    // the launcher builds the page when it's stale (a minute or two), then waits up to a minute for the server
    const t = setTimeout(() => p.kill(), 4 * 60_000);
    p.on("error", (e) => {
      clearTimeout(t);
      resolve({ code: -1, out: `${out}\n${e.message}` });
    });
    p.on("exit", (code) => {
      clearTimeout(t);
      resolve({ code: code ?? -1, out });
    });
  });
}

/**
 * Start FactoryForm on this computer with its own launcher (`npm run serve -- --detach`, FactoryForm's
 * docs/TWIN_API.md): it builds the twin page when src/ is newer, reuses a FactoryForm already answering on the
 * port, never touches anything else there, and leaves the server running in the background.
 *
 * Only on a person's press: an admin, from their own browser (not an agent's bearer), at the server's own
 * computer (the route is in network.ts's LOCAL_ONLY). Never on a hosted server. Only a FactoryForm configured at
 * a loopback address is started (the port comes from FACTORYFORM_URL).
 */
export async function startFactoryForm(user: UserInfo, person: boolean, opts: { local: boolean }): Promise<StartResult> {
  requireLocalFeature("factoryform", "Starting FactoryForm on this computer");
  if (!person) throw new HttpError(403, "Starting FactoryForm needs a person, from their own browser: it runs FactoryForm's code on this computer.");
  if (user.role !== "admin") throw new HttpError(403, "Only an admin can start FactoryForm: it runs FactoryForm's code on this computer.");
  if (!opts.local) throw new HttpError(403, "This works only at the computer this server runs on (Starting FactoryForm).");
  const base = factoryBase();
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    throw new HttpError(400, `FACTORYFORM_URL (${base}) isn't an address.`);
  }
  if (!LOOPBACK.test(u.hostname) || u.protocol !== "http:") throw new HttpError(400, `FactoryForm is set to ${u.host} (FACTORYFORM_URL), not this computer: Foundation starts only a FactoryForm on this computer.`);
  const port = Number(u.port || 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, `FACTORYFORM_URL's port (${u.port}) isn't a port.`);
  const dir = factoryFormDir();
  if (!existsSync(join(dir, "package.json"))) throw new HttpError(404, `FactoryForm isn't checked out at ${dir}. Clone it next to Foundation, or set FOUNDATION_SIBLINGS to the folder it sits in.`);
  let scripts: Record<string, string> = {};
  try {
    scripts = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    /* read below as "no serve" */
  }
  if (!scripts.serve) throw new HttpError(409, `The FactoryForm at ${dir} has no "serve" script: it is older than the twin API. Pull it, then press again.`);
  const host = u.hostname === "localhost" ? "127.0.0.1" : u.hostname.replace(/^\[|\]$/g, "");
  const args = ["--detach", "--port", String(port), "--host", host];
  starting ??= (async () => {
    audit({ actor_kind: "person", actor_id: user.id, actor_name: user.name, board_id: null, door: "route", action: "factoryform.start", target: `${dir} :${port}`, decision: "allowed", result: "ok" });
    const { code, out } = await launcher(dir, args);
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const said = lines.slice(-4).join("\n");
    forgetTwin();
    if (code !== 0) throw new HttpError(502, `FactoryForm didn't start: ${lines.filter((l) => !l.startsWith(">")).slice(-2).join(" ") || `the launcher exited ${code}`}`);
    // --detach prints {url, pid, twin, api} on its last line once the server answers; a FactoryForm that was
    // already running is reused, and the launcher says so in words instead
    for (const l of [...lines].reverse()) {
      if (!l.startsWith("{")) continue;
      try {
        const j = JSON.parse(l) as { url?: string; pid?: number; twin?: string };
        if (j.url) return { state: "started" as const, url: j.url, pid: j.pid, twin: j.twin, said };
      } catch {
        /* not the line */
      }
    }
    return { state: "running" as const, url: base, said };
  })().finally(() => (starting = null));
  return starting;
}

// ---------- the twin pages as a saved app ----------

/**
 * Foundation frames a page on this computer with its own origin only when it is a saved app (the client's
 * frameSandbox.ts); otherwise it runs opaque, and FactoryForm's page can't load its own scripts there. So when a
 * person lays the twin, FactoryForm's configured address (FACTORYFORM_URL, never one a request names) is saved as
 * an app, in their name and audited, as saving any app is. An agent's lay never saves it: it says a person must.
 */
export function ensureTwinApp(userId: string): { saved: boolean; already: boolean; url: string } {
  const base = factoryBase();
  let origin: string;
  try {
    origin = new URL(base).origin;
  } catch {
    return { saved: false, already: false, url: base };
  }
  const known = listApps().some((a) => {
    try {
      return a.url ? new URL(a.url).origin === origin : false;
    } catch {
      return false;
    }
  });
  if (known) return { saved: false, already: true, url: origin };
  saveApp({ name: "FactoryForm (this computer)", url: `${origin}/`, description: "FactoryForm's app and its digital twin pages (/twin), as Foundation reads them (FACTORYFORM_URL)" }, userId);
  return { saved: true, already: false, url: origin };
}

// ---------- the FactoryForm section ----------

/** the section's name; a board already has the twin when any card on it shows the twin connector, whatever its section is called */
export const TWIN_SECTION = "FactoryForm twin";

/**
 * Lay the "FactoryForm twin" section on a board: the floor twin page and one station twin page as frames (FactoryForm
 * sends no X-Frame-Options, so a page on this computer frames them), the twin's stations in a table wired from
 * the twin connector (provenance is a column), the simulated run, and the CAD downloads. The twin connector is
 * read only while something is wired from it or a card shows it; nothing third-party runs. Laid once: a board
 * with a twin card on it already answers `already` (with that card's section).
 */
export function layFactoryTwin(boardId: string, actor: string, opts: { station?: string } = {}): { section: string; already?: boolean; cards: string[]; links: string[]; base: string } {
  const base = factoryBase();
  const station = opts.station && /^[a-z0-9][a-z0-9-]{0,63}$/i.test(opts.station) ? opts.station : "chamber-03";
  return editBoard(boardId, "agent", (doc) => {
    const m = boardMaps(doc);
    // laid already: a card shows the twin (the company grid's own "FactoryForm" section holds FactoryForm's connector, not this)
    const shown = [...m.objects.values()].find((o) => o.kind === "panel" && (o as PanelDoc).panel === "connector" && (o as PanelDoc).connector === TWIN_CONNECTOR);
    if (shown) return { section: shown.sectionId, already: true, cards: [], links: [], base };
    const empty = [...m.sections.values()].find((s) => s.name === TWIN_SECTION && ![...m.objects.values()].some((o) => o.sectionId === s.id));
    const sec = empty ?? appendSection(doc, TWIN_SECTION);
    const now = Date.now();
    const cards: string[] = [];
    const links: string[] = [];
    let n = 0;
    const at = (name: string) => ({ sectionId: sec.id, name, x: 0, y: 0, float: false, bornAt: now + n++, createdBy: actor });
    const page = (name: string, url: string, w: number, h: number, text: string): PanelDoc => {
      const p = { ...at(name), id: uid("pnl"), kind: "panel", panel: "app", url, text, w, h, ports: [] } as PanelDoc;
      m.objects.set(p.id, p);
      cards.push(p.id);
      return p;
    };
    const twinCard = (name: string, view: "run" | "cad", w: number, h: number, ports: boolean): PanelDoc => {
      const p = {
        ...at(name),
        id: uid("pnl"),
        kind: "panel",
        panel: "connector",
        connector: TWIN_CONNECTOR,
        source: view,
        text: view === "run" ? "The simulated run on FactoryForm's twin" : "The twin as CAD: the floor and each station cell",
        w,
        h,
        ports: ports ? [{ id: uid("port"), name: "out", dir: "out", type: "json" }] : [],
      } as unknown as PanelDoc;
      m.objects.set(p.id, p);
      cards.push(p.id);
      return p;
    };

    page("Floor twin · FactoryForm", `${base}/twin`, 960, 620, "FactoryForm's facility floor twin");
    page(`Station twin · ${station}`, `${base}/twin/station/${encodeURIComponent(station)}`, 720, 620, `FactoryForm's twin of ${station}`);
    const run = twinCard("Simulated run · FactoryForm", "run", 460, 420, true);
    const table: TableDoc = { ...at("Stations · FactoryForm twin"), id: uid("tbl"), kind: "table", cols: 6, rows: 12, feed: { columns: "shortName, status, wip, twin, equipment, provenance", limit: 40 } };
    m.objects.set(table.id, table);
    cards.push(table.id);
    const out = run.ports[0];
    const l: LinkDoc = { id: uid("lnk"), from: { panel: run.id, port: out.id }, to: { panel: table.id, port: TABLE_PORT }, label: "stations", createdBy: actor };
    m.links.set(l.id, l);
    links.push(l.id);
    twinCard("CAD · FactoryForm twin", "cad", 460, 400, false);
    const how: NoteDoc & { text: string } = {
      ...at("About this section"),
      id: uid("note"),
      kind: "note",
      w: 420,
      h: 280,
      text: [
        `FactoryForm's digital twin, from FactoryForm on this computer (${base.replace(/^https?:\/\//, "")}).`,
        "",
        "- **Floor twin** and **Station twin** are FactoryForm's own pages in frames. ⌘/Ctrl-click one to use it.",
        "- **Simulated run** follows the run FactoryForm plays (Control starts them). It is always a simulation, never the robots.",
        "- **Stations** is wired from the twin. `provenance` says which records are demo.",
        "- **CAD** downloads the floor (glTF, DXF) and each station cell (glTF) as FactoryForm makes them now.",
        "",
        "If FactoryForm isn't answering, an admin at this computer can start it from the Simulated run card.",
      ].join("\n"),
    };
    putNote(doc, how);
    cards.push(how.id);
    return { section: sec.id, cards, links, base };
  });
}
