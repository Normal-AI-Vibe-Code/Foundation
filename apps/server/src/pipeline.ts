/**
 * Design pipelines — design → CAD → simulation → release, panel by panel.
 *
 * A pipeline is a section holding six stage panels (STAGES in the protocol),
 * wired output → input in order. A stage collects artifacts (renders, STEP
 * files, results, decisions) and a checklist; completing it puts its chosen
 * artifact on its output port, which the wire carries to the next stage, and
 * opens that stage. People and agents drive the same functions (tools.ts).
 *
 * Stage status: idle = waiting on the previous stage · open = active ·
 * done = complete · error = blocked.
 */

import * as Y from "yjs";
import {
  appendSection,
  boardMaps,
  readTracks,
  logActivity,
  stageDef,
  STAGES,
  uid,
  type Artifact,
  type LinkDoc,
  type PanelDoc,
} from "@foundation/protocol";
import { editBoard, getBoard } from "./boards.ts";
import { cadSummaryForFile } from "./cad.ts";
import { one } from "./db.ts";
import type { FileRow } from "./files.ts";

const COL = 520;
const ROW = 560;
/**
 * The first column's extra distance from the section's left wall. The wire from
 * CAD back round to Simulate turns into that column's input from the left;
 * with only the section's 28 px pad it had about 14 px to turn in (a tight hook).
 */
export const LEFT_ROOM = 28;
export const STAGE_W = 460;
export const STAGE_H = 440;

function stagePanel(doc: Y.Doc, id: string): PanelDoc {
  const o = boardMaps(doc).objects.get(id);
  if (!o || o.kind !== "panel" || o.panel !== "stage") throw new Error(`no stage ${id}`);
  return o;
}

export function pipelineStages(doc: Y.Doc, pipeline: string): PanelDoc[] {
  return [...boardMaps(doc).objects.values()]
    .filter((o): o is PanelDoc => o.kind === "panel" && o.panel === "stage" && o.pipeline === pipeline)
    .sort((a, b) => STAGES.findIndex((s) => s.key === a.stage) - STAGES.findIndex((s) => s.key === b.stage));
}

export function startPipeline(
  boardId: string,
  actor: string,
  p: { name: string; goal: string; owner?: string; cadOwner?: string; reviewers?: string[]; analysis?: string },
) {
  return editBoard(boardId, "pipeline", (doc) => {
    const m = boardMaps(doc);
    const sec = appendSection(doc, `Design · ${p.name}`);
    // room for the 3 × 2 stages plus a fourth column for Vision briefs and asks
    const tracks = readTracks(doc);
    tracks.cols = tracks.cols.map((w, i) => (i === sec.c0 ? Math.max(w, 2160) : w));
    m.grid.set("tracks", tracks);
    const pipeline = uid("pipe");
    const panels: PanelDoc[] = STAGES.map((def, i) => {
      const panel: PanelDoc = {
        id: uid("pnl"),
        kind: "panel",
        panel: "stage",
        pipeline,
        stage: def.key,
        sectionId: sec.id,
        name: `${String(i + 1).padStart(2, "0")} · ${def.title}`,
        // a snake of 3 × 2: Brief → Concept → CAD, then Simulate → Review → Release
        x: LEFT_ROOM + (i % 3) * COL,
        y: Math.floor(i / 3) * ROW,
        float: true,
        bornAt: Date.now() + i,
        w: STAGE_W,
        h: STAGE_H,
        text: i === 0 ? p.goal : def.purpose,
        status: i === 0 ? "open" : "idle",
        assignee: def.key === "cad" ? p.cadOwner : def.key === "review" ? p.reviewers?.join(", ") : i === 0 ? p.owner : undefined,
        ports: [
          ...(i > 0 ? [{ id: uid("port"), name: STAGES[i - 1].out.name, dir: "in" as const, type: STAGES[i - 1].out.type }] : []),
          { id: uid("port"), name: def.out.name, dir: "out", type: def.out.type },
        ],
        artifacts: [],
        checklist: def.checklist.map((text) => ({ text, done: false })),
        settings: def.key === "simulate" && p.analysis ? { analysis: p.analysis } : {},
        createdBy: actor,
      };
      for (const k of Object.keys(panel) as Array<keyof PanelDoc>) if (panel[k] === undefined) delete panel[k];
      m.objects.set(panel.id, panel);
      return panel;
    });
    for (let i = 0; i < panels.length - 1; i++) {
      const a = panels[i];
      const b = panels[i + 1];
      const l: LinkDoc = {
        id: uid("lnk"),
        from: { panel: a.id, port: a.ports.find((x) => x.dir === "out")!.id },
        to: { panel: b.id, port: b.ports.find((x) => x.dir === "in")!.id },
        label: STAGES[i].out.name,
        createdBy: actor,
      };
      m.links.set(l.id, l);
    }
    logActivity(doc, { who: actor, role: actor.includes("agent") || actor.includes("Agent") ? "agent" : "human", text: `started the design pipeline “${p.name}”`, objectId: panels[0].id });
    return { pipeline, section: sec.id, stages: panels.map((x) => ({ id: x.id, stage: x.stage })) };
  });
}

