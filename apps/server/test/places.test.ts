/**
 * Places (places.ts): folders on this computer a person approved. Only an
 * admin, as a person, approves or removes one; nothing outside a place is
 * read, whatever the path says or a link points at; secrets stay put; the
 * original is only read; removing needs confirm and touches no file.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { UserInfo } from "@foundation/protocol";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-test-"));
// the test's folders live under the temp folder, which on Windows is inside app data (refused for real places)
delete process.env.APPDATA;
delete process.env.LOCALAPPDATA;

const places = await import("../src/places.ts");
const { run } = await import("../src/db.ts");

const admin: UserInfo = { id: "u-admin", email: "ada@formindustries.com", name: "Ada", color: "#000", role: "admin" };
const member: UserInfo = { id: "u-kai", email: "kai@formindustries.com", name: "Kai", color: "#000", role: "member" };
for (const u of [admin, member]) run("insert or ignore into users (id, email, name, color, role, created_at) values (?, ?, ?, ?, ?, ?)", u.id, u.email, u.name, u.color, u.role, Date.now());

// a folder to approve, and things beside it that must never be reachable through it
const outer = realpathSync(mkdtempSync(join(tmpdir(), "foundation-places-")));
const root = join(outer, "Drawings");
mkdirSync(join(root, "fan", "rev-b"), { recursive: true });
mkdirSync(join(root, ".git"));
mkdirSync(join(root, "node_modules", "x"), { recursive: true });
writeFileSync(join(root, "readme.md"), "# Fan drawings\nrev B is current\n");
writeFileSync(join(root, "fan", "rev-b", "housing.step"), "ISO-10303-21;\nHEADER;\nFILE_NAME('housing');\nENDSEC;\n");
writeFileSync(join(root, ".env"), "TOKEN=do-not-read");
writeFileSync(join(root, "fan", "deploy.pem"), "-----BEGIN PRIVATE KEY-----");
writeFileSync(join(root, ".git", "config"), "[core]");
const outside = join(outer, "Payroll");
mkdirSync(outside);
writeFileSync(join(outside, "salaries.csv"), "name,pay\n");
// a junction inside the place that points out of it (a directory link needs no privilege on Windows)
symlinkSync(outside, join(root, "shortcut"), "junction");

test("only an admin, as a person, approves a place", () => {
  assert.throws(() => places.approvePlace(member, true, { path: root }), /Only an admin/);
  // an agent's bearer acting for the admin (person = false)
  assert.throws(() => places.approvePlace(admin, false, { path: root }), /needs a person/);
  assert.equal(places.listPlaces().length, 0);

  const p = places.approvePlace(admin, true, { path: root });
  assert.equal(p.name, "Drawings");
  assert.equal(p.reachable, true);
  // approving it again is the same place, not a second one
  assert.equal(places.approvePlace(admin, true, { path: join(root, ".") }).id, p.id);
  assert.equal(places.listPlaces().length, 1);
});

test("some folders can't be approved at all", () => {
  const no = (path: string, why: RegExp) => assert.throws(() => places.approvePlace(admin, true, { path }), why, path);
  no(homedir(), /home folder/);
  no(join(homedir(), ".."), /home folder|whole drive/);
  no(process.platform === "win32" ? "C:\\" : "/", /whole drive/);
  no(process.env.FOUNDATION_DATA_DIR!, /Foundation's own data/);
  no(join(root, ".git"), /hidden or holds keys/);
  no(join(root, "readme.md"), /That's a file/);
  no(join(root, "nope"), /no folder/);
  no("Drawings", /full path/);
  if (process.platform === "win32") no(process.env.SystemRoot ?? "C:\\Windows", /System and app-data/);
  else no("/etc", /System and app-data/);
});

test("listing shows what's there, without secrets or links that leave", async () => {
  const [p] = places.listPlaces();
  const top = await places.listPlace(p.id);
  assert.deepEqual(top.entries.map((e) => [e.name, e.dir]), [["fan", true], ["readme.md", false]]);
  const rev = await places.listPlace(p.id, "fan/rev-b");
  assert.deepEqual(rev.entries.map((e) => e.path), ["fan/rev-b/housing.step"]);
  // the key beside it isn't listed
  assert.deepEqual((await places.listPlace(p.id, "fan")).entries.map((e) => e.name), ["rev-b"]);
});

test("nothing outside the place is read, however the path is written", async () => {
  const [p] = places.listPlaces();
  const refused = async (rel: string, why: RegExp) => {
    await assert.rejects(places.listPlace(p.id, rel), why, `list ${rel}`);
    await assert.rejects(places.bringFromPlace(member, p.id, rel, "company"), why, `bring ${rel}`);
    await assert.rejects(places.readPlaceText(p.id, rel), why, `read ${rel}`);
  };
  await refused("../Payroll/salaries.csv", /leaves the place/);
  await refused("fan/../../Payroll", /leaves the place/);
  await refused(join(outside, "salaries.csv"), /leaves the place/);
  await refused("shortcut/salaries.csv", /outside the place/);
  await refused("shortcut", /outside the place/);
  await refused(".env", /stay where they are/);
  await refused(".git/config", /stay where they are/);
  await refused("fan/deploy.pem", /stay where they are/);
  await refused("node_modules/x", /stay where they are/);
});

test("bringing a file copies it into the archive and leaves the original alone", async () => {
  const [p] = places.listPlaces();
  const before = readFileSync(join(root, "fan", "rev-b", "housing.step"), "utf8");
  const file = await places.bringFromPlace(member, p.id, "fan/rev-b/housing.step", "company");
  assert.equal(file.name, "housing.step");
  assert.equal(file.mime, "model/step");
  assert.equal(file.board_id, "company");
  assert.equal(file.uploaded_by, member.id);
  assert.match(file.about ?? "", /From “Drawings” on this computer: fan\/rev-b\/housing.step/);
  assert.equal(readFileSync(join(process.env.FOUNDATION_DATA_DIR!, "files", file.sha256), "utf8"), before);
  assert.equal(readFileSync(join(root, "fan", "rev-b", "housing.step"), "utf8"), before);
  assert.deepEqual(readdirSync(join(root, "fan", "rev-b")), ["housing.step"]);
  // the same file again is the same archived file
  assert.equal((await places.bringFromPlace(member, p.id, "fan\\rev-b\\housing.step", "company")).id, file.id);
  await assert.rejects(places.bringFromPlace(member, p.id, "fan", "company"), /That's a folder/);
  assert.match(await places.readPlaceText(p.id, "readme.md"), /rev B is current/);
});

test("removing a place needs confirm and a person, and only forgets the approval", async () => {
  const [p] = places.listPlaces();
  assert.throws(() => places.removePlace(admin, true, p.id, undefined), /confirm/);
  assert.throws(() => places.removePlace(member, true, p.id, true), /Only an admin/);
  assert.throws(() => places.removePlace(admin, false, p.id, true), /needs a person/);
  assert.equal(places.listPlaces().length, 1);

  places.removePlace(admin, true, p.id, true);
  assert.equal(places.listPlaces().length, 0);
  assert.ok(existsSync(join(root, "readme.md")), "the folder is untouched");
  await assert.rejects(places.listPlace(p.id), /isn't approved/);
  await assert.rejects(places.bringFromPlace(member, p.id, "readme.md", "company"), /isn't approved/);
});
