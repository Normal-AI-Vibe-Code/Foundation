# ChatForm: the architecture

> Josh, 2026-11-18: "re-build the slack and communication framework we use in the company, which includes google workspace email, WhatsApp, Instagram and WeChat … another top level function of Foundation that goes next to the Today button … conversations between humans and agents … all of the features of slack that we use on a regular basis … download the chats that we have so far … agents to be able to chat in this interface and clearly make themselves known … a robust huddle system … take those conversations into the Grid where they can be recorded and re-played … upload CAD files and projects from Vision, and then have a video conversation on them … a small time primitive, that can re-wind the clock in a certain region or section."

This is the build document: what ChatForm is, the contract between its parts, and who builds which part. The contract's types are `packages/protocol/src/chat.ts`. SPEC.md §0.9 and §3 say what was actually built and checked.

## 1. What a professional adds

- **One conversation model.** A channel, a DM, a group, a talk with an agent and a WhatsApp chat are all a *channel* with messages. Threads, reactions, files, search, unread, huddles and export work the same in every one, and are written once.
- **The server says who spoke.** A person's browser posts as that person. An agent's bearer or run posts as an agent and is drawn as one: violet, its avatar, an *Agent* mark, whom it worked for. A bridge's inbound message is a *ghost* with its service's mark. No request names its own author.
- **Nothing leaves the building without a person.** An agent may read a portal and draft a reply; sending a message to a mailbox, a phone or an Instagram account is a person's press (`requirePerson`). Same for joining a huddle with a camera.
- **History comes with us.** Slack's export zip (and, where a token allows, Slack's API) is brought in with its authors, times, threads, reactions, pins and files; brought in twice, nothing is doubled. And ChatForm can be taken out again: every channel downloads as JSON and Markdown.
- **Honest bridges.** Each service has one adapter with one state: off, needs setup (with the steps and which keys are missing), live, error. No adapter pretends. The official routes only: Gmail API, WhatsApp Business Cloud API, Instagram Messaging API, WeCom / WeChat Official Account. A stand-in adapter proves the framework in tests.
- **A huddle is a message.** Starting one posts a card in the channel that everyone can join; when it ends the card holds who was there, the transcript, the recordings and **Replay**. *Take it to a grid* moves the same call onto a section, where what people do on the grid is recorded with it.
- **Replay is a clock.** A recorded session is a timeline: each person's recording, each line said, each change to the grid. A clock card on a section scrubs that timeline: the videos seek, the transcript follows, the portraits and agents' avatars speak when their lines are said, and the section is drawn as it was at that moment. The live grid is never rewritten by looking back.

## 2. The parts

```
packages/protocol/src/chat.ts     the contract: types, the wire, the pure rules (mentions, unread, Slack mrkdwn)
apps/server/src/chat.ts           the store (SQLite), access, the hub (who hears what), FTS, HTTP routes (chatRoutes)
apps/server/src/chatsock.ts       /chat socket: hello, events, typing, presence
apps/server/src/chatimport.ts     Slack export zip and Slack API → channels and messages; ChatForm export
apps/server/src/chatbridges.ts    the bridge framework + adapters/ (gmail, whatsapp, instagram, wechat, standin)
apps/server/src/chatagents.ts     agents in channels: @mention → a turn that answers in the thread; tools; T3 threads as conversations
apps/server/src/huddles.ts        (extended) a huddle that belongs to a channel; agent participants
apps/server/src/replay.ts         takes: a grid's changes kept with a recorded session; the timeline; state at a moment
apps/client/src/chat/             the place: ChatForm.tsx, model.ts (store + socket), Sidebar, Timeline, Message, Composer, Thread, …
apps/client/src/chat/tabs/        Agents, Inbox (bridges), Huddles: one file per tab, each owned by its builder
apps/client/src/panels/ReplayView.tsx   the clock card on the grid
```

### 2.1 Storage (all in `chat.ts`, created at import like huddles.ts)

