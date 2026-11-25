/**
 * What each kind of agent is (docs/agent-harness.md §1): the one place that says how a seat runs, who
 * pays, and what it needs. A seat's kind comes from its key as the server knows it (posted seat → kind →
 * runtime), never from anything in a request.
 *
 * | kind              | key          | runtime        | pays                                         |
 * |-------------------|--------------|----------------|----------------------------------------------|
 * | claude-account    | `claude`     | subscription   | the Claude plan signed in on the server      |
 * | claude-api        | `claude-api` | api            | the API key an admin stored (or the env one) |
 * | claude-federated  | `claude-fed` | federated      | the organization's workspace, by a short-lived token from its identity provider |
 * | t3                | `t3:<id>`    | (T3 runs it)   | whatever that T3 agent is signed in to       |
 *
 * There is no fall-through between kinds: a `claude` seat never spends API credits, a `claude-api` seat
 * never uses the subscription.
 *
 * The API key: sealed at rest (AES-256-GCM with data/secret.key, flowformlink.ts `seal`), held unsealed in
 * memory only while the process runs, never returned (its last four characters at most), never logged,
 * never in a child's environment (it lives in this module, not in process.env) and never in a URL. Set and
 * cleared by an admin in person (the routes check); the audit log records that it was, never the value.
 *
 * Federation (workload identity federation, Anthropic's `/v1/oauth/token` jwt-bearer exchange, the SDK's
 * `oidcFederationProvider`): what's stored is ids and where the identity token is read from (a file the
 * identity provider keeps fresh), nothing secret. The exchanged token is held by the SDK's TokenCache in
 * memory until shortly before it expires.
 */

import Anthropic from "@anthropic-ai/sdk";
import { oidcFederationProvider } from "@anthropic-ai/sdk/lib/credentials/oidc-federation";
import { identityTokenFromFile, identityTokenFromValue } from "@anthropic-ai/sdk/lib/credentials/identity-token";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { AgentKind, AgentRuntime, UserInfo } from "@foundation/protocol";
import { audit } from "./audit.ts";
import { config } from "./config.ts";
import { db, run } from "./db.ts";
import { seal, unseal } from "./flowformlink.ts";
import { HttpError } from "./http.ts";

db.exec(`
create table if not exists agent_settings (
  name text primary key,
  value text not null,
  sealed integer not null default 0,
  last4 text,
  set_by text not null,
  set_by_name text not null,
  set_at integer not null
);
`);

/** the server's own Claude agents, by key */
export const CLAUDE_KEYS = { account: "claude", api: "claude-api", federated: "claude-fed" } as const;

/** a seat's kind, from its key: the server's reading, never the request's */
export function kindOfKey(key: string | undefined | null): AgentKind | null {
  if (!key) return null;
  if (key === CLAUDE_KEYS.account) return "claude-account";
  if (key === CLAUDE_KEYS.api) return "claude-api";
  if (key === CLAUDE_KEYS.federated) return "claude-federated";
  if (key.startsWith("t3:")) return "t3";
  return null;
}

/** how a kind runs here (t3 runs in T3, never through agent.ts) */
export function runtimeOfKind(kind: AgentKind): AgentRuntime | null {
  return kind === "claude-account" ? "subscription" : kind === "claude-api" ? "api" : kind === "claude-federated" ? "federated" : null;
}

/** one sentence: where it runs and who pays (AvailableAgent.runs) */
export function runsSentence(kind: AgentKind, t3?: { service: string }): string {
  switch (kind) {
    case "claude-account":
      return "Claude Code on Foundation's server, on the Claude plan signed in there; it never uses an API key.";
    case "claude-api":
      return "Foundation's own agent on the Anthropic API, paid by the API key an admin stored.";
    case "claude-federated":
      return "Foundation's own agent on the Anthropic API, paid by your organization's workspace through a short-lived token from its identity provider.";
    case "t3":
      return `A T3 session on this computer, through ${t3?.service ?? "the agent T3 runs"}.`;
  }
}

// ---------- stored settings ----------

