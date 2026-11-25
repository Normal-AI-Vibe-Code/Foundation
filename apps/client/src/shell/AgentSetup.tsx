/**
 * Setting up agents (2026-11-24, Josh: "there really should only be three types of Claude agents … is
 * this Claude Code instance directly running something in Foundation, is there an MCP?"). The pieces the
 * add flow (AddAgent.tsx) and Settings → Agents share, each a view that takes its state (for #/design)
 * and a live wrapper that asks the server (lib/claudeAgents.ts, docs/agent-harness.md §1 and §4):
 *
 *  - **How a Claude way stands**: one line, one state (ready and on what / needs something / not set
 *    up), in the server's own words.
 *  - **The API key**: a password field that goes to the server and is cleared at once (never echoed);
 *    a stored key shows as ••••last4 with Replace and Forget… (asked in place).
 *  - **The model**: Anthropic's models newest first, the newest marked *Latest*, and whether the list is
 *    live from Anthropic or the one this server shipped with. Never a typed model id.
 *  - **Federated identity**: an admin's form for the ids and the token file the server asks for, saved
 *    through the server (its refusal in its own words); set, what's set with Change and Remove….
 *  - **Connect Claude Code or another MCP client**: a Claude Code you run is an MCP client acting as you;
 *    a token made here (shown once) and the ready-to-paste `claude mcp add` commands (default, code mode).
 *
 * Keys and tokens are a person's: nothing here is violet (DESIGN.md principle 2).
 */

import { useEffect, useState } from "react";
import { toast } from "../state/ui";
import { activeBoard } from "../sync/board";
import { useAvailable } from "../lib/agentsAvailable";
import { claudeFederation, claudeModels, forgetClaudeKey, forgetFederation, mcpCommand, mintAgentToken, saveFederation, setClaudeModel, storeClaudeKey, type ClaudeModels, type ClaudeStatus, type FederationInput, type FederationState } from "../lib/claudeAgents";
import "./agentSetup.css";

export type ClaudeWayId = "account" | "api" | "federated";

/** a server older than this app: the one line every Claude way shows then */
export const OLDER_WORDS = "The Foundation server is older than this app and can't do this yet. Restart it (the server pill at the foot of the side menu, or stop and start it where it runs), then try again.";

/** how one way of running Claude stands: one state, said once (ready / needs something / not set up), never two that disagree */
export interface WayState {
  ok: boolean;
  warn: boolean;
  /** a word or two for the way's head */
  short: string;
  /** the one line under it */
  words: string;
}

/**
 * The way's state from the two things the server says: whether its agent can take work (`/api/agents/available`:
 * `ready`, its `service`, else its `why`) and how the way is set up (`/api/agents/claude`). Ready wins and says what
 * it runs on; otherwise the setup says what's missing, in the server's words.
 */
