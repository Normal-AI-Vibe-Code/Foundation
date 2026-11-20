/**
 * The built-in browser (hostbrowser.ts) is a real browser with a person's sign-ins on the server's computer, so:
 * only a person opens it (an agent's bearer, the service token and an agent session are refused), only an admin,
 * and its socket opens with nothing but the one-time key minted for that person, once. Asking starts nothing; an
 * agent's call never starts it, and does nothing without a person's leave. Addresses are http and https only.
 *
 * The last test drives the real browser found on this computer (Edge or Chrome) through the server's own upgrade
 * handler, against a small site served here; it is skipped where there is no browser.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-test-"));
// the browser keeps its profile in the work folder: a fresh one for this run, not one shared with other runs
process.env.FOUNDATION_WORK_DIR = mkdtempSync(join(tmpdir(), "foundation-test-work-"));
process.env.FOUNDATION_ADMIN_EMAILS = "boss@formindustries.com";
process.env.FOUNDATION_SERVICE_TOKEN = "s".repeat(40);

const auth = await import("../src/auth.ts");
const { handleUpgrade } = await import("../src/sockets.ts");
const hb = await import("../src/hostbrowser.ts");
const { runTool, TOOLS } = await import("../src/tools.ts");
const { setBoardRole } = await import("../src/roles.ts");
const { READ_TOOLS } = await import("../src/roles.ts");

const boss = auth.upsertUser("boss@formindustries.com", "Boss");
const ada = auth.upsertUser("ada@formindustries.com", "Ada");
assert.equal(boss.role, "admin");

const found = hb.findBrowser();

/** listen on a free port above 15000 (this machine reserves stretches of the ones below) */
async function listen(s: Server): Promise<number> {
  for (let i = 0; i < 40; i++) {
    const port = 15100 + Math.floor(Math.random() * 20000);
    const ok = await new Promise<boolean>((done) => {
      s.once("error", () => done(false));
      s.listen(port, "127.0.0.1", () => done(true));
    });
    if (ok) return (s.address() as AddressInfo).port;
  }
  throw new Error("no free port");
}

let server: Server;
let site: Server;
let base = "";
let siteUrl = "";
before(async () => {
  const wss = new WebSocketServer({ noServer: true });
  server = createServer((_req, res) => res.writeHead(404).end());
  server.on("upgrade", (req, socket, head) => handleUpgrade(wss, req, socket, head));
  base = `ws://127.0.0.1:${await listen(server)}`;
  // a small site: a page with a link, a field and a button, and the page the link goes to
  site = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (req.url?.startsWith("/second")) return res.end(`<!doctype html><title>Second page</title><h1>The second page</h1><p>You followed the link${req.url.includes("q=") ? ` and searched ${decodeURIComponent(req.url.split("q=")[1])}` : ""}.</p>`);
    res.end(
      `<!doctype html><title>First page</title><h1>A page for the test</h1><p>Some words to read.</p>` +
        `<p><a href="/second">Go to the second page</a></p>` +
        `<form action="/second"><input name="q" placeholder="Search here"><input type="password" name="pw" value="hunter2"><button>Find</button></form>` +
        `<p style="display:none">never shown</p><script>document.title = "First page"</script>`,
    );
  });
  siteUrl = `http://127.0.0.1:${await listen(site)}`;
});
after(async () => {
  await hb.stopHostBrowser();
  server?.close();
  site?.close();
  // sockets a failed test left open must not keep the run alive
  server?.closeAllConnections();
  site?.closeAllConnections();
});

/** a JPEG's width and height, from its frame header */
function jpegSize(b: Buffer): [number, number] {
  for (let i = 2; i + 9 < b.length; ) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const mark = b[i + 1];
    if (mark >= 0xc0 && mark <= 0xcf && mark !== 0xc4 && mark !== 0xc8 && mark !== 0xcc) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
    i += 2 + b.readUInt16BE(i + 2);
  }
  return [0, 0];
}

type FakeReq = Parameters<typeof hb.requestHostBrowser>[0];
const reqWith = (headers: Record<string, string>) => ({ headers, url: "/api/host-browser", query: new URLSearchParams(), params: {} }) as unknown as FakeReq;
const cookieOf = (userId: string) => reqWith({ cookie: `foundation_session=${auth.createSession(userId)}` });
const statusOf = (fn: () => unknown) => {
  try {
    fn();
    return 200;
  } catch (e) {
    return (e as { status?: number }).status ?? 500;
  }
};

