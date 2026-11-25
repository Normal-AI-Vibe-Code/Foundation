#!/usr/bin/env node
/**
 * How big Foundation's MCP tool list is, in both modes (docs/agent-harness.md §3):
 *
 *   node scripts/measure-tools.mjs          a table
 *   node scripts/measure-tools.mjs --json   the numbers as JSON
 *
 * It builds the real MCP server in this process (apps/server/src/mcp.ts) on a
 * throwaway data folder, asks it for tools/list over an in-memory transport,
 * and measures the JSON the client would get: bytes, and tokens approximated
 * as characters / 4. Also the size of run_code's whole typed API (toolApiDts),
 * which a model never receives at once but search_tools hands out in pieces.
 * No server, network or real data needed.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { register } from "tsx/esm/api";

const root = resolve(import.meta.dirname, "..");
const data = mkdtempSync(join(tmpdir(), "foundation-measure-"));
process.env.FOUNDATION_DATA_DIR = data;

const src = (f) => pathToFileURL(join(root, "apps/server/src", f)).href;
register(); // TypeScript from here on, in one module graph (tools.ts wires codemode.ts as the server does)
const { buildServer } = await import(src("mcp.ts"));
const { toolApiDts } = await import(src("codemode.ts"));
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const user = { id: "agent", email: "", name: "Agent", color: "#888", role: "member" };
async function list(mode) {
  const server = buildServer("company", user, undefined, undefined, mode);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "measure", version: "0" });
  await client.connect(b);
  const { tools } = await client.listTools();
  await client.close();
  const json = JSON.stringify({ tools });
  return { tools: tools.length, bytes: Buffer.byteLength(json), tokens: Math.round(json.length / 4) };
}

const all = await list("all");
const code = await list("code");
const dts = toolApiDts();
const api = { bytes: Buffer.byteLength(dts), tokens: Math.round(dts.length / 4) };
try {
  rmSync(data, { recursive: true, force: true });
} catch {
  /* Windows keeps the database open until exit; the temp folder is left */
}

if (process.argv.includes("--json")) console.log(JSON.stringify({ all, code, api }, null, 2));
else {
  const row = (name, r) => `  ${name.padEnd(28)}${String(r.tools ?? "").padStart(6)}${String(r.bytes).padStart(10)}${String(r.tokens).padStart(9)}`;
  console.log(`  ${"".padEnd(28)}${"tools".padStart(6)}${"bytes".padStart(10)}${"~tokens".padStart(9)}`);
  console.log(row("tools/list, default", all));
  console.log(row("tools/list, mode=code", code));
  console.log(row("run_code's API (.d.ts)", api));
  console.log(`\n  mode=code lists ${((1 - code.bytes / all.bytes) * 100).toFixed(1)}% fewer bytes.`);
}
process.exit(0);
