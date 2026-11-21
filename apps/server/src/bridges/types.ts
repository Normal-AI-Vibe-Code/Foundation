/**
 * What a bridge adapter is (docs/chatform.md §1 "Honest bridges"; chatbridges.ts is the framework).
 * An adapter knows one service's official API and nothing about ChatForm's store: it says where it
 * stands, checks and reads the service's webhooks into normalized events, and sends a person's message
 * out. The framework turns events into portals, ghosts and messages, and decides what may be sent.
 */

import type { ChatBridgeStatus, ChatChannel, ChatService, UserInfo } from "@foundation/protocol";
import type { Req, Router } from "../http.ts";

/** the live bridges (Slack is history brought in, not a bridge) */
export type BridgeService = Exclude<ChatService, "slack">;

/** a portal as an adapter sees it: the channel, where it points, and what the adapter kept about it */
export interface Portal {
  channel: ChatChannel;
  service: BridgeService;
  externalId: string;
  account?: string;
  /** the adapter's own notes on the conversation (a mail thread's subject and reference chain) */
  meta: Record<string, unknown>;
  /** the newest message the other side sent (epoch ms), for reply windows */
  lastInboundAt: number | null;
  demo: boolean;
}

export interface OutboundFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  body: Buffer;
}

export interface SendResult {
  /** the message's id over there (so its echo, or its delivery status, finds it) */
  externalId?: string;
  /** merged into the portal's meta */
  meta?: Record<string, unknown>;
}

/** an attachment that came in: its bytes, or where to fetch them (only from the service's own hosts, under the size cap) */
export interface InboundFile {
  name: string;
  mime: string;
  size?: number;
  data?: Buffer;
  url?: string;
  headers?: Record<string, string>;
  /** found later, when the event is processed (a WhatsApp media id becomes a URL through the Graph API) */
  resolve?: () => Promise<{ url?: string; headers?: Record<string, string>; mime?: string; data?: Buffer }>;
}

export interface InboundMessage {
  kind: "message";
  conversation: {
    externalId: string;
    account?: string;
    name: string;
    topic?: string;
    meta?: Record<string, unknown>;
    /** people (user ids) to add to a new portal besides the bridge's inbox (the mailbox's owner) */
    members?: string[];
  };
  from: {
    handle: string;
    name?: string;
    avatar?: string;
    /** sent from our side, outside Foundation (on the phone, in Gmail): drawn as `person` when we know who */
    self?: boolean;
    person?: string;
  };
  externalId: string;
  text: string;
  at?: number;
  files?: InboundFile[];
}

export interface InboundStatus {
  kind: "status";
  /** the id the send answered with */
  externalId: string;
  state: "sent" | "delivered" | "read" | "failed";
  error?: string;
}

export type InboundEvent = InboundMessage | InboundStatus;

/** the reply rule the other side sets, for one portal */
export interface ReplyWindow {
  open: boolean;
  rule: string;
  closesAt?: number;
  /** why it's shut, in a sentence a person can act on */
  why?: string;
}

/** what an adapter says about itself; the framework adds the name, the portal count, the last event, and "off" */
export type AdapterStatus = Pick<ChatBridgeStatus, "state" | "detail" | "steps" | "needs" | "canSend" | "window">;

/** what the framework gives an adapter that works on its own (polling, its own routes) */
export interface BridgeContext {
  ingest(events: InboundEvent[]): Promise<void>;
  portal(channelId: string): Portal | undefined;
  /** say the status changed (the Inbox tab hears it) */
  changed(): void;
}

export interface BridgeAdapter {
  service: BridgeService;
  name: string;
  status(): AdapterStatus;
  /** the GET handshake a service makes when its webhook is set up */
  verifyWebhook?(req: Req): { status: number; body: string };
  /** a POST to the webhook: check its signature on the raw body (throw HttpError 401), then read it. No network here: answer fast */
  receive?(req: Req, raw: Buffer): Promise<{ events: InboundEvent[]; ack?: string }>;
  send(portal: Portal, out: { text: string; files: OutboundFile[] }): Promise<SendResult>;
  /** begin polling or renewing a watch */
  start?(ctx: BridgeContext): void;
  stop?(): void;
  window?(portal: Portal): ReplyWindow;
  /** host names (exact, or ".suffix") inbound file URLs may come from */
  mediaHosts?(): string[];
  /** who a handle is, when the webhook didn't say (Instagram gives only an id) */
  profile?(handle: string, account?: string): Promise<{ name?: string; avatar?: string }>;
  /** a person starts a conversation from our side; absent: `startRule` says why it can't */
  startConversation?(by: UserInfo, body: Record<string, unknown>): Promise<{ conversation: InboundMessage["conversation"]; externalId: string; text: string }>;
  startRule?: string;
  /** routes of its own (Gmail's Connect mail) */
  routes?(r: Router, ctx: BridgeContext): void;
  /** sample events for FOUNDATION_BRIDGE_DEMO */
  demo(): InboundEvent[];
}