export function wayState(way: ClaudeWayId, agent: { ready: boolean; service: string; why?: string } | undefined, s: ClaudeStatus | null, older = false): WayState {
  if (agent?.ready) return { ok: true, warn: false, short: "ready", words: `Ready · ${agent.service}` };
  if (older) return way === "account" ? { ok: false, warn: true, short: "needs Claude Code", words: agent?.why ?? "Claude Code isn't set up on the server" } : { ok: false, warn: false, short: "server too old", words: OLDER_WORDS };
  if (!s) return { ok: false, warn: false, short: "", words: "Asking the server…" };
  if (way === "account") {
    const a = s.account;
    if (!a.installed) return { ok: false, warn: false, short: "needs Claude Code", words: agent?.why ?? "Claude Code isn't installed on this computer." };
    const v = a.version ? `Claude Code ${a.version}` : "Claude Code";
    return { ok: false, warn: true, short: "needs sign-in", words: `${v} needs signing in${a.why ? `: ${a.why}` : agent?.why ? `: ${agent.why}` : "."}` };
  }
  if (way === "api") return { ok: false, warn: false, short: "needs a key", words: agent?.why ?? "No API key yet: an admin adds one." };
  return { ok: false, warn: !!s.federated.why && !/isn't set up/.test(s.federated.why), short: "not set up", words: s.federated.why ?? agent?.why ?? "Federated identity isn't set up." };
}

/** a status dot and the words */
export function Readiness({ ok, warn, words, attr }: { ok: boolean; warn: boolean; words: string; short?: string; attr?: string }) {
  return (
    <p className="setup-ready" data-setup-ready={attr} data-ok={ok ? "yes" : "no"}>
      <span className={`f-dot ${ok ? "is-ok" : warn ? "is-warn" : ""}`} /> <span>{words}</span>
    </p>
  );
}

// ---------- the API key ----------

export interface ClaudeKeyViewProps {
  api: ClaudeStatus["api"] | null;
  admin: boolean;
  busy?: "store" | "forget" | null;
  /** the server's refusal, in its own words */
  error?: string | null;
  /** hold the Forget… question open (the design page) */
  askingForget?: boolean;
  onStore?: (key: string) => Promise<boolean> | void;
  onForget?: () => void;
  /** a new start (Replace, Cancel, Forget…): what the server said last no longer applies */
  onReset?: () => void;
}

/** the key: stored (••••last4, Replace, Forget…) or a password field to store one */
export function ClaudeKeyView({ api, admin, busy, error, askingForget = false, onStore, onForget, onReset }: ClaudeKeyViewProps) {
  const stored = !!api?.configured;
  const [replacing, setReplacing] = useState(false);
  const [asking, setAsking] = useState(askingForget);
  const [key, setKey] = useState("");
  const store = async () => {
    const k = key.trim();
    if (!k || busy) return;
    // the field is emptied before the answer comes back: the key lives in this page for one request, never longer
    setKey("");
    const ok = await onStore?.(k);
    if (ok !== false) setReplacing(false);
  };
  if (!admin)
    return (
      <div className="setup-key" data-setup-key={stored ? "stored" : "none"}>
        {stored ? (
          <span className="setup-key-stored">
            <code>••••{api?.last4 ?? "····"}</code> <span>{api?.source === "env" ? "set on the server" : "stored by an admin"}</span>
          </span>
        ) : null}
        <p className="way-fine">Only an admin stores or replaces the key.</p>
      </div>
    );
  return (
    <div className="setup-key" data-setup-key={stored && !replacing ? "stored" : "form"}>
      {stored && !replacing ? (
        <>
          <div className="setup-key-row">
            <span className="setup-key-stored">
              <code data-setup-last4>••••{api?.last4 ?? "····"}</code>
              <span>{api?.source === "env" ? "from the server's environment (ANTHROPIC_API_KEY)" : "stored here, encrypted"}</span>
            </span>
            {!asking && (
              <span className="setup-key-acts">
                <button type="button" className="crew-row-btn" onClick={() => (onReset?.(), setReplacing(true))} data-setup-replace>
                  Replace
                </button>
                {api?.source === "stored" && (
                  <button type="button" className="crew-row-btn" onClick={() => (onReset?.(), setAsking(true))} data-setup-forget>
                    Forget…
                  </button>
                )}
              </span>
            )}
          </div>
          {asking && (
            <div className="setup-confirm" role="alertdialog" aria-label="Forget the stored key?" data-setup-confirm>
              <p>Forget the stored key? API-key seats stop answering until another key is stored. Anthropic still has the key: revoke it there too if it's done with.</p>
              <span className="setup-key-acts">
                <button type="button" className="crew-row-btn" onClick={() => setAsking(false)}>
                  Keep it
                </button>
                <button
                  type="button"
                  className="f-pill setup-danger"
                  disabled={busy === "forget"}
                  onClick={() => {
                    setAsking(false);
                    onForget?.();
                  }}
                  data-setup-forget-yes
                >
                  {busy === "forget" ? "Forgetting…" : "Forget the key"}
                </button>
              </span>
            </div>
          )}
        </>
      ) : (
        <form
          className="setup-key-form"
          onSubmit={(e) => {
            e.preventDefault();
            void store();
          }}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <label className="t3-field">
            <span>API key</span>
            <input type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-ant-…" aria-label="Anthropic API key" data-setup-key-input />
          </label>
          <span className="setup-key-acts">
            {replacing && (
              <button type="button" className="crew-row-btn" onClick={() => (onReset?.(), setReplacing(false))}>
                Cancel
              </button>
            )}
            <button type="submit" className="f-pill is-accent" disabled={!key.trim() || busy === "store"} data-setup-key-store>
              {busy === "store" ? "Checking with Anthropic…" : "Check and store"}
            </button>
          </span>
          <p className="way-fine">The server checks it with Anthropic before keeping it, encrypted. It is never shown again, only its last four.</p>
        </form>
      )}
      {error && (
        <p className="t3-words is-bad" role="alert" data-setup-key-error>
          {error}
        </p>
      )}
    </div>
  );
}

/** the key, live: store and forget through the server, its refusal in its own words */
export function ClaudeKey({ api, admin }: { api: ClaudeStatus["api"] | null; admin: boolean }) {
  const [busy, setBusy] = useState<"store" | "forget" | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <ClaudeKeyView
      api={api}
      admin={admin}
      busy={busy}
      error={error}
      onReset={() => setError(null)}
      onStore={async (key) => {
        setBusy("store");
        setError(null);
        try {
          await storeClaudeKey(key);
          toast("The key is stored", "ok");
          return true;
        } catch (e) {
          setError((e as Error).message);
          return false;
        } finally {
          setBusy(null);
        }
      }}
      onForget={() => {
        setBusy("forget");
        setError(null);
        void forgetClaudeKey()
          .then(() => toast("The key is forgotten", "ok"))
          .catch((e: Error) => setError(e.message))
          .finally(() => setBusy(null));
      }}
    />
  );
}

