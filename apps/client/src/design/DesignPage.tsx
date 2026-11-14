/**
 * The living design language (#/design) — DESIGN.md made visible. Every
 * token, type step, radius, motion curve and effect Foundation uses, rendered
 * from the real tokens so it can't drift. New UI behaviour lands here first.
 */

import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { durations, easings, isNight, setNight, springs } from "@foundation/ui";
import { initAsciiWind2 } from "../login/asciiWind2";
import { Mark } from "../brand/Mark";
import { UpdateCard } from "../update/UpdateCard";
import { ServerSwitchView, type ServerSwitchViewProps } from "../server/ServerSwitch";
import { FOLDER_DEFAULT } from "../server/model";
import type { UpdatePhase } from "../update/updater";
import { NightOrb } from "../shell/NightOrb";
import { InfoGlyph } from "../shell/TopBar";
import { WindowControls } from "../shell/WindowControls";
import { pipeCrossings, polyline, route, routeSides, sideToward, type Side } from "../shell/wireGeometry";
import { tunnelGeometry } from "../shell/wireGeometry";
import { AppChip, FocusRow, GoalRow, ShibaRoom } from "../today/Today";
import type { CompanyApp, FocusItem, Goal, Mood } from "../today/model";

const NOW = Date.now();
const SAMPLE_FOCUS: FocusItem[] = [
  { id: "ask:a", kind: "ask", title: "Upload the latest stator STEP", why: "Kai asked you for CAD · 1 d overdue", board: "rim-drive", boardName: "Rim drive", href: "#", at: NOW, tone: "bad" },
  { id: "stage:s", kind: "stage", title: "03 · CAD", why: "You own this stage · 2 to tick", board: "company", boardName: "Form Industries", href: "#", at: NOW, tone: "warn" },
  { id: "mention:m", kind: "mention", title: "@Ada can you sign off the bearing loads before Friday?", why: "You're tagged in a note on Rim drive", board: "rim-drive", boardName: "Rim drive", href: "#", at: NOW },
  { id: "changes:c", kind: "changes", title: "6 changes on Form Industries", why: "Foundation Agent, Kai · latest: laid out 4 images", board: "company", boardName: "Form Industries", href: "#", at: NOW, tone: "agent" },
  { id: "related:r", kind: "related", title: "Winding thermal model", why: "Matches “thermal”, from your work", board: "motors", boardName: "Motors", href: "#", at: 0 },
];
const SAMPLE_GOALS: Goal[] = [
  { id: "g1", title: "Freeze the rim-drive CAD for the PTHP build", detail: "Stator and bearings signed off", status: "active", progress: 0.6, dueAt: NOW + 8 * 864e5, board: null, objectId: null, source: "foundation" },
  { id: "g2", title: "Onboard Kai to FactoryForm work orders", detail: "", status: "done", progress: 1, dueAt: null, board: null, objectId: null, source: "foundation" },
];
const SAMPLE_APPS: CompanyApp[] = [
  { id: "factoryform", name: "FactoryForm", role: "Inventory, stations, work orders", url: "#", glyph: "⚙" },
  { id: "bomform", name: "BomForm", role: "BOMs, certification", url: "#", glyph: "▤" },
  { id: "hyperform", name: "HyperForm", role: "HyperForm programme", url: null, glyph: "◈" },
];

function TodayDemo() {
  const [mood, setMood] = useState<Mood>("idle");
  return (
    <div className="design-today">
      <div className="design-today-room">
        <ShibaRoom mood={mood} maxFps={24} />
        <div className="today-veil" aria-hidden />
        <div className="design-today-words">
          <p className="today-eyebrow" data-mood={mood}>
            {mood === "idle" ? "Wednesday, November 11" : mood}
          </p>
          <p className="today-line">Good afternoon, Ada.{"\n"}3 things want you today.</p>
        </div>
      </div>
      <div className="design-today-moods">
        {(["idle", "listening", "thinking", "speaking"] as Mood[]).map((m) => (
          <button key={m} className={`f-pill${m === mood ? " is-agent" : ""}`} onClick={() => setMood(m)}>
            {m}
          </button>
        ))}
      </div>
      <div className="design-today-state today-state">
        <section className="today-group">
          <h2 className="f-eyebrow">
            Focus today <span className="today-count">5</span>
          </h2>
          {SAMPLE_FOCUS.map((f, i) => (
            <FocusRow key={f.id} item={f} pointed={i === 2} />
          ))}
        </section>
        <section className="today-group">
          <h2 className="f-eyebrow">Goals</h2>
          {SAMPLE_GOALS.map((g, i) => (
            <GoalRow key={g.id} goal={g} pointed={i === 0} />
          ))}
        </section>
      </div>
      <nav className="today-chips design-today-chips">
        {SAMPLE_APPS.map((a, i) => (
          <AppChip key={a.id} app={a} status={i === 0 ? "ok" : i === 1 ? "warn" : undefined} />
        ))}
      </nav>
    </div>
  );
}
import { PlanBoard, ReleasesTab, type NewCardInput, type SyncState } from "../settings/SettingsPage";
import type { ReleasePost } from "../settings/releases";
import { syncSentence } from "../settings/plan";
import type { Plan } from "../settings/plan";
import { SectionEmpty } from "../panels/SectionEmpty";
import { SlackMarkView } from "../components/SlackMark";
import { SectionCrewView, type CrewFace } from "../components/SectionCrew";
import { SectionAgentsChipView, SectionAgentsView } from "../components/SectionAgents";
import { RichToolbar } from "../components/RichText";
import { AgentRow, AgentsPaneBody, T3AddForm, T3BlockView, type AgentRowData, type AgentsPlace, type T3Host, type T3Preset } from "../shell/AgentsPane";
import { MachineAskList } from "../panels/MachineView";
import type { MachineAsk, SlackSectionState } from "@foundation/protocol";
import { COMMANDS_GLYPH, IS_MAC, keys } from "../lib/keys";
import * as Y from "yjs";
import { loadNoteEditor } from "../components/NoteView";
import { renderMarkdown } from "../utils/markdown";
import { TrayView } from "../shell/UploadTray";
import type { SearchHit } from "@foundation/protocol";
import { Draggable } from "../shell/SearchPane";
import { Clipboard, HitPicture } from "../shell/Clipboard";
import { glyphOf } from "../lib/hits";
import { fan } from "../lib/pickupMath";
import type { UploadItem } from "../lib/uploads";
import { snippetHtml } from "../lib/snippet";
import { RuneDesign } from "../rune/RendererTab";

const SURFACES = ["void", "abyss", "panel", "raise"];
const INKS = ["frost", "mist", "dim"];
const ACCENTS = ["pulse", "volt", "moss", "agent", "ok", "warn", "bad", "on-fill", "highlight"];
// every combo the app prints, and the longest one (Ctrl+Shift+Z) to prove a chip never wraps
const COMBOS = ["mod+K", "mod+F", "mod+L", "mod+U", "mod+J", "mod+\\", "mod+1", "mod+W", "mod+enter", "shift+mod+Z"];
const TYPE = [
  { size: 32, weight: 600, label: "Display 32", font: "var(--font-display)", sample: "Foundation" },
  { size: 24, weight: 600, label: "Title 24", font: "var(--font-sans)", sample: "Airform Max program" },
  { size: 16, weight: 500, label: "Heading 16", font: "var(--font-sans)", sample: "Fan shroud, rev C" },
  { size: 13, weight: 400, label: "Body 13 (default)", font: "var(--font-sans)", sample: "Noa uploaded the STEP; Vision is simulating the inlet." },
  { size: 12, weight: 500, label: "Control 12", font: "var(--font-sans)", sample: "Open · Run · Connect" },
  { size: 11, weight: 600, label: "Eyebrow 11 · .22em caps", font: "var(--font-sans)", sample: "COMPANY", eyebrow: true },
];

