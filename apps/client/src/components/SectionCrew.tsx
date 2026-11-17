/**
 * The agent group of a section: a small tab that stands right above the
 * section, on its top edge, with a face for every agent at work inside it.
 *
 * It shows while the pointer is on the section, or always once it's pinned (a
 * pin is this device's own: what you want to keep an eye on). A free agent
 * that comes into the section joins the group with a spring; one that moves
 * on leaves it. A face is the agent's initial on its own crew colour, with a
 * ring that breathes while it works. Press a face to follow that agent.
 *
 * When two or more are here, the tab says how they stand to each other
 * ("working together" for a lead and its helpers; see lib/sectionCrew.ts), and
 * faces of one team overlap while separate asks stand apart.
 *
 * The tab keeps to the paper you can see. A section that fills the view has
 * its top edge at the top bar (or past it), and a tab above that edge would be
 * out of sight just when you're looking at the section: so it slides down the
 * section with the view, like a sticky heading, and stays in the part of the
 * section that's on screen (`useStick`; written straight to the style, on
 * the camera's own frames, no render).
 *
 * The last button opens the agents pane on the right (shell/AgentsPane.tsx):
 * the same group, larger, with what each is doing and who called whom in.
 */

import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "motion/react";
import { crewTeams, togetherWords } from "../lib/sectionCrew";
import { useSectionCrew } from "../lib/crewWatch";
import { followCrew } from "../shell/Crew";
import { floorInsets, setUi, useUi } from "../state/ui";
import { camera, onCamera } from "../state/camera";
import { getState, sectionCardRect, subscribe } from "../state/store";
import "./sectionCrew.css";

/** what a face needs: enough to draw an agent without the board */
export interface CrewFace {
  id: string;
  name: string;
  hue: number;
  status: "working" | "done" | "stopped" | "error";
  doing: string;
  askerName: string;
  lead?: string;
  leadName?: string;
}

// ----- pins: the sections whose group stays up, on this device -----

const PIN_KEY = "foundation-crew-pins";
let pins: ReadonlySet<string> = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(PIN_KEY) ?? "[]");
    return new Set<string>(Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set<string>();
  }
})();
const pinSubs = new Set<() => void>();

export function setCrewPinned(sectionId: string, on: boolean) {
  const next = new Set(pins);
  if (on) next.add(sectionId);
  else next.delete(sectionId);
  pins = next;
  try {
    localStorage.setItem(PIN_KEY, JSON.stringify([...next].slice(-200)));
  } catch { /* private window */ }
  pinSubs.forEach((f) => f());
}
export function crewPinned(sectionId: string) {
  return pins.has(sectionId);
}
function useCrewPinned(sectionId: string) {
  return useSyncExternalStore(
    (fn) => {
      pinSubs.add(fn);
      return () => pinSubs.delete(fn);
    },
    () => pins.has(sectionId),
  );
}

/** open the agents pane on the right, with this section first */
export function openAgentsPane(sectionId: string | null) {
  setUi({ agents: true, agentsAt: sectionId });
}

const SHOWN = 6;
const faceSpring = { type: "spring", stiffness: 520, damping: 26, mass: 0.7 } as const;

/** what a face says on roll-over */
export function faceTip(f: CrewFace, pressable = true): string {
  const state = f.status === "working" ? f.doing || "working" : f.status === "done" ? "done" : f.status === "stopped" ? "stopped" : "hit a problem";
  const who = f.leadName ? `with ${f.leadName}` : f.askerName ? `for ${f.askerName.split(" ")[0]}` : "";
  return `${f.name} · ${state}${who ? ` · ${who}` : ""}${pressable && f.status === "working" ? " · press to follow" : ""}`;
}

/** an agent's face: its initial on its crew colour */
export function CrewFaceView({ face, onPress, size }: { face: CrewFace; onPress?: () => void; size?: "large" }) {
  return (
    <motion.button
      type="button"
      className={`crew-face is-${face.status}${size ? ` is-${size}` : ""}`}
      style={{ ["--crew" as string]: `var(--color-crew-${face.hue % 6})` }}
      initial={{ opacity: 0, scale: 0.3 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.3 }}
      transition={faceSpring}
      data-tip={faceTip(face, !!onPress)}
      aria-label={faceTip(face, false)}
      data-crew-face={face.name}
      disabled={!onPress}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onPress}
    >
      {face.name.slice(0, 1).toUpperCase()}
    </motion.button>
  );
}

