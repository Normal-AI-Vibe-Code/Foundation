/**
 * The moment (docs/timeline.md §3): beside the playhead, what was said around it in the timeline's scope (asks,
 * answers, messages, huddles; the nearest one marked), what is held back said quietly as its own line, and the voice
 * and video notes left then, which play here, even after their card has gone.
 *
 * A chat card whose conversation lives on a chat server of its own has no events on Foundation's server: the
 * conversation is asked of that server, as the person looking, scrolling back a few pages to the moment (the chat
 * server pages by message, not by time). Further back than that, or on a chat server this device isn't on, it says
 * where the conversation is and opens it there.
 *
 * Sections that were on the grid then and are gone now are listed: the grid draws only the sections it has.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { boardMaps, type ChatMessage, type ChatPage, type MediaNoteInfo, type ObjectDoc, type TimelineEvent } from "@foundation/protocol";
import { useFileSrc } from "../lib/fileSrc";
import { getState } from "../state/store";
import { goChat } from "../lib/place";
import { restOf } from "../chat/logic";
import { CHAT_SERVER, chatApi } from "../chat/server";
import { chatServerName } from "../chat/serverLogic";
import { count, momentAround, whenWords } from "./logic";
import { frameEvent } from "./Lanes";
import { usePlayhead, type Timeline } from "./model";

const KIND_WORD: Record<string, string> = { "chat.ask": "asked", "chat.answer": "answered", "chat.message": "said" };

export function Moment({ tl, seek, compact = false }: { tl: Timeline; seek: (t: number | null) => void; compact?: boolean }) {
  const span = Math.max(60_000, tl.to - tl.from);
  // a step of the range's 1/240: the list follows a scrub without redrawing on every pixel
  usePlayhead(tl.head, Math.max(1000, span / 240));
  const t = tl.head.t ?? tl.to;
  const events = tl.slice?.events ?? [];
  const window = Math.max(5 * 60_000, span / 24);
  const m = useMemo(() => momentAround(events, t, window), [events, t, window]);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = list.current?.querySelector<HTMLElement>("[data-tl-said].is-now");
    const box = list.current;
    if (!el || !box) return;
    const top = el.offsetTop - box.offsetTop;
    if (top < box.scrollTop || top > box.scrollTop + box.clientHeight - el.offsetHeight) box.scrollTo({ top: Math.max(0, top - box.clientHeight / 3) });
  }, [m.nearest]);
  const doc = tl.head.t !== null && tl.player ? tl.player.docAt(tl.head.t) : null;
  const remote = useMemo(() => remoteChats(doc ? [...boardMaps(doc).objects.values()] : null, tl.sectionId && !tl.childName ? tl.sectionId : null), [doc, tl.player?.version, tl.sectionId, tl.childName]); // eslint-disable-line react-hooks/exhaustive-deps
  const gone = useMemo(() => (doc ? goneAt(doc, tl.slice?.sections ?? []) : []), [doc, tl.player?.version, tl.slice]); // eslint-disable-line react-hooks/exhaustive-deps
  const nothing = !m.said.length && !m.notes.length && !remote.length;
  return (
    <section className={`tl-moment${compact ? " is-compact" : ""}`} aria-label="Around this moment" data-tl-moment={tl.key}>
      <header className="tl-moment-head">
        <span className="tl-eyebrow">{tl.head.t === null ? "Lately" : "Around then"}</span>
        <span className="tl-moment-when">{whenWords(tl.head.t)}</span>
      </header>
      <div ref={list} className="tl-moment-list wheel-own">
        {tl.sliceState === "loading" && !tl.slice && <p className="tl-quiet">Reading what was said…</p>}
        {tl.slice && nothing && <p className="tl-quiet">Nothing was said or left here within {spanWords(window)} of this moment.</p>}
        {m.said.map((s) => (
          <button key={s.id} type="button" className={`tl-said is-${s.kind.replace(".", "-")}${s.id === m.nearest ? " is-now" : ""}${s.at > t ? " is-later" : ""}`} onClick={() => (seek(s.at), frameEvent(s.event))} data-tl-said={s.kind}>
            <time>{clock(s.at)}</time>
            <span className="tl-said-main">
              <b className={s.agent ? "is-agent" : undefined}>{s.who}</b> <span className="tl-said-kind">{KIND_WORD[s.kind] ?? s.text}</span>
              {s.body ? <span className="tl-said-body">{s.body}</span> : s.kind in KIND_WORD && !s.withheld ? <span className="tl-said-body is-plain">{s.text}</span> : null}
              {s.withheld && <span className="tl-withheld" data-tl-withheld>{s.withheld}</span>}
            </span>
          </button>
        ))}
        {m.notes.map((n) => (
          <NoteMark key={n.id} e={n} onPick={() => (seek(n.at), frameEvent(n))} />
        ))}
        {remote.map((c) => (
          <RemoteChat key={c.id} card={c} at={t} />
        ))}
        {gone.length > 0 && (
          <div className="tl-gone" data-tl-gone={gone.length}>
            <span className="tl-eyebrow">Sections that were here</span>
            <span className="tl-quiet">
              {gone.join(", ")}: {gone.length === 1 ? "it's" : "they're"} gone from the grid now, so {gone.length === 1 ? "it isn't" : "they aren't"} drawn.
            </span>
          </div>
        )}
      </div>
    </section>
  );
}

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
const spanWords = (ms: number) => (ms >= 3_600_000 ? count(Math.round(ms / 3_600_000), "hour") : count(Math.round(ms / 60_000), "minute"));

/** the sections a board held then that it doesn't now: as the server says (the slice's `gone`), or as this grid shows */
function goneAt(doc: import("yjs").Doc, named: Array<{ id: string; gone?: boolean }>): string[] {
  const live = getState().allSections ?? getState().sections;
  const showing = Object.keys(live).length > 0;
  return [...boardMaps(doc).sections.values()]
    .filter((s) => {
      const n = named.find((x) => x.id === s.id);
      return n ? !!n.gone : showing && !live[s.id];
    })
    .map((s) => s.name);
}

