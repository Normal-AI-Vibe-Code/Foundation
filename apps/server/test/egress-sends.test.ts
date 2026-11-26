/**
 * Every tool says what it sends outside (tools.ts `sends`; egress.ts), and a new tool can't forget to.
 *
 * How it works: a static read of tools.ts. Each tool's definition is cut out of the source (from one
 * `def({` to the next). A maintained list names the functions that reach the network (the Slack,
 * GitHub, Flowform and app MCP clients, and the helpers built on them); a definition whose code calls
 * one of them, or `fetch`, must carry `sends`. So that the list can't fall behind, every name tools.ts
 * imports from a module that talks to the network must be on it, or on the short list of names
 * from those modules that don't (checked by hand: they only parse or check a name).
 *
 * It sees direct calls in a tool's own definition, which is how tools.ts is written. A helper written
 * inside tools.ts that reaches the network would need adding to the list: the import check catches
 * it only if the helper comes from another module.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-egress-sends-"));
const { TOOLS } = await import("../src/tools.ts");

const src = readFileSync(resolve(import.meta.dirname, "../src/tools.ts"), "utf8");

/** functions that send something outside Foundation (and what reaches them) */
const NETWORK = [
  "fetch",
  "searchAll", // Slack, GitHub, Flowform (search.ts)
  "findImages", // Slack (construct.ts)
  "layOut", // Slack files (construct.ts)
  "repoInfo",
  "repoReadme",
  "repoCommits",
  "discoverRepo",
  "searchRepos", // GitHub (github.ts)
  "listAppTools",
  "callAppTool", // a saved app's MCP (apptools.ts)
  "companySnapshot",
  "readConnector", // the company's systems (connectors.ts)
  "writeDigest", // the same, through connectors (digest.ts)
  "createAsk", // a Slack DM (hermes.ts)
  "flowformCall",
  "flowformTools", // Flowform's MCP (flowformlink.ts)
  "channelHistory",
  "channelInfo",
  "listChannels", // Slack (slack.ts)
  "helperStarter", // a helper run: model spend
];

/** modules whose exports may reach the network, and the names from them that don't */
const NETWORK_MODULES = ["./search.ts", "./github.ts", "./apptools.ts", "./connectors.ts", "./digest.ts", "./hermes.ts", "./flowformlink.ts", "./slack.ts", "./construct.ts", "./mcpclient.ts", "./flowform-live.ts", "./flowformfiles.ts", "./meshy.ts", "./vision.ts", "./t3host.ts", "./t3.ts", "./apps.ts"];
const NOT_NETWORK = new Set([
  "parseRepo", // reads a repository's name from text
  "checkRepo", // the same, and checks its owner
  "queueHandoff", // writes a row; a person's Run sends it to Vision (jobs.ts)
]);

test("every name tools.ts imports from a module that talks to the network is on the list, or known not to", () => {
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*"([^"]+)"/g)) {
    if (!NETWORK_MODULES.includes(m[2])) continue;
    seen.add(m[2]);
    for (const raw of m[1].split(",")) {
      const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0];
      if (!name || raw.trim().startsWith("type ")) continue;
      if (!NETWORK.includes(name) && !NOT_NETWORK.has(name)) unknown.push(`${name} from ${m[2]}`);
    }
  }
  // dynamic imports too: `await import("./github.ts")` then a name from it
  for (const m of src.matchAll(/const\s*\{([^}]+)\}\s*=\s*await import\("([^"]+)"\)/g)) {
    if (!NETWORK_MODULES.includes(m[2])) continue;
    for (const raw of m[1].split(",")) {
      const name = raw.trim();
      if (name && !NETWORK.includes(name) && !NOT_NETWORK.has(name)) unknown.push(`${name} from ${m[2]} (dynamic)`);
    }
  }
  assert.ok(seen.has("./github.ts") && seen.has("./slack.ts") && seen.has("./search.ts"), "the imports were read");
  assert.deepEqual(unknown, [], "add each to NETWORK (and give the tools that call it `sends`) or to NOT_NETWORK with why");
});

test("a tool whose code reaches the network says what it sends and where", () => {
  const blocks = src.split(/\r?\n {2}def\(\{\r?\n/).slice(1);
  assert.ok(blocks.length >= 60, `found ${blocks.length} tool definitions`);
  const missing: string[] = [];
  const reaching: string[] = [];
  for (const block of blocks) {
    const name = /^\s*name: "([a-z_]+)"/.exec(block)?.[1];
    assert.ok(name, `a definition without a name: ${block.slice(0, 80)}`);
    const calls = NETWORK.filter((f) => new RegExp(`\\b${f}\\(`).test(block));
    if (!calls.length) continue;
    reaching.push(name);
    const tool = TOOLS.find((t) => t.name === name)!;
    if (!tool.sends?.length) missing.push(`${name} (calls ${calls.join(", ")})`);
  }
  assert.deepEqual(missing, [], "these reach the network and have no `sends`");
  // the list this test knows reaches out, so a change to it is seen
  assert.deepEqual(reaching.sort(), ["add_cad", "add_slack_channel", "app_tools", "ask_person", "call_app_tool", "call_in_help", "company", "find_images", "find_repo", "flowform", "lay_out", "read_repo", "refresh_cad", "search", "slack_read", "stage_request", "write_digest"]);
});

test("every `sends` names a service, a kind and where it runs; external ones are gated or say what gates them", () => {
  for (const t of TOOLS) {
    for (const s of t.sends ?? []) {
      assert.ok(s.service, t.name);
      assert.ok(["query", "message", "read", "call", "spend"].includes(s.kind), `${t.name}: ${s.kind}`);
      assert.ok(["external", "ours-cloud", "ours-local"].includes(s.provenance), `${t.name}: ${s.provenance}`);
      if (s.ownGate) assert.ok(s.ownGate.length > 20, `${t.name}: say what its own gate is`);
    }
  }
  // a tool that sends nothing outside has no `sends`, and isn't gated
  for (const name of ["read_board", "add_note", "read_file", "machine_run", "vision_brief", "reverse_engineer", "propose_machine"]) {
    assert.equal(TOOLS.find((t) => t.name === name)!.sends, undefined, name);
  }
});
