/**
 * How a character is made, as nodes you can read and press (2026-11-17, Josh: "showing the flow of
 * generation as nodes, and give the ability for us to output them to the section, that adds and
 * automatically arranges things when we click on a generate button"). The Character studio's middle row,
 * between a set's Inspiration and its Characters:
 *
 *   Inspiration → Sheet → Expressions → Views → Mesh avatar ───────────────→ Output
 *                                             ↘ Meshy model → Skeleton → Moods ↗
 *
 * Each node is its own card (`panel: "pipeline"`, `node`: which) and the wires between them are the grid's
 * own (links between the cards' ports, laid by the server: characters.ts `layFlow`). A node says what it
 * takes, what it makes and what a press costs, and holds **the characters of this set that are at it** as
 * tiles: the latest picture, the name, a line while its stage runs, and **Generate** with the price on it
 * (a person's press, the same one the character's card makes). When the stage lands the tile is at the
 * next node; when the last one lands the server puts the character's card into `Characters · <Set>`.
 * **＋ New** on the Sheet node starts one: a name, a line of who it is, the pictures to draw it from.
 *
 * A character's own card is still where its detail is; a tile opens it. `PipeNode` is a node drawn from
 * what it's given; `PipeFlow` is the whole flow in one frame with its wires drawn (the design page, and a
 * studio's one flow card from 2026-11-16 until the server has upgraded it).
 */

import { useMemo, useRef, useState } from "react";
import { nodeOf, PIPELINE_NODES, PIPELINE_WIRES, type CharacterForm, type CharacterStageKey, type PipelineNodeKey } from "@foundation/protocol";
import { authHeaders, serverUrl } from "../lib/api";
import { loadCosts, newCharacter, pressStage, STAGE_WORDS, standing, useCosts, useInspiration, useStudioCharacters, type Costs, type Inspiration, type StudioCharacter } from "../lib/characterStudio";
import { useFileSrc } from "../lib/fileSrc";
import { characterFilePath } from "../characters/roster";
import { requestSnap, type PanelMeta } from "../state/store";
import { toast, useUi } from "../state/ui";
import { activeBoard } from "../sync/board";
import "./pipeline.css";

const titled = (set: string) => set.trim().replace(/^./, (c) => c.toUpperCase());

interface NodeWords {
  name: string;
  /** who or what does it */
  kind: string;
  takes: (set: string) => string;
  makes: (set: string) => string;
}
export const NODE_WORDS: Record<PipelineNodeKey, NodeWords> = {
  inspiration: { name: "Inspiration", kind: "Input", takes: (s) => `pictures dropped into Inspiration · ${titled(s)}`, makes: () => "a set's style, mood and palette. A character is never a copy of one" },
  sheet: { name: "Sheet", kind: "Image model", takes: () => "its words and up to five pictures", makes: () => "the character from the front" },
  expressions: { name: "Expressions", kind: "Image model", takes: () => "the sheet", makes: () => "eight labelled panels: emotions and poses" },
  views: { name: "Views", kind: "Image model", takes: () => "the sheet and the expressions", makes: () => "a portrait (mesh avatar), or the back and a side (3D)" },
  mesh: { name: "Mesh avatar", kind: "By hand", takes: () => "the portrait", makes: () => "a .mavatar, built with mesh-avatar-studio" },
  model: { name: "Meshy model", kind: "Meshy", takes: () => "the front, back and side", makes: () => "a textured 3D model" },
  rig: { name: "Skeleton", kind: "Meshy", takes: () => "the model", makes: () => "bones, at its height" },
  clips: { name: "Moods", kind: "Meshy", takes: () => "the skeleton", makes: () => "a clip for each of eight moods" },
  output: { name: "Output", kind: "To the council", takes: () => "a finished character", makes: (s) => `its card in Characters · ${titled(s)}, to approve` },
};

/** what a press at a node costs, in words: a form's price, or both where the forms differ */
function priceOf(node: PipelineNodeKey, price: Costs | null): string {
  if (node === "inspiration" || node === "output") return "";
  if (node === "mesh") return "no credits";
  if (!price) return "";
  const mesh = price.costs.mesh[node];
  const model = price.costs.model[node];
  if (mesh !== undefined && model !== undefined && mesh !== model) return `${mesh} or ${model} credits`;
  return `${mesh ?? model ?? 0} credits`;
}

function Pic({ src, name }: { src: string; name: string }) {
  const url = useFileSrc(src, true, { width: 256 });
  return url ? <img src={url} alt={name} loading="lazy" decoding="async" draggable={false} onError={(e) => (e.currentTarget.style.visibility = "hidden")} /> : <span />;
}