type ChatCard = Extract<ObjectDoc, { kind: "panel" }>;
/** the chat cards in scope then whose conversation is on a chat server of its own */
function remoteChats(objects: ObjectDoc[] | null, sectionId: string | null): ChatCard[] {
  const all = objects ?? (Object.values(getState().panels) as unknown as ObjectDoc[]);
  return all.filter((o): o is ChatCard => o.kind === "panel" && o.panel === "chat" && !!o.channel && !!o.chatServer && (!sectionId || o.sectionId === sectionId));
}

/**
 * One remote conversation as far as the moment: asked of its chat server as the person looking (a few pages back at
 * most). It can't be asked when this device's ChatForm is on another server, or the moment is further back.
 */
function RemoteChat({ card, at }: { card: ChatCard; at: number }) {
  const server = card.chatServer!;
  const here = server === CHAT_SERVER;
  const name = chatServerName(server);
  const bucket = Math.floor(at / 60_000);
  const [s, setS] = useState<{ messages: ChatMessage[]; reached: boolean; why: string | null } | null>(null);
  useEffect(() => {
    if (!here || !card.channel) return;
    const ctrl = new AbortController();
    setS(null);
    void (async () => {
      try {
        const msgs: ChatMessage[] = [];
        let page = await chatApi<ChatPage>(`/api/chat/channels/${encodeURIComponent(card.channel!)}/messages?limit=50`, { signal: ctrl.signal });
        msgs.unshift(...page.messages.filter((m) => !m.root));
        // back, a page at a time, until the moment is covered (four pages at most: two hundred messages)
        for (let i = 0; i < 4 && page.before && msgs.length && msgs[0].createdAt > at; i++) {
          page = await chatApi<ChatPage>(`/api/chat/channels/${encodeURIComponent(card.channel!)}/messages?before=${msgs[0].seq}&limit=50`, { signal: ctrl.signal });
          msgs.unshift(...page.messages.filter((m) => !m.root));
        }
        const reached = !msgs.length || msgs[0].createdAt <= at || !page.before;
        setS({ messages: msgs.filter((m) => m.createdAt <= at && !m.deletedAt).slice(-4), reached, why: null });
      } catch (e) {
        if ((e as Error).name !== "AbortError") setS({ messages: [], reached: false, why: (e as Error).message });
      }
    })();
    return () => ctrl.abort();
  }, [here, card.channel, bucket]); // eslint-disable-line react-hooks/exhaustive-deps
  const open = () => goChat("chat", restOf({ channel: card.channel!, at: s?.messages.at(-1)?.seq }));
  if (!here || (s && (!s.reached || s.why)))
    return (
      <div className="tl-remote" data-tl-remote={card.id}>
        <span className="tl-eyebrow">{card.name || "A conversation"}</span>
        <span className="tl-quiet">
          This conversation is on {name}
          {s?.why ? ` (${s.why})` : here ? ", further back than this reads" : ""}.{" "}
          {here ? (
            <button type="button" className="tl-link" onClick={open}>
              Open it there
            </button>
          ) : (
            <>Open it in ChatForm on {name} to read it at this time.</>
          )}
        </span>
      </div>
    );
  return (
    <div className="tl-remote" data-tl-remote={card.id}>
      <span className="tl-eyebrow">
        {card.name || "A conversation"} · on {name}
      </span>
      {!s && <span className="tl-quiet">Asking {name}…</span>}
      {s && !s.messages.length && <span className="tl-quiet">Nothing was said in it yet.</span>}
      {s?.messages.map((msg) => (
        <span key={msg.id} className="tl-said is-chat-message is-remote">
          <time>{clock(msg.createdAt)}</time>
          <span className="tl-said-main">
            <b className={msg.author.kind === "agent" ? "is-agent" : undefined}>{msg.author.name}</b> <span className="tl-said-body">{msg.text}</span>
          </span>
        </span>
      ))}
      {s && (
        <button type="button" className="tl-link" onClick={open}>
          Open it in ChatForm
        </button>
      )}
    </div>
  );
}

