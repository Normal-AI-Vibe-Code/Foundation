/**
 * A person's own settings that the server has to know (2026-11-15), as opposed to this device's
 * (the colour scheme, what the app opens on: those stay in the browser). One row per person and key.
 *
 * `computer_use`: whether agents may be let onto a machine's desktop at all.
 *   "ask"   (default) a person grants it per machine, on the machine's card
 *   "never" the grant is refused for this person, whoever presses
 *
 * A setting only ever narrows what agents may do. Nothing here lets code start without a person.
 */

import { all, db, run } from "./db.ts";

db.exec(`create table if not exists person_prefs (
  user_id text not null,
  key text not null,
  value text not null,
  at integer not null,
  primary key (user_id, key)
)`);

export const PREFS = {
  computer_use: { values: ["ask", "never"], initial: "ask" },
} as const;
export type PrefKey = keyof typeof PREFS;
export type Prefs = { [K in PrefKey]: (typeof PREFS)[K]["values"][number] };

export function prefsOf(userId: string): Prefs {
  const rows = new Map(all<{ key: string; value: string }>("select key, value from person_prefs where user_id = ?", userId).map((r) => [r.key, r.value]));
  const out = {} as Record<string, string>;
  for (const [k, def] of Object.entries(PREFS)) {
    const v = rows.get(k);
    out[k] = v && (def.values as readonly string[]).includes(v) ? v : def.initial;
  }
  return out as Prefs;
}

/** set one; says why not when the key or value isn't one of ours */
export function setPref(userId: string, key: string, value: unknown): { ok: true } | { error: string } {
  const def = (PREFS as Record<string, { values: readonly string[] }>)[key];
  if (!def) return { error: `No such setting: ${key}` };
  if (typeof value !== "string" || !def.values.includes(value)) return { error: `${key} is one of: ${def.values.join(", ")}` };
  run("insert into person_prefs (user_id, key, value, at) values (?, ?, ?, ?) on conflict (user_id, key) do update set value = excluded.value, at = excluded.at", userId, key, value, Date.now());
  return { ok: true };
}

/** may agents be let onto a machine's desktop for this person? */
export function computerUseDefault(userId: string): "ask" | "never" {
  return prefsOf(userId).computer_use;
}
