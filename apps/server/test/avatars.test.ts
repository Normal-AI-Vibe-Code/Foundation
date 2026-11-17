/**
 * Foundation's avatars (2026-11-17): the uploader on the Character studio's left, what is wired into it, and
 * the upload to main's starter set. "Main" here is a bare git repository in a temp folder with a checkout of
 * it standing in for the server's own (FOUNDATION_AVATARS_REPO).
 *
 *  - the studio gets a column on the left with the uploader hosted in it, wired from each Characters section;
 *  - a character card has an output; a section brings every character card in it, a card brings itself;
 *  - wired, finished and approved is an avatar; pending waits; a wire taken off archives what only it
 *    brought, and wired back approves it again; the first reading changes nobody's approval;
 *  - an upload commits the set to main when it changed (only those characters' files change), says "same"
 *    when it didn't, and refuses an empty set or a server that isn't a checkout;
 *  - a timer runs when it's due; a set main dropped is withdrawn on an install, and brought back.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "foundation-avatars-"));
process.env.FOUNDATION_DATA_DIR = join(tmp, "data");
process.env.FOUNDATION_STARTER_DIR = "";

// main: a bare repository with a starter set of one character, and a checkout of it for the server
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
const origin = join(tmp, "origin.git");
const checkout = join(tmp, "checkout");
git(tmp, "init", "--quiet", "--bare", "--initial-branch=main", origin);
git(tmp, "clone", "--quiet", origin, checkout);
git(checkout, "config", "user.name", "Test");
git(checkout, "config", "user.email", "test@example.com");
git(checkout, "checkout", "--quiet", "-b", "main");
mkdirSync(join(checkout, "apps/server/starter/characters"), { recursive: true });
writeFileSync(join(checkout, "apps/server/starter/characters/old-front.jpg"), "an old picture");
writeFileSync(join(checkout, "apps/server/starter/characters/manifest.json"), JSON.stringify({ version: 1, characters: [{ name: "Old", set: "anime", form: "mesh", identity: "", height: 1.6, files: { front: { file: "old-front.jpg", mime: "image/jpeg" } } }] }));
git(checkout, "add", "-A");
git(checkout, "commit", "--quiet", "-m", "a starter set");
git(checkout, "push", "--quiet", "origin", "main");
process.env.FOUNDATION_AVATARS_REPO = checkout;

const { closeBoards, editBoard, getBoard } = await import("../src/boards.ts");
const { upsertUser } = await import("../src/auth.ts");
const { run } = await import("../src/db.ts");
const { storeFile } = await import("../src/files.ts");
const chars = await import("../src/characters.ts");
const av = await import("../src/avatars.ts");
const { boardMaps, uid, CHARACTER_OUT, SECTION_PORT, UPLOADER_IN } = await import("@foundation/protocol");
type PanelDoc = import("@foundation/protocol").PanelDoc;
type CharacterState = import("@foundation/protocol").CharacterState;
type UploaderState = import("@foundation/protocol").UploaderState;

after(() => {
  av.stopAvatars();
  closeBoards();
});

const ada = upsertUser("ada@formindustries.com", "Ada");
run("update users set role = 'member' where id = ?", ada.id);
let BOARD = "";
const m = () => boardMaps(getBoard(BOARD).doc);
const sectionNamed = (name: string) => [...m().sections.values()].find((s) => s.name === name)!;
let UP = "";
const up = () => m().uploaders.get(UP) as UploaderState;
const states = () => Object.fromEntries(up().entries.map((e) => [e.name, e.state]));
const mainManifest = () => JSON.parse(git(checkout, "show", "origin/main:apps/server/starter/characters/manifest.json")) as { characters: Array<{ name: string; files: Record<string, { file: string; source?: string }> }> };

/** a finished mesh avatar in a section: its sheet, its still and its .mavatar in the archive */
async function finished(name: string, section: string, approve = true): Promise<{ panelId: string; id: string }> {
  const made = chars.createCharacter(BOARD, { name: "Ada", id: ada.id, human: true }, { name, set: "anime", form: "mesh", identity: `${name}, someone.`, section });
  const front = await storeFile(Buffer.from(`${name} sheet`), { name: `${name} sheet.png`, mime: "image/png", boardId: BOARD, userId: ada.id });
  const mav = await storeFile(Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.from(name)]), { name: `${name}.mavatar`, mime: "application/zip", boardId: BOARD, userId: ada.id });
  const c = structuredClone(m().characters.get(made.panelId)!) as CharacterState;
  c.files = { front: front.id, thumb: front.id, mavatar: mav.id };
  c.ready = true;
  run("update characters set state = ? where panel_id = ?", JSON.stringify(c), made.panelId);
  editBoard(BOARD, "characters", (doc) => boardMaps(doc).characters.set(made.panelId, c));
  if (approve) chars.setApproval(BOARD, made.panelId, "approved", ada);
  return { panelId: made.panelId, id: made.id };
}

