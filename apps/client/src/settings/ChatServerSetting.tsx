/**
 * Settings → General → ChatForm's server: the address this device's ChatForm uses (chat/server.ts), or
 * Foundation's own; changing it reloads the window. On a chat server, who this device is there, and signing out
 * of it (Foundation's own sign-in stays). The view is presentational, so `#/design` draws it from fixtures.
 */

import { useState } from "react";
import { SERVER_NAME } from "../lib/api";
import { BUILT_CHAT_SERVER, CHAT_SERVER, chooseChatServer, REMEMBERED_CHAT_SERVERS } from "../chat/server";
import { chatServerName, chatServerOrigin, type KnownChatServer } from "../chat/serverLogic";
import { signOutOfChat, useChat } from "../chat/model";
import { Row } from "./SettingsSpace";
import "../chat/chat.css";

export interface ChatServerSettingViewProps {
  /** the chat server in use ("" when ChatForm is on Foundation's) */
  current: string;
  /** the Foundation server this app uses, as a person would say it */
  foundation: string;
  /** who this device is on the chat server */
  account?: { name: string; email: string } | null;
  /** the servers to offer with a Use each: the team's, and the ones this device has used */
  remembered?: KnownChatServer[];
  onUse(address: string): void;
  onSignOut?(): void;
  error?: string;
  initialDraft?: string;
}

export function ChatServerSettingView(p: ChatServerSettingViewProps) {
  const [draft, setDraft] = useState(p.initialDraft ?? (p.current ? chatServerName(p.current) : ""));
  const origin = chatServerOrigin(draft);
  const same = !!origin && origin === p.current;
  return (
    <>
      <Row
        name={p.current ? chatServerName(p.current) : "Foundation's own server"}
        detail={
          p.current
            ? `On this device, channels, direct messages, threads and search come from this chat server. Grids, files, agents and huddles stay on ${p.foundation}.`
            : `ChatForm is on ${p.foundation}, with everything else. A chat server is one the whole team reaches by account, wherever they are.`
        }
      >
        {p.current && (
          <button type="button" className="f-pill" onClick={() => p.onUse("")} data-chat-server-own>
            Use Foundation's
          </button>
        )}
      </Row>
      {(p.remembered ?? []).map((s) => {
        const inUse = s.origin === p.current;
        return (
          <Row key={s.origin} name={s.name ?? chatServerName(s.origin)} detail={s.name ? `${s.note ? `${s.note} · ` : ""}${chatServerName(s.origin)}` : (s.note ?? "Used on this device before")}>
            <button type="button" className="f-pill" disabled={inUse} onClick={() => p.onUse(s.origin)} data-chat-server-remembered={s.origin}>
              {inUse ? "In use" : "Use"}
            </button>
          </Row>
        );
      })}
      <Row name="A chat server's address" detail={p.error ? <span className="chat-server-error">{p.error}</span> : "Changing it reloads this window. You sign in there once, with Google."}>
        <form
          className="chat-server-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim() && !same) p.onUse(draft);
          }}
        >
          <span className="chat-field-input">
            <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="chat.example.app" spellCheck={false} autoCapitalize="off" autoCorrect="off" aria-label="A chat server's address" data-chat-server-address />
          </span>
          <button type="submit" className="f-pill" disabled={!draft.trim() || same} data-chat-server-use>
            Use
          </button>
        </form>
      </Row>
      {p.current && (
        <Row name={p.account ? p.account.name : "Not signed in there"} detail={p.account ? `${p.account.email} on ${chatServerName(p.current)}` : "Open ChatForm to sign in on the chat server."}>
          {p.account && (
            <button type="button" className="f-pill" onClick={p.onSignOut} data-chat-server-signout>
              Sign out of ChatForm's server
            </button>
          )}
        </Row>
      )}
    </>
  );
}

/** Settings → General: the rows of the "ChatForm's server" group */
export function ChatServerSetting() {
  const s = useChat();
  const [error, setError] = useState("");
  return (
    <ChatServerSettingView
      current={CHAT_SERVER}
      foundation={SERVER_NAME}
      account={s.account}
      remembered={REMEMBERED_CHAT_SERVERS}
      error={error}
      initialDraft={CHAT_SERVER ? undefined : BUILT_CHAT_SERVER ? chatServerName(BUILT_CHAT_SERVER) : ""}
      onUse={(a) => {
        try {
          setError("");
          chooseChatServer(a);
        } catch (e) {
          setError((e as Error).message);
        }
      }}
      onSignOut={() => void signOutOfChat()}
    />
  );
}
