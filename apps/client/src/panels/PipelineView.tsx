/**
 * How a character is made, as a flow you can read and use (2026-11-16): the Character studio's
 * middle row, between a set's Inspiration and its Characters. Five nodes joined left to right:
 *
 *   Inspiration → Character sheet → Views → Meshy 3D · or · Mesh avatar → Characters
 *
 * Each node says what it takes, what it makes, what a press costs, and how many of this set's
 * characters are at it right now (from the grid's own `characters` map, so it moves as stages land).
 * **New character** starts one here, in this section, drawn from the set's inspiration; it is worked
 * a stage at a time on its own card under the flow. Finished, it's dragged down into Characters and
 * approved there: only approved characters are offered when an agent's avatar is chosen.
 */

import { useMemo, useSyncExternalStore } from "react";
import { CHARACTER_STAGES, boardMaps, type CharacterState } from "@foundation/protocol";
import { newCharacter } from "../lib/characterStudio";
import { useFileSrc } from "../lib/fileSrc";
import { getState, subscribe, type PanelMeta } from "../state/store";
import { useUi } from "../state/ui";
import { activeBoard, onBoardChange } from "../sync/board";
import "./pipeline.css";

/** every character on the open grid, keyed by its card: read again when the server's map changes */
function useCharacters(): Array<CharacterState & { panelId: string }> {
  const key = useSyncExternalStore(
    (fn) => {
      let off = () => {};
      const watch = () => {
        off();
        const b = activeBoard();
        if (!b) return;
        const map = boardMaps(b.doc).characters;
        map.observe(fn);
        off = () => map.unobserve(fn);
      };
      watch();
      const offBoard = onBoardChange(() => (watch(), fn()));
      const offStore = subscribe(fn);
      return () => (off(), offBoard(), offStore());
    },
    () => {
      const b = activeBoard();
      if (!b) return "";
      const cards = getState().panels;
      return JSON.stringify([...boardMaps(b.doc).characters.entries()].filter(([id]) => cards[id]).map(([id, c]) => ({ ...c, panelId: id })));
    },
  );
  return useMemo(() => (key ? (JSON.parse(key) as Array<CharacterState & { panelId: string }>) : []), [key]);
}

function inspirationOf(set: string): Array<{ src: string; name: string }> {
  const st = getState();
  const want = `inspiration · ${set}`.toLowerCase();
  const sec = Object.values(st.allSections).find((s) => s.name.trim().toLowerCase() === want);
  if (!sec) return [];
  return Object.values(st.media)
    .filter((m) => m.sectionId === sec.id && m.media === "image")
    .map((m) => ({ src: m.src, name: m.name }));
}

function Pic({ src, name }: { src: string; name: string }) {
  const url = useFileSrc(src);
  return url ? <img src={url} alt={name} draggable={false} onError={(e) => (e.currentTarget.style.visibility = "hidden")} /> : <span />;
}

/** where a character stands: the node it's at (the first stage that isn't done), and whether that stage is running */
export function stageOf(c: CharacterState): { at: "sheet" | "views" | "make" | "out"; running: boolean } {
  const order = CHARACTER_STAGES[c.form];
  const next = order.find((s) => c.stages[s]?.state !== "done");
  const running = !!next && c.stages[next]?.state === "running";
  if (!next) return { at: "out", running: false };
  return { at: next === "sheet" ? "sheet" : next === "views" ? "views" : "make", running };
}

