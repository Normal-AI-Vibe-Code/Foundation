/**
 * Flowform file downloads (flowformfiles.ts): the person's Flowform session,
 * kept encrypted for downloading their files and nothing else. A grant keeps it
 * only for the Foundation person whose Flowform account it is; a session
 * Flowform ended is forgotten; a room's images, brought in through the link,
 * become image cards once their bytes arrive (flowform-live.ts); a file from
 * search is copied into the board's archive. A stand-in Flowform answers
 * /auth/me, /auth/logout, /me/files/:f/revisions/:r/url, the presigned address,
 * and /mcp with the shapes production answered.
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
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cf000000030101005c0a2d4a0000000049454e44ae426082", "hex");
const SESSION = "c".repeat(32);
const flowform = {
  people: { [SESSION]: { user_id: "ff-ada", display_name: "Ada", email: "ada@example.com", email_verified: true, role: "user" }, ["d".repeat(32)]: { user_id: "ff-kai", display_name: "Kai", email: "kai@example.com", email_verified: true, role: "user" } } as Record<string, { user_id: string; display_name: string; email: string; email_verified: boolean; role: string }>,
  revoked: [] as string[],
  roles: [] as string[],
  files: { f1: { rev: "r1", body: PNG, type: "image/png" }, f9: { rev: "r9", body: Buffer.from("%PDF-1.4 drawing"), type: "application/pdf" } } as Record<string, { rev: string; body: Buffer; type: string }>,
};

const body = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

before(async () => {
  fake = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", origin);
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const json = (status: number, v: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));
    if (url.pathname === "/auth/logout") return (flowform.revoked.push(bearer), res.writeHead(204).end());
    if (url.pathname === "/auth/me") return flowform.people[bearer] && !flowform.revoked.includes(bearer) ? json(200, flowform.people[bearer]) : res.writeHead(401).end();
    const m = /^\/me\/files\/([^/]+)\/revisions\/([^/]+)\/url$/.exec(url.pathname);
    if (m) {
      if (bearer !== SESSION || flowform.revoked.includes(bearer)) return res.writeHead(401).end("missing bearer");
      // as production answered on 2026-11-11: an old client is refused, an unknown role is a 400, a missing rendition a 404
      if (req.headers["x-flowform-client-version"] !== "1.9.0") return res.writeHead(426).end("Flowform 1.9.0 or newer is required. Update the app to continue.");
      const role = url.searchParams.get("role") ?? "";
      flowform.roles.push(role);
      if (!["source", "display", "playback", "thumbnail"].includes(role)) return res.writeHead(400).end("unsupported asset role");
      const f = flowform.files[m[1]];
      if (!f || f.rev !== m[2]) return res.writeHead(404).end("file not found");
      // f1 is an older upload: no source rendition, only display
      if (m[1] === "f1" && role !== "display") return res.writeHead(404).end("file rendition not available");
      return json(200, { url: `${origin}/blob/${m[1]}` });
    }
    const b = /^\/blob\/(\w+)$/.exec(url.pathname);
    if (b) {
      const f = flowform.files[b[1]];
      return res.writeHead(200, { "content-type": f.type, "content-length": f.body.length }).end(f.body);
    }
    if (url.pathname === "/mcp") {
      if (bearer !== "tok-ada") return res.writeHead(401).end();
      if (req.method !== "POST") return res.writeHead(405).end();
      const msg = JSON.parse(await body(req)) as { id?: number; method: string; params?: { name: string; arguments: Record<string, unknown>; protocolVersion?: string } };
      if (msg.id === undefined) return res.writeHead(202).end();
      let result: unknown = {};
      if (msg.method === "initialize") result = { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "flowform", version: "test" } };
      if (msg.method === "tools/call") {
        const name = msg.params!.name;
        const out =
          name === "list_rooms"
            ? { rooms: [{ room_id: ROOM, name: "Shop floor", role: "editor", asset_count: 2 }] }
            : name === "search"
              ? {
                  // as production answered: a match in <b>, a Slack file with an address of its own, an upload with a revision
                  results: [
                    { file_id: "f1", title: "Hyperform.png", kind: "image", source: "flowform", snippet: "the <b>hyper</b>form <i>bracket</i> &amp; plate", revision_id: "r1", byte_size: PNG.length, context: { board: "Shop floor" } },
                    { file_id: "s7", title: "hyper notes", kind: "doc", source: "slack", external_url: "https://example.slack.com/files/s7", revision_id: null, context: { channel: "shop" } },
                    { file_id: "x1", title: "bad link", kind: "doc", source: "figma", external_url: "javascript:alert(1)", revision_id: "../../etc" },
                  ].filter(() => String(msg.params!.arguments.query).includes("hyper")),
                }
            : name === "room_catalog_v2"
              ? { layout: "plane", planes: [{ board_id: "p1", name: null, plane_canvas_id: "c-plane", surface: { kind: "plane", board_id: "p1" }, grids: [] }] }
              : {
                  primitives: [
                    { id: "im-1", kind: "image", name: "Hyperform", rect: { x: 300, y: 300, w: 300, h: 200 }, media: { file_id: "f1", revision_id: "r1", byte_size: PNG.length } },
                    // as Flowform answers a file card: its file at the top level, media all null
                    { id: "fr-1", kind: "file_reference", name: "Drawing", rect: { x: 800, y: 300, w: 300, h: 200 }, file_id: "f9", revision_id: "r9", media: { file_id: null, revision_id: null, byte_size: null } },
                    // a 3D model Flowform names no file for
                    { id: "m3-1", kind: "model_3d", name: null, rect: { x: 800, y: 700, w: 300, h: 200 }, file_id: null, revision_id: null },
                    { id: "im-2", kind: "image", name: "Gone", rect: { x: 300, y: 700, w: 300, h: 200 }, media: { file_id: "f-gone", revision_id: "r0", byte_size: 10 } },
                  ],
                };
        result = { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
      }
      return json(200, { jsonrpc: "2.0", id: msg.id, result });
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((ok) => fake.listen(0, "127.0.0.1", ok));
  origin = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  process.env.FLOWFORM_URL = origin;
});
after(async () => {
  fake.close();
  (await import("../src/boards.ts")).closeBoards();
});

const load = async () => {
  const { config } = await import("../src/config.ts");
  config.flowformUrl = origin;
  const { run, one } = await import("../src/db.ts");
  const auth = await import("../src/auth.ts");
  const ada = auth.upsertUser("ada@example.com", "Ada").id;
  run("update users set flowform_user_id = 'ff-ada' where id = ?", ada);
  const link = await import("../src/flowformlink.ts");
  run(
    "insert or replace into flowform_links (user_id, access, refresh, expires_at, scope, connected_at, client_id) values (?, ?, ?, ?, ?, ?, ?)",
    ada, link.seal("tok-ada"), link.seal("ref-ada"), Date.now() + 3600_000, link.SCOPE, Date.now(), "client-1",
  );
  const files = await import("../src/flowformfiles.ts");
  const live = await import("../src/flowform-live.ts");
  return { ada, run, one, link, files, live };
};

test("allowing downloads keeps only your own Flowform account's session, encrypted", async () => {
  const { ada, one, link, files } = await load();
  assert.equal(files.canDownload(ada), false);

  // a grant that comes back with someone else's Flowform session keeps nothing, and that session is ended
  const g1 = files.beginGrant(ada, "http://localhost:4410");
  const n1 = decodeURIComponent(new URL(g1.url).searchParams.get("cb")!).split("/").pop()!;
  const t1 = files.takeGrant(n1)!;
  await assert.rejects(files.finishGrant(t1.userId, { user_id: "ff-kai" }, "d".repeat(32)), /different Flowform account/);
  assert.ok(flowform.revoked.includes("d".repeat(32)));
  assert.equal(files.canDownload(ada), false);
  assert.equal(files.takeGrant(n1), undefined, "a grant is spent once");

  // her own: kept, sealed
  const g2 = files.beginGrant(ada, "http://localhost:4410");
  const t2 = files.takeGrant(decodeURIComponent(new URL(g2.url).searchParams.get("cb")!).split("/").pop()!)!;
  await files.finishGrant(t2.userId, { user_id: "ff-ada" }, SESSION);
  assert.equal(files.canDownload(ada), true);
  const row = one<{ token: string }>("select token from flowform_sessions where user_id = ?", ada)!;
  assert.ok(!row.token.includes(SESSION), "not in the clear");
  assert.equal(link.unseal(row.token), SESSION);
});

test("a file's bytes come through the person's session; a file without its original comes as the next rendition", async () => {
  const { ada, files } = await load();
  const got = await files.fileBytes(ada, "f1", "r1");
  assert.ok(got && got.body.equals(PNG));
  assert.equal(got!.mime, "image/png");
  assert.deepEqual(flowform.roles.slice(0, 3), ["source", "playback", "display"], "the original first; a file without one, the next rendition");
  assert.equal(await files.fileBytes(ada, "f-gone", "r0"), null);
  await assert.rejects(files.fileBytes(ada, "../etc", "r1"), /not a Flowform file id/);
});

test("a room's images and files arrive as themselves, in the background, and the cards follow", async () => {
  const { ada, one, live } = await load();
  const protocol = await import("@foundation/protocol");
  const boards = await import("../src/boards.ts");
  const r = await live.pullRoom(ada, ROOM);
  assert.equal(r.filesComing, 3);
  await live.filesSettled(ROOM);
  const m = protocol.boardMaps(boards.getBoard("ff-room-shop").doc);
  const im = m.objects.get("ff_im-1") as { kind: string; src: string; media: string };
  assert.equal(im.kind, "media");
  assert.equal(im.media, "image");
  const fid = live.fileIdFor(ROOM, "f1");
  assert.equal(im.src, `/files/${fid}`);
  const stored = one<{ name: string; mime: string; board_id: string; uploaded_by: string }>("select name, mime, board_id, uploaded_by from files where id = ?", fid)!;
  assert.deepEqual({ ...stored }, { name: "Hyperform.png", mime: "image/png", board_id: "ff-room-shop", uploaded_by: ada });
  const fr = m.objects.get("ff_fr-1") as { kind: string; panel: string; fileId: string };
  assert.equal(fr.panel, "file");
  assert.equal(fr.fileId, live.fileIdFor(ROOM, "f9"));
  // a card Flowform names no file for says so
  assert.match(String(protocol.noteTextOf(boards.getBoard("ff-room-shop").doc, m.objects.get("ff_m3-1") as { id: string })), /doesn't give its file to other apps/);
  // one Flowform wouldn't give stays a note naming it, and isn't asked for on every read
  assert.equal(m.objects.get("ff_im-2")?.kind, "note");
  const asked = flowform.roles.length;
  const again = await live.pullRoom(ada, ROOM);
  assert.equal(again.filesComing, 0);
  assert.equal(flowform.roles.length, asked);
});

test("a file from search is copied into the board's archive once", async () => {
  const { ada, one, live } = await load();
  const a = await live.bringFlowformFile(ada, "company", "me", { file_id: "f9", revision_id: "r9", name: "Drawing" });
  assert.equal(a?.name, "Drawing.pdf");
  const b = await live.bringFlowformFile(ada, "company", "me", { file_id: "f9", revision_id: "r9", name: "Drawing" });
  assert.equal(b?.id, a?.id);
  assert.equal(one<{ n: number }>("select count(*) n from files where id = ?", a!.id)!.n, 1);
});

test("the one search finds the person's Flowform files, as them, with Flowform's marks as Foundation's", async () => {
  const { ada } = await load();
  const auth = await import("../src/auth.ts");
  const { searchAll } = await import("../src/search.ts");
  const mine = (await searchAll("hyper", { userId: ada })).hits.filter((h) => h.source === "flowform");
  assert.deepEqual(mine.map((h) => h.title), ["Hyperform.png", "hyper notes", "bad link"]);
  // Flowform's <b> is «», and none of its HTML is left
  assert.equal(mine[0].snippet, "the «hyper»form bracket & plate");
  assert.deepEqual(mine[0].flowform, { fileId: "f1", revisionId: "r1", kind: "image", bytes: PNG.length, origin: "flowform" });
  // downloads are allowed for Ada, so a picture has a small one to show; a Slack file keeps its own address
  assert.equal(mine[0].thumb, "/files/flowform/f1/r1/thumb");
  assert.equal(mine[1].url, "https://example.slack.com/files/s7");
  assert.equal(mine[1].thumb, undefined);
  // an address that isn't http(s) and a revision that isn't an id never reach the page
  assert.equal(mine[2].url, undefined);
  assert.equal(mine[2].flowform?.revisionId, undefined);
  // someone without a link asks Flowform nothing; a local-only search doesn't either
  const kai = auth.upsertUser("kai@example.com", "Kai").id;
  assert.equal((await searchAll("hyper", { userId: kai })).hits.filter((h) => h.source === "flowform").length, 0);
  assert.equal((await searchAll("hyper", { userId: ada, remote: false })).hits.filter((h) => h.source === "flowform").length, 0);
});

test("a file's small picture comes as the person, once, and is never another person's", async () => {
  const { ada, files } = await load();
  const auth = await import("../src/auth.ts");
  flowform.roles.length = 0;
  const pic = await files.fileThumb(ada, "f1", "r1");
  assert.equal(pic?.mime, "image/png");
  // f1 has no thumbnail rendition: the display one stands in; the original is never asked for a list
  assert.deepEqual(flowform.roles, ["thumbnail", "display"]);
  await files.fileThumb(ada, "f1", "r1");
  assert.equal(flowform.roles.length, 2, "asked once");
  // a PDF's "picture" isn't one
  assert.equal(await files.fileThumb(ada, "f9", "r9"), null);
  // Kai has no session: nothing of Ada's answers for him
  const kai = auth.upsertUser("kai@example.com", "Kai").id;
  await assert.rejects(() => files.fileThumb(kai, "f1", "r1"), /aren't allowed for you yet/);
});

test("a room's files can be listed without bringing the room in", async () => {
  const { ada, live } = await load();
  const list = await live.roomFiles(ada, ROOM);
  // the image, the file card and the image whose bytes are gone; the model Flowform names no file for isn't listed
  assert.deepEqual(list.map((f) => [f.title, f.flowform?.kind, f.flowform?.fileId]), [["Hyperform", "image", "f1"], ["Drawing", "file", "f9"], ["Gone", "image", "f-gone"]]);
  assert.equal(list[0].thumb, "/files/flowform/f1/r1/thumb");
  assert.equal(list[1].thumb, undefined);
});

test("a session Flowform ended is forgotten and says so; stopping ends it at Flowform", async () => {
  const { ada, files } = await load();
  flowform.revoked.push(SESSION);
  await assert.rejects(files.fileBytes(ada, "f1", "r1"), /ended the session/);
  assert.equal(files.canDownload(ada), false);

  flowform.revoked.length = 0;
  files.keepSession(ada, "ff-ada", SESSION);
  await files.dropSession(ada);
  assert.equal(files.canDownload(ada), false);
  assert.ok(flowform.revoked.includes(SESSION));
});
