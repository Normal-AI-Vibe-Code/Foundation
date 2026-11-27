# The timeline

> Josh, 2026-11-25: "a timeline feature to every grid that also maintains its history of adding and deleting things, and chats that were had during that time frame. So as you move through the past you also see the chat associated with that moment of time in the section, this should be connected to a larger timeline of the whole grid, but you can temporarily scrub the timeline of a section. You should also see the agents that are working on the grid, and people's interaction with the grid, you should see video notes that people leave, and audio notes. There may in fact be agent work that is done behind the scenes of a section, not all agent work must be represented by cursors … terminal level commands … harness prompt, or agent council which should be a top meta level header for every section and every grid. Remember a section is a grid or a view and link to a grid."

This is the architecture. The shared types are `packages/protocol/src/timeline.ts`; the server is `apps/server/src/timeline.ts`; the client is `apps/client/src/timeline/`. What is built and what is not is said at the end, and in SPEC §3 and §7.

## 1. What was there before

- **Only the present was kept.** A board's Yjs update log (`board_updates`) is squashed into one snapshot every 500 writes, and the document garbage-collects. Nothing could answer "what was here on Tuesday".
- **Activity** is 400 lines inside the board document, with no section on a line, written by about seventy call sites; any editor's socket can rewrite it. It is a feed, not a record.
- **Replay takes** (`replay.ts`) keep a grid's changes and cursors, but only while a huddle records, for at most 45 minutes. The take's shape (a base, then timed changes, then cursors; `TakePlayer` rebuilds the board at a moment) is exactly what a timeline needs, and is reused as it is.
- **Agent runs** had a board but no section and no timed events; the crew, a T3 thread's section and a terminal's screen were in memory only. **Chat** is not tied to a grid except by a chat card (a reference), a message's place link, or a huddle taken to a section.
- **Voice and video notes** never existed in Foundation. They were Flowform's `video_note`; Foundation only imports those as video cards.

## 2. The model

### Places, and the meta layer

A **place** is a section's id, or `*` for the grid itself (`GRID_PLACE`, the word the council's `agents` map already uses). Every place has the same **meta layer** above its cards:

| Part | What it is | State |
|---|---|---|
| Council | the agents assigned to the place (`agents` map, `Council.tsx`) | built before |
| Timeline | what happened here, and the place as it was | **this work** |
| Harness prompt | the place's standing instructions to its agents | a kind is reserved (`prompt`); not built |
| Terminal | a shell that belongs to the place, for people and agents | a kind is reserved (`terminal`, fed today by machine cards); not built |

A section that hosts a `grid` card **is** that grid: its timeline is the child grid's own, asked by that grid's id. A plain section's timeline is the grid's, filtered to that section and the sections inside it. So there is one timeline per board, and a section's is always a part of some grid's.

### Two records, both the server's

**History** is the board document over time.

