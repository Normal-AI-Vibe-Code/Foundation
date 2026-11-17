/**
 * The plan board's model: docs/plan.json, bundled into the app as the local
 * copy (so Settings → Plan opens even offline), then refreshed from the
 * server's file, which is where a move made in the app lands (SettingsPage).
 */

import planJson from "../../../../docs/plan.json";

export type CardKind = "bug" | "plan" | "hookup";
export interface PlanCard {
  id: string;
  title: string;
  kind: CardKind;
  milestone: string;
  area: string;
  status: string;
  body: string;
  issue?: number | null;
  moved?: { by: string; at: number; from: string } | null;
}
export interface PlanColumn {
  id: string;
  name: string;
  hint: string;
}
export interface Plan {
  about: string;
  repo: string;
  syncedAt: string | null;
  columns: PlanColumn[];
  milestones: Array<{ id: string; name: string; about: string }>;
  cards: PlanCard[];
}

export const PLAN = planJson as Plan;

export interface PlanFilter {
  kind?: CardKind;
  milestone?: string;
  query?: string;
}

/** The columns in board order, each with its cards (filtered), in the file's order. */
export function boardColumns(plan: Plan, filter: PlanFilter): Array<PlanColumn & { cards: PlanCard[] }> {
  const q = filter.query?.trim().toLowerCase();
  const keep = (c: PlanCard) =>
    (!filter.kind || c.kind === filter.kind) &&
    (!filter.milestone || c.milestone === filter.milestone) &&
    (!q || c.title.toLowerCase().includes(q) || c.body.toLowerCase().includes(q) || c.area.includes(q) || String(c.issue ?? "") === q.replace(/^#/, ""));
  return plan.columns.map((col) => ({ ...col, cards: plan.cards.filter((c) => c.status === col.id && keep(c)) }));
}

export function counts(plan: Plan) {
  const by = (k: CardKind) => plan.cards.filter((c) => c.kind === k && c.status !== "done").length;
  return { bug: by("bug"), plan: by("plan"), hookup: by("hookup"), open: plan.cards.filter((c) => c.status !== "done").length };
}

export const issueUrl = (plan: Plan, n: number) => `https://github.com/${plan.repo}/issues/${n}`;

/** "just now", "4 min ago", "3 h ago", "2 days ago" */
export function ago(iso: string | number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} ${d === 1 ? "day" : "days"} ago`;
}

/** what the last sync did: "Synced: 1 move sent, 2 new cards are issues." */
export function syncSentence(s: { moved: number; created: number }) {
  const parts = [s.moved ? `${s.moved} ${s.moved === 1 ? "move" : "moves"} sent` : "", s.created ? `${s.created} new ${s.created === 1 ? "card is an issue" : "cards are issues"}` : ""].filter(Boolean);
  return parts.length ? `Synced: ${parts.join(", ")}.` : "Synced: GitHub and this board agree.";
}

/** "2 moved and 1 new here" */
export function waitingWords(moved: number, fresh: number) {
  return `${[moved ? `${moved} moved` : "", fresh ? `${fresh} new` : ""].filter(Boolean).join(" and ")} here`;
}