export interface NodeHandlers {
  onGenerate?: (c: StudioCharacter, stage: CharacterStageKey) => void;
  onMavatar?: (c: StudioCharacter, file: File) => void;
  onOpen?: (c: StudioCharacter) => void;
  onNew?: (n: { name: string; identity: string; form: CharacterForm; refs: string[] }) => Promise<boolean>;
}

/** a character at a node: its latest picture, its name, what its stage is doing, and the press that runs it */
function Tile({ c, node, price, viewer, busy, still, onGenerate, onMavatar, onOpen }: { c: StudioCharacter; node: PipelineNodeKey; price: Costs | null; viewer: boolean; busy: boolean; still?: string } & NodeHandlers) {
  const fetched = useFileSrc(c.files.thumb && !still ? characterFilePath(c.id, "thumb") : null, true, { width: 256 });
  const src = still ?? fetched;
  const file = useRef<HTMLInputElement>(null);
  const at = standing(c);
  const stage = at.next;
  const st = stage ? c.stages[stage] : undefined;
  const cost = stage ? (price?.costs[c.form][stage] ?? 0) : 0;
  const says =
    node === "output"
      ? c.approval === "pending"
        ? "waiting for approval"
        : "approved"
      : at.running
        ? `working${st?.progress ? ` · ${st.progress}%` : ""}`
        : at.failed
          ? at.failed
          : c.form === "model"
            ? "3D"
            : "mesh avatar";
  return (
    <li className={`pipe-tile${at.running ? " is-running" : ""}${at.failed ? " is-failed" : ""}${node === "output" && c.approval === "pending" ? " is-pending" : ""}`} data-pipe-tile={c.name} data-pipe-running={at.running || undefined}>
      <button type="button" className="pipe-tile-open" data-tip={`Open ${c.name}'s card`} onClick={() => onOpen?.(c)}>
        <span className="pipe-tile-pic">{src ? <img src={src} alt="" draggable={false} onError={(e) => (e.currentTarget.style.visibility = "hidden")} /> : <i aria-hidden>✦</i>}</span>
        <span className="pipe-tile-words">
          <b>{c.name}</b>
          <span>{says}</span>
        </span>
        {at.running && <i className="pipe-busy" aria-label="working" />}
      </button>
      {at.running && <i className="pipe-progress" style={{ ["--p" as string]: `${st?.progress ?? 4}%` }} />}
      {!viewer && stage && !at.running && node !== "output" && (
        stage === "mesh" ? (
          <>
            <button type="button" className="f-pill is-primary pipe-generate" data-pipe-generate="mesh" disabled={busy} data-tip={`Bring in ${c.name}'s .mavatar, built with mesh-avatar-studio. Spends nothing`} onClick={() => file.current?.click()}>
              Bring in .mavatar
            </button>
            <input ref={file} type="file" accept=".mavatar,application/zip" hidden onChange={(e) => (e.target.files?.[0] && onMavatar?.(c, e.target.files[0]), (e.target.value = ""))} />
          </>
        ) : (
          <button
            type="button"
            className="f-pill is-primary pipe-generate"
            data-pipe-generate={stage}
            disabled={busy || !(price?.configured ?? false)}
            data-tip={price?.configured === false ? "Meshy isn't connected: set MESHY_API_KEY in Foundation's .env" : `${STAGE_WORDS[stage].press(c.form)} for ${c.name}. Spends ${cost} Meshy credits`}
            onClick={() => onGenerate?.(c, stage)}
          >
            {at.failed ? "Try again" : "Generate"} · {cost}
          </button>
        )
      )}
    </li>
  );
}

