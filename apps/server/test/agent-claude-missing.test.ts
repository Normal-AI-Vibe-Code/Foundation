/**
 * No usable Claude Code: the subscription runtime reports off with the reason
 * (runtimes(), which Settings shows), and a subscription run says why instead
 * of starting anything. Nothing runs.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@foundation/protocol";

const dir = mkdtempSync(join(tmpdir(), "foundation-test-"));
process.env.FOUNDATION_DATA_DIR = dir;
delete process.env.FOUNDATION_AGENT_SCRIPT;
process.env.FOUNDATION_CLAUDE_CLI = join(dir, "no-such-claude");
// an API key is there (and Anthropic is a dead address): a claude seat must still not use it
process.env.ANTHROPIC_API_KEY = `sk-ant-api03-${"n".repeat(40)}`;
process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9";

const { upsertUser } = await import("../src/auth.ts");
const { closeBoards } = await import("../src/boards.ts");
const { runtimes, runAgent, pickRuntime } = await import("../src/agent.ts");
after(() => closeBoards());

test("the subscription runtime is off, with the reason", async () => {
  const r = runtimes();
  assert.equal(r.subscription, false);
  assert.match(r.subscriptionNote ?? "", process.platform === "win32" ? /isn't at .*no-such-claude/ : /isn't on this computer's PATH/);
  assert.equal(pickRuntime("subscription"), null);
  const ada = upsertUser("ada@formindustries.com", "Ada Lovelace");
  const events: AgentEvent[] = [];
  await runAgent({ boardId: "missing-board", user: ada, prompt: "hello", runtime: "subscription", emit: (e) => events.push(e), signal: new AbortController().signal });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  assert.ok(events[0].type === "error" && events[0].message.startsWith(`The subscription runtime can't start: ${r.subscriptionNote}`));
});

test("a claude seat with no Claude Code fails clearly: it never falls back to the API key that's there", async () => {
  assert.equal(runtimes().api, true, "a key is there");
  const ada = upsertUser("ada@formindustries.com", "Ada Lovelace");
  const events: AgentEvent[] = [];
  await runAgent({ boardId: "missing-board", user: ada, prompt: "hello", kind: "claude-account", emit: (e) => events.push(e), signal: new AbortController().signal });
  assert.equal(events.length, 1, JSON.stringify(events));
  assert.ok(events[0].type === "error" && /never falls back to an API key/.test(events[0].message), JSON.stringify(events));
});
