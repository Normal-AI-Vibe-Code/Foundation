/**
 * Characters: the council's avatars and the pipeline that makes them. Meshy
 * is a stand-in here (MESHY_API_BASE) that takes tasks, counts what it was
 * sent, finishes them on the second ask, and serves a real PNG and a GLB-named
 * file from its own origin.
 *
 * What's held: the studio board is made once; an agent may add a character
 * but every stage that spends credits needs a person's press (a bearer is
 * refused); a stage runs through to files in the archive, and the finished
 * character is ready for the council; each task keeps its prompt word for
 * word, its model and the hashes of its references, never the images' bytes;
 * a send that Meshy never answered is not sent again unless the person says
 * so, while one Meshy refused can simply be pressed again; doing a stage
 * again clears the stages after it and leaves the old files archived; people
 * can't write the `characters` map; and the avatar's mood machine: arriving
 * waves, finishing cheers, failing holds its head, a beat plays out.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-characters-"));
process.env.FOUNDATION_CREW_TRAVEL_MS = "0";
process.env.FOUNDATION_MESHY_POLL_MS = "15";
process.env.MESHY_API_KEY = "msy-test-key";
import { png } from "./fixtures/png.ts";

// ---------- a stand-in Meshy ----------

interface Sent {
  endpoint: string;
  body: Record<string, unknown>;
}
const sent: Sent[] = [];
const asks = new Map<string, number>();
/** what the next create does instead of answering: "drop" hangs up, a number refuses with that status */
let next: "drop" | number | null = null;
let meshy: Server;
let base = "";

