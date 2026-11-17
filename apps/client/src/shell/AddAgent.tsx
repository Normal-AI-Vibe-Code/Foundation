/**
 * Adding an agent to a council, in the agents panel on the right: who it is, getting it connected,
 * the character it wears, and where it sits. Four steps on one sheet, each open only when the one
 * before is settled, so a person is led through it:
 *
 *  1. **Who.** Claude, ChatGPT, Gemini, Kimi, DeepSeek, or a model on this computer. The list is
 *     already there when the panel opens (lib/agentsAvailable.ts keeps it), each saying how it stands.
 *  2. **Connect** (2026-11-17: "much more hand holding"). Every kind of agent has its *ways* of being
 *     connected, each a card: what it is in a line, then numbered steps that tick themselves off as
 *     they're done, with the button or the link each step needs right there. For Claude there are
 *     three: an API key (a link to the page that makes one, then the key), your Claude account
 *     through this computer's agents (start T3, sign in in T3, and its sessions keep working on
 *     Foundation), or Claude Code on this computer (signed in once in a terminal). The others get the
 *     same treatment: sign-in through T3 for ChatGPT and Gemini, a key or a local model for Kimi and
 *     DeepSeek.
 *  3. **Avatar.** The approved characters; one is chosen already (an abstract one nobody wears).
 *  4. **Add.** To the section or the grid the council is for. One of this computer's agents also gets
 *     its own session, named after it, opened in that section (it reads the grid once).
 */

import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { refreshAvailable, useAvailable } from "../lib/agentsAvailable";
import { GRID_PLACE, postAgent, usePosted, type AvailableAgent } from "../lib/posted";
import { councilOpen } from "../lib/councilOpen";
import { getState } from "../state/store";
import { setUi, toast, useUi } from "../state/ui";
import { activeBoard } from "../sync/board";
import { openExternal } from "../utils/media";
import { Still } from "../characters/Avatar";
import { ProviderMark, providerOf, type Provider } from "../characters/providers";
import { chooseAvatar, readyCharacters, useRoster, type RosterCharacter } from "../characters/roster";
import { T3AddForm, type T3Agent, type T3Local, type T3Preset } from "./AgentsPane";

export type WayId = "key" | "t3" | "own" | "local";

/** which of T3's own agents drives each kind, signed in through T3 */
const T3_DRIVER: Partial<Record<Provider, string>> = { claude: "claudeAgent", chatgpt: "codex", gemini: "antigravity" };

/** one way of connecting a kind of agent */
export interface Way {
  id: WayId;
  title: string;
  what: string;
}

interface Kind {
  id: Provider;
  label: string;
  what: string;
  /** the T3 preset a key or a local model is added as */
  preset?: string;
  /** its own program on this computer, and how that's signed in from a terminal */
  program?: string;
  signIn?: string;
  install?: string;
  /** where a person makes an API key */
  keyPage?: string;
  ways: Way[];
}

const T3_WAY = (who: string, account: string): Way => ({ id: "t3", title: `Sign in with your ${account} account`, what: `Through this computer's agents (T3). No key: it runs on your ${who} plan, and its sessions keep working on Foundation.` });
const KEY_WAY = (vendor: string): Way => ({ id: "key", title: "An API key", what: `Billed to your ${vendor} account as it's used. This computer's agents keep the key; Foundation never stores it.` });
const LOCAL_WAY: Way = { id: "local", title: "A model on this computer", what: "Run by a model server here (Ollama's address by default). No key, and nothing you ask leaves the computer." };

