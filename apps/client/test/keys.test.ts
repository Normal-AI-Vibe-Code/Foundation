/**
 * Shortcut labels per platform (lib/keys.ts): ⌘ on a Mac, Ctrl elsewhere.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { detectMac, keys } from "../src/lib/keys.ts";

test("a Mac is told apart from Windows and Linux, with or without userAgentData", () => {
  assert.equal(detectMac({ platform: "MacIntel" }), true); // Safari, WKWebView
  assert.equal(detectMac({ platform: "", userAgentData: { platform: "macOS" } }), true); // Chromium
  assert.equal(detectMac({ platform: "iPad" }), true);
  assert.equal(detectMac({ platform: "Win32", userAgentData: { platform: "Windows" } }), false); // WebView2
  assert.equal(detectMac({ platform: "Linux x86_64" }), false); // WebKitGTK
  assert.equal(detectMac({ platform: "Win32", userAgentData: { platform: "" } }), false); // empty UA-CH falls back
  assert.equal(detectMac(null), false); // no navigator at all (undefined would take the default: Node 22 has one)
});

test("labels on a Mac", () => {
  assert.equal(keys("mod+K", true), "⌘K");
  assert.equal(keys("mod+\\", true), "⌘\\");
  assert.equal(keys("mod+enter", true), "⌘↵");
  assert.equal(keys("shift+mod+Z", true), "⇧⌘Z");
  assert.equal(keys("mod+shift+Z", true), "⇧⌘Z");
  assert.equal(keys("alt+mod+P", true), "⌥⌘P");
});

test("labels on Windows and Linux", () => {
  assert.equal(keys("mod+K", false), "Ctrl+K");
  assert.equal(keys("mod+\\", false), "Ctrl+\\");
  assert.equal(keys("mod+enter", false), "Ctrl+Enter");
  assert.equal(keys("shift+mod+Z", false), "Ctrl+Shift+Z");
  assert.equal(keys("alt+mod+P", false), "Ctrl+Alt+P");
  assert.equal(keys("ctrl+mod+K", false), "Ctrl+K");
  assert.equal(keys("F", false), "F");
});
