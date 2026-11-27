#!/usr/bin/env node
// Foundation's desktop release, in three steps (SPEC §3 "Desktop updates"):
//
//   npm run release -- bump 0.3.0     every version string to 0.3.0, one commit and the tag v0.3.0 (never pushes)
//   npm run release -- build          signed installers and latest.json for the version in tauri.conf.json
//   npm run release -- publish        the GitHub release v<version>: notes, installers, .sig files, latest.json
//
// The release notes are docs/blog/<version>.md (front-matter, then markdown); `build` refuses without it,
// because the notes are what every installed copy shows on its update card.
//
// Signing: the updater's private key never enters a checkout. `build` reads it from
// TAURI_SIGNING_PRIVATE_KEY(_PASSWORD) if set, else from ~/.tauri/foundation-updater.key and
// ~/.tauri/foundation-updater.password. Losing that key strands every installed copy (they'd need a
// manual reinstall once), so it needs a backup outside this computer.
//
// The feed lives at https://github.com/<repo>/releases/latest/download/latest.json, which works while the
// repository is public. If it goes private, the feed has to move somewhere public (Vision uses a Supabase
// bucket, its ADR-055); change `plugins.updater.endpoints` in tauri.conf.json and `assetUrl` below.
//
// Publishing is the approval: once the release is up, every installed Foundation offers it within a
// launch (or six hours). `publish` refuses a release that already exists unless --replace is given.
//
// CI (2026-11-13, Josh: "all future improvements get installed … without having to be built by claude"):
// .github/workflows/desktop-release.yml runs on every push to main and, once tests pass, runs
//
//   node scripts/release.mjs ci build <run>     on each platform (Windows, and macOS on Apple silicon since
//                                               2026-11-20): stamp <major>.<minor>.<patch + run number>, notes
//                                               from the commits since the last release, build into dist/release/
//   node scripts/release.mjs ci publish <run> <dir>...   once every platform is built: one release with all
//                                               their files and one latest.json naming every platform's
//                                               installer (a draft until complete)
//
// It commits nothing: the stamped version and docs/blog/<version>.md live only in that build.
//
// macOS builds are ad-hoc signed, not with an Apple Developer ID, and not notarized. The updater installs
// them without a word, but the first install from a downloaded .dmg is stopped by Gatekeeper: open it from
// System Settings → Privacy & Security → Open Anyway (or `xattr -dr com.apple.quarantine` on the app).

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Josh, 2026-11-13: releases come from the repo main is pushed to (the org repo's main stopped on 2026-10-04)
const REPO = process.env.FOUNDATION_RELEASE_REPO ?? "joshleong/Foundation";
const TAURI = join(root, "apps/client/src-tauri");
const BUNDLE = join(TAURI, "target/release/bundle");
const OUT = join(root, "dist/release");
const win = process.platform === "win32";

const [cmd, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith("--")));
const args = rest.filter((a) => !a.startsWith("--"));

function die(msg) {
  console.error(`\n  release: ${msg}\n`);
  process.exit(1);
}
function run(bin, argv, opts = {}) {
  const r = spawnSync(bin, argv, { cwd: root, stdio: "inherit", shell: win && /^(npm|npx)$/.test(bin), ...opts });
  if (r.status !== 0) die(`${bin} ${argv.join(" ")} failed (${r.status ?? r.signal})`);
}
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
const readJson = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));
const writeJson = (p, v) => writeFileSync(join(root, p), JSON.stringify(v, null, 2) + "\n");
const currentVersion = () => readJson("apps/client/src-tauri/tauri.conf.json").version;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;

/** docs/blog/<version>.md → { title, date, body }; body is everything after the front-matter */
export function readNotes(version) {
  const p = join(root, "docs/blog", `${version}.md`);
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const meta = {};
  if (m) for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  if (meta.version && meta.version !== version) die(`docs/blog/${version}.md says version ${meta.version}`);
  return { title: meta.title ?? `Foundation ${version}`, date: meta.date ?? null, body: (m ? m[2] : raw).trim() };
}

/** the release asset's public URL */
const assetUrl = (version, file) => `https://github.com/${REPO}/releases/download/v${version}/${encodeURIComponent(file)}`;