const memo = new Map<string, string>();
let loaded = false;
function load() {
  if (loaded) return;
  loaded = true;
  for (const r of db.prepare("select name, value, sealed from agent_settings").all() as Array<{ name: string; value: string; sealed: number }>) {
    try {
      memo.set(r.name, r.sealed ? unseal(r.value) : r.value);
    } catch {
      // sealed with another key (data/secret.key replaced): as good as unset
    }
  }
}
function stored(name: string): string {
  load();
  return memo.get(name) ?? "";
}
function store(user: Pick<UserInfo, "id" | "name">, name: string, value: string, opts: { secret?: boolean } = {}) {
  load();
  if (!value) {
    run("delete from agent_settings where name = ?", name);
    memo.delete(name);
    return;
  }
  run(
    `insert into agent_settings (name, value, sealed, last4, set_by, set_by_name, set_at) values (?, ?, ?, ?, ?, ?, ?)
     on conflict(name) do update set value = excluded.value, sealed = excluded.sealed, last4 = excluded.last4, set_by = excluded.set_by, set_by_name = excluded.set_by_name, set_at = excluded.set_at`,
    name, opts.secret ? seal(value) : value, opts.secret ? 1 : 0, opts.secret && value.length >= 16 ? value.slice(-4) : null, user.id, user.name, Date.now(),
  );
  memo.set(name, value);
}

/** where the Anthropic API is: ANTHROPIC_BASE_URL (a stand-in in tests), else Anthropic's */
export function anthropicBase(): string {
  return (process.env.ANTHROPIC_BASE_URL ?? "").trim().replace(/\/+$/, "") || "https://api.anthropic.com";
}

// ---------- the API key (claude-api) ----------

export function apiKey(): { key: string; source: "stored" | "env" | null } {
  const s = stored("api_key");
  if (s) return { key: s, source: "stored" };
  const env = (config.anthropic.apiKey ?? "").trim();
  return env ? { key: env, source: "env" } : { key: "", source: null };
}

export function apiState(): { configured: boolean; source: "stored" | "env" | null; last4?: string; model: string } {
  const k = apiKey();
  return { configured: Boolean(k.key), source: k.source, ...(k.key.length >= 16 ? { last4: k.key.slice(-4) } : {}), model: defaultModel() };
}

const KEY_SHAPE = /^sk-ant-[A-Za-z0-9_-]{16,400}$/;

/** an admin, in person, stores a key: checked against Anthropic's model list first, then sealed */
export async function setApiKey(user: Pick<UserInfo, "id" | "name">, raw: unknown) {
  const key = typeof raw === "string" ? raw.trim() : "";
  if (!KEY_SHAPE.test(key)) throw new HttpError(400, "That doesn't look like an Anthropic API key (sk-ant-…, one line).");
  try {
    await fetchModels(new Anthropic({ apiKey: key, authToken: null, baseURL: anthropicBase(), maxRetries: 1, timeout: 15_000 }));
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new HttpError(400, "Anthropic didn't accept that key. Check it in the Claude Console (Settings → API keys).");
    throw new HttpError(502, `Couldn't reach Anthropic to check the key, so it wasn't saved: ${scrub((e as Error).message).slice(0, 200)}`);
  }
  store(user, "api_key", key, { secret: true });
  modelsCache = null;
  audit({ actor_kind: "person", actor_id: user.id, actor_name: user.name, door: "http", action: "agent.key.set", target: "claude-api", service: "anthropic", decision: "allowed", result: "ok" });
  return apiState();
}

export function clearApiKey(user: Pick<UserInfo, "id" | "name">) {
  store(user, "api_key", "");
  modelsCache = null;
  audit({ actor_kind: "person", actor_id: user.id, actor_name: user.name, door: "http", action: "agent.key.clear", target: "claude-api", service: "anthropic", decision: "allowed", result: "ok" });
  return apiState();
}

// ---------- models ----------

export interface ClaudeModel {
  id: string;
  name: string;
  created?: string;
}

/**
 * When the list can't be asked for (no key, or Anthropic didn't answer): the current models, newest first, as
 * the claude-api skill lists them (cached 2026-11-03). Claude Mythos is left out (verified organizations only).
 */
