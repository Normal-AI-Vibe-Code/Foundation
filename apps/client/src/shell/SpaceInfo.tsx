/**
 * This space's own pane: what belongs to the open space rather than to the
 * app. Opened from the ⓘ on the space's tab (⌘I); it takes the left pane's
 * place on the floor, and the spaces pane's fold brings that one back.
 *
 * Top to bottom: what the space is (name, canvas, folder, a page's address),
 * who is here now, who may change it (admins set that), what its agents may
 * send to outside services (EgressSettings), and its activity.
 */

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { UserInfo } from "@foundation/protocol";
import { requestSnap, useAppState } from "../state/store";
import { WIDTHS, setUi, useUi } from "../state/ui";
import { api } from "../lib/api";
import { initials, useBoardTick, usePeers } from "./Presence";
import { FloorEdge } from "./FloorEdge";
import { ago, isSystemGrid, paneSpring } from "./SidePane";
import { isPageKind, wouldLoop } from "../lib/grids";
import { THEMES } from "@foundation/ui";
import { KIND_GLYPH, KIND_NAME, type BoardRow } from "./Shell";
import { Egress } from "./EgressSettings";

interface Props {
  user: UserInfo;
  space: BoardRow | null;
  boards: BoardRow[];
  onUpdate(id: string, patch: { name?: string; parent?: string | null; theme?: "day" | "night" | null }): void;
}

