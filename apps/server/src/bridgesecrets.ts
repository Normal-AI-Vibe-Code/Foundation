/**
 * Where the keys a person pastes into the Inbox's setup wizards go (a bridge's token, app secret, phone
 * number id; the Slack app's bot token). Before this, every bridge read only the server's .env; now each
 * reads **the stored value, else the env** (bridges/common.ts `env`, slack.ts `token`).
 *
 *  - Sealed at rest: AES-256-GCM with the key beside the database (`data/secret.key`, flowformlink.ts
 *    `seal`), never in it.
 *  - Only the keys named in KEYS can be stored, each under its service; anything else is refused.
 *  - Written by an admin, as a person (the routes check `requirePerson` and the role); never by an agent.
 *  - Never returned to any client: what the API says is set or missing, where it comes from (stored, the
 *    server's .env) and, for a long value, its last four characters. Never logged; the audit log records
 *    that it was set or cleared, by whom, under which name (never the value).
 *  - Kept unsealed in memory only while the process runs (so a webhook's signature check doesn't decrypt
 *    on every call), dropped when it changes.
 */

import { audit } from "./audit.ts";
import { all, db, one, run } from "./db.ts";
import { HttpError } from "./http.ts";
import { seal, unseal } from "./flowformlink.ts";
import type { UserInfo } from "@foundation/protocol";

db.exec(`
create table if not exists chat_bridge_secrets (
  key text primary key,
  service text not null,
  sealed text not null,
  last4 text,
  set_by text not null,
  set_by_name text not null,
  set_at integer not null
);
`);

/** what may be stored, by service: the key's name, what it is, and whether it's a secret (a secret's tail is shown only when long) */
export const KEYS: Record<string, Array<{ key: string; what: string; secret: boolean; pattern?: RegExp }>> = {
  gmail: [
    { key: "GMAIL_CLIENT_ID", what: "The Google OAuth client's id (…apps.googleusercontent.com)", secret: false, pattern: /^[\w.-]{8,200}$/ },
    { key: "GMAIL_CLIENT_SECRET", what: "The Google OAuth client's secret", secret: true },
  ],
  whatsapp: [
    { key: "WHATSAPP_TOKEN", what: "A system user's permanent access token with whatsapp_business_messaging", secret: true },
    { key: "WHATSAPP_PHONE_NUMBER_ID", what: "The business phone number's id (WhatsApp Manager → API setup)", secret: false, pattern: /^\d{5,30}$/ },
    { key: "WHATSAPP_APP_SECRET", what: "The Meta app's secret (App settings → Basic)", secret: true },
    { key: "WHATSAPP_VERIFY_TOKEN", what: "The verify token: the same long random string goes in Meta's webhook settings", secret: true },
  ],
  instagram: [
    { key: "INSTAGRAM_TOKEN", what: "The Instagram professional account's access token (instagram_business_manage_messages)", secret: true },
    { key: "INSTAGRAM_ACCOUNT_ID", what: "The Instagram professional account's id", secret: false, pattern: /^\d{5,30}$/ },
    { key: "INSTAGRAM_APP_SECRET", what: "The Meta app's secret (App settings → Basic)", secret: true },
    { key: "INSTAGRAM_VERIFY_TOKEN", what: "The verify token: the same long random string goes in Meta's webhook settings", secret: true },
  ],
  wechat: [
    { key: "WECOM_CORP_ID", what: "The WeCom organisation's CorpID (My Company → Company Information)", secret: false, pattern: /^[\w-]{4,64}$/ },
    { key: "WECOM_AGENT_ID", what: "The self-built app's AgentId", secret: false, pattern: /^\d{1,20}$/ },
    { key: "WECOM_SECRET", what: "The self-built app's Secret", secret: true },
    { key: "WECOM_TOKEN", what: "The callback Token (Receive Messages → API receive)", secret: true },
    { key: "WECOM_AES_KEY", what: "The callback EncodingAESKey (43 characters)", secret: true, pattern: /^[A-Za-z0-9+/]{43}$/ },
  ],
  slack: [{ key: "SLACK_BOT_TOKEN", what: "The Foundation Slack app's Bot User OAuth Token (xoxb-…)", secret: true, pattern: /^xoxb-[A-Za-z0-9-]{10,250}$/ }],
};

