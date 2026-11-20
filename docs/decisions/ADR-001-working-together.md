# ADR-001 — One way for our apps, engines and agents to work together

2026-11-18. **Status: accepted by Josh on 2026-11-18, with every recommendation in §12 taken as written. Slices 1 and 2 are built. A security pass on Foundation followed the same day.** Slices are built in the order of §13; this file says what was decided, and SPEC §3 says what is built.

Josh asked for a general protocol so Foundation, Vision, HomeForm and what follows can use each other's tools: built on AG-UI, with MCP- and A2A-like infrastructure, engines consolidated and well visualized, chains of reasoning shown to people, local and cloud both, ours told clearly apart from external services, security considered, and all of it visible in Foundation.

Companion files:
- [mockups.html](ADR-001/mockups.html): the visualization mock-ups (mock-ups, not built).
- [ADR-001/README.md](ADR-001/README.md): what else was written for this decision and why it is not in the public repository (the inventory of the repos, a second critique, and the entries proposed for the other repos' backlogs). `docs/SECURITY.md` has the rule.

No other repo was edited from this one.

Related: Vision's `docs/decisions/ADR-174.md` (AG-UI as the contract between Vision's agents and its interface, shared with Foundation). This ADR extends it and proposes one change to it: ADR-174 §4's "a bearer token a person mints" becomes an enrolment a person makes plus a short-lived mandate per call (§6). That change needs Vision's agreement.

This is the second draft. The first was reviewed by an independent critic who rated its delegation model 2 of 5 and its injection defence 1 of 5, with eight blocking findings. All eight are accepted and answered here; §15 lists them.

## 1. The decision in short

1. **No new protocol.** AG-UI carries a run to a person. MCP carries a call to a tool or engine. A hand-off between two of our agents is an AG-UI run started in the other app, shown in the caller's stream as an AG-UI subagent. A2A is adopted for its Agent Card now and for its task transport only at the boundary with agents that are not ours, later.
2. **What we add is four small things, each inside the standards' own extension points:** an origin stamp, a chain id, a mandate (who asked, through whom, with what ceiling) and a reach label (how far a piece of data may travel).
3. **Where something ran is assigned, never claimed.** A person enrols each participant in Foundation's registry; the receiver of an event stamps its origin from the authenticated link. A name or a self-description never decides it.
4. **Permission is decided by the app that owns the thing, for the weakest link in the chain.** A call made through three agents gets what the least-trusted of them would get directly, and no more. Grants are set on the owning app's own screen. Approvals are answered only in the owning app, on its own screen, never over the wire.
5. **Outside content stays marked wherever it goes.** Anything a run reads from an external or unknown source marks that run, everything it produces, everything it stores and every run it hands off to. A marked run cannot use tools that send data out, act on the house or spend.
6. **Foundation is the registry and the place to watch. It is not in the call path.** Enrolled apps call each other directly and keep working when Foundation is off.
7. **Foundation's own person gate is made real before anything cross-app is built** (§9). When this was written, "a person" could be imitated on the machine, an agent's token could start work only a person should start, and an agent could choose the address of an app's tools. Slices 1 and 2 closed those.
8. **The first chain is an engine call, not an agent hand-off** (§12 Q1): Foundation's agent asks Vision for a part from SolidCraft through a door Vision owns. Agent-to-agent hand-off into Vision waits until Vision has a tool door it controls (its ADR-174 S7).

## 2. What exists today, and where the brief was wrong

The full inventory is kept off the public repository ([why](ADR-001/README.md)). What changes the design:

| Brief said | Found |
|---|---|
| Foundation uses AG-UI; has `POST /api/agui` and `docs/agui.md` | `packages/protocol/src/agui.ts` is an untracked file nothing imports. The route and the doc do not exist. The live wire is the older `AgentEvent` stream. Another session's uncommitted work is in this checkout; this session left it alone. |
| No AG-UI found in Vision | On Vision's `main` since today: `@pacific/agui` (thread model, reducer, conventions), a T3 adapter, and ADR-174, which already fixes a contract with Foundation: `plan` and `approval` activities, loopback ports 4410 (Foundation) and 4420 (Vision), a bearer a person mints. In-process only so far; Vision serves no AG-UI endpoint yet. |
| HomeForm's `hubd` is an MCP policy proxy | `hubd` is a stub README. The `mcp` cargo feature is empty. HomeForm has no MCP server, client or SDK. Its tools are five OpenAI Realtime function tools. |
| Tiers T0–T2 | Four tiers, T0–T3 (T3 is configuration: draft only, a person applies). |
| — | HomeForm's permission tiers, and how they are enforced, are HomeForm's own; what this design needs from them is in HomeForm's backlog. |
| Creation: a local agent (Form), a Blender bridge, companion tools (added by the second critique) | The Creation Hub is a fourth agent runtime and key vault, and `creation-live` is a fifth hand-written MCP server. It has no AG-UI and no link to the other apps. A private project is already a reach label (`this-machine`). It is `GPL-3.0-only`. |

The standards, read from source on 2026-11-18:

| | Version | What it gives us | What it leaves to us |
|---|---|---|---|
| AG-UI | spec 1.0, `@ag-ui/core` 1.0.5 (MIT) | 31 events; `metadata` on every event (vendor-prefixed keys); first-class subagents (`SUBAGENT_*`, `subagentRunId`); `parentRunId`; interrupts and resume; `usage` on the terminal event | No agent identity, origin or signature field. Auth belongs to the transport. |
| MCP | revision 2026-07-28 (Apache-2.0) | Stateless streamable HTTP; `_meta` with reverse-DNS keys; reserved `traceparent`; OAuth 2.1 with audience-bound tokens and no token passthrough; tool annotations as hints only | No origin or trust label on results. No delegation chain. No model for stdio or LAN auth. No prompt-injection model. Registry checks namespace ownership only. |
| A2A | v1.0.1 (Apache-2.0) | Signed Agent Cards; tasks with `INPUT_REQUIRED` / `AUTH_REQUIRED`; `metadata` on messages, parts, artifacts; extensions declared on the card | No field for where an agent runs. No on-behalf-of model. No LAN discovery. Opaque by design: an agent's reasoning is not shared. |

