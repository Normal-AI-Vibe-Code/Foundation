/**
 * A character's card: one avatar's sheet, on the board (redrawn 2026-11-17, Josh: "better organized and
 * structured typographically … draw lines to separate the sections").
 *
 * Top to bottom, each part under its eyebrow and a hairline:
 *
 *   the stage     the character as it stands now (live once it's ready: turn its mood, see it from the
 *                 chest up or head to toe), its name as a title you can write in, and what it is in quiet tags
 *   Who it is     the words every prompt is built from: formatted text on the card's own paper (CharacterWords)
 *   Stages        what each costs before it's pressed, what came back, who pressed it
 *   Pictures      the expressions sheet large, then the sheet, the views and the portrait
 *   Drawn from    the inspiration it's drawn from (the pictures in its set's Inspiration section)
 *   a person's word on it (approve, archive), and the foot: Meshy's balance and the image model
 *
 * The state is the server's (the board's `characters` map); the card only reads it and presses. A viewer
 * sees everything and presses nothing. `CharacterSheet` is the card drawn from what it's given (the design
 * page shows it without a board); `CharacterBody` is the one on the grid.
 */

import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { boardMaps, CHARACTER_STAGES, MOODS, nextStage, stagePassed, type CharacterStageKey, type CharacterState, type Mood } from "@foundation/protocol";
import { api, authHeaders, serverUrl } from "../lib/api";
import { loadCosts, pressStage, STAGE_WORDS, useCosts, useInspiration, type Costs, type Inspiration } from "../lib/characterStudio";
import { useFileSrc } from "../lib/fileSrc";
import { activeBoard } from "../sync/board";
import type { PanelMeta } from "../state/store";
import { toast, useUi } from "../state/ui";
import { Avatar } from "../characters/Avatar";
import type { Framing } from "../characters/actor";
import { characterFilePath, type RosterCharacter } from "../characters/roster";
import { useOnScreen } from "./PanelView";
import { useStage } from "../characters/stageBudget";
import { CharacterWords, type SaveState } from "./CharacterWords";
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

/** a picture the character has, by role; `still` is a picture given instead of the archive's (the design page) */
function Picture({ character, role, label, still, large = false }: { character: CharacterState; role: string; label: string; still?: string; large?: boolean }) {
  const id = (character.files as Record<string, string | undefined>)[role];
  const fetched = useFileSrc(id && !still ? characterFilePath(character.id, role) : null, true, { width: large ? 512 : 256 });
  const src = still ?? fetched;
  const [broken, setBroken] = useState(false);
  if ((!id && !still) || broken) return null;
  return (
    <figure className={`char-thumb${large ? " is-large" : ""}`} data-char-file={role}>
      {src ? <img src={src} alt={`${character.name}, ${label}`} loading="lazy" decoding="async" draggable={false} onError={() => setBroken(true)} /> : <span />}
      <figcaption>{label}</figcaption>
    </figure>
  );
}

function Pick({ item, on, disabled, onToggle }: { item: Inspiration; on: boolean; disabled: boolean; onToggle: () => void }) {
  const src = useFileSrc(item.src, true, { width: 256 });
  return (
    <button type="button" className={`char-pick${on ? " is-on" : ""}`} aria-pressed={on} disabled={disabled && !on} data-tip={on ? "Drawn from this · press to leave it out" : disabled ? "Five at most reach the image model" : "Draw from this"} onClick={onToggle}>
      {src && <img src={src} alt={item.name} loading="lazy" decoding="async" draggable={false} onError={(e) => (e.currentTarget.style.visibility = "hidden")} />}
    </button>
  );
}

/** a part of the sheet: an eyebrow, an aside on its line, and what it holds, under a hairline */
function Part({ name, title, aside, children }: { name: string; title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="char-part" data-char-part={name}>
      <h3 className="char-eyebrow">
        <span>{title}</span>
        {aside}
      </h3>
      {children}
    </section>
  );
}

const SAID: Record<SaveState, string> = { clean: "", dirty: "not saved yet", saving: "saving…", saved: "✓ saved" };

/** the name as a title you can write in: saved on leaving it or Enter, put back on Esc */
function NameField({ name, readOnly, onSave }: { name: string; readOnly: boolean; onSave: (name: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      className="char-name"
      value={draft ?? name}
      readOnly={readOnly}
      aria-label="The character's name"
      data-char-name
      maxLength={60}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null && draft.trim() && draft.trim() !== name) onSave(draft.trim());
        setDraft(null);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape") {
          setDraft(null);
          const field = e.currentTarget;
          requestAnimationFrame(() => field.blur());
        }
      }}
      onKeyUp={(e) => e.stopPropagation()}
    />
  );
}

