/**
 * The plan board (docs/plan.json): Foundation's own kanban, the local copy of
 * the cards on GitHub. Anyone signed in reads it (Settings → Plan). An admin,
 * pressing it themselves, can move a card to another column or make a new
 * one; both write the file and wait for a sync. Sync with GitHub runs
 * `scripts/plan.mjs sync` through the server's gh login: it reads the issues
 * first, then sends only the moved columns and the new cards, so it never
 * overwrites what the team wrote on GitHub. Nothing reaches GitHub until a
 * person presses Sync.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { UserInfo } from "@foundation/protocol";
import { HttpError } from "./http.ts";

export interface PlanCard {
  id: string;
  title: string;
  kind: "bug" | "plan" | "hookup";
  milestone: string;
  area: string;
  status: string;
  body: string;
  issue?: number | null;
  /** moved in the app since the last push to GitHub */
  moved?: { by: string; at: number; from: string } | null;
}
export interface Plan {
  about: string;
  repo: string;
  syncedAt: string | null;
  columns: Array<{ id: string; name: string; hint: string }>;
  milestones: Array<{ id: string; name: string; about: string }>;
  cards: PlanCard[];
}

export function planFile(): string {
  return process.env.FOUNDATION_PLAN_FILE ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "plan.json");
}

export function readPlan(): Plan | null {
  const file = planFile();
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as Plan;
}

/** Moves one card to another column. Admins only, and only a person (an agent can't reorder the company's plan). */
export function movePlanCard(by: UserInfo, id: string, status: string): PlanCard {
  if (by.role !== "admin") throw new HttpError(403, "Only an admin can move cards on the plan");
  const plan = readPlan();
  if (!plan) throw new HttpError(404, "There's no plan file on this server (docs/plan.json)");
  if (!plan.columns.some((c) => c.id === status)) throw new HttpError(400, `No column "${status}"`);
  const card = plan.cards.find((c) => c.id === id);
  if (!card) throw new HttpError(404, `No card "${id}" on the plan`);
  if (card.status !== status) {
    // the column it had on GitHub is kept, so moving it back clears the mark
    const from = card.moved?.from ?? card.status;
    card.status = status;
    card.moved = status === from ? null : { by: by.name, at: Date.now(), from };
    if (!card.moved) delete card.moved;
    writePlan(plan);
  }
  return card;
}

function writePlan(plan: Plan) {
  const file = planFile();
  const tmp = join(dirname(file), `.plan.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(plan, null, 2) + "\n");
  renameSync(tmp, file);
}

export interface NewCard {
  title?: string;
  kind?: string;
  milestone?: string;
  area?: string;
  body?: string;
  request_id?: string;
}

/** "Wires collide at the far end" → "wires-collide-at-the-far-end", made unique on the plan */
export function cardId(title: string, taken: Set<string>) {
  const base =
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .split("-")
      .slice(0, 6)
      .join("-") || "card";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/** request_id → card id: a doubled press makes one card */
const made = new Map<string, string>();

/** Makes a card on the plan (admins, as a person). It has no issue until the next sync. */
export function createPlanCard(by: UserInfo, input: NewCard): PlanCard {
  if (by.role !== "admin") throw new HttpError(403, "Only an admin can add cards to the plan");
  const plan = readPlan();
  if (!plan) throw new HttpError(404, "There's no plan file on this server (docs/plan.json)");
  if (input.request_id && made.has(input.request_id)) {
    const again = plan.cards.find((c) => c.id === made.get(input.request_id!));
    if (again) return again;
  }
  const title = input.title?.trim() ?? "";
  if (title.length < 4 || title.length > 140) throw new HttpError(400, "A card needs a title (4 to 140 characters)");
  const kind = (input.kind ?? "plan") as PlanCard["kind"];
  if (!["bug", "plan", "hookup"].includes(kind)) throw new HttpError(400, "kind is bug, plan or hookup");
  const milestone = input.milestone ?? plan.milestones[plan.milestones.length - 1]?.id;
  if (!plan.milestones.some((m) => m.id === milestone)) throw new HttpError(400, `No milestone "${milestone}"`);
  const area = (input.area?.trim() || "general").toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const card: PlanCard = {
    id: cardId(title, new Set(plan.cards.map((c) => c.id))),
    title,
    kind,
    milestone: milestone!,
    area,
    // waiting on a person goes to Needs you; everything else waits its turn
    status: kind === "hookup" ? "needs-you" : "backlog",
    body: input.body?.trim() || `Added by ${by.name} in Settings → Plan.`,
    issue: null,
  };
  plan.cards.push(card);
  writePlan(plan);
  if (input.request_id) made.set(input.request_id, card.id);
  return card;
}

export function scriptFile(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "plan.mjs");
}

let syncing: Promise<{ plan: Plan; summary: SyncSummary; log: string }> | null = null;
export interface SyncSummary {
  moved: number;
  created: number;
  cards: number;
}

/**
 * Sync with GitHub (admins, as a person): `scripts/plan.mjs sync` on this
 * server's plan file, through its gh login. One at a time; a second press
 * waits for the first.
 */
export async function syncPlan(by: UserInfo): Promise<{ plan: Plan; summary: SyncSummary; log: string }> {
  if (by.role !== "admin") throw new HttpError(403, "Only an admin can sync the plan with GitHub");
  if (!readPlan()) throw new HttpError(404, "There's no plan file on this server (docs/plan.json)");
  if (syncing) return syncing;
  syncing = new Promise<{ plan: Plan; summary: SyncSummary; log: string }>((ok, fail) => {
    const child = spawn(process.execPath, [scriptFile(), "sync"], {
      env: { ...process.env, FOUNDATION_PLAN_FILE: planFile() },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      fail(new HttpError(502, `Couldn't start the sync: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const line = /^SYNC (.+)$/m.exec(out)?.[1];
      if (code !== 0 || !line) {
        const why = (err || out).trim().split("\n").slice(-3).join(" ").slice(0, 400) || `exit ${code}`;
        return fail(new HttpError(502, /gh: (command )?not found|ENOENT|not recognized/i.test(why) ? "GitHub isn't reachable from this server: sign in with gh (gh auth login)" : `GitHub sync failed: ${why}`));
      }
      ok({ plan: readPlan()!, summary: JSON.parse(line) as SyncSummary, log: out.replace(/^SYNC .+$/m, "").trim() });
    });
  }).finally(() => {
    syncing = null;
  });
  return syncing;
}