export const BUILTIN_MODELS: ClaudeModel[] = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
  { id: "claude-fable-5-2", name: "Claude Fable 5.2" },
  { id: "claude-fable-5-1", name: "Claude Fable 5.1" },
  { id: "claude-fable-5", name: "Claude Fable 5" },
  { id: "claude-opus-5", name: "Claude Opus 5" },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
  { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
  { id: "claude-opus-4-7", name: "Claude Opus 4.7" },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
];

const MODELS_MS = 10 * 60_000;
let modelsCache: { at: number; models: ClaudeModel[] } | null = null;

async function fetchModels(client: Anthropic): Promise<ClaudeModel[]> {
  const out: ClaudeModel[] = [];
  for await (const m of client.models.list({ limit: 100 })) {
    out.push({ id: m.id, name: m.display_name || m.id, ...(m.created_at ? { created: String(m.created_at) } : {}) });
    if (out.length >= 200) break;
  }
  // newest first (the API lists them so; sorted again so it holds whatever the order)
  return out.sort((a, b) => (Date.parse(b.created ?? "") || 0) - (Date.parse(a.created ?? "") || 0));
}

/** Anthropic's model list (live, cached 10 minutes), else the built-in one */
export async function claudeModels(): Promise<{ models: ClaudeModel[]; source: "live" | "builtin" }> {
  if (modelsCache && Date.now() - modelsCache.at < MODELS_MS) return { models: modelsCache.models, source: "live" };
  const kind: AgentKind | null = apiKey().key ? "claude-api" : federationState().configured ? "claude-federated" : null;
  if (!kind) return { models: BUILTIN_MODELS, source: "builtin" };
  try {
    const models = await fetchModels(apiClient(kind));
    if (!models.length) return { models: BUILTIN_MODELS, source: "builtin" };
    modelsCache = { at: Date.now(), models };
    return { models, source: "live" };
  } catch {
    return { models: BUILTIN_MODELS, source: "builtin" };
  }
}

/** the model a claude-api or claude-federated seat runs when it has none of its own */
export function defaultModel(): string {
  return stored("api_model") || config.anthropic.model;
}

const MODEL_SHAPE = /^claude-[a-z0-9.-]{2,80}$/;

export async function setDefaultModel(user: Pick<UserInfo, "id" | "name">, raw: unknown) {
  const model = typeof raw === "string" ? raw.trim() : "";
  if (!MODEL_SHAPE.test(model)) throw new HttpError(400, "Name a Claude model id (claude-…), as the model list gives it.");
  const list = await claudeModels();
  // validated against the list when the list is Anthropic's own; the built-in one may lag behind it
  if (list.source === "live" && !list.models.some((m) => m.id === model)) throw new HttpError(400, `${model} isn't one of the models this key can use.`);
  store(user, "api_model", model);
  audit({ actor_kind: "person", actor_id: user.id, actor_name: user.name, door: "http", action: "agent.model.set", target: model, service: "anthropic", decision: "allowed", result: "ok" });
  return apiState();
}

// ---------- federation (claude-federated) ----------

export interface FederationConfig {
  /** the Anthropic organization's id (a uuid) */
  organizationId: string;
  /** the federation rule (`fdrl_…`) the organization made for this server's identity */
  federationRuleId: string;
  /** optional: the service account (`svac_…`) the rule must resolve to */
  serviceAccountId?: string;
  /** optional: the workspace (`wrkspc_…`, or "default"); needed when the rule covers more than one */
  workspaceId?: string;
  /** the file the identity provider keeps the server's identity token (a JWT) in, read on every exchange */
  identityTokenFile: string;
}

const FED_SHAPE = {
  organizationId: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  federationRuleId: /^fdrl_[A-Za-z0-9]{4,80}$/,
  serviceAccountId: /^svac_[A-Za-z0-9]{4,80}$/,
  workspaceId: /^(wrkspc_[A-Za-z0-9]{4,80}|default)$/,
};

