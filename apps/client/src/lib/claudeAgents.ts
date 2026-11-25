/**
 * The client of the Claude agent routes (docs/agent-harness.md §1): how each of the three kinds of
 * Claude agent stands on this server (the account on the server's computer, an API key, the
 * organization's federated sign-in), the key an admin stores, and the models to choose from.
 *
 * An older server (one that hasn't restarted since these routes landed) answers 404: `older` says so,
 * and the add flow falls back to what that server can do (its one "claude" agent), with a line saying
 * the server is older than the app.
 */

import { useSyncExternalStore } from "react";
import { api, ApiError } from "./api";
import { refreshAvailable } from "./agentsAvailable";

export interface ClaudeStatus {
  /** Claude Code on the server's computer, on that computer's Claude sign-in */
  account: { installed: boolean; version?: string; signedIn: true | false | "unknown"; why?: string };
  /** Foundation's own loop on the Messages API, on a key an admin stored (never returned: its last four at most) */
  api: { configured: boolean; source: "stored" | "env" | null; last4?: string; model: string };
  /** the same loop on a token from the organization's identity provider */
  federated: { configured: boolean; why?: string };
}

export interface ClaudeModel {
  id: string;
  name: string;
  /** when Anthropic released it (ISO or epoch), when the list is live */
  created?: string | number;
}
export interface ClaudeModels {
  /** newest first */
  models: ClaudeModel[];
  /** live: Anthropic's own list, read with the stored key · builtin: the list this server shipped with */
  source: "live" | "builtin";
}

export interface ClaudeState {
  status: ClaudeStatus | null;
  /** the server answered 404: it is older than this app */
  older: boolean;
  loaded: boolean;
  /** it couldn't be asked (not the 404 of an older server) */
  error?: string;
}

let now: ClaudeState = { status: null, older: false, loaded: false };
const subs = new Set<() => void>();
let asking: Promise<void> | null = null;
const emit = () => subs.forEach((f) => f());
const isOlder = (e: unknown) => e instanceof ApiError && e.status === 404;

export function refreshClaude(): Promise<void> {
  asking ??= api<ClaudeStatus>("/api/agents/claude")
    .then((status) => {
      now = { status, older: false, loaded: true };
      emit();
    })
    .catch((e: unknown) => {
      now = isOlder(e) ? { status: null, older: true, loaded: true } : { ...now, loaded: true, error: (e as Error).message };
      emit();
    })
    .finally(() => {
      asking = null;
    });
  return asking;
}

export function useClaude(): ClaudeState {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      if (!now.loaded) void refreshClaude();
      return () => subs.delete(f);
    },
    () => now,
  );
}

/** the models to choose from, newest first; null from an older server */
export async function claudeModels(): Promise<ClaudeModels | null> {
  try {
    const r = await api<ClaudeModels>("/api/agents/claude/models");
    return { source: r.source, models: newestFirst(r.models) };
  } catch (e) {
    if (isOlder(e)) return null;
    throw e;
  }
}

/** newest first by `created` where the list carries it; otherwise the server's order (already newest first) */
export function newestFirst(models: ClaudeModel[]): ClaudeModel[] {
  if (!models.every((m) => m.created !== undefined)) return models;
  const t = (m: ClaudeModel) => (typeof m.created === "number" ? m.created : Date.parse(String(m.created)) || 0);
  return [...models].sort((a, b) => t(b) - t(a));
}

/** store an API key (an admin): the server checks it with Anthropic first and says why when it won't keep it */
export async function storeClaudeKey(key: string): Promise<void> {
  await api("/api/agents/claude/key", { method: "PUT", json: { key } });
  // the key way's agent is ready (or not) as of now: both lists, at once
  await Promise.all([refreshClaude(), refreshAvailable()]);
}

/** forget the stored key (an admin, confirmed in place) */
export async function forgetClaudeKey(): Promise<void> {
  await api("/api/agents/claude/key", { method: "DELETE", json: { confirm: true } });
  await Promise.all([refreshClaude(), refreshAvailable()]);
}

/** the default model for API-key seats */
export async function setClaudeModel(model: string): Promise<void> {
  await api("/api/agents/claude/model", { method: "PUT", json: { model } });
  await refreshClaude();
}

/** a token for an MCP client acting as you (a person; 7 days), and the server's MCP address */
export async function mintAgentToken(): Promise<{ token: string; mcp: string }> {
  return api<{ token: string; mcp: string }>("/api/agent/token", { method: "POST" });
}

/** the command that adds this server to Claude Code (docs/agent-harness.md §4) */
export function mcpCommand(mcp: string, board: string | null, token: string, codeMode: boolean): string {
  let url: URL;
  try {
    url = new URL(mcp, typeof window !== "undefined" ? window.location.origin : "http://localhost");
  } catch {
    url = new URL("http://localhost/mcp");
  }
  const grid = board ?? url.searchParams.get("board") ?? "company";
  const address = `${url.origin}${url.pathname}?board=${encodeURIComponent(grid)}${codeMode ? "&mode=code" : ""}`;
  return `claude mcp add foundation --transport http "${address}" --header "Authorization: Bearer ${token}"`;
}

/** federated identity as an admin reads it (GET /api/agents/claude/federation): ids only, nothing secret */
export interface FederationState {
  configured: boolean;
  source: "stored" | "env" | null;
  why?: string;
  organizationId?: string;
  federationRuleId?: string;
  serviceAccountId?: string;
  workspaceId?: string;
  /** where the identity provider writes this server's token (admins only) */
  identityTokenFile?: string;
}
export interface FederationInput {
  organizationId: string;
  federationRuleId: string;
  serviceAccountId?: string;
  workspaceId?: string;
  identityTokenFile: string;
}

/** an admin's read of federated identity; null from an older server */
export async function claudeFederation(): Promise<FederationState | null> {
  try {
    return (await api<{ federated: FederationState }>("/api/agents/claude/federation")).federated;
  } catch (e) {
    if (isOlder(e)) return null;
    throw e;
  }
}

/** set it (an admin): the server checks each id's shape and says which is wrong, in its own words */
export async function saveFederation(input: FederationInput): Promise<FederationState> {
  const r = await api<{ federated: FederationState }>("/api/agents/claude/federation", { method: "PUT", json: input });
  await Promise.all([refreshClaude(), refreshAvailable()]);
  return r.federated;
}

/** forget the stored setup (an admin, confirmed in place) */
export async function forgetFederation(): Promise<FederationState> {
  const r = await api<{ federated: FederationState }>("/api/agents/claude/federation", { method: "DELETE", json: { confirm: true } });
  await Promise.all([refreshClaude(), refreshAvailable()]);
  return r.federated;
}
