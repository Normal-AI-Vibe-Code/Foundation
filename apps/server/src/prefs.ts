/**
 * A person's own preferences: small named values that follow them across
 * devices and boards (`person_prefs`: user, key, value). Only the keys named
 * in PREFS exist, each with the values it may take and its default; a value
 * nobody set reads as the default. A person reads and sets their own, from
 * their browser (index.ts: GET /api/prefs, POST /api/prefs); an agent's token
 * may read them and can't change them.
 *
 * `computer_use`: may agents use a machine's desktop (look at it, move the
 * pointer, type)?
 *   - "ask" (the default): agents may ask; a person lets them, machine by
 *     machine, with **Let agents use this desktop** on the machine's card.
 *   - "never": this person's agents don't use desktops, and this person's
 *     press of that button is refused (machinedesktop.ts).
 */

import { all, one, run } from "./db.ts";
import { HttpError } from "./http.ts";

run(`create table if not exists person_prefs (
  user_id text not null,
  key text not null,
  value text not null,
  updated_at integer not null,
  primary key (user_id, key)
)`);

export const PREFS = {
  computer_use: { values: ["ask", "never"], default: "ask" },
} as const satisfies Record<string, { values: readonly string[]; default: string }>;

export type PrefKey = keyof typeof PREFS;
export type PrefValue<K extends PrefKey> = (typeof PREFS)[K]["values"][number];

const isKey = (k: string): k is PrefKey => Object.hasOwn(PREFS, k);

export function getPref<K extends PrefKey>(userId: string, key: K): PrefValue<K> {
  const row = one<{ value: string }>("select value from person_prefs where user_id = ? and key = ?", userId, key);
  const v = row?.value;
  return (v && (PREFS[key].values as readonly string[]).includes(v) ? v : PREFS[key].default) as PrefValue<K>;
}

/** every preference of a person, defaults filled in */
export function prefsOf(userId: string): { [K in PrefKey]: PrefValue<K> } {
  const set = new Map(all<{ key: string; value: string }>("select key, value from person_prefs where user_id = ?", userId).map((r) => [r.key, r.value]));
  const out: Record<string, string> = {};
  for (const k of Object.keys(PREFS) as PrefKey[]) {
    const v = set.get(k);
    out[k] = v && (PREFS[k].values as readonly string[]).includes(v) ? v : PREFS[k].default;
  }
  return out as { [K in PrefKey]: PrefValue<K> };
}

/** set one of a person's preferences; an unknown key or value is refused (400) */
export function setPref(userId: string, key: string, value: unknown) {
  if (!isKey(key)) throw new HttpError(400, `no preference called “${key}” (there is: ${Object.keys(PREFS).join(", ")})`);
  if (typeof value !== "string" || !(PREFS[key].values as readonly string[]).includes(value)) {
    throw new HttpError(400, `${key} is one of: ${PREFS[key].values.join(", ")}`);
  }
  run(
    "insert into person_prefs (user_id, key, value, updated_at) values (?, ?, ?, ?) on conflict (user_id, key) do update set value = excluded.value, updated_at = excluded.updated_at",
    userId,
    key,
    value,
    Date.now(),
  );
  return prefsOf(userId);
}

/**
 * May agents use machine desktops, as far as this person is concerned:
 * "ask" (a person grants it per machine) or "never". The service token's
 * agent has no person, so it asks.
 */
export function computerUseDefault(userId: string): "ask" | "never" {
  return getPref(userId, "computer_use");
}