/** Attach a file or link to a stage. CAD gets measured; checklists tick themselves where the evidence is unambiguous. */
export async function attachToStage(
  boardId: string,
  panelId: string,
  a: { fileId?: string; url?: string; name?: string; kind?: string; note?: string },
  by: string,
) {
  let name = a.name ?? a.url ?? "attachment";
  let mime: string | undefined;
  let kind = a.kind;
  let note = a.note;
  if (a.fileId) {
    const f = one<FileRow>("select * from files where id = ?", a.fileId);
    if (!f) throw new Error("no such file");
    name = a.name ?? f.name;
    mime = f.mime;
    if (/\.(step|stp|iges|igs|stl|obj|3mf|glb|gltf|f3d|sldprt|sldasm|x_t)$/i.test(f.name)) {
      kind = "cad";
      const s = await cadSummaryForFile(a.fileId).catch(() => null);
      if (s) note = s.note + (s.products.length ? ` · ${s.products.slice(0, 3).join(", ")}` : "");
    } else if (f.mime.startsWith("image/") || f.mime.startsWith("video/")) kind = "image";
    else if (/csv|json|spreadsheet|excel/.test(f.mime) || /\.(csv|xlsx?|json|vtk|vtu)$/i.test(f.name)) kind = "data";
    else kind ??= "doc";
  }
  const art: Artifact = { id: uid("art"), name, kind: kind ?? "link", fileId: a.fileId, url: a.url, mime, note, by, at: Date.now() };
  for (const k of Object.keys(art) as Array<keyof Artifact>) if (art[k] === undefined) delete art[k];
  editBoard(boardId, "pipeline", (doc) => {
    const p = stagePanel(doc, panelId);
    const artifacts = [...(p.artifacts ?? []), art];
    const checklist = (p.checklist ?? []).map((c) => {
      const t = c.text.toLowerCase();
      if (art.kind === "cad" && /step uploaded/.test(t)) return { ...c, done: true };
      if (art.kind === "cad" && /units and envelope/.test(t) && art.note && !/no geometry/.test(art.note)) return { ...c, done: true };
      if (p.stage === "simulate" && art.kind !== "cad" && /results attached/.test(t)) return { ...c, done: true };
      if (p.stage === "concept" && artifacts.filter((x) => x.kind === "image").length >= 2 && /two directions/.test(t)) return { ...c, done: true };
      return c;
    });
    boardMaps(doc).objects.set(p.id, { ...p, artifacts, checklist, status: p.status === "idle" ? "open" : p.status });
    logActivity(doc, { who: by, role: "human", text: `added ${art.kind === "cad" ? "CAD" : "a file"} to ${p.name}: ${name}${note ? ` (${note})` : ""}`, objectId: p.id });
  });
  return art;
}

export function chooseArtifact(boardId: string, panelId: string, artifactId: string) {
  editBoard(boardId, "pipeline", (doc) => {
    const p = stagePanel(doc, panelId);
    const artifacts = (p.artifacts ?? []).map((a) => ({ ...a, chosen: a.id === artifactId }));
    const checklist = (p.checklist ?? []).map((c) => (/chosen/.test(c.text) ? { ...c, done: true } : c));
    boardMaps(doc).objects.set(p.id, { ...p, artifacts, checklist });
  });
}

export function setChecklist(boardId: string, panelId: string, index: number, done: boolean) {
  editBoard(boardId, "pipeline", (doc) => {
    const p = stagePanel(doc, panelId);
    const checklist = (p.checklist ?? []).map((c, i) => (i === index ? { ...c, done } : c));
    boardMaps(doc).objects.set(p.id, { ...p, checklist });
  });
}

