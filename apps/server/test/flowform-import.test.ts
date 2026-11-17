/**
 * The flowform importer, end to end on a fixture backup in flowform's real
 * formats: room documents written by flowform's own card writers
 * (Yjs v2 snapshot + u32-LE update log, test/fixtures/flowform/data) and a
 * flowform.db holding the tables the importer reads (fixtures/flowform/backup.ts).
 *
 * Checks: the mapping, members and the access gate, media bytes, re-runs
 * (idempotent; upstream changes land; local edits and removals win), missing
 * media filled in later, and that the backup is only read.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import type { NoteDoc } from "@foundation/protocol";
import { LAUNCH, NOA, T, makeBackup, png } from "./fixtures/flowform/backup.ts";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-import-"));
process.env.FOUNDATION_ADMIN_EMAILS = "";

/** append a v2 update to a room's log the way flowform's room writer does */
function appendUpdate(roomDir: string, edit: (doc: Y.Doc) => void) {
  const { loadRoomDoc } = mod;
  const { doc } = loadRoomDoc(roomDir);
  const before = Y.encodeStateVector(doc);
  edit(doc);
  const update = Y.encodeStateAsUpdateV2(doc, before);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(update.length);
  appendFileSync(join(roomDir, "updates.log"), Buffer.concat([len, Buffer.from(update)]));
}

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

let mod: typeof import("../src/flowform-import.ts");
// The fixture's room documents (fixtures/flowform/data/rooms) were never committed: the root
// .gitignore's `data/` caught them (now `/data/`). Until they are, these tests say so instead of crashing.
const MISSING = existsSync(join(import.meta.dirname, "fixtures", "flowform", "data", "rooms"))
  ? false
  : "fixture rooms missing: test/fixtures/flowform/data/rooms was never committed (SPEC §7)";
const fx = MISSING ? (null as unknown as ReturnType<typeof makeBackup>) : makeBackup();
const scratch = [process.env.FOUNDATION_DATA_DIR!, ...(MISSING ? [] : [fx.dir, fx.media])];
after(async () => {
  (await import("../src/boards.ts")).closeBoards();
  for (const d of scratch) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // Windows won't delete the database while this process holds it open; it's a temp folder
    }
  }
});
const BOARD = `ff-${LAUNCH}`;

