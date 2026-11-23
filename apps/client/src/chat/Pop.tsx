/**
 * The small pieces the head and the dialogs share: a popover on raised paper that a press outside (or
 * Esc) puts away, and a people picker (a field, the chosen as chips, the matches as rows).
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import type { ChatParty } from "@foundation/protocol";
import { PartyAvatar } from "./Avatar";
import { fuzzyScore } from "./logic";

export function Pop({ onClose, children, className = "", label }: { onClose(): void; children: ReactNode; className?: string; label?: string }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const off = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      // the button that opened it toggles it itself
      if (!box.current?.contains(t) && !t.closest?.("[data-pop-anchor]")) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("pointerdown", off, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", off, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [onClose]);
  return (
    <motion.div
      ref={box}
      className={`chat-pop ${className}`}
      role="dialog"
      aria-label={label}
      initial={{ opacity: 0, y: -4, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -2 }}
      transition={{ type: "spring", stiffness: 520, damping: 38 }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {children}
    </motion.div>
  );
}

export function PeoplePicker({
  people,
  chosen,
  onChange,
  exclude = [],
  online = [],
  placeholder = "Find people by name",
  autoFocus,
  invalid,
  describedBy,
}: {
  people: ChatParty[];
  chosen: string[];
  onChange(ids: string[]): void;
  exclude?: string[];
  online?: string[];
  placeholder?: string;
  autoFocus?: boolean;
  invalid?: boolean;
  describedBy?: string;
}) {
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const found = useMemo(
    () =>
      people
        .filter((p) => !exclude.includes(p.id) && !chosen.includes(p.id))
        .map((p) => ({ p, s: fuzzyScore(q, p.name) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s || a.p.name.localeCompare(b.p.name))
        .slice(0, 8)
        .map((x) => x.p),
    [people, exclude, chosen, q],
  );
  const add = (id: string) => {
    onChange([...chosen, id]);
    setQ("");
    setAt(0);
  };
  return (
    <div className="chat-people">
      <div className="chat-people-field">
        {chosen.map((id) => (
          <span key={id} className="chat-people-chip">
            {byId.get(id)?.name ?? id}
            <button type="button" onClick={() => onChange(chosen.filter((x) => x !== id))} aria-label={`Remove ${byId.get(id)?.name ?? id}`}>
              ✕
            </button>
          </span>
        ))}
        <input
          autoFocus={autoFocus}
          value={q}
          placeholder={chosen.length ? "" : placeholder}
          onChange={(e) => {
            setQ(e.target.value);
            setAt(0);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setAt((i) => Math.min(found.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setAt((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter" && found[at]) {
              e.preventDefault();
              add(found[at].id);
            } else if (e.key === "Backspace" && !q && chosen.length) onChange(chosen.slice(0, -1));
          }}
          aria-label={placeholder}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={describedBy}
          aria-controls="chat-people-listbox"
          aria-activedescendant={found[at] ? `chat-person-opt-${at}` : undefined}
        />
      </div>
      <div className="chat-people-list" id="chat-people-listbox" role="listbox" aria-label="Matching people">
        {found.map((p, i) => (
          <button
            key={p.id}
            id={`chat-person-opt-${i}`}
            type="button"
            role="option"
            aria-selected={i === at}
            className={`chat-people-row${i === at ? " is-on" : ""}`}
            onMouseEnter={() => setAt(i)}
            onClick={() => add(p.id)}
            data-person={p.name}
          >
            <PartyAvatar party={p} size={20} online={online.includes(p.id)} />
            <span>{p.name}</span>
          </button>
        ))}
        {!found.length && <p className="chat-people-none">{q ? "Nobody by that name" : "Everyone's in"}</p>}
      </div>
    </div>
  );
}