```
chat_channels (id pk "ch_…", kind, name, topic, purpose, created_by, created_at, archived_at,
               members_key unique nullable  -- dm/group: chatMembersKey(user ids)
               origin_service, origin_id, origin_account  -- unique together when set
               agent_json, last_seq, last_post_at, last_text, huddle_json)
chat_members  (channel_id, party_kind, party_id, name, read_seq, mentions, notify, starred, joined_at,
               primary key (channel_id, party_kind, party_id))
chat_messages (id pk "m_…", channel_id, seq, author_kind, author_id, author_json, type, text, root_id,
               created_at, edited_at, deleted_at, files_json, mentions_json, previews_json, extra_json,
               pinned, request_id, origin_service, origin_id,
               unique (channel_id, seq), unique (channel_id, author_id, request_id), unique (channel_id, origin_service, origin_id))
chat_reactions(message_id, emoji, party_kind, party_id, name, at, primary key (message_id, emoji, party_kind, party_id))
chat_ghosts   (id pk "gh_…", service, handle, name, avatar, user_id nullable  -- a ghost that is one of us
               unique (service, handle))
```

FTS: `indexDoc("chat", messageId, null, "<#channel or names> · <author>", text + file names)`; a removed message is unindexed. Search results are filtered by what the asker can see.

### 2.2 Who may do what

| | open channel | private / group / dm / agent / portal |
|---|---|---|
| read, search | anyone signed in (a `viewer` account: only if a member) | members; admins do **not** read others' DMs |
| post, react, edit own | members (posting to an open channel joins it); a `viewer` account may post where it is a member | members |
| create | members and admins, not viewers | members and admins, not viewers |
| remove a message | its author, or an admin, with `confirm: true`; the row stays (`deletedAt`), its files stay archived | same |
| archive a channel | its maker or an admin, with `confirm: true` | same |
| agents (bearer / run) | post as an agent in channels the person they work for can see; never edit or remove a person's message | same |
| send out of a portal | a person only (`requirePerson`) | |

Every write carries `request_id` (a retry returns the first result). Chat routes are not board writes: `/api/chat/` is added to `READ_POSTS` in `index.ts` and the rules above are enforced in `chat.ts`.

### 2.3 HTTP (all under `/api/chat`, registered by `chatRoutes(r)` from `index.ts`)

```
GET    /api/chat                                   → { channels: ChatChannelView[], people: ChatParty[], agents: ChatAgentRef[], online: string[] }
POST   /api/chat/channels   {kind, name?, topic?, purpose?, members?: string[], request_id}   → { channel }   (dm/group: returns the one that exists)
GET    /api/chat/channels/:id                      → { channel: ChatChannelView }
POST   /api/chat/channels/:id   {name?, topic?, purpose?, notify?, starred?}                   → { channel }
POST   /api/chat/channels/:id/join | /leave        → { channel }
POST   /api/chat/channels/:id/members   {add?: string[], remove?: string[]}                    → { channel }
POST   /api/chat/channels/:id/archive   {confirm: true}
GET    /api/chat/channels/:id/messages?before=<seq>&after=<seq>&around=<seq>&since=<ms>&root=<id>&limit=   → ChatPage
POST   /api/chat/channels/:id/messages  {text, files?: string[] (archive file ids), root?, request_id, place?}   → { message }
POST   /api/chat/channels/:id/read      {seq}      → { me }          (seq below the newest = "mark unread from here")
POST   /api/chat/messages/:id           {text}     → { message }     (edit; author only)
DELETE /api/chat/messages/:id           {confirm: true}
POST   /api/chat/messages/:id/react     {emoji, on: boolean}         → { message }
POST   /api/chat/messages/:id/pin       {on: boolean}                → { message }
GET    /api/chat/search?q=              → { hits: Array<{ message: ChatMessage, channel: {id,name,kind}, snippet }> }   (parseChatQuery)
GET    /api/chat/unreads                → { total, mentions, channels: Array<{id, unread, mentions}> }
GET    /api/chat/channels/:id/export?format=json|md        (download)
```