before(async () => {
  meshy = createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    const say = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname.startsWith("/dl/")) {
      res.writeHead(200);
      return res.end(url.pathname.endsWith(".glb") ? Buffer.from(`glTF stand-in ${url.pathname}`) : png(24, 32, url.pathname.endsWith("preview.png") ? [90, 90, 200] : [200, 120, 80]));
    }
    if (req.headers.authorization !== "Bearer msy-test-key") return say(401, { message: "bad key" });
    const [, endpoint, id] = /^\/([a-z0-9-]+)(?:\/([^/]+))?$/.exec(url.pathname) ?? [];
    if (endpoint === "balance") return say(200, { balance: 1000 });
    if (req.method === "POST") {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        if (next === "drop") {
          next = null;
          return req.socket.destroy();
        }
        if (typeof next === "number") {
          const status = next;
          next = null;
          return say(status, { message: "Insufficient credits" });
        }
        sent.push({ endpoint, body: JSON.parse(raw) });
        say(200, { result: `${endpoint}-${sent.length}` });
      });
      return;
    }
    // a task is in progress on the first ask and done on the second
    const n = (asks.get(id) ?? 0) + 1;
    asks.set(id, n);
    if (n < 2) return say(200, { id, status: "IN_PROGRESS", progress: 40 });
    const file = (name: string) => `${base}/dl/${id}/${name}`;
    say(200, {
      id,
      status: "SUCCEEDED",
      progress: 100,
      consumed_credits: endpoint === "multi-image-to-3d" ? 30 : endpoint === "rigging" ? 5 : endpoint === "animations" ? 24 : 9,
      image_urls: endpoint.endsWith("-to-image") ? [file("image.png")] : undefined,
      model_urls: endpoint === "multi-image-to-3d" ? { glb: file("model.glb") } : undefined,
      thumbnail_url: endpoint === "multi-image-to-3d" ? file("preview.png") : undefined,
      result: endpoint === "rigging" ? { rigged_character_glb_url: file("rigged.glb") } : endpoint === "animations" ? { animation_glb_url: file("clips.glb") } : undefined,
    });
  });
  await new Promise<void>((r) => meshy.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(meshy.address() as { port: number }).port}`;
  process.env.MESHY_API_BASE = base;
});

const { upsertUser, createSession, requirePerson } = await import("../src/auth.ts");
const { run, all, one } = await import("../src/db.ts");
const { getBoard, closeBoards, listBoards } = await import("../src/boards.ts");
const { setBoardRole } = await import("../src/roles.ts");
const { runTool } = await import("../src/tools.ts");
const { storeFile } = await import("../src/files.ts");
const chars = await import("../src/characters.ts");
const { boardMaps, baseMood, nextMood, seatCrew, MOOD_START, MOODS, MOOD_CLIPS } = await import("@foundation/protocol");

after(() => {
  closeBoards();
  meshy.close();
});

const ada = upsertUser("ada@formindustries.com", "Ada");
const vic = upsertUser("vic@formindustries.com", "Vic");
run("update users set role = 'member' where id in (?, ?)", ada.id, vic.id);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, fn: () => T | undefined | false, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
}

let BOARD = "";
const state = (panel: string) => boardMaps(getBoard(BOARD).doc).characters.get(panel)!;
const done = (panel: string, stage: string) => until(`${stage} to finish`, () => (state(panel).stages as Record<string, { state: string }>)[stage]?.state !== "running" && state(panel));

test("the studio is one board, made once: a row of inspiration and a row of characters, a column per set", () => {
  const made = chars.openStudio(ada);
  assert.equal(made.made, true);
  BOARD = made.id;
  assert.deepEqual(chars.openStudio(vic), { id: BOARD, made: false });
  assert.equal(listBoards().filter((b) => b.name === "Character studio").length, 1);
  const names = [...boardMaps(getBoard(BOARD).doc).sections.values()].map((s) => s.name).sort();
  assert.deepEqual(names, ["Characters · Abstract", "Characters · Animals", "Characters · Anime", "Inspiration · Abstract", "Inspiration · Animals", "Inspiration · Anime"]);
});

test("an agent adds a character; a viewer can't; nothing is sent to Meshy for it", async () => {
  setBoardRole({ ...ada, role: "admin" }, BOARD, vic.id, "viewer");
  const out = (await runTool({ boardId: BOARD, actor: "Wren", userId: ada.id }, "add_character", { name: "Mochi", set: "animals", form: "model", identity: "A small round shiba in a teal scarf." })) as { id: string };
  const c = state(out.id);
  assert.equal(c.name, "Mochi");
  assert.equal(c.form, "model");
  assert.equal(c.ready, false);
  assert.deepEqual(c.stages, {});
  const card = boardMaps(getBoard(BOARD).doc).objects.get(out.id)!;
  assert.equal(card.kind === "panel" && card.panel, "character");
  assert.equal(boardMaps(getBoard(BOARD).doc).sections.get(card.sectionId)!.name, "Characters · Animals");
  assert.equal(sent.length, 0);
  await assert.rejects(() => runTool({ boardId: BOARD, actor: "Vic", userId: vic.id }, "add_character", { name: "x", identity: "y" }), /View only/);
});

test("spending credits needs a person at a browser: a bearer (an agent, MCP, the service token) is refused", () => {
  const token = createSession(ada.id);
  const fakeReq = (headers: Record<string, string>) => ({ headers, query: new URLSearchParams() }) as never;
  assert.throws(() => requirePerson(fakeReq({ authorization: `Bearer ${token}` }), "Spending credits on a character"), /needs a person/);
  assert.equal(requirePerson(fakeReq({ cookie: `foundation_session=${token}` })).id, ada.id);
});

test("a 3D character, stage by stage: sheet, views, model, rig, clips; then it's ready for the council", async () => {
  const ref = await storeFile(png(40, 40, [10, 200, 90]), { name: "inspiration.png", mime: "image/png", boardId: BOARD, userId: ada.id });
  const made = chars.createCharacter(BOARD, { name: "Ada", id: ada.id, human: true }, { name: "Pip", set: "abstract", form: "model", identity: "A green blob wearing sunglasses.", refs: [ref.id, "f_not_a_file"], height: 0.8 });
  const panel = made.panelId;
  assert.deepEqual(state(panel).refs, [ref.id], "a reference that isn't an image on this board is dropped");

  // out of order: the model before the sheet
  await assert.rejects(() => chars.startStage(BOARD, panel, "model", ada), /Draw the sheet first/);
  assert.equal(sent.length, 0);

  let c = await chars.startStage(BOARD, panel, "sheet", ada);
  assert.equal(c.stages.sheet?.state, "running");
  await assert.rejects(() => chars.startStage(BOARD, panel, "sheet", ada), /still on its sheet/);
  c = await done(panel, "sheet");
  assert.equal(c.stages.sheet?.state, "done");
  assert.equal(c.stages.sheet?.credits, 9);
  assert.ok(c.files.front && c.files.thumb === c.files.front);
  // what Meshy was sent: the image inline, and the prompt that's kept
  assert.equal(sent[0].endpoint, "image-to-image");
  assert.match(String((sent[0].body.reference_image_urls as string[])[0]), /^data:image\/png;base64,/);
  assert.equal(sent[0].body.prompt, chars.characterPrompt(c, "front"));
  assert.match(String(sent[0].body.prompt), /^Front view\. A green blob wearing sunglasses\. Orthographic full-body character model sheet/);

  c = await chars.startStage(BOARD, panel, "views", ada);
  c = await done(panel, "views");
  assert.ok(c.files.back && c.files.side);
  assert.equal(c.stages.views?.credits, 18);

  await chars.startStage(BOARD, panel, "model", ada);
  c = await done(panel, "model");
  const model = sent.find((s) => s.endpoint === "multi-image-to-3d")!;
  assert.equal((model.body.image_urls as string[]).length, 3, "front, back and side");
  assert.equal(model.body.pose_mode, undefined, "the sheet is already posed");
  assert.ok(c.files.model && c.files.thumb !== c.files.front, "the model's own preview becomes the still");
  assert.equal(c.ready, false);

  await chars.startStage(BOARD, panel, "rig", ada);
  await done(panel, "rig");
  const rig = sent.find((s) => s.endpoint === "rigging")!;
  assert.deepEqual(rig.body, { input_task_id: `multi-image-to-3d-${sent.indexOf(model) + 1}`, height_meters: 0.8 });

  await chars.startStage(BOARD, panel, "clips", ada);
  c = await done(panel, "clips");
  const clips = sent.find((s) => s.endpoint === "animations")!;
  assert.deepEqual(clips.body.action_ids, MOODS.map((m) => MOOD_CLIPS[m].actionId), "a clip per mood, in the moods' order");
  assert.equal(c.ready, true);

  // the results are files in the archive, on the studio's board
  const kept = one<{ name: string; mime: string; board_id: string }>("select name, mime, board_id from files where id = ?", c.files.clips);
  assert.deepEqual({ ...kept }, { name: "Pip clips.glb", mime: "model/gltf-binary", board_id: BOARD });
  // and the roster offers it, with its file by role
  const r = chars.roster();
  assert.ok(r.characters.find((x) => x.id === c.id)?.ready);
  assert.equal(chars.characterFile(c.id, "clips"), c.files.clips);
  assert.throws(() => chars.characterFile(c.id, "mavatar"), /no such file/);
});

test("lineage: each task keeps its prompt word for word, its model and its references' hashes, never their bytes", () => {
  const pip = chars.roster().characters.find((c) => c.name === "Pip")!;
  const tasks = chars.characterTasks(BOARD, pip.panelId);
  assert.deepEqual(tasks.map((t) => t.role), ["front", "back", "side", "model", "rig", "clips"]);
  const front = tasks[0];
  assert.equal(front.prompt, chars.characterPrompt(pip, "front"));
  assert.equal(front.model, "nano-banana-pro");
  assert.equal(front.by, "Ada");
  assert.equal(front.refHashes.length, 1);
  assert.match(front.refHashes[0], /^[0-9a-f]{64}$/);
  const raw = all<{ request: string }>("select request from character_tasks").map((t) => t.request).join("\n");
  assert.ok(!raw.includes("base64"), "no image bytes in what's kept");
  assert.ok(raw.includes(`sha256:${front.refHashes[0]}`));
  assert.ok(!raw.includes("msy-test-key"));
});

test("a send Meshy never answered isn't sent again unless the person says so; one it refused can be pressed again", async () => {
  const made = chars.createCharacter(BOARD, { name: "Ada", id: ada.id, human: true }, { name: "Nori", set: "anime", form: "mesh", identity: "A girl with a white bob and a red earring." });
  const panel = made.panelId;
  const before = sent.length;

  next = 402;
  let c = await chars.startStage(BOARD, panel, "sheet", ada);
  assert.equal(c.stages.sheet?.state, "failed");
  assert.match(c.stages.sheet!.error!, /not enough credits/);

  next = "drop";
  c = await chars.startStage(BOARD, panel, "sheet", ada);
  assert.equal(c.stages.sheet?.state, "failed");
  assert.match(c.stages.sheet!.error!, /didn't answer/);
  await assert.rejects(() => chars.startStage(BOARD, panel, "sheet", ada), /may have been charged/);
  assert.equal(sent.length, before, "nothing went out");

  await chars.startStage(BOARD, panel, "sheet", ada, { confirm: true });
  c = await done(panel, "sheet");
  assert.equal(c.stages.sheet?.state, "done");
  assert.equal(sent.length, before + 1);
  // no references: drawn from the words alone
  assert.equal(sent[before].endpoint, "text-to-image");
});

test("a send cut off by the server stopping doesn't run forever: at boot the stage says its outcome is unknown", async () => {
  const made = chars.createCharacter(BOARD, { name: "Ada", id: ada.id, human: true }, { name: "Tofu", set: "abstract", form: "model", identity: "A white cube with legs." });
  // as the server would have left it: the stage running, its request written down, no answer kept
  const row = one<{ id: string; state: string }>("select id, state from characters where id = ?", made.id)!;
  const st = JSON.parse(row.state);
  st.stages.sheet = { state: "running", progress: 0, by: "Ada", at: 5 };
  run("update characters set state = ? where id = ?", JSON.stringify(st), made.id);
  run("insert into character_tasks (id, character_id, stage, role, endpoint, request, started_at, status) values ('ctk_cut', ?, 'sheet', 'front', 'text-to-image', '{}', 5, 'submitting')", made.id);
  chars.resumeCharacters();
  const c = state(made.panelId);
  assert.equal(c.stages.sheet?.state, "failed");
  assert.match(c.stages.sheet!.error!, /server stopped/);
  await assert.rejects(() => chars.startStage(BOARD, made.panelId, "sheet", ada), /may have been charged/);
});

test("a mesh avatar: a portrait, then a .mavatar brought in; doing the sheet again clears what came after", async () => {
  const nori = chars.roster().characters.find((c) => c.name === "Nori")!;
  const panel = nori.panelId;
  await assert.rejects(() => chars.startStage(BOARD, panel, "model", ada), /no model stage/);
  await chars.startStage(BOARD, panel, "views", ada);
  let c = await done(panel, "views");
  assert.ok(c.files.portrait && c.files.thumb === c.files.portrait);
  const portrait = sent.at(-1)!;
  assert.match(String(portrait.body.prompt), /^Head-and-shoulders portrait/);

  await assert.rejects(() => chars.attachMavatar(BOARD, panel, Buffer.from("not a zip"), ada), /isn't a .mavatar/);
  const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("rig and layers")]);
  c = await chars.attachMavatar(BOARD, panel, zip, ada);
  assert.equal(c.ready, true);
  assert.equal(c.stages.mesh?.state, "done");
  const mavatar = c.files.mavatar!;

  // someone picks it for an agent name; the roster says so
  assert.deepEqual(chars.setAvatar(ada, "Wren", c.id), { Wren: c.id });
  assert.throws(() => chars.setAvatar(ada, "Kestrel", "chr_none"), /isn't ready/);

  await chars.startStage(BOARD, panel, "sheet", ada);
  c = await done(panel, "sheet");
  assert.equal(c.ready, false);
  assert.deepEqual(Object.keys(c.stages), ["sheet"]);
  assert.equal(c.files.mavatar, undefined);
  assert.equal(one<{ archived_at: number | null }>("select archived_at from files where id = ?", mavatar)?.archived_at, null, "the old avatar's file is still in the archive");
});

test("people can't write the characters map: only the server says what a character has", async () => {
  const Y = await import("yjs");
  const { attachConnection } = await import("../src/boards.ts");
  const { WebSocketServer, WebSocket } = await import("ws");
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  wss.on("connection", (ws) => attachConnection(BOARD, ws, false, ada.id));
  const ws = new WebSocket(`ws://127.0.0.1:${(wss.address() as { port: number }).port}`);
  await new Promise<void>((r) => ws.once("open", () => r()));
  const mochi = chars.roster().characters.find((c) => c.name === "Mochi")!;
  const was = structuredClone(state(mochi.panelId));
  const fake = new Y.Doc();
  Y.applyUpdate(fake, Y.encodeStateAsUpdate(getBoard(BOARD).doc));
  const sv = Y.encodeStateVector(fake);
  fake.getMap("characters").set(mochi.panelId, { ...was, ready: true, files: { clips: "f_someone_elses" } });
  const enc = await import("lib0/encoding");
  const e = enc.createEncoder();
  enc.writeVarUint(e, 0); // sync
  enc.writeVarUint(e, 2); // update
  enc.writeVarUint8Array(e, Y.encodeStateAsUpdate(fake, sv));
  ws.send(enc.toUint8Array(e));
  await sleep(150);
  assert.deepEqual(state(mochi.panelId), was, "the forged state didn't stay");
  ws.close();
  wss.close();
});