/** ＋ New, on the Sheet node: a name, a line of who it is, what to draw it from. It starts at Sheet; nothing is spent until its Generate. */
function NewCharacter({ set, pictures, onNew, onClose }: { set: string; pictures: Inspiration[]; onNew: NonNullable<NodeHandlers["onNew"]>; onClose: () => void }) {
  const [name, setName] = useState("");
  const [identity, setIdentity] = useState("");
  const [form, setForm] = useState<CharacterForm>("mesh");
  const [refs, setRefs] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const quiet = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") onClose();
  };
  return (
    <form
      className="pipe-new"
      data-pipe-new-form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim() || sending) return;
        setSending(true);
        const ok = await onNew({ name: name.trim(), identity: identity.trim(), form, refs });
        setSending(false);
        if (ok) onClose();
      }}
    >
      <input className="pipe-field" autoFocus placeholder="Its name" aria-label="The new character's name" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={quiet} onKeyUp={(e) => e.stopPropagation()} />
      <textarea className="pipe-field" rows={3} placeholder="Who it is, in a line: what it is, its colours, what it wears" aria-label="Who the new character is" maxLength={600} value={identity} onChange={(e) => setIdentity(e.target.value)} onKeyDown={quiet} onKeyUp={(e) => e.stopPropagation()} />
      <div className="pipe-forms" role="radiogroup" aria-label="What it becomes">
        {(["mesh", "model"] as const).map((f) => (
          <button key={f} type="button" role="radio" aria-checked={form === f} className={`pipe-form${form === f ? " is-on" : ""}`} data-pipe-form={f} onClick={() => setForm(f)}>
            {f === "mesh" ? "Mesh avatar" : "3D"}
          </button>
        ))}
      </div>
      {pictures.length > 0 ? (
        <div className="pipe-picks" aria-label={`Draw it from the ${set} inspiration: up to five`}>
          {pictures.map((p) => {
            const on = refs.includes(p.file);
            return (
              <button key={p.file} type="button" className={`pipe-pick${on ? " is-on" : ""}`} aria-pressed={on} disabled={!on && refs.length >= 5} data-tip={on ? "Drawn from this · press to leave it out" : refs.length >= 5 ? "Five at most reach the image model" : "Draw from this"} onClick={() => setRefs(on ? refs.filter((r) => r !== p.file) : [...refs, p.file])}>
                <Pic src={p.src} name={p.name} />
              </button>
            );
          })}
        </div>
      ) : (
        <span className="pipe-hint">No inspiration in this set yet: it will be drawn from its words alone.</span>
      )}
      <div className="pipe-new-acts">
        <button type="submit" className="f-pill is-accent" disabled={!name.trim() || sending} data-pipe-new-add>
          Add at Sheet
        </button>
        <button type="button" className="f-pill" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export interface NodeProps extends NodeHandlers {
  node: PipelineNodeKey;
  set: string;
  /** this set's characters (the node shows the ones that are at it) */
  characters: StudioCharacter[];
  price: Costs | null;
  pictures: Inspiration[];
  viewer?: boolean;
  /** drawn inside one frame with the others, as raised paper (on the grid its card is the paper) */
  inline?: boolean;
  /** the card of a character whose press is on its way */
  busy?: string | null;
  /** pictures to show instead of the archive's, by character id (the design page has no archive) */
  stills?: Record<string, string>;
  /** the new-character form open from the start (the design page shows it still) */
  adding?: boolean;
}

export function PipeNode({ node, set, characters, price, pictures, viewer = false, inline = false, busy = null, stills, adding = false, ...on }: NodeProps) {
  const [open, setOpen] = useState(adding);
  const w = NODE_WORDS[node];
  const here = characters.filter((c) => c.approval !== "archived" && nodeOf(c) === node);
  const working = here.filter((c) => standing(c).running).length;
  const cost = priceOf(node, price);
  const pending = node === "output" ? here.filter((c) => c.approval === "pending").length : 0;
  return (
    <div className={`pipe-node${inline ? " is-inline" : ""}${node === "output" ? " is-out" : ""}${node === "inspiration" ? " is-in" : ""}`} data-pipe-node={node} data-pipe-set={set} data-pipe-count={here.length}>
      <span className="pipe-kind">
        {w.kind}
        {cost && <i> · {cost}</i>}
      </span>
      <b className="pipe-name">{w.name}</b>
      <dl className="pipe-io">
        <dt>Takes</dt>
        <dd>{w.takes(set)}</dd>
        <dt>Makes</dt>
        <dd>{w.makes(set)}</dd>
      </dl>
      {node === "inspiration" ? (
        <>
          <span className="pipe-pics">
            {pictures.slice(0, 12).map((p) => (
              <Pic key={p.src} src={p.src} name={p.name} />
            ))}
          </span>
          <span className={`pipe-count${pictures.length ? "" : " is-none"}`}>{pictures.length ? `${pictures.length} ${pictures.length === 1 ? "picture" : "pictures"}` : "none yet: drop some above"}</span>
        </>
      ) : (
        <>
          {open && on.onNew ? (
            <NewCharacter set={set} pictures={pictures} onNew={on.onNew} onClose={() => setOpen(false)} />
          ) : (
            <ul className="pipe-tiles wheel-own">
              {here.map((c) => (
                <Tile key={c.panelId} c={c} node={node} price={price} viewer={viewer} busy={busy === c.panelId} still={stills?.[c.id]} {...on} />
              ))}
            </ul>
          )}
          <span className="pipe-foot">
            <span className={`pipe-count${here.length ? (working || pending ? " is-running" : "") : " is-none"}`}>
              {node === "output" ? `${here.length - pending} approved${pending ? ` · ${pending} waiting` : ""}` : here.length ? `${here.length} here${working ? ` · ${working} working` : ""}` : "none here"}
            </span>
            {node === "sheet" && !viewer && !open && (
              <button type="button" className="f-pill pipe-add" data-pipe-new onClick={() => setOpen(true)} data-tip="A new character in this set: it starts here, at Sheet">
                ＋ New
              </button>
            )}
          </span>
        </>
      )}
    </div>
  );
}