function envFederation(): (FederationConfig & { tokenValue?: string }) | null {
  const e = process.env;
  const rule = (e.ANTHROPIC_FEDERATION_RULE_ID ?? "").trim();
  const org = (e.ANTHROPIC_ORGANIZATION_ID ?? "").trim();
  const file = (e.ANTHROPIC_IDENTITY_TOKEN_FILE ?? "").trim();
  const value = (e.ANTHROPIC_IDENTITY_TOKEN ?? "").trim();
  if (!rule || !org || (!file && !value)) return null;
  return {
    organizationId: org,
    federationRuleId: rule,
    serviceAccountId: (e.ANTHROPIC_SERVICE_ACCOUNT_ID ?? "").trim() || undefined,
    workspaceId: (e.ANTHROPIC_WORKSPACE_ID ?? "").trim() || undefined,
    identityTokenFile: file,
    ...(value && !file ? { tokenValue: value } : {}),
  };
}

function federation(): { cfg: (FederationConfig & { tokenValue?: string }) | null; source: "stored" | "env" | null } {
  const s = stored("federation");
  if (s) {
    try {
      return { cfg: JSON.parse(s) as FederationConfig, source: "stored" };
    } catch {
      /* unreadable: as good as unset */
    }
  }
  const env = envFederation();
  return env ? { cfg: env, source: "env" } : { cfg: null, source: null };
}

const FED_NEEDS =
  "Federated identity isn't set up. An admin gives Foundation the organization's id, the federation rule (fdrl_…) made for this server in the Claude Console (Settings → Workload identity), optionally its service account and workspace, and the file this server's identity provider keeps its token in (PUT /api/agents/claude/federation), or sets ANTHROPIC_FEDERATION_RULE_ID, ANTHROPIC_ORGANIZATION_ID and ANTHROPIC_IDENTITY_TOKEN_FILE for the server.";

export function federationState(opts: { admin?: boolean } = { admin: true }): { configured: boolean; source: "stored" | "env" | null; why?: string; organizationId?: string; federationRuleId?: string; serviceAccountId?: string; workspaceId?: string; identityTokenFile?: string } {
  const { cfg, source } = federation();
  if (!cfg) return { configured: false, source: null, why: FED_NEEDS };
  const what = { organizationId: cfg.organizationId, federationRuleId: cfg.federationRuleId, ...(cfg.serviceAccountId ? { serviceAccountId: cfg.serviceAccountId } : {}), ...(cfg.workspaceId ? { workspaceId: cfg.workspaceId } : {}), ...(cfg.identityTokenFile ? { identityTokenFile: cfg.identityTokenFile } : {}) };
  if (cfg.identityTokenFile && !existsSync(cfg.identityTokenFile)) return { configured: false, source, ...what, why: `The identity token file${opts.admin ? ` (${cfg.identityTokenFile})` : ""} isn't there. The identity provider writes it; until it does, nothing can be exchanged.` };
  return { configured: true, source, ...what };
}