All three say the same thing in different words: origin, delegation and untrusted content are the implementer's job. That is the work of this ADR.

## 3. How the three protocols divide the work

| Between | Protocol | Rule |
|---|---|---|
| An agent and a person | **AG-UI** | Every agent in every app is drawn from AG-UI events. ADR-174's conventions stand. |
| An agent and a tool or engine | **MCP** | Every engine is reached as an MCP server: SolidCraft, ClassCAD, cadq, Foundation's board tools, HomeForm's HOME tools once `hubd` exists. One tool definition shape (JSON Schema, a read/write kind). |
| One of our agents and another of our agents | **AG-UI, as a subagent** | The caller starts a run in the other app (`RunAgentInput`, `parentRunId` set). The callee's events come back and are relayed in the caller's stream under `SUBAGENT_STARTED` … `SUBAGENT_FINISHED`, each still carrying its own origin. The chain reads as one stream. |
| Our agents and agents that are not ours | **A2A, at the boundary** | Later, and only if wanted (§12 Q2). A gateway in Foundation translates an A2A task to a run and back. External agents get the lowest ceiling. |

Why not A2A between our own apps: A2A is opaque on purpose (agents "collaborate without needing to share their internal thoughts, plans, or tool implementations"), and Josh asked for the opposite between our own. AG-UI between our apps is already agreed in ADR-174, is already half built on both sides, and adds no third SDK.

What we add, and where it rides:

