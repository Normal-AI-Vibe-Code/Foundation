/**
 * Voice and video notes as agents and the grid's moves see them (2026-11-25; docs/timeline.md §4):
 *  - read_board names a note for what it is: who (a claim, "says it is by", unless the timeline saw it left), how long,
 *    when, its file; read_card gives the same facts
 *    (and no wave); a picture's line is as it was.
 *  - a section made into its own grid carries a note whole, its `note.fileId` the new grid's file, as `src` is.
 *  - send_to_board does the same on the other board.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-medianotes-"));
process.env.FOUNDATION_AGENT_SCRIPT = "1";
process.env.FOUNDATION_ADMIN_EMAILS = "boss@formindustries.com";
process.env.FOUNDATION_STARTER_DIR = "";
process.env.MESHY_API_KEY = "";

const { createBoardRow, getBoard, closeBoards, editBoard } = await import("../src/boards.ts");
const { upsertUser } = await import("../src/auth.ts");
const { runTool } = await import("../src/tools.ts");
const { storeFile } = await import("../src/files.ts");
const { extractSection } = await import("../src/subgrids.ts");
const { _resetCrew } = await import("../src/crew.ts");
const { appendSection, boardMaps } = await import("@foundation/protocol");
import type { MediaDoc } from "@foundation/protocol";

after(() => {
  _resetCrew();
  closeBoards();
});

const ada = upsertUser("ada@formindustries.com", "Ada Lovelace");
const ctx = (boardId: string) => ({ boardId, actor: ada.name, userId: ada.id, person: true });
const base = { x: 0, y: 0, float: false, bornAt: 1 };
const AT = Date.UTC(2026, 10, 25, 14, 32);

async function grid(name: string) {
  const id = createBoardRow(name);
  const voice = await storeFile(Buffer.from(`webm of ${name}`), { name: "voice-note-ada.webm", mime: "audio/webm", boardId: id, userId: ada.id });
  const clip = await storeFile(Buffer.from(`mp4 of ${name}`), { name: "video-note-ada.mp4", mime: "video/mp4", boardId: id, userId: ada.id });
  const pic = await storeFile(Buffer.from(`png of ${name}`), { name: "sketch.png", mime: "image/png", boardId: id, userId: ada.id });
  const sec = editBoard(id, "test", (doc) => {
    const m = boardMaps(doc);
    const s = appendSection(doc, "Review");
    m.objects.set("media_voice", {
      id: "media_voice", kind: "media", sectionId: s.id, name: "Voice note · Ada", ...base, w: 320, h: 100, src: `/files/${voice.id}`, media: "audio", autoplay: false, muted: false,
      note: { by: ada.id, byName: "Ada Lovelace", at: AT, ms: 42_400, fileId: voice.id, mime: "audio/webm", peaks: [0.1, 1, 0.5] },
    } satisfies MediaDoc);
    m.objects.set("media_video", {
      id: "media_video", kind: "media", sectionId: s.id, name: "Video note · Ada", ...base, w: 320, h: 206, src: `/files/${clip.id}`, media: "video", autoplay: false, muted: false,
      note: { by: ada.id, byName: "Ada Lovelace", at: AT, ms: 75_000, fileId: clip.id, mime: "video/mp4" },
    } satisfies MediaDoc);
    m.objects.set("media_pic", { id: "media_pic", kind: "media", sectionId: s.id, name: "sketch.png", ...base, w: 300, h: 200, src: `/files/${pic.id}`, media: "image", autoplay: false, muted: true } satisfies MediaDoc);
    return s;
  });
  return { id, sec, voice, clip };
}

test("read_board says what a note is: who, how long, when and its file; a picture's line is as it was", async () => {
  const g = await grid("Notes A");
  const out = String(await runTool(ctx(g.id), "read_board", {}));
  assert.match(out, new RegExp(`- voice note "Voice note · Ada" says it is by Ada Lovelace, 0:42 long, left 2026-11-25 14:32 UTC, file ${g.voice.id} \\(media_voice\\)`));
  assert.match(out, new RegExp(`- video note "Video note · Ada" says it is by Ada Lovelace, 1:15 long, left 2026-11-25 14:32 UTC, file ${g.clip.id} \\(media_video\\)`));
  assert.match(out, /- media "sketch.png" \(media_pic\)/);
});

test("read_card gives a note's facts in words, without its wave", async () => {
  const g = await grid("Notes B");
  const card = (await runTool(ctx(g.id), "read_card", { id: "media_voice" })) as Record<string, unknown>;
  assert.equal(card.kind, "voice note");
  // nothing on the timeline says who left it (it is not kept here), so the card's word is only a claim
  assert.equal(card.by, null);
  assert.equal(card.says_by, "Ada Lovelace");
  assert.equal(card.duration, "0:42");
  assert.equal(card.file, g.voice.id);
  assert.equal(card.at, new Date(AT).toISOString());
  assert.equal((card.note as { peaks?: unknown }).peaks, undefined);
  const pic = (await runTool(ctx(g.id), "read_card", { id: "media_pic" })) as Record<string, unknown>;
  assert.equal(pic.kind, "media");
});

test("a section made its own grid carries its notes whole, each naming the new grid's file", async () => {
  const g = await grid("Notes C");
  const out = extractSection(g.id, g.sec.id, { userId: ada.id, name: "Ada", role: "human" });
  const there = boardMaps(getBoard(out.board).doc);
  const v = there.objects.get("media_voice") as MediaDoc;
  assert.ok(v.note, "the note went with it");
  assert.equal(v.note!.byName, "Ada Lovelace");
  assert.deepEqual(v.note!.peaks, [0.1, 1, 0.5]);
  assert.equal(v.src, `/files/${v.note!.fileId}`, "src and note name the same file");
  assert.notEqual(v.note!.fileId, g.voice.id, "the new grid's own record of the bytes");
  const c = there.objects.get("media_video") as MediaDoc;
  assert.equal(c.src, `/files/${c.note!.fileId}`);
});

test("send_to_board takes a note with its file named on the other board", async () => {
  const g = await grid("Notes D");
  const to = createBoardRow("Elsewhere");
  await runTool(ctx(g.id), "send_to_board", { id: "media_voice", to_board: to, request_id: "s1" });
  const v = boardMaps(getBoard(to).doc).objects.get("media_voice") as MediaDoc;
  assert.ok(v?.note);
  assert.equal(v.src, `/files/${v.note!.fileId}`);
  assert.notEqual(v.note!.fileId, g.voice.id);
  assert.equal(boardMaps(getBoard(g.id).doc).objects.get("media_voice"), undefined);
});