// ------------------------------------------------------------------ bump
/** every version string the app is built from (the packages, tauri.conf.json, the crate and its lock) */
function stamp(version) {
  for (const p of ["apps/client/package.json", "apps/server/package.json", "packages/protocol/package.json", "packages/ui/package.json"]) {
    const j = readJson(p);
    j.version = version;
    writeJson(p, j);
  }
  const conf = readJson("apps/client/src-tauri/tauri.conf.json");
  conf.version = version;
  writeJson("apps/client/src-tauri/tauri.conf.json", conf);
  const cargo = join(TAURI, "Cargo.toml");
  writeFileSync(cargo, readFileSync(cargo, "utf8").replace(/^version = "[^"]+"/m, `version = "${version}"`));
  const lock = join(TAURI, "Cargo.lock");
  writeFileSync(lock, readFileSync(lock, "utf8").replace(/(name = "tauri-app"\r?\nversion = ")[^"]+"/, `$1${version}"`));
}

function bump(version) {
  if (!SEMVER.test(version ?? "")) die("usage: npm run release -- bump <x.y.z>");
  if (git("status", "--porcelain")) die("the working tree isn't clean; commit or set aside your changes first");
  const from = currentVersion();
  stamp(version);
  run("npm", ["install", "--package-lock-only", "--no-audit", "--no-fund"]);
  git("add", "-A", "apps/client/package.json", "apps/server/package.json", "packages/protocol/package.json", "packages/ui/package.json", "apps/client/src-tauri/tauri.conf.json", "apps/client/src-tauri/Cargo.toml", "apps/client/src-tauri/Cargo.lock", "package-lock.json");
  git("commit", "-q", "-m", `Foundation ${version}\n\nVersions bump ${from} → ${version} (npm run release -- bump).`);
  git("tag", "-a", `v${version}`, "-m", `Foundation ${version}`);
  console.log(`\n  ${from} → ${version}, committed and tagged v${version}. Nothing was pushed.\n  Next: npm run release -- build\n`);
}

// ------------------------------------------------------------------ build
function signingEnv() {
  if (process.env.TAURI_SIGNING_PRIVATE_KEY) return {};
  const dir = join(homedir(), ".tauri");
  const key = join(dir, "foundation-updater.key");
  const pw = join(dir, "foundation-updater.password");
  if (!existsSync(key)) die(`no signing key: set TAURI_SIGNING_PRIVATE_KEY or put it at ${key}`);
  return {
    TAURI_SIGNING_PRIVATE_KEY: readFileSync(key, "utf8").trim(),
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: existsSync(pw) ? readFileSync(pw, "utf8").trim() : "",
  };
}

/** this computer's architecture as `tauri build` writes it in file names, and as the updater's platform keys say it */
const ARCH = { x64: { file: "x64", feed: "x86_64" }, arm64: { file: "aarch64", feed: "aarch64" } }[process.arch] ?? { file: process.arch, feed: process.arch };

/** the installers `tauri build` made for this version, with their signatures, under the names they're published as */
function artifacts(version, arch = ARCH) {
  const find = (sub, test, name) => {
    const d = join(BUNDLE, sub);
    if (!existsSync(d)) return null;
    const f = readdirSync(d).find(test);
    if (!f) return null;
    const sig = join(d, `${f}.sig`);
    return { file: name ? name(f) : f, path: join(d, f), sig: existsSync(sig) ? readFileSync(sig, "utf8").trim() : null, sigPath: sig, arch: arch.feed };
  };
  const versioned = (test) => (n) => test(n) && n.includes(`_${version}_`);
  return {
    nsis: find("nsis", versioned((n) => n.endsWith("-setup.exe"))),
    msi: find("msi", versioned((n) => n.endsWith(".msi"))),
    // macOS: the updater's archive is named for the product alone (Foundation.app.tar.gz), so it's published
    // under a name with the version and architecture, as the other installers are
    appTar: find("macos", (n) => n.endsWith(".app.tar.gz"), () => `Foundation_${version}_${arch.file}.app.tar.gz`),
    // the disk image a person downloads to install the first time (the updater uses appTar, so it has no .sig)
    dmg: find("dmg", versioned((n) => n.endsWith(".dmg"))),
    appimage: find("appimage", versioned((n) => n.endsWith(".AppImage"))),
  };
}

/** latest.json in the shape tauri-plugin-updater reads */
export function feed(version, notes, a, now = new Date()) {
  const platforms = {};
  const add = (keys, art) => {
    if (!art?.sig) return;
    for (const k of keys) platforms[k] = { signature: art.sig, url: assetUrl(version, art.file) };
  };
  add(["windows-x86_64", "windows-x86_64-nsis"], a.nsis);
  add(["windows-x86_64-msi"], a.msi);
  // a Mac build is for the architecture it was built on: an Intel Mac must never be offered an Apple silicon app
  if (a.appTar) add([`darwin-${a.appTar.arch}`, `darwin-${a.appTar.arch}-app`], a.appTar);
  add(["linux-x86_64", "linux-x86_64-appimage"], a.appimage);
  return { version, notes: notes.body, pub_date: now.toISOString().replace(/\.\d{3}Z$/, "Z"), platforms };
}

/** one latest.json from each platform's build (CI builds Windows and macOS on separate machines) */
export function mergeFeeds(feeds, now = new Date()) {
  if (!feeds.length) throw new Error("no feeds to merge");
  const version = feeds[0].version;
  const platforms = {};
  for (const f of feeds) {
    if (f.version !== version) throw new Error(`the builds disagree on the version: ${version} and ${f.version}`);
    for (const [k, v] of Object.entries(f.platforms)) {
      if (platforms[k]) throw new Error(`two builds both offer ${k}`);
      platforms[k] = v;
    }
  }
  if (!Object.keys(platforms).length) throw new Error("no build made a signed installer");
  return { version, notes: feeds[0].notes, pub_date: now.toISOString().replace(/\.\d{3}Z$/, "Z"), platforms };
}

function build() {
  const version = currentVersion();
  const notes = readNotes(version);
  if (!notes) die(`docs/blog/${version}.md is missing: the release notes are what the update card shows`);
  run("npm", ["run", "tauri", "-w", "@foundation/client", "--", "build", "--config", "src-tauri/tauri.release.conf.json"], {
    env: { ...process.env, ...signingEnv() },
  });
  const a = artifacts(version);
  if (!a.nsis?.sig && !a.appTar?.sig && !a.appimage?.sig) die("the build made no signed installer (is createUpdaterArtifacts on?)");
  // everything this build publishes, under its published name, in one folder: dist/release/files/
  const files = join(OUT, "files");
  rmSync(files, { recursive: true, force: true });
  mkdirSync(files, { recursive: true });
  for (const art of Object.values(a)) {
    if (!art || (!art.sig && art !== a.dmg)) continue;
    copyFileSync(art.path, join(files, art.file));
    if (art.sig) copyFileSync(art.sigPath, join(files, `${art.file}.sig`));
  }
  const latest = feed(version, notes, a);
  writeFileSync(join(OUT, "latest.json"), JSON.stringify(latest, null, 2) + "\n");
  writeFileSync(join(OUT, "notes.md"), notes.body + "\n");
  writeFileSync(join(OUT, "release.json"), JSON.stringify({ version, title: notes.title }, null, 2) + "\n");
  console.log(`\n  Built Foundation ${version}:`);
  for (const [k, v] of Object.entries(a)) if (v) console.log(`    ${k.padEnd(9)} ${v.file}${v.sig ? " (signed)" : " (no .sig)"}`);
  console.log(`    feed      dist/release/latest.json (${Object.keys(latest.platforms).join(", ")})\n  Next: npm run release -- publish\n`);
}

/** the files a build left in <dir>/files/, as paths */
const builtFiles = (dir) => {
  const d = join(dir, "files");
  if (!existsSync(d)) die(`${d} is missing: run npm run release -- build first`);
  return readdirSync(d).map((f) => join(d, f));
};

// ------------------------------------------------------------------ publish
function publish() {
  const version = currentVersion();
  const tag = `v${version}`;
  const notes = readNotes(version);
  if (!notes) die(`docs/blog/${version}.md is missing`);
  const latestPath = join(OUT, "latest.json");
  if (!existsSync(latestPath)) die("no dist/release/latest.json: run npm run release -- build first");
  const latest = JSON.parse(readFileSync(latestPath, "utf8"));
  if (latest.version !== version) die(`dist/release/latest.json is for ${latest.version}, not ${version}: build again`);
  const files = [...builtFiles(OUT), latestPath];
  // the tag must be on GitHub, at the commit that was built
  const tagged = spawnSync("git", ["ls-remote", "--tags", "origin", tag], { cwd: root, encoding: "utf8" }).stdout.trim();
  if (!tagged) die(`the tag ${tag} isn't on origin yet: push main and the tag first (git push origin main ${tag})`);
  const exists = spawnSync("gh", ["release", "view", tag, "-R", REPO], { cwd: root, encoding: "utf8" }).status === 0;
  const notesFile = join(OUT, "notes.md");
  writeFileSync(notesFile, notes.body + "\n");
  if (exists) {
    if (!flags.has("--replace")) die(`the release ${tag} already exists: --replace uploads these assets over its own (and its notes)`);
    run("gh", ["release", "edit", tag, "-R", REPO, "--title", `Foundation ${version}: ${notes.title}`, "--notes-file", notesFile, "--draft=false", "--latest"]);
    run("gh", ["release", "upload", tag, "-R", REPO, "--clobber", ...files]);
  } else {
    run("gh", ["release", "create", tag, "-R", REPO, "--verify-tag", "--latest", "--title", `Foundation ${version}: ${notes.title}`, "--notes-file", notesFile, ...files]);
  }
  console.log(`\n  Published ${tag}. The feed: https://github.com/${REPO}/releases/latest/download/latest.json\n`);
}

// ------------------------------------------------------------------ ci
/** the version CI publishes: the checked-in one with the run number added to its patch (0.3.0, run 7 → 0.3.7).
 *  A person bumping to 0.4.0 moves CI on to 0.4.<run>, which is newer than any 0.3.x. */
export function ciVersion(base, runNumber) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(base ?? "");
  const n = Number(runNumber);
  if (!m || !Number.isInteger(n) || n < 1) throw new Error(`no CI version from "${base}" and run "${runNumber}"`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + n}`;
}

/** docs/blog/<version>.md for a CI build: the commits since the last release, newest first, without the plan's syncs */
export function ciNotes(version, subjects, date) {
  const kept = subjects.map((s) => s.replace(/\s+/g, " ").trim()).filter((s) => s && !/^Plan: synced/.test(s));
  const shown = kept.slice(0, 25);
  const lines = shown.map((s) => `- ${s}`);
  if (kept.length > shown.length) lines.push(`- and ${kept.length - shown.length} more changes`);
  if (!lines.length) lines.push("- Small fixes.");
  // the front-matter is one line per key, read up to the line's end: no quotes or newlines in the title
  let title = (kept[0] ?? "Small fixes").replace(/["']/g, "");
  if (title.length > 90) title = title.slice(0, 89).replace(/\s+\S*$/, "") + "…";
  return `---\nversion: ${version}\ndate: ${date}\ntitle: ${title}\n---\n\n${lines.join("\n")}\n`;
}

// ------------------------------------------------------------------ history
// docs/releases.json: every published version (its tag), when, from which commit, and what changed in it (the
// commits since the version before). The app bundles it, so the Changes panel shows the whole history offline,
// not only the hand-written posts. `node scripts/release.mjs history` writes it from the tags; `ci build` writes
// it again with the version it is building on top, so each build knows itself and everything before it.

const HISTORY = join(root, "docs/releases.json");

/** a commit subject worth showing in the history: not a plan sync, a merge or a version bump */
export const shownSubject = (s) => !!s && !/^Plan: synced/.test(s) && !/^Merge (remote-tracking )?branch /.test(s) && !/^Foundation \d+\.\d+\.\d+$/.test(s);

/** 0.3.10 after 0.3.9 */
export function cmpVersion(a, b) {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** one version's entry: titled by its newest change (as its CI release is), its changes newest first */
export function historyEntry(version, date, sha, subjects, max = 60) {
  const kept = subjects.map((s) => s.replace(/\s+/g, " ").trim()).filter(shownSubject);
  return { version, date, sha: sha.slice(0, 7), title: kept[0] ?? "Small fixes", changes: kept.slice(0, max), ...(kept.length > max ? { more: kept.length - max } : {}) };
}

/** the versions as the file holds them: newest first, each once */
export function historyFile(entries) {
  const seen = new Set();
  const releases = entries.filter((e) => !seen.has(e.version) && seen.add(e.version)).sort((a, b) => cmpVersion(b.version, a.version));
  return { about: "Every Foundation release, newest first, written by `node scripts/release.mjs history` from the v* tags (and by each CI build, with itself on top). The app's Changes panel shows it.", releases };
}

/** the entries from the repo's v* tags, and, for a build, the version being built at `head` */
function historyFromGit(head) {
  const tags = git("tag", "--list", "v*", "--sort=v:refname").split("\n").filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
  const points = tags.map((t) => ({ version: t.slice(1), rev: t }));
  if (head && !tags.includes(`v${head.version}`)) points.push({ version: head.version, rev: head.sha });
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const { version, rev } = points[i];
    const [sha, date] = git("log", "-1", "--format=%H%x1f%cI", `${rev}^{commit}`).split("\x1f");
    const range = i === 0 ? ["-15", rev] : [`${points[i - 1].rev}..${rev}`];
    out.push(historyEntry(version, date, sha, git("log", "--format=%s", ...range).split("\n")));
  }
  return historyFile(out);
}

function writeHistory(head) {
  const file = historyFromGit(head);
  writeFileSync(HISTORY, JSON.stringify(file, null, 2) + "\n");
  console.log(`  docs/releases.json: ${file.releases.length} releases, the newest ${file.releases[0]?.version ?? "none"}`);
}

const gh = (argv) => spawnSync("gh", argv, { cwd: root, encoding: "utf8" });

/** the version this CI run publishes */
function ciRunVersion() {
  const runNumber = args[1] ?? process.env.GITHUB_RUN_NUMBER;
  return { runNumber, version: ciVersion(currentVersion(), runNumber) };
}

/** `ci build <run>`: stamp this run's version, write its notes, build this machine's installers into dist/release/ */
function ciBuild() {
  const { runNumber, version } = ciRunVersion();
  const sha = process.env.GITHUB_SHA ?? git("rev-parse", "HEAD");
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY) die("ci: TAURI_SIGNING_PRIVATE_KEY isn't set (the repo's Actions secret)");
  // the notes: a post a person wrote for this version, else the commits since the last release
  if (!readNotes(version)) {
    const prev = spawnSync("git", ["describe", "--tags", "--abbrev=0", "--match", "v*", `${sha}^`], { cwd: root, encoding: "utf8" });
    const range = prev.status === 0 ? [`${prev.stdout.trim()}..${sha}`] : ["-15", sha];
    const subjects = git("log", "--format=%s", ...range).split("\n");
    const date = new Date().toISOString().slice(0, 10);
    writeFileSync(join(root, "docs/blog", `${version}.md`), ciNotes(version, subjects, date));
  }
  writeHistory({ version, sha });
  stamp(version);
  console.log(`\n  CI build v${version} from ${sha.slice(0, 7)} (run ${runNumber}, ${process.platform}-${process.arch})\n`);
  build();
}

/** `ci publish <run> <dir>...`: one release from every platform's dist/release/ (the first dir's notes are the release's) */
function ciPublish(dirs) {
  const { version } = ciRunVersion();
  const tag = `v${version}`;
  const sha = process.env.GITHUB_SHA ?? git("rev-parse", "HEAD");
  if (!dirs.length) die("usage: release.mjs ci publish <run> <dist/release dir>...");

  // a re-run of a published run has nothing to do; a draft left by a cancelled one is cleared
  const existing = gh(["release", "view", tag, "-R", REPO, "--json", "isDraft"]);
  if (existing.status === 0) {
    if (!JSON.parse(existing.stdout).isDraft) {
      console.log(`\n  ${tag} is already published; nothing to do.\n`);
      return;
    }
    run("gh", ["release", "delete", tag, "-R", REPO, "--yes"]);
  }

  const read = (dir, f) => readFileSync(join(dir, f), "utf8");
  const feeds = dirs.map((d) => JSON.parse(read(d, "latest.json")));
  const { title } = JSON.parse(read(dirs[0], "release.json"));
  let latest;
  try {
    latest = mergeFeeds(feeds);
  } catch (e) {
    die(e.message);
  }
  if (latest.version !== version) die(`the builds are of ${latest.version}, but run ${args[1]} publishes ${version}`);
  const out = join(OUT, "publish");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "latest.json"), JSON.stringify(latest, null, 2) + "\n");
  writeFileSync(join(out, "notes.md"), read(dirs[0], "notes.md"));
  const files = [...dirs.flatMap(builtFiles), join(out, "latest.json")];
  console.log(`\n  Publishing ${tag} from ${sha.slice(0, 7)}: ${Object.keys(latest.platforms).join(", ")}\n`);

  // a draft until every file is up, so the feed never names an installer that isn't there yet
  run("gh", ["release", "create", tag, "-R", REPO, "--draft", "--target", sha, "--title", `Foundation ${version}: ${title}`, "--notes-file", join(out, "notes.md"), ...files]);
  run("gh", ["release", "edit", tag, "-R", REPO, "--draft=false", "--latest"]);
  console.log(`\n  Published ${tag}. The feed: https://github.com/${REPO}/releases/latest/download/latest.json\n`);
}

// run as a script (tests import feed(), readNotes(), ciVersion() and ciNotes() without running anything)
if (/release\.mjs$/.test(process.argv[1] ?? "")) {
  if (cmd === "bump") bump(args[0]);
  else if (cmd === "build") build();
  else if (cmd === "publish") publish();
  else if (cmd === "ci" && args[0] === "build") ciBuild();
  else if (cmd === "ci" && args[0] === "publish") ciPublish(args.slice(2).map((d) => resolve(d)));
  else if (cmd === "history") writeHistory(null);
  else if (cmd === "notes") console.log(JSON.stringify(readNotes(args[0] ?? currentVersion()), null, 2));
  else die("usage: npm run release -- bump <x.y.z> | build | publish [--replace] | notes [version] | ci build <run> | ci publish <run> <dir>...");
}
