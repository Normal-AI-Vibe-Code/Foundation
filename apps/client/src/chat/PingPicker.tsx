/**
 * The ping picker (2026-11-27): opened from a card's or a section's right-click menu, at the press. A field to
 * narrow by name, then the people and agents to ping in four groups (chat/pingLogic.ts): Recent, On this (who made
 * it, whom it's for), Here now, Worked on this grid. Arrows move, Enter pings, Esc puts it away. Picking one sends
 * the ping (chat/ping.ts) and says so.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import { PartyAvatar } from "./Avatar";
import { useChat } from "./model";
import { closePing, reachable, recentPings, sendPing, usePingAsk, type PingAsk } from "./ping";
import { filterGroups, pingGroups, type PingRow } from "./pingLogic";
import { getObject, isPanel } from "../state/store";
import { activeBoard } from "../sync/board";
import { othersOn, useWhereabouts } from "../lib/whereabouts";
import { toast } from "../state/ui";
import "./chat.css";
import "./ping.css";

const W = 300;

/** mounted once by the shell: the picker while one is asked for */
export function PingHost() {
  const ask = usePingAsk();
  if (!ask) return null;
  return createPortal(<PingPicker key={`${ask.place.board}:${ask.objectId ?? ask.place.section}:${ask.x}:${ask.y}`} ask={ask} />, document.body);
}

function PingPicker({ ask }: { ask: PingAsk }) {
  const s = useChat();
  const where = useWhereabouts();
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: ask.x, top: ask.y });

  const groups = useMemo(() => {
    const card = ask.objectId ? getObject(ask.objectId) : null;
    const all = pingGroups({
      meId: s.me?.id,
      recent: recentPings(),
      card: card ? { createdBy: card.createdBy, assignee: isPanel(card) ? card.assignee : undefined } : null,
      here: othersOn(where, ask.place.board, s.me?.id),
      workers: activeBoard()?.boardId === ask.place.board ? (activeBoard()?.workers() ?? []) : [],
      people: s.people.map((p) => ({ id: p.id, name: p.name })),
    });
    return filterGroups(all, q);
  }, [ask, q, s.me?.id, s.people, where]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = useMemo(() => groups.flatMap((g) => g.rows.filter(reachable)), [groups]);

  // kept inside the window
  useLayoutEffect(() => {
    const r = box.current?.getBoundingClientRect();
    const h = r?.height ?? 360;
    setPos({ left: Math.max(8, Math.min(ask.x, window.innerWidth - W - 8)), top: Math.max(8, Math.min(ask.y, window.innerHeight - h - 8)) });
  }, [ask.x, ask.y, groups.length]);

  useEffect(() => {
    const off = (e: PointerEvent) => !box.current?.contains(e.target as Node) && closePing();
    window.addEventListener("pointerdown", off, true);
    return () => window.removeEventListener("pointerdown", off, true);
  }, []);

  const pick = async (r: PingRow) => {
    if (busy || !reachable(r)) return;
    setBusy(true);
    try {
      await sendPing(r, ask.place);
      toast(`Pinged ${r.name} about “${ask.place.label}”`, "ok");
      closePing();
    } catch (e) {
      toast((e as Error).message, "bad");
      setBusy(false);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") return closePing();
    if (e.key === "ArrowDown") return e.preventDefault(), setAt((i) => Math.min(rows.length - 1, i + 1));
    if (e.key === "ArrowUp") return e.preventDefault(), setAt((i) => Math.max(0, i - 1));
    if (e.key === "Enter" && rows[at]) return e.preventDefault(), void pick(rows[at]);
  };

  const signedOut = !s.me || s.status === "signin" || s.status === "unavailable" || s.status === "off";
  let i = -1;
  return (
    <motion.div
      ref={box}
      className="ping-pick chat-pop f-glass"
      style={{ left: pos.left, top: pos.top, width: W }}
      role="dialog"
      aria-label={`Ping someone about ${ask.place.label}`}
      data-ping-picker
      initial={{ opacity: 0, y: -4, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: "spring", stiffness: 520, damping: 38 }}
      onKeyDown={onKey}
    >
      <div className="ping-pick-head">
        <div className="f-eyebrow">Ping about</div>
        <div className="ping-pick-what">{ask.place.label}</div>
      </div>
      {signedOut ? (
        <p className="ping-pick-empty">{s.status === "unavailable" ? "ChatForm isn't on this server yet." : "Sign in to ChatForm to ping someone."}</p>
      ) : (
        <>
          <input className="ping-pick-filter" autoFocus value={q} onChange={(e) => (setQ(e.target.value), setAt(0))} placeholder="Find a person or an agent" aria-label="Find someone to ping" />
          <div className="ping-pick-list wheel-own" role="listbox">
            {groups.length === 0 && <p className="ping-pick-empty">{q ? "Nobody by that name here." : "Nobody has worked on this grid yet. Ping someone from ChatForm with an @mention."}</p>}
            {groups.map((g) => (
              <div key={g.id} className="ping-pick-group" data-ping-group={g.id}>
                <div className="ping-pick-title">{g.title}</div>
                {g.rows.map((r) => {
                  const ok = reachable(r);
                  if (ok) i++;
                  const me = i;
                  return (
                    <button
                      key={r.id}
                      type="button"
                      role="option"
                      aria-selected={ok && me === at}
                      className={`ping-pick-row${ok && me === at ? " is-at" : ""}${r.kind === "agent" ? " is-agent" : ""}`}
                      disabled={!ok || busy}
                      onPointerEnter={() => ok && setAt(me)}
                      onClick={() => void pick(r)}
                      data-ping-to={r.id}
                    >
                      <PartyAvatar party={{ kind: r.kind, id: r.kind === "agent" ? r.name : r.id, name: r.name }} size={22} />
                      <span className="ping-pick-name">{r.name}</span>
                      <span className="ping-pick-detail">{ok ? r.detail : "not in ChatForm"}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </>
      )}
    </motion.div>
  );
}
