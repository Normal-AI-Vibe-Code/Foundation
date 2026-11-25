/**
 * Adding an agent to a council, in the agents panel on the right. Four steps on one sheet, each open
 * only when the one before is settled.
 *
 * 2026-11-24 (Josh: "I tried to add one via the API key, but it seemed like it was going through T3 …
 * There really should only be three types of Claude agents"): re-cut by **kind** (docs/agent-harness.md §1).
 *
 *  1. **Kind.** *Claude*, run by Foundation itself, or *A T3 session*, where T3 Code runs the agent.
 *     Each says in one sentence where it runs and who pays (the server's `runs` when it sends one).
 *  2. **Connect.** Claude has exactly three ways, each with its live readiness from
 *     `GET /api/agents/claude`: *Claude account on this computer* (`claude-account`: the server starts
 *     Claude Code here on this computer's sign-in; not a connection to any Claude Code window you have
 *     open), *API key* (`claude-api`: straight to Anthropic, on the key's credits; the key stored by an
 *     admin, the model chosen from Anthropic's list) and *Federated identity* (`claude-federated`: the
 *     organization's sign-in; the server's `why` when it isn't set up). *A T3 session* first asks which
 *     agent (Claude, ChatGPT, Gemini, Kimi, DeepSeek, a local model), then that agent's ways as before:
 *     signed in through T3, a key T3 keeps, or a local model. Nothing under Claude says T3.
 *     A Claude Code you run yourself is none of these: "Using Claude Code yourself?" opens the MCP block.
 *  3. **Avatar.** The approved characters; one is chosen already (an abstract one nobody wears).
 *  4. **Add.** To the section or the grid the council is for (kept while the panel is open, even after
 *     the council itself is put away). One of T3's agents also gets its own session in that section.
 *
 * An older server (404 on the Claude routes) gets today's flow: its one Claude agent on the account way,
 * and a line saying the server is older than the app on the other two.
 */

import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { refreshAvailable, useAvailable, type OfferedAgent } from "../lib/agentsAvailable";
import { claudeModels, refreshClaude, useClaude, type ClaudeModel, type ClaudeStatus } from "../lib/claudeAgents";
import { GRID_PLACE, postAgent, usePosted, type AvailableAgent } from "../lib/posted";
import { useCouncilOpen, type CouncilScope } from "../lib/councilOpen";
import { getState } from "../state/store";
import { setUi, toast, useUi } from "../state/ui";
import { activeBoard } from "../sync/board";
import { openExternal } from "../utils/media";
import { Still } from "../characters/Avatar";
import { ProviderMark, providerOf, type Provider } from "../characters/providers";
import { chooseAvatar, readyCharacters, useRoster, type RosterCharacter } from "../characters/roster";
import { T3AddForm, type T3Agent, type T3Local, type T3Preset } from "./AgentsPane";
import { ClaudeKey, ClaudeModelPicker, Federation, McpConnect, OLDER_WORDS, Readiness, wayState, type ClaudeWayId } from "./AgentSetup";

export type KindId = "claude" | "t3";
export type T3WayId = "t3" | "key" | "local";
export type WayId = ClaudeWayId | T3WayId;

/** which of T3's own agents drives each, signed in through T3 */
const T3_DRIVER: Partial<Record<Provider, string>> = { claude: "claudeAgent", chatgpt: "codex", gemini: "antigravity" };

/** one way of connecting an agent */
export interface Way {
  id: WayId;
  title: string;
  what: string;
}

/** the two kinds, each in one sentence: where it runs and who pays */
export const KINDS: Array<{ id: KindId; label: string; what: string }> = [
  { id: "claude", label: "Claude", what: "Run by Foundation itself, in one of three ways: this computer's Claude sign-in, an API key, or your organization's sign-in." },
  { id: "t3", label: "A T3 session", what: "T3 Code runs the agent (Claude, ChatGPT, Gemini, Kimi, DeepSeek or a local model) in a session Foundation starts, paid by whatever that agent is signed in to or keyed with." },
];

