/**
 * FactoryForm's digital twin in Foundation (2026-11-27; factorytwin.ts, connectors.ts). FactoryForm is a stand-in
 * HTTP server here, answering its twin contract (`factoryform.twin/1`, FactoryForm's docs/TWIN_API.md).
 *
 *  - the twin connector reads the manifest and the state: stations with twins, the simulated run (task name and
 *    step count from Control's manifest), `ui.stale`, the twin pages and the CAD links, provenance said;
 *  - FactoryForm's own connector carries the twin too, and its stations are the twin's;
 *  - an older FactoryForm (no /api/twin/v1) is said to be older, and one that's down is said to be down;
 *  - the stream's state is used while fresh (a moving run asks FactoryForm nothing more);
 *  - the section lays once: two frames, the run card wired into a stations table, the CAD card;
 *  - Start FactoryForm: refused to an agent's bearer, to a member, from another computer, on a hosted server, for
 *    a FactoryForm set to another computer, and when the checkout isn't there; an admin's press runs the
 *    launcher once with fixed arguments (--detach, the port from FACTORYFORM_URL), and the door is this-computer-only.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-ftwin-"));
process.env.FOUNDATION_STARTER_DIR = "";

// ---------- a stand-in FactoryForm ----------

let twinApi = true; // false: an older FactoryForm (no /api/twin/v1)
let stale = false;
let run: Record<string, unknown> | null = null;
const hits = new Map<string, number>();
const ff: Server = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  hits.set(path, (hits.get(path) ?? 0) + 1);
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const stations = [
    { id: "testing", name: "Pressure & electrical test", shortName: "Test & QA", status: "running", wip: 2, capacity: 4, provenance: "demo", equipment: null, twin: false },
    { id: "brazing", name: "Brazing cell", shortName: "Brazing", status: "idle", wip: 0, capacity: 2, provenance: "demo", equipment: "eq-brazing", twin: true },
  ];
  if (path === "/api/erp/summary") return json(200, { items: 0, inventoryValue: 0, negativeStock: 0, belowReorderPoint: 0, openPurchaseOrders: 0, overduePurchaseOrders: 0, buildsThisMonth: 0 });
  if (path === "/api/bootstrap") return json(200, { stations: [{ id: "old", name: "From bootstrap", status: "idle", provenance: "demo" }], units: [], alerts: [], meta: { mode: "prototype", demoData: true } });
  if (!twinApi && path.startsWith("/api/twin/")) return json(404, { error: "Not found" });
  if (path === "/api/twin/v1")
    return json(200, {
      schema: "factoryform.twin/1",
      service: "FactoryForm",
      revision: "2.0.0+abc1234",
      ui: { built: true, builtAt: "2026-11-27T00:00:00Z", sourceAt: "2026-11-27T01:00:00Z", stale },
      facilities: [{ id: "facility-kapaa", name: "Kapaʻa Factory", floor: "default", revision: null }],
      stations: [
        { id: "chamber-03", cell: "hipot-cell", name: "Hipot test cell", facility: "facility-kapaa" },
        { id: "brazing", cell: "braze-cell", name: "Flame brazing cell", facility: "facility-kapaa" },
      ],
      links: { app: "/", twin: "/twin", stationTwin: "/twin/station/{id}", floorGlb: "/api/twin/v1/facilities/{facility}/floor.glb", floorDxf: "/api/twin/v1/facilities/{facility}/floor.dxf", stationGlb: "/api/twin/v1/stations/{id}/cell.glb", defaultFacility: "facility-kapaa" },
    });
  if (path === "/api/twin/v1/state")
    return json(200, { schema: "factoryform.twin/1", facility: { id: "facility-kapaa", name: "Kapaʻa Factory" }, layout: { source: "default", revision: null }, stations, alerts: { open: 3 }, run, sim: { session: null, lastFrameAt: null, stale: true }, live: { robots: [] } });
  if (path === "/api/control/v1") return json(200, { schema: "factoryform.control/1", stations: [{ id: "chamber-03", tasks: [{ id: "hipot-cycle", name: "Hipot test cycle", steps: 11, seconds: 42 }] }] });
  json(404, { error: "Not found" });
});

before(async () => {
  await new Promise<void>((ok) => ff.listen(0, "127.0.0.1", ok));
  process.env.FACTORYFORM_URL = `http://127.0.0.1:${(ff.address() as AddressInfo).port}`;
});
after(() => ff.close());

// imported after FACTORYFORM_URL is set (config reads it once)
const load = async () => {
  const connectors = await import("../src/connectors.ts");
  const twin = await import("../src/factorytwin.ts");
  return { ...connectors, ...twin };
};

test("the twin connector reads the manifest and the state: stations, the simulated run, the pages, the CAD, provenance said", async () => {
  const { readConnector, forgetTwin } = await load();
  forgetTwin();
  run = { id: "run-1", station: "chamber-03", task: "hipot-cycle", state: "running", t: 12.4, seconds: 42, step: { index: 3, id: "clamp", label: "Clamp" }, by: "Control", simulated: true, robots: [{ id: "a", joints: [0, 1] }] };
  const st = await readConnector("factoryform-twin", true);
  assert.equal(st.ok, true, st.summary);
  assert.match(st.summary, /^Simulated run: Hipot test cycle on chamber-03 · step 4 of 11, Clamp · 12\.4 s of 42\.0 s · running$/);
  assert.equal(st.provenanceLabel, "demo stations", "demo records are labelled, never hidden");
  const d = st.detail as { stations: Array<{ id: string; provenance: string; twin: boolean }>; twin: { ok: true; run: { simulated: boolean; robots?: unknown }; stale: boolean; twins: Array<{ id: string }>; pages: { floor: string; stations: Array<{ url: string }> }; cad: Array<{ url: string; format: string }> } };
  assert.deepEqual(d.stations.map((s) => [s.id, s.provenance, s.twin]), [["testing", "demo", false], ["brazing", "demo", true]], "the main list is the twin's stations, provenance included");
  assert.equal(d.twin.run.simulated, true);
  assert.equal(d.twin.run.robots, undefined, "a run's joints aren't carried to the card");
  assert.equal(d.twin.stale, false);
  assert.deepEqual(d.twin.twins.map((s) => s.id), ["chamber-03", "brazing"]);
  const base = process.env.FACTORYFORM_URL!;
  assert.equal(d.twin.pages.floor, `${base}/twin`);
  assert.equal(d.twin.pages.stations[0].url, `${base}/twin/station/chamber-03`);
  const cad = d.twin.cad.map((c) => c.url);
  assert.ok(cad.includes(`${base}/api/twin/v1/facilities/facility-kapaa/floor.glb`));
  assert.ok(cad.includes(`${base}/api/twin/v1/facilities/facility-kapaa/floor.dxf`));
  assert.ok(cad.includes(`${base}/api/twin/v1/stations/brazing/cell.glb`));
  assert.ok(cad.includes(`${base}/api/twin/v1/stations/chamber-03/cell.glb?pose=run`), "the station the run is on also has its posed cell");
  // flows.ts: the twin connector's out port carries the stations as rows
  const { connectorValue } = await import("../src/flows.ts");
  const rows = connectorValue(st).rows;
  assert.deepEqual(rows.map((r) => r.id), ["testing", "brazing"]);
  assert.equal(rows[1].provenance, "demo");
});

test("a stale page is said; with no run the card says there's none", async () => {
  const { readConnector, forgetTwin } = await load();
  forgetTwin();
  stale = true;
  run = null;
  const st = await readConnector("factoryform-twin", true);
  assert.equal(st.summary, "No simulated run since FactoryForm started");
  assert.deepEqual(st.metrics.find((m) => m.label === "Twin page"), { label: "Twin page", value: "older than source", tone: "warn" });
  stale = false;
});

test("FactoryForm's own connector carries the twin, and its stations are the twin's", async () => {
  const { readConnector, forgetTwin } = await load();
  forgetTwin();
  const st = await readConnector("factoryform", true);
  assert.equal(st.ok, true);
  const d = st.detail as { stations: Array<{ id: string }>; twin: { available: boolean; stations: Array<{ id: string }>; pages: { floor: string } } };
  assert.deepEqual(d.stations.map((s) => s.id), ["testing", "brazing"]);
  assert.equal(d.twin.available, true);
  assert.ok(st.lists?.some((l) => l.title === "Digital twin" && /2 station twins/.test(l.items[0].text)));
});

test("an older FactoryForm is said to be older (both connectors); the stream's state stands in while fresh", async () => {
  const { readConnector, forgetTwin, takeStreamedState } = await load();
  forgetTwin();
  twinApi = false;
  try {
    const twin = await readConnector("factoryform-twin", true);
    assert.equal(twin.ok, false);
    assert.match(twin.summary, /older build with no twin API \(\/api\/twin\/v1 answered 404\).*npm run serve/);
    assert.equal((twin.detail as { twin: { older: boolean } }).twin.older, true);
    const own = await readConnector("factoryform", true);
    assert.equal(own.ok, true, "the rest of FactoryForm still reads");
    assert.deepEqual((own.detail as { stations: Array<{ id: string }> }).stations.map((s) => s.id), ["old"], "older: the stations come from /api/bootstrap");
    assert.equal((own.detail as { twin: { available: boolean; older: boolean } }).twin.older, true);
  } finally {
    twinApi = true;
  }
  forgetTwin();
  await readConnector("factoryform-twin", true); // the manifest, read and kept
  const before = hits.get("/api/twin/v1/state") ?? 0;
  takeStreamedState(process.env.FACTORYFORM_URL!, { schema: "factoryform.twin/1", stations: [], alerts: { open: 0 }, run: { id: "r2", station: "brazing", task: "braze-cycle", state: "running", t: 5, seconds: 55.2, step: null }, sim: {} });
  const st = await readConnector("factoryform-twin", true);
  assert.equal(hits.get("/api/twin/v1/state") ?? 0, before, "the streamed state was used: FactoryForm wasn't asked");
  assert.match(st.summary, /braze-cycle on brazing · 5\.0 s of 55\.2 s · running/);
  forgetTwin();
});

test("FactoryForm down is said to be down, in words", async () => {
  const { readConnector, forgetTwin } = await load();
  const { config } = await import("../src/config.ts");
  const was = config.connectors.factoryform;
  config.connectors.factoryform = "http://127.0.0.1:9";
  forgetTwin();
  try {
    const st = await readConnector("factoryform-twin", true);
    assert.equal(st.ok, false);
    assert.match(st.summary, /^offline — (nothing is running at 127\.0\.0\.1:9|it didn't answer|nothing answered)/);
  } finally {
    config.connectors.factoryform = was;
  }
});

test("the FactoryForm section lays once: two twin frames, the run wired into a stations table, the CAD", async () => {
  const { createBoardRow, getBoard, closeBoards } = await import("../src/boards.ts");
  const { upsertUser } = await import("../src/auth.ts");
  const { runTool } = await import("../src/tools.ts");
  const { boardMaps, TABLE_PORT } = await import("@foundation/protocol");
  const ada = upsertUser("ada@formindustries.com", "Ada Lovelace");
  const board = createBoardRow("Factory");
  // the company grid's way: a section called FactoryForm already holds FactoryForm's own connector card
  const { appendSection } = await import("@foundation/protocol");
  const { editBoard } = await import("../src/boards.ts");
  editBoard(board, "test", (doc) => {
    const sec = appendSection(doc, "FactoryForm");
    boardMaps(doc).objects.set("pnl_ff", { id: "pnl_ff", kind: "panel", panel: "connector", connector: "factoryform", sectionId: sec.id, name: "FactoryForm", x: 0, y: 0, float: false, bornAt: 1, w: 440, h: 300, ports: [] } as never);
  });
  const ctx = { boardId: board, actor: "Ada Lovelace", userId: ada.id, person: true };
  try {
    const out = (await runTool(ctx, "lay_factoryform_twin", { request_id: "t1" })) as { section: string; cards: string[]; links: string[] };
    const m = boardMaps(getBoard(board).doc);
    assert.equal(m.sections.get(out.section)?.name, "FactoryForm twin");
    const cards = out.cards.map((id) => m.objects.get(id) as unknown as Record<string, unknown>);
    const base = process.env.FACTORYFORM_URL!;
    const frames = cards.filter((c) => c.panel === "app").map((c) => c.url);
    assert.deepEqual(frames, [`${base}/twin`, `${base}/twin/station/chamber-03`]);
    const twinCards = cards.filter((c) => c.panel === "connector");
    assert.deepEqual(twinCards.map((c) => [c.connector, c.source]), [["factoryform-twin", "run"], ["factoryform-twin", "cad"]]);
    const table = cards.find((c) => c.kind === "table") as { id: string; feed: { columns: string } };
    assert.match(table.feed.columns, /provenance/);
    assert.equal(out.links.length, 1);
    const l = m.links.get(out.links[0])!;
    assert.equal(l.from.panel, twinCards[0].id);
    assert.deepEqual(l.to, { panel: table.id, port: TABLE_PORT });
    // a person's lay saved FactoryForm's configured address as an app (its frames keep their origin); once
    const { listApps } = await import("../src/apps.ts");
    const saved = () => listApps().filter((a) => a.url === `${base}/`);
    assert.equal(saved().length, 1);
    assert.equal((out as unknown as { app: { saved: boolean } }).app.saved, true);
    const again = (await runTool(ctx, "lay_factoryform_twin", { request_id: "t2" })) as { already?: boolean; section: string };
    assert.equal(again.already, true);
    assert.equal(again.section, out.section, "found by its twin card, not by a section's name");
    // a station named by an agent is only ever an id, never a path
    const other = createBoardRow("Factory 2");
    const odd = (await runTool({ ...ctx, boardId: other, person: false }, "lay_factoryform_twin", { station: "../../api/x", request_id: "t3" })) as { cards: string[]; app: { saved: boolean }; note?: string };
    assert.equal(odd.app.saved, false, "an agent's lay saves no app");
    assert.match(odd.note ?? "", /a person laying this/);
    assert.equal(saved().length, 1);
    const frames2 = odd.cards.map((id) => boardMaps(getBoard(other).doc).objects.get(id) as unknown as { panel?: string; url?: string }).filter((c) => c.panel === "app");
    assert.equal(frames2[1].url, `${base}/twin/station/chamber-03`);
  } finally {
    const { stopFlows } = await import("../src/flows.ts");
    stopFlows();
    closeBoards();
  }
});

// ---------- Start FactoryForm ----------

test("Start FactoryForm: a person who's an admin, at this computer, on a local server, for a FactoryForm on this computer", async () => {
  const { startFactoryForm, setLauncher } = await load();
  const { config } = await import("../src/config.ts");
  const { localOnlyRefusal } = await import("../src/network.ts");
  const admin = { id: "u1", name: "Ada", email: "ada@formindustries.com", role: "admin" } as never;
  const member = { id: "u2", name: "Kai", email: "kai@formindustries.com", role: "member" } as never;
  const calls: Array<{ cwd: string; args: string[] }> = [];
  setLauncher(async (cwd, args) => {
    calls.push({ cwd, args });
    await new Promise((r) => setTimeout(r, 30));
    return { code: 0, out: `> factoryform@2.0.0 serve\n${JSON.stringify({ url: "http://127.0.0.1:3001", pid: 4242, twin: "http://127.0.0.1:3001/twin", api: "http://127.0.0.1:3001/api/twin/v1" })}\n` };
  });
  const siblings = mkdtempSync(join(tmpdir(), "foundation-siblings-"));
  const wasSiblings = process.env.FOUNDATION_SIBLINGS;
  const wasUrl = config.connectors.factoryform;
  process.env.FOUNDATION_SIBLINGS = siblings;
  config.connectors.factoryform = "http://127.0.0.1:3001";
  const refused = async (p: Promise<unknown>, status: number, re: RegExp) => {
    await assert.rejects(p, (e: Error & { status?: number }) => {
      assert.equal(e.status, status, e.message);
      assert.match(e.message, re);
      return true;
    });
  };
  try {
    // the door itself is this computer's only (network.ts), like T3's and the terminal's
    const fromLan = { method: "POST", headers: { host: "192.168.1.20:4410" }, socket: { remoteAddress: "192.168.1.30" } } as never;
    assert.match(localOnlyRefusal(fromLan, "/api/factoryform/start") ?? "", /only at the computer this server runs on \(Starting FactoryForm/);

    await refused(startFactoryForm(admin, false, { local: true }), 403, /needs a person/);
    await refused(startFactoryForm(member, true, { local: true }), 403, /Only an admin/);
    await refused(startFactoryForm(admin, true, { local: false }), 403, /only at the computer this server runs on/);
    await refused(startFactoryForm(admin, true, { local: true }), 404, /isn't checked out at .*FactoryForm/);
    mkdirSync(join(siblings, "FactoryForm"));
    writeFileSync(join(siblings, "FactoryForm", "package.json"), JSON.stringify({ name: "factoryform", scripts: { start: "node server.js" } }));
    await refused(startFactoryForm(admin, true, { local: true }), 409, /no "serve" script/);
    writeFileSync(join(siblings, "FactoryForm", "package.json"), JSON.stringify({ name: "factoryform", scripts: { start: "node server.js", serve: "node scripts/twin-server.mjs" } }));
    config.connectors.factoryform = "http://10.0.0.5:3001";
    await refused(startFactoryForm(admin, true, { local: true }), 400, /not this computer/);
    config.connectors.factoryform = "http://127.0.0.1:3001";

    // hosted: off, whoever presses
    const wasPublic = config.publicUrl;
    config.publicUrl = "https://foundation.example.com";
    try {
      await refused(startFactoryForm(admin, true, { local: true }), 403, /turned off on a hosted Foundation server/);
    } finally {
      config.publicUrl = wasPublic;
    }
    assert.equal(calls.length, 0, "nothing was run for any refusal");

    // an admin's press: two at once run the launcher once, with fixed arguments
    const [a, b] = await Promise.all([startFactoryForm(admin, true, { local: true }), startFactoryForm(admin, true, { local: true })]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cwd, join(siblings, "FactoryForm"));
    assert.deepEqual(calls[0].args, ["--detach", "--port", "3001", "--host", "127.0.0.1"]);
    assert.deepEqual([a.state, a.url, a.pid], ["started", "http://127.0.0.1:3001", 4242]);
    assert.equal(b, a);

    // one already running is reused, and said
    setLauncher(async () => ({ code: 0, out: "FactoryForm already answers at http://127.0.0.1:3001 (2.0.0+abc); using it.\n" }));
    assert.equal((await startFactoryForm(admin, true, { local: true })).state, "running");
    // a launcher that fails says why
    setLauncher(async () => ({ code: 1, out: "Something else answers at http://127.0.0.1:3001; not touching it. Pass --port <another>.\n" }));
    await refused(startFactoryForm(admin, true, { local: true }), 502, /didn't start: Something else answers/);
  } finally {
    setLauncher(null);
    config.connectors.factoryform = wasUrl;
    if (wasSiblings === undefined) delete process.env.FOUNDATION_SIBLINGS;
    else process.env.FOUNDATION_SIBLINGS = wasSiblings;
  }
});