// ---------- the model ----------

/** Anthropic's models, newest first, the newest marked Latest; a press chooses */
export function ClaudeModelPickerView({ list, value, disabled, busy, onPick }: { list: ClaudeModels | null | "loading" | "older"; value: string | null; disabled?: boolean; busy?: boolean; onPick?: (id: string) => void }) {
  if (list === "loading") return <p className="way-fine">Asking the server for Claude's models…</p>;
  if (list === "older" || !list) return <p className="way-fine">{OLDER_WORDS}</p>;
  return (
    <div className="setup-models" data-setup-models={list.source}>
      <div className="setup-models-list" role="radiogroup" aria-label="Claude's model">
        {list.models.map((m, i) => {
          const on = m.id === value;
          return (
            <button key={m.id} type="button" role="radio" aria-checked={on} className={`setup-model${on ? " is-on" : ""}`} disabled={disabled || busy} onClick={() => onPick?.(m.id)} data-setup-model={m.id}>
              <span className="setup-model-radio" aria-hidden />
              <span className="setup-model-name">
                <b>{m.name}</b>
                <code>{m.id}</code>
              </span>
              {i === 0 && <span className="setup-latest">Latest</span>}
            </button>
          );
        })}
      </div>
      <p className="way-fine" data-setup-models-source>
        {list.source === "live" ? "Live from Anthropic." : "The list this server shipped with. It reads Anthropic's own once a key or federated identity is set up."}
      </p>
    </div>
  );
}

/**
 * The model, live. Without `seat`: an admin's choice is the default for Claude-on-the-API seats (Settings).
 * With `seat`: the choice is this seat's own (the add flow); anyone who can add one may make it.
 */
