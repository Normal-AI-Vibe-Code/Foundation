/**
 * Adding an agent to a council (2026-11-16), in the agents panel on the right: who it is, getting
 * it connected, the character it wears, and where it sits. Four steps on one sheet, each open only
 * when the one before is settled, so a person is led through it:
 *
 *  1. **Who.** Claude, ChatGPT, Gemini, Kimi, DeepSeek, or a model on this computer. The list is
 *     already there when the panel opens (lib/agentsAvailable.ts keeps it), each saying how it stands:
 *     ready, needs signing in, not on this computer, or off.
 *  2. **Connect.** Whatever that one still needs: start this computer's agents (a person's press: it
 *     is a program), a key or a local model for Kimi and DeepSeek, or signing its own program in on
 *     this computer (said plainly, with Check again: Foundation can't sign in for you yet).
 *  3. **Avatar.** The approved characters; one is chosen already (an abstract one nobody wears), so
 *     skipping this still gives it a face.
 *  4. **Add.** To the section or the grid the council is for. One of this computer's agents also gets
 *     its own session, named after it, opened in that section (it reads the grid once).
 */

import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { refreshAvailable, useAvailable } from "../lib/agentsAvailable";
import { GRID_PLACE, postAgent, usePosted, type AvailableAgent } from "../lib/posted";
import { councilOpen } from "../lib/councilOpen";
import { goSettings } from "../lib/place";
import { getState } from "../state/store";
import { toast, useUi } from "../state/ui";
import { activeBoard } from "../sync/board";
import { Still } from "../characters/Avatar";
import { PROVIDER_NAME, ProviderMark, providerOf, type Provider } from "../characters/providers";
import { chooseAvatar, readyCharacters, useRoster, type RosterCharacter } from "../characters/roster";
import { T3AddForm, type T3Agent, type T3Local, type T3Preset } from "./AgentsPane";

/** the kinds of agent there are to add, in the order offered; `find` picks the available agent that is one */
const KINDS: Array<{ id: Provider; label: string; what: string; preset?: string; program?: string; signIn?: string }> = [
  { id: "claude", label: "Claude", what: "Anthropic's, through Claude Code" },
  { id: "chatgpt", label: "ChatGPT", what: "OpenAI's, through Codex", program: "Codex", signIn: "codex login" },
  { id: "gemini", label: "Gemini", what: "Google's, through Antigravity", program: "Antigravity", signIn: "antigravity" },
  { id: "kimi", label: "Kimi", what: "Moonshot's, on a key or a local model", preset: "kimi" },
  { id: "deepseek", label: "DeepSeek", what: "DeepSeek's, on a key or a local model", preset: "deepseek" },
  { id: "local", label: "A local model", what: "runs on this computer, nothing leaves it", preset: "kimi" },
];

