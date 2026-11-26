# The agent harness

How an agent gets a seat on a council, runs, shows its work, and reaches the grid's tools. The contract for `apps/server/src/agent.ts`, `agentkinds.ts`, `codemode.ts`, `mcp.ts` and the council's client.

## 1. Kinds of agent

What a seat is comes from the server's own knowledge of it, never from a request. `AvailableAgent.kind` and `PostedAgent.kind` say which:

| kind | key | Runs as | Who pays | Reaches the grid by |
|---|---|---|---|---|
| `claude-account` | `claude` | Claude Code (`claude -p`) started by the Foundation server on its computer, on that computer's Claude sign-in | the Claude plan signed in there | Foundation's MCP |
| `claude-api` | `claude-api` | Foundation's own loop on the Anthropic Messages API | the API key an admin stored (encrypted at rest, never returned or logged) | the tool surface directly |
| `claude-federated` | `claude-fed` | the same loop, with a short-lived token exchanged from the organization's identity provider | the organization's Anthropic workspace | the tool surface directly |
| `t3` | `t3:<id>` | a T3 Code session Foundation's T3 host starts (Claude, Codex, Gemini, Kimi, DeepSeek, local models) | whatever that T3 agent is signed in to or keyed with | Foundation's MCP, for Claude-driven agents only |

A Claude Code session a person runs themselves (a terminal, the desktop app) is none of these: it is an **MCP client**. It connects with a token the person mints (§4) and acts as that person's agent.

### Routes (all need a signed-in person; changes need an admin)

- `GET /api/agents/claude` → `{ account: { installed, version?, signedIn: true | false | "unknown", why? }, api: { configured, source: "stored" | "env" | null, last4?, model }, federated: { configured, why? } }`
- `PUT /api/agents/claude/key` `{ key }` → checks the key against Anthropic's model list before storing it. `DELETE … { confirm: true }` forgets it.
- `GET /api/agents/claude/models` → `{ models: [{ id, name, created? }], source: "live" | "builtin" }`, newest first.
- `PUT /api/agents/claude/model` `{ model }` → the default for `claude-api` seats; a seat may carry its own `model`.
- `GET /api/agents/available` gains `kind` and, for each agent, `runs` (one sentence: where it runs and who pays). It always lists `claude`, `claude-api` (`model`: the default) and `claude-fed`, each `ready` or with its `why`. A `claude-api`/`claude-fed` seat carries no `model` of its own when seated, so it follows the default.
- `GET /api/agents/claude/federation` (admin) → `{ federated: { configured, source: "stored" | "env" | null, why?, organizationId?, federationRuleId?, serviceAccountId?, workspaceId?, identityTokenFile? } }`. `PUT …` `{ organizationId, federationRuleId, serviceAccountId?, workspaceId?, identityTokenFile }` sets it; `DELETE … { confirm: true }` forgets it. Ids and a path only: the identity token is read from that file (the identity provider keeps it fresh) on each exchange, and exchanged at Anthropic's `/v1/oauth/token` (jwt-bearer; the SDK's `oidcFederationProvider`) for a bearer held in memory until it nears expiry. The server's `ANTHROPIC_FEDERATION_RULE_ID` / `ANTHROPIC_ORGANIZATION_ID` / `ANTHROPIC_IDENTITY_TOKEN_FILE` (or `ANTHROPIC_IDENTITY_TOKEN`) / `ANTHROPIC_SERVICE_ACCOUNT_ID` / `ANTHROPIC_WORKSPACE_ID` count as source `"env"`.
- `POST /api/agent` names its seat by `seat` (the seat's id) or `as` (the name it goes by); the run's runtime is that seat's kind (`claude` → subscription, `claude-api` → api, `claude-fed` → federated); a `runtime` in the body is not read. No seat: the server's default (Claude Code when it's installed, else the API key, else federation). A T3 seat → 409 (ask it through `/api/t3host/threads`).
- `ANTHROPIC_BASE_URL` points the API runtimes, the model list and the token exchange at a stand-in (tests).

## 2. A run, as others see it

A run is a crew member on the grid's awareness (`CrewState.crew`). Beside `doing`, it carries:

- `plan`: `CrewPlan | null` — the goal and at most 8 steps (`pending | active | done`), from `set_plan`.
- `thought`: the latest of its reasoning, at most 200 characters.
- `started`: when the run began.

So the card over an agent's head is the same for everyone on the grid. The asker's stream (`AgentEvent`) also carries `{ type: "thinking", text }` with the reasoning in full, kept in the run's transcript.

A run that says nothing for `FOUNDATION_AGENT_SILENCE_MS` (90 s) ends with an `error` that names the likely cause (the sign-in has expired, the CLI is waiting on a prompt) and what its error output said. The clock stops while one of Foundation's own tools is running for it (a person's Run press is our silence, not the model's). A lost sign-in on Claude Code's error output is said at once; a Foundation MCP that Claude Code reports `failed` stops the run (it would otherwise only talk).

**What the grid never sees.** From the moment a run calls a tool that reads beyond the board (`PRIVATE_READS` in `crew.ts`: chat_read, chat_search, chat_channels, slack_read, search, flowform, huddle_transcript, replay_timeline, today, read_file, places, bring_file, browser_read, browser_tabs, desktop_screenshot, find_images, read_repo, find_repo, company, read_collection, call_app_tool, app_tools), directly or as an inner call of `run_code` (each goes through `runTool`, which names its step to the crew), its presence's `thought` is cleared and stays empty until the run ends. `doing` carries no free text of the model's own (a `focus` note reads "pointing it out"), and `bring_view` loses its note. Its status still says it is thinking. The full reasoning goes on only to the asker's own event stream and the run's transcript. A DM's words, or the model's thoughts about them, reach only the DM's members. `read_timeline` (a grid's timeline as lines, `READ_TOOLS`; apps/server/src/timeline.ts) is not in `PRIVATE_READS` because most of it is the grid's own, but when its answer carries a conversation's words or an agent's answer it marks the run private itself (`markPrivate`); and a run's own answer on the timeline follows the same flag: shown to the grid only if the run never went private.

`doing` goes "reading the ask" → "thinking" (and "writing its answer" as words come) → a line per tool step. `thought` is written at most every 250 ms and cleared when the run ends. Claude Code is run with `--include-partial-messages --thinking-display summarized` (2.1.331; without the latter a `-p` run's thinking arrives empty); a CLI that rejects them is run again without. The API runtimes ask for `thinking: { type: "adaptive", display: "summarized" }` (4.7+/5.x), adaptive on 4.6, a budget on older models.

## 3. Code mode

Two tools on the one tool surface (`apps/server/src/codemode.ts`), both in `READ_TOOLS`:

- `search_tools { query, limit? }`: the best matches (token scoring over names, descriptions and argument names; `limit` 1–20, default 5) as `{ matches: [{ name, description, signature }], more }`. `signature` is a TypeScript declaration printed from the tool's input schema (`add_table(args: { section?: string; name: string; … }): Promise<unknown>`). An empty query gives `{ categories: [{ name, count, tools }], top }`. `toolApiDts()` gives the whole surface as one `.d.ts`.
- `run_code { code, request_id? }`: the script is the body of an async function. Inside, `foundation.<tool>(args)` (every tool but `run_code`) returns a promise of that tool's result as JSON, and a failed call rejects with the tool's own message; `console.log` is kept. Returns `{ result, logs, calls: [{ tool, ok, summary }] }`, or on any failure `{ error: { message, line? }, logs, calls }` with what ran before it (never a thrown error).

**The sandbox.** Each script gets a worker thread of its own (`codemode-worker.mjs`, empty environment, no loaders) holding a fresh WebAssembly instance of QuickJS (`quickjs-emscripten-core` with the release-sync variant: no asyncify). Inside: no `require`, `process`, `fetch`, timers, `import()`, filesystem or network; the host functions are closed over by `foundation` and `console` and never left on the global. Only JSON strings cross, both ways; a tool's picture (`_image`) is left out. Limits: 20 s (an interrupt inside, and the worker is terminated at the deadline), 32 MB of QuickJS heap, 256 KB of QuickJS stack, 40 tool calls, 64 KB of code, 256 KB of result, 1 MB per tool answer, 200 log lines, 4 scripts at once per server and 2 per person (past either, a `busy:` refusal). At the deadline no new tool call starts, and the answer (and the script's slot) waits for the calls already running, up to 10 s more; past that the error names each call still running, since its change may land after the answer. A loop never holds up the server: it spins in its own thread. `node scripts/measure-tools.mjs` measures the tool lists.

**The rules hold inside.** Every inner call goes through `runTool` with the caller's own `ToolCtx`: the board is the caller's, a viewer's writes are refused (so a viewer may call `run_code`, and reads), the external-send gate and an agent's `asked` rows are the tool's own, deletes still need `confirm`, and each call is audited and in the board's activity under the caller's name as it would be alone. The routes' person-only actions (`requirePerson`) aren't tools, so no script reaches them. `run_code` is itself one audit row (its arguments' hash and length, never the code).