| Addition | AG-UI | MCP | A2A (when used) |
|---|---|---|---|
| **Origin** (§5) | `metadata["co.normallab"].origin` on every event | `_meta["co.normallab/origin"]` on results and content blocks | `metadata` on Message, Part, Artifact; on the card, a declared extension's `params` (covered by the card signature) |
| **Chain id** (§7) | `metadata["co.normallab"].chain`, plus `parentRunId` | `_meta.traceparent` (reserved by MCP for this) | W3C `traceparent` header |
| **Mandate** (§6) | `Authorization: Bearer` on the run request | `Authorization: Bearer` on HTTP; none on stdio (the engine is inside its app's boundary) | `Authorization: Bearer` |
| **Reach** (§8) | `metadata["co.normallab"].reach` | `_meta["co.normallab/reach"]` | part `metadata` |

`co.normallab` is the prefix both Vision and HomeForm already use for their keychain entries. Confirm it, or name another (§12 Q5).

## 4. Registry and manifest

**Grow `/.well-known/foundation.json`; do not replace it with an Agent Card.** Reasons: it exists; an engine is not an agent and has no honest Agent Card; neither A2A's card nor MCP's server card has a place for what we most need to say. Where a standard card exists, the manifest links to it and repeats nothing.

Manifest, version 2 (the v1 fields stay valid):

```json
{
  "manifest": 2,
  "name": "Vision",
  "description": "…",
  "repo": "…",
  "key": "ed25519:…public key…",
  "participants": [
    { "id": "vision.agent", "kind": "agent", "name": "Vision Agent",
      "code": "ours",
      "uses": ["t3code", "anthropic", "vision.solidcraft", "vision.classcad"],
      "agui": "http://127.0.0.1:4420/agui" },
    { "id": "vision.solidcraft", "kind": "engine", "name": "SolidCraft / SolidCore",
      "code": "third-party", "pin": "v0.40.0-rc.3", "licence": "MIT OR Apache-2.0",
      "mcp": "stdio (inside Vision)", "sends": "nothing" },
    { "id": "anthropic", "kind": "service", "name": "Anthropic",
      "sends": "prompts, tool results" }
  ],
  "cards": { "a2a": null, "mcp": null }
}
```

- `kind`: `app`, `agent`, `engine`, `service`.
- `code`: `ours` or `third-party`, with `pin` and `licence` when third-party.
- `uses`: the participants this one depends on. An agent of ours that thinks with an external model says so here, and the map draws that edge.
- The manifest is a **claim**. It tells Foundation what to ask a person about. It decides nothing by itself.

**Enrolment.** A person, in Foundation, presses Enrol on a discovered or typed address. The other app shows a short code on its own screen; the person types it into Foundation (or scans it). Foundation stores the app's public key, who enrolled it and when, and, per participant, the class the person confirmed (§5) and a hash of each MCP server's tool list. From then on:
- a participant whose key does not match is shown as unknown and gets nothing;
- a tool list that changes is shown as changed and its new tools are off until a person looks (this is the defence against a server that changes its tool descriptions after approval);
- each enrolled app keeps a signed copy of the registry so it can check its peers when Foundation is off.

Foundation's existing `apps` table grows into this registry (plan cards `app-registry` #48 and `foundation-json` #49 are the natural homes).

## 5. Provenance: where it ran, on everything

Two facts, carried separately, both in the data:

| Fact | Values | Shown as |
|---|---|---|
| **Where it runs** (so, where the data is) | `this-machine` · `our-network` · `our-cloud` (with `host`, e.g. Supabase) · `external` (with the service's name) | "Ours · this machine", "Ours · our network", "Ours · our cloud · hosted by Supabase", "External service · Anthropic" |
| **Whose code it is** | `ours` · `third-party` (with pin, or "not pinned") | nothing for ours; "third-party code · pinned 0.0.44"; "third-party code · not pinned" as a warning |
| **Which model thought it**, if any | the model's name, where it runs, whose it is | "model: Anthropic · external service"; "model: D-FINE-S · this machine · third-party model" |
| **Touched by outside content** | `outside: true` once anything from an external or unknown source has been read | "includes outside content" |

The second fact matters because much of what runs on our machines is not ours: T3 Code under the Vision Agent, SolidCraft, ClassCAD's WASM, the Home Assistant fork. Their data stays put; their code is still something we brought in. The same goes for model weights we run locally.

The stamp:

```json
"co.normallab": {
  "origin": { "participant": "vision.agent", "runs": "this-machine", "code": "ours",
              "model": { "name": "anthropic", "runs": "external" },
              "outside": true, "stampedBy": "foundation" },
  "chain": "4bf92f3577b34da6a3ce929d0e0e4736",
  "reach": "ours"
}
```

Rules:
1. **The receiver stamps who sent it.** When events arrive over a link, the receiving app writes `participant`, `runs` and `code` from the enrolled identity of that link and discards whatever the sender wrote there. An app stamps its own events itself.
2. **A receiver may only lower trust, never raise it.** The sender's `outside: true` is kept. The receiver can add it; nobody can remove it. So content the Vision Agent read on a web page and repeated in its answer arrives in Foundation as "Vision Agent · ours · this machine · includes outside content", not as clean.
3. **The mark is on content, and it is stored.** Whatever a run writes (a board object, a file, a HomeForm draft, an artifact) is saved with its origin and its `outside` mark. Reading a marked thing marks the reader. For Foundation this is a field on board objects in the one board schema (`packages/protocol`); objects with no origin, which is every object today, read as unknown.
4. **What an app says about its own insides is marked as its word.** Vision saying "this result came from SolidCraft" is stamped `stampedBy: "vision"`. The UI can say "per Vision".
5. **Model output names the model.**
6. **No stamp, no trust.** An event with no origin, or an unknown participant, is drawn as "Unknown origin" and treated as external and outside.
7. **Every UI shows it as words plus a mark**, on every participant and every row of a chain. Never colour alone. The shared badge is specified once (§10) and each app draws it in its own design system.

## 6. Permission across apps: the mandate

Each cross-app call carries a mandate: a short-lived token the caller signs with its enrolled key, addressed to one callee.

```
iss     the calling participant           aud   the one callee
exp     minutes, not days                 jti   once only
chain   the chain id; a mandate is good for that chain and no other
sub     the person who asked, as the app where they asked states it
act     the agents the request has passed through, nested, newest outside
        (the claim shape of RFC 8693 token exchange, not an invented one)
may     what the caller is asking to be allowed (a ceiling, not a grant)
outside true if the calling run includes outside content (§5)
```

Rules:
1. **The owner decides.** The callee's own policy runs, as it would for a direct request. Nothing in a mandate can raise a tier or a role.
2. **Grants live in the callee and are set on its own screen.** At enrolment, and later, a person at the callee decides what each caller may do there. Foundation's registry records that an app is enrolled; it does not hold another app's grants.
3. **Weakest link.** What the call may do is the intersection of the callee's grant for each participant in `act`, the callee's grant for the root app, and `may`. A caller with no grant gets nothing; there is no default tier.
4. **`sub` is the root app's word, and is trusted no further than the root app.** The callee does not read "Josh, admin". It reads "a person at Foundation, which Foundation says is Josh", and applies what a person at the callee granted to requests arriving from Foundation. A compromised or buggy app can therefore do no more than that app was granted, whatever it writes in `sub`.
5. **The ceiling belongs to the run and is enforced at the tool door, in code.** A run started by a mandate carries that ceiling for its whole life. Every tool call inside it is checked by the tool runner. The model is never the one enforcing it. This is what stops agent A, refused directly, from talking agent B into doing it: B's run for A has A's ceiling. **Where an app has no tool door it controls, it takes no hand-offs.** That is Vision's agent today: its tools run inside a third-party runtime, and Vision's own ADR-174 plans the door (its S7).
6. **The outside mark travels.** A run started by a mandate with `outside: true` starts marked.
7. **Approvals never travel.** A pending approval may be shown elsewhere and is answered only in the app that owns the resource, on that app's own screen. There is no message, tool or token that means "the person approved". When a callee's run stops to ask, the caller shows it as waiting and does **not** end its own run as an AG-UI interrupt on the callee's behalf, because an interrupt on the caller would be answered to the caller (§7).
8. **No passthrough.** A callee that must call onward mints its own mandate with the previous caller nested in `act`. It never forwards a token it was given (MCP forbids this too). One received mandate authorises a bounded number of onward calls, all on the same chain.
9. **What is left behind keeps its ceiling.** A draft, card or file written under a ceiling is stored with its chain and origin (§5.3). Acting on it later does not launder it: HomeForm's Apply screen lists every T2 service inside a draft and asks for the T2 confirmation for them.
10. **A refusal is recorded with its chain** in the owner's ledger (§9, audit).
11. **Anything can be stopped.** Each app can stop every run on a chain, and un-enrol a caller, from its own screen. Stopping in one app tells the others on the chain.

Not designed here, to be settled in the slice that builds mandates: how long clocks may disagree (the hub and a desktop will), where used `jti`s are remembered across a restart, key rotation and re-enrolment after a reinstall.

How each app's tiers survive:

| Owner | Its rule today | A call arriving with a mandate |
|---|---|---|
| Foundation | Roles admin / member / viewer per board; `requirePerson` for anything that spends or runs third-party code | Is an `agent` session, capped at the role of the person in `for`, further capped by the caller's grant. `requirePerson` routes stay person-only. |
| HomeForm | T0 read · T1 reversible · T2 opens the house (slide or PIN) · T3 configuration (draft, a person applies) | Nothing by default. A person at the house grants a caller named tools and named entities. T0 is not granted as a whole: it includes looking through cameras and reading presence, which a caller with a cloud model would send out of the house. T1 only if granted; T2 only ever surfaces the card at the house; T3 only ever makes a draft, and the draft is checked again at Apply (§6.9). A remote request has no way to state that a person confirmed. |
| Vision | Director-only review events; Supervised threads; nothing paid implicitly | A run started from outside waits for a press in Vision before its first turn and cannot choose a paid route (ADR-174 §4, unchanged). |
| Creation (added by the second critique) | Private projects use no agents and no outside services. Agent output is a proposal the owner accepts. Paid calls need a press. | Nothing by default. A private project is never reachable. What a call produces is a proposal, accepted on Creation's screen. A mandate can never choose a paid route. |

**HomeForm takes inbound calls only through `hubd`, and `hubd` does not exist.** Until it does, HomeForm can ask others for things and can be watched; nothing outside it can call its tools. This is deliberate, not a gap to work around.

## 7. Human-visible reasoning: one vocabulary

| Word people see | Means | Carried as |
|---|---|---|
| **Chain** | Everything that followed from one request by one person, across apps | the chain id (a W3C trace id) on every event and call |
| **Run** | One agent's turn at it | AG-UI `RUN_STARTED` … `RUN_FINISHED`; `parentRunId` names the run that asked |
| **Plan** | The agent's goal and steps | activity `plan` (ADR-174) |
| **Step** | One thing in the plan | a plan step; `STEP_STARTED` / `STEP_FINISHED` for timing |
| **Thinking** | The agent's reasoning | `REASONING_*`, stamped with the model that produced it |
| **Tool call** | An agent using a tool or engine | `TOOL_CALL_*`; the result carries the engine's origin |
| **Hand-off** | One agent asking another | `SUBAGENT_STARTED` (with `parentToolCallId`) … `SUBAGENT_FINISHED`; the callee's events relayed with their own origin. The callee's run-level events (`RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR`) cannot carry `subagentRunId` in 1.0.5, so they are not relayed: its outcome and usage go in `SUBAGENT_FINISHED.result`, and a callee that stops to ask is shown as an `approval` activity marked display-only. To be proven against both reducers before it is relied on. |
| **Waiting for you** | A person is being asked | activity `approval` mid-run; `RUN_FINISHED` outcome `interrupt` when the run ends on a question. Carries where it can be answered. |
| **Left our machines** | Data went to an external service | a marker the sending app emits (custom event `co.normallab.egress`): which service, what kind of data, how much, who approved |
| **Cost** | Tokens and money | `RUN_FINISHED.usage` for tokens; `metadata["co.normallab"].cost` = `{usd, estimated, payer}`; summed over the chain |

Hand-offs to an external A2A agent, if we ever have them, show only what A2A lets through (status, messages, artifacts) and say so: "this agent does not share its reasoning".

## 8. Local and cloud

| | Same machine | Our network (house hub, phones, tablets) | Our cloud | External |
|---|---|---|---|---|
| **Find** | Known loopback ports and the manifest; a person enrols | Typed address, or mDNS as a suggestion only; a person enrols with a pairing code | A domain a person adds to the registry | Listed by a person; never discovered |
| **Address** | `127.0.0.1` only; `Origin` checked | Pinned self-signed TLS (HomeForm's pairing design) | HTTPS | HTTPS |
| **Prove who** | Mandate signed with the enrolled key | The same | The same, inside MCP's OAuth 2.1 rules for hosted servers (audience-bound, no passthrough). **Not designed in detail here**; it belongs with the `hosted-server` card. | The service's own key, held where §9 says |
| **Offline** | Works | Works | Shown as unreachable | Shown as unreachable; paid calls are never queued or retried |

**Reach**: every piece of data that could leave carries how far it may go: `this-machine`, `our-network`, `ours` (our machines and our cloud), or `anywhere`. An app's outgoing gate refuses to send data beyond its reach. Data with no label is treated as `this-machine` when the destination is external.

**What this layer never carries out of the house network:** camera frames and stills, presence, wake-word audio, the Home Assistant token, the content of HomeForm's ledger. This is a rule about cross-app calls and watching. It is not a description of everything HomeForm does: its own voice assistant, with a person's consent per session, uses a cloud model, and its per-camera rules are HomeForm's to build and govern. The rule here is that enrolling HomeForm adds no new way out.

**Never leaves the machine:** provider keys, session tokens, keychain entries, signing keys. CAD files and board content leave only when a person sends them.

**Watching.** For Foundation to show a chain it did not start, an enrolled app may send Foundation a copy of its runs' events. Per participant, a person at that app sets how much: `none`, `outline` (event kinds, tool names, timings, origins, costs; no content) or `full`.
- **HomeForm defaults to `none`.** Even an outline tells who is home: a pending unlock means someone is at the door, a voice session means someone is up. If turned on, house rows are readable only by the person who enrolled the house, not by everyone signed in to Foundation (whose rule today is that everyone signed in can read).
- **Rows are keyed by who sent them and the chain.** An app cannot add rows to another app's part of a chain.
- **A hosted Foundation** receives nothing from a participant whose reach is narrower than `ours`.
- **Buttons come from Foundation's own approval store only.** Nothing in a watched event can make an approval answerable in Foundation.

## 9. Security

### What we are protecting

The house (doors, garage, alarm, cameras). Money (model spend, credits). Keys and tokens. Private data (camera frames, presence, Slack, boards, designs). Our code bases. A person's ability to see and stop what agents do.

### Gaps found before any integration, and where they stand

Found by the inventory and two critiques on 2026-11-18. Each is described here in general terms only; the detail is kept off the public repository until a gap is closed (`docs/SECURITY.md`).

| # | What it is | Status |
|---|---|---|
| G0 | Foundation: sign-in by email alone, for local development, was on by default | Closed (slice 1): off unless turned on, and fenced when on |
| G1 | Foundation: starting a job needed a signed-in caller, not a person | Closed (slice 1) |
| G2 | Foundation: starting an agent run needed a signed-in caller, not a person | Closed (slice 1) |
| G3 | Foundation: an app's tools could be called at an address taken from a card, with no person asked | Closed (slice 2): only a saved app's address is dialled, and each tool needs a person's press on first use and after it changes |
| G9 | Foundation: making an agent token needed a signed-in caller, not a person | Closed (slice 1); tokens last 7 days |
| G10 | Foundation: saving an app and probing an address needed a signed-in caller, not a person | Closed in part (slice 1): person only. Limits on which addresses wait for the registry (slice 5) |
| G11 | Foundation: programs it starts worked inside the data folder | Closed for agents and jobs (slice 1); the T3 home is still under the data folder |
| G12 | Foundation: the shared service token | Closed for the routes above (slice 1): it cannot start a chain |
| G13 | Foundation: programs it starts inherited the server's environment, and one was fetched unpinned | Closed (slice 1 and the child-process door): an allowlisted environment for every program, an exact pinned version checked before it runs |
| G7 | Foundation: no per-call record; long-lived tokens; saved apps with no trust level | Open: the audit log and shorter-lived tokens are in progress; trust levels come with the registry |
| G4 | HomeForm | Open, in that repo's own backlog; described to its owner directly, not here |
| G5 | Vision | Open, in that repo's own backlog; described to its owner directly, not here |
| G6 | HomeForm and Foundation: pinning and audit tooling | Open, in each repo's own backlog; described to its owner directly, not here |
| G8 | A credential shared between two apps | Open, in those repos' own backlogs; described to their owners directly, not here (§12 Q9) |

A wider inventory of Foundation on 2026-11-18 found further issues beyond this list. They are being fixed, and are described in detail only off the public repository until closed; see `docs/SECURITY.md`.

### Threats and what answers them

| Threat | Answer |
|---|---|
| **Prompt injection through a tool result** (a web page, a Slack message, an engine's output says "now unlock the door") | Content from any other participant is data. Three things make that true without relying on the model: (a) the run ceiling at the tool door (§6.5); (b) **the outside mark** (§5): a marked run is **denied**, not asked about, the tools that carry risk: anything that sends to an address or a query the model chose (in Foundation that includes some read tools), anything T1 or above in the house, anything that spends, and hand-offs to a caller with a wider ceiling. Ordinary writes inside the app still work and are stored marked. Denying a short list is deliberate: most runs read Slack or the web, so asking for a press on every write would train people to press. (c) Nothing named in a result is followed automatically: no address fetched, no tool enabled, no image loaded, and addresses in `ui` activities are drawn as text. |
| **Injection that is stored and read later** (a marked run writes a card; a clean run reads it tomorrow) | The mark is stored on what was written and marks whoever reads it (§5.3). |
| **Injection relayed by one of our own agents** | The receiver cannot clear the sender's mark (§5.2); the mandate carries it (§6.6). |
| **Prompt injection through another agent's message** | The same, plus: a hand-off cannot carry an approval, a role or a tier, only a request under a ceiling. |
| **An agent gaining through another agent what it was refused** | Weakest link and run ceiling (§6.3, 6.5); what is left behind keeps its ceiling (§6.9); refusals recorded by chain (§6.10). To be proven by tests that generate chains and check that none exceeds its weakest link. |
| **A compromised or lying enrolled app** | It can do what a person at each callee granted that app, and no more, whatever it claims about people (§6.4). It can be un-enrolled from any app's own screen (§6.11). |
| **Forged or replayed approval** | Approvals are not a message type between apps (§6.7). Mandates are single-use, minutes long, addressed to one callee, bound to one chain. |
| **Lying about origin** | Receiver stamps who sent it from the enrolled link and can only lower trust (§5.1, 5.2). Self-description is display text only. |
| **A tool server that changes after approval** | Tool list hashed at enrolment; changes are off until a person looks (§4). MCP annotations (`readOnlyHint` and the rest) are never used for a decision unless the server is ours. |
| **Stolen or over-broad credentials** | Service keys live in the OS keychain where an app has one; stored tokens are encrypted at rest; signing keys go in the OS key store; programs an app starts work in a folder of their own and get no keys they are not given by name. Nothing in a repo, a URL, a webview or an event. One key per app per service. Mandates replace long-lived bearer tokens between apps. |
| **A stolen registry key, or a stale registry offline** | The signed registry copy has a version and an expiry and names revoked keys. A peer offline past the expiry keeps working with what it has and marks its peers "not checked since". Revocation reaches an offline peer only when it is next online; said plainly in the UI. |
| **Enrolling the wrong thing** (a look-alike on the network relays the real app's code) | The code shown is derived from both keys, so a relay shows a different code. Only an admin person enrols. Un-enrolment, re-enrolment after a reinstall, and a second machine are part of the enrolment slice. |
| **Private data sent to an external service** | The outgoing gate, in each app's code where requests leave: the first time a participant sends a kind of data to a service, a person approves that pairing, and it is recorded. Each send emits a "left our machines" marker (§7), which is that app's word and is shown as such. Reach labels refuse what may not go (§8). Paid calls keep their per-launch consent. **The model call is itself a send**: everything in a run's context goes to its model's service, so what a run may read is bounded by where its model runs. |
| **Private data + outside content + a way out, in one run** | The mark removes the way out. |
| **UI sent by a tool or agent that runs code or phones home** | §10: declarative UI only, drawn from our own components; no HTML, no scripts, no remote images. |
| **Local attacks** (another program on the machine calling a loopback port; DNS rebinding from a web page) | Loopback bind, `Origin` check, mandate on every request, no token in a URL. |
| **Bad third-party code, server or model brought into our repos** | Supply chain rules, below. |
| **No one can tell what happened** | The ledger, below, and the chain view. |

### Supply chain: bringing in third-party code, MCP servers and models

1. **Named and approved.** A new dependency, engine, MCP server or model is named in a proposal with its licence and what it can touch, and a person approves it. It then appears in the registry as a participant with `code: third-party`.
2. **Pinned exactly.** A version and, for a binary or container, a hash. No "newest" or moving tag, and no version range for anything in the agent path. Lockfiles committed; installs use the lockfile.
3. **Read before a bump.** The diff between pins is read (by an agent, checked by a person for anything in the agent path) before the pin moves.
4. **Boxed.** A stdio MCP server gets an allowed folder, no keys in its environment it does not need, and no network unless its entry says so. A hosted one gets a token for itself only.
5. **Licence.** MIT, Apache-2.0, ISC and BSD pass. Anything else, and any "brand" or field-of-use term (SolidCraft's is already being held back in Vision), goes to Josh.
6. **Models are dependencies.** Provider and model id pinned; no storing of our data where the provider offers the switch; a change of model is a bump.
7. **Our own tools count.** MCP servers attached to coding sessions (`.mcp.json`, `.codex/config.toml`) can read the repo. They are listed and reviewed like any other.
8. **Checked by machine.** Proposed, each needing approval as a new tool in its repo: `cargo-deny` and `cargo-audit` in HomeForm and Vision; an exact-pin check in each repo's CI.

### Audit

One ledger shape in every app, append-only, each line carrying the hash of the one before:

`time · chain · run · actor (participant) · for (person) · via · tool or action · target · decision (allowed | needs a press | refused) · who pressed · result · cost · origin`

Arguments and results are kept as hashes unless a person turns content on for that participant; HomeForm keeps no prompts or transcripts by default (its existing rule). Each app keeps its own ledger; Foundation shows them together at whatever level each participant's watching allows. A hash chain kept by the process that writes it shows later edits only if someone else holds a recent head, so each app hands its latest head to its peers when they talk.

### What this does not defend against

A program running as the same user on the same machine, with a shell and no sandbox, can read a browser's cookies and most files. The local rules here (loopback, origin checks, mandates, the outside mark) bound what an agent can do through its tools. They do not contain an agent runtime that has been given an unrestricted shell. T3 Code holds keys for several model vendors and runs with one; it is listed as a participant with third-party code for that reason, and which of its threads may have a shell is a setting a person owns.

## 10. Shared UI

**What is shared is the model, not the components.**

- **One package for the conventions, the event reducer, the origin and mandate types and their schemas.** Vision's `@pacific/agui` is the nearest thing to it today, and HomeForm already takes `@pacific/*` from Vision by hash-locked copy. Recommendation: that package becomes the shared one; Foundation takes it the same way and retires its duplicate reducer (`applyAgui`), contributing `AguiWriter` to it. No registry publish and no new third-party dependency (§12 Q4).
- **Components stay per design system.** Vision and HomeForm draw from `@pacific/ui`; Foundation draws on its own tokens. What is shared is a written spec for four pieces so they read the same everywhere: the origin badge, a chain row, the approval card (with "where to answer"), and the "left our machines" marker. Foundation's versions go on `#/design` first, day and night.

**How a tool or agent sends UI**, in order of preference:

1. **Our primitives**: activity `ui` (`note`, `table`, `choice`, `cards`), already in Foundation's draft and ADR-174. They move into the shared conventions so all three apps draw them.
2. **A2UI** (v1.0, Apache-2.0), activity `a2ui-surface`: declarative, no code, drawn only from a catalog of our own components. This is the only form accepted from anything not ours. **Not built and not proposed for a slice yet**: it needs a renderer, which is a new dependency to name and approve when there is a real need.
3. **MCP Apps** (HTML in a sandboxed frame): refused for now. It is third-party code running in our interface.

## 11. Visualization in Foundation

Mock-ups: [mockups.html](ADR-001/mockups.html). They are mock-ups; nothing is wired. To see them with the real tokens and type, run `npm run dev` and open the file through the dev server's `/@fs/` path; opened straight from disk the type falls back to the system font. Screenshots, day and night: `docs/evidence/2026-11-18_working-together/`. The chain shown is the later agent hand-off (slice 12); the first chain to be built is an engine call and has fewer lanes.

1. **Map.** Participants in three bands, left to right: this machine, our network and cloud, external services. The line before the last band is labelled "leaves our machines", so a connection that crosses it is visibly a crossing. Apps, agents, engines and services differ by shape and by a word. Every node carries its origin badge. Wires are typed by a label (tools, run, model). A live run moves along its wire; a node waiting on a person shows an amber dot and a count; an unreachable service says so. Selecting a node shows who enrolled it, what it may do here, what it uses, and whether its tools have changed.
2. **Chain.** One request, read top to bottom, a lane per participant: plan, thinking, tool calls, hand-offs with the mandate in plain words, approvals with where to answer them, "left our machines" markers, cost. Every row has its origin.
3. **Waiting for you.** Every pending approval across apps in one list. Each says where it can be answered. Only the ones Foundation owns have buttons.

Where it lives in the app (a pane, a board, or under Settings) is open (§12 Q8).

## 12. Questions for Josh (answered 2026-11-18: "Yes, all of them")

Each recommendation below is now the decision.

| # | Question | Recommendation |
|---|---|---|
| Q1 | Which chain proves it first? | **Foundation's agent asks Vision for a part from SolidCraft, as an engine call through a door Vision owns, watched in Foundation.** It proves the registry, origin, the mandate, the ceiling and the chain view against a door that can actually enforce a ceiling. An agent-to-agent hand-off into the Vision Agent comes after Vision's S7, because until then nothing in Vision can hold that agent to a ceiling. The brief's example, a HomeForm agent asking Vision for a part, is the same call from a second caller and comes next: HomeForm has no agent client, no AG-UI and no MCP today. |
| Q2 | A2A: how much, when? | **Agent Cards later and only for agents we expose outward; the task transport only at a boundary gateway, when there is a real external agent.** Between our own apps, AG-UI. No A2A SDK now. |
| Q3 | Manifest: grow `foundation.json` or adopt Agent Cards? | **Grow `foundation.json`** and link to standard cards from it. |
| Q4 | Where does the shared package live? | **Vision's `@pacific/agui`, taken by hash-locked copy** as HomeForm already does. Alternative: a small repo of its own, cleaner ownership, one more thing to keep. |
| Q5 | The vendor prefix for our keys in the standards | **`co.normallab`**, already used by both desktop apps. Is there a domain we own for extension addresses (A2A wants a URL)? |
| Q6 | How much of HomeForm may Foundation see? | **Nothing by default.** If you turn it on: outline only, visible to you only. |
| Q7 | May an agent's token start a model run in Foundation at all? | **No new chain without a person.** Inside a chain a person started, yes, under its ceiling. |
| Q12 | Dev sign-in (G0) was how local development signed in. Turn it off by default? | **Yes**, with a flag to turn it on, refused while an agent runtime with a shell is running. Built in slice 1: it is off by default now. |
| Q13 | Marked runs are denied a short list of risky tools outright (§9) instead of asking for a press each time. | **Deny.** The alternative, a press per write, will be pressed without reading. Expect some runs to say "I can't send that from here because this run read Slack". |
| Q8 | Where does the map live in Foundation? | **Its own pane, reachable from the chrome, with "Waiting for you" also surfaced on Today.** |
| Q9 | A model key shared between two apps (G8) | **Separate keys per app**, so spend and revocation are per app. |
| Q10 | The tools named in §9 supply chain (`cargo-deny`, `cargo-audit`, an exact-pin check) and pinning the third-party servers that are not pinned yet | **Approve**; each lands in its own repo. |
| Q11 | Who lands Foundation's `/api/agui`? | Another session has uncommitted AG-UI work in this checkout. **That session finishes and commits it**; slice 2 below builds on it. Say if this session should take it over instead. |

## 13. Slices

PR-sized. Slices in Vision and HomeForm are proposals for those repos' backlogs.

| # | Repo | Slice | Proves | Needs |
|---|---|---|---|---|
| 1 | Foundation | **Built.** The person gate is real: G0 (dev sign-in), G1, G2, G9, G10, G12, G13. Tests with an agent's token against each. | A person is a person before anything depends on it | Q7, Q12 |
| 2 | Foundation | **Built.** Agents out of the data folder (G11); an app's tools go to a saved app, with a press on first use (G3). | No door to an address a model chose | 1 |
| 3 | Foundation | Origin and the outside mark in the data: `AguiWriter` stamps them; the reducer keeps them; board objects store them (one schema); reading a marked object marks the run. The origin badge and chain row on `#/design`, day and night. | Provenance and the mark are in the data and survive storage | `/api/agui` landed (Q11), Q5 |
| 4 | Foundation | The short deny list for marked runs at the tool door; the ledger line per tool call. | The injection answers in §9, before any cross-app door opens | 3, Q13 |
| 5 | Foundation | Registry: the `apps` table grows into participants; enrol by a code derived from both keys, admin only; un-enrol; manifest v2 served and read; tool-list hash. Map v0 drawn from the registry (no live runs). | Who is here, assigned by a person | 3 |
| 6 | Foundation | Mandates: mint and verify (Node's own `crypto`), chain-bound, with the generated-chain tests for the weakest-link rule. No caller yet. | The rule is proven in tests before it guards anything | 5 |
| 7 | Vision | An engine door Vision owns: an MCP endpoint on loopback in front of SolidCraft that checks a mandate, holds the ceiling, stamps origin, and serves manifest v2. No agent hand-off. | The callee side, where a ceiling can be enforced | Vision's backlog; 6 |
| 8 | Foundation | The first chain: Foundation's agent calls Vision's engine door for a part; the file comes back with its origin; the Chain view draws it. **End to end, with evidence.** | Q1's chain | 6, 7 |
| 9 | Foundation | Watch endpoint keyed by sender and chain; "Waiting for you" from Foundation's own store plus display-only rows; stop a chain. | Chains not started in Foundation can be seen and stopped | 8 |
| 10 | Foundation | Take the shared package; retire `applyAgui`. | One reducer | Q4 |
| 11 | Vision | ADR-174 S7 (one tool registry, kind decides approval), then S6 `/agui` with mandate and ceiling. | Vision's agent can be held to a ceiling | Vision's backlog |
| 12 | Foundation | Hand-off as a subagent into Vision's agent; relayed interrupts display-only, proven against both reducers. | A chain of agents reads as one | 11 |
| 13 | HomeForm | Its own backlog items first (caller identity; drafts keep their chain and are re-checked at Apply). Then outbound only: its agent emits AG-UI and can ask an enrolled app for a part. **The brief's example chain.** | HomeForm in a chain without opening the house | HomeForm's backlog |
| 14 | HomeForm | Inbound through `hubd` (its P7.4): named grants set at the house, mandate checked, ledger, no way for a remote request to state a confirmation. | Tiers survive a call from another app's agent | `hubd`, 13 |
| 15 | Foundation | The outgoing gate and "left our machines" markers for Foundation's own sends. A2A gateway and signed cards, if wanted. A2UI drawn from our catalog, if wanted. | External agents, richer UI | Q2; new dependencies to approve |

Creation (added by the second critique; not answered by Josh yet): its manifest and its own backlog items first, then Creation as a caller of Vision's engine door after slice 8, the same call as HomeForm's.

The order is guards before doors: nothing cross-app is callable (slice 7 and 8) until the person gate, the outside mark, the deny list, the ledger and the tested mandate exist (slices 1–6).

## 14. Dependencies named

None is added by this ADR. For approval when their slice comes:

| Dependency | Where | Status |
|---|---|---|
| `@ag-ui/core` 1.0.5 (MIT) | Foundation, Vision | Already present in both (uncommitted in Foundation). Pinned exactly. |
| Ed25519 signing | Foundation: Node's built-in `crypto`, nothing new. Vision, HomeForm: a Rust crate to be named in their slices. | To name |
| `cargo-deny`, `cargo-audit` | HomeForm, Vision CI | Proposed (Q10) |
| `@a2a-js/sdk` 1.3.0 (Apache-2.0) | Foundation | **Not proposed.** Only if Q2 goes the other way. |
| An A2UI renderer | Foundation | **Not proposed.** |
| `rea-agents` 6.9.0 (MIT), integrity `sha512-KqDn1UR5BMqHoQ3MGAnPuWiSKwgdFaz1L/uUNgrKt+1W8kPtgYP8AWEOXIF1lDIOBVyPuYIIst2iamo1Wf3r8g==` | Foundation, run by `npx` for a REA job a person starts (not in any package.json) | Pinned (G13), checked against npm's registry before each start |

Nothing paid was run and no data of ours was sent to an external service in preparing this, beyond the agents' reading of public documentation.

## 15. Who did what

| Piece | Agent | Model | What the lead checked |
|---|---|---|---|
| Foundation inventory | subagent | Opus | Re-read the server code behind each Foundation gap the report named. |
| Vision inventory | subagent | Opus | Read ADR-174 in full. The rest is as reported. |
| HomeForm inventory | subagent | Opus | Read the hub's README, the tier table in its docs and the code that applies tiers. The rest is as reported. |
| AG-UI and A2UI reading | subagent | Opus | The subagent events are present in the installed 1.0.5; three claims re-fetched by the checker. |
| MCP reading | subagent | Opus | Four claims re-fetched by the checker; one quote was worded differently on the page with the same meaning. |
| A2A reading | subagent | Opus | Two claims (release, card fields) re-fetched by the checker. |
| Spec spot-check | subagent | Sonnet | Its verdicts read against the three reports. |
| Inventory write-up | fork of the lead | Fable | Read the first part against the three reports; unknowns are marked "not stated". The rest not re-read. Kept off the public repository. |
| Mock-ups | subagent | Opus | The agent had not seen it in a real browser. The lead opened it through Foundation's dev server at 1280 px in day and night and at 400 px: Hanken loads, no console errors, no sideways page scroll. Screenshots in `docs/evidence/2026-11-18_working-together/`. The lead changed three captions to match the second draft. Not checked: the 260 and 560 px panel widths DESIGN.md asks for; wires simplify DESIGN §5.1 (one tint, no shared lanes), as the agent reported. |
| Critic on the proposal and threat model | subagent | Opus | Given the first draft and the sources, not the lead's view. The lead re-read the code behind each of its Foundation claims; all held. It fetched no specs, so its AG-UI point rests on the installed 1.0.5 types and its MCP and A2A points are reasoning. |
| Decisions, this ADR, the briefs, the review | lead | Fable | — |
| Second critique, after acceptance | a separate session | Opus | Wrote the critique itself and re-read the code it cites in Foundation, HomeForm, Vision and Creation. It also inventoried Creation (a subagent) and re-fetched 22 spec claims (a subagent). Kept off the public repository. |
| Security pass on Foundation, after acceptance | the lead, with subagents | Fable, Opus | A wider inventory, the fixes in SPEC §3 and §7, and the security check (`npm run check:security`). The lead read each diff and re-ran its tests. Detail of anything still open is kept off the public repository. |

How the reports scored against their briefs (complete, correct, verified, honest about gaps): the three inventories and three spec readings were complete and marked what they had not checked; none needed sending back. The first Foundation inventory missed several gaps that the critic and the later, wider inventory found. The lead's own first draft was the weakest piece.

**The first critic's blocking findings:** eight, all accepted and answered in §5, §6, §8 and §9 (the stored and travelling outside mark; the person in a mandate being only the root app's word; grants set in the callee; no default grant; drafts re-checked when applied; relayed approvals display-only; the person gate; where signing keys live). The findings themselves are kept privately.

Not taken from the critic: nothing was rejected. Two of its points are recorded as open and not solved: how revocation reaches a peer that is offline (§9 says it does not until the peer is next online), and a ledger's hash chain being only as good as who else holds its head.

## 16. Not verified

- The design beyond slices 1 and 2 has not been run.
- The second draft was reviewed again after acceptance, by another session. One of its high findings was built into slice 1 (G13). Two are not yet answered in this file: what origin and reach today's board objects get by default, which has to be decided before slice 3; and Creation's place in the plan. The first draft's reviewer rated it: delegation 2, provenance 2, injection defence 1, protocol fit 3, slice plan 2, honesty 4 (of 5).
- Whether relaying another app's run as AG-UI subagent events survives both reducers (§7). It is a reading of the 1.0.5 types, not a test.
- Whether RFC 8693's claim shape fits MCP's authorization rules for hosted servers as neatly as assumed.
- Vision's, HomeForm's and Creation's inventories beyond what §15 lists are the agents' reading, not the lead's.
- The standards were read by agents from the public sources on 2026-11-18; a sample of claims was re-fetched, not all.
- Authentication for our cloud (§8) is a principle here, not a design.
- Whether `co.normallab` maps to a domain we own.
- Foundation's build when the ADR was written (2026-11-18): typecheck clean; server, extension and slack-agent suites with no failures; one client test with a wall-clock budget failed on a loaded machine and was not diagnosed. Later results are in each slice's evidence folder.
