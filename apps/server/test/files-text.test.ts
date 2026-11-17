/**
 * Searching inside files: PDFs, Word, PowerPoint, Excel and OpenDocument are
 * read after their upload answers (in a worker), put into search, and shown
 * with the matching words marked. The same bytes are stored and read once.
 * Documents uploaded before this are read at boot. Nothing a document
 * carries is run (a macro-enabled .docm's VBA is never read).
 *
 * Fixtures are hand-made by test/fixtures/docs/make.mjs.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const data = mkdtempSync(join(tmpdir(), "foundation-test-"));
process.env.FOUNDATION_DATA_DIR = data;

const { all, one, run } = await import("../src/db.ts");
const { storeFile, readFileText, archiveFile, reindexFilesIfNeeded } = await import("../src/files.ts");
const { fileTextIdle, backfillFileText, TEXT_V } = await import("../src/filetext.ts");
const { extractDocText, docKind } = await import("../src/extract.ts");
const { searchLocal, markSnippet } = await import("../src/search.ts");
const { closeBoards } = await import("../src/boards.ts");

after(() => closeBoards());

const fixture = (name: string) => readFileSync(new URL(`./fixtures/docs/${name}`, import.meta.url));
const user = "u_files";
run("insert or ignore into users (id, email, name, color, role, created_at) values (?, ?, ?, ?, 'member', ?)", user, "files@formindustries.com", "Files", "#325bb4", Date.now());

test("extractors: the words inside a PDF, Word, PowerPoint, Excel and OpenDocument file", async () => {
  const pdf = await extractDocText("pdf", fixture("spec.pdf"));
  assert.match(pdf, /Kestrelmount spec sheet/); // the Info title
  assert.match(pdf, /Torque spec: 42 Nm on the clamp bands\./);
  assert.match(pdf, /Osterlund fan shroud/); // page two

  const docx = await extractDocText("docx", fixture("doc.docx"));
  assert.match(docx, /Zephyrine bracket assembly\nTorque the M6 bolts to 9 Nm then check & sign\./); // runs joined, a tab is a space, &amp; decoded
  assert.match(docx, /Form Industries internal/); // the footer
  assert.match(docx, /assembly, brackets/); // keywords

  const pptx = await extractDocText("pptx", fixture("deck.pptx"));
  // slides in their order (10 after 2), entities decoded
  assert.match(pptx, /Halvorsen roadmap\nQ1: intake redesign\n+Q2: pilot line <Kapaa>\n+Q4: ship/);

  const xlsx = await extractDocText("xlsx", fixture("parts.xlsx"));
  assert.match(xlsx, /BOM\nPart Qty\nVentura gasket 12 03304-10027/); // sheet name, rows as lines, shared strings, numbers, inline strings

  const odt = await extractDocText("odf", fixture("notes.odt"));
  assert.match(odt, /Marrowind test log\nFan ran at 2400 rpm\./);
});

test("a macro-enabled document gives its text and nothing of its macros", async () => {
  assert.equal(docKind("doc.docm", "application/octet-stream"), "docx");
  const text = await extractDocText("docx", fixture("doc.docm"));
  assert.match(text, /Zephyrine bracket assembly/);
  assert.doesNotMatch(text, /calc\.exe|AutoOpen|VB_Name/);
});

test("kinds come from the name, else the type; other files aren't documents", () => {
  assert.equal(docKind("Spec.PDF", ""), "pdf");
  assert.equal(docKind("deck", "application/vnd.openxmlformats-officedocument.presentationml.presentation"), "pptx");
  assert.equal(docKind("notes.md", "text/markdown"), null);
  assert.equal(docKind("part.step", "model/step"), null);
});

test("an upload answers first; its inside is searchable a moment later, the match marked", async () => {
  const t0 = performance.now();
  const f = await storeFile(fixture("spec.pdf"), { name: "intake-spec.pdf", mime: "application/pdf", boardId: "fb", userId: user });
  const took = performance.now() - t0;
  // found by name at once
  assert.ok(searchLocal("intake", "fb").some((h) => h.id === `file:${f.id}`));
  // the PDF hasn't been read yet when the upload returns (a worker reads it after)
  assert.ok(took < 2000, `upload took ${took} ms`);
  await fileTextIdle();
  const hit = searchLocal("osterlund", "fb").find((h) => h.id === `file:${f.id}`);
  assert.ok(hit, "found by a word on page two");
  assert.match(hit.snippet, /«Osterlund»/);
  assert.equal(hit.url, `/files/${f.id}`);
  // a prefix finds it too, and the snippet marks the whole word
  const pre = searchLocal("kestrel", "fb").find((h) => h.id === `file:${f.id}`);
  assert.ok(pre);
  assert.match(pre.snippet, /«Kestrelmount»/);

  for (const [name, mime, word] of [
    ["bracket.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "zephyrine"],
    ["roadmap.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "halvorsen"],
    ["bom.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "03304"],
  ] as const) {
    const fx = name === "bracket.docx" ? "doc.docx" : name === "roadmap.pptx" ? "deck.pptx" : "parts.xlsx";
    const up = await storeFile(fixture(fx), { name, mime, boardId: "fb", userId: user });
    await fileTextIdle();
    const h = searchLocal(word, "fb").find((x) => x.id === `file:${up.id}`);
    assert.ok(h, `${name} found by “${word}”`);
    assert.match(h.snippet, /«[^»]+»/, `${name} snippet marks the match: ${h.snippet}`);
  }
});

test("the same bytes are stored once and read once, whichever board they go to", async () => {
  const body = fixture("doc.docx");
  const sha = createHash("sha256").update(body).digest("hex");
  const again = await storeFile(body, { name: "copy-on-another-board.docx", mime: "", boardId: "fb2", userId: user });
  // already read (the earlier upload): searchable before anything runs
  assert.ok(searchLocal("zephyrine", "fb2").some((h) => h.id === `file:${again.id}`));
  assert.equal(one<{ n: number }>("select count(*) as n from file_text where sha256 = ?", sha)!.n, 1);
  assert.equal(readdirSync(join(data, "files")).filter((n) => n === sha).length, 1);
  // the same bytes to the same board are the same file
  const same = await storeFile(body, { name: "again.docx", mime: "", boardId: "fb2", userId: user });
  assert.equal(same.id, again.id);
});

test("an agent's read_file gets a document's text", async () => {
  const f = await storeFile(fixture("notes.odt"), { name: "log.odt", mime: "application/vnd.oasis.opendocument.text", boardId: "fb", userId: user });
  // asked before the worker got to it: it's read at the front of the queue
  assert.match(await readFileText(f.id), /Fan ran at 2400 rpm/);
});

test("a file that won't read is still found by its name, and isn't tried again", async () => {
  const f = await storeFile(fixture("broken.pdf"), { name: "broken-scan.pdf", mime: "application/pdf", boardId: "fb", userId: user });
  await fileTextIdle();
  assert.ok(searchLocal("broken", "fb").some((h) => h.id === `file:${f.id}`));
  const row = one<{ status: string; v: number }>("select status, v from file_text where sha256 = ?", f.sha256);
  assert.equal(row?.status, "failed");
  assert.equal(row?.v, TEXT_V);
  assert.equal(backfillFileText(), 0);
  assert.match(await readFileText(f.id), /no text could be read/);
});

test("documents from before are read at boot; archived ones are left alone", async () => {
  // as if uploaded by an older server: bytes on disk, a row, no text
  const body = Buffer.concat([fixture("parts.xlsx")]);
  const sha = createHash("sha256").update(Buffer.concat([body, Buffer.from("x")])).digest("hex");
  writeFileSync(join(data, "files", sha), Buffer.concat([body, Buffer.from("x")])); // trailing byte: a zip still reads
  run("insert into files (id, board_id, name, mime, size, sha256, uploaded_by, created_at) values ('f_old', 'fb3', 'old-bom.xlsx', 'application/octet-stream', ?, ?, ?, ?)", body.length + 1, sha, user, Date.now());
  const archivedSha = createHash("sha256").update("archived").digest("hex");
  writeFileSync(join(data, "files", archivedSha), fixture("deck.pptx"));
  run("insert into files (id, board_id, name, mime, size, sha256, uploaded_by, created_at, archived_at) values ('f_gone', 'fb3', 'gone.pptx', '', 10, ?, ?, ?, ?)", archivedSha, user, Date.now(), Date.now());

  assert.equal(searchLocal("ventura", "fb3").length, 0);
  assert.equal(backfillFileText(), 1);
  await fileTextIdle();
  assert.ok(searchLocal("ventura", "fb3").some((h) => h.id === "file:f_old"));
  assert.equal(one("select 1 as y from file_text where sha256 = ?", archivedSha), undefined);
  // the boot hook schedules the same backfill (nothing left to do now)
  reindexFilesIfNeeded();
  // archived, never deleted: the row and its bytes stay
  archiveFile("f_old");
  assert.ok(one("select 1 as y from files where id = 'f_old' and archived_at is not null"));
  assert.ok(readdirSync(join(data, "files")).includes(sha));
});

test("snippets: matches in «», the text's own «» made plain, one line", () => {
  assert.equal(markSnippet("le \x02moteur\x03 «rapide»\n  ici"), 'le «moteur» "rapide" ici');
  run("insert into search_fts (source, ref, board_id, title, body) values ('file', 'f_fr', 'fr', 'notes.txt', ?)", "Le carnet dit «turbine» puis la turbine tourne");
  const h = searchLocal("tourne", "fr")[0];
  assert.ok(h);
  assert.equal(h.snippet.match(/«/g)?.length, 1, h.snippet);
  assert.match(h.snippet, /«tourne»/);
  assert.equal(all("select 1 from search_fts where ref = 'f_fr'").length, 1);
});
