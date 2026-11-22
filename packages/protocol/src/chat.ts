/**
 * ChatForm (2026-11-18, Josh: "re-build the slack and communication framework we use in the company …
 * conversations between humans and agents … agents to be able to chat in this interface and clearly make
 * themselves known … a robust huddle system … take those conversations into the Grid where they can be
 * recorded and re-played").
 *
 * One company, one set of conversations. A conversation is a **channel** whatever it holds: a public or
 * private channel, a direct message, a group, a conversation with an agent (a Foundation agent session or
 * a T3 thread), or a **portal** onto a conversation that lives somewhere else (a mail thread, a WhatsApp,
 * Instagram or WeChat chat). A portal's other side speaks through **ghosts**: authors the server made for
 * people outside Foundation, as Matrix bridges do.
 *
 * Who wrote a message is the server's to say, never the request's: a person's session posts as that
 * person, an agent's bearer or run posts as an agent (and is drawn as one, always), a bridge's inbound
 * posts as a ghost. That is the whole of "agents clearly make themselves known".
 *
 * This file is the contract every side shares (server, client, tools): the types, the wire, and the pure
 * rules (a DM's key, what a mention is, what counts as unread, Slack's mrkdwn as markdown). The shape
 * follows Mattermost's where it had already solved the problem (channel kinds, a per-channel count and a
 * per-member read mark, root_id threads, pending ids for idempotency, the event envelope), simplified to
 * one team.
 */

// ---------- channels ----------

/** open: anyone signed in may read and join · private, group, dm: members only · agent: a person (or people) and one agent · portal: a conversation that lives in another service */
export type ChatChannelKind = "open" | "private" | "dm" | "group" | "agent" | "portal";

/** the services a portal can stand for; `slack` is history brought in from Slack, the rest are live bridges */
export const CHAT_SERVICES = ["slack", "gmail", "whatsapp", "instagram", "wechat"] as const;
export type ChatService = (typeof CHAT_SERVICES)[number];

/** where a channel or a message came from, when it wasn't made in ChatForm */
export interface ChatOrigin {
  service: ChatService | "t3" | "foundation-agent";
  /** the thing's id over there: a Slack channel id or message ts, a Gmail thread id, a WhatsApp chat id, a T3 thread id */
  externalId: string;
  /** an account on our side the portal runs through (a mailbox, a phone number), when a service has several */
  account?: string;
}

export interface ChatChannel {
  id: string;
  kind: ChatChannelKind;
  /** a channel's slug ("general"); for a dm or group, empty: the client names it from its members */
  name: string;
  /** shown in the head, one line */
  topic: string;
  /** what the channel is for, a sentence */
  purpose: string;
  createdBy: string;
  createdAt: number;
  archivedAt: number | null;
  origin?: ChatOrigin;
  /** every message in the channel has a `seq`; this is the newest */
  lastSeq: number;
  lastPostAt: number;
  /** a few words of the newest message, for the list */
  lastText?: string;
  /** members, for dm, group, agent and portal channels (and private ones the asker is in); open channels send a count only */
  members?: ChatParty[];
  memberCount: number;
  /** the agent this conversation is with (kind "agent") */
  agent?: ChatAgentRef;
  /** a huddle going on in it now */
  huddle?: ChatHuddleState | null;
  pinned?: string[];
}

/** what the asker's membership says about a channel; absent when they haven't joined (an open channel they can still read) */
export interface ChatMembership {
  channel: string;
  /** the newest seq they've seen */
  readSeq: number;
  /** mentions of them above readSeq */
  mentions: number;
  /** all: every message makes it unread · mentions: only a mention does · none: muted */
  notify: "all" | "mentions" | "none";
  starred: boolean;
  joinedAt: number;
}

/** one row of the list: the channel, the asker's membership, and the unread count worked out for them */
export interface ChatChannelView extends ChatChannel {
  me: ChatMembership | null;
  unread: number;
}

// ---------- who speaks ----------

export type ChatAuthorKind = "person" | "agent" | "ghost" | "system";

export interface ChatAgentRef {
  /** the agent's name as the crew and the council know it ("Wren", "Claude"): its avatar is found by this */
  name: string;
  /** which agent it is: "claude", "t3:<agent id>", "shiba", "mcp" */
  via?: string;
  /** the T3 thread or Foundation session this conversation is, when it is one */
  session?: string;
}

export interface ChatParty {
  kind: ChatAuthorKind;
  /** a user id, an agent's name, a ghost id ("gh_…"), or "system" */
  id: string;
  name: string;
  color?: string;
  /** agent: which agent it is */
  via?: string;
  /** agent: the person it was working for when it wrote this */
  forName?: string;
  /** ghost: the service it speaks from, and its handle there (an address, a number, a username) */
  service?: ChatService;
  handle?: string;
  /** a picture, when the other side gave one (a server path or an https address) */
  avatar?: string;
}

