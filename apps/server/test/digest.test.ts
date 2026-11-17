/**
 * The daily digest (digest.ts): its markdown from fixed facts, one note per
 * day (again the same day updates it; a restart doesn't add one), the cap of
 * 14 kept by reusing the oldest note (never a delete), FOUNDATION_DIGEST=0,
 * and the tool's rules (a viewer is refused; request_id is idempotent).
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-test-"));
process.env.FOUNDATION_ADMIN_EMAILS = "boss@formindustries.com";
// the tool reads the real connectors: point them at nothing, so they answer "offline" quickly
for (const k of ["FACTORYFORM_URL", "DATAROOM_URL", "VISION_URL", "CREATION_URL", "CREATION_HUB_URL", "T3_URL"]) process.env[k] = "http://127.0.0.1:9";

const { run, all } = await import("../src/db.ts");
const { upsertUser } = await import("../src/auth.ts");
const { runTool } = await import("../src/tools.ts");
const { getBoard, editBoard, closeBoards } = await import("../src/boards.ts");
const { renderDigest, writeDigest, digestTick, startDigest, DIGEST_SECTION } = await import("../src/digest.ts");
import type { ConnSnap } from "../src/digest.ts";
const { boardMaps, findSection, noteTextOf, appendSection, putNote } = await import("@foundation/protocol");
import type { ConnectorState } from "../src/connectors.ts";

after(() => closeBoards());

const ada = upsertUser("ada@formindustries.com", "Ada");
const vic = upsertUser("vic@formindustries.com", "Vic");
run("update users set role = 'viewer' where id = ?", vic.id);

const at = (day: number, h: number, min = 0) => new Date(2026, 10, day, h, min);

test("the markdown, for a fixed activity log and two connector snapshots", () => {
  const snap = (id: string, name: string, ok: boolean, summary: string, metrics: Array<[string, string]> = [], items: string[] = [], extra: Partial<ConnSnap> = {}): ConnSnap => ({
    id,
    name,
    ok,
    summary,
    metrics: metrics.map(([label, value]) => ({ label, value })),
    items,
    ...extra,
  });
  const md = renderDigest({
    now: at(7, 7),
    since: at(6, 7),
    before: {
      board: { sections: { s1: "Company", s2: "Design" }, cards: { c1: "FactoryForm", c2: "Old sketch" } },
      connectors: [
        snap("factoryform", "FactoryForm", true, "6 stations · 4 units in progress", [["Units in progress", "4"], ["Open alerts", "1"]], ["Open alerts: Station 3 low on stock"]),
        snap("bomform", "BomForm", false, "no BomForm key here", [], [], { offlineSince: at(5, 7).getTime() }),
        snap("vision", "Vision", true, "Vision Code (T3) at 127.0.0.1:3783"),
        snap("dataroom", "Airform Data Room", true, "reachable"),
        snap("creation", "Creation", false, "not running", [], [], { offlineSince: at(6, 7).getTime() }),
      ],
    },
    board: { sections: { s1: "Company", s2: "Design", s3: "Parts" }, cards: { c1: "FactoryForm", c3: "Parts list", c4: "Supplier map" } },
    activity: [
      { at: at(6, 8).getTime(), who: "Ada", role: "human", text: "asked the agent: plan the week" },
      { at: at(6, 8, 1).getTime(), who: "Wren", role: "agent", text: "added section “Parts”" },
      { at: at(6, 8, 2).getTime(), who: "Wren", role: "agent", text: "wrote “Parts list”" },
    ],
    activityClipped: false,
    connectors: [
      snap("factoryform", "FactoryForm", true, "6 stations · 6 units in progress", [["Units in progress", "6"], ["Open alerts", "2"]], ["Open alerts: Station 3 low on stock", "Open alerts: Press 2 down"], { label: "prototype" }),
      snap("bomform", "BomForm", false, "no BomForm key here", [], [], { offlineSince: at(5, 7).getTime() }),
      snap("vision", "Vision", false, "not running on this machine", [], [], { offlineSince: at(7, 7).getTime() }),
      snap("dataroom", "Airform Data Room", true, "reachable"),
      snap("creation", "Creation", true, "studio at 127.0.0.1:5173"),
    ],
  });
  assert.equal(
    md,
    [
      "# What changed · Sat 7 Nov",
      "",
      "*Since Fri 6 Nov 07:00, the last digest.*",
      "",
      "## On the board",
      "- 3 actions by 1 person and 1 agent",
      "- **Wren** (agent) · 2: wrote “Parts list”; added section “Parts”",
      "- **Ada** · 1: asked the agent: plan the week",
      "- Sections added (1): Parts",
      "- Cards added (2): Parts list, Supplier map",
      "- Cards removed: 1",
      "",
      "## FactoryForm · prototype",
      "- Units in progress: 4 → 6",
      "- Open alerts: 1 → 2",
      "- New: Press 2 down (Open alerts)",
      "",
      "## BomForm",
      "- Offline since at least Thu 5 Nov 07:00: no BomForm key here",
      "",
      "## Vision",
      "- Offline: not running on this machine. It was live at the last digest (Fri 6 Nov 07:00)",
      "",
      "## Airform Data Room",
      "- No change.",
      "",
      "## Creation",
      "- Back online (it was offline at the last digest): studio at 127.0.0.1:5173",
      "",
      "*Written by Foundation at 07:00 from the board's activity and each company system's own reading. No model wrote it.*",
    ].join("\n"),
  );
});

test("the first digest on a board says there's nothing to compare yet, and a quiet board says no change", () => {
  const md = renderDigest({ now: at(7, 7), since: at(6, 7), before: null, board: { sections: { s1: "A" }, cards: {} }, activity: [], activityClipped: false, connectors: [] });
  assert.match(md, /\*The first digest on this board: the last 24 hours\.\*/);
  assert.match(md, /- 1 section and 0 cards on the board; this is the first digest here/);
  const quiet = renderDigest({ now: at(8, 7), since: at(7, 7), before: { board: { sections: { s1: "A" }, cards: {} }, connectors: [] }, board: { sections: { s1: "A" }, cards: {} }, activity: [], activityClipped: false, connectors: [] });
  assert.match(quiet, /## On the board\n- No change\.\n/);
});