Files are uploaded first as today (`POST /api/files?board=chat&name=`, raw body), then named by id on the message. `board=chat` is a reserved board id the files module accepts for chat uploads.

Socket: `/chat` (ticketed like the others; add it to the Vite proxy). Server sends `ChatEvent`s; the client sends `ChatSay`.

### 2.4 The server module's surface (what the other server modules build on)

`chat.ts` exports exactly these (more is fine, these are promised):

```ts
personParty(user: UserInfo): ChatParty
agentParty(name: string, via?: string, forName?: string): ChatParty
ghostParty(service: ChatService, handle: string, name: string, avatar?: string): ChatParty      // makes or finds the ghost
createChannel(by: ChatParty, c: { kind; name?; topic?; purpose?; members?: ChatParty[]; origin?: ChatOrigin; agent?: ChatAgentRef; createdAt?: number }): ChatChannel
channelByOrigin(service: string, externalId: string, account?: string): ChatChannel | undefined
openDirect(parties: ChatParty[]): ChatChannel                                                   // dm or group, made once
getChannel(id): ChatChannel | undefined
canSeeChannel(user: UserInfo, channel: ChatChannel): boolean;  requireChannel(user, id): ChatChannel   // 404 when hidden
addMember(channelId, party, opts?: { silent?: boolean });  removeMember(channelId, party)
postMessage(channelId: string, author: ChatParty, m: { text?; files?: string[]; root?: string | null; type?: ChatMessageType; requestId?: string;
            origin?: ChatOrigin; createdAt?: number; huddle?; place?; outbound?; reactions?: ChatReaction[]; pinned?: boolean; editedAt?: number },
            opts?: { silent?: boolean }): ChatMessage           // silent: brought-in history: no events, no unread, no mention counts
updateMessage(id, patch: Partial<Pick<ChatMessage, "text" | "huddle" | "outbound" | "previews">>, opts?: { edited?: boolean }): ChatMessage
getMessage(id): ChatMessage | undefined;  pageMessages(channelId, q): ChatPage
onChatMessage(fn: (message: ChatMessage, channel: ChatChannel) => void): () => void              // after every non-silent post
publish(event: ChatEventBody, audience: { channel: string } | { users: string[] } | "all"): void // the hub; chatsock.ts delivers
setChannelHuddle(channelId, state: ChatHuddleState | null): void
```

## 3. The place

`#/chat` (place kind `chat`, `#/chat/<tab>/<channel id>`), a button beside Today in the top bar's left corner with an unread badge (mentions and DMs count; the roll-over says how many of each). ⌘K → *Open ChatForm*; Ctrl/⌘+K inside ChatForm is the quick switcher's field.

Under the top bar, a strip like Settings': **ChatForm** and four tabs.