- `timeline_base (board_id, at, upto, blob)`: the document as it was when keeping began, a checkpoint every so often after (so the board at a moment is rebuilt from the nearest one, not from the beginning), and a fresh first one whenever old history is folded (below). `timeline_boards` keeps each grid's count of kept bytes and the state it last wrote, so changes made while the server was down are caught up when the grid next opens.
- `timeline_updates (board_id, seq, at, blob, by)`: every change after, merged into bursts (2 s) with `Y.mergeUpdates`, with who made it. Captured at the one place every board write passes (`onBoardUpdate` in `boards.ts`), whoever wrote: a person's socket, a tool, a server subsystem, a migration (left out, every later change that leans on it could not be applied). The board document is read as untrusted: a malformed card costs its own event, never the history or anyone else's events.
- `timeline_cursors (board_id, at, json)`: where people's pointers and agents' aims were, once a second while anyone moves (a take's `CursorSample`). Kept `FOUNDATION_TIMELINE_CURSOR_DAYS` (14).
- Compaction of `board_updates` is untouched: the present loads as fast as before. History is a second, append-only log.
- **A budget, said out loud.** `FOUNDATION_TIMELINE_MAX_MB` (256 per grid). Over it, the oldest changes are folded into a new base and `start` moves forward; the timeline then says "History begins …" at that point. Events are never folded.
- For a grid that existed before this, history begins the first time the new server opens it.

**Events** are one line per thing that happened: `timeline_events (id, board_id, section_id, at, end_at, kind, actor_kind, actor_id, actor_name, actor_for, object_id, text, ref_type, ref_id, ref_within, data_json, request_key)`. Append-only (a span's `end_at` is the one field set later). No route writes one: each is recorded by the server where the thing happens, and who did it is the session's or the transaction's to say, never the request's (a name a request claims, such as an MCP client's `as`, is a label, not the actor). Only a request's or a tool's own write is credited to its person or agent; what a subsystem writes later, on a timer, is the system's. Messages and huddles are not copied into this table: they are read from ChatForm's and the huddles' own tables for each reader, so an edit, a removal and who may read them stay theirs to say.

| Lane | Kinds | Recorded where |
|---|---|---|
| People | `person.here` (a span) | awareness: a person arrives on the grid, and leaves |
| Agents | `agent.run` (a span), `agent.seat` | a run starts and ends (`agent.ts`, T3 asks); the council changes (`posted.ts`) |
| Behind the scenes | `agent.tool`, `agent.code`, `terminal`, `prompt` | `runTool` (every door: HTTP, MCP, the agent loop, code mode); `run_code`; a machine's commands (`machineAsks`, `agentActs`) |
| Changes | `card.*`, `section.*`, `wire.*` | the document itself: what each burst added, removed, moved to another section, dragged or resized inside one (`card.place`), renamed or edited (words, cells, settings), per actor |
| Chat | `chat.ask`, `chat.answer`, `chat.message`, `huddle` | an ask to an agent and its answer; a ChatForm message in a conversation that has a card on the grid, or sent with a place link; a huddle on the grid |
| Voice and video | `note.audio`, `note.video` | a media card with `note` arrives in the document |

**One order, the same for every reader.** An event that comes from the document is stamped with the time of the burst that keeps its change, never earlier: the board rebuilt at an event's moment always holds that event's change (tested by replaying a person's session step by step). Events at one moment keep the order the server recorded them in (the row's place), so every read and every reader sees the same sequence. A stretch of typing in one card is one `card.edit` per person until they pause a minute (`FOUNDATION_TIMELINE_EDIT_QUIET_MS`); dragging and resizing one card is one `card.place` until they leave it 20 s; every keystroke and every step of a drag is still in the history, and plays.

**A new primitive** adds its kinds to `TIMELINE_KINDS` and calls `recordEvent` where its thing happens. Its cards' adds, removes and edits are already in Changes, because those come from the document, not from the primitive.

### Who may read what

1. The timeline and the history answer only to someone who can see the grid (a members-only grid is 404 to anyone else). A viewer may read both; nothing here is a write.
2. Reading never writes a board (the rule Replay has, tested the same way).
3. An event's `text` is a line anyone on the grid may read. Its `data` is filled per reader:
   - **A conversation's words** reach only its members, admins included. To anyone else the event is not there at all (a chat card already shows such a person a lock and nothing more).
   - **An agent's answer** is shown to the person it worked for. To others on the grid it is shown only if the run read nothing beyond the grid (the rule its reasoning already follows); otherwise `withheld` says so.
   - **A script's code and a command's text** follow what the grid already shows of them (a machine's ask is on its card); a script shows its length, not its text.
4. History holds what a grid held, including cards since removed: that is what it is for. Removing a card does not remove it from the past. (An admin's purge of a stretch of history is not built.)
5. ChatForm on a chat server of its own (the desktop app's default) keeps its messages there. Foundation's server then has no `chat.message` events for it; the client asks that chat server, as the person looking. That server pages by message, not by time, so the client reads back a bounded way (200 messages) and past that offers the conversation itself.

### The wire

- `GET /api/boards/:id/timeline?section=&from=&to=&limit=` → `TimelineSlice`: the events, a `density` of changes for the bar's texture, the sections named, when keeping began.
- `GET /api/boards/:id/history?from=&to=` → a take's wire (`FRT1`): the board at `from`, then the changes to `to`, thinned to a few hundred steps however long the stretch (a week and an hour cost the same to scrub), and the cursors. `TakePlayer` plays it.
- A tool, `read_timeline`, gives an agent the same slice as words (a read; `READ_TOOLS`).
- **Live.** Whenever the server keeps a burst or records an event it nudges every window on that grid over the board's own socket (message type 2: the time, nothing else). A window with that grid's timeline open at now reads it again within 1.5 s, as the person it is, so who may read what stays the route's to say. A timeline that is looking back keeps what it has and reads again when it comes back to now. A grid this window isn't joined to (a section that is another grid) is read again every 20 s while open.

## 3. What a person sees

- **A clock** in the grid's tab (beside ⓘ) and in every section's header. `H` opens the grid's.
- **The grid's timeline** is a band along the foot of the grid, on the floor (a hairline above it, the grid's paper under it): the transport (back to now, play, speed, the moment in words, the range: hour, day, week, all), then the lanes, with one playhead through all of them. Agents are violet, as everywhere. Behind-the-scenes work is drawn hollow, under the agents' own lane: it happened, and no cursor showed it.
- **Scrubbing** shows the grid as it was: every section draws its cards from history, for this person only, with a banner that says when, and *Back to now*. People's pointers are drawn where they were, and an agent's on the card it was aimed at (what it was doing then is in its lane, not on its pointer). Nothing can be edited in the past.
- **The moment**: beside the playhead, what was said around that time (asks, answers, messages, huddles) and the voice and video notes left then, which play there. A chat card in the past is drawn as its mark and name; what was said in it is in the moment.
- **A section's timeline** opens from its clock: a slim bar that unfolds from under the section's header (where the clock is), over the top of its body, its own range and playhead. Scrubbing it takes only that section into the past; the grid's timeline, if open, shows where the section's playhead is, and *Follow the grid* joins them again. Closing it returns the section to now. A section that is a grid opens that grid's timeline.

## 4. Voice and video notes

A note left to be played back is a `media` card with `note` set (`MediaDoc.note`: who, when, how long, the file, a voice note's wave) and `media: "audio" | "video"`. The clip is an ordinary upload: archived, never deleted, served as passive media. Recording starts only on a person's press of Record (the microphone or camera is not opened before it), runs at most 5 minutes of voice or 2 of video, and can be thrown away before it is left. Nothing is sent outside Foundation; there is no transcript yet (the local transcriber is on the plan). On the timeline a note is an event in its own lane, and plays from there even after its card is gone.

## 5. Built, and not

See SPEC §0.21 for what was checked. Not built, each reserved in the model rather than implied:

- A place's **harness prompt** and its **own terminal** (the `prompt` and `terminal` kinds exist; a machine card's commands feed `terminal` today).
- **Restoring** from the past (bring a removed card back, or a whole section): the timeline only looks.
- A **purge** of a stretch of history, and a per-person opt-out of kept pointers.
- **Transcripts** of voice and video notes, and leaving a note *for* a named person.
