/**
 * A person's link to Flowform (flowformlink.ts): the OAuth hand-off with PKCE,
 * read-only scope, tokens encrypted at rest and never plain in the database,
 * a refresh when the access token runs out, and revoke on disconnect.
 * A stand-in Flowform answers its well-known documents, /oauth/* and /mcp.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "foundation-test-"));
process.env.FOUNDATION_DATA_DIR = dataDir;
process.env.FOUNDATION_PUBLIC_URL = "http://localhost:4410";

let fake: Server;
let origin = "";
const seen = {
  registrations: [] as Array<Record<string, unknown>>,
  codes: new Map<string, { challenge: string; scope: string }>(),
  access: new Set<string>(),
  refresh: new Set<string>(),
  revoked: [] as string[],
  mcpBearers: [] as string[],
  calls: [] as Array<{ name: string; args: unknown }>,
  n: 0,
};

const body = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

before(async () => {
  fake = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", origin);
    const send = (status: number, obj?: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(obj === undefined ? "" : JSON.stringify(obj));
    if (url.pathname === "/.well-known/oauth-authorization-server")
      return send(200, {
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        registration_endpoint: `${origin}/oauth/register`,
        revocation_endpoint: `${origin}/oauth/revoke`,
        code_challenge_methods_supported: ["S256"],
      });
    if (url.pathname === "/oauth/register") {
      seen.registrations.push(JSON.parse(await body(req)));
      return send(201, { client_id: "client-foundation" });
    }
    if (url.pathname === "/oauth/token") {
      const p = new URLSearchParams(await body(req));
      if (p.get("client_id") !== "client-foundation") return send(400, { error: "invalid_client" });
      const mint = (scope: string) => {
        const access = `access-${++seen.n}`;
        const refresh = `refresh-${seen.n}`;
        seen.access.add(access);
        seen.refresh.add(refresh);
        return send(200, { access_token: access, refresh_token: refresh, expires_in: 3600, scope, token_type: "Bearer" });
      };
      if (p.get("grant_type") === "authorization_code") {
        const c = seen.codes.get(p.get("code") ?? "");
        seen.codes.delete(p.get("code") ?? "");
        const challenge = createHash("sha256").update(p.get("code_verifier") ?? "").digest("base64url");
        if (!c || c.challenge !== challenge) return send(400, { error: "invalid_grant" });
        return mint(c.scope);
      }
      if (p.get("grant_type") === "refresh_token") {
        const r = p.get("refresh_token") ?? "";
        if (!seen.refresh.delete(r)) return send(400, { error: "invalid_grant" });
        return mint("search:read canvas:read");
      }
      return send(400, { error: "unsupported_grant_type" });
    }
    if (url.pathname === "/oauth/revoke") {
      const t = new URLSearchParams(await body(req)).get("token") ?? "";
      seen.revoked.push(t);
      seen.access.delete(t);
      seen.refresh.delete(t);
      return send(200, {});
    }
    if (url.pathname === "/mcp") {
      const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (!seen.access.has(bearer)) return res.writeHead(401, { "www-authenticate": "Bearer" }).end("Unauthorized");
      if (req.method !== "POST") return res.writeHead(405).end();
      seen.mcpBearers.push(bearer);
      const msg = JSON.parse(await body(req)) as { id?: number; method: string; params?: { name: string; arguments: unknown; protocolVersion?: string } };
      if (msg.id === undefined) return res.writeHead(202).end();
      const result =
        msg.method === "initialize"
          ? { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "flowform", version: "test" } }
          : msg.method === "tools/list"
            ? { tools: [{ name: "list_boards", description: "The boards you can open", inputSchema: { type: "object", properties: {} } }] }
            : msg.method === "tools/call"
              ? (seen.calls.push({ name: msg.params!.name, args: msg.params!.arguments }), { content: [{ type: "text", text: JSON.stringify([{ id: "room-1", name: "Shop floor" }]) }] })
              : {};
      return send(200, { jsonrpc: "2.0", id: msg.id, result });
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((ok) => fake.listen(0, "127.0.0.1", ok));
  origin = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  process.env.FLOWFORM_URL = origin;
});
after(() => fake.close());

const load = async () => {
  const link = await import("../src/flowformlink.ts");
  const { config } = await import("../src/config.ts");
  config.flowformUrl = origin;
  const { db, run } = await import("../src/db.ts");
  return { link, db, run };
};

/** what Flowform's approval page would do: remember the challenge, hand back a code */
function approve(url: string) {
  const u = new URL(url);
  const code = `code-${seen.codes.size + 1}-${Date.now()}`;
  seen.codes.set(code, { challenge: u.searchParams.get("code_challenge")!, scope: u.searchParams.get("scope")! });
  return { code, state: u.searchParams.get("state")!, u };
}

