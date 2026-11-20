/**
 * Foundation's avatars (protocol avatars.ts; server avatars.ts): the uploader on the Character studio's left.
 *
 * What is wired into it is Foundation's set of avatars: a character card's output, or a whole section (each
 * set's Characters is wired in when the studio gets it). The card shows each character it brings, grouped by
 * what brought it, and where it stands: an avatar main already has, one the next upload adds, one waiting
 * (unfinished, or for a person's approval), one leaving (its wire came off). **Upload now** writes the set to
 * main's starter set and pushes it, when it changed; the timer does the same on its own. **Wire in** draws a
 * wire backwards out of its input: let go on a character card or over a section.
 *
 * Everything on it is the server's (people can't write the board's `uploaders` map): the presses are routes
 * that need a person (an upload publishes to every Foundation).
 */

import { useMemo, useState, useSyncExternalStore } from "react";
import { boardMaps, UPLOAD_EVERY, UPLOADER_IN, type UploaderEntry, type UploaderState } from "@foundation/protocol";
import { requestSnap, type PanelMeta } from "../state/store";
import { activeBoard, onBoardChange } from "../sync/board";
import { toast, useUi } from "../state/ui";
import { api } from "../lib/api";
import { useFileSrc } from "../lib/fileSrc";
import { beginGather } from "../shell/AgentLayer";
import "./uploader.css";

const EMPTY: UploaderState = { entries: [], inMain: [] };
const board = () => activeBoard()?.boardId ?? "";

/** an uploader's state as the board has it, re-read when the server writes it */
export function useUploader(id: string): UploaderState {
  const key = useSyncExternalStore(
    (fn) => {
      let off = () => {};
      const watch = () => {
        off();
        const b = activeBoard();
        if (!b) return;
        const map = boardMaps(b.doc).uploaders;
        map.observe(fn);
        off = () => map.unobserve(fn);
      };
      watch();
      const offBoard = onBoardChange(() => (watch(), fn()));
      return () => (off(), offBoard());
    },
    () => {
      const b = activeBoard();
      const st = b ? boardMaps(b.doc).uploaders.get(id) : undefined;
      return st ? JSON.stringify(st) : "";
    },
  );
  return useMemo(() => (key ? (JSON.parse(key) as UploaderState) : EMPTY), [key]);
}

/** where an entry stands, in a word or two, and its tone */
export function standing(e: UploaderEntry, inMain: Set<string>): { word: string; tone: "main" | "adds" | "waits" | "leaves" } {
  if (e.state === "removed") return { word: "Leaves at the next upload", tone: "leaves" };
  if (e.state === "waiting") return { word: e.why ? `Waiting: ${e.why}` : "Waiting", tone: "waits" };
  return inMain.has(e.key) ? { word: "In main", tone: "main" } : { word: "Added at the next upload", tone: "adds" };
}

const ago = (t: number) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};
const at = (t: number) => new Date(t).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });

function Still({ id, name, src }: { id: string; name: string; src?: string }) {
  const fetched = useFileSrc(src ? null : `/api/characters/${id}/files/thumb`);
  const url = src ?? fetched;
  return url ? <img src={url} alt={name} draggable={false} loading="lazy" onError={(e) => (e.currentTarget.style.visibility = "hidden")} /> : <i aria-hidden>☺</i>;
}

function Tile({ e, inMain, viewer, still, onApprove }: { e: UploaderEntry; inMain: Set<string>; viewer: boolean; still?: string; onApprove?(e: UploaderEntry): void }) {
  const s = standing(e, inMain);
  const approvable = !viewer && e.state === "waiting" && e.panel && /approve/.test(e.why ?? "");
  return (
    <li className={`up-tile is-${s.tone}`} data-up-entry={e.name} data-up-state={e.state}>
      <button type="button" className="up-pic" onClick={() => e.panel && requestSnap({ kind: "object", id: e.panel })} data-tip={e.panel ? `Go to ${e.name}'s card` : undefined}>
        <Still id={e.id} name={e.name} src={still} />
      </button>
      <span className="up-words">
        <b>{e.name}</b>
        <span>{e.form === "mesh" ? "mesh avatar" : "3D"}</span>
      </span>
      <span className={`up-chip is-${s.tone}`} title={e.state === "removed" && e.why ? `${s.word}: ${e.why}` : s.word}>
        {s.word}
      </span>
      {approvable && (
        <button type="button" className="f-pill is-accent up-approve" onClick={() => onApprove?.(e)}>
          Approve
        </button>
      )}
    </li>
  );
}

export interface UploaderCardProps {
  state: UploaderState;
  viewer: boolean;
  /** the uploader's card and its input (absent on the design page: nothing is pressed there) */
  id?: string;
  port?: string;
  busy?: boolean;
  /** pictures by character id (the design page's stand-ins); otherwise each character's still from the server */
  stills?: Record<string, string>;
  onUpload?(): void;
  onTimer?(every: number): void;
  onApprove?(e: UploaderEntry): void;
}