/** an admin, in person, sets (or with null clears) where federated identity comes from. Ids only: nothing secret */
export function setFederation(user: Pick<UserInfo, "id" | "name">, raw: Partial<Record<keyof FederationConfig, unknown>> | null) {
  if (raw === null) {
    store(user, "federation", "");
    fedClient = null;
    audit({ actor_kind: "person", actor_id: user.id, actor_name: user.name, door: "http", action: "agent.federation.clear", target: "claude-fed", service: "anthropic", decision: "allowed", result: "ok" });
    return federationState();
  }
  const s = (k: keyof FederationConfig) => (typeof raw[k] === "string" ? (raw[k] as string).trim() : "");
  const cfg: FederationConfig = { organizationId: s("organizationId"), federationRuleId: s("federationRuleId"), identityTokenFile: s("identityTokenFile") };
  if (!FED_SHAPE.organizationId.test(cfg.organizationId)) throw new HttpError(400, "organizationId: the organization's id, a uuid (Claude Console → Settings → Organization).");
  if (!FED_SHAPE.federationRuleId.test(cfg.federationRuleId)) throw new HttpError(400, "federationRuleId: the rule's id, fdrl_… (Claude Console → Settings → Workload identity).");
  if (s("serviceAccountId")) {
    if (!FED_SHAPE.serviceAccountId.test(s("serviceAccountId"))) throw new HttpError(400, "serviceAccountId: svac_…, or leave it out.");
    cfg.serviceAccountId = s("serviceAccountId");
  }
  if (s("workspaceId")) {
    if (!FED_SHAPE.workspaceId.test(s("workspaceId"))) throw new HttpError(400, "workspaceId: wrkspc_… or default, or leave it out.");
    cfg.workspaceId = s("workspaceId");
  }
  if (!cfg.identityTokenFile || !isAbsolute(cfg.identityTokenFile) || /[\u0000-\u001f]/.test(cfg.identityTokenFile)) throw new HttpError(400, "identityTokenFile: the full path of the file this server's identity provider writes its token (a JWT) to.");
  store(user, "federation", JSON.stringify(cfg));
  fedClient = null;
  modelsCache = null;
  audit({ actor_kind: "person", actor_id: user.id, actor_name: user.name, door: "http", action: "agent.federation.set", target: "claude-fed", service: "anthropic", decision: "allowed", result: "ok" });
  return federationState();
}

// ---------- clients ----------

let fedClient: { fingerprint: string; client: Anthropic } | null = null;

/**
 * The Messages API client a kind runs on, or why there is none. claude-api: the stored key, else the env's.
 * claude-federated: a token exchanged from the identity provider's, kept (one client, its TokenCache) until it
 * is about to expire. Neither falls back to the other, and neither is ever the subscription.
 */
export function apiClient(kind: AgentKind): Anthropic {
  const baseURL = anthropicBase();
  if (kind === "claude-api") {
    const k = apiKey();
    if (!k.key) throw new Error("This seat runs on Foundation's API key, and none is set. An admin adds one in Settings → Agents (PUT /api/agents/claude/key).");
    return new Anthropic({ apiKey: k.key, authToken: null, baseURL });
  }
  if (kind === "claude-federated") {
    const st = federationState();
    const { cfg } = federation();
    if (!st.configured || !cfg) throw new Error(st.why ?? FED_NEEDS);
    const fingerprint = JSON.stringify([cfg, baseURL]);
    if (fedClient?.fingerprint === fingerprint) return fedClient.client;
    const credentials = oidcFederationProvider({
      identityTokenProvider: cfg.identityTokenFile ? identityTokenFromFile(cfg.identityTokenFile) : identityTokenFromValue(cfg.tokenValue ?? ""),
      federationRuleId: cfg.federationRuleId,
      organizationId: cfg.organizationId,
      serviceAccountId: cfg.serviceAccountId,
      workspaceId: cfg.workspaceId,
      baseURL,
      fetch: globalThis.fetch,
      userAgent: "foundation-server",
    });
    const client = new Anthropic({ apiKey: null, authToken: null, credentials, baseURL });
    fedClient = { fingerprint, client };
    return client;
  }
  throw new Error(`a ${kind} seat doesn't run on the Messages API`);
}

/**
 * Who runs an ask that comes from no seat (the Shiba, ChatForm's Claude, the Slack curator, a plain ask): the
 * server's own setup, said once here. Claude Code when it's on this computer; else the API key; else
 * federation. A seat never comes through here: its kind is its own.
 */
export function defaultKind(subscription: boolean): AgentKind {
  if (subscription) return "claude-account";
  if (apiKey().key) return "claude-api";
  if (federationState().configured) return "claude-federated";
  return "claude-account";
}

/** anything that looks like a secret, out of a message before it's shown or kept */
export function scrub(s: string): string {
  return s
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-…")
    .replace(/\b(Bearer|Basic)\s+[^\s"']+/gi, "$1 …")
    .replace(/((?:api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1…")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, "…jwt…")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "…");
}

/** tests only: forget what's held in memory (as a restart would) */
export function _forgetAgentSettings() {
  memo.clear();
  loaded = false;
  modelsCache = null;
  fedClient = null;
}

