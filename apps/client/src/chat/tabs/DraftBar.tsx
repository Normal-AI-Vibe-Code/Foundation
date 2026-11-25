/**
 * A message's way out of Foundation, under its words (Message.tsx draws it for any message with
 * `outbound`): an agent's **draft** waits for a person (Send · Edit · Discard), a person's message shows
 * *Sending…*, *Sent by …* or *Not sent: why* with Retry. The server decides who may send (a person, in
 * the conversation); this only asks. Without `live` (the design page) it shows the state and no buttons.
 */

import { useState } from "react";
import type { ChatMessage } from "@foundation/protocol";
import { api } from "../../lib/api";
import { requestId } from "../logic";
import "./inbox.css";

export function DraftBar({ message: m, live = true }: { message: ChatMessage; live?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(m.text);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const o = m.outbound;
  if (!o || m.deletedAt) return null;

  const send = async (edited?: string) => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/chat/messages/${encodeURIComponent(m.id)}/send`, { method: "POST", json: { request_id: requestId(), ...(edited !== undefined && edited !== m.text ? { text: edited } : {}) } });
      setEditing(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const discard = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/chat/messages/${encodeURIComponent(m.id)}/discard`, { method: "POST", json: { confirm: true } });
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  const label =
    o.state === "draft" ? `Draft · not sent${o.by ? ` · written by ${o.by}` : ""}` : o.state === "sending" ? "Sending…" : o.state === "sent" ? `Sent${o.by ? ` by ${o.by}` : ""}` : `Not sent: ${o.error ?? "it failed"}`;
  const waiting = o.state === "draft" || o.state === "failed";

  return (
    <div className={`chat-draft is-${o.state}`} data-outbound={o.state}>
      <span className={`chat-outbound is-${o.state}`}>
        <span className="chat-draft-dot" aria-hidden />
        {label}
      </span>
      {editing && live && (
        <div className="chat-draft-edit">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={Math.min(8, Math.max(2, text.split("\n").length))} autoFocus aria-label="The message, before it's sent" />
        </div>
      )}
      {live && waiting && (
        <div
          className="chat-draft-actions"
          onKeyDown={(e) => {
            if (asking && e.key === "Escape") {
              e.stopPropagation();
              setAsking(false);
            }
          }}
        >
          {asking ? (
            <>
              <span className="chat-draft-ask">Discard this draft? It won't be sent.</span>
              <button type="button" className="f-pill chat-draft-bad" disabled={busy} onClick={() => void discard()}>
                Discard
              </button>
              <button type="button" className="f-pill" disabled={busy} onClick={() => setAsking(false)} autoFocus>
                Keep
              </button>
            </>
          ) : (
            <>
              <button type="button" className="f-pill is-accent" disabled={busy || (editing && !text.trim() && !m.files.length)} onClick={() => void send(editing ? text : undefined)}>
                {busy ? "Sending…" : o.state === "failed" ? "Retry" : "Send"}
              </button>
              {editing ? (
                <button type="button" className="f-pill" disabled={busy} onClick={() => (setEditing(false), setText(m.text))}>
                  Cancel
                </button>
              ) : (
                (m.type === "draft" || o.state === "failed") && (
                  <button type="button" className="f-pill" disabled={busy} onClick={() => (setText(m.text), setEditing(true))}>
                    Edit
                  </button>
                )
              )}
              <button type="button" className="f-pill" disabled={busy} onClick={() => setAsking(true)}>
                Discard…
              </button>
            </>
          )}
        </div>
      )}
      {err && <span className="chat-draft-err" role="alert">{err}</span>}
    </div>
  );
}