/** the uploader from what it's given: the grid's (UploaderBody) and the design page's */
export function UploaderCard({ state: st, viewer, id, port, busy, stills, onUpload, onTimer, onApprove }: UploaderCardProps) {
  const inMain = useMemo(() => new Set(st.inMain), [st.inMain]);
  const groups = useMemo(() => {
    const out = new Map<string, UploaderEntry[]>();
    for (const e of st.entries) {
      const k = e.state === "removed" ? "Leaving" : (e.via ?? "Wired in");
      out.set(k, [...(out.get(k) ?? []), e]);
    }
    return [...out];
  }, [st.entries]);
  const n = (state: UploaderEntry["state"]) => st.entries.filter((e) => e.state === state).length;
  const avatars = n("avatar");
  const adds = st.entries.filter((e) => e.state === "avatar" && !inMain.has(e.key)).length;
  const leaving = n("removed");
  const waiting = n("waiting");
  const changes = adds + leaving;
  const running = Boolean(st.running) || Boolean(busy);
  const cannot = st.cannot;
  const last = st.last;
  const repo = /^([^/\s]+\/[^/\s]+) · /.exec(st.target ?? "")?.[1];
  return (
    <div className="up-body wheel-own" data-uploader data-up-avatars={avatars} data-up-running={running || undefined}>
      <header className="up-head">
        <span className="up-kind">
          Foundation's avatars <i>{avatars}</i>
        </span>
        <p className="up-lede">
          A character wired in here is an avatar on every Foundation. Uploaded to {st.target ? <b>{st.target}</b> : "main"}, every install has it when its server next starts; taken off, it's archived and leaves them too.
        </p>
      </header>

      <div className="up-actions">
        <button type="button" className="f-pill is-accent up-upload" disabled={viewer || running || Boolean(cannot) || !avatars} onClick={onUpload} data-up-upload data-tip={cannot ?? (changes ? `Upload ${avatars} avatars to main: ${[adds && `${adds} added`, leaving && `${leaving} leaving`].filter(Boolean).join(", ")}` : "Main already has these: an upload checks, and pushes only a change")}>
          {running ? "Uploading…" : "Upload now"}
        </button>
        <label className="up-timer">
          <span>Timer</span>
          <select value={st.every ?? 0} disabled={viewer || Boolean(cannot)} data-up-timer onChange={(e) => onTimer?.(Number(e.target.value))}>
            {UPLOAD_EVERY.map((o) => (
              <option key={o.ms} value={o.ms}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {st.every && st.nextAt ? <span className="up-next">next {at(st.nextAt)}{st.everyBy ? ` · set by ${st.everyBy}` : ""}</span> : null}
        <span className="up-spacer" />
        {!viewer && id && port && (
          <button type="button" className="f-pill up-wire" onPointerDown={(e) => beginGather(e, id, port)} data-tip="Drag onto a character card, or let go over a section to wire in every character in it">
            ＋ Wire in
          </button>
        )}
      </div>

      {cannot && <p className="up-note">{cannot}</p>}
      {last && (
        <p className={`up-last is-${last.outcome}`} data-up-last={last.outcome}>
          <span>{last.text}</span>
          <span className="up-when">
            {ago(last.at)} · {last.how === "timer" ? "timer" : last.by}
            {last.commit && (repo ? <a href={`https://github.com/${repo}/commit/${last.commit}`} target="_blank" rel="noreferrer">{last.commit.slice(0, 7)}</a> : <code>{last.commit.slice(0, 7)}</code>)}
          </span>
        </p>
      )}

      <p className="up-tally">
        {avatars} avatar{avatars === 1 ? "" : "s"}
        {adds ? ` · ${adds} to add` : ""}
        {leaving ? ` · ${leaving} leaving` : ""}
        {waiting ? ` · ${waiting} waiting` : ""}
      </p>

      {st.entries.length === 0 ? (
        <div className="up-empty">
          <span aria-hidden>⇪</span>
          <p>Nothing is wired in. Drag a wire from a character card's output to here, or use Wire in and let go over a section of characters.</p>
        </div>
      ) : (
        <div className="up-groups">
          {groups.map(([via, list]) => (
            <section key={via} className="up-group" data-up-group={via}>
              <h4>
                {via} <i>{list.length}</i>
              </h4>
              <ul className="up-grid">
                {list.map((e) => (
                  <Tile key={e.id} e={e} inMain={inMain} viewer={viewer} still={stills?.[e.id]} onApprove={onApprove} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

export function UploaderBody({ panel }: { panel: PanelMeta }) {
  const ui = useUi();
  const st = useUploader(panel.id);
  const [busy, setBusy] = useState(false);
  const port = panel.ports.find((p) => p.dir === "in" && p.name === UPLOADER_IN)?.id;
  const url = (rest: string) => `/api/boards/${encodeURIComponent(board())}/uploaders/${panel.id}${rest}`;
  const upload = () => {
    setBusy(true);
    void api(url("/upload"), { method: "POST", json: {} })
      .then(() => toast("Uploading Foundation's avatars to main", "ok"))
      .catch((e) => toast((e as Error).message, "bad"))
      .finally(() => setBusy(false));
  };
  const timer = (every: number) =>
    void api<UploaderState>(url("/timer"), { method: "POST", json: { every } })
      .then(() => toast(every ? `Uploading ${UPLOAD_EVERY.find((o) => o.ms === every)?.label.toLowerCase()}` : "Timer off", "ok"))
      .catch((e) => toast((e as Error).message, "bad"));
  const approve = (e: UploaderEntry) =>
    e.panel &&
    void api(`/api/boards/${encodeURIComponent(board())}/characters/${e.panel}/approval`, { method: "POST", json: { approval: "approved" } })
      .then(() => toast(`${e.name} approved: an avatar`, "ok"))
      .catch((err) => toast((err as Error).message, "bad"));
  return <UploaderCard state={st} viewer={ui.role === "viewer"} id={panel.id} port={port} busy={busy} onUpload={upload} onTimer={timer} onApprove={approve} />;
}