export function ClaudeModelPicker({ status, admin, seat }: { status: ClaudeStatus | null; admin: boolean; seat?: { value: string | null; onPick(id: string): void } }) {
  const [list, setList] = useState<ClaudeModels | null | "loading" | "older">("loading");
  const [busy, setBusy] = useState(false);
  // a key or federation set or forgotten changes which list the server has (live or built in)
  const source = `${status?.api.source ?? ""}:${status?.federated.configured ?? ""}`;
  useEffect(() => {
    let gone = false;
    void claudeModels()
      .then((r) => !gone && setList(r ?? "older"))
      .catch((e: Error) => !gone && (toast(e.message, "bad"), setList(null)));
    return () => {
      gone = true;
    };
  }, [source]);
  if (seat)
    return (
      <>
        <ClaudeModelPickerView list={list} value={seat.value ?? status?.api.model ?? null} onPick={seat.onPick} />
        <p className="way-fine" data-setup-seat-model>
          {seat.value ? "This seat runs the one chosen here." : `Unchosen, it follows the server's default (${status?.api.model ?? "…"}).`}
        </p>
      </>
    );
  return (
    <>
      <ClaudeModelPickerView
        list={list}
        value={status?.api.model ?? null}
        disabled={!admin}
        busy={busy}
        onPick={(id) => {
          setBusy(true);
          void setClaudeModel(id)
            .catch((e: Error) => toast(e.message, "bad"))
            .finally(() => setBusy(false));
        }}
      />
      <p className="way-fine">{admin ? "The default for seats that run on the API; a seat can be given its own when it's added." : "Only an admin chooses the default model; a seat can be given its own when it's added."}</p>
    </>
  );
}

// ---------- federated identity ----------

/** the fields the server asks for (agentkinds.ts setFederation), each with where to find it */
export const FED_FIELDS: Array<{ id: keyof FederationInput; label: string; hint: string; placeholder: string; optional?: boolean; code?: boolean }> = [
  { id: "organizationId", label: "Organization", hint: "Your Anthropic organization's id, a uuid: Claude Console → Settings → Organization.", placeholder: "6b5af527-…" },
  { id: "federationRuleId", label: "Rule", hint: "The federation rule made for this server: Claude Console → Settings → Workload identity (fdrl_…).", placeholder: "fdrl_…" },
  { id: "serviceAccountId", label: "Service account", hint: "Only if the rule names one (svac_…).", placeholder: "svac_… (optional)", optional: true },
  { id: "workspaceId", label: "Workspace", hint: "Needed when the rule covers more than one workspace (wrkspc_…, or default).", placeholder: "wrkspc_… (optional)", optional: true },
  { id: "identityTokenFile", label: "Token file", hint: "The full path, on the server's computer, of the file your identity provider writes this server's token (a JWT) to. Foundation reads it on every exchange; nothing secret is stored.", placeholder: "/var/run/secrets/anthropic/token", code: true },
];

export interface FederationViewProps {
  /** what an admin reads (null while asking) */
  fed: FederationState | null;
  admin: boolean;
  busy?: "save" | "forget" | null;
  error?: string | null;
  /** hold the form or the Remove… question open (the design page) */
  start?: "form" | "asking";
  onSave?: (input: FederationInput) => Promise<boolean> | void;
  onForget?: () => void;
  onReset?: () => void;
}