/** Complete a stage: its chosen (or latest) artifact goes out on the wire and the next stage opens. */
export function completeStage(boardId: string, panelId: string, by: string, decision?: "approved" | "changes") {
  return editBoard(boardId, "pipeline", (doc) => {
    const m = boardMaps(doc);
    const p = stagePanel(doc, panelId);
    const def = stageDef(p.stage)!;
    const arts = [...(p.artifacts ?? [])];
    let out: unknown = arts.find((a) => a.chosen) ?? arts[arts.length - 1] ?? { text: p.text };
    if (p.stage === "review") {
      if (decision === "changes") {
        // send it back: the review stays open, simulate and CAD reopen
        for (const s of pipelineStages(doc, p.pipeline!)) {
          if (s.stage === "cad" || s.stage === "simulate") m.objects.set(s.id, { ...s, status: "open" });
        }
        const decisionArt: Artifact = { id: uid("art"), name: "Changes requested", kind: "decision", by, at: Date.now() };
        m.objects.set(p.id, { ...p, artifacts: [...arts, decisionArt] });
        logActivity(doc, { who: by, role: "human", text: `requested changes on ${p.name} — CAD and simulation reopened`, objectId: p.id });
        return { next: null, sentBack: true };
      }
      out = { decision: "approved", by, at: Date.now() };
      arts.push({ id: uid("art"), name: `Approved by ${by}`, kind: "decision", by, at: Date.now() });
    }
    const outPort = p.ports.find((x) => x.dir === "out");
    const checklist = (p.checklist ?? []).map((c) => ({ ...c, done: true }));
    m.objects.set(p.id, { ...p, status: "done", artifacts: arts, checklist, outputs: { ...(p.outputs ?? {}), ...(outPort ? { [outPort.id]: out } : {}) } });
    // open whatever this stage feeds
    let next: string | null = null;
    for (const l of m.links.values()) {
      if (l.from.panel !== p.id) continue;
      const n = m.objects.get(l.to.panel);
      if (n && n.kind === "panel" && n.panel === "stage" && n.status !== "done") {
        m.objects.set(n.id, { ...n, status: "open" });
        next = n.id;
      }
    }
    logActivity(doc, { who: by, role: "human", text: `completed ${p.name}${next ? " — next stage open" : " — pipeline released"}`, objectId: next ?? p.id });
    void def;
    return { next, sentBack: false };
  });
}

export function updateStageSettings(boardId: string, panelId: string, settings: Record<string, string>, assignee?: string) {
  editBoard(boardId, "pipeline", (doc) => {
    const p = stagePanel(doc, panelId);
    boardMaps(doc).objects.set(p.id, { ...p, settings: { ...(p.settings ?? {}), ...settings }, ...(assignee !== undefined ? { assignee } : {}) });
  });
}

/** a pipeline by its id, its section's id or name, or the product's name ("Rim-drive fan v3") */
export function resolvePipeline(doc: Y.Doc, ref: string): string | null {
  const m = boardMaps(doc);
  const stages = [...m.objects.values()].filter((o): o is PanelDoc => o.kind === "panel" && o.panel === "stage" && Boolean(o.pipeline));
  if (stages.some((s) => s.pipeline === ref)) return ref;
  const needle = ref.trim().toLowerCase().replace(/^design · /, "");
  for (const s of stages) {
    const sec = m.sections.get(s.sectionId);
    const name = sec?.name.toLowerCase().replace(/^design · /, "") ?? "";
    if (s.sectionId === ref || name === needle || (needle.length > 2 && name.includes(needle))) return s.pipeline!;
  }
  return null;
}

export function describePipeline(boardId: string, ref: string) {
  const doc = getBoard(boardId).doc;
  const pipeline = resolvePipeline(doc, ref);
  if (!pipeline) return "";
  return pipelineStages(doc, pipeline)
    .map((s) => `${s.name} [${s.status}]${s.assignee ? ` · ${s.assignee}` : ""} — ${(s.artifacts ?? []).length} artifacts${(s.artifacts ?? []).length ? `: ${(s.artifacts ?? []).map((a) => `${a.name}${a.note ? ` (${a.note})` : ""}`).join("; ")}` : ""}`)
    .join("\n");
}