// ---------- messages ----------

export interface ChatFile {
  /** an archive file id (`/files/<id>`) */
  id: string;
  name: string;
  mime: string;
  size: number;
  w?: number;
  h?: number;
}

export interface ChatReaction {
  /** an emoji itself ("👍"), or a shortcode in colons when it has no character (":shipit:") */
  emoji: string;
  /** names of who reacted, people and agents */
  by: string[];
}

/**
 * What a message is, beyond words.
 *  - text: someone said something
 *  - system: someone joined, left, renamed, pinned (text says what)
 *  - huddle: a huddle's card in the channel: started, who was in it, and once it ends its session (recordings, transcript, replay)
 *  - link: a place on a grid (a board, a section, a card)
 *  - draft: an outbound message to a portal that an agent wrote and a person has not sent yet
 */
export type ChatMessageType = "text" | "system" | "huddle" | "link" | "draft";

export interface ChatLinkPreview {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  site?: string;
}

export interface ChatMessage {
  id: string;
  channel: string;
  /** its place in the channel, counting from 1; never reused */
  seq: number;
  author: ChatParty;
  type: ChatMessageType;
  /** markdown */
  text: string;
  /** the message this replies to (a thread's first message), or null */
  root: string | null;
  createdAt: number;
  editedAt: number | null;
  /** removed: the text and files are gone from what's sent, the row stays so the thread holds together */
  deletedAt: number | null;
  files: ChatFile[];
  reactions: ChatReaction[];
  /** on a thread's first message */
  replyCount: number;
  lastReplyAt: number | null;
  /** names of who replied, at most five */
  repliers?: string[];
  pinned: boolean;
  /** users this mentions (ids), plus "channel" or "here" */
  mentions: string[];
  previews?: ChatLinkPreview[];
  origin?: ChatOrigin;
  /** type "huddle" */
  huddle?: { id: string; session?: string; startedAt: number; endedAt?: number; people: string[]; recorded?: boolean; board?: string; /** the section of `board` it was taken to */ section?: string };
  /** type "link" */
  place?: { board: string; boardName?: string; section?: string; object?: string; label: string };
  /** type "draft": where it stands (drafted by an agent · sent by a person · failed with why) */
  outbound?: { state: "draft" | "sending" | "sent" | "failed"; by?: string; at?: number; error?: string };
}

/** a page of messages, Mattermost's PostList in spirit: oldest first, with what's either side */
export interface ChatPage {
  messages: ChatMessage[];
  /** there are older / newer messages than these */
  before: boolean;
  after: boolean;
}

// ---------- huddles in a channel ----------

export interface ChatHuddleState {
  /** the huddle's id; it always signals on `/huddle/chat/:id`, wherever it is shown */
  id: string;
  /** where it is shown: `chat` until it is taken to a grid, then that grid (its card there is a view of the same room) */
  board: string;
  /** the section of `board` it was taken to */
  section?: string;
  liveSince: number;
  people: string[];
  recording: boolean;
  /** agents seated in it */
  agents?: string[];
}

// ---------- bridges ----------

export type ChatBridgeState = "off" | "needs-setup" | "connecting" | "live" | "error";

export interface ChatBridgeStatus {
  service: ChatService;
  name: string;
  state: ChatBridgeState;
  /** in a sentence: what it is doing, or what it needs ("Needs a Meta app's token and phone number id") */
  detail: string;
  /** what a person must do, in order, when it needs setting up */
  steps?: string[];
  /** the env vars or settings it reads, and whether each is set (never their values) */
  needs?: Array<{ key: string; set: boolean; what: string }>;
  /** can it send, or only receive */
  canSend: boolean;
  /** a rule the other side sets on replies ("Replies only within 24 hours of their last message") */
  window?: string;
  portals: number;
  lastEventAt?: number;
}

// ---------- who is where (2026-11-21) ----------

/**
 * Who is on a grid right now (Josh, 2026-11-21: "show when people are in the boards and collaborating, as well as the
 * agents"): the people with it open (each once, however many windows) and the agents at work on it. Read from the
 * grid's live presence on the server (apps/server/src/whereabouts.ts); `GET /api/whereabouts` and the chat socket's
 * `where` event carry it, for the grids the person can see.
 */
