/**
 * The Inbox on `#/design` (ChatForm chapter): the cards from fixtures (This Foundation; Mail connected for
 * you; Slack with two linked channels; WhatsApp needing setup; Instagram live; WeChat off), a setup wizard
 * on its first and its webhook step, the Slack guide's channel table and its first screen, and the nudge.
 * No server: nothing here presses anything real.
 */

import type { UserInfo } from "@foundation/protocol";
import { InboxView } from "./Inbox";
import { SetupWizard } from "./SetupWizard";
import { NudgeCard, SlackGuide, type SlackChannelRow } from "./SlackGuide";
import type { BridgeView, Bridges, SlackView } from "./bridges";
import "./inbox.css";
import "./slackguide.css";

const NOW = Date.now();
const MIN = 60_000;
const JOSH: UserInfo = { id: "u_josh", email: "josh@formindustries.com", name: "Josh Leong", color: "var(--viz-2)", role: "admin" };
const ADA: UserInfo = { id: "u_ada", email: "ada@formindustries.com", name: "Ada Lovelace", color: "var(--viz-1)", role: "member" };
const SETTINGS = { enabled: true, inbox: [], puppet: null, inboxIsAdmins: true };
const SERVER = { publicUrl: "http://localhost:4410", reachable: false, why: "This server's public address is http://localhost:4410, which only this computer or this network can reach. Meta and WeCom deliver messages to a public https address, so they can't reach it yet." };

const bridge = (b: Partial<BridgeView> & Pick<BridgeView, "service" | "name" | "state" | "detail">): BridgeView => ({ canSend: false, portals: 0, settings: SETTINGS, list: [], canStart: false, ...b });

const SLACK: SlackView = {
  status: { service: "slack", name: "Slack", state: "live", detail: "2 channels in step with Slack (Form Industries)", canSend: true, portals: 2 },
  admin: true,
  token: { set: true, source: "stored", tail: "Qx7a", setBy: "Josh Leong", setAt: NOW - 3 * 864e5 },
  app: { ok: true, team: "Form Industries", url: "https://formindustries.slack.com/", bot: "foundation", checkedAt: NOW - 5 * MIN, error: null },
  scopes: { have: ["channels:read", "groups:read", "channels:history", "groups:history", "channels:join", "chat:write", "chat:write.customize", "users:read", "users:read.email", "files:read"], need: ["channels:read", "groups:read", "channels:history", "groups:history", "channels:join", "chat:write", "chat:write.customize", "users:read", "users:read.email", "files:read", "reactions:read"], optional: ["files:write"], missing: ["reactions:read"], files: "line" },
  events: ["message.channels", "message.groups", "reaction_added", "reaction_removed"],
  mode: "polling",
  pollSeconds: 10,
  links: [
    { channel: "ch_general", name: "general", kind: "open", slackId: "C0GENERAL1", slackName: "general", private: false, state: "live", linkedBy: "Josh Leong", linkedAt: NOW - 2 * 864e5, lastReadAt: NOW - MIN, lastInAt: NOW - 4 * MIN, lastOutAt: NOW - 12 * MIN },
    { channel: "ch_shop", name: "shop-floor", kind: "open", slackId: "C0SHOPFLR1", slackName: "shop-floor", private: false, state: "paused", linkedBy: "Josh Leong", linkedAt: NOW - 864e5, lastReadAt: NOW - 90 * MIN, lastInAt: NOW - 2 * 3600_000, lastOutAt: null },
  ],
  history: { channels: 14, lastImportAt: NOW - 3 * 864e5 },
  nudge: false,
  nudgeDismissed: false,
};

