/**
 * Flowform rooms brought in live through a person's link (flowform-live.ts).
 * A stand-in Flowform answers /mcp with the shapes production answered on
 * 2026-11-11 (list_rooms, room_catalog_v2, read_surface_v2). The rules:
 * a room lands as board ff-<room>, a section per surface; a re-pull updates
 * what changed there, leaves what was edited or removed here, and deletes
 * nothing; files show by name; a Flowform viewer can't bring a room in.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "foundation-test-"));
process.env.FOUNDATION_DATA_DIR = dataDir;

let fake: Server;
let origin = "";
const ROOM = "room-shop";

/** what Flowform has now: tests change it between pulls */
const flowform = {
  rooms: [
    { room_id: ROOM, name: "Shop floor", role: "editor", asset_count: 3 },
    { room_id: "room-look", name: "Lookbook", role: "viewer", asset_count: 0 },
  ],
  plane: [] as Array<Record<string, unknown>>,
  page: [] as Array<Record<string, unknown>>,
  calls: [] as string[],
};

const rect = (x: number, y: number, w = 200, h = 100) => ({ x, y, w, h });
function reset() {
  flowform.plane = [
    { id: "t-1", kind: "text", name: "Plan", rect: rect(500, 300), stack_order: 1, text: "Ship Airform Ones", text_readable: true },
    { id: "tb-1", kind: "table", name: "Contracts", rect: rect(900, 300, 400, 200), stack_order: 2, table: { rows: [["Who", "2026"], ["Kobayashi", "$1.1M"]], columns: [null, null] } },
    { id: "if-1", kind: "iframe", name: null, rect: rect(500, 800, 600, 400), stack_order: 3, url: "https://certform.example" },
    { id: "im-1", kind: "image", name: "Hyperform", rect: rect(1500, 300, 300, 300), stack_order: 4, media: { file_id: "f1", revision_id: "r1", byte_size: 6560408 } },
    { id: "fr-1", kind: "grid", structural: true, name: "Example Frame", rect: rect(0, 0, 1000, 1000) },
  ];
  flowform.page = [{ id: "pg-1", kind: "todo", name: null, rect: rect(300, 300), items: [{ text: "Call BYD", done: false }, { text: "Book flights", done: true }] }];
}
reset();

const catalog = {
  layout: "plane",
  version: 2,
  planes: [
    {
      board_id: "plane-1",
      name: null,
      plane_canvas_id: "canvas-plane",
      surface: { kind: "plane", board_id: "plane-1" },
      grids: [
        {
          name: "Engineering meeting",
          pages: [{ canvas_id: "canvas-page", coordinate: "A1", name: "Summaries", surface: { kind: "grid_canvas", board_id: "plane-1", grid_id: "g-1", canvas_id: "canvas-page" } }],
        },
      ],
    },
  ],
};

const body = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

before(async () => {
  fake = createServer(async (req, res) => {
    const send = (status: number, obj?: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(obj === undefined ? "" : JSON.stringify(obj));
    if (req.url !== "/mcp") return res.writeHead(404).end();
    if (req.headers.authorization !== "Bearer tok-ada") return res.writeHead(401).end("Unauthorized");
    if (req.method !== "POST") return res.writeHead(405).end();
    const msg = JSON.parse(await body(req)) as { id?: number; method: string; params?: { name: string; arguments: Record<string, unknown>; protocolVersion?: string } };
    if (msg.id === undefined) return res.writeHead(202).end();
    let result: unknown = {};
    if (msg.method === "initialize") result = { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "flowform", version: "test" } };
    if (msg.method === "tools/call") {
      const { name, arguments: a } = msg.params!;
      flowform.calls.push(name);
      const out =
        name === "list_rooms"
          ? { rooms: flowform.rooms }
          : name === "room_catalog_v2"
            ? { ...catalog, room_id: a.room_id }
            : name === "read_surface_v2"
              ? { primitives: (a.target as { kind: string }).kind === "plane" ? flowform.plane : flowform.page, truncated: false }
              : null;
      result = out ? { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out } : { isError: true, content: [{ type: "text", text: "no such tool" }] };
    }
    return send(200, { jsonrpc: "2.0", id: msg.id, result });
  });
  await new Promise<void>((ok) => fake.listen(0, "127.0.0.1", ok));
  origin = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  process.env.FLOWFORM_URL = origin;
});
after(async () => {
  fake.close();
  (await import("../src/flowform-live.ts")).stopFlowformSync();
  (await import("../src/boards.ts")).closeBoards();
});

const load = async () => {
  const { config } = await import("../src/config.ts");
  config.flowformUrl = origin;
  const link = await import("../src/flowformlink.ts");
  const { run, one } = await import("../src/db.ts");
  const ada = (await import("../src/auth.ts")).upsertUser("ada@example.com", "Ada").id;
  // Ada's link, as a finished sign-in leaves it
  run(
    "insert or replace into flowform_links (user_id, access, refresh, expires_at, scope, connected_at, client_id) values (?, ?, ?, ?, ?, ?, ?)",
    ada, link.seal("tok-ada"), link.seal("ref-ada"), Date.now() + 3600_000, link.SCOPE, Date.now(), "client-1",
  );
  const live = await import("../src/flowform-live.ts");
  const boards = await import("../src/boards.ts");
  const protocol = await import("@foundation/protocol");
  const members = await import("../src/members.ts");
  const board = () => boards.getBoard("ff-room-shop").doc;
  const obj = (id: string) => protocol.boardMaps(board()).objects.get(id);
  const note = (id: string) => protocol.noteTextOf(board(), obj(id) as { id: string });
  return { ada, live, boards, protocol, members, board, obj, note, one };
};