export function SpaceInfo({ user, space, boards, onUpdate }: Props) {
  const ui = useUi();
  const canEdit = !!space && space.role !== "viewer";
  const kind = space?.kind ?? "grid";
  return (
    <AnimatePresence initial={false}>
      {ui.pane && space && (
        <motion.aside key="info" className="side-pane space-info floor-pane" style={{ width: ui.paneW }} initial={{ opacity: 0, x: -16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }} transition={paneSpring} aria-label={`About ${space.name}`}>
          <div className="pane-scroll">
            <section className="pane-group">
              <div className="pane-eyebrow">This grid</div>
              <input
                key={space.id + space.name}
                className="info-name"
                defaultValue={space.name}
                readOnly={!canEdit}
                aria-label="The grid's name"
                onBlur={(e) => {
                  const name = e.target.value.trim();
                  if (name && name !== space.name) onUpdate(space.id, { name });
                  else e.target.value = space.name;
                }}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
              />
              <dl className="info-facts">
                <dt>Canvas</dt>
                <dd>
                  <span className="pane-glyph">{KIND_GLYPH[kind]}</span> {KIND_NAME[kind]}
                </dd>
                <dt>Inside</dt>
                <dd>
                  <select className="info-pick" value={space.parent ?? ""} disabled={!canEdit} aria-label="The grid this one is inside" onChange={(e) => onUpdate(space.id, { parent: e.target.value || null })}>
                    <option value="">No grid (the top of All Grids)</option>
                    {boards
                      .filter((b) => !isPageKind(b.kind) && !isSystemGrid(b.id) && !wouldLoop(space.id, b.id, boards))
                      .sort((a, b) => a.name.localeCompare(b.name))
                      .map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name}
                        </option>
                      ))}
                  </select>
                </dd>
                {/* the theme this grid wears while it's the one in focus (DESIGN.md §2.1): paper follows the orb; a grid may pin day or night */}
                {!isPageKind(kind) && (
                  <>
                    <dt>Look</dt>
                    <dd>
                      <select className="info-pick" value={space.theme ?? "paper"} disabled={!canEdit} aria-label="The look this grid wears" data-grid-theme onChange={(e) => onUpdate(space.id, { theme: e.target.value === "day" || e.target.value === "night" ? e.target.value : null })}>
                        {(["paper", "day", "night"] as const).map((t) => (
                          <option key={t} value={t}>
                            {t === "paper" ? "Paper (follows day and night)" : THEMES[t].name}
                          </option>
                        ))}
                      </select>
                    </dd>
                  </>
                )}
                {isPageKind(kind) && space.url && (
                  <>
                    <dt>Address</dt>
                    <dd className="info-url" title={space.url}>
                      {space.url}
                    </dd>
                  </>
                )}
                {!isPageKind(kind) && <Counts />}
              </dl>
            </section>

            <Here me={user} />
            {user.role === "admin" && <People board={space.id} me={user.id} />}
            <Egress board={space.id} />
            <Activity />
          </div>
          <FloorEdge side="right" value={ui.paneW} {...WIDTHS.pane} onChange={(w) => setUi({ paneW: w })} label="This grid's pane" />
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

/** what's on the grid, counted */
function Counts() {
  const st = useAppState();
  const cards = Object.keys(st.panels).length + Object.keys(st.notes).length + Object.keys(st.tables).length + Object.keys(st.maps).length + Object.keys(st.media).length;
  return (
    <>
      <dt>On it</dt>
      <dd className="info-count">
        {Object.keys(st.sections).length} sections · {cards} cards
      </dd>
    </>
  );
}

/** who has this space open right now: you, then everyone else (agents in violet) */
function Here({ me }: { me: UserInfo }) {
  const peers = usePeers();
  return (
    <section className="pane-group">
      <div className="pane-eyebrow">Here now</div>
      <div className="pane-row is-person is-still">
        <span className="person-dot" style={{ background: me.color }}>
          {initials(me.name)}
        </span>
        <span className="pane-label">{me.name}</span>
        <span className="person-role">You</span>
      </div>
      {peers.map((p) => (
        <div key={p.clientId} className="pane-row is-person is-still">
          <span className={`person-dot${p.user.agent ? " is-agent" : ""}`} style={{ background: p.user.agent ? undefined : p.user.color }}>
            {p.user.agent ? "✦" : initials(p.user.name)}
          </span>
          <span className="pane-label">{p.user.name}</span>
          {p.user.agent && <span className="person-role">Agent</span>}
        </div>
      ))}
    </section>
  );
}

interface Person {
  id: string;
  name: string;
  email: string;
  color: string;
  role: "admin" | "member" | "viewer";
  account: "admin" | "member" | "viewer";
  onBoard: boolean;
}

/** admins: who may change this space. A role set here beats the person's account role; admins always can. */
function People({ board, me }: { board: string; me: string }) {
  const [people, setPeople] = useState<Person[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<{ people: Person[] }>(`/api/boards/${encodeURIComponent(board)}/people`).then((r) => setPeople(r.people)).catch(() => {});
  }, [board]);
  const set = async (userId: string, role: "member" | "viewer" | null) => {
    try {
      const r = await api<{ people: Person[] }>(`/api/boards/${encodeURIComponent(board)}/people`, { method: "POST", json: { userId, role } });
      setPeople(r.people);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <section className="pane-group">
      <div className="pane-eyebrow">Who can change it</div>
      {people.map((p) => (
        <div key={p.id} className="pane-row is-person" title={p.email}>
          <span className="person-dot" style={{ background: p.color }}>
            {initials(p.name)}
          </span>
          <span className="pane-label">{p.name}</span>
          {p.account === "admin" ? (
            <span className="person-role">Admin</span>
          ) : (
            <select
              className={`person-role-pick${p.role === "viewer" ? " is-viewer" : ""}`}
              value={p.onBoard ? p.role : "default"}
              disabled={p.id === me}
              aria-label={`${p.name} on this grid`}
              onChange={(e) => void set(p.id, e.target.value === "default" ? null : (e.target.value as "member" | "viewer"))}
            >
              <option value="default">{p.account === "viewer" ? "Viewer (account)" : "Member (account)"}</option>
              <option value="member">Can edit</option>
              <option value="viewer">View only</option>
            </select>
          )}
        </div>
      ))}
      {err && <div className="pane-empty is-bad">{err}</div>}
    </section>
  );
}

function Activity() {
  const board = useBoardTick();
  const items = (board?.activity() ?? []).slice(-30).reverse();
  return (
    <section className="pane-group">
      <div className="pane-eyebrow">Activity</div>
      {items.length === 0 && <div className="pane-empty">Quiet so far. Agents and people show up here as they work.</div>}
      {items.map((a, i) => (
        <button key={a.at + ":" + i} className={`activity-row role-${a.role}`} onClick={() => a.objectId && requestSnap({ kind: "object", id: a.objectId })}>
          <span className={`f-dot ${a.role === "agent" ? "is-agent" : a.role === "human" ? "is-ok" : ""}`} />
          {/* an agent's line says whom it worked for; a person's is just theirs */}
          <span className="activity-who" data-tip={a.role === "agent" && a.for ? `${a.who}: an agent working for ${a.for}` : undefined}>
            {a.role === "agent" ? "✦ " : ""}
            {a.who}
          </span>
          <span className="activity-text">{a.text}</span>
          <span className="activity-when">{ago(a.at)}</span>
        </button>
      ))}
    </section>
  );
}