test("the studio gets Foundation avatars on its left: the uploader hosted there, wired from each set's Characters", () => {
  BOARD = chars.openStudio(ada).id;
  const sec = sectionNamed(av.AVATARS_SECTION);
  assert.equal(sec.c0, 0);
  assert.equal(sectionNamed("Inspiration · Anime").c0, 1, "every section moved one to the right");
  assert.equal(sectionNamed("Characters · Anime").r0, sec.r0, "beside the characters");
  const card = m().objects.get(sec.host!) as PanelDoc;
  assert.equal(card.panel, "uploader");
  UP = card.id;
  const port = card.ports.find((p) => p.name === UPLOADER_IN)!;
  const wires = [...m().links.values()].filter((l) => l.to.panel === UP);
  assert.deepEqual(wires.map((l) => m().sections.get(l.from.panel)?.name).sort(), ["Characters · Abstract", "Characters · Animals", "Characters · Anime"]);
  assert.ok(wires.every((l) => l.from.port === SECTION_PORT && l.to.port === port.id));
  // laid once
  chars.upgradeStudio(BOARD);
  assert.equal([...m().objects.values()].filter((o) => o.kind === "panel" && o.panel === "uploader").length, 1);
  av.reconcile(BOARD);
  assert.deepEqual(up().inMain, ["mesh:anime:old"], "what main has, read from origin");
  // what an upload would take out of main shows before anyone presses: Old is in main and nowhere here
  assert.deepEqual(up().entries.map((e) => [e.name, e.state, e.why]), [["Old", "removed", "in main, but not on this Foundation"]]);
  assert.match(up().target ?? "", /main$/);
});

let aoi = { panelId: "", id: "" };
let hana = { panelId: "", id: "" };
let kiko = { panelId: "", id: "" };

test("a wired section brings its character cards: finished and approved is an avatar, pending waits", async () => {
  aoi = await finished("Aoi", "Characters · Anime");
  hana = await finished("Hana", "Characters · Anime", false);
  const card = m().objects.get(aoi.panelId) as PanelDoc;
  assert.equal(card.ports.find((p) => p.dir === "out")?.name, CHARACTER_OUT, "a character card has an output");
  av.reconcile(BOARD);
  assert.deepEqual(states(), { Aoi: "avatar", Hana: "waiting", Old: "removed" });
  assert.match(up().entries.find((e) => e.name === "Hana")!.why!, /approve/);
  assert.equal(up().entries[0].via, "Characters · Anime");
  // a card wired on its own, from a section that isn't wired
  kiko = await finished("Kiko", "Pipeline · Anime");
  av.reconcile(BOARD);
  assert.equal(states().Kiko, undefined);
  const out = (m().objects.get(kiko.panelId) as PanelDoc).ports[0];
  const port = (m().objects.get(UP) as PanelDoc).ports[0];
  editBoard(BOARD, "test", (doc) => boardMaps(doc).links.set("lnk_kiko", { id: "lnk_kiko", from: { panel: kiko.panelId, port: out.id }, to: { panel: UP, port: port.id } }));
  av.reconcile(BOARD);
  assert.equal(states().Kiko, "avatar");
  assert.equal(up().entries.find((e) => e.name === "Kiko")!.via, "its card");
});

