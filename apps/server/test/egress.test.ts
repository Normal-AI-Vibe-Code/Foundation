/**
 * Sending outside is explicit (egress.ts; SECURITY.md rule 8), in process, with the network seams
 * stubbed and counted: Slack (every fetch to its API) and GitHub (github.ts's transport).
 *
 * - An agent calling search, read_repo, slack_read and ask_person on a board where nothing is allowed:
 *   nothing reaches a seam, the agent gets a sentence saying a person has to allow it, and an `asked`
 *   row is in the audit log.
 * - A person allows Slack searches on that board: the agent's search now reaches Slack but not GitHub.
 * - Allowances on one board do nothing for another; taking one back works.
 * - A person's own call is allowed and recorded as approved by themselves.
 * - Who may set an allowance: not the service token, not a viewer, and on a members-only board only its
 *   owner or an admin (the routes add requirePerson: egress-doors.test.ts).
 * - Private things are refused whole, never sent with the private part left out.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-egress-"));
process.env.SLACK_BOT_TOKEN = "test-slack-bot-token";
process.env.SLACK_USER_TOKEN = "test-slack-user-token";
process.env.SLACK_API_BASE = "https://slack.test/api";
process.env.GITHUB_TOKEN = "";
process.env.FOUNDATION_GITHUB_ORG = "";
process.env.FOUNDATION_GITHUB_OWNERS = "";

// ---------- the seams, counted ----------

const slackHits: string[] = [];
const elsewhere: string[] = [];
const sawSlack = (method: string) => slackHits.some((u) => u.includes(method));
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  if (/slack\.(com|test)/.test(url)) {
    slackHits.push(url);
    const method = new URL(url).pathname.split("/").pop();
    const body =
      method === "auth.test"
        ? { ok: true, user_id: "U1" }
        : method === "users.info"
          ? { ok: true, user: { id: "U1", profile: { email: "ada@example.test" } } }
          : method === "search.messages"
        ? { ok: true, messages: { matches: [{ iid: "m1", text: "the rim drive ships Friday", permalink: "https://slack.test/m1", username: "ada", channel: { name: "general" } }] } }
        : method === "users.lookupByEmail"
          ? { ok: true, user: { id: "U1" } }
          : { ok: true, messages: [{ ts: "1700000000.000100", user: "U1", text: "hello from the channel" }], channel: { id: "C0123456", name: "general" }, channels: [], members: [], user: { id: "U1", name: "ada", real_name: "Ada", profile: {} }, response_metadata: {} };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }
  elsewhere.push(url);
  throw new Error(`no network in this test: ${url}`);
}) as typeof fetch;

const gh = await import("../src/github.ts");
const ghHits: string[] = [];
gh.githubTransport.get = async <T>(path: string): Promise<T> => {
  ghHits.push(path);
  if (path.endsWith("/readme")) return { content: Buffer.from("# Hello").toString("base64"), encoding: "base64" } as T;
  if (path.includes("/commits")) return [] as T;
  if (path.startsWith("/user/repos")) return [{ full_name: "form-industries/rim", html_url: "", description: "rim drive", homepage: null, default_branch: "main", pushed_at: "", language: null, private: true }] as T;
  return { full_name: "form-industries/rim", html_url: "", description: null, homepage: null, default_branch: "main", pushed_at: "", language: null, private: false } as T;
};

const { runTool, httpToolCtx } = await import("../src/tools.ts");
const { upsertUser } = await import("../src/auth.ts");
const { setBoardRole } = await import("../src/roles.ts");
const { setMember } = await import("../src/members.ts");
const { createBoardRow, closeBoards, getBoard } = await import("../src/boards.ts");
const { setAllowance, allowancesOn } = await import("../src/egress.ts");
const { readAudit } = await import("../src/audit.ts");
const { db, one } = await import("../src/db.ts");
const { boardMaps } = await import("@foundation/protocol");

after(() => {
  closeBoards();
  globalThis.fetch = realFetch;
});

const ada = upsertUser("ada@example.test", "Ada");
const boss = { ...upsertUser("boss@example.test", "Boss"), role: "admin" as const };
db.prepare("update users set role = 'admin' where id = ?").run(boss.id);
const vic = upsertUser("vic@example.test", "Vic");
const kai = upsertUser("kai@example.test", "Kai");
setBoardRole(boss, "company", vic.id, "viewer");
const other = createBoardRow("Other grid");

/** Ada's agent at the MCP door (her agent token), on a board */
const agent = (boardId = "company") => ({ boardId, actor: "Ada's agent", userId: ada.id, door: "mcp" as const });
const reset = () => {
  slackHits.length = 0;
  ghHits.length = 0;
  elsewhere.length = 0;
};
const rowsSince = (n: number) => readAudit({ limit: 500 }).slice(n);
const count = () => readAudit({ limit: 500 }).length;
const HELD = /Nothing was sent to .*: a person has to allow/;

