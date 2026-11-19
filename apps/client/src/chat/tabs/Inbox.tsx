/**
 * ChatForm's Inbox tab. The inbox builder replaces this file: keep the default export and its props
 * (`{ user, rest }`: who's signed in, and what follows `#/chat/inbox/` in the address).
 */

import type { UserInfo } from "@foundation/protocol";

export default function InboxTab({ user, rest }: { user: UserInfo; rest: string }) {
  void user;
  void rest;
  return (
    <div className="chat-tab-empty" data-chat-tab="inbox">
      <h2>Inbox</h2>
      <p>Mail, WhatsApp, Instagram and WeChat come in here as conversations, each bridge with where it stands and the steps to connect it, beside the history brought in from Slack.</p>
    </div>
  );
}