/** Claude's three ways (docs/agent-harness.md §1), with the server's agent key for each */
export const CLAUDE_WAYS: Array<Way & { id: ClaudeWayId; key: string }> = [
  { id: "account", key: "claude", title: "Claude account on this computer", what: "Foundation's server starts Claude Code here, on the Claude sign-in this computer already has. Your Claude plan pays; no key." },
  { id: "api", key: "claude-api", title: "API key", what: "Foundation talks to Anthropic directly, on a key an admin stores here. The key's credits pay." },
  { id: "federated", key: "claude-fed", title: "Federated identity", what: "Your organization's sign-in, exchanged for a short-lived token. Your organization's Anthropic workspace pays." },
];

/** an agent T3 runs, and its ways of being connected */
export interface T3Kind {
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
  ways: Array<Way & { id: T3WayId }>;
}

const T3_WAY = (who: string, account: string): Way & { id: T3WayId } => ({ id: "t3", title: `Sign in with your ${account} account`, what: `In T3. No key: it runs on your ${who} plan, and its sessions keep working on Foundation.` });
const KEY_WAY = (vendor: string): Way & { id: T3WayId } => ({ id: "key", title: "An API key, kept by T3", what: `Billed to your ${vendor} account as it's used. T3 keeps the key; Foundation never stores it.` });
const LOCAL_WAY: Way & { id: T3WayId } = { id: "local", title: "A model on this computer", what: "Run by a model server here (Ollama's address by default). No key, and nothing you ask leaves the computer." };

/** the agents a T3 session can run, in the order offered */
export const T3_KINDS: T3Kind[] = [
  { id: "claude", label: "Claude", what: "Anthropic's, through Claude Code in T3", preset: "claude", program: "Claude Code", signIn: "claude", install: "npm install -g @anthropic-ai/claude-code", keyPage: "https://console.anthropic.com/settings/keys", ways: [T3_WAY("Claude", "Claude"), KEY_WAY("Anthropic")] },
  { id: "chatgpt", label: "ChatGPT", what: "OpenAI's, through Codex", program: "Codex", signIn: "codex login", install: "npm install -g @openai/codex", ways: [T3_WAY("ChatGPT", "ChatGPT")] },
  { id: "gemini", label: "Gemini", what: "Google's, through Antigravity", program: "Antigravity", signIn: "antigravity", ways: [T3_WAY("Google", "Google")] },
  { id: "kimi", label: "Kimi", what: "Moonshot's, on a key or a local model", preset: "kimi", keyPage: "https://platform.moonshot.ai/console/api-keys", ways: [KEY_WAY("Moonshot"), LOCAL_WAY] },
  { id: "deepseek", label: "DeepSeek", what: "DeepSeek's, on a key or a local model", preset: "deepseek", keyPage: "https://platform.deepseek.com/api_keys", ways: [KEY_WAY("DeepSeek"), LOCAL_WAY] },
  { id: "local", label: "A local model", what: "runs on this computer, nothing leaves it", preset: "kimi", ways: [LOCAL_WAY] },
];

/** the server's agent for a Claude way: on an older server only the account way has one (its "claude") */
export function claudeAgentFor(way: ClaudeWayId, agents: AvailableAgent[], older: boolean): AvailableAgent | undefined {
  if (older) return way === "account" ? agents.find((a) => a.key === "claude") : undefined;
  const w = CLAUDE_WAYS.find((x) => x.id === way)!;
  return agents.find((a) => a.key === w.key);
}