/** the kinds of agent there are to add, in the order offered, each with its ways of being connected */
export const KINDS: Kind[] = [
  {
    id: "claude",
    label: "Claude",
    what: "Anthropic's, through Claude Code",
    preset: "claude",
    program: "Claude Code",
    signIn: "claude",
    install: "npm install -g @anthropic-ai/claude-code",
    keyPage: "https://console.anthropic.com/settings/keys",
    ways: [KEY_WAY("Anthropic"), T3_WAY("Claude", "Claude"), { id: "own", title: "Claude Code on this computer", what: "The computer Foundation's server runs on, signed in once in a terminal. Your Claude subscription, no key. This is Foundation's own agent." }],
  },
  { id: "chatgpt", label: "ChatGPT", what: "OpenAI's, through Codex", program: "Codex", signIn: "codex login", install: "npm install -g @openai/codex", ways: [T3_WAY("ChatGPT", "ChatGPT")] },
  { id: "gemini", label: "Gemini", what: "Google's, through Antigravity", program: "Antigravity", signIn: "antigravity", ways: [T3_WAY("Google", "Google")] },
  { id: "kimi", label: "Kimi", what: "Moonshot's, on a key or a local model", preset: "kimi", keyPage: "https://platform.moonshot.ai/console/api-keys", ways: [KEY_WAY("Moonshot"), LOCAL_WAY] },
  { id: "deepseek", label: "DeepSeek", what: "DeepSeek's, on a key or a local model", preset: "deepseek", keyPage: "https://platform.deepseek.com/api_keys", ways: [KEY_WAY("DeepSeek"), LOCAL_WAY] },
  { id: "local", label: "A local model", what: "runs on this computer, nothing leaves it", preset: "kimi", ways: [LOCAL_WAY] },
];

/** the available agent that is this kind connected this way, if this server or this computer has one */
export function agentFor(kind: Kind, way: WayId, agents: AvailableAgent[]): AvailableAgent | undefined {
  const added = (w: "cloud" | "local") => agents.find((a) => a.key === `t3:${kind.preset}-${w}`);
  if (way === "own") return agents.find((a) => a.key === "claude");
  if (way === "key") return added("cloud");
  if (way === "local") return kind.id === "local" ? agents.find((a) => a.where === "local") : added("local");
  // signed in through T3: its own program's agent, not one added on a key
  return agents.find((a) => a.key.startsWith("t3:") && providerOf(a) === kind.id && !/-(cloud|local)$/.test(a.key));
}

/** the character a new agent gets when nobody picks: an abstract one no agent wears yet, else any free one, else the first */
export function defaultAvatar(ready: RosterCharacter[], worn: Record<string, string>): RosterCharacter | undefined {
  const taken = new Set(Object.values(worn));
  return ready.find((c) => c.set.toLowerCase() === "abstract" && !taken.has(c.id)) ?? ready.find((c) => !taken.has(c.id)) ?? ready.find((c) => c.set.toLowerCase() === "abstract") ?? ready[0];
}

/** a command to run in a terminal, with a press to copy it */
function Cmd({ text }: { text: string }) {
  return (
    <button type="button" className="add-cmd" data-tip="Copy" onClick={() => void navigator.clipboard?.writeText(text).then(() => toast("Copied", "ok"))}>
      <code>{text}</code>
      <span aria-hidden>⧉</span>
    </button>
  );
}

/** one numbered step of a way: ticked when it's done, dimmed until the one before is */
function WayStep({ n, done, wait, title, children }: { n: number; done: boolean; wait?: boolean; title: React.ReactNode; children?: React.ReactNode }) {
  return (
    <li className={`way-step${done ? " is-done" : wait ? " is-wait" : " is-now"}`} data-way-step={n} data-way-state={done ? "done" : wait ? "wait" : "now"}>
      <span className="way-step-n">{done ? "✓" : n}</span>
      <div className="way-step-body">
        <b>{title}</b>
        {!done && !wait && children}
      </div>
    </li>
  );
}

