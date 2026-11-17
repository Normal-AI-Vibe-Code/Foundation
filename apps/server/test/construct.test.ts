/**
 * Construction: find images (archive, board, Slack) and lay them out as a
 * page. Slack is a stand-in server here (SLACK_API_BASE) serving real PNGs.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-test-"));
import { png } from "./fixtures/png.ts";

let slack: Server;
let base = "";
const FILES = [
  { id: "F1", name: "pthp-stack-rev3.png", title: "PTHP stack, rev 3", w: 800, h: 600, ts: 1_790_000_000, rgb: [50, 91, 180] as [number, number, number] },
  { id: "F2", name: "pthp-thermal-map.png", title: "Airform PTHP thermal map", w: 600, h: 800, ts: 1_791_000_000, rgb: [200, 122, 28] as [number, number, number] },
  { id: "F3", name: "lunch.png", title: "Team lunch", w: 400, h: 400, ts: 1_789_000_000, rgb: [46, 125, 84] as [number, number, number] },
];

before(async () => {
  slack = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.headers.authorization !== "Bearer xoxp-test" && req.headers.authorization !== "Bearer xoxb-test") return res.writeHead(401).end();
    const meta = (f: (typeof FILES)[number]) => ({ id: f.id, name: f.name, title: f.title, mimetype: "image/png", timestamp: f.ts, username: "noa", channels: ["airform-pthp"], permalink: `https://slack.example/${f.id}`, url_private_download: `${base}/download/${f.id}` });
    if (url.pathname === "/search.files") {
      const q = (url.searchParams.get("query") ?? "").toLowerCase();
      const words = q.split(/\s+/);
      const hits = FILES.filter((f) => words.every((w) => `${f.name} ${f.title}`.toLowerCase().includes(w)));
      return res.end(JSON.stringify({ ok: true, files: { matches: hits.map(meta) } }));
    }
    if (url.pathname === "/files.info") {
      const f = FILES.find((x) => x.id === url.searchParams.get("file"));
      return res.end(JSON.stringify(f ? { ok: true, file: meta(f) } : { ok: false, error: "file_not_found" }));
    }
    const d = /^\/download\/(\w+)$/.exec(url.pathname);
    if (d) {
      const f = FILES.find((x) => x.id === d[1])!;
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(png(f.w / 20, f.h / 20, f.rgb)); // small, but the shape of the real thing
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((ok) => slack.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(slack.address() as { port: number }).port}`;
  process.env.SLACK_API_BASE = base;
});
after(() => slack.close());

const { findImages, layOut, imageSize } = await import("../src/construct.ts");
const { getBoard, closeBoards } = await import("../src/boards.ts");
const { run } = await import("../src/db.ts");
const { boardMaps, appendSection, noteTextOf } = await import("@foundation/protocol");
after(() => closeBoards());

run("insert or ignore into users (id, email, name, color, role, created_at) values ('u', 'u@formindustries.com', 'Tester', '#325bb4', 'member', 0)");
const ctx = { boardId: "build", actor: "test", userId: "u" };

test("image sizes come from the file's header", () => {
  assert.deepEqual(imageSize(png(40, 30, [0, 0, 0])), { w: 40, h: 30 });
});

test("without Slack keys, find_images says Slack wasn't searched", async () => {
  delete process.env.SLACK_USER_TOKEN;
  delete process.env.SLACK_BOT_TOKEN;
  const doc = getBoard("build").doc;
  doc.transact(() => appendSection(doc, "Main"));
  const r = await findImages(doc, "build", "Airform PTHP");
  assert.equal(r.count, 0);
  assert.match(r.notes.join(" "), /Slack isn't connected/);
});

test("with Slack connected: find the PTHP images, then lay them out as a grid with captions", async () => {
  process.env.SLACK_USER_TOKEN = "xoxp-test";
  process.env.SLACK_BOT_TOKEN = "xoxb-test";
  const doc = getBoard("build").doc;
  const found = await findImages(doc, "build", "pthp", ["slack"]);
  assert.deepEqual(found.images.map((i) => i.ref).sort(), ["slack:F1", "slack:F2"]); // not the lunch photo
  // a phrase finds what names only part of it too, best matches first ("PTHP stack" lacks "Airform")
  const phrase = await findImages(doc, "build", "Airform PTHP", ["slack"]);
  assert.deepEqual(phrase.images.map((i) => i.ref), ["slack:F2", "slack:F1"]);
  assert.match(found.images[0].from!, /#airform-pthp · noa/);

  const out = await layOut(ctx, { title: "Airform PTHP · from Slack", style: "grid", intro: "Everything shared in #airform-pthp.", items: found.images.map((i) => ({ ref: i.ref })) });
  assert.equal(out.images, 2);
  assert.deepEqual(out.skipped, []);
  const m = boardMaps(doc);
  const sec = m.sections.get(out.section)!;
  assert.equal(sec.name, "Airform PTHP · from Slack");
  const cards = [...m.objects.values()].filter((o) => o.sectionId === sec.id);
  const media = cards.filter((o) => o.kind === "media");
  assert.equal(media.length, 2);
  // each image keeps its shape: 800×600 landscape and 600×800 portrait
  const shapes = (media as Array<{ w: number; h: number; src: string }>).map((o) => (o.w > o.h ? "landscape" : "portrait")).sort();
  assert.deepEqual(shapes, ["landscape", "portrait"], "aspect kept");
  assert.match((media[0] as { src: string }).src, /^\/files\/f_/);
  // nothing overlaps
  const rects = cards.map((o) => o as unknown as { x: number; y: number; w: number; h: number; name: string });
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) {
      const p = rects[i], q = rects[j];
      const ox = Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x);
      const oy = Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y);
      assert.ok(!(ox > 0 && oy > 0), `${p.name} overlaps ${q.name}`);
    }
  // captions say where each came from; the imported files are searchable by it
  assert.ok(cards.some((o) => o.kind === "note" && /\*\*PTHP stack, rev 3\*\*\s+Slack · #airform-pthp · noa · \d+ \w+ 2026/.test(noteTextOf(doc, o))), "captions carry the Slack title, where and when");
  const again = await findImages(doc, "build", "airform-pthp", ["files"]);
  assert.equal(again.count, 2, "imported images are found in the archive by where they came from");
});

test("a document reads top to bottom; a timeline runs in time order; laying out twice doesn't duplicate files", async () => {
  const doc = getBoard("build").doc;
  const items = [{ ref: "slack:F2" }, { ref: "slack:F1" }];
  const d = await layOut(ctx, { title: "PTHP document", style: "document", intro: "The stack, then the thermal map.", items });
  const m = boardMaps(doc);
  const ys = [...m.objects.values()].filter((o) => o.sectionId === d.section).map((o) => o.y);
  assert.deepEqual(ys, [...ys].sort((p, q) => p - q), "one column, top to bottom");
  const t = await layOut(ctx, { title: "PTHP timeline", style: "timeline", items });
  const imgs = [...m.objects.values()].filter((o) => o.sectionId === t.section && o.kind === "media") as Array<{ x: number; name: string }>;
  assert.ok(imgs.every((o, i) => i === 0 || o.x > imgs[i - 1].x));
  const { all } = await import("../src/db.ts");
  assert.equal(all("select id from files").length, 2, "the same Slack image is one file, however often it's laid out");
});