function open(path: string, headers: Record<string, string> = {}): Promise<{ ws?: WebSocket; status?: number }> {
  return new Promise((done) => {
    const ws = new WebSocket(base + path, { headers });
    ws.once("open", () => done({ ws }));
    ws.once("unexpected-response", (_req, res) => done({ status: res.statusCode }));
    ws.once("error", () => done({ status: -1 }));
  });
}

/** run with FOUNDATION_BROWSER set (or unset), then put it back */
function withBrowserEnv<T>(value: string | undefined, fn: () => T): T {
  const was = process.env.FOUNDATION_BROWSER;
  if (value === undefined) delete process.env.FOUNDATION_BROWSER;
  else process.env.FOUNDATION_BROWSER = value;
  try {
    return fn();
  } finally {
    if (was === undefined) delete process.env.FOUNDATION_BROWSER;
    else process.env.FOUNDATION_BROWSER = was;
  }
}

test("only a person who is an admin gets the browser, and asking starts nothing", () => {
  // any program that exists stands in for a browser here: asking never runs it
  withBrowserEnv(found?.path ?? process.execPath, () => {
    assert.equal(statusOf(() => hb.requestHostBrowser(cookieOf(boss.id))), 200);
    // a member, in their browser
    assert.equal(statusOf(() => hb.requestHostBrowser(cookieOf(ada.id))), 403);
    // the service token (agents, MCP) is never a person
    assert.equal(statusOf(() => hb.requestHostBrowser(reqWith({ authorization: `Bearer ${"s".repeat(40)}` }))), 403);
    // an agent's session, even the admin's own
    const agentSession = auth.createSession(boss.id, 60_000, "agent");
    assert.equal(statusOf(() => hb.requestHostBrowser(reqWith({ authorization: `Bearer ${agentSession}` }))), 403);
    // nobody signed in
    assert.equal(statusOf(() => hb.requestHostBrowser(reqWith({}))), 401);
  });
  assert.equal(hb.hostBrowserRunning(), false);
});

