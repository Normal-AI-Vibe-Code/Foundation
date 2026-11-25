/**
 * `#/design` → ChatForm: the bell (resting, with a count, its panel with three rows, empty, and on a server that
 * keeps no list), a link preview (a card whose picture waits for a press, a card with none, a link straight to a
 * GIF), a file going up and one that was too big, and the setting's row. All from fixtures: no server is asked.
 */

import type { ChatLinkPreview, ChatMessage, ChatParty } from "@foundation/protocol";
import { BellButton, BellPanel } from "./Bell";
import { Composer } from "./Composer";
import { LinkPreviews } from "./Files";
import { TellSettingView } from "./TellSetting";
import { uploadFailure } from "./serverLogic";
import type { Notice, Seen } from "./notifyLogic";
import "./chat.css";
import "./bell.css";

const NOW = Date.now();
const MIN = 60_000;
const ADA: ChatParty = { kind: "person", id: "u_ada", name: "Ada Lovelace", color: "var(--viz-1)" };
const KAI: ChatParty = { kind: "person", id: "u_kai", name: "Kai Moreno", color: "var(--viz-3)" };
const WREN: ChatParty = { kind: "agent", id: "Wren", name: "Wren", via: "claude", forName: "Ada Lovelace" };

const msg = (id: string, author: ChatParty, minsAgo: number, text: string, channel: string, seq: number): ChatMessage => ({
  id, channel, seq, author, type: "text", text, root: null, createdAt: NOW - minsAgo * MIN, editedAt: null, deletedAt: null, files: [], reactions: [], replyCount: 0, lastReplyAt: null, pinned: false, mentions: [],
});

const NOTICES: Notice[] = [
  { id: "n_1", why: "mention", channel: { id: "ch_shroud", name: "fan-shroud", kind: "open" }, message: msg("n_1", ADA, 2, "@josh.leong can you look at rev C before it prints? The inlet lip is **2 mm** thicker.", "ch_shroud", 41) },
  { id: "n_2", why: "direct", channel: { id: "ch_kai", name: "Kai Moreno", kind: "dm" }, message: msg("n_2", KAI, 14, "The quote from Mei is in. Shall I confirm it today?", "ch_kai", 12) },
  { id: "n_3", why: "everyone", channel: { id: "ch_general", name: "general", kind: "open" }, message: msg("n_3", WREN, 190, "@channel the flow report for rev C is on the grid.", "ch_general", 88) },
];
/** the third was pressed earlier: seen */
const SEEN: Seen = { allAt: 0, ids: ["n_3"] };

const PREVIEWS: ChatLinkPreview[] = [
  { url: "https://prints.example.com/model/fan-shroud", site: "Example Prints", title: "Fan shroud, 120 mm, rev C", description: "A printable shroud for a 120 mm fan with a thicker inlet lip. PA12 or PETG, no supports at 45°.", image: "https://media.example.com/shroud.jpg" },
  { url: "https://docs.example.com/print-farm", site: "Example Docs", title: "The print farm: queue and profiles", description: "How jobs are queued, which profile to pick, and who to ask." },
];
const GIF: ChatLinkPreview[] = [{ url: "https://media.example.com/ship-it.gif", image: "https://media.example.com/ship-it.gif" }];

const noop = () => {};

export function BellDemo() {
  const tooBig = uploadFailure({ name: "walkthrough.mov", size: 6.4 * 1024 * 1024 }, 413, { error: "file too large", limit: 4 * 1024 * 1024 }, "chat.example.app");
  return (
    <div className="chat-server-demo" data-bell-demo>
      <div>
        <p className="chat-demo-cap">The bell · resting, with a count, open</p>
        <div className="chat-demo-bar" style={{ gap: "var(--space-5)" }}>
          <BellButton count={0} />
          <BellButton count={3} />
          <BellButton count={128} />
          <BellButton count={3} open />
        </div>
      </div>
      <div>
        <p className="chat-demo-cap">Its panel · three rows, two not seen yet</p>
        <BellPanel inPlace notices={NOTICES} seen={SEEN} count={2} now={NOW} onClose={noop} onAll={noop} onSeeAll={noop} onSettings={noop} />
      </div>
      <div>
        <p className="chat-demo-cap">Nothing new</p>
        <BellPanel inPlace notices={[]} seen={SEEN} count={0} told now={NOW} onClose={noop} onAll={noop} onSeeAll={noop} />
      </div>
      <div>
        <p className="chat-demo-cap">On a server that keeps no list · what's waiting, by conversation</p>
        <BellPanel
          inPlace
          waiting={[
            { channel: "ch_kai", kind: "dm", n: 2, why: "direct", at: NOW - 4 * MIN, text: "Shall I confirm it today?", title: "Kai Moreno" },
            { channel: "ch_design", kind: "private", n: 1, why: "mention", at: NOW - 9 * MIN, text: "Ada: can you sign off the fillet?", title: "#design-review" },
          ]}
          seen={SEEN}
          count={3}
          told
          now={NOW}
          onClose={noop}
        />
      </div>
      <div>
        <p className="chat-demo-cap">A link preview · the page's words at once, its picture on a press</p>
        <LinkPreviews previews={PREVIEWS} />
        <p className="chat-demo-cap" style={{ marginTop: "var(--space-6)" }}>
          A link straight to a GIF
        </p>
        <LinkPreviews previews={GIF} />
      </div>
      <div>
        <p className="chat-demo-cap">A file going up, and one too big for the server</p>
        <Composer
          channel="ch_design_files"
          placeholder="Message #fan-shroud"
          people={[]}
          agents={[]}
          channels={[]}
          initial=""
          autoFocus={false}
          noAttachFrom
          initialChips={[
            { key: "d1", name: "shroud-revC.gif", size: 1_840_000, mime: "image/gif", progress: 0.62 },
            { key: "d2", name: "walkthrough.mov", size: 6_710_000, mime: "video/quicktime", progress: 0, error: tooBig },
          ]}
          onSend={noop}
        />
      </div>
      <div>
        <p className="chat-demo-cap">Settings · General · Notifications (off, on, blocked)</p>
        <div className="chat-server-demo-card is-rows set-rows">
          <TellSettingView on={false} permission="default" onChange={noop} />
          <TellSettingView on permission="granted" onChange={noop} />
          <TellSettingView on={false} permission="denied" onChange={noop} />
        </div>
      </div>
    </div>
  );
}