**Idempotency.** `runTool` replays a `request_id` only for the same tool (and, for `run_code`, the same script: its key carries the code's hash). Inside a script, a call with no `request_id` of its own gets `<outer>:<hash>:<n>` (the script's id, the first 12 hex of its code's sha256, the n-th call in call order), so re-running the same script doesn't write twice, and a changed script under the same id is a new request that never takes another script's results for its own. A script that succeeded replays its result; one that failed is not replayed: it runs again, and the writes that landed the first time return their first result.

`/mcp?…&mode=code` lists only `CODE_MODE_TOOLS`: `search_tools`, `run_code`, `read_board`, `read_card`, `set_plan`, `point_at` and `bring_view`; a direct call to any other tool is refused with a sentence pointing to `run_code`. Without `mode` nothing changes. `GET /api/capabilities` says `codeMode: true`.

**Foundation's own runs.** `FOUNDATION_AGENT_TOOLS` (`all` by default, or `code`) decides whether a `claude-account` run's MCP address carries `&mode=code`, and whether the API loop is given every tool or only the code-mode ones. `read_card` is among those because reading one card in full is a single read the model needs to see before it decides anything, and going through `run_code` for it costs a round trip. The default stays `all`: on a real one-write turn, code mode was correct but slower and wrote more (docs/evidence/2026-11-24_council-harness/REAL-TURN.md).

## 4. Connecting an MCP client

`POST /api/agent/token` (a person) mints a 7-day token. Then, for Claude Code:

```
claude mcp add foundation --transport http "<server>/mcp?board=<grid>&mode=code" --header "Authorization: Bearer <token>"
```

The token is shown once, is stored hashed and never travels in a URL.