test("connecting asks Flowform for reading only, with PKCE, and keeps the tokens encrypted", async () => {
  const { link, db } = await load();
  assert.equal(link.linkStatus("u-ada").connected, false);

  const { url } = await link.beginLink("u-ada");
  const { code, state, u } = approve(url);
  assert.equal(u.origin + u.pathname, `${origin}/oauth/authorize`);
  assert.equal(u.searchParams.get("scope"), "search:read canvas:read", "never canvas:write or admin:write");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("redirect_uri"), "http://localhost:4410/auth/flowform/link/callback");
  assert.equal(seen.registrations.length, 1);
  assert.equal(seen.registrations[0].token_endpoint_auth_method, "none");

  // someone else's state, or none, connects nothing
  await assert.rejects(link.finishLink(code, "not-the-state"), /expired or was already used/);
  assert.equal(link.linkStatus("u-ada").connected, false);

  assert.equal(await link.finishLink(code, state), "u-ada");
  const st = link.linkStatus("u-ada");
  assert.equal(st.connected, true);
  assert.equal(st.scope, "search:read canvas:read");
  // a state is spent once
  await assert.rejects(link.finishLink(code, state), /expired or was already used/);

  // nothing Flowform issued is readable in the database, or in the key file
  const row = db.prepare("select access, refresh from flowform_links where user_id = 'u-ada'").get() as { access: string; refresh: string };
  for (const t of [...seen.access, ...seen.refresh]) {
    assert.ok(!row.access.includes(t) && !row.refresh.includes(t), "a token is stored in the clear");
  }
  assert.ok(seen.access.has(link.unseal(row.access)), "and it opens with the key");
  assert.equal(Buffer.from(readFileSync(join(dataDir, "secret.key"), "utf8"), "base64").length, 32);

  // every connection registers afresh (Flowform forgets a registration that goes unused)
  await link.beginLink("u-kai");
  assert.equal(seen.registrations.length, 2);
});

test("Flowform's tools are listed and called as the person; nobody else's link is used", async () => {
  const { link } = await load();
  const tools = await link.flowformTools("u-ada");
  assert.deepEqual(tools.map((t) => t.name), ["list_boards"]);
  const r = await link.flowformCall("u-ada", "list_boards", { limit: 5 });
  assert.equal(r.isError, false);
  assert.match(r.text, /Shop floor/);
  assert.deepEqual(seen.calls.at(-1), { name: "list_boards", args: { limit: 5 } });
  assert.ok(seen.mcpBearers.every((b) => seen.access.has(b)));

  await assert.rejects(link.flowformTools("u-kai"), /isn't connected for you/);
});

test("an access token that ran out is refreshed once, and the new pair replaces the old", async () => {
  const { link, run } = await load();
  const before = seen.n;
  run("update flowform_links set expires_at = ? where user_id = 'u-ada'", Date.now() - 1000);
  // two calls at once share one refresh (a refresh token is spent when used)
  const [a, b] = await Promise.all([link.flowformTools("u-ada"), link.flowformTools("u-ada")]);
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.equal(seen.n, before + 1, "one refresh");
  assert.equal(seen.mcpBearers.at(-1), `access-${seen.n}`);

  // Flowform stops taking the access token early (revoked there): refreshed on the 401, and the call still answers
  seen.access.delete(`access-${seen.n}`);
  assert.equal((await link.flowformTools("u-ada")).length, 1);
  assert.equal(seen.mcpBearers.at(-1), `access-${seen.n}`);
});

test("a link Flowform ended is forgotten here, and says to connect again", async () => {
  const { link } = await load();
  const { url } = await link.beginLink("u-rin");
  const { code, state } = approve(url);
  await link.finishLink(code, state);
  // Flowform revokes both of Rin's tokens
  seen.access.delete(`access-${seen.n}`);
  seen.refresh.delete(`refresh-${seen.n}`);
  await assert.rejects(link.flowformTools("u-rin"), /ended on Flowform's side/);
  assert.equal(link.linkStatus("u-rin").connected, false);
});

test("disconnecting revokes the tokens at Flowform and forgets them", async () => {
  const { link, db } = await load();
  const row = db.prepare("select access, refresh from flowform_links where user_id = 'u-ada'").get() as { access: string; refresh: string };
  const tokens = [link.unseal(row.access), link.unseal(row.refresh)];
  await link.unlink("u-ada");
  assert.equal(link.linkStatus("u-ada").connected, false);
  for (const t of tokens) assert.ok(seen.revoked.includes(t));
  assert.equal(db.prepare("select count(*) n from flowform_links where user_id = 'u-ada'").get()!.n, 0);
  await assert.rejects(link.flowformCall("u-ada", "list_boards"), /isn't connected for you/);
});