/** the character a new agent gets when nobody picks: an abstract one no agent wears yet, else any free one, else the first */
export function defaultAvatar(ready: RosterCharacter[], worn: Record<string, string>): RosterCharacter | undefined {
  const taken = new Set(Object.values(worn));
  return ready.find((c) => c.set.toLowerCase() === "abstract" && !taken.has(c.id)) ?? ready.find((c) => !taken.has(c.id)) ?? ready.find((c) => c.set.toLowerCase() === "abstract") ?? ready[0];
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
  const [where, setWhere] = useState<"cloud" | "local">("cloud");
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
  // the agent that is this kind, if this server or this computer has one
  const found: AvailableAgent | undefined = useMemo(() => {
    if (!kind) return undefined;
    if (kind === "local") return agents.find((a) => a.where === "local");
    return agents.find((a) => providerOf(a) === kind && (kind === "claude" || a.where === where || !KINDS.find((x) => x.id === kind)?.preset));
  }, [agents, kind, where]);
  const t3Agent: T3Agent | undefined = found?.key.startsWith("t3:") ? host?.agents.find((a) => `t3:${a.id}` === found.key) : undefined;
  const needsT3 = kind !== null && kind !== "claude" && t3 !== "running";
  const needsAdding = !!k?.preset && !found && !needsT3;
  const needsSignIn = !!found && !found.ready;
  const connected = !!found && found.ready;
  const picked = ready.find((c) => c.id === avatar) ?? defaultAvatar(ready, roster.avatars);

  useEffect(() => {
    if (kind === "local") setWhere("local");
  }, [kind]);
  useEffect(() => {
    if (!needsAdding) return;
    void api<Record<string, T3Preset>>("/api/t3host/presets").then(setPresets).catch(() => {});
  }, [needsAdding]);

  const said = (e: unknown) => toast((e as Error).message, "bad");
  const startT3 = () => {
    setBusy("t3");
    void api("/api/t3host/start", { method: "POST" })
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

  return (
    <div className="add-agent" data-add-agent>
      <p className="add-lede">
        An agent for the council of <b>{placeName}</b>. Adding it starts nothing by itself: it sits there until it's spoken to.
      </p>

      {step(
        1,
        "Who",
        kind ? "done" : "open",
        k?.label,
        <div className="add-kinds">
          {KINDS.map((x) => {
            const a = x.id === "local" ? agents.find((y) => y.where === "local") : agents.find((y) => providerOf(y) === x.id);
            const words = a ? (a.ready ? (here.has(a.key) ? "already here" : "ready") : (a.why ?? "not ready")) : x.id === "claude" ? "not set up on this server" : t3 === "running" ? (x.preset ? "not added yet" : "not on this computer") : "this computer's agents are off";
            return (
              <button key={x.id} type="button" className={`add-kind${kind === x.id ? " is-on" : ""}`} data-add-kind={x.id} aria-pressed={kind === x.id} onClick={() => (setKind(x.id), setFormError(null))}>
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
        !kind ? "wait" : connected ? "done" : "open",
        connected ? `${found!.where === "local" ? "On this computer" : "In the cloud"} · ${found!.service}` : "after choosing who",
        <div className="add-connect" data-add-connect={connected ? "ready" : needsT3 ? "t3" : needsAdding ? "add" : needsSignIn ? "sign-in" : "none"}>
          {connected && (
            <p className="add-note is-ok">
              <span className="f-dot is-ok" /> {found!.name} is connected: {found!.where === "local" ? "on this computer, nothing you ask leaves it" : `in the cloud, ${found!.service}`}.
            </p>
          )}
          {!connected && kind === "claude" && !found?.ready && (
            <p className="add-note">
              Claude needs Claude Code on the server's computer, signed in (run <code>claude</code> there once), or an API key (<code>ANTHROPIC_API_KEY</code>). {found?.why ? `Right now: ${found.why}.` : ""}{" "}
              <button type="button" className="add-link" onClick={() => goSettings("agents")}>
                Settings → Agents
              </button>{" "}
              says how it stands.
            </p>
          )}
          {needsT3 && (
            <>
              <p className="add-note">
                {k?.label} is one of this computer's agents. They run from one program (T3) that Foundation starts and stops; it's off{t3 === "error" ? `: ${host?.detail ?? "it failed to start"}` : t3 === "starting" ? ", and starting…" : "."}
              </p>
              <button type="button" className="f-pill is-accent" disabled={busy === "t3" || t3 === "starting"} onClick={startT3} data-add-start-t3>
                {busy === "t3" || t3 === "starting" ? "Starting…" : "Start this computer's agents"}
              </button>
            </>
          )}
          {needsAdding && Object.keys(presets).length > 0 && (
            <T3AddForm
              presets={presets}
              local={local}
              start={{ preset: k!.preset, where: kind === "local" ? "local" : where }}
              busy={busy === "form"}
              error={formError}
              onWhere={(w, baseUrl) => {
                setWhere(w);
                if (w === "local") {
                  setLocal(null);
                  void api<T3Local>(`/api/t3host/local?base=${encodeURIComponent(baseUrl)}`).then(setLocal).catch(() => setLocal({ baseUrl, up: false, models: [] }));
                }
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
          )}
          {needsSignIn && kind !== "claude" && (
            <>
              <p className="add-note">
                {found!.name} is on this computer but {found!.why ?? "isn't ready"}.{" "}
                {t3Agent?.state === "sign-in" ? (
                  <>
                    Sign it in here, in a terminal on this computer{k?.signIn ? (
                      <>
                        : <code>{k.signIn}</code>
                      </>
                    ) : null}
                    . Foundation can't do that for you yet; it shows up here as soon as it's done.
                  </>
                ) : t3Agent?.state === "missing" ? (
                  <>Install {k?.program ?? found!.name} on this computer, then sign it in.</>
                ) : null}
              </p>
              <button type="button" className="f-pill" onClick={() => void refreshAvailable()}>
                Check again
              </button>
            </>
          )}
          {!connected && !needsT3 && !needsAdding && !needsSignIn && kind !== "claude" && kind !== null && !found && (
            <p className="add-note">
              {PROVIDER_NAME[kind]}'s program isn't on this computer ({k?.program ?? "its agent"}). Install it and sign in; it appears here by itself.
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
