/**
 * A Slack channel on the board. Its messages (polled while the card is on
 * screen; the server shares one read among everyone looking), a field to post
 * under your own name ("Noa via Foundation"), and two ways to bring the
 * channel here: send it a link to any place on the board, or invite it to a
 * huddle — the portal opens beside the card if there isn't one yet.
 */

import { useEffect, useRef, useState } from "react";
import { allObjects, getState, uid, updatePanel, type PanelMeta } from "../state/store";
import { api } from "../lib/api";
import { activeBoard } from "../sync/board";
import { askAgent, toast } from "../state/ui";
import { useOnScreen } from "./PanelView";

interface SlackMessage {
  ts: string;
  at: number;
  name: string;
  text: string;
  replies?: number;
  viaFoundation?: boolean;
}
interface SlackChannel {
  id: string;
  name: string;
  private: boolean;
  member: boolean;
  members?: number;
  topic?: string;
}
interface Status {
  connected: boolean;
  team?: string;
  reason?: string;
}

export function SlackBody({ panel }: { panel: PanelMeta }) {
  const host = useRef<HTMLDivElement>(null);
  const onScreen = useOnScreen(host, 0.25);
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    if (!onScreen || status) return;
    api<Status>("/api/slack/status")
      .then(setStatus)
      .catch((e) => setStatus({ connected: false, reason: (e as Error).message }));
  }, [onScreen, status]);

  return (
    <div ref={host} className="slack-body">
      {!status ? (
        <div className="slack-empty">Reaching Slack…</div>
      ) : !status.connected ? (
        <div className="slack-off">
          <div className="connector-offline">
            <div className="connector-offline-title">Slack isn't connected</div>
            <div className="connector-offline-reason">{status.reason}</div>
          </div>
          <div className="connector-foot">
            <button className="f-pill is-agent" onClick={() => askAgent("The Slack card says Slack isn't connected. Walk me through connecting Foundation's Slack app (SPEC §6, docs/slack-app-manifest.yml).")}>
              ✦ How do I connect it?
            </button>
          </div>
        </div>
      ) : !panel.channel ? (
        <ChannelPicker panel={panel} team={status.team} />
      ) : (
        <Channel panel={panel} live={onScreen} />
      )}
    </div>
  );
}