test("a wire taken off archives what only it brought; wired back, it's an avatar again", () => {
  editBoard(BOARD, "test", (doc) => boardMaps(doc).links.delete("lnk_kiko"));
  av.reconcile(BOARD);
  av.reconcile(BOARD); // the approval it wrote comes round again and changes nothing more
  assert.equal(states().Kiko, undefined, "never in main: nothing to show as leaving");
  assert.equal(chars.characterById(kiko.id)!.approval, "archived");
  assert.equal(chars.roster().characters.find((c) => c.id === kiko.id)!.approval, "archived");
  const out = (m().objects.get(kiko.panelId) as PanelDoc).ports[0];
  const port = (m().objects.get(UP) as PanelDoc).ports[0];
  editBoard(BOARD, "test", (doc) => boardMaps(doc).links.set("lnk_kiko", { id: "lnk_kiko", from: { panel: kiko.panelId, port: out.id }, to: { panel: UP, port: port.id } }));
  av.reconcile(BOARD);
  assert.equal(chars.characterById(kiko.id)!.approval, "approved");
  assert.equal(states().Kiko, "avatar");
  // a character a person archived isn't brought back by a wire: it waits for their approval
  chars.setApproval(BOARD, aoi.panelId, "archived", ada);
  av.reconcile(BOARD);
  assert.equal(states().Aoi, "waiting");
  chars.setApproval(BOARD, aoi.panelId, "approved", ada);
  av.reconcile(BOARD);
});

test("an upload commits the avatars to main when they changed, and says so when they didn't", async () => {
  const before = git(checkout, "rev-parse", "origin/main");
  const r = await av.uploadAvatars(BOARD, UP, "Ada", "manual").started;
  assert.equal(r.outcome, "pushed", r.text);
  git(checkout, "fetch", "--quiet", "origin");
  assert.notEqual(git(checkout, "rev-parse", "origin/main"), before);
  const set = mainManifest();
  assert.deepEqual(set.characters.map((c) => c.name).sort(), ["Aoi", "Kiko"], "the avatars, not the one waiting, and Old is gone");
  assert.deepEqual(r.added?.sort(), ["Aoi", "Kiko"]);
  assert.deepEqual(r.removed, ["Old"]);
  const aoiFiles = set.characters.find((c) => c.name === "Aoi")!.files;
  assert.equal(aoiFiles.front.file, aoiFiles.thumb.file, "one picture that plays two roles is one file");
  assert.ok(aoiFiles.mavatar.source, "each file says which archive file it came from");
  assert.ok(git(checkout, "show", `origin/main:apps/server/starter/characters/${aoiFiles.mavatar.file}`).endsWith("Aoi"), "its .mavatar, byte for byte");
  assert.match(git(checkout, "log", "-1", "--format=%B", "origin/main"), /\+Aoi, Kiko.*−Old/s);
  assert.equal(up().last?.outcome, "pushed");
  assert.equal(up().running, undefined);
  assert.deepEqual([...up().inMain].sort(), ["mesh:anime:aoi", "mesh:anime:kiko"]);

  // the same set again: nothing to commit
  const again = await av.uploadAvatars(BOARD, UP, "Ada", "manual").started;
  assert.equal(again.outcome, "same");

  // one leaves: shown as leaving until the upload takes it out of main, and only its files change
  editBoard(BOARD, "test", (doc) => boardMaps(doc).links.delete("lnk_kiko"));
  av.reconcile(BOARD);
  assert.equal(states().Kiko, "removed");
  const second = git(checkout, "rev-parse", "origin/main");
  const third = await av.uploadAvatars(BOARD, UP, "Ada", "manual").started;
  assert.equal(third.outcome, "pushed");
  assert.deepEqual(third.removed, ["Kiko"]);
  git(checkout, "fetch", "--quiet", "origin");
  const changed = git(checkout, "diff", "--name-only", second, "origin/main", "--", "apps/server/starter/characters").split("\n");
  assert.ok(!changed.some((f) => /aoi-/.test(f)), "Aoi's files weren't touched");
  assert.equal(states().Kiko, undefined, "gone from main, gone from the card");
});