/** an admin sets the organization's identity here; set, it shows what's set with Change and Remove… */
export function FederationView({ fed, admin, busy, error, start, onSave, onForget, onReset }: FederationViewProps) {
  const set = !!fed?.organizationId;
  const [editing, setEditing] = useState(start === "form");
  const [asking, setAsking] = useState(start === "asking");
  const blank = (): Record<keyof FederationInput, string> => ({ organizationId: fed?.organizationId ?? "", federationRuleId: fed?.federationRuleId ?? "", serviceAccountId: fed?.serviceAccountId ?? "", workspaceId: fed?.workspaceId ?? "", identityTokenFile: fed?.identityTokenFile ?? "" });
  const [vals, setVals] = useState(blank);
  if (!admin) return <p className="way-fine" data-setup-fed-admin>An admin sets up federated identity, here or in Settings → Agents.</p>;
  if (!fed) return <p className="way-fine">Asking the server how federated identity is set…</p>;
  const open = editing || !set;
  const save = async () => {
    const input: FederationInput = { organizationId: vals.organizationId.trim(), federationRuleId: vals.federationRuleId.trim(), identityTokenFile: vals.identityTokenFile.trim() };
    if (vals.serviceAccountId.trim()) input.serviceAccountId = vals.serviceAccountId.trim();
    if (vals.workspaceId.trim()) input.workspaceId = vals.workspaceId.trim();
    const ok = await onSave?.(input);
    if (ok !== false) setEditing(false);
  };
  return (
    <div className="setup-fed" data-setup-fed={open ? "form" : "set"}>
      {!open ? (
        <>
          <dl className="setup-fed-set">
            {FED_FIELDS.filter((f) => fed[f.id]).map((f) => (
              <div key={f.id}>
                <dt>{f.label}</dt>
                <dd>
                  <code data-setup-fed-value={f.id}>{fed[f.id]}</code>
                </dd>
              </div>
            ))}
          </dl>
          <p className="way-fine">{fed.source === "env" ? "Set in the server's environment (ANTHROPIC_FEDERATION_RULE_ID and the rest). Saving here takes its place." : "Stored here: ids and a path, nothing secret."}</p>
          {!asking && (
            <span className="setup-key-acts">
              <button type="button" className="crew-row-btn" onClick={() => (onReset?.(), setVals(blank()), setEditing(true))} data-setup-fed-change>
                Change
              </button>
              {fed.source === "stored" && (
                <button type="button" className="crew-row-btn" onClick={() => (onReset?.(), setAsking(true))} data-setup-fed-remove>
                  Remove…
                </button>
              )}
            </span>
          )}
          {asking && (
            <div className="setup-confirm" role="alertdialog" aria-label="Remove federated identity?" data-setup-fed-confirm>
              <p>Remove federated identity? Seats on it stop answering until it is set up again. The rule stays in the Claude Console.</p>
              <span className="setup-key-acts">
                <button type="button" className="crew-row-btn" onClick={() => setAsking(false)}>
                  Keep it
                </button>
                <button type="button" className="f-pill setup-danger" disabled={busy === "forget"} onClick={() => (setAsking(false), onForget?.())} data-setup-fed-remove-yes>
                  {busy === "forget" ? "Removing…" : "Remove it"}
                </button>
              </span>
            </div>
          )}
        </>
      ) : (
        <form
          className="setup-fed-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {FED_FIELDS.map((f) => (
            <label key={f.id} className="setup-fed-field">
              <span className="setup-fed-label">
                {f.label}
                {f.optional && <i> optional</i>}
              </span>
              <input type="text" spellCheck={false} autoComplete="off" className={f.code ? "is-code" : undefined} value={vals[f.id]} placeholder={f.placeholder} onChange={(e) => setVals((v) => ({ ...v, [f.id]: e.target.value }))} data-setup-fed-input={f.id} />
              <span className="setup-fed-hint">{f.hint}</span>
            </label>
          ))}
          <span className="setup-key-acts">
            {set && (
              <button type="button" className="crew-row-btn" onClick={() => (onReset?.(), setEditing(false))}>
                Cancel
              </button>
            )}
            <button type="submit" className="f-pill is-accent" disabled={busy === "save" || !vals.organizationId.trim() || !vals.federationRuleId.trim() || !vals.identityTokenFile.trim()} data-setup-fed-save>
              {busy === "save" ? "Saving…" : "Save"}
            </button>
          </span>
        </form>
      )}
      {error && (
        <p className="t3-words is-bad" role="alert" data-setup-fed-error>
          {error}
        </p>
      )}
    </div>
  );
}

/** federated identity, live: read (admins), saved and removed through the server, its refusal in its own words */
export function Federation({ admin, configured }: { admin: boolean; configured: boolean }) {
  const [fed, setFed] = useState<FederationState | null>(null);
  const [busy, setBusy] = useState<"save" | "forget" | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!admin) return;
    let gone = false;
    void claudeFederation()
      .then((f) => !gone && setFed(f ?? { configured: false, source: null }))
      .catch((e: Error) => !gone && setError(e.message));
    return () => {
      gone = true;
    };
    // read again when the server's view of it changes (saved here or elsewhere)
  }, [admin, configured]);
  return (
    <FederationView
      fed={fed}
      admin={admin}
      busy={busy}
      error={error}
      onReset={() => setError(null)}
      onSave={async (input) => {
        setBusy("save");
        setError(null);
        try {
          setFed(await saveFederation(input));
          toast("Federated identity is saved", "ok");
          return true;
        } catch (e) {
          setError((e as Error).message);
          return false;
        } finally {
          setBusy(null);
        }
      }}
      onForget={() => {
        setBusy("forget");
        setError(null);
        void forgetFederation()
          .then((f) => (setFed(f), toast("Federated identity is removed", "ok")))
          .catch((e: Error) => setError(e.message))
          .finally(() => setBusy(null));
      }}
    />
  );
}

