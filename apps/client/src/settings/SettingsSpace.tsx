/**
 * Settings, as a place inside Foundation (2026-11-15): the top bar and the side menu stay, and the
 * open paper holds Settings' tabs. The first tab is the settings themselves:
 *
 *  - **General** — how it looks (day, night, the system's), what the app opens on, what agents may do
 *    on this computer's machines, updates, and you.
 *  - **Agents** — the agents this server can call on: Claude Code and Codex over MCP, the server's own
 *    runtimes, and this computer's agents (Claude, Codex, Kimi, DeepSeek… cloud or local).
 *  - **Avatars** — the characters made for the council, and which one each connected agent wears.
 *  - **Plan** and **Design language** — these two are grids: Foundation's own boards (the plan as a
 *    kanban card filling one section; the design language a section per chapter). On those tabs only
 *    the strip is drawn here; the grid underneath is the shell's canvas.
 *  - **Services**, **Places**, **Renderer**, **Releases** — as before.
 */

import { useEffect, useState } from "react";
import type { UserInfo } from "@foundation/protocol";
import { chooseNight, nightChoice, onNight } from "@foundation/ui";
import { api, logout } from "../lib/api";
import { TOP_BAR, floorInsets, toast, useUi } from "../state/ui";
import { SETTINGS_TABS, goSettings, setStartsOn, startsOn, type Place, type SettingsTab } from "../lib/place";
import { PlacesTab } from "./PlacesTab";
import { POSTS, ReleasesTab, ServicesTab } from "./SettingsPage";
import { RendererTab } from "../rune/RendererTab";
import { UpdatesSection } from "../update/UpdateCard";
import { T3Block } from "../shell/AgentsPane";
import { copyMcpCommand } from "../shell/CommandBar";
import { FLOORPLAN_URL } from "../shell/SidePane";
import { initials } from "../shell/Presence";
import { Still } from "../characters/Avatar";
import { chooseAvatar, readyCharacters, useRoster, type RosterCharacter } from "../characters/roster";
import { ProviderMark, providerOf, type Provider } from "../characters/providers";
import { openCharacterStudio } from "../lib/characterStudio";
import "./settings-space.css";

const LABEL: Record<SettingsTab, string> = { general: "General", agents: "Agents", avatars: "Avatars", plan: "Plan", design: "Design language", services: "Services", places: "Places", renderer: "Renderer", releases: "Releases" };

/** the tabs that are grids of Foundation's own (the shell opens the grid; see systemgrids.ts on the server) */
export const SETTINGS_GRIDS: Partial<Record<SettingsTab, "plan" | "design">> = { plan: "plan", design: "design" };