test("an upload of nothing, one under way, or from a server that isn't a checkout is refused", async () => {
  editBoard(BOARD, "test", (doc) => {
    for (const [id, l] of boardMaps(doc).links.entries()) if (l.to.panel === UP) boardMaps(doc).links.delete(id);
  });
  av.reconcile(BOARD);
  assert.throws(() => av.uploadAvatars(BOARD, UP, "Ada", "manual"), /Nothing is wired in/);
  assert.equal(chars.characterById(aoi.id)!.approval, "archived");
  // back as it was
  const port = (m().objects.get(UP) as PanelDoc).ports[0];
  editBoard(BOARD, "test", (doc) => boardMaps(doc).links.set("lnk_anime", { id: "lnk_anime", from: { panel: sectionNamed("Characters · Anime").id, port: SECTION_PORT }, to: { panel: UP, port: port.id } }));
  av.reconcile(BOARD);
  assert.equal(chars.characterById(aoi.id)!.approval, "approved");
  const first = av.uploadAvatars(BOARD, UP, "Ada", "manual");
  assert.throws(() => av.uploadAvatars(BOARD, UP, "Ada", "manual"), /already under way/);
  await first.started;

  process.env.FOUNDATION_AVATARS_REPO = join(tmp, "data");
  av.forgetRepo();
  try {
    assert.throws(() => av.uploadAvatars(BOARD, UP, "Ada", "manual"), /started from a checkout/);
    assert.throws(() => av.setTimer(BOARD, UP, 3_600_000, ada), /started from a checkout/);
    av.reconcile(BOARD);
    assert.match(up().cannot ?? "", /checkout/);
  } finally {
    process.env.FOUNDATION_AVATARS_REPO = checkout;
    av.forgetRepo();
    av.reconcile(BOARD);
  }
});

test("a timer uploads when it's due, and moves on by its interval", async () => {
  assert.throws(() => av.setTimer(BOARD, UP, 1234, ada), /a timer is one of/);
  const st = av.setTimer(BOARD, UP, 3_600_000, ada);
  assert.equal(st.every, 3_600_000);
  assert.equal(st.everyBy, "Ada");
  assert.equal(av.tick(Date.now()).length, 0, "not due yet");
  const later = Date.now() + 3_600_001;
  const runs = av.tick(later);
  assert.equal(runs.length, 1);
  const r = await runs[0];
  assert.equal(r.how, "timer");
  assert.ok(r.outcome === "same" || r.outcome === "pushed", r.text);
  assert.equal(up().nextAt, later + 3_600_000);
  av.setTimer(BOARD, UP, 0, ada);
  assert.equal(up().every, undefined);
  assert.equal(av.tick(later * 2).length, 0);
});

test("on an install: a character main took out is withdrawn (archived, kept), and one it brings back is approved", async () => {
  const dir = join(tmp, "starter");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "front.png"), "a picture");
  writeFileSync(join(dir, "clips.glb"), "glTF clips");
  const one = (name: string) => ({ name, set: "animals", form: "model", identity: "", height: 0.5, files: { front: { file: "front.png", mime: "image/png" }, clips: { file: "clips.glb", mime: "model/gltf-binary" } } });
  const write = (names: string[]) => writeFileSync(join(dir, "manifest.json"), JSON.stringify({ version: 1, characters: names.map(one) }));
  process.env.FOUNDATION_STARTER_DIR = dir;
  try {
    write(["Bao", "Dumpling"]);
    assert.equal(await chars.bringInStarter(), 2);
    const dumpling = chars.roster().characters.find((c) => c.name === "Dumpling")!;
    assert.equal(dumpling.approval, undefined, "the starter set arrives approved");
    write(["Bao"]);
    await chars.bringInStarter();
    assert.equal(chars.characterById(dumpling.id)!.approval, "archived");
    assert.ok(chars.roster().characters.some((c) => c.id === dumpling.id), "kept, with its card");
    write(["Bao", "Dumpling"]);
    await chars.bringInStarter();
    assert.equal(chars.characterById(dumpling.id)!.approval, "approved");
    assert.equal(chars.roster().characters.filter((c) => c.name === "Dumpling").length, 1, "not brought in twice");
    // a character only this install has is never withdrawn by a set that doesn't name it
    assert.equal(chars.characterById(hana.id)!.approval, "pending");
  } finally {
    process.env.FOUNDATION_STARTER_DIR = "";
  }
  assert.ok(existsSync(join(checkout, ".git")));
  assert.ok(readFileSync(join(dir, "manifest.json"), "utf8"));
  void uid;
});
