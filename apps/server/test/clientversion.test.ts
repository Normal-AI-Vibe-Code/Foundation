/**
 * The oldest client a server still works with (clientversion.ts): `FOUNDATION_MIN_CLIENT`.
 *
 * An older client is told (426 for a socket ticket, close 4426 for a socket) and gets no board
 * socket, so it can't write a board it might misread; a current one, and anything that isn't the
 * app (an agent, a script), is untouched; with no minimum set, nobody is refused. These run the
 * server's own upgrade handler on a real port with real sockets.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-test-"));

const { config } = await import("../src/config.ts");
const auth = await import("../src/auth.ts");
const { handleUpgrade } = await import("../src/sockets.ts");
const { closeBoards, getBoard } = await import("../src/boards.ts");
const { boardMaps, appendSection, belowMinimum, compareVersions } = await import("@foundation/protocol");
const cv = await import("../src/clientversion.ts");

const ada = auth.upsertUser("ada@formindustries.com", "Ada");
const session = auth.createSession(ada.id);
{
  const doc = getBoard("mv").doc;
  if (boardMaps(doc).sections.size === 0) doc.transact(() => appendSection(doc, "Main"));
}

let server: Server;
let base = "";
before(async () => {
  const wss = new WebSocketServer({ noServer: true });
  server = createServer((_req, res) => res.writeHead(404).end());
  server.on("upgrade", (req, socket, head) => handleUpgrade(wss, req, socket, head));
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  closeBoards();
});

/** open a sync socket and say how it went: the close code, or "open" if it stayed up */
function knock(query: string, origin?: string): Promise<number | "open"> {
  return new Promise((ok) => {
    const ws = new WebSocket(`${base}/sync/mv${query}`, { headers: { authorization: `Bearer ${session}`, ...(origin ? { origin } : {}) } });
    const t = setTimeout(() => (ws.close(), ok("open")), 400);
    ws.on("close", (code) => (clearTimeout(t), ok(code)));
    ws.on("error", () => (clearTimeout(t), ok(-1)));
  });
}

test("versions compare as numbers, pre-releases before their release, and nothing unreadable is refused", () => {
  assert.equal(compareVersions("0.10.0", "0.9.2"), 1);
  assert.equal(compareVersions("0.4.0-rc.1", "0.4.0"), -1);
  assert.equal(belowMinimum("0.3.0", "0.4.0"), true);
  assert.equal(belowMinimum("0.4.0", "0.4.0"), false);
  assert.equal(belowMinimum("0.4.1", "v0.4.0"), false);
  // no minimum, a minimum that isn't a version, a client that doesn't say: nobody is refused on a guess
  assert.equal(belowMinimum("0.3.0", ""), false);
  assert.equal(belowMinimum("0.3.0", "soon"), false);
  assert.equal(belowMinimum(undefined, "0.4.0"), false);
  assert.equal(belowMinimum("latest", "0.4.0"), false);
});

test("with no minimum set, every client gets its socket", async () => {
  config.minClient = "";
  assert.equal(cv.minClient(), "");
  assert.equal(await knock("?client=0.1.0"), "open");
  assert.doesNotThrow(() => cv.requireCurrentClient("0.1.0", undefined));
});

test("an older client is told to update and gets no board socket; a current one is untouched", async () => {
  config.minClient = "0.4.0";
  assert.equal(await knock("?client=0.3.0"), cv.CLOSE_TOO_OLD);
  assert.equal(await knock("?client=0.4.0"), "open");
  assert.equal(await knock("?client=0.5.2"), "open");
  // the ticket a bearer client asks for first is refused the same way, in words a person can act on
  assert.throws(
    () => cv.requireCurrentClient("0.3.0", "http://localhost:31440"),
    (e: Error & { status?: number }) => e.status === 426 && /0\.3\.0 is no longer supported.*Update to 0\.4\.0 or newer/.test(e.message),
  );
  assert.doesNotThrow(() => cv.requireCurrentClient("0.4.0", "http://localhost:31440"));
});

test("the desktop builds from before clients said their version are known by their page; anything else that doesn't say isn't the app", async () => {
  config.minClient = "0.4.0";
  // 0.3.0's window: no `client=`, the desktop page's origin
  assert.equal(await knock("", "http://localhost:31440"), cv.CLOSE_TOO_OLD);
  assert.equal(cv.clientVersionOf(undefined, "tauri://localhost"), "0.3.0");
  // an agent, a script, the service: no origin, no version, not refused
  assert.equal(await knock(""), "open");
  // a version that isn't one is not a way round, and not a reason either
  assert.equal(await knock("?client=9.9.9"), "open");
  assert.equal(cv.clientVersionOf("../etc", undefined), null);
  // once the minimum is 0.3.0 or under, those builds are fine again
  config.minClient = "0.3.0";
  assert.equal(await knock("", "http://localhost:31440"), "open");
});

test("a minimum that isn't a version is ignored rather than locking everyone out", async () => {
  config.minClient = "next";
  assert.equal(cv.minClient(), "");
  assert.equal(await knock("?client=0.0.1"), "open");
  config.minClient = "";
});
