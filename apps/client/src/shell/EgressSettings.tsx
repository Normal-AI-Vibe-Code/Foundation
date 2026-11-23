/**
 * "Agents on this board may send to": what an agent on this board may send to
 * an external service, one row per kind of send (SECURITY.md rule 8; the
 * server's egress.ts). Every board starts with nothing allowed. A person who
 * can edit the board flips a row (on a members-only board, its owner or an
 * admin); everyone else sees the state, the switches held, and a line saying
 * who can change them. A person's own search or read from their browser is
 * theirs and needs none of this.
 *
 * In the space's pane (SpaceInfo), under who can change the grid; drawn on
 * #/design from EgressView with the same props.
 */

import { ErrorCard } from "../components/ErrorCard";
import { useEffect, useState } from "react";
import { api } from "../lib/api";

export interface EgressKind {
  kind: string;
  /** what is sent, in plain words */
  sends: string;
  allowed: boolean;
  allowedBy?: string;
  allowedAt?: number;
}
export interface EgressService {
  service: string;
  provenance: "external";
  /** "External service · Slack" */
  badge: string;
  configured: boolean;
  kinds: EgressKind[];
}
export interface EgressState {
  services: EgressService[];
  canChange: boolean;
  /** who can change these, in a line */
  who: string;
  /** why this person can't, when they can't */
  why?: string;
}

export function EgressView({ state, busy, error, onToggle }: { state: EgressState; busy?: string | null; error?: string | null; onToggle?: (service: string, kind: string, on: boolean) => void }) {
  const shown = state.services.filter((s) => s.configured);
  return (
    <section className="pane-group egress" aria-label="Agents on this board may send to">
      <div className="pane-eyebrow">Agents on this board may send to</div>
      {shown.length === 0 && <div className="pane-empty">This server has no outside services set up, so agents here send nothing outside.</div>}
      {shown.map((s) => (
        <div key={s.service} className="egress-service">
          <div className="egress-head">
            <span className="egress-name">{s.service}</span>
            <span className="egress-badge" title="Where it runs: a service outside the company">
              <span aria-hidden="true">↗</span> {s.badge}
            </span>
          </div>
          {s.kinds.map((k) => {
            const id = `${s.service}:${k.kind}`;
            return (
              <div key={id} className={`egress-row${k.allowed ? " is-on" : ""}`}>
                <div className="egress-what">
                  <span className="egress-sends">{k.sends}</span>
                  <span className="egress-state">{k.allowed ? `Allowed${k.allowedBy ? ` by ${k.allowedBy}` : ""}` : "Not allowed"}</span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={k.allowed}
                  aria-label={`${s.service}: ${k.sends}`}
                  className="egress-switch"
                  disabled={!state.canChange || busy === id}
                  onClick={() => onToggle?.(s.service, k.kind, !k.allowed)}
                >
                  <span className="egress-knob" />
                </button>
              </div>
            );
          })}
        </div>
      ))}
      <div className="pane-empty egress-who">{state.canChange ? `Off until someone turns it on. ${state.who}` : state.who}</div>
      {error && <ErrorCard message={error} />}
    </section>
  );
}

/** the live section for one board: reads the state, and flips a row as the person (the server checks who) */
export function Egress({ board }: { board: string }) {
  const [state, setState] = useState<EgressState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const path = `/api/boards/${encodeURIComponent(board)}/egress`;
  useEffect(() => {
    setState(null);
    api<EgressState>(path)
      .then(setState)
      .catch(() => setState(null));
  }, [path]);
  if (!state) return null;
  const toggle = async (service: string, kind: string, on: boolean) => {
    setBusy(`${service}:${kind}`);
    try {
      setState(await api<EgressState>(path, { method: on ? "POST" : "DELETE", json: { service, kind } }));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return <EgressView state={state} busy={busy} error={error} onToggle={(s, k, on) => void toggle(s, k, on)} />;
}
