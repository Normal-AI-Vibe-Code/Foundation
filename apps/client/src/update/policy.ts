/**
 * When Foundation's desktop app checks for an update, when it offers one, and what it remembers
 * across a restart. Pure, so the rules are tested without a feed or an installer (test/update.test.ts).
 * The same rules as Vision's (its ADR-055), so the two apps behave alike:
 *
 * - An installed build checks once, a few seconds after launch, when the network is up. Development
 *   builds (`tauri dev`) and the browser never check: installing there would overwrite the installed app.
 * - Nothing downloads until a person presses Update, and nothing retries by itself.
 * - "Later" hides the card until the next launch; "Skip this version" hides that version until a newer one.
 * - Before installing, the app notes the version and its release notes; the first launch of that
 *   version shows them once ("Updated to …"), then forgets them.
 */

import { belowMinimum, compareVersions } from "@foundation/protocol";

export { compareVersions };

export const PREFS_KEY = "foundation.update.v1";
/** how long after launch the first check waits, so the board opens first */
export const LAUNCH_DELAY_MS = 8_000;
/** an app left open for days still hears about a release: it asks again this often (quietly) */
export const RECHECK_MS = 6 * 60 * 60 * 1000;

export interface PendingUpdate {
  version: string;
  from: string;
  notes?: string | null;
  date?: string | null;
}
export interface UpdatePrefs {
  skipped?: string;
  pending?: PendingUpdate;
}

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const optStr = (v: unknown) => v === undefined || v === null || typeof v === "string";

/** Stored prefs, or none when missing or unreadable (a bad value never blocks an update). */
export function parsePrefs(raw: string | null | undefined): UpdatePrefs {
  if (!raw) return {};
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const o = v as Record<string, unknown>;
  const out: UpdatePrefs = {};
  if (o.skipped !== undefined) {
    if (!str(o.skipped)) return {};
    out.skipped = o.skipped;
  }
  if (o.pending !== undefined) {
    const p = o.pending as Record<string, unknown> | null;
    if (!p || typeof p !== "object" || !str(p.version) || !str(p.from) || !optStr(p.notes) || !optStr(p.date)) return {};
    out.pending = { version: p.version, from: p.from, notes: (p.notes as string | null | undefined) ?? null, date: (p.date as string | null | undefined) ?? null };
  }
  return out;
}

export function readPrefs(): UpdatePrefs {
  try {
    return parsePrefs(localStorage.getItem(PREFS_KEY));
  } catch {
    return {};
  }
}

export function writePrefs(prefs: UpdatePrefs) {
  try {
    if (!prefs.skipped && !prefs.pending) localStorage.removeItem(PREFS_KEY);
    else localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* storage off: the card simply asks again next launch */
  }
}

/** Whether this launch may check the feed by itself. */
export function mayCheckOnLaunch(env: { desktop: boolean; dev: boolean; online: boolean }): boolean {
  return env.desktop && !env.dev && env.online;
}

/**
 * The minimum this client is under, if the server names one it doesn't meet (else null). The server
 * says the oldest client it still works with (`FOUNDATION_MIN_CLIENT`, on `/auth/config`); under it,
 * the update isn't one to put off: Later and Skip aren't offered, and the card stays up.
 */
export function minimumOver(current: string | null | undefined, min: string | null | undefined): string | null {
  return belowMinimum(current, min) ? (min as string).replace(/^v/, "") : null;
}

/** Whether to put the card up for a version the feed offers. A manual check always shows it, and so does one the server needs. */
export function shouldOffer(version: string, prefs: UpdatePrefs, opts: { manual: boolean; laterThisLaunch: boolean; required?: boolean }): boolean {
  if (opts.manual || opts.required) return true;
  if (opts.laterThisLaunch) return false;
  return prefs.skipped !== version;
}

/**
 * On launch: the update installed before this launch, if this is its first run, and the prefs to
 * store afterwards. A pending note for any other version (the install failed or was cancelled) is
 * dropped. A skip older than or equal to what now runs is dropped too.
 */
export function settleOnLaunch(current: string, prefs: UpdatePrefs): { whatsNew: PendingUpdate | null; prefs: UpdatePrefs } {
  const whatsNew = prefs.pending && prefs.pending.version === current ? prefs.pending : null;
  const next: UpdatePrefs = {};
  if (prefs.skipped && compareVersions(prefs.skipped, current) > 0) next.skipped = prefs.skipped;
  return { whatsNew, prefs: next };
}

/** A plugin or network error in a sentence a person can act on. */
export function explainError(e: unknown, step: "check" | "install"): string {
  const raw = (e instanceof Error ? e.message : String(e ?? "")).trim();
  if (/signature/i.test(raw)) return "The download's signature didn't match Foundation's key, so nothing was installed.";
  if (step === "check" && /valid release JSON|404|not found/i.test(raw)) return "No version has been published to the feed yet.";
  if (/timed? ?out|network|dns|connect|offline|unreachable|error sending request/i.test(raw))
    return step === "check"
      ? "Foundation works offline as usual and checks again next time it opens."
      : "The download stopped: the network dropped. Nothing was installed.";
  const short = raw.length > 160 ? `${raw.slice(0, 157)}…` : raw;
  return short ? `${short}. Nothing was installed.` : "Nothing was installed. Foundation keeps the version you have.";
}

// ------------------------------------------------------------ the card's words

/** The first `max` lines of release notes as plain sentences: headings skipped, bullets and links stripped. */
export function noteLines(notes: string | null | undefined, max = 4): string[] {
  if (!notes) return [];
  const out: string[] = [];
  for (const raw of notes.split(/\r?\n/)) {
    // headings name sections ("## Fixes", "# Foundation 0.3.0"); the card already says the version
    if (/^\s*#{1,6}\s/.test(raw)) continue;
    const line = raw
      .replace(/^\s*([-*+]\s+|\d+[.)]\s+|>\s*)/, "")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/(\*\*|__|`)/g, "")
      .trim();
    if (!line || /^[-*_]{3,}$/.test(line)) continue;
    out.push(line);
    if (out.length === max) break;
  }
  return out;
}

const MB = 1024 * 1024;

/** "4.2 of 10.0 MB", or "4.2 MB" when the size is unknown; one decimal up to 10 MB. */
export function progressLabel(received = 0, total?: number | null): string {
  const digits = (total ?? received) <= 10 * MB ? 1 : 0;
  const mb = (n: number) => (n / MB).toFixed(digits);
  return total ? `${mb(Math.min(received, total))} of ${mb(total)} MB` : `${mb(received)} MB`;
}

/** "8 Nov": the publish date as the feed states it (UTC), the same in any time zone. */
export function shortDate(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}
