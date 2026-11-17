/**
 * Hermes — Foundation's messenger. Agents (and people) ask teammates for
 * things the board needs, above all the latest CAD, and Hermes keeps the ask
 * alive until it's answered: an ask card on the board, a row in `asks`, and a
 * nudge every few hours (activity on the board; a Slack DM when a bot token
 * is configured). Dropping a file on the ask card resolves it.
 */

import { randomBytes } from "node:crypto";
import { boardMaps, logActivity, uid, appendSection, findSection, type PanelDoc } from "@foundation/protocol";
import { all, one, run } from "./db.ts";
import { editBoard } from "./boards.ts";
import { config } from "./config.ts";
import type { ToolCtx } from "./tools.ts";

export interface AskRow {
  id: string;
  board_id: string;
  panel_id: string | null;
  assignee: string;
  kind: string;
  prompt: string;
  status: string;
  created_by: string;
  created_at: number;
  due_at: number | null;
  last_nudged_at: number | null;
  resolved_file_id: string | null;
  stage_panel_id: string | null;
}

const NUDGE_EVERY = 4 * 3600_000;

export function createAsk(
  ctx: ToolCtx,
  a: { assignee: string; prompt: string; kind: string; section?: string; dueHours?: number; stagePanelId?: string },
): { id: string; panelId: string } {
  const id = `ask_${randomBytes(6).toString("hex")}`;
  const panelId = editBoard(ctx.boardId, "hermes", (doc) => {
    const m = boardMaps(doc);
    const sec = (a.section && (findSection(doc, a.section) ?? appendSection(doc, a.section))) || [...m.sections.values()][0] || appendSection(doc, "Asks");
    const panel: PanelDoc = {
      id: uid("pnl"),
      kind: "panel",
      panel: "ask",
      sectionId: sec.id,
      name: `${a.kind === "cad_upload" ? "CAD needed" : a.kind === "review" ? "Review" : "Ask"} · ${a.assignee}`,
      x: 0,
      y: 0,
      float: false,
      bornAt: Date.now(),
      w: 380,
      h: 220,
      text: a.prompt,
      ports: [{ id: uid("port"), name: "file", dir: "out", type: a.kind === "cad_upload" ? "cad" : "json" }],
      assignee: a.assignee,
      status: "open",
      createdBy: ctx.actor,
      sessionId: id,
    };
    m.objects.set(panel.id, panel);
    logActivity(doc, { who: "Hermes", role: "agent", text: `asked ${a.assignee}: ${a.prompt}`, objectId: panel.id });
    return panel.id;
  });
  run(
    "insert into asks (id, board_id, panel_id, assignee, kind, prompt, status, created_by, created_at, due_at, stage_panel_id) values (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)",
    id, ctx.boardId, panelId, a.assignee, a.kind, a.prompt, ctx.actor, Date.now(), a.dueHours ? Date.now() + a.dueHours * 3600_000 : null, a.stagePanelId ?? null,
  );
  void slackDm(a.assignee, `Foundation · ${ctx.actor} asks: ${a.prompt}\nDrop it on the card: ${config.clientUrl}/?board=${ctx.boardId}&focus=${panelId}`);
  return { id, panelId };
}

export async function resolveAsk(id: string, by: string, fileId?: string) {
  const ask = one<AskRow>("select * from asks where id = ?", id);
  if (!ask) throw new Error("no such ask");
  run("update asks set status = 'done', resolved_file_id = ? where id = ?", fileId ?? null, id);
  if (ask.panel_id) {
    editBoard(ask.board_id, "hermes", (doc) => {
      const m = boardMaps(doc);
      const p = m.objects.get(ask.panel_id!);
      if (p && p.kind === "panel") {
        const outPort = p.ports.find((x) => x.dir === "out");
        m.objects.set(p.id, {
          ...p,
          status: "done",
          fileId: fileId ?? p.fileId,
          outputs: fileId && outPort ? { ...(p.outputs ?? {}), [outPort.id]: { fileId, url: `/files/${fileId}` } } : p.outputs,
        });
      }
      logActivity(doc, { who: "Hermes", role: "agent", text: `${by} answered: ${ask.prompt}`, objectId: ask.panel_id! });
    });
  }
  // an ask raised by a pipeline stage delivers its file to that stage
  if (fileId && ask.stage_panel_id) {
    const { attachToStage } = await import("./pipeline.ts");
    await attachToStage(ask.board_id, ask.stage_panel_id, { fileId }, by).catch(() => {});
  }
  return { ok: true };
}

export function listAsks(boardId?: string) {
  return boardId
    ? all<AskRow>("select * from asks where board_id = ? order by status = 'done', created_at desc", boardId)
    : all<AskRow>("select * from asks order by status = 'done', created_at desc limit 200");
}

async function slackDm(assignee: string, text: string) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token || !assignee.includes("@")) return;
  try {
    const u = (await (await fetch(`https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(assignee)}`, { headers: { authorization: `Bearer ${token}` } })).json()) as { ok: boolean; user?: { id: string } };
    if (!u.ok || !u.user) return;
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel: u.user.id, text }),
    });
  } catch {
    /* Slack is best-effort; the board card is the source of truth */
  }
}

/** Every few minutes: nudge open asks that have waited long enough. */
export function startHermes() {
  const tick = () => {
    const now = Date.now();
    for (const ask of all<AskRow>("select * from asks where status = 'open'")) {
      const last = ask.last_nudged_at ?? ask.created_at;
      if (now - last < NUDGE_EVERY) continue;
      run("update asks set last_nudged_at = ? where id = ?", now, ask.id);
      const overdue = ask.due_at && now > ask.due_at;
      editBoard(ask.board_id, "hermes", (doc) =>
        logActivity(doc, { who: "Hermes", role: "agent", text: `${overdue ? "overdue — " : ""}still waiting on ${ask.assignee}: ${ask.prompt}`, objectId: ask.panel_id ?? undefined }),
      );
      void slackDm(ask.assignee, `Friendly nudge from Foundation: ${ask.prompt}`);
    }
  };
  setInterval(tick, 5 * 60_000).unref();
}
