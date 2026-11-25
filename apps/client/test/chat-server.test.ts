/**
 * ChatForm on a chat server of its own (2026-11-22; src/chat/serverLogic.ts):
 *  - what a person types becomes a server's origin (https unless it's this computer), or nothing;
 *  - ChatForm is "remote" only when a chat server is chosen and it isn't the Foundation server itself;
 *  - what's left out there: Foundation-only things always, the rest by what the server says it has.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { builtChatServer, chatCan, chatServerName, chatServerOrigin, FORM_CHAT_SERVER, isRemoteChat, KNOWN_CHAT_SERVERS, readUsedChatServers, rememberChatServer, rememberedChatServers } from "../src/chat/serverLogic.ts";

test("the desktop app defaults to the team's chat server; a named build, dev and e2e don't", () => {
  assert.equal(builtChatServer(undefined, "desktop"), "https://foundation-chatserver.vercel.app");
  assert.equal(builtChatServer(undefined, "production"), "");
  assert.equal(builtChatServer(undefined, "development"), "");
  // a build that names one gets it, and naming "" is Foundation's own even on the desktop
  assert.equal(builtChatServer("chat.example.app", "desktop"), "https://chat.example.app");
  assert.equal(builtChatServer("", "desktop"), "");
  assert.equal(builtChatServer("not an address", "desktop"), "");
});

test("the servers a device used are remembered newest first, five at most, each once", () => {
  let used: string[] = [];
  used = rememberChatServer(used, "a.example.app");
  used = rememberChatServer(used, "localhost:4420");
  used = rememberChatServer(used, "https://a.example.app/");
  assert.deepEqual(used, ["https://a.example.app", "http://localhost:4420"]);
  assert.deepEqual(rememberChatServer(used, "not an address"), used);
  for (const n of [1, 2, 3, 4, 5]) used = rememberChatServer(used, `s${n}.example.app`);
  assert.equal(used.length, 5);
  assert.equal(used[0], "https://s5.example.app");
});

test("a stored list keeps its addresses and drops what isn't one", () => {
  assert.deepEqual(readUsedChatServers(null), []);
  assert.deepEqual(readUsedChatServers("{oops"), []);
  assert.deepEqual(readUsedChatServers('{"a":1}'), []);
  assert.deepEqual(readUsedChatServers('["https://a.example.app", 3, "javascript://x", "https://a.example.app", "localhost:4420"]'), ["https://a.example.app", "http://localhost:4420"]);
});

test("Settings offers the team's server first, then the device's own, never Foundation's", () => {
  const list = rememberedChatServers(KNOWN_CHAT_SERVERS, ["http://localhost:4420", FORM_CHAT_SERVER.origin, "http://localhost:4410"], "http://localhost:4410");
  assert.deepEqual(list.map((s) => s.origin), ["https://foundation-chatserver.vercel.app", "http://localhost:4420"]);
  assert.equal(list[0].name, "Form Industries");
  assert.equal(list[1].name, undefined);
});

test("an address a person typed becomes an origin: https by default, http on this computer", () => {
  assert.equal(chatServerOrigin("chatform.vercel.app"), "https://chatform.vercel.app");
  assert.equal(chatServerOrigin("  https://chatform.vercel.app/  "), "https://chatform.vercel.app");
  assert.equal(chatServerOrigin("https://chat.example.app/some/path?x=1#y"), "https://chat.example.app");
  assert.equal(chatServerOrigin("localhost:4420"), "http://localhost:4420");
  assert.equal(chatServerOrigin("127.0.0.1:15420/"), "http://127.0.0.1:15420");
  assert.equal(chatServerOrigin("http://localhost:4420"), "http://localhost:4420");
  // a name that only starts like this computer's is not this computer
  assert.equal(chatServerOrigin("localhost.evil.example"), "https://localhost.evil.example");
});

test("what isn't a server's address is nothing", () => {
  assert.equal(chatServerOrigin(""), null);
  assert.equal(chatServerOrigin("   "), null);
  assert.equal(chatServerOrigin("ftp://files.example"), null);
  assert.equal(chatServerOrigin("javascript://alert(1)"), null);
  assert.equal(chatServerOrigin("http://"), null);
  // an address never carries a name or a password
  assert.equal(chatServerOrigin("https://user:pass@chat.example.app"), null);
  assert.equal(chatServerOrigin("not an address"), null);
});

test("a name is the origin without its scheme", () => {
  assert.equal(chatServerName("https://chatform.vercel.app"), "chatform.vercel.app");
  assert.equal(chatServerName("http://localhost:4420"), "localhost:4420");
});

test("ChatForm is on a server of its own only when one is chosen and it isn't Foundation's", () => {
  assert.equal(isRemoteChat("", "http://localhost:4410"), false);
  assert.equal(isRemoteChat("https://chatform.vercel.app", "http://localhost:4410"), true);
  assert.equal(isRemoteChat("http://localhost:4410", "http://localhost:4410"), false);
  assert.equal(isRemoteChat("localhost:4410", "http://localhost:4410"), false);
  assert.equal(isRemoteChat("not an address", "http://localhost:4410"), false);
});

test("on Foundation's own server everything is there", () => {
  for (const f of ["files", "pins", "topics", "members", "notify", "star", "export", "archive", "threads-list", "huddles", "agents"] as const) assert.equal(chatCan(false, null, f), true);
});

test("on a chat server, Foundation's own things are never there, and the rest is what the server says", () => {
  const rust = ["channels", "direct", "threads", "reactions", "search"];
  for (const f of ["huddles", "agents"] as const) {
    assert.equal(chatCan(true, rust, f), false);
    assert.equal(chatCan(true, null, f), false);
    // even a server that claims them: they live on Foundation's server, which the chat store doesn't ask there
    assert.equal(chatCan(true, [...rust, f], f), false);
  }
  for (const f of ["pins", "topics", "members", "notify", "star", "export", "archive", "threads-list"] as const) assert.equal(chatCan(true, rust, f), false);
  assert.equal(chatCan(true, [...rust, "pins"], "pins"), true);
  // a server that doesn't say (another Foundation used for chat alone) has what the chat store asks for
  assert.equal(chatCan(true, null, "pins"), true);
  assert.equal(chatCan(true, null, "export"), true);
});

test("files and the mentions list are on a chat server only when it says so (never assumed, never Foundation's instead)", () => {
  const rust = ["channels", "direct", "threads", "reactions", "search"];
  for (const f of ["files", "mentions"] as const) {
    assert.equal(chatCan(true, rust, f), false, `${f}: a server that lists other things and not this`);
    assert.equal(chatCan(true, null, f), false, `${f}: a server that doesn't say`);
    assert.equal(chatCan(true, [...rust, f], f), true, `${f}: listed`);
    assert.equal(chatCan(false, null, f), true, `${f}: Foundation's own`);
  }
  assert.equal(chatCan(true, [...rust, "previews"], "previews"), true);
});