export function DesignPage() {
  const wind = useRef<HTMLDivElement>(null);
  const [replay, setReplay] = useState(0);
  useEffect(() => initAsciiWind2(wind.current!, "wind"), []);

  return (
    <div className="design-page">
      <header className="design-head">
        <Mark size={28} />
        <div>
          <div className="f-eyebrow">Form Industries · one design language</div>
          <h1>Foundation design language</h1>
        </div>
        <div className="capsule-spacer" />
        <NightOrb onToggle={() => setNight(!isNight())} />
        <a className="f-pill" href="#/">
          ← Back to the grid
        </a>
      </header>

      <p className="design-lede">
        Warm printed paper, ink, one federal blue — shared with Vision, the Data Room, FactoryForm and Creation. The work brings the colour; colour means state.
        Agents wear violet. Everything floats on glass over a living grid. This page renders the real tokens; <code>DESIGN.md</code> is the contract.
      </p>

      <Section title="The mark" note="Four panels on a grid: two full rows over a row split in two. Blue on paper and glass; the white original on a solid fill or dark ground.">
        <div className="mark-specimens">
          {[64, 32, 20, 16].map((n) => (
            <span key={n} className="mark-specimen">
              <Mark size={n} />
            </span>
          ))}
          {[64, 32, 20, 16].map((n) => (
            <span key={`f${n}`} className="mark-specimen" data-ground="fill">
              <Mark size={n} tone="on-fill" />
            </span>
          ))}
        </div>
      </Section>

      <Section title="Surfaces" note="Paper by day, graphite by night: greys and white, with yellow and orange only where something needs you. The orb mixes every token — try it.">
        <div className="swatches">
          {SURFACES.map((s) => (
            <Swatch key={s} name={s} />
          ))}
        </div>
      </Section>

      <Section title="Ink & accents" note="Ink flips hard at the midpoint so contrast holds. One accent; violet only for agents.">
        <div className="swatches">
          {[...INKS, ...ACCENTS].map((s) => (
            <Swatch key={s} name={s} />
          ))}
        </div>
        <div className="swatches viz">
          {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
            <div key={i} className="swatch-chip" style={{ background: `var(--viz-${i})` }} title={`--viz-${i}`} />
          ))}
          <span className="design-note">Data uses --viz-1…8 in order.</span>
        </div>
      </Section>

      <Section title="Type" note="Hanken Grotesk (OFL, bundled). Display prefers Lufga where licensed. Scale 11/12/13/14/16/20/24/32 — no half sizes.">
        <div className="type-ramp">
          {TYPE.map((t) => (
            <div key={t.label} className="type-row">
              <span className="type-label">{t.label}</span>
              <span className={t.eyebrow ? "f-eyebrow" : ""} style={t.eyebrow ? undefined : { font: `${t.weight} ${t.size}px/1.25 ${t.font}`, letterSpacing: t.size >= 24 ? "-0.02em" : undefined }}>
                {t.sample}
              </span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Shape" note="Paper 3 · card 5 · pane 8 · pill 999 — nothing in between; corners stay quiet. Space 2/4/8/12/16/24/32.">
        <div className="shapes">
          {[
            ["paper", "3"],
            ["card", "5"],
            ["pane", "8"],
            ["pill", "999"],
          ].map(([n, v]) => (
            <div key={n} className="shape" style={{ borderRadius: `var(--radius-${n})` }}>
              <b>{n}</b>
              <span>{v}px</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Controls" note="One primary (ink) per bar. Accent blue is for a single forward action; violet means an agent will act.">
        <div className="controls-row">
          <button className="f-pill">Secondary</button>
          <button className="f-pill is-primary">Primary</button>
          <button className="f-pill is-accent">Accent</button>
          <button className="f-pill is-agent">✦ Agent</button>
          <button className="f-pill" disabled>
            Disabled
          </button>
          <span className="f-kbd">{keys("mod+K")}</span>
          <span className="f-dot is-ok is-live" />
          <span className="f-dot is-warn" />
          <span className="f-dot is-bad" />
          <span className="f-dot is-agent" />
        </div>
        <div className="glass-demo">
          <div className="glass-demo-bg" />
          <div className="f-glass glass-demo-pane">
            <div className="f-eyebrow">Glass</div>
            <p>One backdrop-filter per region: blur 18 · saturate 1.4 · fill 72% · edge 14%.</p>
          </div>
        </div>
      </Section>

      <Section
        title="Key labels"
        note="Shortcuts print for the machine they're on: ⌘ on a Mac, Ctrl on Windows and Linux (lib/keys.ts — the handlers take either). A chip is one line and never shrinks; where a panel is too tight for it, the panel drops the chip, not the words around it."
      >
        <div className="keys-table">
          {[
            { label: "Mac", mac: true },
            { label: "Windows · Linux", mac: false },
          ].map((p) => (
            <div key={p.label} className="keys-row">
              <span className="keys-os">
                {p.label}
                {p.mac === IS_MAC && <span className="keys-here"> · this machine</span>}
              </span>
              {COMBOS.map((c) => (
                <span key={c} className="f-kbd">
                  {keys(c, p.mac)}
                </span>
              ))}
              <button className="hud-search f-glass">
                <span className="hud-glyph">⌕</span>
                <span className="hud-label">Search</span>
                <span className="f-kbd">{keys("mod+F", p.mac)}</span>
              </button>
              <div className="f-tip is-on keys-tip">
                Ask the agent about this section <span className="f-kbd">{keys("mod+J", p.mac)}</span>
              </div>
            </div>
          ))}
        </div>
        {[680, 440].map((h) => (
          <div key={h} className="adapt-row keys-sections">
            {[260, 400, 560].map((w) => (
              <div key={w} className="keys-section" style={{ width: w, height: h }}>
                <SectionEmpty name={`Section · ${w} × ${h}`} onUpload={() => {}} onNote={() => {}} onText={() => {}} onAsk={() => {}} onFocus={() => {}} />
              </div>
            ))}
          </div>
        ))}
      </Section>

      <Section title="Motion" note="Springs move things; curves fade things. Overshoot only on arrivals (pop). Delight under 600 ms, only after a real completion.">
        <div className="motion-grid">
          {Object.entries(springs).map(([name, s]) => (
            <div key={name} className="motion-card">
              <motion.div
                key={replay}
                className="motion-ball"
                initial={{ x: 0 }}
                animate={{ x: 180 }}
                transition={{ type: "spring", stiffness: s.stiffness, damping: s.damping, mass: s.mass }}
              />
              <div className="motion-label">
                <b>{name}</b> k{s.stiffness} c{s.damping}
              </div>
            </div>
          ))}
          {Object.entries(easings).map(([name, e]) => (
            <div key={name} className="motion-card">
              <motion.div key={replay} className="motion-ball is-curve" initial={{ x: 0 }} animate={{ x: 180 }} transition={{ duration: durations.rise / 1000, ease: e as unknown as [number, number, number, number] }} />
              <div className="motion-label">
                <b>{name}</b> ({e.join(", ")})
              </div>
            </div>
          ))}
        </div>
        <button className="f-pill" onClick={() => setReplay((r) => r + 1)}>
          Replay
        </button>
      </Section>

      <Section title="Effects" note="ASCII wind (sign-in), the paper shader (grid), agent rings, live wires. Each has a frame budget and a reduced-motion still.">
        <div className="effects">
          <div className="effect-card">
            <div ref={wind} className="effect-wind ascii-wind" data-ascii-wind />
            <a className="effect-label" href="#/design/sign-in">
              ASCII wind · move the cursor, press to ripple · full size ↗
            </a>
          </div>
          <div className="effect-card effect-ring">
            <div className="ring-card">
              <span className="f-dot is-agent is-live" /> Agent working
            </div>
            <div className="effect-label">Agent ring · violet, breathing 2.4 s</div>
          </div>
          <div className="effect-card effect-wire">
            <WireDemo />
            <div className="effect-label">Wires · 45° roads, lanes, and a tunnel where one passes under</div>
          </div>
          <div className="effect-card effect-wire">
            <AppSectionsDemo />
            <div className="effect-label">App sections · neighbours join straight across the gap; apps apart, by one long diagonal from facing edges</div>
          </div>
        </div>
      </Section>

      <Section title="The floor" note="A tab is a space (a grid ▦, a presentation ▶, a web page ◳); ＋ makes a grid space. The left pane files spaces by recent or by project folder; the ⓘ on a space's tab opens that space's own people and activity in its place; a session with the agent opens from Ask in the bottom bar. The top bar, the panes, an open session and search are drawn on the grid's own paper — no glass, no card. The dots run underneath; the cards stop at a pane's edge, cut clean behind a hairline (no fade), like an editor's panels, and the view slides over to stay in the middle of what's left. That hairline is the edge you drag: it turns blue under the pointer, and a double-click resets the width.">
        <div className="floor-demo">
          <header className="top-bar">
            <span className="top-btn is-on">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
                <rect x="1.5" y="2.5" width="13" height="11" rx="2.5" />
                <path d="M6 2.5v11" />
              </svg>
            </span>
            <nav className="tabs">
              <span className="tab is-space is-current is-board">
                <span className="tab-main">
                  <span className="tab-glyph">◉</span>
                  <span className="tab-title">Form Industries</span>
                  <span className="f-dot is-ok" />
                </span>
                <span className="tab-info">
                  <InfoGlyph />
                </span>
                <span className="tab-close">✕</span>
              </span>
              <span className="tab is-space">
                <span className="tab-main">
                  <span className="tab-glyph">▦</span>
                  <span className="tab-title">Rim-drive fan</span>
                </span>
              </span>
              <span className="tab is-space">
                <span className="tab-main">
                  <span className="tab-glyph">▶</span>
                  <span className="tab-title">Design review</span>
                </span>
              </span>
              <span className="tab is-space">
                <span className="tab-main">
                  <span className="tab-glyph">◳</span>
                  <span className="tab-title">FactoryForm</span>
                </span>
              </span>
            </nav>
            <span className="tab-new-wrap">
              <span className="top-btn tab-new">＋</span>
              <span className="top-btn tab-new-more">
                <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
                  <path d="M1 2.5l3 3 3-3" />
                </svg>
              </span>
            </span>
            <div className="top-tools">
              <span className="top-btn is-on">⌕</span>
              <span className="top-btn">{COMMANDS_GLYPH}</span>
              <span className="top-btn">◇</span>
              <span className="top-btn">▶</span>
              <NightOrb onToggle={() => setNight(!isNight())} />
            </div>
            <WindowControls demo />
          </header>
          <aside className="side-pane floor-pane" style={{ width: 200 }}>
            <div className="pane-scroll">
              <section className="pane-group">
                <div className="pane-eyebrow">
                  Spaces
                  <span className="pane-eyebrow-acts">
                    <span className="pane-eyebrow-act">▱</span>
                    <span className="pane-eyebrow-act">＋</span>
                  </span>
                </div>
                <div className="pane-seg">
                  <span className="pane-seg-btn">Recent</span>
                  <span className="pane-seg-btn is-on">Folders</span>
                </div>
                <div className="space-row is-folder">
                  <span className="pane-row space-open">
                    <span className="pane-glyph folder-caret is-open">›</span>
                    <span className="pane-label">Fans</span>
                    <span className="pane-when">2</span>
                  </span>
                </div>
                <div className="space-row" style={{ paddingLeft: 14 }}>
                  <span className="pane-row space-open">
                    <span className="pane-glyph">▦</span>
                    <span className="pane-label">Rim-drive fan</span>
                  </span>
                </div>
                <div className="space-row" style={{ paddingLeft: 14 }}>
                  <span className="pane-row space-open">
                    <span className="pane-glyph">▶</span>
                    <span className="pane-label">Design review</span>
                  </span>
                </div>
                <div className="pane-sub">Not in a folder</div>
                <div className="space-row is-current">
                  <span className="pane-row space-open">
                    <span className="pane-glyph">◉</span>
                    <span className="pane-label">Form Industries</span>
                  </span>
                </div>
              </section>
            </div>
          </aside>
          <section className="session floor-pane" style={{ left: 200, width: 260 }}>
            <div className="plan">
              <div className="plan-head">
                <span className="pane-eyebrow is-agent">Goal</span>
                <span className="plan-count">1/3</span>
              </div>
              <div className="plan-goal">The fan work in one section, with the open questions on a note.</div>
              <ol className="plan-steps">
                <li className="plan-step is-done"><span className="plan-box">✓</span><span>Make the section</span></li>
                <li className="plan-step is-active is-running"><span className="plan-box" /><span>Move the fan cards in</span></li>
                <li className="plan-step is-pending"><span className="plan-box" /><span>Write the questions</span></li>
              </ol>
            </div>
            <div className="session-list">
              <div className="s-steps">
                <span className="s-step is-ok is-link"><span className="step-dot" /><span className="s-step-name">Added a section</span><span className="s-step-detail">Fan</span><span className="s-step-go">↗</span></span>
                <span className="s-step is-run"><span className="step-dot" /><span className="s-step-name">Updated a card</span></span>
              </div>
            </div>
          </section>
          <div className="floor-demo-grid">
            <div className="floor-demo-card is-touched">Fan · touched by the session</div>
            <div className="floor-demo-card">Rim drive</div>
          </div>
          <aside className="search-pane floor-pane" style={{ width: 210 }}>
            <header className="search-head">
              <span className="search-glyph">⌕</span>
              <span className="search-field">fan</span>
            </header>
            <div className="search-results">
              <span className="search-row">
                <span className="search-row-glyph">▤</span>
                <span className="search-row-main">
                  <span className="search-row-title">fan-v3-shroud.step</span>
                  <span className="search-row-snip">Rim-drive <mark>fan</mark> shroud</span>
                </span>
              </span>
              <span className="search-row">
                <span className="search-row-glyph">◳</span>
                <span className="search-row-main">
                  <span className="search-row-title">FactoryForm</span>
                  <span className="search-row-snip">stations, work orders</span>
                </span>
              </span>
            </div>
          </aside>
        </div>
        <div className="floor-demo-caption">Side pane · a session (goal, steps; its cards ringed on the grid) · search, dragged from onto the grid</div>
      </Section>

      <Section title="Chrome on call" note="The grid runs edge to edge. Everything else waits to be called: search is a small pill at the bottom, a card's bar drops in on hover, and an image's icons slide out from behind it.">
        <div className="oncall-row">
          <div className="oncall-cell">
            <div className="oncall-hud">
              <button className="hud-search f-glass">
                <span className="hud-glyph">⌕</span>
                <span className="hud-label">Search</span>
                <span className="f-kbd">{keys("mod+F")}</span>
              </button>
              <button className="hud-ask f-glass">
                <span className="hud-glyph">✦</span>
                <span className="hud-label">Ask</span>
              </button>
              <button className="hud-talk f-glass">
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
                  <rect x="5.5" y="1.5" width="5" height="9" rx="2.5" />
                  <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2" strokeLinecap="round" />
                </svg>
                <span className="f-kbd">Space</span>
              </button>
              <button className="hud-zoom f-glass">64%</button>
            </div>
            <div className="effect-label">The search pill, talk (hold Space: what you say goes to the crew) and the zoom</div>
          </div>
          <div className="oncall-cell">
            <div className="oncall-talking">
              <div className="hud-heard f-glass">
                <span className="hud-heard-dot" />
                <span className="hud-heard-text">lay out all the images from Slack about the Airform PTHP</span>
              </div>
              <button className="hud-talk f-glass is-on">
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
                  <rect x="5.5" y="1.5" width="5" height="9" rx="2.5" />
                  <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            <div className="effect-label">Talking: the words as they're heard; the pill sends them when you stop (Esc drops them)</div>
          </div>
          <div className="oncall-cell">
            <div className="frame-anchor chrome-bar oncall-static is-hover" style={{ width: 240 }}>
              <div className="frame-card">
                <div className="frame-header" style={{ height: 30 }}>
                  <span className="frame-title">▤ Launch notes</span>
                  <div className="header-actions">
                    <span className="icon-btn">✥</span>
                    <span className="icon-btn">✕</span>
                  </div>
                </div>
                <div className="frame-body oncall-body">Card at rest: no bar. Hover: the bar drops in over the top edge.</div>
              </div>
            </div>
            <div className="effect-label">A card, hovered</div>
          </div>
          <div className="oncall-cell">
            <div className="frame-anchor chrome-icons oncall-static is-hover" style={{ width: 200 }}>
              <div className="frame-icons">
                <span className="frame-icon is-on">♪</span>
                <span className="frame-icon is-remove">✕</span>
              </div>
              <div className="frame-card">
                <div className="frame-body oncall-media" />
              </div>
            </div>
            <div className="effect-label">Video, hovered: a ghost rail carries the pointer out to mute and remove</div>
          </div>
          <div className="oncall-cell">
            <div className="section-card oncall-static oncall-section is-hover" style={{ width: 460, height: 120 }}>
              <div className="section-header" style={{ height: 42 }}>
                <span className="section-name">Design</span>
                <span className="section-coords">B1</span>
                <span className="section-count">3</span>
                <div className="section-tools">
                  <div className="sec-group">
                    <span className="sec-tool">◳</span>
                    <span className="sec-tool">⊞</span>
                    <span className="sec-tool">◍</span>
                    <span className="sec-tool">▤</span>
                    <span className="sec-tool">⇪</span>
                    <span className="sec-tool">▣</span>
                  </div>
                  <div className="sec-group">
                    <span className="sec-tool">◫</span>
                    <span className="sec-tool">⬓</span>
                    <span className="sec-tool">⤢</span>
                  </div>
                  <div className="sec-group">
                    <span className="sec-tool sec-agent">✦</span>
                    <span className="sec-tool">✕</span>
                  </div>
                </div>
              </div>
            </div>
            <div className="f-tip is-on oncall-tip">
              Ask the agent about this section <span className="f-kbd">{keys("mod+J")}</span>
            </div>
            <div className="effect-label">Section, hovered: no bar — tools wait top-right (add · arrange · agent · remove), each names itself on roll-over</div>
          </div>
          <div className="oncall-cell">
            <div className="section-card oncall-static oncall-section" style={{ width: 420, height: 220 }}>
              <div className="section-header" style={{ height: 42 }}>
                <span className="section-name">Research</span>
                <span className="section-coords">C2</span>
                <span className="section-count">14</span>
              </div>
              <div className="section-body">
                <div className="section-content" style={{ transform: "scale(0.4)" }}>
                  {Array.from({ length: 12 }, (_, i) => (
                    <div
                      key={i}
                      className="frame-card"
                      style={{ position: "absolute", left: 28 + (i % 4) * 236, top: 28 + Math.floor(i / 4) * 156, width: 210, height: 130 }}
                    />
                  ))}
                </div>
                <span className="section-more">
                  2 more <span aria-hidden>⤢</span> Expand
                </span>
              </div>
            </div>
            <div className="effect-label">A section never takes the wheel: it lays its cards out at the width that shows them largest and fits them to its body, down to 40%. Past that it says what doesn't fit and offers Expand</div>
          </div>
          <div className="oncall-cell" style={{ paddingBottom: 72 }}>
            <div className="section-card oncall-static oncall-section expanded" style={{ width: 420, height: 64 }}>
              <div className="section-header" style={{ height: 42 }}>
                <span className="section-name">Research</span>
                <span className="section-coords">C2</span>
                <span className="section-count">14</span>
                <span className="section-back">
                  <span aria-hidden>⤡</span> Back to the board
                </span>
              </div>
            </div>
            <div className="effect-label">Expanded: the section opens as its own grid, at full size and its own width, as long as it needs; neighbours step back to 12%, the wheel pans down through it, Esc or ⤡ closes it</div>
          </div>
        </div>
      </Section>

      <Section
        title="Using a card"
        note={`No card takes the wheel: over a live app, a map, a terminal or a list, the wheel pans the grid and ${IS_MAC ? "⌘" : "Ctrl"}-wheel zooms it. ${keys("mod+click")} puts a card in use (a 2 px blue ring; it alone takes the pointer and the wheel until Esc, a click elsewhere, or a pan). Holding ${IS_MAC ? "⌘" : "Ctrl"} rings the card a click would use. ${keys("mod+enter")} or ⤢ opens it full screen: the card itself, not a copy (an app doesn't reload), under a 44 px bar with its name and the way back.`}
      >
        <div className="adapt-row">
          <div className="oncall-cell">
            <div className="frame-card live-specimen" style={{ width: 360, height: 220, position: "relative" }}>
              <div className="live-frame">
                <div className="frame-poster">
                  <div className="frame-poster-name">Moneyform</div>
                  <div className="frame-poster-domain">moneyform.example</div>
                </div>
                <div className="frame-engage" style={{ opacity: 1 }}>
                  <span className="f-pill frame-engage-pill">
                    {keys("mod+click")} to use · {keys("mod+enter")} full screen
                  </span>
                </div>
              </div>
            </div>
            <div className="effect-label">At rest: the pointer on it shows how to use it; the wheel still pans</div>
          </div>
          <div className="oncall-cell">
            <div className="frame-card live-specimen" style={{ width: 360, height: 220, position: "relative" }}>
              <div className="live-frame is-engaged">
                <div className="frame-poster">
                  <div className="frame-poster-name">Moneyform</div>
                  <div className="frame-poster-domain">in use</div>
                </div>
              </div>
            </div>
            <div className="effect-label">In use: the ring says the pointer and the wheel are the card's</div>
          </div>
          <div className="oncall-cell">
            <div className="frame-card live-specimen" style={{ width: 420, height: 220, display: "flex", flexDirection: "column", overflow: "hidden" }}>
              <div className="fs-bar">
                <span className="fs-title">Moneyform</span>
                <span className="fs-hint">Esc to return to the grid</span>
                <button className="f-pill">Open in a tab ↗</button>
                <button className="f-pill">Back to the grid</button>
              </div>
              <div style={{ flex: 1, background: "var(--color-abyss)" }} />
            </div>
            <div className="effect-label">Full screen: the card fills the window under its bar</div>
          </div>
        </div>
      </Section>

      <Section title="Adding files" note={`Drop files or whole folders on a section, paste onto the board (${keys("mod+V")}: they land where the pointer is), or pick them (${keys("mod+U")}). A folder comes in as a group, in path order, under a note that names it. Every upload goes through one glass tray at the bottom right: how many and how much in its head, a 3 px meter (blue while sending, green when everything landed, red when something didn't), then a row per file (its folder in dim, a percentage while it goes, ✓ when it's there). Three go at a time. It folds to its head, and goes by itself a beat after the last one lands. A failure keeps it open with Retry; its card waits until Retry or Close. Documents (PDF, Word, PowerPoint, Excel, OpenDocument) are searchable by what's inside them a moment after they land, and a result shows the words that matched.`}>
        <UploadsDemo />
      </Section>
      <Section title="Huddles and Slack" note="A huddle is a video portal at a place on the board: Live (green) while people are in it, REC (red, the one convention read without a legend) while it records, tabs and controls along the bottom because the hover bar covers the top. A Slack card is a channel: posts carry the person's name, ours get a blue rule. Shown at 400 and 560 px; offline says why.">
        <div className="adapt-row">
          {[560, 400].map((w) => (
            <div key={w} className="frame-card live-specimen" style={{ width: w, height: 300 }}>
              <div className="huddle-body">
                <div className="huddle-head">
                  <span className="huddle-status is-live">
                    <span className="f-dot is-ok is-live" />
                    Live · 3
                  </span>
                  <span className="huddle-rec">
                    <span className="huddle-rec-dot" />
                    REC
                  </span>
                  <span className="huddle-channel">Slack</span>
                </div>
                <div className="huddle-stage n-3">
                  {["Josh", "Kai", "Mara"].map((n, i) => (
                    <div key={n} className={`huddle-tile${i === 0 ? " is-self" : ""}`}>
                      <span className="huddle-face is-big">{n[0]}</span>
                      <span className="huddle-name">{i === 0 ? `${n} (you)` : n}</span>
                    </div>
                  ))}
                  <div className="huddle-captions">
                    <b>Kai</b> the clearance is four millimetres
                  </div>
                </div>
                <div className="huddle-controls">
                  <span className="huddle-ctl">●</span>
                  <span className="huddle-ctl is-off">×</span>
                  <span className="huddle-ctl is-rec">
                    <span className="huddle-rec-glyph" />
                  </span>
                  <span className="huddle-ctl-note" />
                  <span className="f-pill huddle-leave">Leave</span>
                  <div className="huddle-tabs">
                    <span className="huddle-tab is-on">Room</span>
                    <span className="huddle-tab">Notes 4</span>
                    <span className="huddle-tab">Archive</span>
                  </div>
                </div>
              </div>
            </div>
          ))}
          <div className="frame-card live-specimen" style={{ width: 400, height: 300 }}>
            <div className="huddle-body">
              <div className="huddle-stage is-empty">
                <div className="huddle-portal">
                  <div className="huddle-empty-title">Nobody's here yet</div>
                  <div className="huddle-empty-note">Join and everyone who looks this way sees you; what's said is transcribed into the archive.</div>
                </div>
              </div>
              <div className="huddle-controls">
                <span className="f-pill is-accent">Start the huddle</span>
                <span className="huddle-ctl-note">Camera and mic stay off until you join</span>
              </div>
            </div>
          </div>
          <div className="frame-card live-specimen" style={{ width: 400, height: 300 }}>
            <div className="huddle-body">
              <div className="huddle-lines">
                <div className="huddle-line is-system">Josh started recording · 4:19 PM</div>
                <div className="huddle-line">
                  <div className="huddle-line-head">
                    <b>Josh</b>
                    <time>4:19 PM</time>
                  </div>
                  <p>Rev C clears the fan by 4 mm — good enough to simulate.</p>
                </div>
                <div className="huddle-line">
                  <div className="huddle-line-head">
                    <b>Kai</b>
                    <time>4:20 PM</time>
                    <i>note</i>
                  </div>
                  <p>Action: I'll send the STEP to Vision for CFD today.</p>
                </div>
              </div>
              <div className="huddle-session-foot">
                <span className="f-pill is-agent">✦ Summarize</span>
                <span className="f-pill">Post notes to Slack</span>
              </div>
            </div>
          </div>
          <div className="frame-card live-specimen" style={{ width: 400, height: 300 }}>
            <div className="slack-body">
              <div className="slack-channel">
                <div className="slack-head">
                  <span className="connector-status is-live">
                    <span className="f-dot is-ok is-live" />
                    Slack
                  </span>
                  <span className="slack-topic">Shrouds, fans and rev C</span>
                </div>
                <div className="slack-messages">
                  <div className="slack-msg">
                    <div className="slack-msg-head">
                      <b>Mara</b>
                      <time>3:18 PM</time>
                    </div>
                    <p>@Kai clearance to the fan looks tight, can we look together?</p>
                  </div>
                  <div className="slack-msg is-ours">
                    <div className="slack-msg-head">
                      <b>Josh via Foundation</b>
                      <time>4:21 PM</time>
                    </div>
                    <p>🎥 Josh invited this channel to a huddle on Foundation.</p>
                  </div>
                </div>
                <div className="slack-actions">
                  <span className="f-pill">↗ Link a place</span>
                  <span className="f-pill">◐ Invite to a huddle</span>
                  <span className="f-pill is-accent slack-send">Send</span>
                </div>
              </div>
            </div>
          </div>
          <div className="frame-card live-specimen" style={{ width: 260, height: 300 }}>
            <div className="slack-body">
              <div className="slack-off">
                <div className="connector-offline">
                  <div className="connector-offline-title">Slack isn't connected</div>
                  <div className="connector-offline-reason">Set SLACK_BOT_TOKEN — create the app from docs/slack-app-manifest.yml</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Section>

      <Section
        title="Today and the Shiba"
        note="Home, before the boards. Vision's ethereal shiba fills the room and is the agent's face: warm paper at rest, lilac while it listens, frosted blue while it thinks, dusk while it speaks. Its words are set at 40 (the one size above 32). The day sits beside it on glass: focus rows by kind (overdue red, owned amber, agent violet), goals with a blue bar, and the company apps as chips in the top bar (dashed when not linked). What the Shiba talks about wears the violet ring."
      >
        <TodayDemo />
      </Section>

      <Section title="The Slack board" note="One space with a section for every Slack channel, each kept current with its channel: a Summary note, a Latest note (the newest top-level messages) and the channel's latest images, newest first; a new one takes the first place and the rest move along. Each section wears a live Slack mark beside its count: Slack's octothorpe in the ink (the brand's colours stay out of the chrome), a word and a state dot. Live breathes green: Slack sends what's posted as it's posted. Polling is a still amber dot: the Slack app isn't running, so channels are read in turn while someone looks. Join is a hollow amber dot: the app isn't in the channel, and a press has it join. Offline is red, and the roll-over says why. Beside it, ✦: violet while agents write and keep the summaries, which only a person turns on.">
        <SlackMarks />
      </Section>

      <Section title="Machines" note="A Linux machine or container in a section, on this computer's engine: Kiri or Docker (one wire, the Docker Engine API). The state pill leads: Running (green, breathing), Pulling and Starting (amber, with the engine's own progress), Stopped and Not started (grey), Error (red, in the engine's words), No engine (amber, a hatched well that says why). Kiri installed but asleep is not No engine: the tag says Kiri · asleep and Start wakes it first; a machine whose disk is on a sleeping Kiri is Out of reach (amber), never removed. Then the engine and its version, the image in code type, and published ports as pills that open the port as a page in the section. Start is the one blue action, and only a person presses it: an agent's proposal says so in violet. Running, the shared terminal fills the card (paper, ink, the tokens as its colours); viewers watch it under an amber View only tag. Remove asks twice. A page opened from a port follows its machine: while the machine isn't running the page's poster dims and the machine's state stands over it (the card's own pill, what happened in its words, Start it for a person and Show the machine), and it reloads by itself when the machine runs again; a removed machine, or a card taken off the board, says it's gone. An agent's command (machine_run) waits on the card under the head: violet, the agent's name, the command in code type, its why, and the time left; Run is a person's blue go-ahead beside Decline, and a viewer sees who can answer instead. Running and answered asks shrink to a line (amber running, green exit 0, red otherwise, struck through when declined or unanswered) for two minutes. Shown at 560, 400 and 260 px.">
        <div className="adapt-row">
          <div className="frame-card live-specimen" style={{ width: 560, height: 320 }}>
            <div className="machine-body is-running">
              <div className="machine-head">
                <span className="machine-state is-ok">
                  <span className="f-dot is-ok is-live" />
                  Running
                </span>
                <span className="machine-engine">Kiri 0.9.0</span>
                <code className="machine-image">ubuntu:24.04</code>
                <span className="machine-ports">
                  <span className="f-pill machine-port">:8080 ↗</span>
                </span>
              </div>
              <div className="machine-term-wrap">
                <pre className="machine-term machine-term-specimen">
                  <span className="t-ok">build-box</span>:<span className="t-pulse">~</span># uname -sm{"\n"}Linux x86_64{"\n"}
                  <span className="t-ok">build-box</span>:<span className="t-pulse">~</span># python3 -m http.server 8080{"\n"}Serving HTTP on 0.0.0.0 port 8080 …{"\n"}
                  <span className="t-cursor"> </span>
                </pre>
                <div className="machine-people">2 here</div>
              </div>
              <div className="machine-controls">
                <span className="f-pill">Stop</span>
                <span className="f-pill">Restart</span>
                <span className="machine-name">build-box</span>
                <span className="f-pill machine-remove">Remove</span>
              </div>
            </div>
          </div>
          <div className="frame-card live-specimen" style={{ width: 400, height: 320 }}>
            <div className="machine-body is-absent">
              <div className="machine-head">
                <span className="machine-state is-idle">
                  <span className="f-dot" />
                  Not started
                </span>
                <span className="machine-engine">Docker 28.3.0</span>
                <code className="machine-image">postgres:17</code>
              </div>
              <div className="machine-picker">
                <div className="machine-proposed">
                  <span className="f-dot is-agent" /> Proposed by Foundation Agent: a scratch database for the BOM import
                </div>
                <div className="f-eyebrow">A Linux machine</div>
                <div className="machine-chips">
                  {["ubuntu", "debian", "alpine", "fedora"].map((d) => (
                    <span key={d} className="machine-chip">
                      {d}
                    </span>
                  ))}
                </div>
                <div className="f-eyebrow">On Docker already</div>
                <div className="machine-chips">
                  <span className="machine-chip is-code is-on">postgres:17</span>
                  <span className="machine-chip is-code">nginx:1.27</span>
                </div>
                <div className="machine-start">
                  <span className="f-pill is-accent">Start postgres:17 on Docker</span>
                  <span className="machine-terms">Pulls it if needed · ports on 127.0.0.1 only · nothing from this computer mounted</span>
                </div>
              </div>
            </div>
          </div>
        </div>
        <MachineAsksDemo />
        <div className="adapt-row">
          <div className="frame-card live-specimen" style={{ width: 400, height: 220 }}>
            <div className="machine-body is-pulling">
              <div className="machine-head">
                <span className="machine-state is-warn">
                  <span className="f-dot is-warn is-live" />
                  Pulling
                </span>
                <span className="machine-engine">Kiri 0.9.0</span>
                <code className="machine-image">fedora:42</code>
              </div>
              <div className="machine-progress">
                <span className="f-dot is-warn is-live" />
                <span>Pulling fedora:42: 31 MB of 64 MB</span>
              </div>
            </div>
          </div>
          <div className="frame-card live-specimen" style={{ width: 260, height: 220 }}>
            <div className="machine-body">
              <div className="machine-head">
                <span className="machine-state is-warn">
                  <span className="f-dot is-warn" />
                  No engine
                </span>
              </div>
              <div className="connector-offline">
                <div className="connector-offline-title">No container engine is running here</div>
                <div className="connector-offline-reason">Kiri isn't running here (nothing answers at \\.\pipe\kiri)</div>
              </div>
              <div className="connector-foot">
                <span className="f-pill is-agent">✦ How do I set one up?</span>
              </div>
            </div>
          </div>
          <div className="frame-card live-specimen" style={{ width: 260, height: 220 }}>
            <div className="machine-body is-running">
              <div className="machine-head">
                <span className="machine-state is-ok">
                  <span className="f-dot is-ok is-live" />
                  Running
                </span>
                <span className="machine-engine">Kiri 0.9.0</span>
              </div>
              <div className="machine-term-wrap">
                <pre className="machine-term machine-term-specimen">
                  <span className="t-ok">box</span>:<span className="t-pulse">~</span># ls{"\n"}notes.md  src{"\n"}
                </pre>
                <div className="machine-watching">View only: you're watching</div>
              </div>
            </div>
          </div>
        </div>
        <div className="adapt-row">
          <div className="frame-card live-specimen" style={{ width: 400, height: 220 }}>
            <div className="machine-body is-absent">
              <div className="machine-head">
                <span className="machine-state is-idle">
                  <span className="f-dot" />
                  Not started
                </span>
                <span className="machine-engine">Kiri · asleep</span>
                <code className="machine-image">alpine:3.22</code>
              </div>
              <div className="machine-picker">
                <div className="f-eyebrow">A Linux machine</div>
                <div className="machine-chips">
                  {["ubuntu", "debian", "alpine", "fedora"].map((d) => (
                    <span key={d} className={`machine-chip${d === "alpine" ? " is-on" : ""}`}>
                      {d}
                    </span>
                  ))}
                </div>
                <div className="machine-start">
                  <span className="f-pill is-accent">Start alpine:3.22 on Kiri</span>
                  <span className="machine-terms">Wakes Kiri first · Pulls it if needed · ports on 127.0.0.1 only · nothing from this computer mounted</span>
                </div>
              </div>
            </div>
          </div>
          <div className="frame-card live-specimen" style={{ width: 400, height: 220 }}>
            <div className="machine-body is-stopped">
              <div className="machine-head">
                <span className="machine-state is-warn">
                  <span className="f-dot is-warn" />
                  Out of reach
                </span>
                <span className="machine-engine">Kiri · asleep</span>
                <code className="machine-image">alpine:3.22</code>
              </div>
              <div className="machine-well">
                <div className="connector-offline-title">build-box is out of reach</div>
                <div className="connector-offline-reason">Kiri isn't answering here, so this machine is out of reach. Its disk is kept: Start brings Kiri back and runs it again.</div>
              </div>
              <div className="machine-controls">
                <span className="f-pill is-accent">Start on Kiri</span>
                <span className="machine-name">build-box</span>
                <span className="f-pill machine-remove">Remove</span>
              </div>
            </div>
          </div>
        </div>
        <div className="adapt-row">
          <HeldPageDemo width={400} word="Stopped" tone="idle" title="Machine stopped — web-box isn't running" reason="Stopped by Ada. Its disk is kept: Start runs it again." start show />
          <HeldPageDemo width={400} word="Running" tone="ok" live title="web-box is running" reason="Waiting for :80 to answer…" />
        </div>
        <div className="adapt-row">
          <HeldPageDemo width={400} word="Stopped" tone="idle" title="Machine stopped — web-box isn't running" reason="Its disk is kept: Start runs it again." show viewer />
          <HeldPageDemo width={260} word="Not started" tone="idle" kind="removed" title="Machine gone — web-box was removed" reason="Removed by Ada, with its disk. Start makes a fresh one." show />
          <HeldPageDemo width={260} word="Gone" tone="idle" kind="gone" title="Machine gone — web-box isn't on the board any more" reason="This page was port 80 of it. There's nothing left to load." />
        </div>
      </Section>

      <Section title="The crew" note="Agents you can see. Each ask gets an agent with a generated name and a colour of its own from the violet family (six, --color-crew-0…5), and a cursor that glides on a spring to what it's about to change, a beat before the change lands, saying what it's doing in a paper chip. A helper says who called it in. Done shows in green where it finished, then the cursor fades and leaves. When an agent brings you somewhere, a glass pill under the top bar says so with Back; if you were busy moving, it asks first (Go, in violet, because an agent will act). Hold Space and the voice sheet rises from the bottom: the mic's own level in violet bars, your words as heard, the crew at work below with Open and Stop; a tap of Space types instead.">
        <CrewDemo />
      </Section>

      <Section title="Agents in a section" note="Every section has an agent group: a paper tab that stands right above it, on its top edge, while the pointer is on the section, or always once it's pinned (the pin turns violet; a pin is this device's own). A face is an agent's initial on its own crew colour, with a ring that breathes while it works; done, it keeps its colour and sets back, with no ring; stopped is amber. The tab is drawn at screen size at any zoom, and when its section fills the view it comes down with the view instead of hiding under the top bar. A free agent that comes into the section joins the group on a spring, and leaves it when it moves on. A lead and the helpers it called in stand shoulder to shoulder and the tab says working together; separate asks stand apart and it counts the teams. Press a face to follow that agent. The last button opens the agents pane on the right, where search goes: every agent by the section it's in, what it's doing and the ask it's on, with each team held by a rule in its lead's colour. The section it was opened from comes first, in violet. At the pane's foot, this computer's agents: Foundation's own T3 instance, off until a person presses Start T3 (it's a third-party program). Running, each agent T3 has is a face with how it stands (an ok dot and its plan, amber for needs sign-in, set back on the panel well when it isn't installed) and the threads it's working on under a rule in its colour; the ones turned off in T3 are one dim line. The agents stand in two groups under small caps: In the cloud (what you ask goes to a service, on a plan or a key) and On this computer (a local model server: no key, nothing leaves it). Ask on a ready agent opens a composer on paper, ringed violet while it has focus: the model, a note that it runs supervised and on what, and Ask in violet, because an agent will act; the agent then joins the section's group under its own name. Its threads carry Open (T3's own page, for approvals and the transcript) and Stop. An admin adds Kimi or DeepSeek with a form on paper: which, and where it runs (two segmented controls), then the key (cloud only), the model and the address, with a line that says what a local model server answered.">
        <SectionCrewDemo />
      </Section>

      <Section title="Agents in the section" note="A section says it can be worked in by agents before anyone has asked. At rest its header carries two quiet marks at the right, in dim 11/600 on 22 px pills: ✦ Agents (the ✦ in violet) and ⤢, the way into the section's own grid; the tools take that corner while the pointer is on the section, and carry the same two. With agents at work the chip turns violet on the agent wash and counts them behind a breathing dot. Pressed, it opens the section's agents as a panel in the section's top-right corner, under its header: raised paper, pane radius, a hairline tinted violet, 340 wide, drawn at screen size and moving with the section. It lists who is at work there (a lead and its helpers as one team, with Follow, Open and Stop), the last three things agents made there, and a composer ringed violet in focus: three starters as violet chips, and Ask as the violet pill, because an agent will act. An ask from here brings an agent into this section under its own name and cursor. Keep here puts the same view on the board as a card, for everyone; the right-click menu adds it too (Agents card).">
        <SectionAgentsDemo />
      </Section>

      <Section title="Text box" note={`A note written as formatted text: what you see is what's kept. Click in it to write; a toolbar rides the card's foot while it has the caret (raised paper, card radius, 34 tall): the style (Body, Title, Heading, Subheading), bold, italic, underline, strikethrough, bulleted and numbered lists, quote, link, clear. A mark that's on is the pulse tint. ${keys("mod+B")}, ${keys("mod+I")} and ${keys("mod+U")} work as in any word processor. Under it, it is the note's own markdown in the note's shared text, so search, agents and the other renderer read it as they read any note; underline is kept as <u>. From the right-click menu (Text box), and from an empty section's Write.`}>
        <TextBoxDemo />
      </Section>

      <Section title="Writing together" note={`A note at rest is its markdown, tables included. Double-click and it opens as a CodeMirror editor on the note's shared text: monospace, the markdown's own marks dimmed, headings and strong text in weight, links blue — no colour of its own. Every keystroke is shared as it's typed, so two people can write in one note, even in one word, and both keep their words whole. Each person keeps their own colour: someone else's caret is a 2 px bar in it, named while it moves and quiet once it rests; their selection is a 22 % tint. A note at rest names whoever is writing in it with a breathing chip at the bottom right, clear of the bar that drops in at the top. ${keys("mod+Z")} takes back only your own words. The two editors below share one text: type in either.`}>
        <NoteEditorDemo />
      </Section>

      <Section title="Plan board" note="Settings → Plan: Foundation's own kanban, the local copy of the issues on GitHub. Columns sit on the panel well; cards are raised paper with the title in 13/600 and a meta line in dim 11: a kind dot (red bug, blue plan, amber when it waits on a person), the milestone, the area in code type and the issue number, which links to the issue (a card made here says new in amber until it's synced). Needs you reads amber, Done green. An admin drags a card to another column (the column rings blue) or picks Move to… on the opened card; a moved card keeps an amber hairline and says who moved it until it's synced. Beside the title, + New card opens a form on the panel well, and Sync with GitHub turns while it works, then says what it sent in ok green. Every column's hint takes two lines so the cards start level. Cards travel on the camera spring. Under 720 px the columns stack.">
        <PlanBoardDemo />
      </Section>

      <Section title="Out of search, into the hand" note={`A search result is something you pick up. Pull it past 5 px and it comes out of the list as a card: a picture as the picture, anything else as a slip of paper with its mark and name. It follows on the drag spring, lifted 2.5 % on the lift shadow and leaning at most 2.5° about the point it was pressed; its row stays behind, dimmed and dashed. It's a little faint until it's over somewhere it can land; the section under it rings. Let go over the grid and it settles flat as the card arrives under it; anywhere else (or Esc) it flies back into its row. A file that has to be fetched first (from Flowform, from an approved folder) waits where it was put, flat, with a bar moving along its foot. ＋ on a result (or ${keys("mod+click")}) keeps it on the clipboard at the foot of the pane: small cards a little askew on a paper well. Pull one off to carry it; pull the stack's handle to carry them all, fanned, each card under the top one on a looser spring so the stack trails the hand, and they're dealt out one step apart. What lands leaves the clipboard. Try it here: clip a few, pull the stack.`}>
        <PickupDemo />
      </Section>

      <Section title="Desktop updates" note="The desktop app checks its signed feed a few seconds after it opens and puts this card up under the top bar, on glass, when a new version is ready: Update and restart is the one blue action, Later hides it until the next launch, Skip this version until a newer one. Nothing downloads until a person presses Update. The bar fills on the compositor; the mark's panels settle while it works. After the restart it says what changed, once. Settings → Updates shows the same card inline on paper, with Check for updates. Shown at 260, 400 and 560 px.">
        <UpdateDemo />
      </Section>

      <Section title="Server switch" note="Bottom right, wherever the app can point at another server (the desktop app, or a page on another site's server), over the sign-in page too: a glass pill with a dot for whether the server this app uses answers (green), is starting or being checked (amber, breathing) or can't be reached (red), and its address. Pressed, it opens upward into both ways to have a server, on paper: This computer, where Start the server is the one blue action (the desktop app runs Foundation's server from a checkout; once it answers, the app uses it and reloads), and a remote server by address, where Connect reloads onto it to sign in. The one in use is ringed and tagged. A server that won't start says why in its own words, in red. Esc or a press outside puts it away. The call chip and the upload tray move up while it's there.">
        <ServerSwitchDemo />
      </Section>

      <Section title="Release notes" note="Settings → Releases: docs/blog/<version>.md, newest first. The versions run down a sticky list on the left (the current one raised paper, the one this app is built as tagged in blue); the post reads on the right at 720 px: an eyebrow with the version and date, the title in display 24, the body in mist 14/1.6 with frost headings and bold. Under 720 px the list runs across the top.">
        <div className="design-releases">
          <ReleasesTab posts={DEMO_POSTS} route="" />
        </div>
      </Section>

      <Section title="Rune renderer" note="A second engine beside the web renderer (Settings → Renderer; it's this device's choice, and the web renderer is the default). While Rune draws the board, a quiet glass pill in the bottom bar says so, beside the zoom: a green dot when it's drawing, a breathing blue one while it starts, amber and Rune off when it was asked for and couldn't run (the label says why, and a toast says it once). A press opens the list of where Rune stands. In Settings the two engines are raised cards, the chosen one ringed blue; under them, whether WebGPU and the build are here, then the ledger: each part of the board with one of four words. Never violet: which engine draws is a person's choice.">
        <RuneDesign />
      </Section>

      <Section title="Panels that adapt" note="Design for the narrowest width first; container queries, never the window. Check 260, 400 and 560 px.">
        <div className="adapt-row">
          {[260, 400, 560].map((w) => (
            <div key={w} className="adapt-panel" style={{ width: w }}>
              <div className="adapt-head">
                <span className="f-dot is-ok" /> FactoryForm <span className="adapt-deco">· live</span>
              </div>
              <div className="adapt-metrics">
                <div>
                  <b>$412k</b>
                  <span>on hand</span>
                </div>
                <div>
                  <b>3</b>
                  <span>below reorder</span>
                </div>
                <div className="adapt-secondary">
                  <b>12</b>
                  <span>open POs</span>
                </div>
              </div>
              <div className="adapt-w">{w}px</div>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

/** the crew, laid out still: cursors on a card, the guide pill, the sheet listening and typing */
/** an agent's command on a running machine's card: waiting for a person, then what became of it (560, 400 as a viewer, 260) */
function MachineAsksDemo() {
  const now = Date.now();
  const waiting: MachineAsk = { id: "ask_demo1", command: "apt-get install -y python3-pip && pip install trimesh", why: "to read the STEP export and list its parts", by: "Kestrel", for: "Ada", state: "waiting", at: now - 20_000, expiresAt: now + 100_000 };
  const answered: MachineAsk[] = [
    { id: "ask_demo0", command: "uname -sm", by: "Kestrel", for: "Ada", state: "done", at: now - 90_000, decidedBy: "Ada", exitCode: 0, endedAt: now - 80_000 },
    { id: "ask_demo2", command: "rm -rf /srv/cache", by: "Kestrel", for: "Ada", state: "declined", at: now - 60_000, decidedBy: "Kai", endedAt: now - 50_000 },
  ];
  const card = (width: number, height: number, asks: MachineAsk[], viewer = false) => (
    <div className="frame-card live-specimen" style={{ width, height }}>
      <div className="machine-body is-running">
        <div className="machine-head">
          <span className="machine-state is-ok">
            <span className="f-dot is-ok is-live" />
            Running
          </span>
          <span className="machine-engine">Kiri 0.9.0</span>
          <code className="machine-image">ubuntu:24.04</code>
        </div>
        <MachineAskList asks={asks} viewer={viewer} now={now} />
        <div className="machine-term-wrap">
          <pre className="machine-term machine-term-specimen">
            <span className="t-ok">build-box</span>:<span className="t-pulse">~</span># ls /srv{"\n"}cache exports{"\n"}
            <span className="t-cursor"> </span>
          </pre>
        </div>
      </div>
    </div>
  );
  return (
    <div className="adapt-row">
      {card(560, 400, [...answered, waiting])}
      {card(400, 360, [{ id: "ask_demo4", command: "python3 -m pip list", by: "Wren", for: "Kai", state: "running", at: now - 4_000, decidedBy: "Kai" }, waiting], true)}
      {card(260, 300, [waiting])}
    </div>
  );
}

/** a section at rest and at work, and its agents panel: empty, and with a team and what it made */
function SectionAgentsDemo() {
  const face = (id: string, hue: number, doing: string, extra: Partial<CrewFace> = {}): AgentRowData => ({ id, name: id, hue, status: "working", doing, askerName: "Ada Okafor", task: "", mine: true, ...extra });
  const wren = { ...face("Wren", 0, "writing the parts table"), task: "Build the parts table from the STEP export" };
  const tern = { ...face("Tern", 1, "reading the STEP export", { lead: "Wren", leadName: "Wren" }), task: "Read the STEP header and list its parts" };
  const team = { id: "Wren", members: [wren, tern], together: true };
  const now = Date.now();
  const header = (name: string, working: number, on = false) => (
    <div className="section-card oncall-static oncall-section" style={{ width: 340, height: 64 }}>
      <div className="section-header" style={{ height: 42 }}>
        <span className="section-name">{name}</span>
        <span className="section-coords">A1</span>
        <span className="section-rest">
          <SectionAgentsChipView working={working} on={on} sectionName={name} />
          <button type="button" className="sec-rest-open" aria-label="Open as its own grid">
            ⤢
          </button>
        </span>
      </div>
    </div>
  );
  return (
    <div className="sec-crew-demo sec-agents-demo">
      <div className="oncall-row">
        <div className="oncall-cell">
          {header("Suppliers", 0)}
          <div className="effect-label">At rest: agents can build here</div>
        </div>
        <div className="oncall-cell">
          {header("Parts", 2)}
          <div className="effect-label">Two at work</div>
        </div>
        <div className="oncall-cell">
          {header("Parts", 0, true)}
          <div className="effect-label">Its panel is open</div>
        </div>
      </div>
      <div className="adapt-row">
        <div className="sa-panel sa-specimen" style={{ width: 340 }}>
          <header className="sa-head">
            <span className="sa-title">
              <span className="sa-spark">✦</span>Agents in <b>Suppliers</b>
            </span>
            <button className="crew-row-btn">Keep here</button>
            <button className="crew-row-btn">All agents</button>
            <button className="sa-close">✕</button>
          </header>
          <SectionAgentsView sectionName="Suppliers" teams={null} recent={[]} canAsk />
        </div>
        <div className="sa-panel sa-specimen" style={{ width: 340 }}>
          <header className="sa-head">
            <span className="sa-title">
              <span className="sa-spark">✦</span>Agents in <b>Parts</b>
            </span>
            <button className="crew-row-btn">Keep here</button>
            <button className="crew-row-btn">All agents</button>
            <button className="sa-close">✕</button>
          </header>
          <SectionAgentsView
            sectionName="Parts"
            canAsk
            now={now}
            recent={[
              { at: now - 20_000, who: "Wren", text: "made table “Parts”" },
              { at: now - 240_000, who: "Lark", text: "wrote “Suppliers to call”", for: "Ada Okafor" },
            ]}
            teams={
              <div className="sa-teams">
                <ul className="agents-team is-together" style={{ ["--crew" as string]: "var(--color-crew-0)" }}>
                  <li className="agents-team-label">
                    Working together <span>· one ask, for Ada</span>
                  </li>
                  {team.members.map((m) => (
                    <AgentRow key={m.id} row={m} team={team} acts={<><button className="crew-row-btn">Follow</button>{!m.lead && <><button className="crew-row-btn">Open</button><button className="crew-row-btn is-stop">Stop</button></>}</>} />
                  ))}
                </ul>
              </div>
            }
          />
        </div>
        <div className="sa-panel sa-specimen" style={{ width: 300 }}>
          <header className="sa-head">
            <span className="sa-title">
              <span className="sa-spark">✦</span>Agents in <b>Review</b>
            </span>
            <button className="sa-close">✕</button>
          </header>
          <SectionAgentsView sectionName="Review" teams={null} recent={[]} canAsk={false} />
        </div>
      </div>
    </div>
  );
}

/** a text box at rest and while it's written in (the toolbar's marks on) */
function TextBoxDemo() {
  const html = renderMarkdown("# Launch plan\n\nShip the **desktop app** this week, _signed_ and <u>notarised</u>.\n\n- Sign the build\n- ~~Email the list~~ post in #launch\n\n> Nothing ships on a Friday.");
  const box = (writing: boolean) => (
    <div className="frame-card oncall-static" style={{ position: "relative", width: 400, height: 300 }}>
      <div className="note-inner" style={{ height: 300 }}>
        <div className={`note-rendered rich-text${writing ? " is-writing" : ""}`} style={writing ? { paddingTop: 14 } : undefined} dangerouslySetInnerHTML={{ __html: html }} />
        {writing && (
          <div className="rich-bar-slot">
            <RichToolbar marks={{ bold: true, italic: false, underline: false, strike: false, ul: false, ol: false, quote: false, style: "p" }} />
          </div>
        )}
      </div>
    </div>
  );
  return (
    <div className="adapt-row text-box-demo">
      <div className="oncall-cell">
        {box(false)}
        <div className="effect-label">At rest</div>
      </div>
      <div className="oncall-cell">
        {box(true)}
        <div className="effect-label">Writing: the caret is in bold text</div>
      </div>
    </div>
  );
}

/** the agent group above a section (one agent, one team, teams side by side, pinned and empty) and the agents pane */
function SectionCrewDemo() {
  const face = (id: string, hue: number, doing: string, extra: Partial<CrewFace> = {}): CrewFace => ({ id, name: id, hue, status: "working", doing, askerName: "Ada Okafor", ...extra });
  const wren = face("Wren", 0, "writing the parts table");
  const tern = face("Tern", 1, "reading the STEP export", { lead: "Wren", leadName: "Wren" });
  const lark = face("Lark", 2, "listing suppliers to call", { lead: "Wren", leadName: "Wren" });
  const basalt = face("Basalt", 3, "checking web-box's port", { askerName: "Kai Ito" });
  const onyx = face("Onyx", 4, "", { status: "done", askerName: "Kai Ito" });
  const specimens: Array<{ label: string; name: string; faces: CrewFace[]; pinned?: boolean }> = [
    { label: "One agent, pointer on the section", name: "Parts", faces: [wren] },
    { label: "A lead and two helpers: one team", name: "Parts", faces: [wren, tern, lark] },
    { label: "Pinned · two asks side by side, one done", name: "Shop floor", faces: [wren, tern, basalt, onyx], pinned: true },
    { label: "Pinned, nobody here", name: "Suppliers", faces: [], pinned: true },
  ];
  const row = (f: CrewFace, task: string, mine = true): AgentRowData => ({ ...f, task, mine });
  const team = (members: AgentRowData[]) => ({ id: members[0].id, members, together: members.length > 1 });
  const places: AgentsPlace[] = [
    { id: "parts", name: "Parts", at: true, teams: [team([row(wren, "Build the parts table from the STEP export"), row(tern, "Read the STEP header and list its parts"), row(lark, "Find a supplier for each part")])] },
    { id: "shop", name: "Shop floor", at: false, teams: [team([row(basalt, "Is web-box serving on port 80?", false)]), team([row(onyx, "Summarise yesterday's huddle", false)])] },
  ];
  const claudeModels = [
    { slug: "claude-opus-5-5", name: "Claude Opus 5.5" },
    { slug: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
  ];
  const t3Running: T3Host = {
    state: "running",
    version: "0.0.44",
    port: 15783,
    since: 0,
    agents: [
      { id: "claudeAgent", driver: "claudeAgent", name: "Claude", enabled: true, installed: true, version: "2.1.319", state: "ready", account: "Claude Team Subscription", models: 12, modelList: claudeModels, where: "cloud" },
      { id: "codex", driver: "codex", name: "Codex", enabled: true, installed: true, version: "0.98.0", state: "sign-in", models: 0, modelList: [], where: "cloud" },
      { id: "kimi-cloud", driver: "claudeAgent", name: "Kimi", enabled: true, installed: true, version: "2.1.319", state: "ready", models: 1, modelList: [{ slug: "kimi-k3", name: "Kimi · kimi-k3" }], model: "kimi-k3", where: "cloud", added: { preset: "kimi", baseUrl: "https://api.moonshot.ai/anthropic" } },
      { id: "deepseek-local", driver: "claudeAgent", name: "DeepSeek (local)", enabled: true, installed: true, version: "2.1.319", state: "ready", models: 1, modelList: [{ slug: "deepseek-r1:14b", name: "DeepSeek · deepseek-r1:14b" }], model: "deepseek-r1:14b", where: "local", added: { preset: "deepseek", baseUrl: "http://127.0.0.1:11434" } },
      { id: "cursor", driver: "cursor", name: "Cursor", enabled: false, installed: false, version: null, state: "off", models: 0, modelList: [], where: "cloud" },
      { id: "grok", driver: "grok", name: "Grok", enabled: false, installed: false, version: null, state: "off", models: 0, modelList: [], where: "cloud" },
    ],
    work: [
      { id: "t1", title: "Build the parts table from the STEP export", project: "Foundation", agent: "claudeAgent", model: "claude-opus-5-5", state: "working", updatedAt: "" },
      { id: "t2", title: "Rim drive: tolerance stack", project: "Fans", agent: "kimi-cloud", model: "kimi-k3", state: "waiting", updatedAt: "" },
    ],
  };
  const t3Presets: Record<string, T3Preset> = {
    kimi: { name: "Kimi", cloud: { baseUrl: "https://api.moonshot.ai/anthropic", model: "kimi-k3" }, local: { baseUrl: "http://127.0.0.1:11434", model: "" } },
    deepseek: { name: "DeepSeek", cloud: { baseUrl: "https://api.deepseek.com/anthropic", model: "deepseek-v4-pro" }, local: { baseUrl: "http://127.0.0.1:11434", model: "" } },
  };
  return (
    <div className="sec-crew-demo">
      <div className="oncall-row">
        {specimens.map((sp) => (
          <div className="oncall-cell" key={sp.label}>
            <div className="section-card oncall-static oncall-section" style={{ width: 300, height: 84 }}>
              <SectionCrewView faces={sp.faces} pinned={!!sp.pinned} shown sectionName={sp.name} />
              <div className="section-header" style={{ height: 42 }}>
                <span className="section-name">{sp.name}</span>
                <span className="section-coords">A1</span>
              </div>
            </div>
            <div className="effect-label">{sp.label}</div>
          </div>
        ))}
      </div>
      <div className="adapt-row">
        <div className="agents-pane-specimen" style={{ width: 360 }}>
          <AgentsPaneBody places={places} count={5} />
        </div>
        <div className="agents-pane-specimen" style={{ width: 300 }}>
          <AgentsPaneBody places={[{ id: "suppliers", name: "Suppliers", at: true, teams: [] }]} count={0} />
        </div>
        <div className="agents-pane-specimen" style={{ width: 300 }}>
          <AgentsPaneBody places={[]} count={0} foot={<T3BlockView host={null} viewer={false} />} />
        </div>
      </div>
      <div className="adapt-row">
        <div className="agents-pane-specimen is-tall" style={{ width: 360 }}>
          <div className="agents-scroll">
            <T3BlockView host={t3Running} viewer={false} admin section={{ id: "parts", name: "Parts" }} askingStart="claudeAgent" />
          </div>
        </div>
        <div className="agents-pane-specimen is-tall" style={{ width: 340 }}>
          <div className="agents-scroll">
            <T3AddForm presets={t3Presets} local={null} start={{ preset: "kimi", where: "cloud" }} />
          </div>
        </div>
        <div className="agents-pane-specimen is-tall" style={{ width: 340 }}>
          <div className="agents-scroll">
            <T3AddForm presets={t3Presets} local={{ baseUrl: "http://127.0.0.1:11434", up: true, models: ["deepseek-r1:14b", "qwen3-coder:30b"] }} start={{ preset: "deepseek", where: "local" }} />
          </div>
        </div>
        <div className="agents-pane-specimen is-short" style={{ width: 300 }}>
          <div className="agents-scroll">
            <T3BlockView host={{ state: "starting", detail: "Starting T3 on port 15783", since: 0, agents: [], work: [] }} viewer={false} />
          </div>
        </div>
        <div className="agents-pane-specimen is-short" style={{ width: 300 }}>
          <div className="agents-scroll">
            <T3BlockView host={{ state: "error", detail: "The T3 program isn't on this computer. Install Vision Code, or set T3_CLI to a t3 program where Foundation's server starts.", since: 0, agents: [], work: [] }} viewer={false} />
          </div>
        </div>
      </div>
    </div>
  );
}

function CrewDemo() {
  const cursor = (name: string, hue: number, doing: string, x: number, y: number, extra = "", lead?: string) => (
    <div className={`crew-cursor is-placed${extra}`} style={{ transform: `translate3d(${x}px, ${y}px, 0)`, ["--crew" as string]: `var(--color-crew-${hue})` }}>
      <svg className="crew-arrow" width="20" height="22" viewBox="0 0 20 22">
        <path d="M2 2 L17.5 10.5 L10.4 12.3 L7 19.5 Z" fill="var(--crew)" stroke="var(--color-raise)" strokeWidth="1.6" strokeLinejoin="round" />
      </svg>
      <span className="crew-spark" />
      <div className="crew-tag">
        <span className="crew-name">
          ✦ {name}
          {lead && <span className="crew-with"> · with {lead}</span>}
        </span>
        <span className="crew-doing">{doing}</span>
      </div>
    </div>
  );
  const row = (name: string, hue: number, doing: string, status = "working", mine = true, extra?: string) => (
    <li className={`crew-row${mine ? " is-mine" : ""} is-${status}`} style={{ ["--crew" as string]: `var(--color-crew-${hue})` }}>
      <span className="crew-row-dot" />
      <span className="crew-row-name">{name}</span>
      <span className="crew-row-doing">
        {doing}
        {extra && <span className="crew-row-for"> · {extra}</span>}
      </span>
      {mine && (
        <span className="crew-row-actions">
          <button className="crew-row-btn">Open</button>
          {status === "working" && <button className="crew-row-btn is-stop">Stop</button>}
        </span>
      )}
    </li>
  );
  return (
    <div className="crew-demo">
      <div className="crew-demo-board">
        <div className="frame-card crew-demo-card" style={{ left: 24, top: 28, width: 300, height: 170 }}>
          <div className="crew-demo-sheet">
            {["Part", "Qty", "Supplier"].map((h) => (
              <b key={h}>{h}</b>
            ))}
            {["Vane, 6061", "12", "Kapaʻa Metals", "Hub bearing", "2", "Pacific Fasteners", "M4 cap screw", "48", "Pacific Fasteners"].map((c, i) => (
              <span key={i}>{c}</span>
            ))}
          </div>
        </div>
        <div className="frame-card crew-demo-card" style={{ left: 360, top: 28, width: 220, height: 120 }}>
          <div className="crew-demo-note">
            <b>Suppliers to call</b>
            <span>Kapaʻa Metals: 3 weeks</span>
          </div>
        </div>
        <div className="crew-layer" style={{ zIndex: 2 }}>
          {cursor("Wren", 0, "making table “Parts”", 70, 50)}
          {cursor("Kestrel", 2, "writing “Suppliers to call”", 400, 52, "", "Wren")}
          {cursor("Basalt", 1, "✓ done", 260, 170, " is-done")}
          {cursor("Vega", 4, "the total, 52.62", 150, 110, " is-pointing")}
        </div>
        <div className="effect-label">Cursors at 100 %: Wren aiming at the table it's filling, Kestrel (a helper Wren called in), Basalt done and leaving, Vega pointing at a cell (the laser)</div>
      </div>
      <div className="crew-demo-col">
        <div className="crew-guide crew-follow f-glass" style={{ ["--crew" as string]: "var(--color-crew-1)" }}>
          <span className="crew-guide-dot" />
          <span className="crew-guide-text">
            Following <b>Sirocco</b>
            <span className="crew-guide-note"> · writing “What's here”</span>
          </span>
          <button className="f-pill crew-guide-back">Stop</button>
        </div>
        <div className="crew-guide f-glass" style={{ ["--crew" as string]: "var(--color-crew-0)" }}>
          <span className="crew-guide-dot" />
          <span className="crew-guide-text">
            <b>Wren</b> brought you to <b>Supply chain</b>
            <span className="crew-guide-note"> · the parts table is ready</span>
          </span>
          <button className="f-pill crew-guide-back">← Back</button>
        </div>
        <div className="crew-guide f-glass" style={{ ["--crew" as string]: "var(--color-crew-2)" }}>
          <span className="crew-guide-dot" />
          <span className="crew-guide-text">
            <b>Kestrel</b> wants to show you <b>Suppliers</b>
          </span>
          <button className="f-pill is-agent">Go</button>
          <button className="crew-guide-x">✕</button>
        </div>
        <div className="effect-label">Brought (Back) · asked first, because you were moving (Go)</div>
        <div className="talk-sheet f-glass is-open crew-demo-still" data-mode="listening">
          <div className="talk-input">
            <span className="talk-level is-on">
              {[0, 1, 2, 3, 4].map((i) => (
                <span key={i} style={{ animationDelay: `${i * 90}ms` }} />
              ))}
            </span>
            <p className="talk-heard">make a supply section with the parts and hook up FactoryForm</p>
          </div>
          <ul className="crew-roster">
            <li className="crew-row crew-row-all">
              <span className="crew-row-doing">2 of yours at work</span>
              <span className="crew-row-actions">
                <button className="crew-row-btn is-stop">Stop all</button>
              </span>
            </li>
            {row("Wren", 0, "making table “Parts”")}
            {row("Kestrel", 2, "writing “Suppliers to call”", "working", true, "with Wren")}
            {row("Vega", 4, "searching “thermal map”", "working", false, "for Kai")}
          </ul>
          <div className="talk-hints">
            <span>
              Let go of <span className="f-kbd">Space</span> to send
            </span>
            <span>
              <span className="f-kbd">Esc</span> drops it
            </span>
          </div>
        </div>
        <div className="effect-label">Holding Space: the level, the words, the crew at work</div>
        <div className="talk-sheet f-glass is-open crew-demo-still" data-mode="typing">
          <div className="talk-input">
            <span className="talk-level">
              {[0, 1, 2, 3, 4].map((i) => (
                <span key={i} />
              ))}
            </span>
            <textarea className="talk-field" rows={1} placeholder="Ask the crew: make a section for…, hook up FactoryForm…" readOnly />
          </div>
          <div className="talk-hints">
            <span>
              <span className="f-kbd">↵</span> sends
            </span>
            <span>
              Hold <span className="f-kbd">Space</span> on the board to talk
            </span>
          </div>
        </div>
        <div className="effect-label">A tap of Space: typing</div>
      </div>
    </div>
  );
}

const DEMO_NOTE = [
  "## Fan programme",
  "",
  "Goals:",
  "- ship the fan",
  "- **tooling** by the 14th",
  "",
  "Risks:",
  "- supplier slip, see [the tracker](https://example.com)",
  "",
  "| Part | Qty |",
  "|---|---|",
  "| Shroud | 2 |",
  "| Hub | 1 |",
  "",
].join("\n");

/**
 * Two live note editors on one Y.Text (as Ada's and Kai's browsers would be),
 * each drawing the other's caret, beside the same note at rest: rendered
 * markdown with its table and the chip naming who's writing.
 */
function NoteEditorDemo() {
  const ada = useRef<HTMLDivElement>(null);
  const kai = useRef<HTMLDivElement>(null);
  const [text, setText] = useState(DEMO_NOTE);
  useEffect(() => {
    let gone = false;
    const handles: Array<{ destroy(): void }> = [];
    const doc = new Y.Doc();
    const ytext = doc.getText("note");
    ytext.insert(0, DEMO_NOTE);
    const sync = () => setText(ytext.toString());
    ytext.observe(sync);
    // each person's selection as relative positions, as the board's awareness carries them
    const people = [
      { clientId: 1, name: "Ada", color: "var(--viz-5)", sel: null as null | { anchor: Y.RelativePosition; head: Y.RelativePosition } },
      { clientId: 2, name: "Kai", color: "var(--viz-3)", sel: null as null | { anchor: Y.RelativePosition; head: Y.RelativePosition } },
    ];
    const rel = (i: number) => Y.createRelativePositionFromTypeIndex(ytext, i);
    const abs = (r: Y.RelativePosition) => Y.createAbsolutePositionFromRelativePosition(r, doc)?.index ?? 0;
    // where each starts: Kai after "ship the fan", Ada selecting "supplier slip"
    const kaiAt = DEMO_NOTE.indexOf("ship the fan") + "ship the fan".length;
    people[1].sel = { anchor: rel(kaiAt), head: rel(kaiAt) };
    people[0].sel = { anchor: rel(DEMO_NOTE.indexOf("supplier")), head: rel(DEMO_NOTE.indexOf(", see")) };
    const listeners = new Set<() => void>();
    const source = (me: number) => ({
      get: () =>
        people
          .filter((p) => p.clientId !== me && p.sel)
          .map((p) => {
            const [a, h] = [abs(p.sel!.anchor), abs(p.sel!.head)];
            return { clientId: p.clientId, name: p.name, color: p.color, from: Math.min(a, h), to: Math.max(a, h), head: h };
          }),
      subscribe: (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn)),
      publish: (sel: { anchor: number; head: number } | null) => {
        const p = people.find((x) => x.clientId === me)!;
        if (!sel) return;
        p.sel = { anchor: rel(sel.anchor), head: rel(sel.head) };
        for (const fn of listeners) fn();
      },
    });
    void loadNoteEditor().then((m) => {
      if (gone) return;
      for (const [el, me, um] of [[ada.current, 1, new Y.UndoManager(ytext)], [kai.current, 2, new Y.UndoManager(ytext)]] as const)
        if (el) handles.push(m.mountNoteEditor(el, { ytext, undoManager: um, carets: source(me), at: 0 }));
    });
    return () => {
      gone = true;
      for (const h of handles) h.destroy();
      ytext.unobserve(sync);
      doc.destroy();
    };
  }, []);
  return (
    <div className="adapt-row">
      {(
        [
          ["Ada writing", ada],
          ["Kai writing", kai],
        ] as const
      ).map(([label, ref]) => (
        <div key={label} style={{ display: "grid", gap: 6 }}>
          <span className="design-note">{label}</span>
          <div className="frame-card" style={{ width: 400 }}>
            <div className="note-inner" style={{ height: 300 }}>
              <div ref={ref} className="note-cm" />
            </div>
          </div>
        </div>
      ))}
      <div style={{ display: "grid", gap: 6 }}>
        <span className="design-note">At rest, with Kai still writing</span>
        <div className="frame-card" style={{ width: 300 }}>
          <div className="note-inner" style={{ height: 300 }}>
            <div className="note-writers">
              <span className="note-writer" style={{ ["--peer" as string]: "var(--viz-3)" }}>
                Kai
              </span>
            </div>
            <div className="note-rendered" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** the live Slack mark in each of its states, on a section's header */
function SlackMarks() {
  const now = Date.now();
  const rows: Array<[SlackSectionState, string, string, string]> = [
    [{ channel: "C1", name: "design", state: "live", detail: "Slack sends what's posted here as it's posted", lastAt: now - 4 * 60_000, agents: { by: "Ada", at: now }, summaryBy: "Wren", summaryAt: now - 3 * 60_000 }, "#design", "7", "Live, and agents keep its summary: a breathing green dot, ✦ in violet"],
    [{ channel: "C2", name: "general", state: "polling", detail: "Read about every 40 s while someone has this board open", lastAt: now - 2 * 3600_000 }, "#general", "5", "Polling: a still amber dot; agents off"],
    [{ channel: "C3", name: "random", state: "waiting", detail: "The Slack app isn't in this channel. Press to have it join" }, "#random", "2", "Not in the channel: a hollow amber dot, and Join"],
    [{ channel: "C4", name: "launch", state: "offline", detail: "Slack isn't connected: run the Slack app (npm run slack)" }, "#launch", "2", "Offline: red, and the roll-over says why"],
  ];
  return (
    <div className="oncall-row">
      {rows.map(([st, name, count, label]) => (
        <div className="oncall-cell" key={name}>
          <div className="section-card oncall-static oncall-section" style={{ width: 300, height: 84 }}>
            <div className="section-header" style={{ height: 42 }}>
              <span className="section-name">{name}</span>
              <span className="section-coords">A1</span>
              <span className="section-count">{count}</span>
              <SlackMarkView st={st} viewer={false} />
            </div>
          </div>
          <div className="effect-label">{label}</div>
        </div>
      ))}
    </div>
  );
}

function Section({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section className="design-section">
      <div className="design-section-head">
        <h2>{title}</h2>
        <p>{note}</p>
      </div>
      {children}
    </section>
  );
}

function Swatch({ name }: { name: string }) {
  return (
    <div className="swatch">
      <div className="swatch-chip" style={{ background: `var(--color-${name})` }} />
      <code>--color-{name}</code>
    </div>
  );
}

/** The wire rules, drawn by the real router: a forward road, a road heading back round two cards, and the crossing between them. */
function WireDemo() {
  const cardA = { x: 20, y: 30, w: 70, h: 50 };
  const cardB = { x: 250, y: 120, w: 70, h: 50 };
  const cardC = { x: 150, y: 20, w: 70, h: 40 };
  const forward = route({ x: 90, y: 50 }, { x: 250, y: 140 }, { src: cardA, dst: cardB });
  const back = route({ x: 220, y: 40 }, { x: 20, y: 60 }, { src: cardC, dst: cardA, lane: 0 });
  const crossings = pipeCrossings([
    { id: "a-forward", points: forward },
    { id: "b-back", points: back },
  ]);
  const t = tunnelGeometry(forward, crossings.get("a-forward") ?? [], 13);
  return (
    <svg viewBox="0 0 340 200" width="100%" height="200" className="wire-demo">
      {[cardA, cardB, cardC].map((r, i) => (
        <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} rx={6} className="wire-demo-card" />
      ))}
      <defs>
        <mask id="demo-tun" maskUnits="userSpaceOnUse" x={0} y={0} width={340} height={200}>
          <rect x={0} y={0} width={340} height={200} fill="white" />
          <path d={t.cut} fill="black" />
        </mask>
      </defs>
      <g className="pipe is-live is-under" style={{ ["--wire-tone" as string]: "var(--viz-2)", ["--pipe-opacity" as string]: 1 }}>
        <path className="pipe-trace" d={polyline(forward)} />
        <g mask="url(#demo-tun)">
          <path className="pipe-lane" d={polyline(forward)} />
          <path className="pipe-wire" d={polyline(forward)} />
          <path className="pipe-pulse" d={polyline(forward)} />
        </g>
        <path className="pipe-terminal" d={t.terminals} />
      </g>
      <g className="pipe is-live" style={{ ["--wire-tone" as string]: "var(--color-pulse)", ["--pipe-opacity" as string]: 1 }}>
        <path className="pipe-lane" d={polyline(back)} />
        <path className="pipe-wire" d={polyline(back)} />
        <path className="pipe-pulse" d={polyline(back)} />
      </g>
    </svg>
  );
}

/** Three app sections and the roads between them, by the real side choice and router. */
function AppSectionsDemo() {
  const A = { x: 10, y: 14, w: 110, h: 70 };
  const B = { x: 130, y: 14, w: 110, h: 70 };
  // ends at 164, clear of the caption along the card's foot (as the Wires demo's cards do)
  const C = { x: 200, y: 104, w: 130, h: 60 };
  const land = (r: typeof A, s: Side, at: number) =>
    s === "right" ? { x: r.x + r.w, y: at } : s === "left" ? { x: r.x, y: at } : s === "bottom" ? { x: at, y: r.y + r.h } : { x: at, y: r.y };
  const sab = sideToward(A, B, "right");
  const sba = sideToward(B, A, "left");
  const sac = sideToward(A, C, "right");
  const sca = sideToward(C, A, "left");
  const ab = routeSides(land(A, sab, 50), sab, land(B, sba, 50), sba, { src: A, dst: B });
  const acFrom = land(A, sac, sac === "bottom" ? 60 : 64);
  const acTo = land(C, sca, sca === "top" ? 290 : 134);
  const ac = routeSides(acFrom, sac, acTo, sca, { src: A, dst: C, obstacles: [B] });
  return (
    <svg viewBox="0 0 340 200" width="100%" height="200" className="wire-demo">
      {[A, B, C].map((r, i) => (
        <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} rx={8} className="wire-demo-card" />
      ))}
      {[ab, ac].map((pts, i) => (
        <g key={i} className="pipe is-live" style={{ ["--wire-tone" as string]: i ? "var(--viz-3)" : "var(--color-pulse)", ["--pipe-opacity" as string]: 1 }}>
          <path className="pipe-lane" d={polyline(pts)} />
          <path className="pipe-wire" d={polyline(pts)} />
          <path className="pipe-pulse" d={polyline(pts)} />
        </g>
      ))}
    </svg>
  );
}

const DEMO_POSTS: ReleasePost[] = [
  { version: "0.3.0", date: "2026-11-09", title: "The plan syncs with GitHub, and the board says what it means", body: `0.3.0 is a polish release.

## The plan, synced with GitHub

- **Sync with GitHub.** It reads every issue first, then sends only what changed here.
- **New card.** A bug, a plan, or something that waits on a person.

## Fixed

- **Wires keep to their edge** at both ends.` },
  { version: "0.2.0", date: "2026-11-08", title: "The crew you can see, sections that fit, and Foundation on Windows", body: "The first release that runs as a desktop app on Windows." },
];

/** The plan board with a small sample plan, moving locally. */
function PlanBoardDemo() {
  const [plan, setPlan] = useState<Plan>(() => ({
    about: "",
    repo: "joshleong/Foundation",
    syncedAt: "2026-11-07T22:00:00.000Z",
    columns: [
      { id: "needs-you", name: "Needs you", hint: "Waits on a person" },
      { id: "next", name: "Next", hint: "Picked up in this order" },
      { id: "doing", name: "Doing", hint: "Someone is on it" },
      { id: "done", name: "Done", hint: "Ran and was checked" },
    ],
    milestones: [
      { id: "crew", name: "The crew", about: "" },
      { id: "polish", name: "Polish", about: "" },
    ],
    cards: [
      { id: "sign-in", title: "Sign Claude Code back in", kind: "hookup", milestone: "crew", area: "agent", status: "needs-you", body: "Run `claude` once and sign in.", issue: 12 },
      { id: "gap", title: "The + buttons in the gaps catch double-clicks", kind: "bug", milestone: "polish", area: "sections", status: "next", body: "Make adding a deliberate press.", issue: 31 },
      { id: "stop", title: "A crew-wide stop", kind: "plan", milestone: "crew", area: "crew", status: "doing", body: "Stop all of yours at once.", issue: 27, moved: { by: "Ada", at: 0, from: "next" } },
      { id: "fit", title: "Sections fit instead of scrolling", kind: "plan", milestone: "polish", area: "sections", status: "done", body: "Expand opens one as its own grid.", issue: 4 },
      { id: "blink", title: "Wire landings blink on undo", kind: "bug", milestone: "polish", area: "wires", status: "next", body: "Made here; the next sync makes it an issue.", issue: null },
    ],
  }));
  const [sync, setSync] = useState<SyncState>({ busy: false });
  // Sync with GitHub, played locally: a moment's work, then the marks clear and the new card gets a number
  const onSync = () => {
    setSync({ busy: true });
    window.setTimeout(() => {
      let moved = 0;
      let created = 0;
      setPlan((p) => ({
        ...p,
        syncedAt: new Date().toISOString(),
        cards: p.cards.map((c) => {
          if (c.moved) moved++;
          if (!c.issue) created++;
          return { ...c, moved: null, issue: c.issue ?? 40 + created };
        }),
      }));
      setSync({ busy: false, said: syncSentence({ moved, created }) });
    }, 1200);
  };
  const onCreate = async (input: NewCardInput) => {
    const card = { id: `demo-${Date.now()}`, title: input.title, kind: input.kind, milestone: input.milestone, area: input.area, status: input.kind === "hookup" ? "needs-you" : "next", body: input.body ?? "", issue: null };
    setPlan((p) => ({ ...p, cards: [...p.cards, card] }));
    return card;
  };
  return (
    <div className="kb-demo">
      <PlanBoard plan={plan} source="server" canMove height={460} sync={sync} onSync={onSync} onCreate={onCreate} onMove={(id, status) => setPlan((p) => ({ ...p, cards: p.cards.map((c) => (c.id === id ? { ...c, status, moved: c.moved ?? (c.status === status ? null : { by: "Ada", at: Date.now(), from: c.status }) } : c)) }))} />
    </div>
  );
}

/** a page opened from a machine's port while the machine isn't running (the specimen of LiveFrame's MachineHold) */
function HeldPageDemo(p: { width: number; word: string; tone: "ok" | "warn" | "bad" | "idle"; live?: boolean; kind?: string; title: string; reason: string; start?: boolean; show?: boolean; viewer?: boolean }) {
  return (
    <div className="frame-card live-specimen" style={{ width: p.width, height: 320 }}>
      <div className="live-frame">
        <div className="frame-poster is-held">
          <div className="frame-poster-name">web-box:80</div>
          <div className="frame-poster-domain">127.0.0.1:49731</div>
          <div className="frame-poster-text">Port 80 of the machine web-box</div>
          <div className={`machine-hold is-${p.kind ?? "stopped"}`}>
            <span className={`machine-state is-${p.tone}`}>
              <span className={`f-dot${p.tone === "idle" ? "" : ` is-${p.tone}`}${p.live ? " is-live" : ""}`} />
              {p.word}
            </span>
            <div className="machine-hold-title">{p.title}</div>
            <div className="machine-hold-reason">{p.reason}</div>
            {(p.start || p.show) && (
              <div className="machine-hold-actions">
                {p.start && <span className="f-pill is-accent">Start it</span>}
                {p.show && <span className="f-pill">Show the machine</span>}
              </div>
            )}
            {p.viewer && <div className="machine-hold-note">View only: someone who can edit this board starts it.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

const UPDATE_NOTES = ["## Foundation 0.3.0", "- Desktop updates: this card", "- A new icon: four panels on a grid", "- Signed installers, checked before they run"].join("\n");
const UPDATE_PHASES: Array<{ phase: UpdatePhase; width: number; layout?: "floating" | "inline"; extra?: Record<string, unknown> }> = [
  { phase: "available", width: 400 },
  { phase: "available", width: 260 },
  { phase: "downloading", width: 400, extra: { received: 4.2 * 1048576, total: 9.6 * 1048576 } },
  { phase: "downloading", width: 260 },
  { phase: "installing", width: 400 },
  { phase: "failed", width: 400, extra: { message: "The download's signature didn't match Foundation's key, so nothing was installed." } },
  { phase: "updated", width: 560 },
  { phase: "checking", width: 400, layout: "inline" },
  { phase: "current", width: 400, layout: "inline" },
  { phase: "unreachable", width: 400, layout: "inline" },
  { phase: "off", width: 400, layout: "inline", extra: { message: "This is a development build (tauri dev): pull main to update it." } },
  // an update the server needs (FOUNDATION_MIN_CLIENT): no Later, no Skip, no close
  { phase: "available", width: 400, extra: { required: "0.3.0", onLater: undefined, onSkip: undefined } },
  { phase: "current", width: 400, extra: { required: "0.3.0", version: "0.2.0" } },
  { phase: "off", width: 400, extra: { required: "0.3.0", message: "This page is Foundation 0.2.0, and its server is 0.3.0. Reload to get the server's own page.", onReload: () => {} } },
];

function UpdateDemo() {
  const noop = () => {};
  return (
    <div className="update-demo">
      {UPDATE_PHASES.map((d, i) => (
        <div key={i} style={{ width: d.width }}>
          <div className="f-eyebrow update-demo-label">
            {d.phase} · {d.width} px{d.layout === "inline" ? " · inline" : ""}
          </div>
          <UpdateCard
            phase={d.phase}
            layout={d.layout ?? "floating"}
            version={d.phase === "current" ? "0.3.0" : "0.3.0"}
            current="0.2.0"
            date="2026-11-09T08:00:00Z"
            notes={UPDATE_NOTES}
            onUpdate={noop}
            onLater={noop}
            onSkip={noop}
            onCheck={noop}
            onClose={noop}
            {...d.extra}
          />
        </div>
      ))}
    </div>
  );
}

const SWITCH_BASE: ServerSwitchViewProps = {
  open: true,
  still: true,
  current: "http://localhost:4410",
  reach: "up",
  desktop: true,
  local: "running",
  localListening: true,
  localOurs: true,
  kind: "checkout",
  builtIn: true,
  runningKind: "checkout",
  runningFolder: FOLDER_DEFAULT,
  folder: FOLDER_DEFAULT,
  remote: "https://server.formresearch.ai",
};
const SWITCH_STATES: Array<{ label: string; props: Partial<ServerSwitchViewProps> }> = [
  { label: "Closed · connected", props: { open: false } },
  { label: "Closed · not running", props: { open: false, reach: "down", local: "stopped", localListening: false, localOurs: false } },
  { label: "This computer, started from a checkout", props: {} },
  { label: "This computer, the built-in server", props: { kind: "builtIn", runningKind: "builtIn", runningFolder: "C:\\Users\\you\\AppData\\Roaming\\co.normallab.foundation" } },
  { label: "Nothing running: the built-in server", props: { reach: "down", local: "stopped", localListening: false, localOurs: false, kind: "builtIn" } },
  { label: "Nothing running: from a checkout", props: { reach: "down", local: "stopped", localListening: false, localOurs: false } },
  { label: "Starting", props: { reach: "down", local: "starting", localListening: false, localOurs: false, kind: "builtIn" } },
  {
    label: "It didn't start",
    props: {
      reach: "down",
      local: "failed",
      localListening: false,
      localOurs: false,
      message: "Foundation's server needs Node 22.16 or newer (its search needs SQLite's FTS5), and this computer has v22.13.1. Install it with winget install OpenJS.NodeJS.LTS, or start the built-in server instead.",
    },
  },
  { label: "On a remote server; this computer's is running too", props: { current: "https://server.formresearch.ai", localOurs: false } },
  { label: "A remote address that isn't one", props: { current: "https://server.formresearch.ai", reach: "down", local: "stopped", localListening: false, localOurs: false, remote: "ftp://files", remoteError: "A server's address starts with https:// or http://." } },
  { label: "In a browser on another site's server (can't start one)", props: { desktop: false, builtIn: false, current: "https://server.formresearch.ai", local: "stopped", localListening: false, localOurs: false } },
];

function ServerSwitchDemo() {
  return (
    <div className="update-demo server-switch-demo">
      {SWITCH_STATES.map((d, i) => (
        <div key={i} style={{ width: 360 }}>
          <div className="f-eyebrow update-demo-label">{d.label}</div>
          <ServerSwitchView {...SWITCH_BASE} {...d.props} />
        </div>
      ))}
    </div>
  );
}

const MB = 1024 * 1024;
const TRAY_SENDING: UploadItem[] = [
  { id: 1, name: "front.png", path: "Renders/front.png", size: 2.4 * MB, loaded: 2.4 * MB, state: "done" },
  { id: 2, name: "side.png", path: "Renders/side.png", size: 2.1 * MB, loaded: 1.3 * MB, state: "sending" },
  { id: 3, name: "shroud-rev-c.step", path: "Renders/CAD/shroud-rev-c.step", size: 18 * MB, loaded: 4 * MB, state: "sending" },
  { id: 4, name: "test-log.xlsx", path: "Renders/test-log.xlsx", size: 220 * 1024, loaded: 0, state: "waiting" },
  { id: 5, name: "intake-spec.pdf", path: "Renders/intake-spec.pdf", size: 1.1 * MB, loaded: 0, state: "waiting" },
];
const TRAY_DONE: UploadItem[] = TRAY_SENDING.map((it) => ({ ...it, loaded: it.size, state: "done" }));
const TRAY_FAILED: UploadItem[] = [
  ...TRAY_DONE.slice(0, 3),
  { id: 6, name: "flythrough.mov", size: 840 * MB, loaded: 312 * MB, state: "failed", error: "network error" },
];

function UploadsDemo() {
  return (
    <div className="oncall-row uploads-demo">
      <div className="oncall-cell">
        <TrayView items={TRAY_SENDING} folded={false} demo />
        <div className="effect-label">A folder on its way: three at a time, the rest waiting; each row names its folder in dim</div>
      </div>
      <div className="oncall-cell">
        <TrayView items={TRAY_SENDING} folded demo />
        <TrayView items={TRAY_DONE} folded demo />
        <div className="effect-label">Folded to its head while it works; all landed (it leaves by itself 2.6 s later)</div>
      </div>
      <div className="oncall-cell">
        <TrayView items={TRAY_FAILED} folded={false} demo />
        <div className="effect-label">Something didn't make it: the tray stays, red, with Retry; its card waits for it</div>
      </div>
      <div className="oncall-cell" style={{ width: 420 }}>
        <div className="search-results">
          <div className="search-row">
            <span className="search-row-glyph">▤</span>
            <span className="search-row-main">
              <span className="search-row-title">intake-spec.pdf</span>
              <span className="search-row-snip" dangerouslySetInnerHTML={{ __html: snippetHtml("Page two of the assembly notes for the rear housing and the clamp bands: the «Osterlund» fan shroud is printed in PETG") }} />
            </span>
            <span className="search-row-src">file</span>
          </div>
          <div className="search-row">
            <span className="search-row-glyph">▤</span>
            <span className="search-row-main">
              <span className="search-row-title">bom.xlsx</span>
              <span className="search-row-snip" dangerouslySetInnerHTML={{ __html: snippetHtml("BOM Part Qty Ventura gasket 12 «03304»-10027") }} />
            </span>
            <span className="search-row-src">file</span>
          </div>
        </div>
        <div className="cmd f-glass design-cmd-specimen">
          <div className="cmd-list">
            <div className="cmd-row is-hit is-sel">
              <span className="cmd-src src-file">File</span>
              <span className="cmd-row-label">bracket.docx</span>
              <span className="cmd-row-hint" dangerouslySetInnerHTML={{ __html: snippetHtml("«Zephyrine» bracket assembly Torque the M6 bolts to 9 Nm then check & sign.") }} />
            </div>
          </div>
        </div>
        <div className="effect-label">What matched, inside the document: the search pane ({keys("mod+F")}) and {keys("mod+K")}, the match in blue and brought forward on its line</div>
      </div>
    </div>
  );
}

// ---------- out of search, into the hand ----------

const DEMO_HITS: SearchHit[] = [
  { source: "file", id: "demo:mark", title: "foundation-mark.svg", snippet: "image/svg+xml", thumb: "/foundation.svg", score: 1 },
  { source: "file", id: "demo:bracket", title: "bracket-rev-c.step", snippet: "STEP · «bracket», 6061-T6", score: 1 },
  { source: "flowform", id: "demo:ff", title: "Kapaa factory walk.mp4", snippet: "Form Industries · 48.2 MB", flowform: { fileId: "demo", kind: "video", origin: "flowform" }, score: 1 },
  { source: "slack", id: "demo:slack", title: "#shop · Kai", snippet: "the «bracket» drawings are in the thread", url: "https://example.com", score: 1 },
];

/** the held card, drawn still: what lib/pickup.ts builds while a result is in the hand */
function HeldStill({ hits, state, count }: { hits: SearchHit[]; state: string; count?: number }) {
  return (
    <div className={`held design-held ${state}`} style={{ height: hits[0].thumb ? 164 : 96 }}>
      {hits
        .map((h, i) => {
          const f = fan(i);
          const picture = Boolean(h.thumb);
          return (
            <div
              key={h.id}
              className={`held-card${picture ? " is-picture" : ""}`}
              style={{ width: picture ? 176 : 232, height: picture ? 132 : 56, zIndex: 3 - i, transform: `translate3d(${f.dx + 12}px, ${f.dy + 12}px, 0)`, ["--fan" as string]: `${f.rotate}deg` }}
            >
              <div className="held-face">
                {picture ? (
                  <>
                    <HitPicture hit={h} />
                    <span className="held-name">{h.title}</span>
                  </>
                ) : (
                  <>
                    <span className="search-row-glyph">{glyphOf(h)}</span>
                    <span className="held-main">
                      <span className="held-title">{h.title}</span>
                      <span className="held-src">{h.flowform?.origin ?? h.source}</span>
                    </span>
                  </>
                )}
                <i className="held-wait" />
              </div>
              {i === 0 && count ? <span className="held-count">{count}</span> : null}
            </div>
          );
        })
        .reverse()}
    </div>
  );
}

function PickupDemo() {
  return (
    <div className="design-pickup">
      <div className="design-pickup-pane">
        <div className="search-tiles">
          <Draggable hit={DEMO_HITS[0]} className="search-tile" onPress={() => {}}>
            <HitPicture hit={DEMO_HITS[0]} />
            <span className="search-tile-name">{DEMO_HITS[0].title}</span>
          </Draggable>
        </div>
        {DEMO_HITS.slice(1).map((h) => (
          <Draggable key={h.id} hit={h} className="search-row" onPress={() => {}}>
            <span className="search-row-glyph">{glyphOf(h)}</span>
            <span className="search-row-main">
              <span className="search-row-title">{h.title}</span>
              <span className="search-row-snip">{h.snippet.replace(/[«»]/g, "")}</span>
            </span>
            <span className="search-row-src">{h.flowform?.origin ?? h.source}</span>
          </Draggable>
        ))}
        <Clipboard />
      </div>
      <div className="design-pickup-states">
        {(
          [
            ["Lifted, nowhere to land yet", "is-lifted", [DEMO_HITS[1]], 0],
            ["Over the grid", "is-lifted is-over", [DEMO_HITS[0]], 0],
            ["A stack of three", "is-lifted is-over", [DEMO_HITS[1], DEMO_HITS[2], DEMO_HITS[3]], 3],
            ["Put down, waiting for its file", "is-waiting", [DEMO_HITS[2]], 0],
          ] as Array<[string, string, SearchHit[], number]>
        ).map(([label, state, hits, count]) => (
          <figure key={label} className="design-pickup-state">
            <HeldStill hits={hits} state={state} count={count || undefined} />
            <figcaption>{label}</figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}
