/**
 * Reading Slack stays tied to the board, and one person's Slack stays theirs. Slack is a stand-in here
 * (SLACK_API_BASE) that answers each token as Slack would.
 *
 * - slack_read reads only a channel the board has taken in: a Slack card on it, or a section the Slack board
 *   keeps for it. Any other channel id is refused, even one the bot can see.
 * - The user token (SLACK_USER_TOKEN) is Ada's Slack. Slack search with it runs only for Ada's own asks (her
 *   search, or an agent acting for her). For Kai, or the service token, message search returns nothing and
 *   says Slack search needs their own connection; image search falls back to what the bot can see; and a
 *   Slack file is fetched with the bot's token, never with Ada's.
 * - If Slack won't say whose the token is, nobody's asks use it.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-slack-tie-"));
delete process.env.SLACK_USER_TOKEN;
delete process.env.SLACK_BOT_TOKEN;
import { png } from "./fixtures/png.ts";

const USER = "xoxp-ada";
const BOT = "xoxb-bot";
let fake: Server;
let base = "";
/** each Slack call: the method and the token it carried */
const calls: Array<{ method: string; token: string }> = [];
/** what users.info says the user token's account's email is (null: Slack won't say) */
let ownerEmail: string | null = "ada@example.test";

before(async () => {
  fake = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const method = url.pathname.slice(1);
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    calls.push({ method, token });
    const send = (o: unknown) => res.end(JSON.stringify(o));
    if (token !== USER && token !== BOT) return send({ ok: false, error: "invalid_auth" });
    const file = { id: "F1", name: "pthp.png", title: "PTHP", mimetype: "image/png", timestamp: 1_790_000_000, channels: ["design"], url_private_download: `${base}/download/F1` };
    switch (method) {
      case "auth.test":
        return send(token === USER ? { ok: true, user_id: "UADA", user: "ada" } : { ok: true, user_id: "UBOT", user: "foundation" });
      case "users.info":
        return send(ownerEmail && url.searchParams.get("user") === "UADA" ? { ok: true, user: { name: "ada", profile: { email: ownerEmail } } } : { ok: false, error: "user_not_found" });
      case "search.messages":
        // only a user token can search messages
        if (token !== USER) return send({ ok: false, error: "not_allowed_token_type" });
        return send({ ok: true, messages: { matches: [{ iid: "m1", text: "salary review in DM", permalink: "https://slack.example/m1", username: "ada", channel: { name: "dm" } }] } });
      case "search.files":
        if (token !== USER) return send({ ok: false, error: "not_allowed_token_type" });
        return send({ ok: true, files: { matches: [file] } });
      case "files.list":
        return send({ ok: true, files: [file] });
      case "files.info":
        return send({ ok: true, file });
      case "conversations.history":
        return send({ ok: true, messages: [{ ts: "1793000001.000100", user: "UKAI", text: "morning" }] });
      case "download/F1":
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(png(4, 3, [10, 20, 30]));
      default:
        return send({ ok: false, error: "unknown_method" });
    }
  });
  await new Promise<void>((ok) => fake.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
  process.env.SLACK_API_BASE = base;
});
after(() => fake.close());

const { run } = await import("../src/db.ts");
const { runTool } = await import("../src/tools.ts");
const { searchAll } = await import("../src/search.ts");
const { findImages, layOut } = await import("../src/construct.ts");
const { slackUserTokenFor, forgetUserTokenOwner } = await import("../src/slackuser.ts");
const { getBoard, editBoard, closeBoards } = await import("../src/boards.ts");
const { appendSection, boardMaps } = await import("@foundation/protocol");
after(() => closeBoards());

for (const [id, email] of [
  ["u_ada", "ada@example.test"],
  ["u_kai", "kai@example.test"],
])
  run("insert or ignore into users (id, email, name, color, role, created_at) values (?, ?, ?, '#325bb4', 'member', 0)", id, email, id.slice(2));

const BOARD = "slack-tie";
const ctx = (userId: string) => ({ boardId: BOARD, actor: `${userId}'s agent`, userId });

// these checks are about which channel and whose token, so a person has already allowed agents on this board to
// read and search Slack (the outgoing gate, egress.ts, has its own tests)
const { setAllowance } = await import("../src/egress.ts");
const adaPerson = { id: "u_ada", email: "ada@example.test", name: "ada", color: "#325bb4", role: "member" as const };
setAllowance(BOARD, adaPerson, "Slack", "read", true);
setAllowance(BOARD, adaPerson, "Slack", "query", true);

