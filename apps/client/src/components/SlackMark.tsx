/**
 * The live Slack mark on a section that follows a Slack channel (the Slack
 * board: one section per channel). It reads the board's `slack` map, which
 * the server alone writes, so it says the same thing to everyone:
 *
 *   live     a breathing ok dot: Slack sends what's posted as it's posted
 *   polling  a still warn dot: read in turn while someone has the board open
 *   waiting  a hollow warn dot: the Slack app isn't in the channel (press to have it join)
 *   offline  a bad dot: Slack isn't connected, and why
 *
 * Beside it, ✦: agents write and keep each section's summary. Violet while
 * it's on (an agent will act); turning it on or off is a person's press.
 */

import { useEffect, useState } from "react";
import { boardMaps, type SlackSectionState } from "@foundation/protocol";
import { api } from "../lib/api";
import { activeBoard } from "../sync/board";
import { toast, useUi } from "../state/ui";

export function useSlackSection(sectionId: string): SlackSectionState | undefined {
  const [state, setState] = useState<SlackSectionState | undefined>(undefined);
  useEffect(() => {
    const b = activeBoard();
    if (!b) return;
    const map = boardMaps(b.doc).slack;
    const read = () => setState(map.get(sectionId));
    read();
    const onChange = (e: { keysChanged: Set<string> }) => e.keysChanged.has(sectionId) && read();
    map.observe(onChange);
    return () => map.unobserve(onChange);
  }, [sectionId]);
  return state;
}

/** "just now", "4 min ago", "3 h ago", "6 Nov" */
export function ago(at: number | undefined, now = Date.now()): string {
  if (!at) return "";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

const WORD: Record<SlackSectionState["state"], string> = { live: "Live", polling: "Polling", waiting: "Not in the channel", offline: "Offline" };

/** what the mark says on roll-over: the channel, how the connection stands, and what a press does */
export function slackTip(st: SlackSectionState, viewer: boolean, now = Date.now()): string {
  const last = st.lastAt ? ` · last post ${ago(st.lastAt, now)}` : "";
  const press = viewer ? "" : st.state === "waiting" ? (st.private ? "" : " · press to join") : st.state === "offline" ? "" : " · press to read it now";
  return `Slack #${st.name} · ${WORD[st.state]}${last}${st.detail ? ` · ${st.detail}` : ""}${press}`;
}

/** Slack's octothorpe as four rounded strokes, in the ink it's given: the brand's four colours stay out of the chrome */
export function SlackGlyph() {
  return (
    <svg className="slack-glyph" viewBox="0 0 14 14" width="12" height="12" aria-hidden="true">
      <path d="M5 1.6v10.8M9 1.6v10.8M1.6 5h10.8M1.6 9h10.8" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

/** the mark alone, for the section header and the design page */
export function SlackMarkView({ st, viewer, busy, onPress, onAgents }: { st: SlackSectionState; viewer: boolean; busy?: boolean; onPress?: () => void; onAgents?: () => void }) {
  const pressable = !viewer && !busy && (st.state === "live" || st.state === "polling" || (st.state === "waiting" && !st.private));
  return (
    <span className="slack-marks">
      <button
        type="button"
        className={`slack-mark is-${st.state}${busy ? " is-busy" : ""}`}
        data-tip={slackTip(st, viewer)}
        aria-label={slackTip(st, true)}
        disabled={!pressable}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onPress}
      >
        <SlackGlyph />
        <span className="slack-mark-word">{st.state === "waiting" ? "Join" : WORD[st.state]}</span>
        <span className="slack-mark-dot" />
      </button>
      {(st.agents || !viewer) && (
        <button
          type="button"
          className={`slack-agents${st.agents ? " is-on" : ""}`}
          data-tip={
            st.agents
              ? `Agents keep this board's summaries · turned on by ${st.agents.by}${st.summaryBy ? ` · this one by ✦ ${st.summaryBy}, ${ago(st.summaryAt)}` : st.state === "waiting" || st.state === "offline" ? "" : " · this one is waiting its turn"}${viewer ? "" : " · press to turn them off"}`
              : "Have agents write each section's summary and keep it · every summary is an agent turn on your Claude subscription or API credits"
          }
          aria-label={st.agents ? "Agents keep the summaries: on" : "Agents keep the summaries: off"}
          aria-pressed={Boolean(st.agents)}
          disabled={viewer}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onAgents}
        >
          ✦
        </button>
      )}
    </span>
  );
}

export function SlackMark({ sectionId }: { sectionId: string }) {
  const st = useSlackSection(sectionId);
  const viewer = useUi().role === "viewer";
  const [busy, setBusy] = useState(false);
  // "4 min ago" in the roll-over stays true while the board sits open
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!st) return;
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [Boolean(st)]);
  if (!st) return null;
  const board = encodeURIComponent(activeBoard()?.boardId ?? "");
  const press = async () => {
    setBusy(true);
    try {
      await api(`/api/slack/board/${st.state === "waiting" ? "join" : "sync"}?board=${board}`, { method: "POST", json: { channel: st.channel } });
      if (st.state === "waiting") toast(`The Slack app joined #${st.name}`, "ok");
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };
  const agents = async () => {
    try {
      const r = await api<{ on: boolean }>(`/api/slack/board/agents?board=${board}`, { method: "POST", json: { on: !st.agents } });
      toast(r.on ? "Agents will write each section's summary and keep it. Press ✦ again to stop them" : "Agents are off for the Slack board", r.on ? "ok" : undefined);
    } catch (e) {
      toast((e as Error).message, "bad");
    }
  };
  return <SlackMarkView st={st} viewer={viewer} busy={busy} onPress={() => void press()} onAgents={() => void agents()} />;
}
