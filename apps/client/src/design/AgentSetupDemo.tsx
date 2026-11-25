/**
 * #/design → Agent setup (2026-11-24): the add flow's kinds, Claude's three ways each with one line saying
 * how it stands, the API key (stored, refused, Forget… asked in place), the model list, federated identity
 * (the form, set, Remove… asked in place, a non-admin), an older server, and connecting a Claude Code you
 * run yourself (default and code mode). At 260, 400 and 560 px (DESIGN principle 7).
 */

import { CLAUDE_WAYS, KindList, WayCard } from "../shell/AddAgent";
import { ClaudeKeyView, ClaudeModelPickerView, FederationView, McpConnectView, OLDER_WORDS, Readiness, wayState } from "../shell/AgentSetup";
import type { ClaudeModels, ClaudeStatus, FederationState } from "../lib/claudeAgents";

const FED_WHY = "Federated identity isn't set up. An admin gives Foundation the organization's id, the federation rule (fdrl_…) made for this server in the Claude Console (Settings → Workload identity), optionally its service account and workspace, and the file this server's identity provider keeps its token in.";
const STATUS: ClaudeStatus = {
  account: { installed: true, version: "2.1.4", signedIn: false, why: "run `claude` once in a terminal here" },
  api: { configured: true, source: "stored", last4: "x7Qa", model: "claude-opus-5-5" },
  federated: { configured: false, why: FED_WHY },
};
const AGENTS = {
  account: { ready: false, service: "Claude Code isn't set up on the server" },
  api: { ready: true, service: "the Anthropic API, on Foundation's key (claude-opus-5-5)" },
  federated: { ready: false, service: "the Anthropic API, once federated identity is set up", why: FED_WHY },
};
const MODELS: ClaudeModels = {
  source: "live",
  models: [
    { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
    { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
  ],
};
const FED_SET: FederationState = { configured: true, source: "stored", organizationId: "6b5af527-c7f3-45d6-98e5-62dbdc91afcf", federationRuleId: "fdrl_01HqK7", workspaceId: "wrkspc_xyz789", identityTokenFile: "/var/run/secrets/anthropic/token" };
const URL_ = "http://localhost:4410/mcp?board=company";
const TOKEN = "fnd_9c1e…d07a";
const COMMANDS = { plain: `claude mcp add foundation --transport http "${URL_}" --header "Authorization: Bearer ${TOKEN}"`, code: `claude mcp add foundation --transport http "${URL_}&mode=code" --header "Authorization: Bearer ${TOKEN}"` };
const kindWords = (id: "claude" | "t3") => (id === "claude" ? { ok: true, words: "ready" } : { ok: false, words: "T3 is off" });

function Flow({ open }: { open: "api" | "federated" }) {
  return (
    <div className="add-agent">
      <KindList kind="claude" words={kindWords} />
      <div className="add-connect">
        {CLAUDE_WAYS.map((w) => {
          const st = wayState(w.id, AGENTS[w.id], STATUS);
          return (
            <WayCard key={w.id} id={w.id} title={w.title} what={w.what} ok={st.ok} state={st.short} on={w.id === open}>
              <Readiness {...st} />
              {w.id === "api" ? <ClaudeKeyView api={STATUS.api} admin /> : <FederationView fed={{ configured: false, source: null, why: FED_WHY }} admin />}
              <ClaudeModelPickerView list={MODELS} value="claude-opus-5-5" />
            </WayCard>
          );
        })}
      </div>
    </div>
  );
}

export function AgentSetupDemo() {
  return (
    <div className="sec-crew-demo">
      <div className="adapt-row">
        {[260, 400, 560].map((w) => (
          <div key={w} className="agents-pane-specimen is-tall" style={{ width: w }}>
            <div className="agents-scroll">
              <Flow open={w === 400 ? "federated" : "api"} />
            </div>
          </div>
        ))}
      </div>
      <div className="adapt-row">
        <div className="agents-pane-specimen is-tall" style={{ width: 400 }}>
          <div className="agents-scroll add-agent">
            {CLAUDE_WAYS.map((w) => (
              <Readiness key={w.id} {...wayState(w.id, AGENTS[w.id], STATUS)} />
            ))}
            <ClaudeKeyView api={{ configured: false, source: null, model: "claude-opus-5-5" }} admin error="Anthropic didn't accept that key (401 invalid x-api-key)." />
            <ClaudeKeyView api={STATUS.api} admin askingForget />
            <ClaudeKeyView api={{ configured: true, source: "env", last4: "b21F", model: "claude-opus-5-5" }} admin={false} />
            <ClaudeModelPickerView list={{ ...MODELS, source: "builtin" }} value="claude-sonnet-5-5" disabled />
          </div>
        </div>
        <div className="agents-pane-specimen is-tall" style={{ width: 400 }}>
          <div className="agents-scroll add-agent">
            <FederationView fed={FED_SET} admin />
            <FederationView fed={FED_SET} admin start="asking" />
            <FederationView fed={{ configured: false, source: null }} admin error="organizationId: the organization's id, a uuid (Claude Console → Settings → Organization)." />
            <FederationView fed={null} admin={false} />
            <p className="setup-older">{OLDER_WORDS}</p>
          </div>
        </div>
        <div className="agents-pane-specimen is-tall" style={{ width: 400 }}>
          <div className="agents-scroll add-agent">
            <McpConnectView commands={null} onClose={() => {}} />
            <McpConnectView commands={COMMANDS} />
          </div>
        </div>
      </div>
    </div>
  );
}
