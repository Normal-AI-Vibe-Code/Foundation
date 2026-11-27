/**
 * Which server this is, in words (the server panel and ChatForm's note; ServerAbout.tsx). Pure, so it's
 * tested on its own (test/serverInfo.test.ts).
 */
import { isLocalServer } from "./model";

/** where the server is, as a person would say it */
export type Where = "this-computer" | "network" | "hosted";

const PRIVATE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/;

/** this computer, another on the network, or a hosted one: from the address the app uses and what the server says */
export function whereIs(current: string, info: { kind: "local" | "network" | "hosted" } | null): Where {
  if (isLocalServer(current)) return "this-computer";
  let host = "";
  try {
    host = new URL(current).hostname.toLowerCase();
  } catch {
    /* not an address */
  }
  if (PRIVATE.test(host) || host.endsWith(".local") || (host && !host.includes(".")) || info?.kind === "network") return "network";
  return "hosted";
}

export const WHERE_LABEL: Record<Where, string> = {
  "this-computer": "This computer",
  network: "Another computer on your network",
  hosted: "A hosted Foundation",
};
/** the dim line ChatForm's strip shows */
export const WHERE_NOTE: Record<Where, string> = {
  "this-computer": "on this computer",
  network: "on a computer on your network",
  hosted: "on a hosted server",
};

/** "since 09:14 · 3 h" */
export function upSince(startedAt: number, now = Date.now()): string {
  const d = new Date(startedAt);
  const clock = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const mins = Math.max(0, Math.floor((now - startedAt) / 60_000));
  const span = mins < 1 ? "just now" : mins < 60 ? `${mins} min` : mins < 48 * 60 ? `${Math.round(mins / 60)} h` : `${Math.round(mins / 1440)} days`;
  const day = now - startedAt > 20 * 3600_000 ? `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ` : "";
  return `since ${day}${clock} · ${span}`;
}

/** "2 people", "1 person", "no one" */
export const peopleNow = (n: number) => (n === 0 ? "no one" : n === 1 ? "1 person" : `${n} people`);

/** what it serves, in words */
export function servesLine(serves: string[]): string {
  const words = serves.map((s) => (s === "chat" ? "ChatForm" : s));
  const list = words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}` : (words[0] ?? "");
  return `${list.charAt(0).toUpperCase()}${list.slice(1)}.`;
}


/** a `git describe` (`v0.3.58-4-g24521f71`): the release it's from and commits since; null when it doesn't say */
function described(s: string | null | undefined): { tag: number[]; ahead: number; sha: string } | null {
  const m = /^v(\d+)\.(\d+)\.(\d+)-(\d+)-g([0-9a-f]{4,40})(-dirty)?$/.exec((s ?? "").trim());
  return m ? { tag: [Number(m[1]), Number(m[2]), Number(m[3])], ahead: Number(m[4]), sha: m[5] } : null;
}

/**
 * Is the server's code older than this app's (plan *server-older-than-app*)? The app updates itself; a server
 * started from a checkout runs what it was started with, and both say 0.3.0, so they're compared by where each
 * is in the release history: an earlier release, or the same release with fewer commits since. Null when it
 * can't be told (either doesn't say, or the two are side by side on different branches): it says nothing then.
 */
export function serverOlder(server: string | null | undefined, app: string | null | undefined): { words: string } | null {
  const s = described(server);
  const a = described(app);
  if (!s || !a || s.sha === a.sha || a.sha.startsWith(s.sha) || s.sha.startsWith(a.sha)) return null;
  const order = s.tag[0] - a.tag[0] || s.tag[1] - a.tag[1] || s.tag[2] - a.tag[2];
  const name = (d: { tag: number[]; ahead: number }) => `v${d.tag.join(".")}${d.ahead ? ` +${d.ahead}` : ""}`;
  if (order < 0 || (order === 0 && s.ahead < a.ahead)) {
    return { words: `This server runs older code than this app (${name(s)}, the app is ${name(a)}). What's newer in the app won't work until it restarts.` };
  }
  return null;
}