const SPEC = new Map(Object.entries(KEYS).flatMap(([service, list]) => list.map((k) => [k.key, { ...k, service }] as const)));

const cache = new Map<string, string>();
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  for (const r of all<{ key: string; sealed: string }>("select key, sealed from chat_bridge_secrets")) {
    try {
      cache.set(r.key, unseal(r.sealed));
    } catch {
      // sealed with another key (data/secret.key replaced): as good as unset, and the Inbox says it's missing
    }
  }
}

/** the stored value of a key, or "" (only keys in KEYS are ever stored) */
export function storedSecret(key: string): string {
  if (!SPEC.has(key)) return "";
  load();
  return cache.get(key) ?? "";
}

export type SecretSource = "stored" | "env" | null;

export interface SecretState {
  key: string;
  what: string;
  set: boolean;
  source: SecretSource;
  /** the last four characters of a long value; never more, never for a short secret */
  tail?: string;
  setBy?: string;
  setAt?: number;
}

/** what a service's keys look like, for the Inbox: set or missing, from where, a tail at most. Never a value */
export function secretStates(service: string): SecretState[] {
  load();
  return (KEYS[service] ?? []).map((k) => {
    const row = one<{ last4: string | null; set_by_name: string; set_at: number }>("select last4, set_by_name, set_at from chat_bridge_secrets where key = ?", k.key);
    const stored = cache.get(k.key) ?? "";
    const env = (process.env[k.key] ?? "").trim();
    const source: SecretSource = stored ? "stored" : env ? "env" : null;
    const value = stored || env;
    const tail = value && (!k.secret || value.length >= 16) ? value.slice(-4) : undefined;
    return { key: k.key, what: k.what, set: Boolean(value), source, ...(tail ? { tail } : {}), ...(stored && row ? { setBy: row.set_by_name, setAt: row.set_at } : {}) };
  });
}

const listeners = new Set<(key: string) => void>();
/** told the name (never the value) of a key that was set or cleared: a client drops what it cached */
export function onSecretChange(fn: (key: string) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** store (or, with an empty value, clear) a key. The caller has checked it's an admin in person */
export function setSecret(user: Pick<UserInfo, "id" | "name">, key: string, value: string): SecretState {
  const spec = SPEC.get(key);
  if (!spec) throw new HttpError(400, `${key} isn't a key a bridge reads`);
  const v = value.trim();
  if (v.length > 4000 || /[\u0000-\u001f\s]/.test(v)) throw new HttpError(400, `${key}: one line, no spaces`);
  if (v && spec.pattern && !spec.pattern.test(v)) throw new HttpError(400, `${key} doesn't look right: ${spec.what}`);
  load();
  if (v) {
    run(
      `insert into chat_bridge_secrets (key, service, sealed, last4, set_by, set_by_name, set_at) values (?, ?, ?, ?, ?, ?, ?)
       on conflict(key) do update set sealed = excluded.sealed, last4 = excluded.last4, set_by = excluded.set_by, set_by_name = excluded.set_by_name, set_at = excluded.set_at`,
      key, spec.service, seal(v), !spec.secret || v.length >= 16 ? v.slice(-4) : null, user.id, user.name, Date.now(),
    );
    cache.set(key, v);
  } else {
    run("delete from chat_bridge_secrets where key = ?", key);
    cache.delete(key);
  }
  audit({ actor_kind: "person", actor_id: user.id, actor_name: user.name, door: "http", action: v ? "bridge.key.set" : "bridge.key.clear", target: `${spec.service}:${key}`, service: spec.service, decision: "allowed", result: "ok" });
  for (const fn of listeners) fn(key);
  return secretStates(spec.service).find((s) => s.key === key)!;
}

/** tests only: forget what's held in memory (as a restart would) */
export function _forgetSecretCache() {
  cache.clear();
  loaded = false;
}