// ---------- writing it on a board ----------

let factory: ConnectorState = { id: "factoryform", name: "FactoryForm", ok: true, url: "", summary: "6 stations", metrics: [{ label: "Units in progress", value: 4 }], checkedAt: 0 };
const read = async () => [factory, { id: "bomform", name: "BomForm", ok: false, url: "", summary: "offline — no BomForm key here", metrics: [], checkedAt: 0 } satisfies ConnectorState];

/** the digest section's notes in flow order (the flow runs by bornAt) */
function digestNotes(boardId: string) {
  const doc = getBoard(boardId).doc;
  const sec = findSection(doc, DIGEST_SECTION);
  if (!sec) return [];
  return [...boardMaps(doc).objects.values()]
    .filter((o) => o.sectionId === sec.id && o.kind === "note")
    .sort((a, b) => a.bornAt - b.bornAt)
    .map((o) => ({ id: o.id, name: o.name, createdBy: o.createdBy, text: noteTextOf(doc, o as { id: string }) }));
}

test("one note a day: again the same day updates it, a restart doesn't add one, the next morning adds the next first", async () => {
  const b = "digest-day";
  editBoard(b, "test", (d) => appendSection(d, "Work"));
  // activity at fixed times (logActivity stamps the real clock)
  const act = (when: Date, who: string, text: string) => editBoard(b, "test", (d) => boardMaps(d).activity.push([{ at: when.getTime(), who, role: "human", text }]));
  act(at(7, 6), "Ada", "asked the agent: plan the week");

  const first = await writeDigest(b, { now: at(7, 7), read });
  assert.equal(first?.did, "added");
  let notes = digestNotes(b);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].name, "What changed · Sat 7 Nov");
  assert.equal(notes[0].createdBy, undefined); // Foundation's own, not a crew agent's
  assert.match(notes[0].text, /- \*\*Ada\*\* · 1: asked the agent/);
  assert.match(notes[0].text, /## BomForm\n- Offline: no BomForm key here/);
  const log = boardMaps(getBoard(b).doc).activity.toArray();
  assert.deepEqual(
    { who: log.at(-1)!.who, role: log.at(-1)!.role, text: log.at(-1)!.text, objectId: log.at(-1)!.objectId },
    { who: "Foundation", role: "system", text: "wrote the daily digest for Sat 7 Nov", objectId: first!.id },
  );

  // later the same day: the same note, brought up to date (the window still starts where it did)
  act(at(7, 8), "Kai", "started recording Huddle");
  const again = await writeDigest(b, { now: at(7, 9), read, by: "Ada" });
  assert.equal(again?.did, "updated");
  assert.equal(again?.id, first?.id);
  notes = digestNotes(b);
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /2 actions by 2 people/); // its own "wrote the daily digest" line isn't counted
  assert.equal(boardMaps(getBoard(b).doc).activity.toArray().at(-1)!.text, "updated the daily digest for Sat 7 Nov (asked by Ada)");

  // a restart: the board comes back from SQLite, and the timer finds today's already written
  closeBoards();
  assert.equal(await digestTick(at(7, 10), read, b), null);
  assert.equal(digestNotes(b).length, 1);

  // the next morning: nothing before the hour, then the next note, first in the flow
  factory = { ...factory, metrics: [{ label: "Units in progress", value: 6 }] };
  assert.equal(await digestTick(at(8, 6, 59), read, b), null);
  const next = await digestTick(at(8, 7), read, b);
  assert.equal(next?.did, "added");
  notes = digestNotes(b);
  assert.deepEqual(notes.map((n) => n.name), ["What changed · Sun 8 Nov", "What changed · Sat 7 Nov"]);
  assert.match(notes[0].text, /\*Since Sat 7 Nov 09:00, the last digest\.\*/); // from the update, not the first write
  assert.match(notes[0].text, /- Units in progress: 4 → 6/);
  assert.match(notes[0].text, /- Offline since at least Sat 7 Nov 07:00: no BomForm key here/);
  assert.match(notes[0].text, /## On the board\n- No change\./);
  assert.equal(await digestTick(at(8, 18), read, b), null);
  assert.equal(digestNotes(b).length, 2);
});

