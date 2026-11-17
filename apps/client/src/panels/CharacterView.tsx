/**
 * A character's card: the art pipeline for one avatar, on the board.
 *
 * Top to bottom: the character as it stands now (live once it's ready: turn
 * its mood, see it from the chest up or head to toe), its stages with what
 * each costs before it's pressed, the words that describe it, and the
 * inspiration it's drawn from (the pictures in its set's Inspiration section).
 *
 * The state is the server's (the board's `characters` map); the card only
 * reads it and presses. A viewer sees everything and presses nothing.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { boardMaps, CHARACTER_STAGES, MOODS, type CharacterStageKey, type CharacterState, type Mood } from "@foundation/protocol";
import { api, authHeaders, serverUrl } from "../lib/api";
import { useFileSrc } from "../lib/fileSrc";
import { activeBoard } from "../sync/board";
import { getState, subscribe, type PanelMeta } from "../state/store";
import { toast, useUi } from "../state/ui";
import { Avatar } from "../characters/Avatar";
import type { Framing } from "../characters/actor";
import { characterFilePath, type RosterCharacter } from "../characters/roster";
import { useOnScreen } from "./PanelView";
import { useStage } from "../characters/stageBudget";
import "./character.css";

const board = () => activeBoard()?.boardId ?? "";

export function useCharacter(panelId: string): CharacterState | undefined {
  const [state, setState] = useState<CharacterState | undefined>(undefined);
  useEffect(() => {
    const b = activeBoard();
    if (!b) return;
    const map = boardMaps(b.doc).characters;
    const read = () => setState(map.get(panelId));
    read();
    const onChange = (e: { keysChanged: Set<string> }) => e.keysChanged.has(panelId) && read();
    map.observe(onChange);
    return () => map.unobserve(onChange);
  }, [panelId]);
  return state;
}

// ----- what the buttons cost: one read, shared, read again after a press -----

interface Costs {
  configured: boolean;
  balance: number | null;
  imageModel: string;
  costs: Record<"model" | "mesh", Partial<Record<CharacterStageKey, number>>>;
}
let costs: Costs | null = null;
const costSubs = new Set<() => void>();
let costLoad: Promise<void> | null = null;
function loadCosts(force = false) {
  if (costLoad || (costs && !force)) return;
  costLoad = api<Costs>("/api/characters/costs")
    .then((c) => {
      costs = c;
      costSubs.forEach((f) => f());
    })
    .catch(() => {})
    .finally(() => {
      costLoad = null;
    });
}
function useCosts(): Costs | null {
  return useSyncExternalStore(
    (fn) => {
      costSubs.add(fn);
      loadCosts();
      return () => costSubs.delete(fn);
    },
    () => costs,
  );
}

// ----- the pictures in the set's Inspiration section -----

interface Inspiration {
  file: string;
  src: string;
  name: string;
}
function inspirationKey(set: string): string {
  const st = getState();
  const want = `inspiration · ${set}`.toLowerCase();
  const sec = Object.values(st.allSections).find((s) => s.name.trim().toLowerCase() === want || s.name.trim().toLowerCase() === `${want}s`);
  if (!sec) return "";
  return Object.values(st.media)
    .filter((m) => m.sectionId === sec.id && m.media === "image" && /^\/files\/f_/.test(m.src))
    .map((m) => `${m.src.slice(7)}\t${m.src}\t${m.name}`)
    .join("\n");
}
function useInspiration(set: string): Inspiration[] {
  const key = useSyncExternalStore(subscribe, () => inspirationKey(set));
  return useMemo(() => (key ? key.split("\n").map((l) => l.split("\t")).map(([file, src, name]) => ({ file, src, name })) : []), [key]);
}

const STAGE_WORDS: Record<CharacterStageKey, { name: string; press: (form: CharacterState["form"]) => string; makes: (form: CharacterState["form"]) => string }> = {
  sheet: { name: "Sheet", press: () => "Draw the sheet", makes: () => "the character from the front, from its words and inspiration" },
  views: { name: "Views", press: (f) => (f === "model" ? "Draw the back and side" : "Draw the portrait"), makes: (f) => (f === "model" ? "the same character from behind and in profile" : "head and shoulders, facing you: what the mesh avatar is cut from") },
  model: { name: "Model", press: () => "Make the model", makes: () => "a textured 3D model from the views" },
  rig: { name: "Skeleton", press: () => "Fit the skeleton", makes: () => "bones, so it can move" },
  clips: { name: "Moods", press: () => "Animate the moods", makes: () => `a clip for each mood: ${MOODS.join(", ")}` },
  mesh: { name: "Mesh avatar", press: () => "Bring in the .mavatar", makes: () => "the portrait as a mesh that blinks, talks and emotes (built with mesh-avatar-studio)" },
};

function Thumb({ character, role, label }: { character: CharacterState; role: string; label: string }) {
  const id = (character.files as Record<string, string | undefined>)[role];
  const src = useFileSrc(id ? characterFilePath(character.id, role) : null);
  const [broken, setBroken] = useState(false);
  if (!id || broken) return null;
  return (
    <figure className="char-thumb" data-char-file={role}>
      {src ? <img src={src} alt={`${character.name}, ${label}`} draggable={false} onError={() => setBroken(true)} /> : <span />}
      <figcaption>{label}</figcaption>
    </figure>
  );
}

function Pick({ item, on, disabled, onToggle }: { item: Inspiration; on: boolean; disabled: boolean; onToggle: () => void }) {
  const src = useFileSrc(item.src);
  return (
    <button type="button" className={`char-pick${on ? " is-on" : ""}`} aria-pressed={on} disabled={disabled && !on} data-tip={on ? "Drawn from this · press to leave it out" : disabled ? "Five at most reach the image model" : "Draw from this"} onClick={onToggle}>
      {src && <img src={src} alt={item.name} draggable={false} onError={(e) => (e.currentTarget.style.visibility = "hidden")} />}
    </button>
  );
}


export function CharacterBody({ panel }: { panel: PanelMeta }) {
  const host = useRef<HTMLDivElement>(null);
  // every card draws itself: the ones on screen at a size worth it play (as many as the frames allow:
  // characters/stageBudget.ts), and a card without a place holds its picture, never an empty frame
  const onScreen = useOnScreen(host, 0.3);
  const { live, take: takeStage } = useStage(onScreen);
  const c = useCharacter(panel.id);
  const ui = useUi();
  const viewer = ui.role === "viewer";
  const price = useCosts();
  const [mood, setMood] = useState<Mood>("idle");
  // a 3D character starts head to toe; a mesh avatar starts as what it is, a portrait
  const [framed, setFraming] = useState<Framing | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [identity, setIdentity] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const inspiration = useInspiration(c?.set ?? "");

  if (!c)
    return (
      <div ref={host} className="char-body">
        <p className="char-note">Reading this character…</p>
      </div>
    );

  const framing: Framing = framed ?? (c.form === "mesh" ? "bust" : "full");
  const order = CHARACTER_STAGES[c.form];
  const running = order.find((s) => c.stages[s]?.state === "running");
  // the stage to press next: the first that isn't done
  const next = order.find((s) => c.stages[s]?.state !== "done");
  const entry: RosterCharacter = { ...c, boardId: board(), panelId: panel.id };
  const url = (rest: string) => `/api/boards/${encodeURIComponent(board())}/characters/${panel.id}${rest}`;

  const press = async (stage: CharacterStageKey, confirm = false) => {
    setBusy(stage);
    try {
      await api(url(`/stages/${stage}`), { method: "POST", json: { confirm } });
      loadCosts(true);
    } catch (e) {
      const msg = (e as Error).message;
      // a send that was never answered: the person decides whether to send it again
      if (/may have been charged/.test(msg) && window.confirm(`${msg}\n\nSend it again?`)) return press(stage, true);
      toast(msg, "bad");
    } finally {
      setBusy(null);
    }
  };
  const edit = (patch: { identity?: string; refs?: string[] }) => api(url("/edit"), { method: "POST", json: patch }).catch((e: Error) => toast(e.message, "bad"));
  const bringMavatar = async (f: File) => {
    setBusy("mesh");
    try {
      const res = await fetch(serverUrl(url("/mavatar")), { method: "POST", credentials: "include", headers: { ...authHeaders(), "content-type": "application/zip" }, body: f });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `it didn't upload (${res.status})`);
      toast(`${c.name} is ready for the council`, "ok");
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setBusy(null);
    }
  };

  const approve = (approval: "approved" | "archived" | "pending") =>
    api(url("/approval"), { method: "POST", json: { approval } }).then(
      () => toast(approval === "approved" ? `${c.name} is approved for the council` : approval === "archived" ? `${c.name} is archived` : `${c.name} is back in the pipeline`, "ok"),
      (e: Error) => toast(e.message, "bad"),
    );
  const words = identity ?? c.identity;
  return (
    <div ref={host} className="char-body wheel-own" data-character-card={c.name} data-character-ready={c.ready || undefined} onPointerEnter={takeStage} onPointerMove={takeStage}>
      <div className="char-view">
        {c.ready || c.files.thumb || c.files.front || c.files.portrait ? (
          <Avatar character={entry} mood={mood} framing={c.ready ? framing : "full"} still={!(c.ready && live)} />
        ) : (
          <p className="char-note">{c.files.front ? "" : "Nothing drawn yet. Say who it is, pick its inspiration, and draw the sheet."}</p>
        )}
        <div className="char-tags">
          <span className="char-tag">{c.set}</span>
          <span className="char-tag">{c.form === "model" ? "3D character" : "mesh avatar"}</span>
          {c.ready && c.approval !== "pending" && c.approval !== "archived" && <span className="char-tag is-ready">on the council</span>}
          {c.ready && c.approval === "pending" && <span className="char-tag is-pending">waiting for approval</span>}
          {c.approval === "archived" && <span className="char-tag is-archived">archived</span>}
        </div>
      </div>

      {/* a person's word on it: only approved characters are offered as an agent's avatar */}
      {(c.ready || c.approval === "archived") && !viewer && (
        <div className="char-approval" data-char-approval={c.approval ?? "approved"}>
          {c.approval === "pending" && (
            <>
              <span>Finished. Approve it and agents can wear it.</span>
              <button type="button" className="f-pill is-accent" onClick={() => void approve("approved")}>
                Approve
              </button>
              <button type="button" className="f-pill" onClick={() => void approve("archived")}>
                Archive
              </button>
            </>
          )}
          {c.approval === "archived" && (
            <>
              <span>Archived: kept, with its files, and not offered as an avatar.</span>
              <button type="button" className="f-pill" onClick={() => void approve(c.ready ? "approved" : "pending")}>
                Restore
              </button>
            </>
          )}
          {c.approval !== "pending" && c.approval !== "archived" && (
            <>
              <span>Approved: offered when an agent's avatar is chosen.</span>
              <button type="button" className="f-pill" onClick={() => void approve("archived")}>
                Archive
              </button>
            </>
          )}
        </div>
      )}

      {c.ready && (
        <div className="char-moods" role="group" aria-label="Try a mood">
          {MOODS.map((m) => (
            <button key={m} type="button" className={`char-mood${m === mood ? " is-on" : ""}`} aria-pressed={m === mood} onClick={() => (takeStage(), setMood(m))}>
              {m}
            </button>
          ))}
          <button type="button" className="char-mood char-frame" onClick={() => setFraming(framing === "full" ? "bust" : "full")} data-tip="Chest up, or head to toe">
            {framing === "full" ? "↧ chest up" : "↥ head to toe"}
          </button>
        </div>
      )}

      <ol className="char-stages">
        {order.map((s) => {
          const st = c.stages[s];
          const cost = price?.costs[c.form][s] ?? 0;
          const w = STAGE_WORDS[s];
          const prior = order.slice(0, order.indexOf(s)).every((p) => c.stages[p]?.state === "done");
          const canPress = !viewer && !running && prior && busy === null && (price?.configured ?? false);
          return (
            <li key={s} className={`char-stage is-${st?.state ?? (s === next ? "next" : "later")}`} data-char-stage={s} data-char-state={st?.state ?? "idle"}>
              <span className="char-stage-mark" aria-hidden="true">
                {st?.state === "done" ? "✓" : st?.state === "failed" ? "!" : st?.state === "running" ? "…" : ""}
              </span>
              <div className="char-stage-words">
                <b>{w.name}</b>
                <span>
                  {st?.state === "running"
                    ? `in progress${st.progress ? ` · ${st.progress}%` : ""}`
                    : st?.state === "failed"
                      ? st.error
                      : st?.state === "done"
                        ? `${st.credits ? `${st.credits} credits` : "done"}${st.by ? ` · ${st.by}` : ""}`
                        : w.makes(c.form)}
                </span>
                {st?.state === "running" && <i className="char-progress" style={{ ["--p" as string]: `${st.progress ?? 4}%` }} />}
              </div>
              {s === "mesh" ? (
                !viewer && prior && (
                  <button type="button" className={`f-pill${s === next ? " is-primary" : ""}`} disabled={busy !== null} onClick={() => file.current?.click()}>
                    {st?.state === "done" ? "Replace" : w.press(c.form)}
                  </button>
                )
              ) : (
                (s === next || st?.state === "done" || st?.state === "failed") &&
                !viewer &&
                st?.state !== "running" && (
                  <button type="button" className={`f-pill${s === next ? " is-primary" : ""}`} disabled={!canPress} data-tip={price?.configured === false ? "Meshy isn't connected: set MESHY_API_KEY in Foundation's .env" : `Spends ${cost} Meshy credits`} onClick={() => void press(s)}>
                    {st?.state === "done" ? "Again" : st?.state === "failed" ? "Try again" : w.press(c.form)} · {cost}
                  </button>
                )
              )}
            </li>
          );
        })}
      </ol>
      <input ref={file} type="file" accept=".mavatar,application/zip" hidden onChange={(e) => (e.target.files?.[0] && void bringMavatar(e.target.files[0]), (e.target.value = ""))} />

      {(c.files.front || c.files.portrait) && (
        <div className="char-thumbs">
          <Thumb character={c} role="front" label="sheet" />
          <Thumb character={c} role="back" label="back" />
          <Thumb character={c} role="side" label="side" />
          <Thumb character={c} role="portrait" label="portrait" />
        </div>
      )}

      <label className="char-field">
        <span className="char-label">Who it is</span>
        <textarea
          className="char-words"
          value={words}
          readOnly={viewer || Boolean(running)}
          rows={4}
          placeholder="A line or two: what it is, its colours, what it wears."
          onChange={(e) => setIdentity(e.target.value)}
          onBlur={() => {
            if (identity !== null && identity.trim() !== c.identity) void edit({ identity });
            setIdentity(null);
          }}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </label>

      <div className="char-field">
        <span className="char-label">
          Drawn from <i>{c.refs.length ? `${c.refs.length} of the ${c.set} inspiration` : inspiration.length ? "its words alone · pick up to five" : `its words alone · drop pictures into “Inspiration · ${c.set}”`}</i>
        </span>
        {inspiration.length > 0 && (
          <div className="char-picks">
            {inspiration.map((i) => {
              const on = c.refs.includes(i.file);
              return <Pick key={i.file} item={i} on={on} disabled={viewer || Boolean(running) || c.refs.length >= 5} onToggle={() => !viewer && !running && void edit({ refs: on ? c.refs.filter((r) => r !== i.file) : [...c.refs, i.file] })} />;
            })}
          </div>
        )}
      </div>

      <footer className="char-foot">
        {price?.configured ? `Meshy · ${price.balance === null ? "balance unknown" : `${price.balance.toLocaleString()} credits left`} · images by ${price.imageModel}` : price ? "Meshy isn't connected, so nothing can be drawn (MESHY_API_KEY)" : ""}
      </footer>
    </div>
  );
}