export function AddAgent({ onDone }: { onDone(): void }) {
  const ui = useUi();
  const { agents, t3, host } = useAvailable();
  const posted = usePosted();
  const roster = useRoster();
  const ready = readyCharacters(roster);
  const scope = councilOpen();
  const st = getState();
  const sectionId = scope?.kind === "section" ? scope.id : null;
  const place = sectionId ?? GRID_PLACE;
  const placeName = sectionId ? (st.allSections[sectionId]?.name ?? "this section") : "this grid";
  const here = new Set((posted[place] ?? []).map((p) => p.key));

  const [kind, setKind] = useState<Provider | null>(null);
  const [wayPick, setWay] = useState<WayId | null>(null);
  const [avatar, setAvatar] = useState<string | null>(null);
  const [session, setSession] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [presets, setPresets] = useState<Record<string, T3Preset>>({});
  const [local, setLocal] = useState<T3Local | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    void refreshAvailable();
    const t = setInterval(() => void refreshAvailable(), 4000);
    return () => clearInterval(t);
  }, []);

  const k = KINDS.find((x) => x.id === kind);
  // the way in use: the one picked, else one that's already connected, else the first offered
  const way: WayId | null = k ? (wayPick && k.ways.some((w) => w.id === wayPick) ? wayPick : (k.ways.find((w) => agentFor(k, w.id, agents)?.ready)?.id ?? k.ways[0].id)) : null;
  const found: AvailableAgent | undefined = useMemo(() => (k && way ? agentFor(k, way, agents) : undefined), [k, way, agents]);
  // T3's own agent for this kind, even one it has switched off (it isn't offered as available until it's on)
  const t3Agent: T3Agent | undefined = found?.key.startsWith("t3:") ? host?.agents.find((a) => `t3:${a.id}` === found.key) : k ? host?.agents.find((a) => a.driver === T3_DRIVER[k.id]) : undefined;
  const t3On = t3 === "running";
  const connected = !!found && found.ready;
  const picked = ready.find((c) => c.id === avatar) ?? defaultAvatar(ready, roster.avatars);
  const needsForm = !!k && (way === "key" || way === "local") && !found && t3On;

  useEffect(() => {
    if (!needsForm) return;
    void api<Record<string, T3Preset>>("/api/t3host/presets").then(setPresets).catch(() => {});
  }, [needsForm]);
  useEffect(() => {
    if (!needsForm || way !== "local" || !k?.preset) return;
    void api<T3Local>("/api/t3host/local")
      .then(setLocal)
      .catch(() => setLocal(null));
  }, [needsForm, way, k?.preset]);

  const said = (e: unknown) => toast((e as Error).message, "bad");
  const startT3 = () => {
    setBusy("t3");
    void api("/api/t3host/start", { method: "POST" })
      .then(() => refreshAvailable())
      .catch(said)
      .finally(() => setBusy(null));
  };
  // T3's page opens here, in the T3 tool on the right (2026-11-17), not in another browser
  const openT3 = () => setUi({ tool: "t3" });
  const enable = (id: string) => {
    setBusy("enable");
    void api(`/api/t3host/agents/${encodeURIComponent(id)}/enable`, { method: "POST" })
      .then(() => refreshAvailable())
      .catch(said)
      .finally(() => setBusy(null));
  };
  const add = async () => {
    if (!found) return;
    setBusy("add");
    try {
      await postAgent(place, found.key);
      if (picked) await chooseAvatar(found.name, picked.id).catch(() => {});
      let opened = "";
      if (session && found.key.startsWith("t3:")) {
        const board = activeBoard()?.boardId;
        const sec = sectionId ?? Object.values(getState().sections).find((s) => !s.parent)?.id;
        if (board && sec) {
          await api("/api/t3host/threads", { method: "POST", json: { board, section: sec, agent: found.key.slice(3), text: `You are ${found.name}, now on the council of ${placeName}. Read the grid, say in one line what you see here, and wait to be asked.` } })
            .then(() => (opened = ", with its own session"))
            .catch((e: Error) => toast(`${found.name} is added, but its session didn't open: ${e.message}`, "warn"));
        }
      }
      toast(`${found.name} is on the council of ${placeName}${opened}`, "agent");
      onDone();
    } catch (e) {
      said(e);
    } finally {
      setBusy(null);
    }
  };

  const viewer = ui.role === "viewer";
  if (viewer) return <p className="agents-empty">Viewers can't add agents to a council.</p>;
  const step = (n: number, title: string, state: "open" | "done" | "wait", summary: React.ReactNode, body: React.ReactNode) => (
    <section className={`add-step is-${state}`} data-add-step={n} data-add-state={state}>
      <header className="add-step-head">
        <span className="add-step-n">{state === "done" ? "✓" : n}</span>
        <b>{title}</b>
        {state !== "open" && <span className="add-step-sum">{summary}</span>}
      </header>
      {state !== "wait" && body}
    </section>
  );

  const startStep = (n: number) => (
    <WayStep n={n} done={t3On} title={t3On ? "This computer's agents are running" : "Start this computer's agents"}>
      <p>
        One program (T3) runs them and keeps their sign-ins and keys. Foundation starts and stops it{t3 === "error" ? `; it failed: ${host?.detail ?? "no reason given"}` : ""}.
      </p>
      <button type="button" className="f-pill is-accent" disabled={busy === "t3" || t3 === "starting"} onClick={startT3} data-add-start-t3>
        {busy === "t3" || t3 === "starting" ? "Starting…" : "Start them"}
      </button>
    </WayStep>
  );
  const form = (where: "cloud" | "local") =>
    k?.preset && presets[k.preset] ? (
      <T3AddForm
        key={`${k.preset}-${where}`}
        presets={{ [k.preset]: presets[k.preset] }}
        only
        local={local}
        start={{ preset: k.preset, where }}
        busy={busy === "form"}
        error={formError}
        onWhere={(w, baseUrl) => {
          if (w !== "local") return;
          setLocal(null);
          void api<T3Local>(`/api/t3host/local?base=${encodeURIComponent(baseUrl)}`)
            .then(setLocal)
            .catch(() => setLocal({ baseUrl, up: false, models: [] }));
        }}
        onCancel={() => setKind(null)}
        onAdd={(input) => {
          setBusy("form");
          setFormError(null);
          void api("/api/t3host/agents", { method: "POST", json: input })
            .then(() => refreshAvailable())
            .catch((e: Error) => setFormError(e.message))
            .finally(() => setBusy(null));
        }}
      />
    ) : (
      <p>Asking this computer's agents what they need…</p>
    );

  /** the steps of the way in use */
  const steps = () => {
    if (!k || !way) return null;
    const again = (
      <button type="button" className="f-pill" onClick={() => void refreshAvailable()} data-add-again>
        Check again
      </button>
    );
    if (way === "key")
      return (
        <ol className="way-steps">
          <WayStep n={1} done={connected} title={`Make a key on ${k.label}'s site`}>
            <p>It opens in your browser. Sign in there, make a key, and copy it.</p>
            {k.keyPage && (
              <button type="button" className="f-pill" onClick={() => void openExternal(k.keyPage!)} data-add-key-page>
                Open {new URL(k.keyPage).host} ↗
              </button>
            )}
          </WayStep>
          {startStep(2)}
          <WayStep n={3} done={connected} wait={!t3On} title="Paste the key">
            {form("cloud")}
          </WayStep>
        </ol>
      );
    if (way === "local")
      return (
        <ol className="way-steps">
          <WayStep n={1} done={connected || Boolean(local?.up)} title="Have a model server running here">
            <p>
              Ollama is the usual one: install it, then pull a model, for example <Cmd text="ollama pull deepseek-r1:14b" />
            </p>
            <button type="button" className="f-pill" onClick={() => void openExternal("https://ollama.com/download")}>
              Open ollama.com ↗
            </button>
          </WayStep>
          {startStep(2)}
          <WayStep n={3} done={connected} wait={!t3On} title="Choose the model">
            {form("local")}
          </WayStep>
        </ol>
      );
    if (way === "own")
      return (
        <ol className="way-steps">
          <WayStep n={1} done={connected} title={`Install ${k.program} on this computer`}>
            <p>In a terminal on the computer Foundation's server runs on:</p>
            {k.install && <Cmd text={k.install} />}
          </WayStep>
          <WayStep n={2} done={connected} title="Sign it in, once">
            <p>
              Run it and follow its sign-in (it opens your browser). {found?.why ? `Right now: ${found.why}.` : ""}
            </p>
            {k.signIn && <Cmd text={k.signIn} />}
            <p className="way-fine">A machine card's terminal is a computer of its own and can't sign this one in: use this computer's own terminal.</p>
            {again}
          </WayStep>
        </ol>
      );
    // signed in through T3
    const state = t3Agent?.state;
    const off = t3On && state === "off";
    const missing = t3On && !off && (!found || state === "missing");
    // the turn-on step shows while it's off; the steps after it count on from it
    const extra = off || (t3Agent && t3Agent.enabled === false) ? 1 : 0;
    return (
      <ol className="way-steps">
        {startStep(1)}
        {extra > 0 && (
          <WayStep n={2} done={!off} wait={!t3On} title={`Turn ${t3Agent?.name ?? k.program ?? k.label} on`}>
            <p>T3 has it, switched off (it ships that way). Turning it on lets this computer run {k.program ?? k.label} when it's asked to.</p>
            <button type="button" className="f-pill is-accent" disabled={busy === "enable" || !t3Agent || ui.role !== "admin"} onClick={() => t3Agent && enable(t3Agent.id)} data-add-enable>
              {busy === "enable" ? "Turning it on…" : "Turn it on"}
            </button>
            {ui.role !== "admin" && <p className="way-fine">Only an admin can turn an agent on.</p>}
          </WayStep>
        )}
        <WayStep n={2 + extra} done={connected || (t3On && !missing && !off)} wait={!t3On || off} title={`Have ${k.program ?? k.label} on this computer`}>
          <p>This computer's agents drive {k.program ?? k.label}, and it isn't installed here yet.</p>
          {k.install && <Cmd text={k.install} />}
          {again}
        </WayStep>
        <WayStep n={3 + extra} done={connected} wait={!t3On || missing || off} title={`Sign in with your ${k.label} account`}>
          <p>
            {found?.name ?? k.label} {found?.why ?? "needs signing in"}. Open T3 and sign in from its settings{k.signIn ? ", or in a terminal on this computer:" : "."}
          </p>
          {k.signIn && <Cmd text={k.signIn} />}
          <span className="way-acts">
            <button type="button" className="f-pill is-accent" onClick={openT3} data-add-open-t3>
              Open T3 to sign in
            </button>
            {again}
          </span>
          <p className="way-fine">It shows as connected here by itself once the sign-in is done.</p>
        </WayStep>
      </ol>
    );
  };

  return (
    <div className="add-agent" data-add-agent>
      <p className="add-lede">
        An agent for the council of <b>{placeName}</b>. Adding it starts nothing by itself: it sits there until it's spoken to.
      </p>

      {step(
        1,
        "Who",
        kind ? "done" : "open",
        <button type="button" className="add-link" onClick={() => (setKind(null), setWay(null))}>
          {k?.label} · change
        </button>,
        <div className="add-kinds">
          {KINDS.map((x) => {
            const all = x.ways.map((w) => agentFor(x, w.id, agents)).filter(Boolean) as AvailableAgent[];
            const a = all.find((y) => y.ready) ?? all[0];
            const words = a ? (a.ready ? (here.has(a.key) ? "already here" : "ready") : (a.why ?? "not ready")) : x.ways.length > 1 ? `${x.ways.length} ways to connect` : t3On ? "not connected yet" : "needs this computer's agents";
            return (
              <button key={x.id} type="button" className={`add-kind${kind === x.id ? " is-on" : ""}`} data-add-kind={x.id} aria-pressed={kind === x.id} onClick={() => (setKind(x.id), setWay(null), setFormError(null))}>
                <ProviderMark provider={x.id} size={28} />
                <span className="add-kind-text">
                  <b>{x.label}</b>
                  <span>{x.what}</span>
                </span>
                <span className={`add-kind-state${a?.ready ? " is-ok" : ""}`}>{words}</span>
              </button>
            );
          })}
        </div>,
      )}

      {step(
        2,
        "Connect",
        !kind ? "wait" : "open",
        "after choosing who",
        <div className="add-connect" data-add-connect={connected ? "ready" : (way ?? "none")}>
          {k && k.ways.length > 1 && <p className="add-note">There are {k.ways.length} ways to connect {k.label}. Pick one; the steps under it tick off as you go.</p>}
          {k?.ways.map((w) => {
            const a = agentFor(k, w.id, agents);
            const on = way === w.id;
            return (
              <div key={w.id} className={`add-way${on ? " is-on" : ""}${a?.ready ? " is-ready" : ""}`} data-add-way={w.id} data-add-way-ready={a?.ready ? "yes" : "no"}>
                <button type="button" className="add-way-head" aria-expanded={on} onClick={() => (setWay(w.id), setFormError(null))}>
                  <span className="add-way-radio" aria-hidden />
                  <span className="add-way-text">
                    <b>{w.title}</b>
                    <span>{w.what}</span>
                  </span>
                  <span className={`add-kind-state${a?.ready ? " is-ok" : ""}`}>{a?.ready ? "connected" : a ? "not yet" : ""}</span>
                </button>
                {on && (
                  <div className="add-way-body">
                    {steps()}
                    {connected && (
                      <p className="add-note is-ok">
                        <span className="f-dot is-ok" /> {found!.name} is connected: {found!.where === "local" ? "on this computer, nothing you ask leaves it" : `in the cloud, ${found!.service}`}.
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>,
      )}

      {step(
        3,
        "Avatar",
        !connected ? "wait" : "open",
        "after it's connected",
        <div className="add-avatars">
          {ready.length === 0 && <p className="add-note">No characters are approved yet. It gets the agent's spark until one is; the Character studio makes them.</p>}
          {ready.map((c) => (
            <button key={c.id} type="button" className={`add-avatar${picked?.id === c.id ? " is-on" : ""}`} aria-pressed={picked?.id === c.id} data-add-avatar={c.name} data-tip={`${c.name} · ${c.set}`} onClick={() => setAvatar(c.id)}>
              <Still character={c} role={c.form === "mesh" ? "portrait" : "thumb"} />
            </button>
          ))}
          {picked && (
            <p className="add-note">
              It will appear as <b>{picked.name}</b>
              {avatar ? "" : " (chosen for you; press another to change it)"}.
            </p>
          )}
        </div>,
      )}

      {step(
        4,
        "Add",
        !connected ? "wait" : "open",
        "",
        <div className="add-final">
          {found && here.has(found.key) ? (
            <p className="add-note">{found.name} is already on this council.</p>
          ) : (
            <>
              {found?.key.startsWith("t3:") && (
                <label className="add-check">
                  <input type="checkbox" checked={session} onChange={(e) => setSession(e.target.checked)} />
                  <span>
                    Open its own session, named {found.name}, in {sectionId ? placeName : "the first section"} (it reads the grid once, on {found.where === "local" ? "this computer" : "its plan"})
                  </span>
                </label>
              )}
              <button type="button" className="f-pill is-agent" disabled={!found || busy === "add"} onClick={() => void add()} data-add-submit>
                {busy === "add" ? "Adding…" : `Add ${found?.name ?? "it"} to ${placeName}`}
              </button>
            </>
          )}
        </div>,
      )}
    </div>
  );
}