test("the cap: 14 kept, the oldest reused for the newest (nothing deleted), a person's card untouched", async () => {
  const b = "digest-cap";
  const sec = editBoard(b, "test", (d) => appendSection(d, DIGEST_SECTION));
  editBoard(b, "test", (d) => putNote(d, { id: "note_mine", kind: "note", sectionId: sec.id, name: "Mine", x: 0, y: 0, float: false, bornAt: 1, w: 300, h: 200, text: "kept" }));
  const ids = new Set<string>();
  for (let i = 0; i < 16; i++) ids.add((await writeDigest(b, { now: new Date(2026, 10, 7 + i, 7), read }))!.id);
  assert.equal(ids.size, 14); // two days reused a note
  const notes = digestNotes(b);
  const titles = notes.filter((n) => n.id !== "note_mine").map((n) => n.name);
  assert.equal(titles.length, 14);
  assert.equal(titles[0], "What changed · Sun 22 Nov"); // newest first
  assert.equal(titles[13], "What changed · Mon 9 Nov"); // 7 and 8 Nov were reused
  assert.equal(notes.at(-1)!.id, "note_mine");
  assert.equal(notes.at(-1)!.text, "kept");
  const rows = all<{ day: string; note_id: string | null }>("select day, note_id from digest_days where board_id = ? order by day", b);
  assert.equal(rows.length, 16);
  assert.deepEqual(rows.slice(0, 2).map((r) => r.note_id), [null, null]);
});

test("FOUNDATION_DIGEST=0: the timer writes nothing", async () => {
  process.env.FOUNDATION_DIGEST = "0";
  try {
    assert.equal(await digestTick(at(7, 12), read, "digest-off"), null);
    assert.equal(findSection(getBoard("digest-off").doc, DIGEST_SECTION), undefined);
    assert.equal(all("select * from digest_days where board_id = 'digest-off'").length, 0);
    startDigest()(); // starts no timer; its stop is a no-op
  } finally {
    delete process.env.FOUNDATION_DIGEST;
  }
});

test("write_digest: a viewer is refused; a member's request_id runs it once", async () => {
  editBoard("digest-tool", "test", (d) => appendSection(d, "Work"));
  await assert.rejects(() => runTool({ boardId: "digest-tool", actor: "Vic", userId: vic.id }, "write_digest", {}), /View only/);
  assert.equal(findSection(getBoard("digest-tool").doc, DIGEST_SECTION), undefined);

  const ctx = { boardId: "digest-tool", actor: "Ada", userId: ada.id };
  const a = (await runTool(ctx, "write_digest", { request_id: "r1" })) as { id: string; did: string };
  const entries = boardMaps(getBoard("digest-tool").doc).activity.length;
  const b = (await runTool(ctx, "write_digest", { request_id: "r1" })) as { id: string };
  assert.equal(b, a);
  assert.equal(boardMaps(getBoard("digest-tool").doc).activity.length, entries);
  assert.equal(a.did, "added");
  const text = digestNotes("digest-tool")[0].text;
  assert.match(text, /## FactoryForm\n- Offline: /); // the real connector, pointed at nothing, says so
  assert.match(boardMaps(getBoard("digest-tool").doc).activity.toArray().at(-1)!.text, /^wrote the daily digest for \w{3} \d{1,2} \w{3} \(asked by Ada\)$/);
});
