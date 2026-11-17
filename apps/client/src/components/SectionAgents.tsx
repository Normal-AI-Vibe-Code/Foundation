/**
 * The agents of a section, in the section.
 *
 * Three faces of one view (2026-11-13, Josh: "bring the agent view into the
 * sections … make apparent the ability to have agents collaborate and build
 * things in the interface with the user"):
 *
 * - **The chip** on every section's header, at rest: ✦ Agents, or how many
 *   are at work there. It is always there, so a section says it can be worked
 *   in by agents before anyone has asked.
 * - **The panel** the chip opens, standing in the section's top-right corner
 *   and moving with it: who is at work here (a lead and its helpers as one
 *   team), what each is doing, what agents made here lately, and a place to
 *   ask one. An ask from here brings an agent into this section under its own
 *   name and cursor, in front of everyone on the board.
 * - **The card** (`panel: "crew"`, from the right-click menu or the panel's
 *   own "Keep on the section"): the same view as a card on the board, so it
 *   stays, and everyone sees it.
 *
 * The panel is drawn at screen size, like the crew's cursors and the tab
 * above a section (SectionCrew.tsx): readable at any zoom, and it works the
 * same over either renderer, because it reads the store's rects.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { crewTeams, togetherWords } from "../lib/sectionCrew";
import { boardWhere, useSectionCrew } from "../lib/crewWatch";
import { LiveAgentRow, rowOf } from "../shell/AgentsPane";
import { useActiveBoard } from "../shell/Presence";
import { camera, onCamera } from "../state/camera";
import { askCrew } from "../state/sessions";
import { SECTION_HEADER, addPanel, getState, sectionCardRect, subscribe } from "../state/store";
import { floorInsets, toast, useUi } from "../state/ui";
import { openAgentsPane } from "./SectionCrew";
import { closeSectionAgents, openSectionAgents, toggleSectionAgents, useSectionAgentsOpen } from "../lib/sectionAgentsOpen";

// which section's panel is open: lib/sectionAgentsOpen.ts (the toolbar's rules open it without a page)
export { closeSectionAgents, openSectionAgents, toggleSectionAgents };
const useOpen = useSectionAgentsOpen;

// ---------- what agents did here lately ----------

/** is this card or section inside `sectionId` (itself, or a section within it)? */
function isWithin(objectId: string, sectionId: string): boolean {
  let at = boardWhere.sectionOfObject(objectId) ?? (boardWhere.hasSection(objectId) ? objectId : undefined);
  for (let i = 0; at && i < 16; i++) {
    if (at === sectionId) return true;
    at = boardWhere.parentOf(at);
  }
  return false;
}