// ---------- the whole flow in one frame, its wires drawn ----------

/** the band as the server lays it (characters.ts NODE_AT): a column and a lane for each node */
const AT: Record<PipelineNodeKey, { col: number; lane: 0 | 1; tall?: boolean }> = {
  inspiration: { col: 0, lane: 0, tall: true },
  sheet: { col: 1, lane: 0, tall: true },
  expressions: { col: 2, lane: 0, tall: true },
  views: { col: 3, lane: 0, tall: true },
  mesh: { col: 4, lane: 0 },
  model: { col: 4, lane: 1 },
  rig: { col: 5, lane: 1 },
  clips: { col: 6, lane: 1 },
  output: { col: 7, lane: 0, tall: true },
};
const W = 200;
const H = 290;
const GAP = 56;
const LANE = 40;
const PORT = 30;
const box = (n: PipelineNodeKey) => ({ x: AT[n].col * (W + GAP), y: AT[n].lane * (H + LANE), w: W, h: AT[n].tall ? H * 2 + LANE : H });

export function PipeFlow(props: Omit<NodeProps, "node" | "inline"> & { addingAt?: PipelineNodeKey }) {
  const wires = useMemo(
    () =>
      PIPELINE_WIRES.map((w) => {
        const a = box(w.from);
        const b = box(w.to);
        // a node's second wire leaves (or lands) a step lower, as a card's second port does
        const out = PIPELINE_WIRES.filter((x) => x.from === w.from).indexOf(w);
        const into = PIPELINE_WIRES.filter((x) => x.to === w.to).indexOf(w);
        const sy = a.y + PORT + out * 22;
        const ey = b.y + PORT + into * 22;
        const sx = a.x + a.w;
        const mid = b.x - GAP / 2 + (into ? 8 : 0) - (out ? 8 : 0);
        return { key: `${w.from}-${w.to}`, d: `M${sx} ${sy} H${mid} V${ey} H${b.x}` };
      }),
    [],
  );
  const { addingAt, ...rest } = props;
  return (
    <div className="pipe-flow wheel-own" data-pipeline={props.set}>
      <div className="pipe-band" style={{ width: 8 * W + 7 * GAP, height: H * 2 + LANE }}>
        <svg className="pipe-wires" width={8 * W + 7 * GAP} height={H * 2 + LANE} aria-hidden>
          {wires.map((w) => (
            <g key={w.key}>
              <path className="pipe-road" d={w.d} />
              <path className="pipe-line" d={w.d} />
            </g>
          ))}
        </svg>
        {PIPELINE_NODES.map((n) => {
          const b = box(n);
          return (
            <div key={n} className="pipe-slot" style={{ left: b.x, top: b.y, width: b.w, height: b.h }}>
              <PipeNode {...rest} node={n} inline adding={addingAt === n} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- on the grid ----------

export function PipelineBody({ panel }: { panel: PanelMeta }) {
  const ui = useUi();
  const set = panel.source ?? "abstract";
  const all = useStudioCharacters();
  const mine = useMemo(() => all.filter((c) => c.set.toLowerCase() === set.toLowerCase()), [all, set]);
  const pictures = useInspiration(set);
  const price = useCosts();
  const [busy, setBusy] = useState<string | null>(null);
  const node = PIPELINE_NODES.find((n) => n === panel.node);

  const handlers: NodeHandlers = {
    onGenerate: async (c, stage) => {
      setBusy(c.panelId);
      await pressStage(c.panelId, stage);
      setBusy(null);
    },
    onMavatar: async (c, f) => {
      setBusy(c.panelId);
      try {
        const res = await fetch(serverUrl(`/api/boards/${encodeURIComponent(activeBoard()?.boardId ?? "")}/characters/${c.panelId}/mavatar`), { method: "POST", credentials: "include", headers: { ...authHeaders(), "content-type": "application/zip" }, body: f });
        if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `it didn't upload (${res.status})`);
        loadCosts(true);
        toast(`${c.name} is ready for the council`, "ok");
      } catch (e) {
        toast((e as Error).message, "bad");
      } finally {
        setBusy(null);
      }
    },
    onOpen: (c) => requestSnap({ kind: "object", id: c.panelId }),
    onNew: (n) => newCharacter(panel.sectionId, n.form, { name: n.name, identity: n.identity, refs: n.refs, set }),
  };
  const shared = { set, characters: mine, price, pictures, viewer: ui.role === "viewer", busy, ...handlers };
  // a studio's one flow card (2026-11-16), until the server has made it a node: the whole flow, in the card
  if (!node) return <PipeFlow {...shared} />;
  return <PipeNode {...shared} node={node} />;
}