function ChannelPicker({ panel, team }: { panel: PanelMeta; team?: string }) {
  const [channels, setChannels] = useState<SlackChannel[] | null>(null);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    api<{ channels: SlackChannel[] }>("/api/slack/channels")
      .then((r) => setChannels(r.channels))
      .catch((e) => setError((e as Error).message));
  }, []);
  const shown = (channels ?? []).filter((c) => c.name.includes(q.replace(/^#/, "").toLowerCase()));
  return (
    <div className="slack-picker">
      <div className="f-eyebrow">Pick a channel{team ? ` · ${team}` : ""}</div>
      <input autoFocus className="slack-filter" value={q} onChange={(e) => setQ(e.target.value)} placeholder="#channel" />
      <div className="slack-channels wheel-own">
        {error ? (
          <div className="slack-empty">{error}</div>
        ) : !channels ? (
          <div className="slack-empty">Listing channels…</div>
        ) : (
          shown.map((c) => (
            <button key={c.id} className="slack-channel-row" onClick={() => updatePanel(panel.id, { channel: c.id, name: `#${c.name}`, text: c.topic })}>
              <b>{c.private ? "🔒" : "#"}</b>
              <span>{c.name}</span>
              <i>{c.member ? "app is in it" : c.private ? "invite the app first" : `${c.members ?? "?"} people`}</i>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function Channel({ panel, live }: { panel: PanelMeta; live: boolean }) {
  const boardId = activeBoard()?.boardId ?? "company";
  const [msgs, setMsgs] = useState<SlackMessage[] | null>(null);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [places, setPlaces] = useState(false);
  const list = useRef<HTMLDivElement>(null);

  const load = (fresh = false) =>
    api<{ messages: SlackMessage[] }>(`/api/slack/channels/${panel.channel}${fresh ? "?fresh=1" : ""}`)
      .then((r) => {
        setMsgs(r.messages);
        setError("");
      })
      .catch((e) => setError((e as Error).message));

  useEffect(() => {
    if (!live) return;
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [live, panel.channel]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs?.length]);

  const post = async (path: string, json: unknown, done: string) => {
    setSending(true);
    try {
      await api(`/api/slack/channels/${panel.channel}/${path}`, { method: "POST", json });
      toast(done, "ok");
      await load(true);
      return true;
    } catch (e) {
      toast((e as Error).message, "bad");
      return false;
    } finally {
      setSending(false);
    }
  };

  const send = async () => {
    if (!draft.trim() || sending) return;
    if (await post("messages", { text: draft }, `Posted to ${panel.name}`)) setDraft("");
  };

  const share = (objectId: string | undefined, title: string) => {
    setPlaces(false);
    void post("share", { board: boardId, objectId, title }, `Sent ${panel.name} a link to ${title}`);
  };

  /** invite the channel to its huddle: the one opened for it, else one in this section, else a new one beside the card */
  const invite = async () => {
    const huddles = Object.values(getState().panels).filter((p) => p.panel === "huddle");
    let huddle = huddles.find((p) => p.channel === panel.channel);
    const near = !huddle && huddles.find((p) => p.sectionId === panel.sectionId && !p.channel);
    if (near) {
      updatePanel(near.id, { channel: panel.channel });
      huddle = near;
    }
    if (!huddle) {
      // a new huddle: the server makes the card and sends the invite in one go (it arrives here by sync)
      const name = `Huddle · ${panel.name}`;
      const create = { id: uid("pnl"), sectionId: panel.sectionId, name, x: panel.x + panel.w + 32, y: panel.y };
      void post("invite", { board: boardId, create }, `Invited ${panel.name} to ${name}`);
      return;
    }
    void post("invite", { board: boardId, huddleId: huddle.id }, `Invited ${panel.name} to ${huddle.name}`);
  };

  return (
    <div className="slack-channel">
      <div className="slack-head">
        <span className="connector-status is-live">
          <span className="f-dot is-ok is-live" />
          Slack
        </span>
        <span className="slack-topic">{panel.text}</span>
      </div>
      <div ref={list} className="slack-messages wheel-own">
        {error ? (
          <div className="connector-offline">
            <div className="connector-offline-title">Can't read {panel.name}</div>
            <div className="connector-offline-reason">{error}</div>
          </div>
        ) : !msgs ? (
          <div className="slack-empty">Reading {panel.name}…</div>
        ) : msgs.length === 0 ? (
          <div className="slack-empty">No messages yet.</div>
        ) : (
          msgs.map((m, i) => {
            const same = i > 0 && msgs[i - 1].name === m.name && m.at - msgs[i - 1].at < 5 * 60_000;
            return (
              <div key={m.ts} className={`slack-msg${same ? " is-cont" : ""}${m.viaFoundation ? " is-ours" : ""}`}>
                {!same && (
                  <div className="slack-msg-head">
                    <b>{m.name}</b>
                    <time>{new Date(m.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time>
                  </div>
                )}
                <p>{linkify(m.text)}</p>
                {m.replies ? <span className="slack-replies">{m.replies} replies in Slack</span> : null}
              </div>
            );
          })
        )}
      </div>
      {places && <PlacePicker onPick={share} onClose={() => setPlaces(false)} />}
      <div className="slack-compose">
        <textarea
          value={draft}
          rows={2}
          placeholder={`Message ${panel.name}`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="slack-actions">
          <button className="f-pill" disabled={sending} onClick={() => setPlaces(!places)} data-tip="Send the channel a link straight to a place on this board">
            ↗ Link a place
          </button>
          <button className="f-pill" disabled={sending} onClick={() => void invite()} data-tip="Post an invite to a huddle on the board, beside this card">
            ◐ Invite to a huddle
          </button>
          <button className="f-pill is-accent slack-send" disabled={sending || !draft.trim()} onClick={() => void send()}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function PlacePicker({ onPick, onClose }: { onPick(objectId: string | undefined, title: string): void; onClose(): void }) {
  const st = getState();
  const sections = Object.values(st.sections);
  const cards = allObjects().filter((o) => o.name);
  return (
    <div className="slack-places wheel-own" role="dialog" aria-label="Link a place">
      <div className="slack-places-head">
        <span className="f-eyebrow">Send a link to…</span>
        <button className="icon-btn" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      <button className="slack-place" onClick={() => onPick(undefined, activeBoard()?.boardId === "company" ? "The company board" : "This board")}>
        <b>▦</b> The whole board
      </button>
      {sections.map((s) => (
        <div key={s.id}>
          <button className="slack-place" onClick={() => onPick(s.host ?? s.id, s.name)}>
            <b>▢</b> {s.name}
          </button>
          {cards
            .filter((o) => o.sectionId === s.id && o.id !== s.host)
            .map((o) => (
              <button key={o.id} className="slack-place is-card" onClick={() => onPick(o.id, o.name)}>
                {o.name}
              </button>
            ))}
        </div>
      ))}
    </div>
  );
}

function linkify(text: string) {
  const parts = text.split(/(https?:\/\/[^\s)]+)/g);
  return parts.map((p, i) =>
    /^https?:\/\//.test(p) ? (
      <a key={i} href={p} target="_blank" rel="noreferrer">
        {p.replace(/^https?:\/\//, "").slice(0, 48)}
      </a>
    ) : (
      p
    ),
  );
}
