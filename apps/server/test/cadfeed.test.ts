/**
 * CAD cards fed by an app (cadfeed.ts, docs/cad-feed.md). A stand-in BOM app answers `part_model` with an STL as an
 * embedded resource. Before a person's Allow nothing is called and no card is made; after it, add_cad keeps the file,
 * makes a file card wired from the app's `cad` port, and refresh_cad follows the app: new bytes swap the model (the
 * old file stays), the same bytes change nothing, and a card whose wire was cut is an orphan that isn't asked.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-test-"));

const { run: runSql, one } = await import("../src/db.ts");
runSql("insert or ignore into users (id, email, name, color, role, created_at) values (?, ?, ?, ?, 'member', ?)", "u1", "u1@formindustries.com", "Ada", "#325bb4", Date.now());
const { boardMaps, cadLinked, CAD_IN_PORT, CAD_OUT_PORT } = await import("@foundation/protocol");
const { runTool } = await import("../src/tools.ts");
const { editBoard, getBoard, closeBoards } = await import("../src/boards.ts");
const { answerAppToolAsk } = await import("../src/apptools.ts");
const { nameOfResource, stopCadFeeds } = await import("../src/cadfeed.ts");
const { machineAsksOf } = await import("@foundation/protocol");

const BOARD = "cad-feed";
const ctx = { boardId: BOARD, actor: "Wren", userId: "u1" };

/** the stand-in app: its parts' models, changed by the test */
const models: Record<string, string> = { hub: "solid hub\nfacet normal 0 0 1\nendsolid hub\n" };
let calls = 0;
let http: Server;
let address = "";