| Tab | Holds |
|---|---|
| **Chat** | The sidebar (Unreads · Threads · starred · Channels · Direct messages, each a section that folds), the timeline, the thread pane on the right, the composer |
| **Agents** | Conversations with agents: each T3 thread and Foundation agent session as a channel of kind `agent`; start one with any connected agent; the council's talk per grid |
| **Inbox** | The bridges: Mail, WhatsApp, Instagram, WeChat (and Slack's brought-in history), each with its state and its portals; setup steps when one isn't connected |
| **Huddles** | Live huddles now, and the archive of sessions: who, how long, transcript, recordings, Replay, *Open on its grid* |

The timeline: day rules, messages grouped by author within five minutes, a hover bar (react, reply in thread, pin, link, more), reactions as pills, files inline (images and GIFs as pictures, video and audio as players, CAD as the CAD card's still that turns, anything else a row with its size), link previews, edited marks, a *New* rule at the first unread, jump to newest. Composer: markdown with a small toolbar, `@` people and agents, `#` channels, `:` emoji, paste and drop files, drafts kept per channel on the device, ↑ edits your last message, Enter sends and Shift+Enter breaks the line.

Design: on tokens only, shown on `#/design` first (a **ChatForm** chapter), day and night. An agent's message is always violet-marked (`--color-agent`), a ghost's carries its service's monogram; a person's has no mark. Rows are added to DESIGN.md §5.

## 4. Work packages

One checkout, several builders: **each builder owns its files and touches a shared file only at the named seam.** Nobody commits; the lead (this session) reviews, integrates, and commits. Everyone runs `npm run typecheck` and their own tests; e2e on their own ports (above 15000). If typecheck is red in a file you don't own, say so in your report and carry on.

| # | Package | Owns | Shared seams |
|---|---|---|---|
| S1 | **Core server**: store, access, hub, socket, routes, search, unread into Today | `apps/server/src/chat.ts`, `chatsock.ts`, `test/chat*.test.ts` | `index.ts` (`chatRoutes(r)`, `READ_POSTS`), `sockets.ts` (`/chat`), `search.ts` (source `chat`), `files.ts` (`board=chat`), `today.ts` (a `message` focus kind) |
| C1 | **The place**: button, tabs, sidebar, timeline, composer, threads, reactions, files, search, switcher, unread badge | `apps/client/src/chat/**` (except `tabs/`), `e2e/chatform.spec.ts`, `test/chat-*.test.ts` | `lib/place.ts`, `shell/Shell.tsx`, `shell/TopBar.tsx`, `shell/CommandBar.tsx`, `vite.config.ts`, `design/DesignPage.tsx`, `protocol/design.ts`, DESIGN.md |
| I1 | **History**: Slack export zip, Slack API pull, ChatForm export, the import screen | `apps/server/src/chatimport.ts`, `scripts/chat-import.mjs`, `test/chatimport.test.ts`, `apps/client/src/chat/tabs/History.tsx` | `index.ts` (routes), Inbox tab mount |
| B1 | **Bridges**: framework, four adapters, stand-in, webhooks, drafts and a person's send, Inbox tab | `apps/server/src/chatbridges.ts`, `src/bridges/*`, `test/chatbridges.test.ts`, `apps/client/src/chat/tabs/Inbox.tsx` | `index.ts` (routes), `config.ts` |
| A1 | **Agents in chat**: mentions start a turn that answers in the thread, tools, MCP, T3 threads and sessions as conversations, avatars, Agents tab | `apps/server/src/chatagents.ts`, `test/chatagents.test.ts`, `apps/client/src/chat/tabs/Agents.tsx` | `tools.ts` (chat tools), `agent.ts` (a `chat` context), `index.ts` |
| H1 | **Huddles in channels**: start, join, the card, screen share, agent participants that speak, take it to a grid, Huddles tab | `apps/server/src/huddles.ts`, `apps/client/src/lib/huddle.ts`, `panels/HuddleView.tsx`, `shell/HuddlePip.tsx`, `apps/client/src/chat/tabs/Huddles.tsx`, `chat/HuddleCard.tsx` | `sockets.ts`, `index.ts` |
| R1 | **Replay and the clock**: takes, the timeline, the section as it was, the clock card, CAD and Vision files in a channel, the whole scenario end to end | `apps/server/src/replay.ts`, `apps/client/src/panels/ReplayView.tsx`, `apps/client/src/chat/CadAttachment.tsx`, `e2e/chatform-scenario.spec.ts` | `boards.ts` (an update hook), `protocol/index.ts` (panel kind `replay`), `tools.ts` |

Order: S1 and C1 first, together. Then I1, B1, A1 and H1 side by side. Then R1 and the scenario.

## 5. What shows it's right

- Two browsers, two people: a message, a thread reply, a reaction, an edit and a file each reach the other without a reload; unread counts and the badge agree with the server; a viewer account can't make a channel; a DM is invisible to a third person and to an admin.
- A real Slack export (the fixture in `apps/server/test/fixtures/slack-export/`, and Josh's own zip when he has it) comes in whole, twice, with nothing doubled; its threads, reactions, pins and mentions read the same as in Slack.
- An agent mentioned in a channel answers in the thread as itself, with its avatar, through the scripted runtime in tests and a real turn once.
- A stand-in bridge: an inbound webhook makes a portal and a ghost; an agent's draft does not leave; a person's press sends it; a bearer's press is refused.
- The scenario: a STEP file dropped into a channel, a huddle started on it by two people, taken to a grid, recorded, ended; the clock card replays it: videos seek together, lines light as they were said, the section shows the card that was added halfway only after halfway.
- `npm test`, `npm run typecheck`, the e2e specs, `#/design` day and night, evidence in `docs/evidence/2026-11-18_chatform/`.

## 6. As built: the core server (S1, 2026-11-18)

What differs from, or adds to, §2. Builders after S1 read this before `chat.ts`.

**Routes.** `GET /api/chat/threads` → `{ threads: [{ root, channel: {id,name,kind} }] }` (threads the asker started or replied in). `DELETE /api/chat/messages/:id` returns `{ message }` (the stub) and also takes `?confirm=true`. Archive, leave and members return `{ channel }` (`null` when the asker can no longer see it). Creating: `members` are user ids or `agent:<Name>`; `dm` or `group` is decided by the head count; `kind: "agent"` needs `agent: {name, via?, session?}`; `kind: "portal"` is refused over HTTP (bridges call `createChannel`). Open and private names are unique among unarchived channels over HTTP (409); `createChannel()` from server code does not enforce it. `join` is for open channels and never for a viewer account (a member adds them). Renaming is the maker's or an admin's; topic and purpose any non-viewer member's.

**Who is speaking.** `requestParty(req, body?) → { user, party, person }`: a person's session is that person; an agent-kind bearer or the service token is an agent, named by the `X-Foundation-Agent` header or the body's `as` (`X-Foundation-Agent-Via` sets `via`), working for the session's user (`forName`). A person's request ignores `as`.

**Messages.** Paging without `root` returns top-level messages only; with `root`, the thread, its first message first. `since` is made-or-changed since. `limit` 50, at most 200. A post with `place` is `type: "link"`. `mentions` holds user ids, `"agent:<Name>"` for an agent, `"channel"` and `"here"`. Every message in a dm, group, agent or portal channel is a mention for the others in it. Posting marks the channel read for the author; posting or reacting in an open channel joins them (a "joined" system line). Replies and system lines have a `seq` and count as unread (`lastSeq − readSeq`). A repeated `requestId` (per channel and author) or `origin` (per channel) returns the first message. Silent posts (history) send nothing, count nothing, notify no listener.

**Ghosts.** `ghostParty` returns the *person's* party when the ghost row has `user_id` set (a ghost that is one of us).

**Events.** `hello` has `rev: 0`; a `presence` follows it. A thread reply sends `message` and a `message-changed` for its root. `read` goes to the person concerned, all their windows. Removal from a non-open channel sends them `channel-gone`. Typing is throttled to one per 1.5 s per person, channel and thread, and is not echoed to the typer.

**More exports.** `CHAT_BOARD = "chat"`, `SYSTEM_PARTY`, `channelView`, `removeMessage`, `react`, `pin`, `setRead`, `ensureGeneral`, `registerChatAgents(fn: () => ChatAgentRef[])`, `knownAgents`, `resolveMentions`, `onPublish`, `onlineUsers`, `canSeeChatFile`, `searchChat`, `unreadsFor`, `chatFocus`, `exportChannel`, `exportMarkdown`, `linkPreview`.

**Files.** Uploads go to board `chat`. A chat file opens for its uploader and for anyone who can read a message (not removed) that carries it; admins get no exception. A message may carry the poster's own chat uploads, chat files they can already see, or files from boards they can see.

**Search and Today.** Chat rows are indexed with `board_id = "chat"`; ⌘K filters them per person. Today's focus kind is `"message"` (id `message:<channel>`, href `#/chat/chat/<id>`): mentions anywhere, and unread in a dm, group or agent conversation.

**Admins** do not read private channels they are not in (nor DMs), so they cannot moderate them either.
