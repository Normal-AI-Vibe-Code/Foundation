/**
 * ChatForm's Huddles tab. The huddles builder replaces this file: keep the default export and its props
 * (`{ user, rest }`: who's signed in, and what follows `#/chat/huddles/` in the address).
 */

import type { UserInfo } from "@foundation/protocol";

export default function HuddlesTab({ user, rest }: { user: UserInfo; rest: string }) {
  void user;
  void rest;
  return (
    <div className="chat-tab-empty" data-chat-tab="huddles">
      <h2>Huddles</h2>
      <p>The huddles going on now, and every one recorded: who was there, for how long, the transcript, the recordings and Replay on its grid.</p>
    </div>
  );
}