test("a character whose card is gone leaves the roster", () => {
  const mochi = chars.roster().characters.find((c) => c.name === "Mochi")!;
  getBoard(BOARD).doc.transact(() => boardMaps(getBoard(BOARD).doc).objects.delete(mochi.panelId));
  assert.ok(!chars.roster().characters.some((c) => c.id === mochi.id));
});

test("the mood machine: arriving waves, reading thinks, writing works, finishing cheers, and a beat plays out", () => {
  assert.equal(baseMood({ status: "working", doing: "reading the board" }), "thinking");
  assert.equal(baseMood({ status: "working", doing: "adding a table of parts" }), "working");
  assert.equal(baseMood({ status: "working", doing: "adding a note", asking: true }), "talking");
  assert.equal(baseMood({ status: "done", doing: "" }), "idle");

  let s = nextMood(MOOD_START, { status: "working", doing: "reading the board" }, 1000);
  assert.equal(s.mood, "waving");
  // the wave isn't cut short by what it's doing
  s = nextMood(s, { status: "working", doing: "adding a note" }, 1500);
  assert.equal(s.mood, "waving");
  s = nextMood(s, { status: "working", doing: "adding a note" }, 1000 + MOOD_CLIPS.waving.holdMs + 1);
  assert.equal(s.mood, "working");
  s = nextMood(s, { status: "working", doing: "searching for the BOM" }, 9000);
  assert.equal(s.mood, "thinking");
  // done: a cheer, then rest
  s = nextMood(s, { status: "done", doing: "" }, 10_000);
  assert.equal(s.mood, "happy");
  s = nextMood(s, { status: "done", doing: "" }, 10_000 + MOOD_CLIPS.happy.holdMs + 1);
  assert.equal(s.mood, "idle");
  // an error holds its head and stays low; being stopped is a surprise
  const err = nextMood({ ...MOOD_START, status: "working" }, { status: "error", doing: "" }, 0);
  assert.equal(err.mood, "sad");
  assert.equal(nextMood(err, { status: "error", doing: "" }, 99_999).mood, "sad");
  assert.equal(nextMood({ ...MOOD_START, status: "working" }, { status: "stopped", doing: "" }, 0).mood, "surprised");
});

test("seating: a chosen character wins, the same name keeps the same one, and two agents don't share while there are enough", () => {
  const ready = ["a", "b", "c"];
  const one = seatCrew(["Wren", "Kestrel", "Juniper"], ready);
  assert.equal(new Set(Object.values(one)).size, 3);
  assert.deepEqual(seatCrew(["Wren", "Kestrel", "Juniper"], ready), one, "steady");
  assert.equal(seatCrew(["Wren"], ready)["Wren"], seatCrew(["Wren"], ready)["Wren"]);
  assert.equal(seatCrew(["Wren", "Kestrel"], ready, { Kestrel: "a" })["Kestrel"], "a");
  assert.notEqual(seatCrew(["Wren", "Kestrel"], ready, { Kestrel: "a" })["Wren"], "a");
  // more agents than characters: they share rather than go without
  assert.equal(Object.keys(seatCrew(["A", "B", "C", "D"], ["x"])).length, 4);
  assert.deepEqual(seatCrew(["A"], []), {});
});
