/**
 * The hosted server boundary and server-wide people roles (issues #227, #229).
 *
 * A hosted Foundation (FOUNDATION_PUBLIC_URL is a public HTTPS address rather
 * than localhost/127.0.0.1) serves the company's shared grids, files, huddles
 * and ChatForm online. Tools that open a shell, drive a desktop browser, mount
 * local folders, watch local git checkouts, or boot containers and QEMU VMs on
 * the server's own host machine are local-computer features and are turned off
 * on a hosted server unless FOUNDATION_ALLOW_HOST_TOOLS=1 is explicitly set.
 */

import type { UserInfo } from "@foundation/protocol";
import { audit } from "./audit.ts";
import { all, one, run } from "./db.ts";
import { hostedServer } from "./flowform.ts";
import { HttpError } from "./http.ts";

export type LocalFeature =
  | "terminal"
  | "browser"
  | "machines"
  | "vms"
  | "t3"
  | "vision"
  | "places"
  | "localDev";

const FEATURE_LABELS: Record<LocalFeature, string> = {
  terminal: "The built-in terminal",
  browser: "The server's built-in browser",
  machines: "Local container machines",
  vms: "Local QEMU virtual machines",
  t3: "Local T3 agents",
  vision: "Vision Code on this computer",
  places: "Local computer folders (Places)",
  localDev: "This computer's local projects watch",
};

/** Whether host-level tools are explicitly unlocked on a hosted server. */
export function allowHostTools(): boolean {
  return process.env.FOUNDATION_ALLOW_HOST_TOOLS === "1";
}

/** Whether a local-computer feature may run on this server. */
export function localFeatureAllowed(_feature: LocalFeature): boolean {
  return !hostedServer() || allowHostTools();
}

/** Plain, honest one-sentence explanation when a local feature is turned off on a hosted server. */
export function hostedFeatureReason(feature: LocalFeature, label?: string): string {
  const what = (label ?? FEATURE_LABELS[feature]).trim();
  return `${what} runs on a local computer and is turned off on a hosted Foundation server.`;
}

/** Guard a route or action that requires a local-computer feature. */
export function requireLocalFeature(feature: LocalFeature, label?: string): void {
  if (!localFeatureAllowed(feature)) {
    throw new HttpError(403, hostedFeatureReason(feature, label));
  }
}

export interface ServerCapabilities {
  hosted: boolean;
  allowHostTools: boolean;
  local: Record<LocalFeature, boolean>;
  chat: true;
  images: {
    serverLevels: true;
    widths: number[];
  };
}

/** What this server supports (`GET /api/capabilities`). */
export function serverCapabilities(): ServerCapabilities {
  return {
    hosted: hostedServer(),
    allowHostTools: allowHostTools(),
    local: {
      terminal: localFeatureAllowed("terminal"),
      browser: localFeatureAllowed("browser"),
      machines: localFeatureAllowed("machines"),
      vms: localFeatureAllowed("vms"),
      t3: localFeatureAllowed("t3"),
      vision: localFeatureAllowed("vision"),
      places: localFeatureAllowed("places"),
      localDev: localFeatureAllowed("localDev"),
    },
    chat: true,
    images: {
      serverLevels: true,
      widths: [64, 256, 512, 1024, 2048],
    },
  };
}

// ---------- Admin people management (/api/admin/users) ----------

export type ServerRole = "admin" | "member" | "viewer";

export interface ServerUserRow {
  id: string;
  email: string;
  name: string;
  color: string;
  role: ServerRole;
  created_at: number;
}

const VALID_ROLES = new Set<ServerRole>(["admin", "member", "viewer"]);

/** Every person who has signed in to this server, admins first, then by name. */
export function listServerUsers(): ServerUserRow[] {
  return all<ServerUserRow>(
    `select id, email, name, color, role, created_at
       from users
      order by case role when 'admin' then 0 when 'member' then 1 else 2 end,
               lower(name),
               lower(email)`,
  );
}

/**
 * Change a person's server-wide role (`POST /api/admin/users/:id/role`).
 * Only an admin may call this, and the last admin on the server cannot be demoted.
 */
export function setServerUserRole(actor: UserInfo, targetId: string, role: ServerRole): ServerUserRow[] {
  if (actor.role !== "admin") {
    throw new HttpError(403, "Only an admin can change someone's role on this server.");
  }
  if (!VALID_ROLES.has(role)) {
    throw new HttpError(400, "Role must be admin, member, or viewer.");
  }
  const target = one<ServerUserRow>(
    "select id, email, name, color, role, created_at from users where id = ?",
    targetId,
  );
  if (!target) {
    throw new HttpError(404, "No such person on this server.");
  }
  if (target.role === "admin" && role !== "admin") {
    const admins = one<{ n: number }>("select count(*) as n from users where role = 'admin'")?.n ?? 0;
    if (admins <= 1) {
      throw new HttpError(400, "At least one admin must stay on this server.");
    }
  }
  run("update users set role = ? where id = ?", role, target.id);
  audit({
    actor_kind: "person",
    actor_id: actor.id,
    actor_name: actor.name,
    door: "route",
    action: "user.role",
    target: `${target.email} -> ${role}`,
    decision: "allowed",
    result: "ok",
  });
  return listServerUsers();
}
