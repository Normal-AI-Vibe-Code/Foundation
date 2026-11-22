#!/usr/bin/env node
// Hosted Foundation preflight & post-deploy smoke checker (issue #228).
//
//   node scripts/hosted-preflight.mjs [--env deploy/.env] [--url https://foundation.formindustries.co]
//
// Checks deploy/.env for unsafe or missing production settings before starting the compose stack,
// and optionally probes a live hosted server's /api/health, /auth/config, and /api/capabilities.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);

export function parseEnvFile(text) {
  const vars = {};
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    vars[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return vars;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);
const PLACEHOLDER_RE = /^(your|example|changeme|change-me|placeholder|replace|todo|<|\.\.\.)/i;

function looksPlaceholder(val) {
  const v = String(val ?? "").trim();
  if (!v) return true;
  if (PLACEHOLDER_RE.test(v)) return true;
  if (/example\.com/i.test(v)) return true;
  return false;
}

export function validateHostedEnv(vars = {}) {
  const errors = [];
  const warnings = [];

  const domain = String(vars.FOUNDATION_DOMAIN ?? "").trim().toLowerCase();
  if (!domain) {
    errors.push("FOUNDATION_DOMAIN is required (e.g. foundation.formindustries.co, without https://).");
  } else if (/^https?:\/\//i.test(domain) || domain.includes("/")) {
    errors.push("FOUNDATION_DOMAIN must be a bare hostname without https:// or path.");
  } else if (LOOPBACK_HOSTS.has(domain.split(":")[0])) {
    errors.push(`FOUNDATION_DOMAIN cannot be a loopback address (${domain}) on a hosted server.`);
  } else if (domain === "foundation.example.com" || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
    errors.push(`FOUNDATION_DOMAIN (${domain}) must be a real public domain name.`);
  }

  if (String(vars.FOUNDATION_DEV_LOGIN ?? "").trim() === "1") {
    errors.push("FOUNDATION_DEV_LOGIN=1 is forbidden on a hosted server.");
  }

  const allowlistRaw = String(vars.FOUNDATION_ALLOWLIST ?? "").trim();
  const allowlist = allowlistRaw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (allowlist.length === 0 || allowlist.includes("@example.com")) {
    errors.push("FOUNDATION_ALLOWLIST must list at least one real company domain or email (e.g. @formindustries.co,@normallab.co).");
  } else if (allowlist.includes("@formindustries.com") && !allowlist.includes("@formindustries.co")) {
    warnings.push("FOUNDATION_ALLOWLIST includes @formindustries.com but not @formindustries.co.");
  }

  const adminsRaw = String(vars.FOUNDATION_ADMIN_EMAILS ?? "").trim();
  const admins = adminsRaw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const validAdmins = admins.filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && !e.endsWith("@example.com"));
  if (validAdmins.length === 0) {
    errors.push("FOUNDATION_ADMIN_EMAILS must name at least one real admin email address.");
  }

  const clientId = String(vars.GOOGLE_CLIENT_ID ?? "").trim();
  const clientSecret = String(vars.GOOGLE_CLIENT_SECRET ?? "").trim();
  if (!clientId || looksPlaceholder(clientId)) {
    errors.push("GOOGLE_CLIENT_ID is required for hosted Google OAuth sign-in.");
  }
  if (!clientSecret || looksPlaceholder(clientSecret)) {
    errors.push("GOOGLE_CLIENT_SECRET is required for hosted Google OAuth sign-in.");
  }

  if (String(vars.FOUNDATION_ALLOW_HOST_TOOLS ?? "").trim() === "1") {
    warnings.push("FOUNDATION_ALLOW_HOST_TOOLS=1 is set: host terminal, browser, machines and Places will be exposed on this hosted server.");
  }

  if (!String(vars.ANTHROPIC_API_KEY ?? "").trim()) {
    warnings.push("ANTHROPIC_API_KEY is unset: server-side agent runs and @agent chat replies will be unavailable.");
  }

  const iceRaw = String(vars.FOUNDATION_ICE_SERVERS ?? "").trim();
  if (!iceRaw) {
    warnings.push("FOUNDATION_ICE_SERVERS is unset: huddles and ChatForm calls will use STUN only (a TURN server is recommended across strict NATs).");
  } else {
    try {
      const parsed = JSON.parse(iceRaw);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        errors.push("FOUNDATION_ICE_SERVERS must be a non-empty JSON array of RTCIceServer objects.");
      }
    } catch {
      errors.push("FOUNDATION_ICE_SERVERS is not valid JSON.");
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}

export async function probeHostedServer(baseUrl) {
  const base = String(baseUrl).trim().replace(/\/+$/, "");
  const errors = [];
  const checks = {};

  const getJson = async (path) => {
    const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`${path} answered HTTP ${res.status}`);
    return res.json();
  };

  try {
    const health = await getJson("/api/health");
    checks.health = health;
    if (!health?.ok) errors.push("/api/health did not report ok: true");
  } catch (e) {
    errors.push(`/api/health probe failed: ${e.message}`);
  }

  try {
    const auth = await getJson("/auth/config");
    checks.auth = auth;
    if (!auth?.hosted) errors.push("/auth/config did not report hosted: true");
    if (!auth?.google) errors.push("/auth/config did not report google: true");
    if (auth?.devLogin) errors.push("/auth/config reports devLogin: true on a hosted server");
  } catch (e) {
    errors.push(`/auth/config probe failed: ${e.message}`);
  }

  try {
    const caps = await getJson("/api/capabilities");
    checks.capabilities = caps;
    if (!caps?.hosted) errors.push("/api/capabilities did not report hosted: true");
  } catch (e) {
    errors.push(`/api/capabilities probe failed: ${e.message}`);
  }

  return { ok: errors.length === 0, errors, checks };
}

const isMain = Boolean(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url);
if (isMain) {
  const envPath = resolve(arg("--env", "deploy/.env"));
  const url = arg("--url", "");
  let failed = false;

  if (existsSync(envPath)) {
    const vars = parseEnvFile(readFileSync(envPath, "utf8"));
    const res = validateHostedEnv(vars);
    for (const w of res.warnings) console.warn(`warning: ${w}`);
    for (const err of res.errors) console.error(`error: ${err}`);
    if (!res.ok) failed = true;
    else console.log(`preflight env (${envPath}): ok`);
  } else if (!url) {
    console.error(`preflight: no env file at ${envPath} (pass --env <path> or --url <https://...>)`);
    failed = true;
  }

  if (url) {
    const probe = await probeHostedServer(url);
    for (const err of probe.errors) console.error(`probe error: ${err}`);
    if (!probe.ok) failed = true;
    else console.log(`preflight probe (${url}): ok`);
  }

  process.exit(failed ? 1 : 0);
}