export interface SheetProps {
  /** undefined while the board's map is still being read: the same card, saying so */
  character: CharacterState | undefined;
  /** where its card is, for the live avatar's files */
  boardId?: string;
  panelId?: string;
  viewer?: boolean;
  price: Costs | null;
  inspiration?: Inspiration[];
  /** the stage may play (it has a place in the frame budget) */
  live?: boolean;
  /** a stage whose press is on its way to the server */
  busy?: string | null;
  /** pictures to show instead of the archive's, by role (the design page has no archive) */
  stills?: Partial<Record<string, string>>;
  hostRef?: Ref<HTMLDivElement>;
  onPointer?: () => void;
  onPress?: (stage: CharacterStageKey) => void;
  onEdit?: (patch: { name?: string; identity?: string; refs?: string[] }) => Promise<unknown>;
  onMavatar?: (file: File) => void;
  onApprove?: (approval: "approved" | "archived" | "pending") => void;
}

export function CharacterSheet({ character, boardId = "", panelId = "", viewer = false, price, inspiration = [], live = false, busy = null, stills, hostRef, onPointer, onPress, onEdit, onMavatar, onApprove }: SheetProps) {
  const [mood, setMood] = useState<Mood>("idle");
  // a 3D character starts head to toe; a mesh avatar starts as what it is, a portrait
  const [framed, setFraming] = useState<Framing | null>(null);
  const [said, setSaid] = useState<SaveState>("clean");
  const file = useRef<HTMLInputElement>(null);
  // "saved" is a moment, not a state the card stays in
  useEffect(() => {
    if (said !== "saved") return;
    const t = setTimeout(() => setSaid("clean"), 2600);
    return () => clearTimeout(t);
  }, [said]);

  // the same element before and after its character is read: what watches it (is it on screen?) keeps watching
  if (!character)
    return (
      <div ref={hostRef} className="char-body">
        <p className="char-note">Reading this character…</p>
      </div>
    );
  const c = character;
  const framing: Framing = framed ?? (c.form === "mesh" ? "bust" : "full");
  const order = CHARACTER_STAGES[c.form];
  const running = order.find((s) => c.stages[s]?.state === "running");
  // the stage to press next: the first it isn't past
  const next = nextStage(c);
  const entry: RosterCharacter = { ...c, boardId, panelId };
  const edit = (patch: { name?: string; identity?: string; refs?: string[] }) => onEdit?.(patch) ?? Promise.resolve();
  /** a change that says for itself when it didn't take (the card's own toast): nothing to wait for here */
  const change = (patch: { name?: string; refs?: string[] }) => void edit(patch).catch(() => {});
  const drawn = c.ready || c.files.thumb || c.files.front || c.files.portrait;
  const pictures = (["front", "back", "side", "portrait"] as const).filter((r) => c.files[r] || stills?.[r]);
  const expressions = Boolean(c.files.expressions || stills?.expressions);

  return (
    <div ref={hostRef} className="char-body wheel-own" data-character-card={c.name} data-character-ready={c.ready || undefined} onPointerEnter={onPointer} onPointerMove={onPointer}>
      <header className="char-head">
        <div className="char-view">
          {stills?.thumb ? (
            <img className="char-view-still" src={stills.thumb} alt={c.name} draggable={false} />
          ) : drawn ? (
            <Avatar character={entry} mood={mood} framing={c.ready ? framing : "full"} still={!(c.ready && live)} />
          ) : (
            <p className="char-note">Nothing drawn yet. Say who it is, pick its inspiration, and draw the sheet.</p>
          )}
        </div>
        <NameField name={c.name} readOnly={viewer} onSave={(name) => change({ name })} />
        <p className="char-tags">
          <span className="char-tag">{c.set}</span>
          <span className="char-tag">{c.form === "model" ? "3D character" : "mesh avatar"}</span>
          {c.copyOf && <span className="char-tag is-copy" data-tip="A copy: the character as it was when it was copied. Its stages are pressed on the original">copy</span>}
          {c.ready && !c.copyOf && c.approval !== "pending" && c.approval !== "archived" && <span className="char-tag is-ready">on the council</span>}
          {c.ready && !c.copyOf && c.approval === "pending" && <span className="char-tag is-pending">waiting for approval</span>}
          {c.approval === "archived" && <span className="char-tag is-archived">archived</span>}
          {!c.ready && c.approval !== "archived" && <span className="char-tag is-making">{running ? `on its ${STAGE_WORDS[running].name.toLowerCase()}` : next ? `next: ${STAGE_WORDS[next].name.toLowerCase()}` : "in the making"}</span>}
        </p>
        {c.ready && (
          <div className="char-moods" role="group" aria-label="Try a mood">
            {MOODS.map((m) => (
              <button key={m} type="button" className={`char-mood${m === mood ? " is-on" : ""}`} aria-pressed={m === mood} onClick={() => (onPointer?.(), setMood(m))}>
                {m}
              </button>
            ))}
            <button type="button" className="char-mood char-frame" onClick={() => setFraming(framing === "full" ? "bust" : "full")} data-tip="Chest up, or head to toe">
              {framing === "full" ? "↧ chest up" : "↥ head to toe"}
            </button>
          </div>
        )}
      </header>

      <Part
        name="who"
        title="Who it is"
        aside={
          <span className={`char-said is-${said}`} data-char-saved={said} aria-live="polite">
            {SAID[said]}
          </span>
        }
      >
        <CharacterWords
          value={c.identity}
          label={`Who ${c.name} is`}
          readOnly={viewer || Boolean(running)}
          placeholder={viewer ? "Nothing written yet." : "What it is, its colours, what it wears, its proportions. Click to write; ⌘↵ saves."}
          onSave={(identity) => edit({ identity })}
          onState={setSaid}
        />
      </Part>

      <Part name="stages" title="Stages" aside={<span className="char-aside">{order.filter((s) => c.stages[s]?.state === "done").length} of {order.length} done</span>}>
        <ol className="char-stages">
          {order.map((s) => {
            const st = c.stages[s];
            const cost = price?.costs[c.form][s] ?? 0;
            const w = STAGE_WORDS[s];
            const prior = order.slice(0, order.indexOf(s)).every((p) => stagePassed(c, p));
            // a character made before the expressions sheet: it has none and isn't held back for one; it can be given one
            const optional = s === "expressions" && !st && stagePassed(c, s);
            const canPress = !viewer && !running && prior && busy === null && (price?.configured ?? false);
            return (
              <li key={s} className={`char-stage is-${st?.state ?? (optional ? "optional" : s === next ? "next" : "later")}`} data-char-stage={s} data-char-state={st?.state ?? "idle"}>
                <span className="char-stage-mark" aria-hidden="true">
                  {st?.state === "done" ? "✓" : st?.state === "failed" ? "!" : st?.state === "running" ? "…" : optional ? "＋" : ""}
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
                          : optional
                            ? "optional: it was made before expression sheets. Adding one changes nothing else."
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
                  (s === next || optional || st?.state === "done" || st?.state === "failed") &&
                  !viewer &&
                  st?.state !== "running" && (
                    <button type="button" className={`f-pill${s === next ? " is-primary" : ""}`} disabled={!canPress} data-tip={price?.configured === false ? "Meshy isn't connected: set MESHY_API_KEY in Foundation's .env" : `Spends ${cost} Meshy credits`} onClick={() => onPress?.(s)}>
                      {st?.state === "done" ? "Again" : st?.state === "failed" ? "Try again" : optional ? "Add expressions" : w.press(c.form)} · {cost}
                    </button>
                  )
                )}
              </li>
            );
          })}
        </ol>
        <input ref={file} type="file" accept=".mavatar,application/zip" hidden onChange={(e) => (e.target.files?.[0] && onMavatar?.(e.target.files[0]), (e.target.value = ""))} />
      </Part>

      {(pictures.length > 0 || expressions) && (
        <Part name="pictures" title="Pictures" aside={<span className="char-aside">{pictures.length + (expressions ? 1 : 0)} kept in the archive</span>}>
          {expressions && <Picture character={c} role="expressions" label="expressions: neutral, happy, sad, surprised, thinking, talking, blink, waving" still={stills?.expressions} large />}
          {pictures.length > 0 && (
            <div className="char-thumbs">
              <Picture character={c} role="front" label="sheet" still={stills?.front} />
              <Picture character={c} role="back" label="back" still={stills?.back} />
              <Picture character={c} role="side" label="side" still={stills?.side} />
              <Picture character={c} role="portrait" label="portrait" still={stills?.portrait} />
            </div>
          )}
        </Part>
      )}

      <Part name="drawn" title="Drawn from" aside={<span className="char-aside">{c.refs.length ? `${c.refs.length} of the ${c.set} inspiration` : "its words alone"}</span>}>
        {inspiration.length > 0 ? (
          <div className="char-picks">
            {inspiration.map((i) => {
              const on = c.refs.includes(i.file);
              return <Pick key={i.file} item={i} on={on} disabled={viewer || Boolean(running) || c.refs.length >= 5} onToggle={() => !viewer && !running && change({ refs: on ? c.refs.filter((r) => r !== i.file) : [...c.refs, i.file] })} />;
            })}
          </div>
        ) : (
          <p className="char-hint">Drop pictures into “Inspiration · {c.set}” and pick up to five here.</p>
        )}
      </Part>

      {/* a person's word on it: only approved characters are offered as an agent's avatar */}
      {(c.ready || c.approval === "archived") && !viewer && (
        <div className="char-approval" data-char-approval={c.approval ?? "approved"}>
          {c.approval === "pending" && (
            <>
              <span>Finished. Approve it and agents can wear it.</span>
              <button type="button" className="f-pill is-accent" onClick={() => onApprove?.("approved")}>
                Approve
              </button>
              <button type="button" className="f-pill" onClick={() => onApprove?.("archived")}>
                Archive
              </button>
            </>
          )}
          {c.approval === "archived" && (
            <>
              <span>Archived: kept, with its files, and not offered as an avatar.</span>
              <button type="button" className="f-pill" onClick={() => onApprove?.(c.ready ? "approved" : "pending")}>
                Restore
              </button>
            </>
          )}
          {c.approval !== "pending" && c.approval !== "archived" && (
            <>
              <span>Approved: offered when an agent's avatar is chosen.</span>
              <button type="button" className="f-pill" onClick={() => onApprove?.("archived")}>
                Archive
              </button>
            </>
          )}
        </div>
      )}

      <footer className="char-foot">
        {price?.configured ? `Meshy · ${price.balance === null ? "balance unknown" : `${price.balance.toLocaleString()} credits left`} · images by ${price.imageModel}` : price ? "Meshy isn't connected, so nothing can be drawn (MESHY_API_KEY)" : ""}
      </footer>
    </div>
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
  const price = useCosts();
  const [busy, setBusy] = useState<string | null>(null);
  const inspiration = useInspiration(c?.set ?? "");

  const url = (rest: string) => `/api/boards/${encodeURIComponent(board())}/characters/${panel.id}${rest}`;
  const press = async (stage: CharacterStageKey) => {
    setBusy(stage);
    await pressStage(panel.id, stage);
    setBusy(null);
  };
  const name = c?.name ?? panel.name;
  const edit = (patch: { name?: string; identity?: string; refs?: string[] }) =>
    api(url("/edit"), { method: "POST", json: patch }).catch((e: Error) => {
      toast(e.message, "bad");
      throw e;
    });
  const bringMavatar = async (f: File) => {
    setBusy("mesh");
    try {
      const res = await fetch(serverUrl(url("/mavatar")), { method: "POST", credentials: "include", headers: { ...authHeaders(), "content-type": "application/zip" }, body: f });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `it didn't upload (${res.status})`);
      loadCosts(true);
      toast(`${name} is ready for the council`, "ok");
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setBusy(null);
    }
  };
  const approve = (approval: "approved" | "archived" | "pending") =>
    void api(url("/approval"), { method: "POST", json: { approval } }).then(
      () => toast(approval === "approved" ? `${name} is approved for the council` : approval === "archived" ? `${name} is archived` : `${name} is back in the pipeline`, "ok"),
      (e: Error) => toast(e.message, "bad"),
    );

  return (
    <CharacterSheet
      character={c}
      boardId={board()}
      panelId={panel.id}
      // a copy (dragged out of a collection, or laid out by one) shows the character; its original is where it's pressed
      viewer={ui.role === "viewer" || Boolean(c?.copyOf)}
      price={price}
      inspiration={inspiration}
      live={live}
      busy={busy}
      hostRef={host}
      onPointer={takeStage}
      onPress={(s) => void press(s)}
      onEdit={edit}
      onMavatar={(f) => void bringMavatar(f)}
      onApprove={approve}
    />
  );
}
