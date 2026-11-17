/**
 * A design pipeline stage — one panel per step of design → CAD → simulation →
 * review → release. It shows where the stage stands, what it holds (renders,
 * STEP files with their measured size, results, decisions), what's left on
 * its checklist, and the one hand-off that moves it forward. Drop files on it
 * to attach them; complete it to send its output down the wire.
 *
 * Every action goes through the board tools (the same ones agents use), so a
 * person and an agent working a pipeline leave the same trail.
 */

import { useState } from "react";
import { STAGES, stageDef, type Artifact } from "@foundation/protocol";
import type { PanelMeta } from "../state/store";
import { api, uploadFile } from "../lib/api";
import { fileLink, useFileSrc } from "../lib/fileSrc";
import { activeBoard } from "../sync/board";
import { askAgent, toast } from "../state/ui";

const STATUS: Record<string, { label: string; tone: string }> = {
  idle: { label: "Waiting", tone: "idle" },
  open: { label: "Active", tone: "open" },
  done: { label: "Done", tone: "done" },
  error: { label: "Blocked", tone: "error" },
};

const HANDOFF: Partial<Record<string, string>> = {
  concept: "◈ Explore in Vision",
  cad: "✉ Ask for the STEP",
  simulate: "≋ Run in Vision",
  review: "◎ Ask reviewers",
};

const DROP_HINT: Record<string, string> = {
  brief: "Drop references, specs or sketches",
  concept: "Drop renders and sketches — ★ the one to take forward",
  cad: "Drop the STEP — it's measured on arrival",
  simulate: "Drop results: plots, CSV, reports",
  review: "Drop markups or notes",
  release: "Drop the BOM export or drawings",
};

const ANALYSES = ["CFD", "FEA", "Thermal", "RF", "Motion", "Acoustics"];

function tool<T = unknown>(name: string, input: Record<string, unknown>) {
  const board = activeBoard()?.boardId ?? "company";
  return api<{ result: T }>(`/api/boards/${encodeURIComponent(board)}/tools/${name}`, { method: "POST", json: input }).then((r) => r.result);
}