/** the tab alone, for the section and the design page */
export function SectionCrewView({
  faces,
  pinned,
  shown = false,
  sectionName,
  onFace,
  onPin,
  onOpen,
  stick,
}: {
  /** the tab's element, for the section to keep in view (useStick) */
  stick?: React.Ref<HTMLDivElement>;
  faces: CrewFace[];
  pinned: boolean;
  /** held up, as when the pointer is on the section (the design page) */
  shown?: boolean;
  sectionName: string;
  onFace?: (f: CrewFace) => void;
  onPin?: () => void;
  onOpen?: () => void;
}) {
  const teams = crewTeams(faces, (f) => ({ id: f.id, lead: f.lead, target: null }));
  const words = togetherWords(teams);
  let room = SHOWN;
  const more = Math.max(0, faces.length - SHOWN);
  return (
    <div
      ref={stick}
      className={`sec-crew${pinned ? " is-pinned" : ""}${shown ? " is-shown" : ""}${faces.length ? "" : " is-empty"}`}
      role="group"
      aria-label={`Agents in ${sectionName}`}
      data-sec-crew={faces.length}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {faces.length === 0 ? (
        <span className="sec-crew-words">No agents here</span>
      ) : (
        <>
          <span className="sec-crew-teams">
            <AnimatePresence initial={false}>
              {teams.map((t) => {
                const take = t.members.slice(0, Math.max(0, room));
                room -= take.length;
                if (!take.length) return null;
                return (
                  <span key={t.id} className={`sec-crew-team${t.together ? " is-together" : ""}`}>
                    <AnimatePresence initial={false}>
                      {take.map((f) => (
                        <CrewFaceView key={f.id} face={f} onPress={onFace && f.status === "working" ? () => onFace(f) : undefined} />
                      ))}
                    </AnimatePresence>
                  </span>
                );
              })}
            </AnimatePresence>
            {more > 0 && <span className="sec-crew-more">+{more}</span>}
          </span>
          {words && <span className="sec-crew-words">{words}</span>}
        </>
      )}
      <button
        type="button"
        className={`sec-crew-btn${pinned ? " is-on" : ""}`}
        aria-pressed={pinned}
        aria-label={pinned ? `Unpin the agents of ${sectionName}` : `Pin the agents of ${sectionName}`}
        data-tip={pinned ? "Pinned: stays up when the pointer leaves · press to unpin" : "Pin: keep this group up"}
        onClick={onPin}
      >
        <svg width="11" height="11" viewBox="0 0 12 12" fill={pinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round" aria-hidden>
          <path d="M4.2 1.5h3.6l-.5 3.3 1.9 1.9H2.8l1.9-1.9zM6 6.7v3.8" />
        </svg>
      </button>
      <button type="button" className="sec-crew-btn" aria-label={`Open the agents of ${sectionName} in the side pane`} data-tip="Open in the agents pane" onClick={onOpen}>
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" aria-hidden>
          <rect x="1.5" y="2" width="9" height="8" rx="1.5" />
          <path d="M7.2 2v8" />
        </svg>
      </button>
    </div>
  );
}

/** the tab's own box and its gap above the section, in world px (sectionCrew.css) */
const TAB_H = 30;
const TAB_GAP = 5;
const TAB_LEFT = 12;
/** how far left of the middle its right end stops: clear of the + that adds a section above */
const CLEAR_MID = 24;
/** below this zoom the tab stops growing against the board and shrinks with it */
const MIN_ZOOM = 0.3;

/**
 * Keep a section's tab on the paper that's showing. At rest it stands above
 * the section's top edge, its right end just left of the middle of the part
 * of the section you can see. When that edge is under the top bar (or off the
 * top), the tab comes down with the view, never past the section's foot.
 * It's drawn at screen size (scaled against the camera about its bottom-left
 * corner), like the cursors: readable with the whole board in view.
 */
function useStick(ref: React.RefObject<HTMLDivElement | null>, sectionId: string, what: string) {
  const ui = useUi();
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // measured here, when what's in the tab changed; never on a camera frame
    const w = el.offsetWidth;
    const place = () => {
      const st = getState();
      const s = st.sections[sectionId];
      if (!s) return;
      const r = sectionCardRect(st.grid, s);
      const f = floorInsets();
      const k = camera.scale || 1;
      // drawn at the size of the screen, not the board's: a face reads the same at any zoom (far out, it gives a little)
      const inv = 1 / Math.max(k, MIN_ZOOM);
      const tabW = w * inv;
      const tabH = TAB_H * inv;
      const restTop = (r.y - TAB_GAP - tabH) * k + camera.y;
      const dy = Math.min(Math.max(0, (f.top + 6 - restTop) / k), r.h + TAB_GAP - 8 * inv);
      // the part of the section that's on the open paper, in world px from its left edge
      const seenL = Math.max(0, (f.left - camera.x) / k - r.x);
      const seenR = Math.min(r.w, (camera.width - f.right - camera.x) / k - r.x);
      const x = seenR > seenL ? (seenL + seenR) / 2 - CLEAR_MID - tabW : TAB_LEFT;
      const dx = Math.max(8 * inv, Math.min(r.w - tabW - 8 * inv, x)) - TAB_LEFT;
      el.style.transform = `translate3d(${dx.toFixed(1)}px, ${dy.toFixed(1)}px, 0) scale(${inv.toFixed(4)})`;
      el.classList.toggle("is-stuck", dy > 0);
    };
    place();
    const offCam = onCamera(place);
    const offStore = subscribe(place);
    return () => {
      offCam();
      offStore();
    };
  }, [ref, sectionId, what, ui.pane, ui.paneW, ui.session, ui.sessionW, ui.search, ui.searchW, ui.agents, ui.agentsW, ui.presenting]);
}

/** a section's agent group, live; nothing at all while nobody's here and it isn't pinned */
export function SectionCrew({ sectionId, sectionName }: { sectionId: string; sectionName: string }) {
  const crew = useSectionCrew(sectionId);
  const pinned = useCrewPinned(sectionId);
  const tab = useRef<HTMLDivElement>(null);
  // placed again when what the tab holds (so how wide it is) changes
  useStick(tab, sectionId, `${pinned}:${crew.map((p) => `${p.crew.id}>${p.crew.lead ?? ""}`).join(",")}`);
  if (!crew.length && !pinned) return null;
  const faces: CrewFace[] = crew.map((p) => ({
    id: p.crew.id,
    name: p.user.name,
    hue: p.crew.hue,
    status: p.crew.status,
    doing: p.crew.doing,
    askerName: p.crew.askerName,
    lead: p.crew.lead,
    leadName: p.crew.leadName,
  }));
  return (
    <SectionCrewView
      stick={tab}
      faces={faces}
      pinned={pinned}
      sectionName={sectionName}
      onFace={(f) => followCrew(f.id)}
      onPin={() => setCrewPinned(sectionId, !pinned)}
      onOpen={() => openAgentsPane(sectionId)}
    />
  );
}