export interface WherePerson {
  id: string;
  name: string;
  /** their cursor's colour on the grid */
  color: string;
}
export interface WhereAgent {
  /** its presence on the grid (crew.ts) */
  id: string;
  name: string;
  /** 0–5: the crew colour */
  hue: number;
  /** "claude", "t3:<id>" */
  via: string;
  status: "working" | "done" | "stopped" | "error" | "idle";
  doing?: string;
  /** who asked it */
  askerName?: string;
}
export interface WhereBoard {
  people: WherePerson[];
  agents: WhereAgent[];
}

// ---------- the wire (/chat) ----------

/**
 * Server → client on the chat socket. One socket per window carries every channel the person can see.
 * `rev` counts up by one per event on a connection; a gap, or a reconnect, means: fetch the list again
 * and the open channel `since` its newest message.
 */
export type ChatEvent =
  | { t: "hello"; rev: number; you: string; at: number }
  | { t: "message"; rev: number; message: ChatMessage; /** the sender's request id, so their window can swap its pending copy */ requestId?: string }
  | { t: "message-changed"; rev: number; message: ChatMessage }
  | { t: "channel"; rev: number; channel: ChatChannel }
  | { t: "channel-gone"; rev: number; channel: string }
  | { t: "member"; rev: number; channel: string; party: ChatParty; joined: boolean }
  | { t: "read"; rev: number; channel: string; readSeq: number; mentions: number }
  | { t: "typing"; rev: number; channel: string; root: string | null; party: ChatParty }
  | { t: "presence"; rev: number; online: string[] }
  /** who is on each grid this person can see, whenever that changes (whereabouts.ts) */
  | { t: "where"; rev: number; boards: Record<string, WhereBoard> }
  | { t: "bridge"; rev: number; bridge: ChatBridgeStatus };

/** Client → server on the chat socket. Everything that changes anything goes over HTTP; the socket only says what's passing. */
export type ChatSay = { t: "typing"; channel: string; root?: string | null } | { t: "ping" };

// ---------- the pure rules ----------

export const CHAT_TEXT_MAX = 16000;
export const CHAT_FILES_MAX = 12;
export const CHAT_GROUP_MAX = 8;
export const CHAT_TYPING_MS = 5000;

/** a channel's name as a slug: lower case, digits, hyphens and underscores, 1–80 */
export function chatSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/^#/, "")
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** the key that makes a dm or a group one conversation however it is asked for: its members, sorted */
export function chatMembersKey(ids: string[]): string {
  return [...new Set(ids)].sort().join("__");
}

/** `@name` handles in a text: a person is mentioned by their handle (see chatHandle), everyone by @channel, those here by @here */
export function chatMentionHandles(text: string): string[] {
  const out = new Set<string>();
  // not inside code: drop fences and spans first
  const plain = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
  for (const m of plain.matchAll(/(^|[^\p{L}\p{N}_@./])@([\p{L}\p{N}][\p{L}\p{N}._-]{0,63})/gu)) out.add(m[2].replace(/[.]+$/, "").toLowerCase());
  return [...out];
}

/** a person's handle: their name with no spaces, lower case ("Josh Leong" → "josh.leong"), so `@josh.leong` finds them */
export function chatHandle(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ".").replace(/[^\p{L}\p{N}._-]/gu, "") || "someone";
}

/** how many messages a member hasn't seen, given how they want to hear about it */
export function chatUnread(lastSeq: number, me: Pick<ChatMembership, "readSeq" | "mentions" | "notify"> | null): number {
  if (!me) return 0;
  if (me.notify === "none") return 0;
  if (me.notify === "mentions") return me.mentions;
  return Math.max(0, lastSeq - me.readSeq);
}

/** a dm's or group's name for one of its members: the others, by name */
export function chatTitle(channel: Pick<ChatChannel, "kind" | "name" | "members" | "agent" | "origin">, meId?: string): string {
  if (channel.kind === "agent" && channel.agent && !channel.name) return channel.agent.name;
  if (channel.name) return channel.name;
  const others = (channel.members ?? []).filter((m) => m.id !== meId);
  if (!others.length) return (channel.members ?? [])[0]?.name ?? "Just you";
  return others.map((m) => m.name).join(", ");
}

const SLACK_EMOJI: Record<string, string> = {
  "+1": "👍", thumbsup: "👍", "-1": "👎", thumbsdown: "👎", heart: "❤️", tada: "🎉", eyes: "👀", fire: "🔥", rocket: "🚀", white_check_mark: "✅", heavy_check_mark: "✔️",
  x: "❌", pray: "🙏", raised_hands: "🙌", clap: "👏", wave: "👋", smile: "😄", slightly_smiling_face: "🙂", joy: "😂", sob: "😭", thinking_face: "🤔", "100": "💯",
  point_up: "☝️", muscle: "💪", warning: "⚠️", bulb: "💡", star: "⭐", sparkles: "✨", bug: "🐛", wrench: "🔧", hammer_and_wrench: "🛠️", package: "📦", memo: "📝",
  calendar: "📅", link: "🔗", lock: "🔒", zap: "⚡", ok_hand: "👌", grinning: "😀", sweat_smile: "😅", cry: "😢", party_parrot: ":party_parrot:", robot_face: "🤖", checkered_flag: "🏁",
};