export function StageBody({ panel }: { panel: PanelMeta }) {
  const def = stageDef(panel.stage);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [uploading, setUploading] = useState<number | null>(null);
  if (!def) return null;
  const status = STATUS[panel.status ?? "idle"] ?? STATUS.idle;
  const arts = panel.artifacts ?? [];
  const checklist = panel.checklist ?? [];
  const doneCount = checklist.filter((c) => c.done).length;
  const waiting = panel.status === "idle";
  const prev = STAGES[STAGES.findIndex((x) => x.key === def.key) - 1];
  const [editing, setEditing] = useState(false);

  const run = async (label: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(label);
    try {
      await fn();
      if (ok) toast(ok, "ok");
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setBusy(null);
    }
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOver(false);
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    const board = activeBoard()?.boardId ?? "company";
    for (const f of files) {
      try {
        const up = await uploadFile(f, board, setUploading);
        const art = await tool<Artifact>("stage_attach", { stage_panel: panel.id, file_id: up.id });
        toast(art.note ? `${art.name} · ${art.note}` : `${art.name} attached`, "ok");
      } catch (err) {
        toast(`${f.name}: ${(err as Error).message}`, "bad");
      }
    }
    setUploading(null);
  };

  const complete = (decision?: "approved" | "changes") =>
    run(
      "complete",
      () => tool("complete_stage", { stage_panel: panel.id, ...(decision ? { decision } : {}) }),
      decision === "changes" ? "Sent back — CAD and Simulate reopened" : `${def.title} done → next stage open`,
    );

  return (
    <div
      className={`stage-body tone-${status.tone}${over ? " is-over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <div className="stage-head">
        <span className="stage-glyph">{def.glyph}</span>
        {/* the card rests without a bar, so the stage names itself */}
        <span className="stage-name">{panel.name}</span>
        <span className={`stage-status is-${status.tone}`}>{status.label}</span>
        {panel.assignee && <span className="stage-owner" title="Owner">{panel.assignee}</span>}
        <span className="stage-progress" title="Checklist">
          {doneCount}/{checklist.length}
        </span>
      </div>

      {editing ? (
        <textarea
          className="stage-edit"
          autoFocus
          defaultValue={panel.text}
          onBlur={(e) => {
            setEditing(false);
            if (e.target.value !== panel.text) void tool("update_card", { id: panel.id, text: e.target.value });
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) (e.target as HTMLTextAreaElement).blur();
          }}
        />
      ) : (
        <p
          className={`stage-text${panel.stage === "brief" ? " is-brief is-editable" : ""}`}
          title={panel.stage === "brief" ? "Click to edit the brief" : undefined}
          onClick={() => panel.stage === "brief" && panel.status !== "done" && setEditing(true)}
        >
          {panel.text}
        </p>
      )}

      {panel.stage === "simulate" && (
        <div className="stage-settings">
          <select
            value={panel.settings?.analysis ?? ""}
            onChange={(e) => void tool("stage_settings", { stage_panel: panel.id, settings: { analysis: e.target.value } })}
            title="Analysis"
          >
            <option value="">Analysis…</option>
            {ANALYSES.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
          <input
            defaultValue={panel.settings?.loads ?? ""}
            placeholder="Loads / conditions"
            onBlur={(e) => e.target.value !== (panel.settings?.loads ?? "") && void tool("stage_settings", { stage_panel: panel.id, settings: { loads: e.target.value } })}
          />
          <input
            defaultValue={panel.settings?.target ?? ""}
            placeholder="Pass if…"
            onBlur={(e) => e.target.value !== (panel.settings?.target ?? "") && void tool("stage_settings", { stage_panel: panel.id, settings: { target: e.target.value } })}
          />
        </div>
      )}

      <div className="stage-artifacts">
        {arts.length === 0 ? (
          <div className="stage-drop">
            {uploading !== null ? (
              <div className="upload-bar" style={{ ["--p" as string]: String(uploading) }} />
            ) : waiting && prev ? (
              `Opens when ${prev.title} is done — or drop work here early`
            ) : (
              DROP_HINT[def.key]
            )}
          </div>
        ) : (
          arts.map((a) => <ArtifactTile key={a.id} a={a} onChoose={() => void tool("stage_choose", { stage_panel: panel.id, artifact_id: a.id })} />)
        )}
      </div>

      <ul className="stage-checklist">
        {checklist.map((c, i) => (
          <li key={i}>
            <button className={c.done ? "is-done" : ""} onClick={() => void tool("stage_check", { stage_panel: panel.id, index: i, done: !c.done })}>
              <span className="tick">{c.done ? "✓" : ""}</span>
              {c.text}
            </button>
          </li>
        ))}
      </ul>

      <div className="stage-actions">
        {panel.status === "done" ? (
          <span className="stage-done-note">Handed to the next stage</span>
        ) : (
          <>
            {HANDOFF[def.key] && (
              <button
                className="f-pill is-agent"
                disabled={busy !== null}
                onClick={() =>
                  def.key === "cad" && !panel.assignee
                    ? askAgent(`Who should model the CAD for this pipeline? Then ask them for the STEP on the stage “${panel.name}”.`)
                    : void run("handoff", () => tool("stage_request", { stage_panel: panel.id }), def.key === "cad" ? `Asked ${panel.assignee} — Hermes will follow up` : def.key === "review" ? "Reviewers asked" : "Vision brief written")
                }
              >
                {busy === "handoff" ? "…" : HANDOFF[def.key]}
              </button>
            )}
            {def.key === "review" ? (
              <>
                <button className="f-pill" disabled={busy !== null} onClick={() => complete("changes")}>
                  Request changes
                </button>
                <button className="f-pill is-primary" disabled={busy !== null || waiting} onClick={() => complete("approved")}>
                  Approve
                </button>
              </>
            ) : (
              <button className="f-pill is-primary" disabled={busy !== null || waiting} title={waiting ? "Waiting on the previous stage" : undefined} onClick={() => complete()}>
                {def.key === "release" ? "Release" : "Complete →"}
              </button>
            )}
          </>
        )}
      </div>
      {over && <div className="stage-over">Drop to add to {def.title}</div>}
    </div>
  );
}

function ArtifactTile({ a, onChoose }: { a: Artifact; onChoose(): void }) {
  const href = a.fileId ? `/files/${a.fileId}` : a.url;
  const img = useFileSrc(a.kind === "image" ? href : undefined);
  return (
    <div className={`artifact kind-${a.kind}${a.chosen ? " is-chosen" : ""}`} title={`${a.name}${a.note ? ` — ${a.note}` : ""} · ${a.by}`}>
      <a className="artifact-face" {...(href ? fileLink(href) : {})} target="_blank" rel="noreferrer">
        {a.kind === "image" && href ? (
          <img src={img} alt={a.name} loading="lazy" decoding="async" />
        ) : (
          <span className="artifact-glyph">{a.kind === "cad" ? "⬡" : a.kind === "decision" ? "◎" : a.kind === "data" ? "≋" : "▤"}</span>
        )}
      </a>
      <div className="artifact-meta">
        <span className="artifact-name">{a.name}</span>
        {a.note && <span className="artifact-note">{a.note}</span>}
      </div>
      {a.kind !== "decision" && (
        <button className={`artifact-star${a.chosen ? " is-on" : ""}`} onClick={onChoose} title="Take this one forward">
          ★
        </button>
      )}
    </div>
  );
}
