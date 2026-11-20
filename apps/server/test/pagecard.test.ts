/**
 * Page cards (2026-11-19): an app on HyperForm is a card whose page is a tab of the built-in browser, with a
 * picture kept of it for the far view.
 *
 *  - the company's apps are linked where HyperForm hosts them, and marked as behind its sign-in;
 *  - a card's ask is checked (ids, an http/https address), the key it mints is for that card, once;
 *  - the picture store keeps JPEGs only, by board and card, and no path leaves its folder;
 *  - in the real browser found on this computer: each card gets a tab of its own, a card's socket never turns to
 *    another card's tab, the page is kept as the card's picture while someone looks, and an agent with the
 *    person's leave reads a card's page. Skipped where there is no browser.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";

const dataDir = mkdtempSync(join(tmpdir(), "foundation-test-"));
process.env.FOUNDATION_DATA_DIR = dataDir;
process.env.FOUNDATION_WORK_DIR = mkdtempSync(join(tmpdir(), "foundation-test-work-"));
process.env.FOUNDATION_ADMIN_EMAILS = "boss@formindustries.com";
for (const k of ["HYPERFORM_URL", "PARTFORM_URL", "BOMFORM_URL", "DEPLOYFORM_URL", "FACTORYFORM_APP_URL"]) delete process.env[k];

const auth = await import("../src/auth.ts");
const { handleUpgrade } = await import("../src/sockets.ts");
const hb = await import("../src/hostbrowser.ts");
const pics = await import("../src/pagepictures.ts");
const { companyApps } = await import("../src/today.ts");
const { runTool } = await import("../src/tools.ts");
const { COMPANY_APPS, onHyperForm } = await import("@foundation/protocol");

const boss = auth.upsertUser("boss@formindustries.com", "Boss");
const found = hb.findBrowser();

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
  site = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    const name = req.url?.startsWith("/customers") ? "Customers" : "Parts";
    res.end(`<!doctype html><title>${name}</title><body style="background:#${name === "Parts" ? "cde" : "edc"}"><h1>${name}</h1><p>The ${name.toLowerCase()} page.</p>`);
  });
  siteUrl = `http://127.0.0.1:${await listen(site)}`;
});
after(async () => {
  await hb.stopHostBrowser();
  server?.close();
  site?.close();
});

type FakeReq = Parameters<typeof hb.requestHostBrowser>[0];
const cookieOf = (userId: string) => ({ headers: { cookie: `foundation_session=${auth.createSession(userId)}` }, url: "/api/host-browser", query: new URLSearchParams(), params: {} }) as unknown as FakeReq;

function open(path: string): Promise<{ ws?: WebSocket; status?: number }> {
  return new Promise((done) => {
    const ws = new WebSocket(base + path);
    ws.once("open", () => done({ ws }));
    ws.once("unexpected-response", (_req, res) => done({ status: res.statusCode }));
    ws.once("error", () => done({ status: -1 }));
  });
}

test("the company's apps: the four on HyperForm are linked where they are hosted, and say whose sign-in they are behind", () => {
  const apps = new Map(companyApps().map((a) => [a.id, a]));
  assert.equal(apps.get("hyperform")?.url, "https://dock.apps.normallab.co/");
  assert.equal(apps.get("partform")?.url, "https://partform.apps.normallab.co/");
  assert.equal(apps.get("deployform")?.url, "https://deployform.apps.normallab.co/");
  // the hosted app, not the local connector's API address
  assert.equal(apps.get("factoryform")?.url, "https://factory-form-factoryform.apps.normallab.co/");
  for (const id of ["hyperform", "partform", "deployform", "factoryform"]) {
    assert.equal(apps.get(id)?.signIn, "hyperform", id);
    assert.ok(onHyperForm(apps.get(id)?.url), id);
  }
  // PartForm still shows BomForm's connector state, and an app with no address is still "not linked"
  assert.equal(apps.get("partform")?.connector, "bomform");
  assert.equal(apps.get("fleetform")?.url, null);
  assert.equal(apps.get("vision")?.signIn, undefined);
  // they lead the list, in the order people reach for them
  assert.deepEqual(COMPANY_APPS.slice(0, 4).map((a) => a.id), ["hyperform", "partform", "deployform", "factoryform"]);

  // an address set on this machine wins, the newer name first
  process.env.BOMFORM_URL = "http://localhost:9001/";
  assert.equal(companyApps().find((a) => a.id === "partform")?.url, "http://localhost:9001/");
  process.env.PARTFORM_URL = "http://localhost:9002/";
  assert.equal(companyApps().find((a) => a.id === "partform")?.url, "http://localhost:9002/");
  delete process.env.BOMFORM_URL;
  delete process.env.PARTFORM_URL;

  assert.equal(onHyperForm("https://anything.apps.normallab.co/x"), true);
  assert.equal(onHyperForm("http://dock.apps.normallab.co/"), false, "not without https");
  assert.equal(onHyperForm("https://apps.normallab.co.evil.example/"), false);
  assert.equal(onHyperForm("https://evil.example/?x=.apps.normallab.co"), false);
  assert.equal(onHyperForm(null), false);
});

test("a card's ask: its board, its card and an http or https address; the key is that card's, once", () => {
  assert.equal(hb.cardPageOf({}), undefined, "the Browser tool's own ask names no card");
  assert.equal(hb.cardPageOf(null), undefined);
  assert.deepEqual(hb.cardPageOf({ board: "company", card: "pnl_1_abcde", url: "partform.apps.normallab.co" }), { board: "company", card: "pnl_1_abcde", url: "https://partform.apps.normallab.co/" });
  for (const bad of [
    { board: "company", card: "pnl_1", url: "file:///C:/Windows/win.ini" },
    { board: "company", card: "pnl_1", url: "javascript:alert(1)" },
    { board: "company", card: "pnl_1", url: "about:blank" },
    { board: "company", card: "pnl_1" },
    { board: "../..", card: "pnl_1", url: "https://example.com" },
    { board: "company", card: "a/b", url: "https://example.com" },
    { board: "company", url: "https://example.com" },
    { card: "pnl_1", url: "https://example.com" },
    { board: 7, card: "pnl_1", url: "https://example.com" },
  ])
    assert.throws(() => hb.cardPageOf(bad as never), (e: { status?: number }) => e.status === 400, JSON.stringify(bad));

  const page = hb.cardPageOf({ board: "company", card: "pnl_1_abcde", url: "https://example.com/" })!;
  const k = hb.openHostBrowser(boss, page);
  assert.deepEqual(hb.spendHostBrowser(k.id, k.key), { user: boss, page });
  assert.equal(hb.spendHostBrowser(k.id, k.key), null, "and only once");
  const plain = hb.openHostBrowser(boss);
  assert.equal(hb.spendHostBrowser(plain.id, plain.key)?.page, undefined);
  assert.equal(hb.hostBrowserRunning(), false, "asking starts nothing");
});

test("the picture store keeps JPEGs by board and card, and nothing leaves its folder", () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
  assert.equal(pics.readPagePicture({ board: "company", card: "pnl_9" }), null);
  const at = pics.savePagePicture({ board: "company", card: "pnl_9" }, jpeg);
  assert.ok(at && Math.abs(at - Date.now()) < 60_000);
  assert.deepEqual(pics.readPagePicture({ board: "company", card: "pnl_9" })?.jpeg, jpeg);
  // replaced, not piled up
  const next = Buffer.concat([jpeg, Buffer.from([1])]);
  pics.savePagePicture({ board: "company", card: "pnl_9" }, next);
  assert.deepEqual(pics.readPagePicture({ board: "company", card: "pnl_9" })?.jpeg, next);
  assert.deepEqual(readdirSync(join(dataDir, "pages", "company")), ["pnl_9.jpg"]);
  // not a JPEG, too large, or ids that aren't ids
  assert.equal(pics.savePagePicture({ board: "company", card: "pnl_8" }, Buffer.from("<html>")), null);
  assert.equal(pics.savePagePicture({ board: "company", card: "pnl_8" }, Buffer.concat([jpeg, Buffer.alloc(pics.PICTURE_MAX)])), null);
  for (const [board, card] of [["..", "x"], ["company", "../../x"], ["a/b", "x"], ["company", "x.jpg"], ["", "x"], ["company", "C:\\x"]]) {
    assert.equal(pics.savePagePicture({ board, card }, jpeg), null, `${board} ${card}`);
    assert.equal(pics.readPagePicture({ board, card }), null, `${board} ${card}`);
  }
  assert.equal(existsSync(join(dataDir, "x.jpg")), false);
  pics.dropPagePicture({ board: "company", card: "pnl_9" });
  assert.equal(pics.readPagePicture({ board: "company", card: "pnl_9" }), null);
});

test("the real browser: each card has its own tab, keeps to it, has its picture kept, and an agent with leave reads it", { skip: found ? false : "no Edge, Chrome or Chromium on this computer", timeout: 120_000 }, async () => {
  const socks: WebSocket[] = [];
  const attach = async (page?: { board: string; card: string; url: string }) => {
    const k = hb.requestHostBrowser(cookieOf(boss.id), page ? hb.cardPageOf(page) : undefined);
    const { ws } = await open(`/host/browser/${k.id}?key=${encodeURIComponent(k.key)}`);
    assert.ok(ws, "the key opens the socket");
    socks.push(ws);
    const got: Array<Record<string, any>> = [];
    const frames: Buffer[] = [];
    ws.on("message", (raw, binary) => (binary ? frames.push(raw as Buffer) : got.push(JSON.parse(String(raw)))));
    const tabs = () => got.filter((m) => m.t === "tabs").at(-1);
    return { ws, got, frames, tabs, say: (m: unknown) => ws.send(JSON.stringify(m)), current: () => tabs()?.tabs.find((t: { id: string }) => t.id === tabs()?.at) };
  };
  const until = async (ok: () => boolean, what: string, ms = 30_000) => {
    const t0 = Date.now();
    while (!ok()) {
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 40));
    }
  };
  try {
    // the first card: the browser starts, and the card's tab is at the card's address
    const parts = await attach({ board: "company", card: "pnl_parts", url: `${siteUrl}/` });
    await until(() => parts.got.some((m) => m.t === "hello"), "hello");
    parts.say({ t: "size", w: 640, h: 400, dpr: 1 });
    await until(() => parts.current()?.url === `${siteUrl}/` && parts.current()?.title === "Parts" && parts.current()?.loading === false, "the Parts page in the card's tab");
    assert.equal(parts.current()?.card, "pnl_parts");
    // it took the browser's one empty tab rather than leave it lying about
    assert.equal(parts.tabs()?.tabs.length, 1);
    await until(() => parts.frames.length > 0, "a picture of it");

    // the page as it drew is kept as the card's picture, and the socket is told
    await until(() => parts.got.some((m) => m.t === "seen"), "the picture being kept", 15_000);
    const kept = pics.readPagePicture({ board: "company", card: "pnl_parts" });
    assert.ok(kept && kept.jpeg[0] === 0xff && kept.jpeg[1] === 0xd8, "a JPEG is kept for the card");
    assert.equal(parts.got.findLast((m) => m.t === "seen")?.at, kept.at);

    // a second card: a tab of its own, at its own address; the first card's socket stays where it was
    const customers = await attach({ board: "company", card: "pnl_customers", url: `${siteUrl}/customers` });
    await until(() => customers.current()?.title === "Customers" && customers.current()?.loading === false, "the Customers page in its own tab");
    assert.equal(customers.tabs()?.tabs.length, 2);
    assert.notEqual(customers.tabs()?.at, parts.tabs()?.at);
    assert.equal(parts.current()?.title, "Parts");

    // a card's socket doesn't turn to another card's tab, open tabs, or close another card's
    const theirs = customers.tabs()!.at as string;
    parts.say({ t: "tab.select", tab: theirs });
    parts.say({ t: "tab.new", url: `${siteUrl}/customers` });
    parts.say({ t: "tab.close", tab: theirs });
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(parts.current()?.title, "Parts");
    assert.equal(parts.tabs()?.tabs.length, 2);
    assert.equal(customers.current()?.title, "Customers");

    // the same card again (someone else looking at it, or coming back): the same tab, not another
    const again = await attach({ board: "company", card: "pnl_parts", url: `${siteUrl}/` });
    await until(() => Boolean(again.tabs()?.at), "the card's tab, again");
    assert.equal(again.tabs()?.at, parts.tabs()?.at);
    assert.equal(again.tabs()?.tabs.length, 2);

    // a picture is not kept while the tab is somewhere else than the card's own site
    customers.say({ t: "size", w: 640, h: 400, dpr: 1 });
    await until(() => customers.got.some((m) => m.t === "seen"), "the second card's picture", 15_000);
    const before = pics.readPagePicture({ board: "company", card: "pnl_customers" })!;
    customers.say({ t: "nav", url: `${siteUrl.replace("127.0.0.1", "localhost")}/customers` });
    await until(() => String(customers.current()?.url).includes("localhost") && customers.current()?.loading === false, "the tab at another site");
    await new Promise((r) => setTimeout(r, 6000));
    assert.equal(pics.readPagePicture({ board: "company", card: "pnl_customers" })!.at, before.at, "the picture kept is still the card's own site");

    // an agent: nothing without leave; with it (given on a card's socket), it finds the card's tab and reads it
    const ctx = { boardId: "company", actor: "Boss's agent", userId: boss.id };
    assert.equal(await runTool(ctx, "browser_read", {}), hb.NO_LEAVE);
    parts.say({ t: "agents", allow: true });
    await until(() => parts.got.some((m) => m.t === "agents" && m.allow === true), "the leave");
    const listed = JSON.stringify(await runTool(ctx, "browser_tabs", {}));
    assert.match(listed, /Parts/);
    const read = JSON.stringify(await runTool(ctx, "browser_tabs", { select: parts.tabs()!.at }).then(() => runTool(ctx, "browser_read", {})));
    assert.match(read, /The parts page/);

    // the first card's sockets close: its tab stays for a while (coming back is instant), the browser goes on for the other
    parts.ws.close();
    again.ws.close();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(hb.hostBrowserRunning(), true);
    assert.equal(hb.hostBrowserViewers(), 1);
  } finally {
    for (const ws of socks) ws.close();
    const t0 = Date.now();
    while (hb.hostBrowserRunning() && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(hb.hostBrowserRunning(), false, "closing the last socket stops the browser");
});
