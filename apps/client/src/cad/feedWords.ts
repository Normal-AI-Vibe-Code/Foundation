/**
 * What a fed CAD card says about where its model comes from (docs/cad-feed.md): pure, so it's tested and the
 * design page draws every state without a server. The strip itself is cad/CadFeedStrip.tsx.
 */
import type { CadFeed } from "@foundation/protocol";

export function since(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

export interface FeedWords {
  /** "From Airform BOM · Fan hub, rev C" */
  source: string;
  /** "changed 3 min ago · checked just now", or empty before the first fetch */
  when: string;
  tone: "ok" | "waiting" | "error" | "unlinked";
  /** what it waits on, what went wrong, or that it's an orphan now */
  note: string | null;
}

export function feedWords(feed: CadFeed, linked: boolean, now: number): FeedWords {
  const source = `From ${feed.appName || "an app"}${feed.label ? ` · ${feed.label}` : ""}`;
  const when = [feed.changedAt ? `changed ${since(feed.changedAt, now)}` : "", feed.checkedAt ? `checked ${since(feed.checkedAt, now)}` : ""].filter(Boolean).join(" · ");
  if (!linked) return { source, when: feed.changedAt ? `changed ${since(feed.changedAt, now)}` : "", tone: "unlinked", note: "Unlinked: keeps its last model" };
  if (feed.state === "waiting") return { source, when, tone: "waiting", note: feed.note || `Waiting on ${feed.appName || "the app"}` };
  if (feed.state === "error") return { source, when, tone: "error", note: feed.note || `${feed.appName || "The app"} didn't give the model` };
  return { source, when, tone: "ok", note: null };
}
