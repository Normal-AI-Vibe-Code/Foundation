/**
 * A machine's web port shared (2026-11-17): what the relay sends the machine's app, how it points redirects and
 * HTML back under its prefix, Docker Hub's answers as the picker wants them, and cloudflared's link.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { relayHeaders, relayHtml, relayLocation, tunnelUrl, PORT_PATH } from "../src/machineshare.ts";
import { hubPath, hubRepo } from "../src/machinehub.ts";

test("the machine's app never sees Foundation's session, and knows its prefix", () => {
  const h = relayHeaders({ cookie: "fdn_session=secret", authorization: "Bearer x", accept: "text/html", connection: "keep-alive", "accept-encoding": "gzip" }, 49153, "/m/b/p/8080");
  assert.equal(h.cookie, undefined);
  assert.equal(h.authorization, undefined);
  assert.equal(h.connection, undefined);
  assert.equal(h.host, "127.0.0.1:49153");
  assert.equal(h["accept-encoding"], "identity");
  assert.equal(h["x-forwarded-prefix"], "/m/b/p/8080");
  assert.equal(h.accept, "text/html");
});

test("redirects and root-relative links stay under the prefix", () => {
  const p = "/m/b/p/8080";
  assert.equal(relayLocation("/login", 49153, p), `${p}/login`);
  assert.equal(relayLocation("http://127.0.0.1:49153/x?y=1", 49153, p), `${p}/x?y=1`);
  assert.equal(relayLocation("http://localhost:49153", 49153, p), `${p}/`);
  assert.equal(relayLocation(`${p}/already`, 49153, p), `${p}/already`);
  assert.equal(relayLocation("https://example.com/out", 49153, p), "https://example.com/out");
  assert.equal(relayLocation("//cdn.example.com/a.js", 49153, p), "//cdn.example.com/a.js");
  assert.equal(relayLocation("relative/path", 49153, p), "relative/path");
  assert.equal(
    relayHtml(`<link href="/a.css"><script src='/b.js'></script><form action="/go"><a href="//cdn.x/y">x</a><a href="c">c</a><img src="https://x/y.png">`, p),
    `<link href="${p}/a.css"><script src='${p}/b.js'></script><form action="${p}/go"><a href="//cdn.x/y">x</a><a href="c">c</a><img src="https://x/y.png">`,
  );
});

test("the relay's addresses: /m/<board>/<card>/<port>/…", () => {
  assert.deepEqual(PORT_PATH.exec("/m/company/pnl_1/8080/static/a.js")?.slice(1), ["company", "pnl_1", "8080", "/static/a.js"]);
  assert.deepEqual(PORT_PATH.exec("/m/company/pnl_1/8080")?.slice(1), ["company", "pnl_1", "8080", undefined]);
  assert.equal(PORT_PATH.exec("/machine.html"), null);
  assert.equal(PORT_PATH.exec("/m/company/pnl_1/notaport/"), null);
});

test("cloudflared's link, read from its own lines", () => {
  const said = "2026-11-17T07:00:00Z INF |  https://dense-river-cat-bloom.trycloudflare.com                                          |\n";
  assert.equal(tunnelUrl(said), "https://dense-river-cat-bloom.trycloudflare.com");
  assert.equal(tunnelUrl("INF Requesting new quick Tunnel on trycloudflare.com..."), null);
});

test("Docker Hub's answers as the picker wants them", () => {
  assert.deepEqual(hubRepo({ repo_name: "library/postgres", short_description: " The PostgreSQL object-relational database system ", star_count: 14000, pull_count: 1e9, is_official: true }), { name: "postgres", description: "The PostgreSQL object-relational database system", stars: 14000, pulls: 1e9, official: true });
  assert.equal(hubRepo({ repo_name: "grafana/grafana", is_official: false }).official, false);
  assert.equal(hubRepo({ repo_name: "nginx" }).official, true, "a name without a namespace is an official image");
  assert.equal(hubPath("postgres"), "library/postgres");
  assert.equal(hubPath("Grafana/Grafana"), "grafana/grafana");
  assert.equal(hubPath("ghcr.io/x/y"), null, "another registry isn't Docker Hub's");
  assert.equal(hubPath("../etc"), null);
});

test("a stand-in Docker Hub answers through the server's code", async () => {
  const hub = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/v2/search/repositories/")) return res.end(JSON.stringify({ results: [{ repo_name: "library/redis", short_description: "Redis", star_count: 1, pull_count: 2, is_official: true }] }));
    if (req.url?.startsWith("/v2/repositories/library/redis/tags")) return res.end(JSON.stringify({ results: [{ name: "7.4", full_size: 40e6, images: [{ size: 41e6 }] }, { name: "latest", full_size: 39e6 }] }));
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((ok) => hub.listen(0, "127.0.0.1", ok));
  const port = (hub.address() as { port: number }).port;
  process.env.FOUNDATION_DOCKER_HUB = `http://127.0.0.1:${port}`;
  const { hubSearch, hubTags } = await import(`../src/machinehub.ts?standin=${port}`);
  try {
    assert.deepEqual(await hubSearch("redis"), [{ name: "redis", description: "Redis", stars: 1, pulls: 2, official: true }]);
    assert.deepEqual(
      (await hubTags("redis")).map((t: { name: string; size: number }) => [t.name, t.size]),
      // latest leads, then the newest
      [
        ["latest", 39e6],
        ["7.4", 41e6],
      ],
    );
    await assert.rejects(hubTags("nope/nothing"), /no such repository/);
    assert.deepEqual(await hubSearch("   "), []);
  } finally {
    hub.close();
    delete process.env.FOUNDATION_DOCKER_HUB;
  }
});