test("nothing allowed: an agent's search, read_repo, slack_read and ask_person reach no seam, get a sentence, and are recorded as asked", async () => {
  reset();
  const n = count();
  const found = String(await runTool(agent(), "search", { query: "rim drive" }));
  assert.match(found, HELD, "the search says what it couldn't send");
  const repo = await runTool(agent(), "read_repo", { repo: "form-industries/rim" });
  assert.match(String(repo), HELD);
  assert.match(String(repo), /GitHub/);
  const read = await runTool(agent(), "slack_read", { channel: "C0123456" });
  assert.match(String(read), HELD);
  const asked = await runTool(agent(), "ask_person", { assignee: "kai@example.test", request: "Upload the latest rim STEP", kind: "cad_upload" });
  assert.match(String(asked), HELD);
  assert.equal(one("select count(*) as n from asks") && (one<{ n: number }>("select count(*) as n from asks")!.n), 0, "no ask card was made: the call didn't run");

  assert.deepEqual(slackHits, [], "nothing reached Slack");
  assert.deepEqual(ghHits, [], "nothing reached GitHub");
  assert.deepEqual(elsewhere, []);

  const rows = rowsSince(n);
  const askedRows = rows.filter((r) => r.decision === "asked");
  for (const [action, service] of [["search", "Slack"], ["search", "GitHub"], ["read_repo", "GitHub"], ["slack_read", "Slack"], ["ask_person", "Slack"]]) {
    const r = askedRows.find((x) => x.action === action && x.service === service);
    assert.ok(r, `an asked row for ${action} → ${service}`);
    assert.deepEqual([r!.actor_kind, r!.for_person, r!.door, r!.provenance, r!.board_id], ["agent", ada.id, "mcp", "external", "company"]);
  }
});

test("a person allows Slack searches on the board: the agent's search reaches Slack, and still not GitHub", async () => {
  setAllowance("company", ada, "Slack", "query", true);
  reset();
  const n = count();
  const found = String(await runTool(agent(), "search", { query: "rim drive" }));
  assert.ok(slackHits.some((u) => u.includes("search.messages")), `Slack was searched: ${slackHits.join()}`);
  assert.deepEqual(ghHits, [], "GitHub wasn't");
  assert.match(found, /the rim drive ships Friday/, "Slack's answer is in the result");
  assert.match(found, /Nothing was sent to GitHub/, "and the result says GitHub wasn't searched");
  const call = rowsSince(n).find((r) => r.action === "search" && r.decision === "allowed")!;
  assert.equal(call.approved_by, ada.id, "approved by the person who allowed it");
  assert.match(call.service!, /Slack/);
  assert.ok(rowsSince(n).some((r) => r.action === "search" && r.decision === "asked" && r.service === "GitHub"));
  // Slack searches aren't Slack reads
  reset();
  assert.match(String(await runTool(agent(), "slack_read", { channel: "C0123456" })), HELD);
  assert.deepEqual(slackHits, []);
});

test("an allowance on one board does nothing for another, and taking it back works", async () => {
  reset();
  await runTool(agent(other), "search", { query: "rim drive" });
  assert.deepEqual(slackHits, [], "nothing allowed on the other grid");
  setAllowance("company", ada, "Slack", "query", false);
  assert.equal(allowancesOn("company").length, 0);
  reset();
  assert.match(String(await runTool(agent(), "search", { query: "rim drive" })), /Nothing was sent to Slack/);
  assert.deepEqual(slackHits, [], "taken back: Slack isn't searched");
});