test("a flowform backup becomes boards, cards, files and members", { skip: MISSING }, async () => {
  mod = await import("../src/flowform-import.ts");
  const { boardMaps } = await import("@foundation/protocol");
  const { getBoard } = await import("../src/boards.ts");
  const { all, one } = await import("../src/db.ts");
  const before = sha(join(fx.dir, "flowform.db"));

  const r = await mod.importFlowform({ dir: fx.dir, media: mod.dirMedia(fx.media) });
  assert.deepEqual(r.users, { created: 3, linked: 0, unchanged: 0, skipped: 1 });
  const launch = r.boards.find((b) => b.room === LAUNCH)!;
  assert.equal(launch.updates, 2, "both logged updates replayed after the snapshot");
  assert.equal(launch.actions, 1, "and the agent action row from flowform.db");
  assert.deepEqual(launch.members, { create: 3, update: 0, unchanged: 0, kept: 0, "removed-here": 0 });
  assert.equal(launch.sections.create, 2);
  assert.equal(launch.objects.create, 12);
  assert.deepEqual(launch.files, { imported: 4, existing: 0, archived: 1, missing: 1 });
  assert.deepEqual(launch.missingMedia, ["files/file-lost/var-lost.pdf"]);
  assert.deepEqual(launch.unmapped, {
    "unplaceable card (no kind or geometry; flowform skips it too)": 1,
    "group (sections are Foundation's grouping)": 1,
    "connector arrow between cards (Foundation wires join app ports)": 1,
    "sticky colour": 2,
    directive: 1,
  });

  const m = boardMaps(getBoard(BOARD).doc);
  assert.equal(m.meta.get("flowformRoom"), LAUNCH);
  assert.deepEqual([...m.sections.values()].map((s) => s.name).sort(), ["Overview", "Shop floor"]);
  const o = (id: string) => m.objects.get(`ff_${id}`) as any;
  assert.equal(o("p-sticky").text, "Order the hinges\nCall Kenji\nChase the anodiser", "the log's later edit wins over the snapshot");
  assert.equal(
    o("p-plan").text,
    "Launch plan\n- Freeze the BOM\n- Book the [chamber](https://example.com/chamber)\n1. Cut\n2. Fold\n> Ship it when it's quiet\n```\nmake release\n```",
  );
  assert.equal(o("p-plan").name, "Plan");
  assert.equal(o("p-late").kind, "note");
  assert.equal(o("p-agent").text, "Filed by the agent");
  assert.equal(o("p-todo").text, "- [x] Order hinges\n- [ ] Book chamber (due 2026-11-09)");
  assert.deepEqual(m.cells.get("ff_p-table"), { "0,0": "Part", "1,0": "Qty", "0,1": "Hinge", "1,1": "4", "0,2": "Panel", "1,2": "2" });
  assert.equal(o("p-table").rows, 3);
  assert.deepEqual([o("p-site").panel, o("p-site").url], ["app", "https://formindustries.com"]);
  assert.deepEqual([o("p-link").panel, o("p-link").url], ["link", "https://github.com/formindustries/bomform"]);
  assert.match(o("p-lost").text, /drawing\.pdf\*\* hasn't arrived from flowform yet \(files\/file-lost\/var-lost\.pdf\)/, "missing bytes leave a note that says so, not a broken card");
  assert.equal(o("p-directive"), undefined);
  // centre → top-left, shifted into the section; all float where flowform had them
  assert.equal(o("p-sticky").float, true);
  // the canvas's top-left card edge (the photo's left, the sticky's top) lands 160 px into the section
  assert.deepEqual([o("p-photo").x, o("p-sticky").y], [160, 160]);
  // and keeps flowform's spacing: plan's top-left (560,120) less sticky's (180,100)
  assert.deepEqual([o("p-plan").x - o("p-sticky").x, o("p-plan").y - o("p-sticky").y], [380, 20]);

  // media: the image is the source rendition's bytes, the video a legacy key, the CAD a file panel
  const fileOf = (src: unknown) => one<{ sha256: string; name: string; archived_at: number | null; board_id: string }>("select * from files where id = ?", String(src).replace("/files/", ""))!;
  const photo = fileOf(o("p-photo").src);
  assert.equal(photo.sha256, createHash("sha256").update(png(240, 160)).digest("hex"), "the source rendition, not the display one");
  assert.equal(photo.board_id, BOARD);
  assert.equal(o("p-clip").media, "video");
  assert.equal(fileOf(o("p-clip").src).name, "clip.mp4");
  assert.equal(o("p-cad").panel, "file");
  assert.equal(fileOf(o("p-cad").fileId).name, "shroud.step");
  const notes = all<{ name: string; archived_at: number | null }>("select name, archived_at from files where name = 'notes.txt'");
  assert.equal(notes.length, 1);
  assert.equal(notes[0].archived_at, (T + 60) * 1000, "removed in flowform → archived here, not dropped");

  // the default room is everyone's; others are members-only
  const home = r.boards.find((b) => b.room === "flowform")!;
  assert.equal(home.open, true);
  assert.equal(all("select * from board_members where board_id = ?", home.board).length, 0);
  assert.deepEqual(
    all<{ email: string; role: string }>("select u.email, m.role from board_members m join users u on u.id = m.user_id where m.board_id = ? order by u.email", BOARD).map((x) => ({ ...x })),
    [
      { email: "noa@formindustries.com", role: "owner" },
      { email: "sam@formindustries.com", role: "editor" },
      { email: "vic@partner.example", role: "viewer" },
    ],
  );
  assert.equal(one<{ role: string }>("select role from users where email = 'noa@formindustries.com'")!.role, "admin");

  assert.equal(sha(join(fx.dir, "flowform.db")), before, "the backup is only read");
});

test("re-running changes nothing", { skip: MISSING }, async () => {
  const { all } = await import("../src/db.ts");
  const rows = all("select seq from board_updates").length;
  const r = await mod.importFlowform({ dir: fx.dir, media: mod.dirMedia(fx.media) });
  const launch = r.boards.find((b) => b.room === LAUNCH)!;
  assert.deepEqual(r.users, { created: 0, linked: 0, unchanged: 3, skipped: 1 });
  assert.equal(launch.objects.unchanged, 12);
  assert.equal(launch.objects.create + launch.objects.update, 0);
  assert.equal(launch.members.unchanged, 3);
  assert.equal(launch.files.existing, 4);
  assert.equal(all("select seq from board_updates").length, rows, "no board writes");
  assert.equal(all("select id from files").length, 4);
});

test("upstream changes land; edits and removals made here win; late media fills its placeholder", { skip: MISSING }, async () => {
  const { boardMaps } = await import("@foundation/protocol");
  const { editBoard, getBoard } = await import("../src/boards.ts");
  const { run } = await import("../src/db.ts");
  const m = () => boardMaps(getBoard(BOARD).doc);

  // a person edits the sticky and removes the late note in Foundation
  editBoard(BOARD, "test", (doc) => {
    const mm = boardMaps(doc);
    mm.objects.set("ff_p-sticky", { ...(mm.objects.get("ff_p-sticky") as NoteDoc), text: "edited in Foundation" });
    mm.objects.delete("ff_p-late");
  });
  // a person changes Sam's access here
  const sam = (await import("../src/db.ts")).one<{ id: string }>("select id from users where email = 'sam@formindustries.com'")!.id;
  run("update board_members set role = 'viewer' where board_id = ? and user_id = ?", BOARD, sam);

  // meanwhile in flowform: the sticky, the plan and the late note change; the link card is deleted
  const roomDir = join(fx.dir, "rooms", LAUNCH);
  appendUpdate(roomDir, (doc) => {
    const prims = doc.getMap("primitives");
    const data = (t: string) => JSON.stringify({ blocks: [{ type: "p", inlines: [{ text: t }] }], align: "left", font_scale: 1, line_height: 1.4, color: 0 });
    (prims.get("p-sticky") as Y.Map<unknown>).set("data", data("changed in flowform"));
    (prims.get("p-plan") as Y.Map<unknown>).set("data", data("New plan"));
    (prims.get("p-late") as Y.Map<unknown>).set("data", data("late, edited"));
    prims.delete("p-link");
  });
  // and the missing drawing reaches the bucket
  fx.put("files/file-lost/var-lost.pdf", "%PDF-1.7 drawing");

  const r = await mod.importFlowform({ dir: fx.dir, media: mod.dirMedia(fx.media) });
  const launch = r.boards.find((b) => b.room === LAUNCH)!;
  assert.equal(launch.updates, 3);
  assert.equal(m().objects.get("ff_p-sticky")!.kind === "note" && (m().objects.get("ff_p-sticky") as { text: string }).text, "edited in Foundation", "edited here: kept");
  assert.equal((m().objects.get("ff_p-plan") as { text: string }).text, "New plan", "untouched here: updated");
  assert.equal(m().objects.get("ff_p-late"), undefined, "removed here: not brought back");
  assert.ok(m().objects.get("ff_p-link"), "deleted in flowform: left on the board");
  assert.equal(launch.goneUpstream, 1);
  const lost = m().objects.get("ff_p-lost") as { kind: string; panel?: string; fileId?: string };
  assert.deepEqual([lost.kind, lost.panel, typeof lost.fileId], ["panel", "file", "string"], "the placeholder became the file");
  assert.deepEqual(
    { kept: launch.objects.kept, removed: launch.objects["removed-here"], update: launch.objects.update },
    { kept: 1, removed: 1, update: 2 },
  );
  assert.equal(launch.members.kept, 1, "Sam's role changed here: kept");
  assert.equal((await import("../src/members.ts")).boardRole(BOARD, sam), "viewer");
  assert.equal(launch.files.imported, 1);
});

test("an imported room is members-only; flowform's default room is open", { skip: MISSING }, async () => {
  const { canSeeBoard, hiddenBoards } = await import("../src/members.ts");
  const { upsertUser } = await import("../src/auth.ts");
  const { one } = await import("../src/db.ts");
  const vic = one<never>("select id, email, name, color, role from users where email = 'vic@partner.example'")!;
  const outsider = upsertUser("someone@formindustries.com", "Someone");
  assert.equal(canSeeBoard(vic, BOARD), true);
  assert.equal(canSeeBoard(outsider, BOARD), false);
  assert.equal(canSeeBoard(outsider, "ff-flowform"), true);
  assert.equal(canSeeBoard(outsider, "company"), true);
  assert.equal(canSeeBoard({ ...outsider, role: "admin" }, BOARD), true);
  assert.deepEqual([...hiddenBoards(outsider)], [BOARD]);

  // search never shows a members-only board's cards to an outsider
  const { searchLocal } = await import("../src/search.ts");
  (await import("../src/db.ts")).indexDoc("board", "ff_p-plan", BOARD, "Plan", "New plan chamber");
  assert.equal(searchLocal("chamber", undefined, 30, hiddenBoards(outsider)).length, 0);
  assert.ok(searchLocal("chamber", undefined, 30, hiddenBoards(vic)).length > 0);
});

test("signing in with flowform finds the imported person by flowform id, even at a new address", { skip: MISSING }, async () => {
  const { admitFlowformUser } = await import("../src/flowform.ts");
  const { boardRole } = await import("../src/members.ts");
  const user = admitFlowformUser({ user_id: NOA, display_name: "Noa Field", email: "noa@newdomain.example", email_verified: true, role: "admin" });
  assert.equal(user.email, "noa@formindustries.com");
  assert.equal(boardRole(BOARD, user.id), "owner");
});

test("a tar.gz backup opens like the directory, and its extraction is removed", { skip: MISSING }, async () => {
  const { execFileSync } = await import("node:child_process");
  const parent = mkdtempSync(join(tmpdir(), "flowform-tar-"));
  scratch.push(parent);
  cpSync(fx.dir, join(parent, "data"), { recursive: true });
  const tar = join(parent, "current.tar.gz");
  execFileSync("tar", ["-czf", tar, "-C", parent, "data"]);
  const { dir, close } = mod.openBackup(tar);
  assert.ok(statSync(join(dir, "flowform.db")).isFile());
  assert.ok(statSync(join(dir, "rooms", LAUNCH, "snapshot.ydoc")).isFile());
  close();
  assert.equal(existsSync(dir), false, "the extraction (everyone's data) is removed afterwards");
});