test("slack_read reads a channel on the board, and refuses one that isn't", async () => {
  process.env.SLACK_BOT_TOKEN = BOT;
  const doc = getBoard(BOARD).doc;
  doc.transact(() => appendSection(doc, "Main"));
  // nothing on the board yet: the bot could read C0SECRET, but this board never took it in
  await assert.rejects(runTool(ctx("u_ada"), "slack_read", { channel: "C0SECRET" }), /isn't on this board/);
  assert.equal(calls.filter((c) => c.method === "conversations.history").length, 0, "Slack wasn't asked");
  // a person puts a Slack card for C0DESIGN on the board: that channel reads
  editBoard(BOARD, "test", (d) => {
    const m = boardMaps(d);
    const sectionId = [...m.sections.keys()][0];
    m.objects.set("pnl_slack", { id: "pnl_slack", kind: "panel", panel: "slack", sectionId, name: "#design", channel: "C0DESIGN", x: 0, y: 0, w: 4, h: 4, float: false, ports: [] } as never);
  });
  assert.match(String(await runTool(ctx("u_kai"), "slack_read", { channel: "C0DESIGN" })), /morning/);
  // and still not another one
  await assert.rejects(runTool(ctx("u_kai"), "slack_read", { channel: "C0SECRET" }), /isn't on this board/);
});

test("the user token is Ada's: her own asks use it; Kai's, the service token's and no one's don't", async () => {
  process.env.SLACK_USER_TOKEN = USER;
  forgetUserTokenOwner();
  assert.equal(await slackUserTokenFor("u_ada"), USER);
  assert.equal(await slackUserTokenFor("u_kai"), null);
  assert.equal(await slackUserTokenFor("agent"), null, "the service token is nobody's own ask");
  assert.equal(await slackUserTokenFor(undefined), null);
});

test("message search: Ada (or her agent) finds her Slack; Kai gets a sentence, and Ada's token isn't used", async () => {
  const mine = await searchAll("salary", { userId: "u_ada" });
  assert.equal(mine.hits.filter((h) => h.source === "slack").length, 1);
  assert.deepEqual(mine.notes, []);
  // an agent acting for Ada: the search tool
  assert.match(String(await runTool(ctx("u_ada"), "search", { query: "salary" })), /\[slack\].*salary review/);

  calls.length = 0;
  const theirs = await searchAll("salary", { userId: "u_kai" });
  assert.equal(theirs.hits.filter((h) => h.source === "slack").length, 0);
  assert.match(theirs.notes.join(" "), /Slack search runs on a person's own Slack connection/);
  const kaiTool = String(await runTool(ctx("u_kai"), "search", { query: "salary" }));
  assert.doesNotMatch(kaiTool, /salary review/);
  assert.match(kaiTool, /own Slack connection/);
  const service = await searchAll("salary", { slackAs: "agent" });
  assert.equal(service.hits.filter((h) => h.source === "slack").length, 0);
  assert.equal(calls.filter((c) => c.token === USER && c.method.startsWith("search.")).length, 0, "Ada's token searched nothing for anyone else");
});

test("image search: Ada's search uses her token; Kai's uses only what the bot can see, and says so", async () => {
  const doc = getBoard(BOARD).doc;
  calls.length = 0;
  const mine = await findImages(doc, BOARD, "pthp", "u_ada", ["slack"]);
  assert.deepEqual(mine.images.map((i) => i.ref), ["slack:F1"]);
  assert.ok(calls.some((c) => c.method === "search.files" && c.token === USER));

  calls.length = 0;
  const theirs = await findImages(doc, BOARD, "pthp", "u_kai", ["slack"]);
  assert.deepEqual(theirs.images.map((i) => i.ref), ["slack:F1"], "the bot can see this one");
  assert.match(theirs.notes.join(" "), /with what the bot can see.*own Slack connection/);
  assert.equal(calls.filter((c) => c.token === USER && c.method !== "auth.test" && c.method !== "users.info").length, 0, "Ada's token wasn't used for Kai");

  // with no bot token, Kai's image search finds nothing in Slack and says why
  delete process.env.SLACK_BOT_TOKEN;
  const none = await findImages(doc, BOARD, "pthp", "u_kai", ["slack"]);
  assert.equal(none.count, 0);
  assert.match(none.notes.join(" "), /own Slack connection/);
});

test("bringing a Slack file in: the bot's token, or Ada's only for Ada", async () => {
  delete process.env.SLACK_BOT_TOKEN;
  calls.length = 0;
  const kai = await layOut(ctx("u_kai"), { title: "Kai's page", items: [{ ref: "slack:F1" }] });
  assert.equal(kai.images, 0);
  assert.match(JSON.stringify(kai.skipped), /own Slack connection/);
  assert.equal(calls.filter((c) => c.method === "files.info").length, 0, "Ada's token fetched nothing for Kai");
  const ada = await layOut(ctx("u_ada"), { title: "Ada's page", items: [{ ref: "slack:F1" }] });
  assert.equal(ada.images, 1);
});

test("if Slack won't say whose the user token is, nobody's asks use it", async () => {
  ownerEmail = null;
  forgetUserTokenOwner();
  assert.equal(await slackUserTokenFor("u_ada"), null);
  const r = await searchAll("salary", { userId: "u_ada" });
  assert.equal(r.hits.filter((h) => h.source === "slack").length, 0);
  assert.match(r.notes.join(" "), /own Slack connection/);
});