export function PipelineBody({ panel }: { panel: PanelMeta }) {
  const ui = useUi();
  const set = panel.source ?? "abstract";
  const all = useCharacters();
  const insp = useSyncExternalStore(subscribe, () => JSON.stringify(inspirationOf(set)));
  const pictures = useMemo(() => JSON.parse(insp) as Array<{ src: string; name: string }>, [insp]);
  const mine = all.filter((c) => c.set.toLowerCase() === set.toLowerCase());
  const at = (node: "sheet" | "views" | "make" | "out", form?: CharacterState["form"]) => mine.filter((c) => stageOf(c).at === node && (!form || c.form === form) && c.approval !== "archived");
  const pending = at("out").filter((c) => c.approval === "pending");
  const approved = at("out").filter((c) => c.approval !== "pending");
  const viewer = ui.role === "viewer";
  const count = (list: CharacterState[]) => {
    const running = list.filter((c) => stageOf(c).running).length;
    return list.length ? (
      <span className={`pipe-count${running ? " is-running" : ""}`} data-tip={list.map((c) => c.name).join(", ")}>
        {list.length} here{running ? ` · ${running} working` : ""}
      </span>
    ) : (
      <span className="pipe-count is-none">none here</span>
    );
  };
  return (
    <div className="pipeline" data-pipeline={set}>
      <div className="pipe-flow">
        <div className="pipe-node" data-pipe-node="inspiration">
          <span className="pipe-kind">Input</span>
          <b>Inspiration</b>
          <span className="pipe-what">Pictures dropped in the section above set the style, mood and palette. A character is never a copy of one.</span>
          <span className="pipe-pics">
            {pictures.slice(0, 5).map((p) => (
              <Pic key={p.src} src={p.src} name={p.name} />
            ))}
          </span>
          <span className={`pipe-count${pictures.length ? "" : " is-none"}`}>{pictures.length ? `${pictures.length} pictures` : "none yet: drop some above"}</span>
        </div>
        <span className="pipe-wire" aria-hidden />
        <div className="pipe-node" data-pipe-node="sheet">
          <span className="pipe-kind">Image model · 9 credits</span>
          <b>Character sheet</b>
          <span className="pipe-what">The character from the front, drawn from its words and up to five inspiration pictures.</span>
          {count(at("sheet"))}
        </div>
        <span className="pipe-wire" aria-hidden />
        <div className="pipe-node" data-pipe-node="views">
          <span className="pipe-kind">Image model · 9 or 18</span>
          <b>Views</b>
          <span className="pipe-what">A portrait on a flat ground for a mesh avatar; the back and one side for a 3D model.</span>
          {count(at("views"))}
        </div>
        <span className="pipe-wire is-split" aria-hidden />
        <div className="pipe-fork">
          <div className="pipe-node" data-pipe-node="mesh">
            <span className="pipe-kind">mesh-avatar-studio · by hand</span>
            <b>Mesh avatar</b>
            <span className="pipe-what">The portrait rigged into a face that blinks, talks and turns, brought in as a .mavatar.</span>
            {count(at("make", "mesh"))}
          </div>
          <div className="pipe-node" data-pipe-node="meshy">
            <span className="pipe-kind">Meshy · 59 credits</span>
            <b>Meshy 3D</b>
            <span className="pipe-what">A textured model from the views, then a skeleton, then a clip for each mood.</span>
            {count(at("make", "model"))}
          </div>
        </div>
        <span className="pipe-wire is-join" aria-hidden />
        <div className="pipe-node is-out" data-pipe-node="output">
          <span className="pipe-kind">Output</span>
          <b>Characters</b>
          <span className="pipe-what">Drag a finished card down into Characters and approve it there: approved ones are what an agent can wear.</span>
          <span className={`pipe-count${pending.length ? " is-running" : ""}`}>
            {approved.length} approved{pending.length ? ` · ${pending.length} waiting for approval` : ""}
          </span>
        </div>
      </div>
      {!viewer && (
        <div className="pipe-acts">
          <span>Start one here, from this set's inspiration:</span>
          <button type="button" className="f-pill is-accent" data-pipe-new="mesh" onClick={() => void newCharacter(panel.sectionId, "mesh")}>
            New character · mesh avatar
          </button>
          <button type="button" className="f-pill" data-pipe-new="model" onClick={() => void newCharacter(panel.sectionId, "model")}>
            New character · 3D
          </button>
        </div>
      )}
    </div>
  );
}