before(async () => {
  http = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const server = new McpServer({ name: "bom-standin", version: "0.0.1" });
    server.registerTool("part_model", { description: "A part's 3D model as an STL file.", inputSchema: { part: z.string() } }, async ({ part }) => {
      calls++;
      const stl = models[part];
      if (!stl) return { content: [{ type: "text" as const, text: `no part ${part}` }], isError: true };
      return { content: [{ type: "text" as const, text: `${part}, rev C` }, { type: "resource" as const, resource: { uri: `bom://parts/${part}.stl`, mimeType: "model/stl", blob: Buffer.from(stl).toString("base64") } }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
  });
  await new Promise<void>((ok) => http.listen(0, "127.0.0.1", ok));
  address = `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`;
  runSql("insert into apps (id, name, url, mcp, description, created_by, created_at) values (?, ?, ?, ?, ?, ?, ?)", "app_bom", "Airform BOM", "http://127.0.0.1/", address, "parts", "u1", Date.now());
});

after(() => {
  stopCadFeeds();
  closeBoards();
  http.close();
});

const appCard = () => {
  const r = (runTool(ctx, "add_panel", { panel: "app", name: "Airform BOM", section: "BOM", mcp: address }) as Promise<{ id: string }>);
  return r;
};

test("a resource's name comes from its address, with the extension its type gives", () => {
  assert.equal(nameOfResource("bom://parts/hub.stl", "model/stl", 0), "hub.stl");
  assert.equal(nameOfResource("bom://parts/hub", "model/stl", 0), "hub.stl");
  assert.equal(nameOfResource(undefined, undefined, 2), "file-3");
  assert.equal(nameOfResource("x://a/..%2F..%2Fetc", undefined, 0).includes("/"), false);
});

test("an app's STL becomes a 3D card wired to the app, which follows it until the wire is cut", async () => {
  const added = (await appCard()) as { id: string };
  const app = added.id;

  // first use: a person is asked; nothing called, no card
  const first = await runTool(ctx, "add_cad", { name: "Fan hub", from: { panel: app, tool: "part_model", args: { part: "hub" } }, section: "CAD" });
  assert.match(String(first), /Nothing was called/);
  assert.equal(calls, 0);
  const ask = machineAsksOf(getBoard(BOARD).doc, app).find((a) => a.state === "waiting")!;
  answerAppToolAsk(BOARD, app, ask.id, { id: "u1", name: "Ada" }, "allow");

  const made = (await runTool(ctx, "add_cad", { name: "Fan hub", from: { panel: app, tool: "part_model", args: { part: "hub" } }, section: "CAD", request_id: "cad-1" })) as { id: string; file: string; wired: boolean };
  assert.equal(made.wired, true);
  assert.equal(calls, 1);
  const m = boardMaps(getBoard(BOARD).doc);
  const card = m.objects.get(made.id) as import("@foundation/protocol").PanelDoc;
  assert.equal(card.panel, "file");
  assert.equal(card.fileId, made.file);
  assert.equal(card.mime, "model/stl");
  assert.equal(card.feed?.app, app);
  assert.equal(card.feed?.label, "hub");
  assert.equal(card.feed?.state, "ok");
  const file = one<{ name: string; board_id: string; archived_at: number | null }>("select name, board_id, archived_at from files where id = ?", made.file)!;
  assert.deepEqual({ ...file }, { name: "hub.stl", board_id: BOARD, archived_at: null });
  const links = [...m.links.values()];
  assert.ok(links.some((l) => l.from.panel === app && l.from.port === CAD_OUT_PORT && l.to.panel === made.id && l.to.port === CAD_IN_PORT));
  assert.equal(cadLinked(links, card), true);
  // the same request again answers with the first result, and calls nothing
  await runTool(ctx, "add_cad", { name: "Fan hub", from: { panel: app, tool: "part_model", args: { part: "hub" } }, section: "CAD", request_id: "cad-1" });
  assert.equal(calls, 1);

  // the same bytes: checked, nothing changes
  const same = (await runTool(ctx, "refresh_cad", { id: made.id })) as { sha: string; changedAt: number; checkedAt: number };
  assert.equal((m.objects.get(made.id) as { fileId: string }).fileId, made.file);
  assert.ok(same.checkedAt >= same.changedAt);

  // the app's part changes: the card takes the new model; the old file stays in the archive
  models.hub = "solid hub\nfacet normal 1 0 0\nendsolid hub\n";
  await runTool(ctx, "refresh_cad", { id: made.id });
  const after1 = m.objects.get(made.id) as { fileId: string; feed: { sha: string } };
  assert.notEqual(after1.fileId, made.file);
  assert.equal(one<{ archived_at: number | null }>("select archived_at from files where id = ?", made.file)?.archived_at, null);

  // the card's own `feed` written in the board changes nothing about what is asked (it is only shown)
  editBoard(BOARD, "test", (d) => {
    const mm = boardMaps(d);
    const c = mm.objects.get(made.id) as import("@foundation/protocol").PanelDoc;
    mm.objects.set(made.id, { ...c, feed: { ...c.feed!, args: { part: "gone" }, by: "someone-else" } });
  });
  await runTool(ctx, "refresh_cad", { id: made.id });
  assert.equal((m.objects.get(made.id) as { feed: { state: string } }).feed.state, "ok");
  // a part the app no longer has (the server's record changed): the card keeps its model and says why
  const { recordFeed, feedRecord } = await import("../src/cadfeed.ts");
  recordFeed(BOARD, made.id, { ...feedRecord(BOARD, made.id)!, args: { part: "gone" } });
  // the tool's definition is the same, so the Allow still holds
  await runTool(ctx, "refresh_cad", { id: made.id });
  const bad = m.objects.get(made.id) as { fileId: string; feed: { state: string; note?: string } };
  assert.equal(bad.fileId, after1.fileId);
  assert.equal(bad.feed.state, "error");

  // the wire cut: an orphan, never asked again, keeping its model
  editBoard(BOARD, "test", (d) => {
    const ls = boardMaps(d).links;
    for (const l of [...ls.values()]) if (l.to.panel === made.id) ls.delete(l.id);
  });
  const before = calls;
  await assert.rejects(() => runTool(ctx, "refresh_cad", { id: made.id }), /isn't wired/);
  assert.equal(calls, before);
  assert.equal((m.objects.get(made.id) as { fileId: string }).fileId, after1.fileId);
});

test("a card whose feed was written into the board (a copy, or by hand) is never asked, wired or not", async () => {
  const app = (await appCard()) as { id: string };
  const before = calls;
  // a member writes a card claiming to be fed, in someone else's name, and wires it to the app
  editBoard(BOARD, "test", (d) => {
    const m = boardMaps(d);
    m.objects.set("pnl_forged", { id: "pnl_forged", kind: "panel", panel: "file", sectionId: [...m.sections.keys()][0], name: "Forged", x: 0, y: 0, float: false, bornAt: 1, w: 400, h: 300, ports: [{ id: CAD_IN_PORT, name: "model", dir: "in" }], feed: { app: app.id, appName: "Airform BOM", tool: "part_model", args: { part: "hub" }, state: "ok", by: "someone-else" } });
    m.links.set("lnk_forged", { id: "lnk_forged", from: { panel: app.id, port: CAD_OUT_PORT }, to: { panel: "pnl_forged", port: CAD_IN_PORT } });
  });
  await assert.rejects(() => runTool(ctx, "refresh_cad", { id: "pnl_forged" }), /isn't fed|no CAD card/);
  const { fedCards } = await import("../src/cadfeed.ts");
  assert.equal(fedCards(BOARD).includes("pnl_forged"), false);
  assert.equal(calls, before);
});

test("add_cad from a file: a plain 3D card, no wire; a file that isn't a model is refused", async () => {
  const { storeFile } = await import("../src/files.ts");
  const stl = await storeFile(Buffer.from("solid x\nendsolid x\n"), { name: "bracket.stl", mime: "model/stl", boardId: BOARD, userId: "u1" });
  const made = (await runTool(ctx, "add_cad", { name: "Bracket", file_id: stl.id })) as { id: string; wired: boolean };
  assert.equal(made.wired, false);
  const card = boardMaps(getBoard(BOARD).doc).objects.get(made.id) as { feed?: unknown; fileId: string };
  assert.equal(card.feed, undefined);
  assert.equal(card.fileId, stl.id);
  const txt = await storeFile(Buffer.from("hello"), { name: "notes.txt", mime: "text/plain", boardId: BOARD, userId: "u1" });
  await assert.rejects(() => runTool(ctx, "add_cad", { name: "Notes", file_id: txt.id }), /isn't a model/);
  await assert.rejects(() => runTool(ctx, "add_cad", { name: "Nothing" }), /either file_id or from/);
});

test("a viewer can't make or refresh a CAD card", async () => {
  runSql("insert or ignore into users (id, email, name, color, role, created_at) values (?, ?, ?, ?, 'viewer', ?)", "v1", "v1@formindustries.com", "Vee", "#325bb4", Date.now());
  await assert.rejects(() => runTool({ boardId: BOARD, actor: "Vee", userId: "v1" }, "add_cad", { name: "X", file_id: "f_nope" }), /View only|viewer|can't/i);
});