/** the T3 agent that is this kind connected this way, if this computer has one */
export function t3AgentFor(kind: T3Kind, way: T3WayId, agents: AvailableAgent[]): AvailableAgent | undefined {
  const added = (w: "cloud" | "local") => agents.find((a) => a.key === `t3:${kind.preset}-${w}`);
  if (way === "key") return added("cloud");
  if (way === "local") return kind.id === "local" ? agents.find((a) => a.key.startsWith("t3:") && a.where === "local") : added("local");
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

/** the two kinds, each with its sentence and how it stands (also drawn on #/design) */
export function KindList({ kind, words, onPick }: { kind: KindId | null; words: (id: KindId) => { ok: boolean; words: string }; onPick?: (id: KindId) => void }) {
  return (
    <div className="add-kinds">
      {KINDS.map((x) => {
        const s = words(x.id);
        return (
          <button key={x.id} type="button" className={`add-kind${kind === x.id ? " is-on" : ""}`} data-add-kind={x.id} aria-pressed={kind === x.id} onClick={() => onPick?.(x.id)}>
            {x.id === "claude" ? <ProviderMark provider="claude" size={28} /> : <span className="add-kind-t3" aria-hidden>T3</span>}
            <span className="add-kind-text">
              <b>{x.label}</b>
              <span>{x.what}</span>
            </span>
            <span className={`add-kind-state${s.ok ? " is-ok" : ""}`}>{s.words}</span>
          </button>
        );
      })}
    </div>
  );
}

/** one way of connecting: a radio card, its sentence, how it stands, and (open) its body (also drawn on #/design) */
export function WayCard({ id, title, what, ok, state, on, onPick, children }: { id: string; title: string; what: string; ok: boolean; state: string; on: boolean; onPick?: () => void; children?: React.ReactNode }) {
  return (
    <div className={`add-way${on ? " is-on" : ""}${ok ? " is-ready" : ""}`} data-add-way={id} data-add-way-ready={ok ? "yes" : "no"}>
      <button type="button" className="add-way-head" aria-expanded={on} onClick={onPick}>
        <span className="add-way-radio" aria-hidden />
        <span className="add-way-text">
          <b>{title}</b>
          <span className="setup-runs">{what}</span>
        </span>
        <span className={`add-kind-state${ok ? " is-ok" : ""}`}>{state}</span>
      </button>
      {on && <div className="add-way-body">{children}</div>}
    </div>
  );
}

/** the council the panel was opened for, kept while the panel is open even once the council is put away */
function useAddScope(): CouncilScope | null {
  const live = useCouncilOpen();
  const [kept, setKept] = useState<CouncilScope | null>(live);
  useEffect(() => {
    if (live) setKept(live);
  }, [live]);
  return live ?? kept;
}

export function AddAgent({ onDone }: { onDone(): void }) {
  const ui = useUi();
  const { agents, t3, host } = useAvailable();
  const claude = useClaude();
  const posted = usePosted();
  const roster = useRoster();
  const ready = readyCharacters(roster);
  const scope = useAddScope();
  const st = getState();
  const sectionId = scope?.kind === "section" ? scope.id : null;
  const place = sectionId ?? GRID_PLACE;
  const placeName = sectionId ? (st.allSections[sectionId]?.name ?? "this section") : "this grid";
  const here = new Set((posted[place] ?? []).map((p) => p.key));
  const admin = ui.role === "admin";

  const [kind, setKind] = useState<KindId | null>(null);
  const [claudeWayPick, setClaudeWay] = useState<ClaudeWayId | null>(null);
  const [t3Pick, setT3Pick] = useState<Provider | null>(null);
  const [t3WayPick, setT3Way] = useState<T3WayId | null>(null);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [avatar, setAvatar] = useState<string | null>(null);
  const [session, setSession] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [presets, setPresets] = useState<Record<string, T3Preset>>({});
  const [local, setLocal] = useState<T3Local | null>(null);
  const [claudeList, setClaudeList] = useState<ClaudeModel[] | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  // a Claude on the API (key or federated): the model this seat runs, when the person picks one
  const [seatModelPick, setSeatModel] = useState<string | null>(null);

  useEffect(() => {
    void refreshAvailable();
    void refreshClaude();
    const t = setInterval(() => {
      void refreshAvailable();
      void refreshClaude();
    }, 4000);
    return () => clearInterval(t);
  }, []);

  const older = claude.older;
  const status: ClaudeStatus | null = claude.status;
  const runsOf = (key: string) => (agents.find((a) => a.key === key) as OfferedAgent | undefined)?.runs;

  // Claude: the way picked, else one that's ready, else the account
  const claudeWay: ClaudeWayId = claudeWayPick ?? CLAUDE_WAYS.find((w) => claudeAgentFor(w.id, agents, older)?.ready)?.id ?? "account";
  // a T3 session: the agent picked, then its way (picked, else one that's connected, else its first)
  const tk = T3_KINDS.find((x) => x.id === t3Pick);
  const t3Way: T3WayId | null = tk ? (t3WayPick && tk.ways.some((w) => w.id === t3WayPick) ? t3WayPick : (tk.ways.find((w) => t3AgentFor(tk, w.id, agents)?.ready)?.id ?? tk.ways[0].id)) : null;

  const found: AvailableAgent | undefined = useMemo(() => {
    if (kind === "claude") return claudeAgentFor(claudeWay, agents, older);
    if (kind === "t3" && tk && t3Way) return t3AgentFor(tk, t3Way, agents);
    return undefined;
  }, [kind, claudeWay, tk, t3Way, agents, older]);
  // T3's own agent for this one, even one it has switched off (it isn't offered as available until it's on)
  const t3Agent: T3Agent | undefined = kind !== "t3" || !tk ? undefined : found?.key.startsWith("t3:") ? host?.agents.find((a) => `t3:${a.id}` === found.key) : host?.agents.find((a) => a.driver === T3_DRIVER[tk.id]);
  const t3On = t3 === "running";
  const connected = !!found && found.ready;
  const picked = ready.find((c) => c.id === avatar) ?? defaultAvatar(ready, roster.avatars);
  const needsForm = kind === "t3" && !!tk && (t3Way === "key" || t3Way === "local") && !found && t3On;

  useEffect(() => {
    if (!needsForm) return;
    void api<Record<string, T3Preset>>("/api/t3host/presets").then(setPresets).catch(() => {});
    // Claude in T3 on a key: the model is chosen from Anthropic's list, not typed
    if (tk?.preset === "claude") void claudeModels().then((r) => setClaudeList(r?.models ?? null)).catch(() => setClaudeList(null));
  }, [needsForm, tk?.preset]);
  useEffect(() => {
    if (!needsForm || t3Way !== "local" || !tk?.preset) return;
    void api<T3Local>("/api/t3host/local")
      .then(setLocal)
      .catch(() => setLocal(null));
  }, [needsForm, t3Way, tk?.preset]);

  const said = (e: unknown) => toast((e as Error).message, "bad");
  const again = () => {
    void refreshAvailable();
    void refreshClaude();
  };
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
      // a new seat with a name of its own: its character is chosen for that name, so a second Claude doesn't re-dress the first
      const own = (found.key === "claude-api" || found.key === "claude-fed") && seatModelPick ? seatModelPick : undefined;
      const seat = await postAgent(place, found.key, own);
      const who = seat?.alias ?? found.name;
      if (picked) await chooseAvatar(who, picked.id).catch(() => {});
      let opened = "";
      if (session && found.key.startsWith("t3:")) {
        const board = activeBoard()?.boardId;
        const sec = sectionId ?? Object.values(getState().sections).find((s) => !s.parent)?.id;
        if (board && sec) {
          await api("/api/t3host/threads", { method: "POST", json: { board, section: sec, agent: found.key.slice(3), as: seat?.alias, text: `You are ${who} (${found.name}), now on the council of ${placeName}. Read the grid, say in one line what you see here, and wait to be asked.` } })
            .then(() => (opened = ", with its own session"))
            .catch((e: Error) => toast(`${who} is added, but its session didn't open: ${e.message}`, "warn"));
        }
      }
      toast(`${who} (${found.name}) is on the council of ${placeName}${opened}`, "agent");
      onDone();
    } catch (e) {
      said(e);
    } finally {
      setBusy(null);
    }
  };

  if (ui.role === "viewer")
    return (
      <div className="add-agent" data-add-agent>
        <p className="agents-empty">Viewers can't add agents to a council.</p>
        <McpConnect viewer />
      </div>
    );
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
  const mcpLink = (
    <button type="button" className="setup-link" onClick={() => setMcpOpen(true)} data-add-mcp-link>
      Using Claude Code yourself?
    </button>
  );
  const againBtn = (
    <button type="button" className="f-pill" onClick={again} data-add-again>
      Check again
    </button>
  );

  // ---------- Claude's three ways ----------

  const claudeBody = (way: ClaudeWayId) => {
    const agent = claudeAgentFor(way, agents, older);
    // one line, one state: ready and on what, or what's missing, in the server's words
    const line = <Readiness {...wayState(way, agent, status, older)} attr={way} />;
    const ready = !!agent?.ready;
    const modelPicker = <ClaudeModelPicker status={status} admin={admin} seat={{ value: seatModelPick, onPick: setSeatModel }} />;
    if (way === "account") {
      // a ready agent on this way settles both steps (a test server's scripted stand-in has no Claude Code at all)
      const installed = ready || (!older && !!status?.account.installed);
      const signedIn = ready || (!older && status?.account.signedIn === true);
      return (
        <>
          {line}
          <p className="add-note" data-add-account-note>
            It is the same sign-in Claude Code uses on this computer. It is <b>not</b> a connection to a Claude Code window you have open: Foundation starts its own Claude Code for each ask. {mcpLink}
          </p>
          <ol className="way-steps">
            <WayStep n={1} done={installed} title="Install Claude Code on this computer">
              <p>In a terminal on the computer Foundation's server runs on:</p>
              <Cmd text="npm install -g @anthropic-ai/claude-code" />
              {againBtn}
            </WayStep>
            <WayStep n={2} done={signedIn} wait={!installed} title="Sign it in, once">
              <p>Run it and follow its sign-in (it opens your browser). Once it's signed in, every Claude on this way uses that sign-in.</p>
              <Cmd text="claude" />
              <p className="way-fine">A machine card's terminal is a computer of its own and can't sign this one in: use this computer's own terminal.</p>
              {againBtn}
            </WayStep>
          </ol>
        </>
      );
    }
    if (older)
      return (
        <p className="setup-older" data-add-older>
          {OLDER_WORDS}
        </p>
      );
    if (way === "api") {
      const stored = !!status?.api.configured;
      return (
        <>
          {line}
          <ol className="way-steps">
            <WayStep n={1} done={stored} title="Make a key on Anthropic's console">
              <p>It opens in your browser. Sign in there, make a key, and copy it.</p>
              <button type="button" className="f-pill" onClick={() => void openExternal("https://console.anthropic.com/settings/keys")} data-add-key-page>
                Open console.anthropic.com ↗
              </button>
            </WayStep>
            <WayStep n={2} done={false} title={stored ? "The key" : "Store it here"}>
              <ClaudeKey api={status?.api ?? null} admin={admin} />
            </WayStep>
            <WayStep n={3} done={false} wait={!stored && !ready} title="This seat's model">
              {modelPicker}
            </WayStep>
          </ol>
        </>
      );
    }
    const fedSet = !!status?.federated.configured;
    return (
      <>
        {line}
        <ol className="way-steps">
          <WayStep n={1} done={false} title="Your organization's identity">
            <p>A federation rule in the Claude Console lets this server trade its identity provider's token for a short-lived Anthropic one. Tell Foundation which rule, and where the token is.</p>
            <Federation admin={admin} configured={fedSet} />
          </WayStep>
          <WayStep n={2} done={false} wait={!fedSet && !ready} title="This seat's model">
            {modelPicker}
          </WayStep>
        </ol>
      </>
    );
  };

  const claudeWays = (
    <>
      {CLAUDE_WAYS.map((w) => {
        const st = wayState(w.id, claudeAgentFor(w.id, agents, older), status, older);
        return (
          <WayCard key={w.id} id={w.id} title={w.title} what={runsOf(w.key) ?? w.what} ok={st.ok} state={st.short} on={claudeWay === w.id} onPick={() => (setClaudeWay(w.id), setSeatModel(null))}>
            {claudeBody(w.id)}
          </WayCard>
        );
      })}
    </>
  );

  // ---------- a T3 session ----------

  const startStep = (n: number) => (
    <WayStep n={n} done={t3On} title={t3On ? "T3 is running" : "Start T3"}>
      <p>
        T3 is a program on this computer that runs these agents and keeps their sign-ins and keys. Foundation starts and stops it{t3 === "error" ? `; it failed: ${host?.detail ?? "no reason given"}` : ""}.
      </p>
      <button type="button" className="f-pill is-accent" disabled={busy === "t3" || t3 === "starting"} onClick={startT3} data-add-start-t3>
        {busy === "t3" || t3 === "starting" ? "Starting…" : "Start T3"}
      </button>
    </WayStep>
  );
  const form = (where: "cloud" | "local") =>
    tk?.preset && presets[tk.preset] ? (
      <T3AddForm
        key={`${tk.preset}-${where}`}
        presets={{ [tk.preset]: presets[tk.preset] }}
        only
        local={local}
        start={{ preset: tk.preset, where }}
        models={tk.preset === "claude" && claudeList?.length ? claudeList : undefined}
        busy={busy === "form"}
        error={formError}
        onWhere={(w, baseUrl) => {
          if (w !== "local") return;
          setLocal(null);
          void api<T3Local>(`/api/t3host/local?base=${encodeURIComponent(baseUrl)}`)
            .then(setLocal)
            .catch(() => setLocal({ baseUrl, up: false, models: [] }));
        }}
        onCancel={() => setT3Pick(null)}
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
      <p>Asking T3 what it needs…</p>
    );

  const t3Steps = () => {
    if (!tk || !t3Way) return null;
    if (t3Way === "key")
      return (
        <ol className="way-steps">
          <WayStep n={1} done={connected} title={`Make a key on ${tk.label}'s site`}>
            <p>It opens in your browser. Sign in there, make a key, and copy it.</p>
            {tk.keyPage && (
              <button type="button" className="f-pill" onClick={() => void openExternal(tk.keyPage!)} data-add-key-page>
                Open {new URL(tk.keyPage).host} ↗
              </button>
            )}
          </WayStep>
          {startStep(2)}
          <WayStep n={3} done={connected} wait={!t3On} title="Paste the key into T3">
            {form("cloud")}
          </WayStep>
        </ol>
      );
    if (t3Way === "local")
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
          <WayStep n={2} done={!off} wait={!t3On} title={`Turn ${t3Agent?.name ?? tk.program ?? tk.label} on`}>
            <p>T3 has it, switched off (it ships that way). Turning it on lets T3 run {tk.program ?? tk.label} when it's asked to.</p>
            <button type="button" className="f-pill is-accent" disabled={busy === "enable" || !t3Agent || !admin} onClick={() => t3Agent && enable(t3Agent.id)} data-add-enable>
              {busy === "enable" ? "Turning it on…" : "Turn it on"}
            </button>
            {!admin && <p className="way-fine">Only an admin can turn an agent on.</p>}
          </WayStep>
        )}
        <WayStep n={2 + extra} done={connected || (t3On && !missing && !off)} wait={!t3On || off} title={`Have ${tk.program ?? tk.label} on this computer`}>
          <p>T3 drives {tk.program ?? tk.label}, and it isn't installed here yet.</p>
          {tk.install && <Cmd text={tk.install} />}
          {againBtn}
        </WayStep>
        <WayStep n={3 + extra} done={connected} wait={!t3On || missing || off} title={`Sign in with your ${tk.label} account`}>
          <p>
            {found?.name ?? tk.label} {found?.why ?? "needs signing in"}. Open T3 and sign in from its settings{tk.signIn ? ", or in a terminal on this computer:" : "."}
          </p>
          {tk.signIn && <Cmd text={tk.signIn} />}
          <span className="way-acts">
            <button type="button" className="f-pill is-accent" onClick={openT3} data-add-open-t3>
              Open T3 to sign in
            </button>
            {againBtn}
          </span>
          <p className="way-fine">It shows as connected here by itself once the sign-in is done.</p>
        </WayStep>
      </ol>
    );
  };

  const t3Body = (
    <>
      <div className="setup-t3-agents" role="radiogroup" aria-label="Which agent T3 runs">
        {T3_KINDS.map((x) => (
          <button key={x.id} type="button" role="radio" aria-checked={t3Pick === x.id} className={`setup-t3-agent${t3Pick === x.id ? " is-on" : ""}`} onClick={() => (setT3Pick(x.id), setT3Way(null), setFormError(null))} data-add-t3-agent={x.id} data-tip={x.what}>
            <ProviderMark provider={x.id} size={18} />
            <span>{x.label}</span>
          </button>
        ))}
      </div>
      {!t3Pick && <p className="add-note">Which agent should T3 run? Each is signed in, keyed or local in T3, not in Foundation.</p>}
      {tk && tk.ways.length > 1 && <p className="add-note">There are {tk.ways.length} ways to connect {tk.label} in T3. Pick one; the steps under it tick off as you go.</p>}
      {tk?.ways.map((w) => {
        const a = t3AgentFor(tk, w.id, agents);
        const on = t3Way === w.id;
        return (
          <WayCard key={w.id} id={`t3-${w.id}`} title={w.title} what={(a as OfferedAgent | undefined)?.runs ?? w.what} ok={!!a?.ready} state={a?.ready ? "connected" : a ? "not yet" : ""} on={on} onPick={() => (setT3Way(w.id), setFormError(null))}>
            {t3Steps()}
          </WayCard>
        );
      })}
    </>
  );

  // how each kind stands, for its row in step 1
  const claudeReady = CLAUDE_WAYS.map((w) => claudeAgentFor(w.id, agents, older)).find((a) => a?.ready);
  const t3Ready = agents.filter((a) => a.key.startsWith("t3:") && a.ready);
  const kindWords = (id: KindId): { ok: boolean; words: string } =>
    id === "claude"
      ? claudeReady
        ? { ok: true, words: here.has(claudeReady.key) ? "ready · one here already" : "ready" }
        : { ok: false, words: !claude.loaded ? "asking…" : "3 ways to connect" }
      : t3On
        ? t3Ready.length
          ? { ok: true, words: `${t3Ready.length} ready in T3` }
          : { ok: false, words: "T3 is running" }
        : { ok: false, words: t3 === "starting" ? "T3 is starting" : "T3 is off" };

  const kindLabel = KINDS.find((x) => x.id === kind)?.label;
  return (
    <div className="add-agent" data-add-agent data-add-place={place}>
      <p className="add-lede">
        An agent for the council of <b>{placeName}</b>. Adding it starts nothing by itself: it sits there until it's spoken to. {!mcpOpen && mcpLink}
      </p>
      {mcpOpen && <McpConnect onClose={() => setMcpOpen(false)} />}

      {step(
        1,
        "Kind",
        kind ? "done" : "open",
        <button type="button" className="add-link" onClick={() => setKind(null)}>
          {kindLabel} · change
        </button>,
        <KindList kind={kind} words={kindWords} onPick={(id) => (setKind(id), setFormError(null))} />,
      )}

      {step(
        2,
        "Connect",
        !kind ? "wait" : "open",
        "after choosing the kind",
        <div className="add-connect" data-add-connect={connected ? "ready" : kind === "claude" ? claudeWay : (t3Way ?? "none")}>
          {kind === "claude" && (
            <>
              <p className="add-note">Three ways to run Claude. Pick one; each says how it stands right now.</p>
              {older && (
                <p className="setup-older" data-add-older>
                  The Foundation server is older than this app: only its own Claude is offered. Restart the server for the API key and federated ways.
                </p>
              )}
              {claudeWays}
            </>
          )}
          {kind === "t3" && t3Body}
          {connected && kind === "t3" && (
            <p className="add-note is-ok">
              <span className="f-dot is-ok" /> {found!.name} is connected: {found!.where === "local" ? "on this computer, nothing you ask leaves it" : `in the cloud, ${found!.service}`}.
            </p>
          )}
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
          {found && here.has(found.key) && (
            <p className="add-note" data-add-again-note>
              {found.name} already sits on this council. Adding it again seats another one, with a name, a character and sessions of its own.
            </p>
          )}
          {found?.key.startsWith("t3:") && (
            <label className="add-check">
              <input type="checkbox" checked={session} onChange={(e) => setSession(e.target.checked)} />
              <span>
                Open its own session in {sectionId ? placeName : "the first section"} (it reads the grid once, on {found.where === "local" ? "this computer" : "its plan"})
              </span>
            </label>
          )}
          <button type="button" className="f-pill is-accent" disabled={!found || busy === "add"} onClick={() => void add()} data-add-submit>
            {busy === "add" ? "Adding…" : `${found && here.has(found.key) ? "Add another" : "Add"} ${found?.name ?? "it"} to ${placeName}`}
          </button>
        </div>,
      )}
    </div>
  );
}