export function agoWords(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 50) return "just now";
  if (s < 3300) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86_400) return `${Math.max(1, Math.round(s / 3600))} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

export interface AgentLine {
  at: number;
  who: string;
  text: string;
  for?: string;
}

// ---------- the view ----------

const STARTERS = ["Organize what's here", "Summarize this section in a note", "Make a table from what's here"];

/** the view alone, for the panel, the card and the design page */
export function SectionAgentsView({
  sectionName,
  teams,
  recent,
  canAsk,
  focus = false,
  onAsk,
  now,
}: {
  sectionName: string;
  /** the agents at work here, already drawn as rows, a team to a list */
  teams: React.ReactNode;
  recent: AgentLine[];
  canAsk: boolean;
  focus?: boolean;
  onAsk?: (text: string) => void;
  now?: number;
}) {
  const [text, setText] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focus) field.current?.focus({ preventScroll: true });
  }, [focus]);
  const send = () => {
    const t = text.trim();
    if (!t) return;
    onAsk?.(t);
    setText("");
  };
  return (
    <div className="sa-body">
      {teams ?? (
        <p className="sa-none">
          No agents are at work in <b>{sectionName}</b>. {canAsk ? "Ask for something below: an agent comes in under its own name and cursor, and builds it here where everyone on the board can watch, follow or stop it." : "When one comes in, it shows here."}
        </p>
      )}
      {recent.length > 0 && (
        <div className="sa-recent">
          <div className="sa-label">Made here by agents</div>
          {recent.map((a, i) => (
            <div key={`${a.at}:${i}`} className="sa-line" data-tip={a.for ? `For ${a.for}` : undefined}>
              <span className="sa-who">✦ {a.who}</span> <span className="sa-what">{a.text}</span>
              <span className="sa-when">{agoWords(a.at, now)}</span>
            </div>
          ))}
        </div>
      )}
      {canAsk && (
        <form
          className="t3-ask sa-ask"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <textarea
            ref={field}
            className="t3-ask-text"
            rows={2}
            value={text}
            placeholder={`What should an agent build in ${sectionName}?`}
            aria-label={`Ask an agent to work in ${sectionName}`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            onKeyUp={(e) => e.stopPropagation()}
          />
          {!text && (
            <div className="sa-starters">
              {STARTERS.map((s) => (
                <button key={s} type="button" className="sa-starter" onClick={() => (setText(s), field.current?.focus({ preventScroll: true }))}>
                  {s}
                </button>
              ))}
            </div>
          )}
          <div className="t3-ask-foot">
            <span className="t3-ask-note">works on the board, as itself · your plan</span>
            <button type="submit" className="f-pill is-agent t3-ask-send" disabled={!text.trim()}>
              Ask
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/** a section's agents, live: the rows, what they made lately, and the ask */
export function SectionAgentsBody({ sectionId, sectionName, focus }: { sectionId: string; sectionName: string; focus?: boolean }) {
  const crew = useSectionCrew(sectionId);
  const board = useActiveBoard();
  const viewer = useUi().role === "viewer";
  const me = board?.user.id;
  const teams = useMemo(() => crewTeams(crew.map((p) => rowOf(p, me)), (r) => ({ id: r.id, lead: r.lead, target: null })), [crew, me]);
  // the crew's list changes with every step an agent takes: that's when a new line can have landed
  const recent = useMemo(
    () =>
      (board?.activity() ?? [])
        .filter((a) => a.role === "agent" && !!a.objectId && isWithin(a.objectId, sectionId))
        .slice(-3)
        .reverse()
        .map((a) => ({ at: a.at, who: a.who, text: a.text, for: a.for })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [board, crew, sectionId],
  );
  const words = togetherWords(teams);
  return (
    <SectionAgentsView
      sectionName={sectionName}
      canAsk={!viewer}
      focus={focus}
      recent={recent}
      onAsk={(text) => {
        askCrew(`In the “${sectionName}” section: ${text}`);
        toast(`An agent is on its way to ${sectionName}`, "agent");
      }}
      teams={
        teams.length ? (
          <div className="sa-teams" data-sa-teams={crew.length}>
            {/* one team says so on its own block; the count is for when several asks met here */}
            {teams.length > 1 && words && <div className="sa-label">{words}</div>}
            {teams.map((t) => (
              <ul key={t.id} className={`agents-team${t.together ? " is-together" : ""}`} style={{ ["--crew" as string]: `var(--color-crew-${t.members[0].hue % 6})` }}>
                {t.together && (
                  <li className="agents-team-label">
                    Working together <span>· one ask{t.members[0].askerName ? `, for ${t.members[0].askerName.split(" ")[0]}` : ""}</span>
                  </li>
                )}
                {t.members.map((m) => (
                  <LiveAgentRow key={m.id} row={m} team={t} />
                ))}
              </ul>
            ))}
          </div>
        ) : null
      }
    />
  );
}

// ---------- the chip on a section's header ----------

export function SectionAgentsChipView({ working, on = false, sectionName, onPress }: { working: number; on?: boolean; sectionName: string; onPress?: () => void }) {
  const tip = working ? `${working} agent${working === 1 ? "" : "s"} at work in ${sectionName} · press to see them, or ask another` : `Agents can build in ${sectionName} with you · press to ask one`;
  return (
    <button type="button" className={`sec-agents-chip${working ? " is-working" : ""}${on ? " is-on" : ""}`} data-tip={tip} aria-label={tip} aria-pressed={on} data-sec-agents={working} onClick={onPress}>
      {working ? <span className="f-dot is-agent is-live" /> : <span aria-hidden>✦</span>}
      {working ? `${working} at work` : "Agents"}
    </button>
  );
}

export function SectionAgentsChip({ sectionId, sectionName }: { sectionId: string; sectionName: string }) {
  const crew = useSectionCrew(sectionId);
  const isOpen = useOpen()?.id === sectionId;
  const working = crew.filter((p) => p.crew.status === "working").length;
  return <SectionAgentsChipView working={working} on={isOpen} sectionName={sectionName} onPress={() => toggleSectionAgents(sectionId)} />;
}

// ---------- the panel, in the section's corner ----------

const PANEL_W = 340;

/** add the agents card to a section: the same view, kept on the board for everyone */
export function keepAgentsCard(sectionId: string, at: { float?: boolean; x?: number; y?: number } = {}) {
  const st = getState();
  const has = Object.values(st.panels).find((p) => p.panel === "crew" && p.sectionId === sectionId);
  if (has) {
    toast("This section already has its agents card", "ok");
    return has;
  }
  return addPanel(sectionId, { panel: "crew", name: "Agents", ...at });
}

const sectionsOf = () => getState().sections;

export function SectionAgentsPanel() {
  const at = useOpen();
  const ui = useUi();
  const sections = useSyncExternalStore(subscribe, sectionsOf);
  const el = useRef<HTMLDivElement>(null);
  const section = at ? sections[at.id] : undefined;

  // the section went (removed, or the view moved to another grid): the panel goes with it
  useEffect(() => {
    if (at && !section) closeSectionAgents();
  }, [at, section]);

  useEffect(() => {
    if (!at) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !el.current?.contains(document.activeElement)) return;
      e.stopPropagation();
      closeSectionAgents();
    };
    window.addEventListener("keydown", key, { capture: true });
    return () => window.removeEventListener("keydown", key, { capture: true });
  }, [at]);

  // it stands in the section's top-right corner, under its header, and stays on the open paper
  useLayoutEffect(() => {
    const node = el.current;
    const id = at?.id;
    if (!node || !id) return;
    const place = () => {
      const st = getState();
      const s = st.sections[id];
      if (!s) return;
      const r = sectionCardRect(st.grid, s);
      const f = floorInsets();
      const k = camera.scale || 1;
      const h = node.offsetHeight;
      const right = (r.x + r.w) * k + camera.x - 8;
      const top = r.y * k + camera.y + SECTION_HEADER * k + 4;
      const x = Math.max(f.left + 8, Math.min(window.innerWidth - f.right - PANEL_W - 8, right - PANEL_W));
      const y = Math.max(f.top + 8, Math.min(window.innerHeight - h - 72, top));
      node.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
    };
    place();
    const offCam = onCamera(place);
    const offStore = subscribe(place);
    const ro = new ResizeObserver(place);
    ro.observe(node);
    window.addEventListener("resize", place);
    return () => {
      offCam();
      offStore();
      ro.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [at?.id, ui.pane, ui.paneW, ui.session, ui.sessionW, ui.search, ui.searchW, ui.agents, ui.agentsW]);

  if (!at || !section || ui.presenting) return null;
  return (
    <div ref={el} className="sa-panel" role="dialog" aria-label={`Agents in ${section.name}`} data-sa-panel={section.id} style={{ width: PANEL_W }} onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <header className="sa-head">
        <span className="sa-title">
          <span className="sa-spark" aria-hidden>
            ✦
          </span>
          Agents in <b>{section.name}</b>
        </span>
        {ui.role !== "viewer" && (
          <button type="button" className="crew-row-btn" data-tip="Keep this on the section as a card, for everyone" onClick={() => (keepAgentsCard(section.id), closeSectionAgents())}>
            Keep here
          </button>
        )}
        <button type="button" className="crew-row-btn" data-tip="Every agent on the board, and this computer's agents" onClick={() => (openAgentsPane(section.id), closeSectionAgents())}>
          All agents
        </button>
        <button type="button" className="sa-close" aria-label="Close" data-tip="Close" data-kbd="Esc" onClick={closeSectionAgents}>
          ✕
        </button>
      </header>
      <SectionAgentsBody key={section.id} sectionId={section.id} sectionName={section.name} focus={at.focus} />
    </div>
  );
}

/** the card's body: the agents of the section the card sits in */
export function CrewCardBody({ sectionId }: { sectionId: string }) {
  const name = useSyncExternalStore(subscribe, () => getState().allSections[sectionId]?.name ?? "this section");
  return (
    <div className="sa-card">
      <div className="sa-card-head">
        <span className="sa-spark" aria-hidden>
          ✦
        </span>
        Agents in <b>{name}</b>
      </div>
      <SectionAgentsBody sectionId={sectionId} sectionName={name} />
    </div>
  );
}