/** a Slack shortcode as an emoji where it has one (":+1:" → "👍"); otherwise the shortcode stays, in colons */
export function slackEmoji(name: string): string {
  const base = name.replace(/::skin-tone-\d$/, "");
  return SLACK_EMOJI[base] ?? `:${base}:`;
}

/**
 * Slack's mrkdwn as markdown. `who` and `where` name the users and channels its `<@U…>` and `<#C…>` point
 * at (an unknown one keeps its fallback label, or its id). Mentions come out as `@handle`, so a brought-in
 * message mentions the same person here.
 */
export function slackToMarkdown(text: string, who: (id: string) => string | undefined = () => undefined, where: (id: string) => string | undefined = () => undefined): string {
  let t = text ?? "";
  // entities first, while the angle brackets are still Slack's
  t = t.replace(/<([^<>\n]+)>/g, (_all, inner: string) => {
    const [target, label] = inner.split(/\|(.*)/s) as [string, string | undefined];
    if (target.startsWith("@")) return `@${who(target.slice(1)) ?? label ?? target.slice(1)}`;
    if (target.startsWith("#")) return `#${where(target.slice(1)) ?? label ?? target.slice(1)}`;
    if (target.startsWith("!subteam")) return label ?? "@group";
    if (target.startsWith("!date")) return label ?? "";
    if (target === "!here" || target === "!channel" || target === "!everyone") return target === "!here" ? "@here" : "@channel";
    if (target.startsWith("!")) return label ?? `@${target.slice(1)}`;
    if (target.startsWith("mailto:")) return label && label !== target.slice(7) ? `[${label}](${target})` : target.slice(7);
    if (/^https?:\/\//.test(target)) return label && label !== target ? `[${label.replace(/[[\]]/g, "")}](${target})` : target;
    return _all;
  });
  // styles, outside code. Slack: *bold* _italic_ ~strike~ ; markdown: **bold** _italic_ ~~strike~~
  const parts = t.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  t = parts
    .map((p, i) => {
      if (i % 2) return p;
      return p
        .replace(/(^|[\s(>])\*([^*\n]+)\*(?=$|[\s).,!?:;<])/gm, "$1**$2**")
        .replace(/(^|[\s(>])~([^~\n]+)~(?=$|[\s).,!?:;<])/gm, "$1~~$2~~")
        .replace(/^•\s/gm, "- ")
        .replace(/:([a-z0-9_+-]+(?:::skin-tone-\d)?):/g, (_m, n: string) => slackEmoji(n));
    })
    .join("");
  // Slack escapes only these three
  return t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** a Slack `ts` ("1714654000.000100") as epoch milliseconds */
export function slackTsMs(ts: string): number {
  return Math.round(Number(ts) * 1000);
}

/** a search as typed, pulled apart: `from:ada in:general before:2026-11-01 "exact words" rest` */
export interface ChatQuery {
  words: string;
  from?: string;
  in?: string;
  before?: number;
  after?: number;
  has?: "file" | "link" | "pin";
}

export function parseChatQuery(q: string): ChatQuery {
  const out: ChatQuery = { words: "" };
  const rest: string[] = [];
  for (const m of q.matchAll(/"[^"]*"|\S+/g)) {
    const tok = m[0];
    const kv = /^(from|in|before|after|has|on):(.+)$/i.exec(tok);
    if (!kv) {
      rest.push(tok);
      continue;
    }
    const [, k, v] = kv;
    const key = k.toLowerCase();
    if (key === "from") out.from = v.replace(/^@/, "").toLowerCase();
    else if (key === "in") out.in = v.replace(/^#/, "").toLowerCase();
    else if (key === "has" && (v === "file" || v === "link" || v === "pin")) out.has = v;
    else if (key === "before" || key === "after" || key === "on") {
      const at = Date.parse(v);
      if (Number.isNaN(at)) rest.push(tok);
      else if (key === "before") out.before = at;
      else if (key === "after") out.after = at;
      else {
        out.after = at - 1;
        out.before = at + 86400000;
      }
    } else rest.push(tok);
  }
  out.words = rest.join(" ").trim();
  return out;
}
