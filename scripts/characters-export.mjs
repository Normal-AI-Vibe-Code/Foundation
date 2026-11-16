#!/usr/bin/env node
// The starter set: the ready characters on this computer's Character studio board, written out as
// `apps/server/starter/characters/` so every install has them (the server brings them onto the studio
// board the first time it's made: characters.ts `seedStarter`; the desktop build carries the folder).
//
//   node scripts/characters-export.mjs            every ready character
//   node scripts/characters-export.mjs Mochi Aoi  only these
//
// What's written: a manifest (name, set, form, who it is, height) and each character's pictures and
// its playable file (clips.glb or the .mavatar). Not the bare model, and never the inspiration
// pictures: those are other people's work and stay on the board they were dropped on.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import * as Y from "yjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const data = resolve(root, process.env.FOUNDATION_DATA_DIR ?? "data");
const out = join(root, "apps/server/starter/characters");
const only = process.argv.slice(2).map((n) => n.toLowerCase());
const ROLES = ["front", "back", "side", "portrait", "thumb", "clips", "mavatar"];

const db = new DatabaseSync(join(data, "foundation.db"), { readOnly: true });
const boards = new Set(db.prepare("select board_id from character_boards").all().map((b) => b.board_id));
// a character whose card was taken off the grid is retired: its record stays (so do its files), but it isn't one of the set
const cards = new Map();
const onGrid = (boardId, panelId) => {
  if (!cards.has(boardId)) {
    const doc = new Y.Doc();
    for (const u of db.prepare("select update_blob from board_updates where board_id = ? order by seq").all(boardId)) Y.applyUpdate(doc, u.update_blob);
    cards.set(boardId, new Set(doc.getMap("objects").keys()));
  }
  return cards.get(boardId).has(panelId);
};
const rows = db.prepare("select board_id, panel_id, state from characters order by created_at").all().filter((r) => boards.has(r.board_id) && onGrid(r.board_id, r.panel_id));
const file = db.prepare("select name, mime, sha256 from files where id = ?");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const characters = [];
let bytes = 0;
for (const r of rows) {
  const c = JSON.parse(r.state);
  if (!c.ready || (only.length && !only.includes(c.name.toLowerCase()))) continue;
  const slug = c.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const files = {};
  const seen = new Map(); // one copy of a picture that plays two roles (a sheet that is also the still)
  for (const role of ROLES) {
    const id = c.files[role];
    const f = id && file.get(id);
    if (!f) continue;
    const src = join(data, "files", f.sha256);
    if (!existsSync(src)) continue;
    if (!seen.has(f.sha256)) {
      const name = `${slug}-${role}${extname(f.name) || ".bin"}`;
      copyFileSync(src, join(out, name));
      bytes += statSync(src).size;
      seen.set(f.sha256, name);
    }
    files[role] = { file: seen.get(f.sha256), mime: f.mime };
  }
  characters.push({ name: c.name, set: c.set, form: c.form, identity: c.identity, height: c.height, files });
  console.log(`  ${c.name.padEnd(8)} ${c.form.padEnd(6)} ${Object.keys(files).join(" ")}`);
}
// Pictures as JPEG where Pillow is to hand (`uv run --with pillow`): a sheet is 1.2 MB as the PNG Meshy made and
// 0.15 MB as a JPEG nobody can tell from it at the size a card or a seat shows. Without Pillow they stay PNG.
const py = join(tmpdir(), `foundation-shrink-${process.pid}.py`);
writeFileSync(py, `import sys, os
from PIL import Image
d = sys.argv[1]
for n in os.listdir(d):
    if n.endswith(".png"):
        im = Image.open(os.path.join(d, n)).convert("RGBA")
        bg = Image.new("RGB", im.size, (246, 243, 236)); bg.paste(im, mask=im.getchannel("A"))
        bg.save(os.path.join(d, n[:-4] + ".jpg"), quality=88, optimize=True); os.remove(os.path.join(d, n))
`);
const shrink = spawnSync("uv", ["run", "--with", "pillow", "python", py, out], { encoding: "utf8" });
rmSync(py, { force: true });
if (shrink.status === 0) {
  bytes = 0;
  for (const c of characters) for (const f of Object.values(c.files)) if (f.file.endsWith(".png")) Object.assign(f, { file: f.file.replace(/\.png$/, ".jpg"), mime: "image/jpeg" });
  for (const n of readdirSync(out)) bytes += statSync(join(out, n)).size;
} else console.log("  (pictures kept as PNG: uv with Pillow isn't here)");
writeFileSync(join(out, "manifest.json"), `${JSON.stringify({ version: 1, madeAt: new Date().toISOString().slice(0, 10), characters }, null, 2)}\n`);
console.log(`\n  ${characters.length} characters, ${(bytes / 1e6).toFixed(1)} MB → ${out}`);