// ---------- Claude Code or another MCP client ----------

export interface McpConnectViewProps {
  /** the commands, once a token is made; null before the press. `code` only when the server takes mode=code */
  commands: { plain: string; code?: string } | null;
  busy?: boolean;
  error?: string | null;
  viewer?: boolean;
  onCreate?: () => void;
  onClose?: () => void;
}

export function McpConnectView({ commands, busy, error, viewer, onCreate, onClose }: McpConnectViewProps) {
  return (
    <section className="setup-mcp" data-setup-mcp={commands ? "token" : "none"} aria-label="Connect Claude Code or another MCP client">
      <header className="setup-mcp-head">
        <b>Connect Claude Code or another MCP client</b>
        {onClose && (
          <button type="button" className="top-btn" onClick={onClose} aria-label="Close" data-tip="Close">
            ✕
          </button>
        )}
      </header>
      <p className="add-note">
        A Claude Code session you run yourself, in a terminal or the desktop app, isn't one of the council's agents: it is an MCP client, and it acts as you on this grid. Make it a token here, paste a command into a terminal, and that session can read and work the grid with your permissions.
      </p>
      {!commands ? (
        <button type="button" className="f-pill is-accent" disabled={busy} onClick={onCreate} data-setup-mcp-create>
          {busy ? "Making a token…" : "Create a token"}
        </button>
      ) : (
        <>
          {commands.code && (
            <p className="add-note" data-setup-mcp-diff>
              Two ways in, one token. In code mode the agent sees seven tools and writes short scripts that call the rest: about a tenth of the tokens up front, and better for many-step work. The default lists every tool.
            </p>
          )}
          <McpCommand label={commands.code ? "Default: every tool" : undefined} text={commands.plain} attr="plain" />
          {commands.code && <McpCommand label="Code mode" text={commands.code} attr="code" />}
          <p className="way-fine">The token is in the command and is shown this once: copy it now. It lasts 7 days, and you can make another any time.</p>
        </>
      )}
      {viewer && <p className="way-fine">You're a viewer here, so a session on your token can read this grid but not change it.</p>}
      {error && (
        <p className="t3-words is-bad" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** the command in the code face, wrapped, with Copy */
function McpCommand({ text, label, attr }: { text: string; label?: string; attr: string }) {
  return (
    <div className="setup-mcp-cmd" data-setup-mcp-mode={attr}>
      {label && <span className="setup-mcp-label">{label}</span>}
      <code data-setup-mcp-command={attr}>{text}</code>
      <button type="button" className="f-pill" onClick={() => void navigator.clipboard?.writeText(text).then(() => toast("Copied: paste it in a terminal", "ok"))} data-setup-mcp-copy>
        Copy
      </button>
    </div>
  );
}

/** the block, live: the token is made on the press and kept only while the block is open */
export function McpConnect({ viewer, onClose }: { viewer?: boolean; onClose?: () => void }) {
  const { codeMode } = useAvailable();
  const [made, setMade] = useState<{ token: string; mcp: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const board = activeBoard()?.boardId ?? null;
  return (
    <McpConnectView
      commands={made ? { plain: mcpCommand(made.mcp, board, made.token, false), ...(codeMode ? { code: mcpCommand(made.mcp, board, made.token, true) } : {}) } : null}
      busy={busy}
      error={error}
      viewer={viewer}
      onClose={onClose}
      onCreate={() => {
        setBusy(true);
        setError(null);
        void mintAgentToken()
          .then(setMade)
          .catch((e: Error) => setError(e.message))
          .finally(() => setBusy(false));
      }}
    />
  );
}