test("a room lands as its own board: a section per surface, its cards mapped, files by name", async () => {
  const { ada, live, protocol, members, board, obj, note } = await load();
  const r = await live.pullRoom(ada, ROOM);
  assert.equal(r.board, "ff-room-shop");
  assert.equal(r.sections, 2, "the plane and the Grid's page");
  assert.equal(r.cards.create, 5, "the frame is structure, not a card");
  assert.equal(r.byName, 1);

  const m = protocol.boardMaps(board());
  assert.deepEqual([...m.sections.values()].map((s) => s.name).sort(), ["Engineering meeting · Summaries", "Shop floor"]);
  assert.equal(note("ff_t-1"), "Ship Airform Ones");
  assert.equal(obj("ff_tb-1")?.kind, "table");
  assert.deepEqual(protocol.tableCellsOf(board(), "ff_tb-1"), { "0,0": "Who", "1,0": "2026", "0,1": "Kobayashi", "1,1": "$1.1M" });
  assert.equal((obj("ff_if-1") as { panel: string; url: string }).url, "https://certform.example");
  assert.equal(obj("ff_im-1")?.kind, "note");
  assert.match(note("ff_im-1"), /Hyperform[\s\S]*An image in Flowform, 6\.3 MB[\s\S]*allow Flowform file downloads/);
  assert.equal(note("ff_pg-1"), "- [ ] Call BYD\n- [x] Book flights");
  assert.equal(obj("ff_fr-1"), undefined);

  // positions keep their layout: Plan sits left of Contracts, by the same gap as in Flowform
  assert.equal(obj("ff_tb-1")!.x - obj("ff_t-1")!.x, 300);
  // the board is the room's: Ada is on it with her Flowform role, and it's recorded as live
  assert.equal(members.boardRole("ff-room-shop", ada), "editor");
  assert.equal(live.liveRooms()[0].room_id, ROOM);
});

test("pulling again: changes there arrive, edits and removals here stand, nothing is deleted", async () => {
  const { ada, live, protocol, boards, board, obj, note } = await load();
  // nothing changed: nothing written
  const again = await live.pullRoom(ada, ROOM);
  assert.equal(again.cards.unchanged, 5);
  assert.equal(again.cards.create + again.cards.update, 0);

  // someone edits the plan here, and removes the iframe here
  boards.editBoard("ff-room-shop", "test", (doc) => {
    protocol.setNoteText(doc, "ff_t-1", "Ship Airform Ones (Kuulei first)");
    protocol.boardMaps(doc).objects.delete("ff_if-1");
  });
  // meanwhile in Flowform: the plan, the table and the todo change; the image goes
  (flowform.plane[0] as { text: string }).text = "Ship Airform Ones to Kuulei";
  (flowform.plane[1] as { table: { rows: string[][] } }).table.rows[1][1] = "$2.4M";
  (flowform.page[0] as { items: Array<{ done: boolean }> }).items[0].done = true;
  flowform.plane.splice(3, 1);

  const r = await live.pullRoom(ada, ROOM);
  assert.equal(note("ff_t-1"), "Ship Airform Ones (Kuulei first)", "edited here: Foundation's copy wins");
  assert.equal(obj("ff_if-1"), undefined, "removed here: stays removed");
  assert.equal(protocol.tableCellsOf(board(), "ff_tb-1")["1,1"], "$2.4M");
  assert.match(note("ff_pg-1"), /- \[x\] Call BYD/);
  assert.ok(obj("ff_im-1"), "gone from Flowform: left on the board");
  assert.equal(r.goneUpstream, 1);
  assert.deepEqual({ kept: r.cards.kept, removed: r.cards["removed-here"], update: r.cards.update }, { kept: 1, removed: 1, update: 2 });
  reset();
});

test("a card that already holds the real file is never swapped for a note naming it", async () => {
  const { ada, live, protocol, boards, obj } = await load();
  // the backup import (or a person) gave the image its bytes
  boards.editBoard("ff-room-shop", "flowform-import", (doc) => {
    const m = protocol.boardMaps(doc);
    const was = m.objects.get("ff_im-1")!;
    m.objects.set("ff_im-1", { ...was, kind: "media", src: "/files/ff_x", media: "image", autoplay: false, muted: true } as never);
  });
  (flowform.plane[3] as { name: string }).name = "Hyperform v2";
  await live.pullRoom(ada, ROOM);
  assert.equal(obj("ff_im-1")?.kind, "media");
  reset();
});

test("a Flowform viewer can't bring a room in, and a room you're not in isn't found", async () => {
  const { ada, live, one } = await load();
  await assert.rejects(live.pullRoom(ada, "room-look"), /only view “Lookbook”/);
  await assert.rejects(live.pullRoom(ada, "room-nope"), /not in that Flowform room/);
  assert.equal(one("select id from boards where id = 'ff-room-look'"), undefined);
});

test("kept connected: the timer reads pulled rooms again as whoever pulled them", async () => {
  const { ada, live, note } = await load();
  (flowform.plane[0] as { text: string }).text = "Plan, as Flowform has it now";
  // the plan was edited here earlier, so a note that isn't edited shows the sync instead: the todo
  (flowform.page[0] as { items: Array<{ text: string }> }).items[1].text = "Book flights to Osaka";
  const before = flowform.calls.length;
  await live.syncAll();
  assert.ok(flowform.calls.length > before);
  assert.match(note("ff_pg-1"), /Book flights to Osaka/);
  reset();
});