/** a voice or video note, playable where it's listed */
export function NoteMark({ e, onPick }: { e: TimelineEvent; onPick?: () => void }) {
  const note = (e.data?.note ?? null) as MediaNoteInfo | null;
  const video = e.kind === "note.video";
  const src = useFileSrc(note ? `/files/${note.fileId}` : null);
  const media = useRef<HTMLAudioElement & HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const toggle = () => {
    const el = media.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => {});
    else el.pause();
  };
  const secs = note ? Math.round(note.ms / 1000) : 0;
  return (
    <div className={`tl-note${video ? " is-video" : ""}`} data-tl-note={e.kind}>
      <button type="button" className="tl-note-play" onClick={toggle} disabled={!note} aria-label={playing ? "Pause" : `Play ${e.actor.name}'s ${video ? "video" : "voice"} note`} data-tip={note ? (playing ? "Pause" : "Play it here") : (e.withheld ?? "Not yours to play")}>
        {playing ? (
          <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden>
            <rect x="3" y="2.2" width="2.8" height="9.6" rx="0.8" fill="currentColor" />
            <rect x="8.2" y="2.2" width="2.8" height="9.6" rx="0.8" fill="currentColor" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden>
            <path d="M3.5 2.2v9.6L11.6 7Z" fill="currentColor" />
          </svg>
        )}
      </button>
      <button type="button" className="tl-note-main" onClick={onPick}>
        <span className="tl-note-head">
          <b>{e.actor.name}</b> {video ? "left a video note" : "left a voice note"} <time>{clock(e.at)}</time>
        </span>
        {video ? null : <Wave peaks={note?.peaks} />}
        <span className="tl-quiet">{note ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}` : (e.withheld ?? "")}</span>
      </button>
      {note && video && <video ref={media} className="tl-note-video" src={src} playsInline preload="metadata" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />}
      {note && !video && <audio ref={media} src={src} preload="none" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />}
    </div>
  );
}

function Wave({ peaks }: { peaks?: number[] }) {
  const p = peaks?.length ? peaks : Array.from({ length: 32 }, () => 0.2);
  return (
    <span className="tl-wave" aria-hidden>
      {p.slice(0, 48).map((v, i) => (
        <i key={i} style={{ height: `${Math.max(12, Math.min(1, v) * 100)}%` }} />
      ))}
    </span>
  );
}