const DATA: Bridges = {
  admin: true,
  demo: false,
  server: SERVER,
  slack: SLACK,
  bridges: [
    bridge({ service: "gmail", name: "Mail", state: "live", detail: "Watching 2 mailboxes", canSend: true, portals: 3, lastEventAt: NOW - 6 * MIN, accounts: [{ email: "josh@formindustries.com", userId: "u_josh", label: "Foundation", labelFound: true, lastSyncAt: NOW - 2 * MIN, connectedAt: NOW - 9 * 864e5, error: null }, { email: "ops@formindustries.com", userId: "u_kai", label: "Foundation", labelFound: true, lastSyncAt: NOW - 3 * MIN, connectedAt: NOW - 20 * 864e5, error: null }], needs: [{ key: "GMAIL_CLIENT_ID", set: true, what: "A Google OAuth client id" }, { key: "GMAIL_CLIENT_SECRET", set: true, what: "Its secret" }] }),
    bridge({ service: "whatsapp", name: "WhatsApp", state: "needs-setup", detail: "Needs WHATSAPP_TOKEN, WHATSAPP_APP_SECRET.", window: "Replies only within 24 hours of the customer's last message.", keys: [{ key: "WHATSAPP_TOKEN", what: "A system user's permanent access token", set: false, source: null }, { key: "WHATSAPP_PHONE_NUMBER_ID", what: "The business phone number's id", set: true, source: "stored", tail: "8765", setBy: "Josh Leong" }, { key: "WHATSAPP_APP_SECRET", what: "The Meta app's secret", set: false, source: null }, { key: "WHATSAPP_VERIFY_TOKEN", what: "The verify token", set: true, source: "env" }] }),
    bridge({ service: "instagram", name: "Instagram", state: "live", detail: "Receiving direct messages for account …4411", canSend: true, portals: 1, lastEventAt: NOW - 50 * MIN, list: [{ id: "p1", name: "studio.vale", topic: "Instagram", lastPostAt: NOW - 50 * MIN, lastText: "Rosa Vale: Do you ship to Hilo?", unread: 1, demo: false, window: { open: true, rule: "", closesAt: NOW + 23 * 3600_000 } }] }),
    bridge({ service: "wechat", name: "WeChat", state: "off", detail: "WeChat is turned off: nothing comes in or goes out." }),
  ],
};

const CHANNELS: SlackChannelRow[] = [
  { id: "C0GENERAL1", name: "general", private: false, member: true, members: 31, topic: "", link: SLACK.links[0], lands: { id: "ch_general", name: "general", how: "imported" } },
  { id: "C0AIRFORM1", name: "airform-pthp", private: false, member: true, members: 9, topic: "", link: null, lands: { id: "ch_air", name: "airform-pthp", how: "imported" } },
  { id: "C0DESIGN01", name: "design", private: false, member: true, members: 12, topic: "", link: null, lands: { id: "ch_d", name: "design-slack", how: "create" } },
  { id: "C0RANDOM01", name: "random", private: false, member: false, members: 30, topic: "", link: null, lands: { id: null, name: "random", how: "merge" } },
  { id: "G0BOARD001", name: "board-only", private: true, member: false, members: 4, topic: "", link: null, lands: { id: null, name: "board-only", how: "create" } },
];

export function InboxDemo() {
  const noop = () => {};
  return (
    <div className="design-chat-inbox" data-inbox-demo>
      <h3 className="design-sub">Inbox: what's connected, and the buttons that connect the rest</h3>
      <div className="inbox" style={{ position: "relative", overflow: "visible" }}>
        <div className="inbox-page">
          <InboxView data={DATA} user={JOSH} version="0.3.24" reload={noop} still />
        </div>
      </div>
      <h3 className="design-sub">A setup wizard: the honest first step, and the webhook step</h3>
      <div className="design-chat-row">
        <SetupWizard service="whatsapp" bridge={DATA.bridges[1]} server={SERVER} admin onClose={noop} inline />
        <SetupWizard service="whatsapp" bridge={DATA.bridges[1]} server={SERVER} admin onClose={noop} inline startAt={4} />
      </div>
      <h3 className="design-sub">The Slack guide: two paths, and the channels table · the nudge</h3>
      <div className="design-chat-row">
        <SlackGuide user={ADA} onClose={noop} inline demo={{ view: SLACK, channels: CHANNELS }} />
        <SlackGuide user={JOSH} onClose={noop} start="bridge" inline demo={{ view: SLACK, channels: CHANNELS, step: 2 }} />
      </div>
      <NudgeCard onStart={noop} onLater={noop} still />
    </div>
  );
}
