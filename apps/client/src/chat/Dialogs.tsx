/**
 * ChatForm's dialogs: a new channel (name, what it's for, open or private, who's in it), a new direct
 * message (one person or a few), and the quick switcher (Ctrl/⌘+K inside ChatForm: channels and people,
 * matched fuzzily; Enter opens; Ctrl/⌘+K again hands over to Foundation's own commands).
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import { chatSlug, chatTitle, type ChatChannelView, type ChatParty } from "@foundation/protocol";
import { keys } from "../lib/keys";
import { PeoplePicker } from "./Pop";
import { channelMark } from "./Sidebar";
import { PartyAvatar } from "./Avatar";
import { fuzzyScore, isDirect } from "./logic";

function Modal({ onClose, children, label, className = "" }: { onClose(): void; children: ReactNode; label: string; className?: string }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [onClose]);
  // on the page itself: a pane's containment (the timeline's container query) must not hold a fixed layer
  return createPortal(
    <motion.div className="chat-modal-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }}>
      <motion.div
        className={`chat-modal ${className}`}
        role="dialog"
        aria-label={label}
        initial={{ opacity: 0, y: 10, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 6, scale: 0.99 }}
        transition={{ type: "spring", stiffness: 420, damping: 36 }}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {children}
      </motion.div>
    </motion.div>,
    document.body,
  );
}

export function NewChannelDialog({ people, online, meId, onCreate, onClose }: { people: ChatParty[]; online: string[]; meId?: string; onCreate(c: { name: string; purpose: string; kind: "open" | "private"; members: string[] }): Promise<void>; onClose(): void }) {
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [kind, setKind] = useState<"open" | "private">("open");
  const [members, setMembers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState("");
  const slug = chatSlug(name);
  const submit = async () => {
    if (!slug || busy) return;
    setBusy(true);
    setWhy("");
    try {
      await onCreate({ name: slug, purpose: purpose.trim(), kind, members });
    } catch (e) {
      setWhy((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} label="New channel">
      <h3 className="chat-modal-title">New channel</h3>
      <label className="chat-field">
        <span>Name</span>
        <span className="chat-field-input has-mark">
          <span className="chat-field-mark">#</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. fan-shroud" onKeyDown={(e) => e.key === "Enter" && void submit()} data-new-channel-name />
        </span>
        {name && slug !== name.trim() && <em className="chat-field-note">It will be #{slug || "…"}</em>}
      </label>
      <label className="chat-field">
        <span>What it's for</span>
        <span className="chat-field-input">
          <input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="A sentence, so people know whether to join" />
        </span>
      </label>
      <div className="chat-field">
        <span>Who can find it</span>
        <div className="chat-seg is-wide" role="radiogroup" aria-label="Who can find it">
          <button role="radio" aria-checked={kind === "open"} className={`chat-seg-btn${kind === "open" ? " is-on" : ""}`} onClick={() => setKind("open")}>
            Open · anyone can join
          </button>
          <button role="radio" aria-checked={kind === "private"} className={`chat-seg-btn${kind === "private" ? " is-on" : ""}`} onClick={() => setKind("private")}>
            Private · invited only
          </button>
        </div>
      </div>
      <div className="chat-field">
        <span>People</span>
        <PeoplePicker people={people} chosen={members} onChange={setMembers} exclude={meId ? [meId] : []} online={online} placeholder="Add people now, or later" />
      </div>
      {why && <p className="chat-modal-why">{why}</p>}
      <div className="chat-modal-foot">
        <button className="f-pill" onClick={onClose}>
          Cancel
        </button>
        <button className="f-pill is-accent" disabled={!slug || busy} onClick={() => void submit()} data-new-channel-create>
          {busy ? "Making it…" : "Create channel"}
        </button>
      </div>
    </Modal>
  );
}

export function NewDirectDialog({ people, online, meId, onStart, onClose }: { people: ChatParty[]; online: string[]; meId?: string; onStart(ids: string[]): Promise<void>; onClose(): void }) {
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState("");
  const start = async () => {
    if (!chosen.length || busy) return;
    setBusy(true);
    try {
      await onStart(chosen);
    } catch (e) {
      setWhy((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} label="New message">
      <h3 className="chat-modal-title">New message</h3>
      <p className="chat-modal-lede">One person is a direct message; a few (up to eight) are a group. Only they can read it.</p>
      <PeoplePicker people={people} chosen={chosen} onChange={setChosen} exclude={meId ? [meId] : []} online={online} autoFocus />
      {why && <p className="chat-modal-why">{why}</p>}
      <div className="chat-modal-foot">
        <button className="f-pill" onClick={onClose}>
          Cancel
        </button>
        <button className="f-pill is-accent" disabled={!chosen.length || busy} onClick={() => void start()} data-new-direct-start>
          {chosen.length > 1 ? "Start the group" : "Start"}
        </button>
      </div>
    </Modal>
  );
}

type SwitchRow = { key: string; kind: "channel"; c: ChatChannelView; score: number } | { key: string; kind: "person"; p: ChatParty; score: number };

export function QuickSwitcher({ channels, people, meId, online, onChannel, onPerson, onCommands, onClose }: { channels: ChatChannelView[]; people: ChatParty[]; meId?: string; online: string[]; onChannel(id: string): void; onPerson(id: string): void; onCommands(): void; onClose(): void }) {
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const rows = useMemo((): SwitchRow[] => {
    const direct = new Set(channels.filter((c) => c.kind === "dm" && c.me).flatMap((c) => (c.members ?? []).map((m) => m.id)));
    const out: SwitchRow[] = [];
    for (const c of channels) {
      if (c.archivedAt || (!c.me && c.kind !== "open") || c.kind === "portal") continue;
      const s = fuzzyScore(q, chatTitle(c, meId));
      // with nothing typed: the ones with something waiting, then the latest
      if (s > 0) out.push({ key: `c:${c.id}`, kind: "channel", c, score: q ? s + (c.me ? 5 : 0) : (c.unread ? 1e13 : 0) + c.lastPostAt + (c.me ? 1e12 : 0) });
    }
    for (const p of people) {
      if (p.id === meId || direct.has(p.id)) continue;
      const s = fuzzyScore(q, p.name);
      if (s > 0 && q) out.push({ key: `p:${p.id}`, kind: "person", p, score: s - 1 });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 12);
  }, [q, channels, people, meId]);
  useEffect(() => setAt(0), [q]);
  useEffect(() => {
    list.current?.querySelector(".is-on")?.scrollIntoView({ block: "nearest" });
  }, [at]);
  const choose = (r?: SwitchRow) => {
    if (!r) return;
    onClose();
    if (r.kind === "channel") onChannel(r.c.id);
    else onPerson(r.p.id);
  };
  return (
    <Modal onClose={onClose} label="Go to a conversation" className="chat-switcher">
      <input
        className="chat-switcher-field"
        autoFocus
        value={q}
        placeholder="Go to a channel or a person"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          const mod = e.metaKey || e.ctrlKey;
          if (mod && e.key.toLowerCase() === "k") {
            e.preventDefault();
            onClose();
            onCommands();
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setAt((i) => Math.min(rows.length - 1, i + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setAt((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            choose(rows[at]);
          }
        }}
        data-chat-switcher
      />
      <div className="chat-switcher-list" ref={list} role="listbox">
        {rows.map((r, i) => (
          <button key={r.key} role="option" aria-selected={i === at} className={`chat-switcher-row${i === at ? " is-on" : ""}`} onMouseEnter={() => setAt(i)} onClick={() => choose(r)} data-switch-row={r.kind === "channel" ? chatTitle(r.c, meId) : r.p.name}>
            {r.kind === "channel" ? (
              <>
                <span className="chat-side-mark">{channelMark(r.c, meId, online)}</span>
                <span className="chat-switcher-name">{chatTitle(r.c, meId)}</span>
                <span className="chat-switcher-detail">{!r.c.me ? "Not joined" : isDirect(r.c) ? (r.c.kind === "agent" ? "Agent" : "Direct message") : r.c.purpose || r.c.topic}</span>
                {r.c.unread > 0 && r.c.me?.notify !== "none" && <span className={`chat-count${isDirect(r.c) || r.c.me?.mentions ? " is-accent" : ""}`}>{r.c.unread}</span>}
              </>
            ) : (
              <>
                <span className="chat-side-mark">
                  <PartyAvatar party={r.p} size={18} online={online.includes(r.p.id)} />
                </span>
                <span className="chat-switcher-name">{r.p.name}</span>
                <span className="chat-switcher-detail">Start a direct message</span>
              </>
            )}
          </button>
        ))}
        {!rows.length && <p className="chat-switcher-none">Nothing by that name. Try a person's first name, or part of a channel's.</p>}
      </div>
      <div className="chat-switcher-foot">
        <span>↑↓ to move · Enter to open · Esc to close</span>
        <span className="chat-head-gap" />
        <span>
          <span className="f-kbd">{keys("mod+K")}</span> again: all of Foundation's commands
        </span>
      </div>
    </Modal>
  );
}