export function SettingsSpace({ place, user }: { place: Extract<Place, { kind: "settings" }>; user: UserInfo }) {
  const ui = useUi();
  const insets = floorInsets(ui);
  const grid = SETTINGS_GRIDS[place.tab];
  return (
    <div className={`settings-space${grid ? " is-grid" : ""}`} style={{ left: insets.left, right: insets.right, top: TOP_BAR }} data-settings-tab={place.tab}>
      <header className="settings-strip">
        <h1>Settings</h1>
        <nav className="settings-tabs" aria-label="Settings">
          {SETTINGS_TABS.map((t) => (
            <a key={t} href={`#/settings/${t}`} className={`settings-tab${place.tab === t ? " is-current" : ""}`} aria-current={place.tab === t ? "page" : undefined}>
              {LABEL[t]}
            </a>
          ))}
        </nav>
        {place.tab === "plan" && (
          <a className="settings-strip-link" href={FLOORPLAN_URL} target="_blank" rel="noopener">
            App floorplan ↗
          </a>
        )}
        {place.tab === "design" && (
          <a className="settings-strip-link" href="#/design">
            As one page ↗
          </a>
        )}
      </header>
      {!grid && (
        <div className="settings-body">
          {place.tab === "general" ? (
            <GeneralTab user={user} />
          ) : place.tab === "agents" ? (
            <AgentsTab user={user} />
          ) : place.tab === "avatars" ? (
            <AvatarsTab user={user} />
          ) : place.tab === "releases" ? (
            <ReleasesTab posts={POSTS} route={`#/settings/releases${place.rest ? `/${place.rest}` : ""}`} />
          ) : place.tab === "places" ? (
            <PlacesTab />
          ) : place.tab === "renderer" ? (
            <RendererTab />
          ) : (
            <ServicesTab />
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- parts

function Group({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="set-group">
      <div className="set-group-head">
        <h2>{title}</h2>
        {note && <p>{note}</p>}
      </div>
      <div className="set-rows">{children}</div>
    </section>
  );
}

function Row({ name, detail, children }: { name: string; detail?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-row-text">
        <span className="set-row-name">{name}</span>
        {detail && <span className="set-row-detail">{detail}</span>}
      </div>
      {children && <div className="set-row-act">{children}</div>}
    </div>
  );
}

/** a choice among a few: the settings tabs' own segmented pill */
function Seg<T extends string>({ value, options, onChange, label, disabled }: { value: T; options: Array<{ id: T; label: string }>; onChange(v: T): void; label: string; disabled?: boolean }) {
  return (
    <div className="set-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={value === o.id} disabled={disabled} className={`set-seg-btn${value === o.id ? " is-on" : ""}`} onClick={() => value !== o.id && onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- General

interface Prefs {
  computer_use: "ask" | "never";
}

function GeneralTab({ user }: { user: UserInfo }) {
  const ui = useUi();
  const [scheme, setScheme] = useState(nightChoice);
  const [start, setStart] = useState(startsOn);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  // the orb in the top bar changes the scheme too
  useEffect(() => onNight(() => setScheme(nightChoice())), []);
  useEffect(() => {
    api<{ prefs: Prefs }>("/api/prefs").then((r) => setPrefs(r.prefs), () => {});
  }, []);
  const savePref = async (patch: Partial<Prefs>) => {
    const before = prefs;
    setPrefs((p) => (p ? { ...p, ...patch } : p));
    try {
      setPrefs((await api<{ prefs: Prefs }>("/api/prefs", { method: "POST", json: patch })).prefs);
    } catch (e) {
      setPrefs(before);
      toast((e as Error).message, "bad");
    }
  };
  return (
    <div className="set-page">
      <Group title="Appearance">
        <Row name="Colour scheme" detail="Day is paper and ink; night is greys and white. The orb in the top bar switches too.">
          <Seg
            label="Colour scheme"
            value={scheme}
            options={[
              { id: "day", label: "Day" },
              { id: "night", label: "Night" },
              { id: "system", label: "Follow the system" },
            ]}
            onChange={(v) => {
              chooseNight(v);
              setScheme(v);
            }}
          />
        </Row>
      </Group>

      <Group title="When Foundation opens" note="Kept on this device.">
        <Row name="Open on" detail="Today is the Shiba, your todos and the company's apps.">
          <Seg
            label="Open on"
            value={start}
            options={[
              { id: "today", label: "Today" },
              { id: "grid", label: "The grid I had open" },
            ]}
            onChange={(v) => {
              setStartsOn(v);
              setStart(v);
            }}
          />
        </Row>
        <Row name="Side menu" detail={ui.pane ? "Open. It stays the way you leave it; the top bar's first button folds it." : "Folded. It stays the way you leave it; the top bar's first button opens it."} />
      </Group>

      <Group title="Agents on this computer" note="What agents may do beyond writing a grid. Nothing that runs code or spends money starts without a person.">
        <Row
          name="Using a machine's desktop"
          detail={
            prefs?.computer_use === "never"
              ? "Off for you: nobody can let an agent drive a machine's screen, keyboard and mouse on your behalf."
              : "An agent can see and drive a machine's desktop only after you press Let agents use this desktop on that machine's card. You can take it back there."
          }
        >
          <Seg
            label="Using a machine's desktop"
            value={prefs?.computer_use ?? "ask"}
            disabled={!prefs || user.role === "viewer"}
            options={[
              { id: "ask", label: "Ask me on each machine" },
              { id: "never", label: "Never" },
            ]}
            onChange={(v) => void savePref({ computer_use: v })}
          />
        </Row>
        <Row name="Starting a machine" detail="Always a person's press, from a browser. An agent can only propose one." />
        <Row name="Running a command in a machine" detail="Each command an agent wants to run waits on the machine's card for your Run or Decline." />
        <Row name="Folders agents may read" detail="Only the folders an admin approved.">
          <button className="f-pill" onClick={() => goSettings("places")}>
            Places
          </button>
        </Row>
      </Group>

      <section className="set-group">
        <UpdatesSection />
      </section>

      <Group title="You">
        <Row
          name={user.name}
          detail={
            <>
              {user.email} · {user.role === "admin" ? "Admin" : user.role === "viewer" ? "View only" : "Member"}
            </>
          }
        >
          <span className="me-avatar" style={{ background: user.color }}>
            {initials(user.name)}
          </span>
          <button
            className="f-pill"
            onClick={async () => {
              await logout();
              window.location.reload();
            }}
          >
            Sign out
          </button>
        </Row>
      </Group>
    </div>
  );
}

// ---------------------------------------------------------------- Agents

interface Integrations {
  agent: { subscription: boolean; subscriptionNote?: string | null; api: boolean; model: string };
}

function AgentsTab({ user }: { user: UserInfo }) {
  const [s, setS] = useState<Integrations | null>(null);
  useEffect(() => {
    api<Integrations>("/api/integrations").then(setS, () => {});
  }, []);
  return (
    <div className="set-page">
      <Group title="Your own agent, over MCP" note="An agent you run yourself (Claude Code, Codex) joins a grid with its own cursor and the grid's tools.">
        <Row name="Claude Code or Codex" detail="Copies the command that adds this server to it. Run it in a terminal, then ask it about the grid.">
          <button className="f-pill" onClick={() => void copyMcpCommand()}>
            Copy the command
          </button>
        </Row>
      </Group>

      <Group title="The server's own agent" note="What ✦ Ask, the voice sheet and a section's Ask call on.">
        <Row name="On your Claude subscription" detail={!s ? "Asking the server…" : s.agent.subscription ? "Claude Code is installed on the server's computer." : (s.agent.subscriptionNote ?? "Claude Code isn't on the server's PATH. Install it and sign in (`claude`).")}>
          <span className={`f-dot ${s?.agent.subscription ? "is-ok" : "is-warn"}`} />
        </Row>
        <Row name="On API credits" detail={!s ? "Asking the server…" : s.agent.api ? `On credits, ${s.agent.model}.` : "No API key. Set ANTHROPIC_API_KEY on the server."}>
          <span className={`f-dot ${s?.agent.api ? "is-ok" : "is-warn"}`} />
        </Row>
      </Group>

      <section className="set-group">
        <div className="set-group-head">
          <h2>This computer's agents</h2>
          <p>Claude, Codex and the rest, each on its own sign-in; Kimi and DeepSeek on a key or a local model. Assign any of them to a section from that section's council.</p>
        </div>
        <div className="set-t3">
          <T3Block viewer={user.role === "viewer"} admin={user.role === "admin"} section={null} />
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- Avatars

interface T3HostLite {
  agents?: Array<{ id: string; name: string; driver: string; where: "cloud" | "local"; added?: { preset: string } }>;
}

function AvatarsTab({ user }: { user: UserInfo }) {
  const roster = useRoster();
  const ready = readyCharacters(roster);
  const [host, setHost] = useState<T3HostLite | null>(null);
  useEffect(() => {
    api<T3HostLite>("/api/t3host").then(setHost, () => setHost({}));
  }, []);
  const viewer = user.role === "viewer";
  // every agent that has a name of its own: this computer's, then any name someone already dressed
  const agents = [
    { name: "Claude", provider: "claude" as Provider, where: "The server's own agent, and any crew it sends" },
    ...(host?.agents ?? []).filter((a) => a.name !== "Claude").map((a) => ({ name: a.name, provider: providerOf(a), where: a.where === "local" ? "On this computer" : "In the cloud" })),
  ];
  for (const n of Object.keys(roster.avatars)) if (!agents.some((a) => a.name === n)) agents.push({ name: n, provider: providerOf({ name: n }), where: "Chosen on a council" });
  const sets = [...new Set(ready.map((c) => c.set))];
  return (
    <div className="set-page">
      <Group title="Who wears what" note="An agent keeps its character on every grid. Without a choice it takes one by its name, and no two agents in a council share one while there are enough.">
        {agents.map((a) => {
          const worn = ready.find((c) => c.id === roster.avatars[a.name]);
          return (
            <div key={a.name} className="set-row avatar-assign" data-avatar-agent={a.name}>
              <span className="avatar-face">
                {worn ? <Still character={worn} role={worn.form === "mesh" ? "portrait" : "thumb"} /> : <span className="avatar-face-none">✦</span>}
                <ProviderMark provider={a.provider} />
              </span>
              <div className="set-row-text">
                <span className="set-row-name">{a.name}</span>
                <span className="set-row-detail">{a.where}</span>
              </div>
              <select
                className="set-pick"
                aria-label={`The character ${a.name} wears`}
                disabled={viewer || !roster.loaded}
                value={worn?.id ?? ""}
                onChange={(e) => void chooseAvatar(a.name, e.target.value || null).catch((err: Error) => toast(err.message, "bad"))}
              >
                <option value="">Chosen by its name</option>
                {sets.map((s) => (
                  <optgroup key={s} label={s}>
                    {ready.filter((c) => c.set === s).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
          );
        })}
      </Group>

      <section className="set-group">
        <div className="set-group-head">
          <h2>
            The characters <span className="set-count">{ready.length}</span>
          </h2>
          <p>Made on the Character studio grid: inspiration, a sheet, then a mesh avatar or a 3D model.</p>
          <button className="f-pill" onClick={() => void openCharacterStudio()}>
            Open the Character studio
          </button>
        </div>
        {roster.loaded && ready.length === 0 && <p className="set-empty">No characters yet. Open the Character studio: the starter set walks on by itself.</p>}
        <div className="avatar-gallery">
          {ready.map((c) => (
            <CharacterTile key={c.id} c={c} wornBy={Object.entries(roster.avatars).filter(([, id]) => id === c.id).map(([n]) => n)} />
          ))}
        </div>
      </section>
    </div>
  );
}

function CharacterTile({ c, wornBy }: { c: RosterCharacter; wornBy: string[] }) {
  return (
    <figure className="avatar-tile" data-avatar-character={c.name}>
      <div className="avatar-tile-view">
        <Still character={c} role={c.form === "mesh" ? "portrait" : "thumb"} />
      </div>
      <figcaption>
        <b>{c.name}</b>
        <span>
          {c.set} · {c.form === "mesh" ? "mesh avatar" : "3D"}
        </span>
        {wornBy.length > 0 && <span className="avatar-worn">worn by {wornBy.join(", ")}</span>}
      </figcaption>
    </figure>
  );
}