test("a person's own call is allowed, and recorded as approved by themselves", async () => {
  reset();
  const n = count();
  const out = (await runTool(httpToolCtx("company", ada, true), "read_repo", { repo: "form-industries/rim" })) as { readme: string };
  assert.equal(out.readme, "# Hello");
  assert.ok(ghHits.length > 0, "GitHub was read");
  const r = rowsSince(n).find((x) => x.action === "read_repo")!;
  assert.deepEqual([r.actor_kind, r.door, r.decision, r.approved_by, r.provenance, r.service, r.result], ["person", "http", "allowed", ada.id, "external", "GitHub", "ok"]);
});

test("who may set an allowance: not the service token, not a viewer; on a members-only grid only its owner or an admin", () => {
  const svc = { id: "agent", email: "agent@foundation.local", name: "Foundation Agent", color: "", role: "member" as const };
  assert.throws(() => setAllowance("company", svc, "Slack", "query", true), /service token/);
  assert.throws(() => setAllowance("company", vic, "Slack", "query", true), /View only/);
  const room = createBoardRow("Members room");
  setMember(room, kai.id, "editor");
  setMember(room, ada.id, "owner");
  assert.throws(() => setAllowance(room, kai, "GitHub", "read", true), /owner or an admin/);
  setAllowance(room, ada, "GitHub", "read", true);
  setAllowance(room, boss, "GitHub", "query", true);
  assert.equal(allowancesOn(room).length, 2);
  const refused = readAudit({ limit: 500 }).filter((r) => r.action === "egress.allow" && r.decision === "refused");
  assert.equal(refused.length, 3, "each refusal is recorded");
});

test("private things are refused whole: a send naming or quoting a members-only grid's card is never sent, with or without that part", async () => {
  const secret = createBoardRow("Secret room");
  setMember(secret, boss.id, "owner");
  const quote = "The new rim profile holds at twelve thousand rpm with the thinner spokes";
  const note = (await runTool(httpToolCtx(secret, boss, true), "add_note", { section: "Plans", title: "Rim test", markdown: `${quote}.\n\nNumbers to follow.` })) as { id: string };
  await new Promise((r) => setTimeout(r, 1100)); // the board's text goes into the index a beat after it settles
  assert.ok(boardMaps(getBoard(secret).doc).objects.has(note.id));
  // allow everything an agent could need on the company grid, so only the content decides
  for (const [s, k] of [["Slack", "query"], ["Slack", "message"], ["GitHub", "query"]] as const) setAllowance("company", ada, s, k, true);
  reset();
  const n = count();

  // Ada can't see the room: naming its card, or quoting it, is refused, as her agent and as herself
  await assert.rejects(() => runTool(agent(), "ask_person", { assignee: "kai@example.test", request: `See ${note.id} and send the STEP`, kind: "info" }), /Refused, and nothing was sent/);
  await assert.rejects(() => runTool(agent(), "search", { query: quote }), /Refused, and nothing was sent/);
  await assert.rejects(() => runTool(httpToolCtx("company", ada, true), "search", { query: `${quote}.` }), /Refused, and nothing was sent/);
  await assert.rejects(() => runTool(agent(), "search", { query: "Secret room" }), /can't see/, "the grid's own name");
  // Boss can see it: a search naming it is his; a message from the company grid carrying it isn't
  const bossAgent = { boardId: "company", actor: "Boss's agent", userId: boss.id, door: "mcp" as const };
  await assert.rejects(() => runTool(bossAgent, "ask_person", { assignee: "kai@example.test", request: `Look at ${note.id}`, kind: "info" }), /another members-only grid/);
  assert.deepEqual(slackHits, [], "nothing went to Slack, not even the rest of the message");
  assert.deepEqual(ghHits, []);
  assert.equal(one<{ n: number }>("select count(*) as n from asks")!.n, 0, "no ask was made");
  const refused = rowsSince(n).filter((r) => r.decision === "refused");
  assert.equal(refused.length, 5);
  for (const r of refused) assert.equal(r.reason, "private content");
  // the same ask without it goes
  await runTool(agent(), "ask_person", { assignee: "kai@example.test", request: "Send the latest rim STEP", kind: "cad_upload" });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(sawSlack("chat.postMessage"), "a message with nothing private in it goes");
  // and from the room itself, a message carrying its own card is fine for its member
  reset();
  setAllowance(secret, boss, "Slack", "message", true);
  await runTool({ boardId: secret, actor: "Boss's agent", userId: boss.id, door: "mcp" }, "ask_person", { assignee: "kai@example.test", request: `About ${note.id}: send the STEP`, kind: "info" });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(sawSlack("chat.postMessage"));
});
