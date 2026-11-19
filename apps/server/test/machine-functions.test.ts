/**
 * A machine's functions (2026-11-17): reading what a machine offers from its scripts' headers, and the tar that
 * carries files in and out.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EXAMPLE_NAMES, examplesScript, fnPortName, mimeOf, parseFunctions, safeName } from "../src/machinefunctions.ts";
import { packTar, readTar } from "../src/tarlite.ts";

test("functions are read from their headers; a bad name or a missing kind is handled", () => {
  const listed = ["@@ trim-resize", "# about: Trims each picture", "# in: images", "#out:images", "@@ notes", "# about: Joins text", "# in: text", "# out: json", "@@ plain", "@@ bad/name", "# in: images", "@@ odd", "# in: pictures", ""].join("\n");
  assert.deepEqual(parseFunctions(listed), [
    { name: "notes", about: "Joins text", in: "text", out: "json" },
    { name: "odd", in: "files", out: "files" },
    { name: "plain", in: "files", out: "files" },
    { name: "trim-resize", about: "Trims each picture", in: "images", out: "images" },
  ]);
  assert.deepEqual(parseFunctions(""), []);
  assert.equal(fnPortName("trim-resize"), "fn:trim-resize");
});

test("the example functions say what they take and give", () => {
  const script = examplesScript();
  assert.deepEqual(EXAMPLE_NAMES, ["trim-resize", "sprite-sheet", "describe"]);
  // each one's header, as the machine would list it
  const listed = EXAMPLE_NAMES.map((n) => {
    const body = script.split(`cat > /foundation/functions/${n} <<'FOUNDATION_FN'\n`)[1].split("FOUNDATION_FN")[0];
    return `@@ ${n}\n${body.split("\n").filter((l) => /^#\s*(about|in|out)/.test(l)).join("\n")}`;
  }).join("\n");
  const fns = parseFunctions(listed);
  assert.deepEqual(
    fns.map((f) => [f.name, f.in, f.out]),
    [
      ["describe", "images", "json"],
      ["sprite-sheet", "images", "images"],
      ["trim-resize", "images", "images"],
    ],
  );
  assert.ok(fns.every((f) => f.about));
  assert.match(script, /apt-get install -y -qq --no-install-recommends imagemagick/);
  assert.match(script, /apk add --no-cache imagemagick/);
});

test("files go into the machine and come back by tar, byte for byte", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 255]);
  const big = Buffer.alloc(1300, 7);
  const tar = packTar([
    { name: "foundation/", dir: true },
    { name: "foundation/runs/r1/in/", dir: true },
    { name: "foundation/runs/r1/in/001-a.png", body: png },
    { name: "foundation/runs/r1/in/002-big.bin", body: big },
  ]);
  assert.equal(tar.length % 512, 0);
  const back = readTar(tar);
  assert.deepEqual(
    back.map((e) => e.name),
    ["foundation/runs/r1/in/001-a.png", "foundation/runs/r1/in/002-big.bin"],
  );
  assert.ok(back[0].body.equals(png));
  assert.ok(back[1].body.equals(big));
  // a checksum a real tar accepts: the header's sum of bytes, with the field read as spaces
  const h = tar.subarray(1024, 1536);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
  assert.equal(parseInt(h.subarray(148, 154).toString(), 8), sum);
});

test("a pax header's long name is read", () => {
  const long = `out/${"x".repeat(120)}.png`;
  const paxBody = Buffer.from(`${String(long.length + 9 + 3).padStart(0)} path=${long}\n`);
  // build: pax header (type x) + file entry with a short name
  const one = packTar([{ name: "PaxHeader", body: paxBody }, { name: "short.png", body: Buffer.from("hi") }]);
  one[156] = "x".charCodeAt(0); // the first entry is a pax header
  // fix its checksum after the type change
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : one[i];
  one.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  const back = readTar(one);
  assert.equal(back.length, 1);
  assert.equal(back[0].name, long);
});

test("names and types for what goes in and comes out", () => {
  assert.equal(safeName("Ada — sheet (final).PNG", 0), "001-Ada-sheet-final-.PNG");
  // no slashes survive, and a number leads, so nothing can leave the folder
  assert.equal(safeName("../../etc/passwd", 4), "005-..-..-etc-passwd");
  assert.equal(mimeOf("sheet.PNG"), "image/png");
  assert.equal(mimeOf("a.json"), "application/json");
  assert.equal(mimeOf("thing"), "application/octet-stream");
});