test("no browser on the computer: the ask fails with a sentence that says what was looked for", () => {
  assert.equal(hb.findBrowser({}, () => false, "win32"), null);
  assert.equal(hb.findBrowser({}, () => false, "darwin"), null);
  assert.equal(hb.findBrowser({}, () => false, "linux"), null);
  // FOUNDATION_BROWSER comes first, and a path that isn't there is not quietly passed over
  assert.deepEqual(hb.findBrowser({ FOUNDATION_BROWSER: "/opt/x/chrome" }, (p) => p === "/opt/x/chrome", "linux"), { path: "/opt/x/chrome", name: "Google Chrome" });
  assert.equal(hb.findBrowser({ FOUNDATION_BROWSER: "/nowhere/chrome" }, (p) => p !== "/nowhere/chrome", "linux"), null);
  assert.equal(hb.findBrowser({ ProgramFiles: "C:\\Program Files" }, (p) => /Edge.Application.msedge\.exe$/.test(p), "win32")?.name, "Microsoft Edge");
  assert.equal(hb.findBrowser({}, (p) => p === "/usr/bin/chromium", "linux")?.name, "Chromium");
  assert.match(hb.findBrowser({}, (p) => p.includes("Google Chrome.app"), "darwin")?.path ?? "", /Contents\/MacOS\/Google Chrome$/);
  assert.match(hb.noBrowserSentence({}), /Microsoft Edge, Google Chrome and Chromium.*FOUNDATION_BROWSER/);
  assert.match(hb.noBrowserSentence({ FOUNDATION_BROWSER: "/nowhere/chrome" }), /FOUNDATION_BROWSER points at \/nowhere\/chrome, which isn't there/);

  const missing = join(tmpdir(), "no-such-browser-here.exe");
  assert.equal(existsSync(missing), false);
  withBrowserEnv(missing, () => {
    let said = "";
    let status = 0;
    try {
      hb.requestHostBrowser(cookieOf(boss.id));
    } catch (e) {
      said = (e as Error).message;
      status = (e as { status?: number }).status ?? 0;
    }
    assert.equal(status, 503);
    assert.match(said, /FOUNDATION_BROWSER points at/);
  });
});

test("the key opens its socket once; nothing else opens it", async () => {
  // spent by the person it was minted for, once
  const a = hb.openHostBrowser(boss);
  assert.equal(a.expiresIn, 30);
  assert.equal(hb.spendHostBrowserKey(a.id, a.key)?.id, boss.id);
  assert.equal(hb.spendHostBrowserKey(a.id, a.key), null, "and only once");
  // a wrong key spends the id: the right one no longer works on it either
  const b = hb.openHostBrowser(boss);
  assert.equal(hb.spendHostBrowserKey(b.id, "nope"), null);
  assert.equal(hb.spendHostBrowserKey(b.id, b.key), null);
  // no key at all
  const c = hb.openHostBrowser(boss);
  assert.equal(hb.spendHostBrowserKey(c.id, null), null);
  // an expired key
  const d = hb.openHostBrowser(boss);
  const realNow = Date.now;
  Date.now = () => realNow() + 31_000;
  try {
    assert.equal(hb.spendHostBrowserKey(d.id, d.key), null);
  } finally {
    Date.now = realNow;
  }

  // at the server's own upgrade handler: no key, a wrong key, or the admin's own cookie instead of the key
  const e = hb.openHostBrowser(boss);
  assert.equal((await open(`/host/browser/${e.id}`)).status, 401);
  const f = hb.openHostBrowser(boss);
  assert.equal((await open(`/host/browser/${f.id}?key=nope`)).status, 401);
  assert.equal((await open(`/host/browser/${f.id}?key=${f.key}`)).status, 401);
  const g = hb.openHostBrowser(boss);
  assert.equal((await open(`/host/browser/${g.id}`, { cookie: `foundation_session=${auth.createSession(boss.id)}` })).status, 401);
  assert.equal((await open(`/host/browser/nosuchid1234?key=${g.key}`)).status, 401);
  // none of that started a browser
  assert.equal(hb.hostBrowserRunning(), false);
});

test("the address: http and https only, words become a search, the rest is refused by name", () => {
  const url = (raw: string) => {
    const a = hb.browserAddress(raw);
    return "url" in a ? a.url : `refused: ${a.refused}`;
  };
  assert.equal(url("https://example.com/a?b=c"), "https://example.com/a?b=c");
  assert.equal(url("  http://example.com  "), "http://example.com/");
  assert.equal(url("example.com"), "https://example.com/");
  assert.equal(url("docs.anthropic.com/en/home"), "https://docs.anthropic.com/en/home");
  assert.equal(url("example.com:8080/x"), "https://example.com:8080/x");
  assert.equal(url("localhost:1430/#/design"), "http://localhost:1430/#/design");
  assert.equal(url("localhost"), "http://localhost/");
  assert.equal(url("127.0.0.1:15999/x"), "http://127.0.0.1:15999/x");
  assert.equal(url("[::1]:15999"), "http://[::1]:15999/");
  assert.equal(url("192.168.1.20:3000"), "http://192.168.1.20:3000/");
  assert.equal(url("about:blank"), "about:blank");
  assert.equal(url("how do rim-driven fans work"), "https://duckduckgo.com/?q=how%20do%20rim-driven%20fans%20work");
  assert.equal(url("fans"), "https://duckduckgo.com/?q=fans");
  assert.equal(url("note: buy milk"), "https://duckduckgo.com/?q=note%3A%20buy%20milk");
  for (const bad of [
    "file:///C:/Windows/win.ini",
    "file:/etc/passwd",
    "FILE:///etc/passwd",
    "chrome://settings",
    "chrome:version",
    "edge://flags",
    "devtools://devtools/bundled/inspector.html",
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "blob:https://example.com/1",
    "view-source:https://example.com",
    "about:config",
    "ftp://example.com/x",
    "ws://example.com",
    "chrome-extension://abc/page.html",
    "",
    "   ",
  ]) {
    const a = hb.browserAddress(bad);
    assert.ok("refused" in a, `${bad} is refused`);
    assert.ok(a.refused.length > 10);
  }
  // whatever comes out is http, https or about:blank, never anything else
  for (const raw of ["x", "a b", "a:b", "//example.com", "\\\\server\\share", "C:\\Windows\\win.ini", "..%2f", "http:example.com", "https:/example.com", "exa mple.com", "user:pw@example.com"]) {
    const a = hb.browserAddress(raw);
    if ("url" in a) assert.match(a.url, /^(https?:\/\/|about:blank$)/, raw);
  }
});

test("agents: nothing without a person's leave, the browser is never started by a call, and viewers' agents can't", async () => {
  const ctx = { boardId: "company", actor: "Boss's agent", userId: boss.id };
  for (const [name, input] of [
    ["browser_read", {}],
    ["browser_navigate", { url: "https://example.com" }],
    ["browser_click", { ref: "ref_1" }],
    ["browser_type", { ref: "ref_1", text: "x", submit: true }],
    ["browser_tabs", { open: "https://example.com" }],
  ] as const) {
    assert.ok(TOOLS.find((t) => t.name === name), name);
    assert.equal(READ_TOOLS.has(name), false, `${name} is not a viewer's`);
    const out = await runTool(ctx, name, input);
    assert.equal(out, hb.NO_LEAVE, name);
    assert.match(String(out), /A person \(an admin\) must open the Browser tool/);
  }
  assert.equal(hb.agentsMayBrowse(), false);
  assert.equal(hb.hostBrowserRunning(), false, "an agent's call starts nothing");
  // a viewer's agent is refused before the tool runs
  setBoardRole(boss, "hbv", ada.id, "viewer");
  await assert.rejects(() => runTool({ boardId: "hbv", actor: "Ada's agent", userId: ada.id }, "browser_read", {}), /View only/);
  await assert.rejects(() => runTool({ boardId: "hbv", actor: "Ada's agent", userId: ada.id }, "browser_navigate", { url: "https://example.com" }), /View only/);
});

test("the real browser: a person opens it, sees the page, lets an agent read it and follow a link; closing ends it", { skip: found ? false : "no Edge, Chrome or Chromium on this computer", timeout: 120_000 }, async () => {
  const k = withBrowserEnv(found!.path, () => hb.requestHostBrowser(cookieOf(boss.id)));
  assert.equal(k.running, false);
  const { ws } = await open(`/host/browser/${k.id}?key=${encodeURIComponent(k.key)}`);
  assert.ok(ws, "the key opens the socket");
  try {
    assert.equal((await open(`/host/browser/${k.id}?key=${encodeURIComponent(k.key)}`)).status, 401, "and only once");
    const got: Array<Record<string, any>> = [];
    const frames: Buffer[] = [];
    ws.on("message", (raw, binary) => (binary ? frames.push(raw as Buffer) : got.push(JSON.parse(String(raw)))));
    const say = (m: unknown) => ws.send(JSON.stringify(m));
    const until = async (ok: () => boolean, what: string, ms = 90_000) => {
      const t0 = Date.now();
      while (!ok()) {
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}; got ${JSON.stringify(got.slice(-4)).slice(0, 1200)}`);
        await new Promise((r) => setTimeout(r, 40));
      }
    };
    const tabs = () => got.filter((m) => m.t === "tabs").at(-1);
    const current = () => tabs()?.tabs.find((t: { id: string }) => t.id === tabs()?.at);

    await until(() => got.some((m) => m.t === "hello"), "hello");
    assert.equal(got.find((m) => m.t === "hello")?.agents, false);
    assert.equal(hb.hostBrowserRunning(), true);
    assert.equal(hb.hostBrowserViewers(), 1);
    await until(() => Boolean(tabs()?.at), "a tab");

    // the page's box, then an address: the page comes back as pictures of that size
    say({ t: "size", w: 800, h: 600, dpr: 1 });
    say({ t: "nav", url: `${siteUrl}/` });
    await until(() => current()?.url === `${siteUrl}/` && current()?.loading === false && current()?.title === "First page", "the first page");
    await until(() => frames.length > 0 && got.some((m) => m.t === "view" && m.w === 800 && m.h === 600), "a frame at 800×600");
    const jpeg = frames.at(-1)!;
    assert.equal(jpeg[0], 0xff);
    assert.equal(jpeg[1], 0xd8, "a frame is a JPEG");

    // a refused address is said, and goes nowhere
    say({ t: "nav", url: "file:///C:/Windows/win.ini" });
    await until(() => got.some((m) => m.t === "note" && m.bad && /http and https pages only/.test(m.text)), "the refusal");
    assert.equal(current()?.url, `${siteUrl}/`);

    // an agent, before the person says so: nothing
    const ctx = { boardId: "company", actor: "Boss's agent", userId: boss.id };
    assert.equal(await runTool(ctx, "browser_read", {}), hb.NO_LEAVE);

    // the person lets agents use it
    say({ t: "agents", allow: true });
    await until(() => got.some((m) => m.t === "agents" && m.allow === true && m.by === "Boss"), "the leave");
    assert.equal(hb.agentsMayBrowse(), true);

    const page = (await runTool(ctx, "browser_read", {})) as { url: string; title: string; text: string };
    assert.equal(page.url, `${siteUrl}/`);
    assert.equal(page.title, "First page");
    assert.match(page.text, /^# A page for the test$/m);
    assert.match(page.text, /Some words to read\./);
    assert.doesNotMatch(page.text, /never shown/);
    assert.doesNotMatch(page.text, /hunter2/, "a password field's value is not read out");
    const link = /\[(ref_\d+)\] link "Go to the second page" \(([^)]+)\)/.exec(page.text);
    assert.ok(link, page.text);
    assert.equal(link[2], `${siteUrl}/second`);
    const field = /\[(ref_\d+)\] input text name="q" label="Search here"/.exec(page.text);
    assert.ok(field, page.text);
    assert.match(page.text, /\[ref_\d+\] button "Find"/);
    // the person is shown what the agent did
    assert.ok(got.some((m) => m.t === "agent" && m.who === "Boss's agent" && /read/.test(m.did)));

    // by ref: press the link, and the browser is on the second page
    const pressed = (await runTool(ctx, "browser_click", { ref: link[1] })) as { url: string; title: string };
    assert.equal(pressed.url, `${siteUrl}/second`);
    assert.equal(pressed.title, "Second page");
    await until(() => current()?.url === `${siteUrl}/second` && current()?.canBack === true, "the person's tab following");
    assert.match(((await runTool(ctx, "browser_read", {})) as { text: string }).text, /You followed the link\./);
    // the first page's refs went with it
    await assert.rejects(() => runTool(ctx, "browser_type", { ref: field[1], text: "x" }), /isn't on the page any more|doesn't take typing/);

    // back (the person's press), then the agent fills the field and submits
    say({ t: "back" });
    await until(() => current()?.url === `${siteUrl}/` && current()?.canForward === true && current()?.loading === false, "back");
    const again = (await runTool(ctx, "browser_read", {})) as { text: string };
    const field2 = /\[(ref_\d+)\] input text name="q"/.exec(again.text);
    assert.ok(field2);
    const typed = (await runTool(ctx, "browser_type", { ref: field2[1], text: "rim fans", submit: true })) as { url: string };
    assert.match(typed.url, /\/second\?q=rim(\+|%20)fans/);

    // agents may not open what the person may not
    await assert.rejects(() => runTool(ctx, "browser_navigate", { url: "file:///etc/passwd" }), /http and https pages only/);
    await assert.rejects(() => runTool(ctx, "browser_navigate", { url: "javascript:alert(1)" }), /http and https pages only/);

    // tabs: the agent opens one and is on it; the person's view stays
    const mine = current()?.id;
    const t = (await runTool(ctx, "browser_tabs", { open: `${siteUrl}/second` })) as { current: string; tabs: Array<{ id: string; url: string }> };
    assert.equal(t.tabs.length, 2);
    assert.notEqual(t.current, mine);
    assert.equal(t.tabs.find((x) => x.id === t.current)?.url, `${siteUrl}/second`);
    await until(() => tabs()?.tabs.length === 2, "the second tab");
    assert.equal(tabs()?.at, mine);

    // the leave, taken back
    say({ t: "agents", allow: false });
    await until(() => got.some((m) => m.t === "agents" && m.allow === false), "the leave taken back");
    assert.equal(await runTool(ctx, "browser_read", {}), hb.NO_LEAVE);

    // the person's own hands: close the agent's tab, press the link on the first page with the pointer
    say({ t: "tab.close", tab: t.current });
    await until(() => tabs()?.tabs.length === 1, "one tab again");
    say({ t: "nav", url: `${siteUrl}/` });
    await until(() => current()?.url === `${siteUrl}/` && current()?.loading === false, "the first page again");
    const where = (await hb._evaluateForTest(`(() => { const r = document.querySelector("a").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`)) as { x: number; y: number };
    say({ t: "mouse", kind: "move", x: where.x, y: where.y, button: 0, buttons: 0, clicks: 0, mods: 0 });
    say({ t: "mouse", kind: "down", x: where.x, y: where.y, button: 0, buttons: 1, clicks: 1, mods: 0 });
    say({ t: "mouse", kind: "up", x: where.x, y: where.y, button: 0, buttons: 0, clicks: 1, mods: 0 });
    await until(() => current()?.url === `${siteUrl}/second`, "the pointer's press following the link");

    // a page's confirm() waits for the person; their answer reaches the page
    void hb._evaluateForTest(`setTimeout(() => { document.title = confirm("Sure?") ? "yes" : "no"; }, 0)`);
    await until(() => got.some((m) => m.t === "dialog" && m.kind === "confirm" && m.message === "Sure?"), "the dialog");
    say({ t: "dialog", accept: true });
    await until(() => current()?.title === "yes", "the answer reaching the page");

    // keys reach the page: type into the field
    say({ t: "nav", url: `${siteUrl}/` });
    await until(() => current()?.url === `${siteUrl}/` && current()?.loading === false, "the first page, once more");
    await hb._evaluateForTest(`document.querySelector("input[name=q]").focus()`);
    for (const ch of "hi") {
      say({ t: "key", kind: "down", key: ch, code: `Key${ch.toUpperCase()}`, vk: ch.toUpperCase().charCodeAt(0), text: ch, mods: 0 });
      say({ t: "key", kind: "up", key: ch, code: `Key${ch.toUpperCase()}`, vk: ch.toUpperCase().charCodeAt(0), mods: 0 });
    }
    say({ t: "paste", text: " there" });
    const t0 = Date.now();
    let value = "";
    while (value !== "hi there" && Date.now() - t0 < 10_000) value = String(await hb._evaluateForTest(`document.querySelector("input[name=q]").value`));
    assert.equal(value, "hi there");

    // a dense screen (2×): the moving pictures stay one image pixel per CSS pixel, and a still page gets a sharp one
    say({ t: "nav", url: `${siteUrl}/` });
    await until(() => current()?.url === `${siteUrl}/` && current()?.loading === false, "the first page, for the dense screen");
    frames.length = 0;
    say({ t: "size", w: 640, h: 480, dpr: 2 });
    await until(() => frames.some((f) => jpegSize(f).join("x") === "1280x960"), "a sharp frame at 1280×960", 15_000);
    assert.equal(got.filter((m) => m.t === "view").at(-1)?.w, 640, "its size is still told in CSS pixels");
    // the pointer still lands where it is put, on a 2× page, with sharp pictures being taken around it
    const at2 = (await hb._evaluateForTest(`(() => { const r = document.querySelector("a").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`)) as { x: number; y: number };
    say({ t: "mouse", kind: "move", x: at2.x, y: at2.y, button: 0, buttons: 0, clicks: 0, mods: 0 });
    await new Promise((r) => setTimeout(r, 150)); // about when the sharp picture after that move is being taken
    say({ t: "mouse", kind: "down", x: at2.x, y: at2.y, button: 0, buttons: 1, clicks: 1, mods: 0 });
    say({ t: "mouse", kind: "up", x: at2.x, y: at2.y, button: 0, buttons: 0, clicks: 1, mods: 0 });
    await until(() => current()?.url === `${siteUrl}/second`, "the press landing on the link at 2×");
    // and a still page stops sending: no run of pictures chasing each other
    // (a sharp picture can take over a second on a busy computer: wait for the pictures to stop, then see they stay stopped)
    let settled = -1;
    for (const t0 = Date.now(); settled !== frames.length && Date.now() - t0 < 12_000; ) {
      settled = frames.length;
      await new Promise((r) => setTimeout(r, 1500));
    }
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(frames.length, settled, "a still page sends nothing more");
  } finally {
    // closing the last socket stops the browser's process
    ws.close();
    const t0 = Date.now();
    while (hb.hostBrowserRunning() && Date.now() - t0 < 15_000) await new Promise((r) => setTimeout(r, 50));
    assert.equal(hb.hostBrowserRunning(), false);
    await hb.stopHostBrowser();
    assert.equal(hb._browserProcessAlive(), false, "the browser's process has gone");
  }
});
