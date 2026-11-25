/**
 * ChatForm on a server of its own (chat/server.ts), the parts a person sees:
 *
 *  - **ChatSignIn**: where the Chat tab is until this device is signed in on the chat server. One press opens
 *    Google in the system browser; meanwhile this panel shows the code of eight (login/SignInCode.tsx), which the
 *    browser shows back before asking "This is me" (apps/chatserver/src/app_signin.rs). Nothing is signed in until
 *    that press. A local test server offers its email-only sign-in instead. Blue, never violet: a person signs in.
 *  - The setting itself is Settings → General → ChatForm's server (settings/ChatServerSetting.tsx).
 *  - **ChatServerNote**: the strip's right end, in place of the Foundation server's note: which chat server, and
 *    who this device is there.
 *
 * The views are presentational, so `#/design` draws them from fixtures.
 */

import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { goSettings } from "../lib/place";
import { SignInCode } from "../login/SignInCode";
import { CHAT_REMOTE, CHAT_SERVER_NAME, chatBegin, chatConfig, chatDevLogin, chatPoll, type ChatServerConfig } from "./server";
import { chatSignedIn, useChat } from "./model";
import "./chat.css";

const inDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// ---------------------------------------------------------------- signing in

export interface ChatSignInViewProps {
  /** the chat server, as a person would say it */
  server: string;
  /** what the server offers: null while it's being asked */
  config: Pick<ChatServerConfig, "google" | "devLogin" | "app"> | null;
  /** why the server couldn't be asked, or why the sign-in didn't finish */
  error?: string;
  /** the store's own line (a sign-in that ended) */
  note?: string;
  /** Google is open in the browser: the code this window shows */
  code?: string | null;
  /** the sign-in page's address, for when the browser didn't open it (a blocked new tab) */
  link?: string | null;
  waiting?: boolean;
  busy?: boolean;
  onGoogle?(): void;
  onCancel?(): void;
  onDev?(email: string, name: string): void;
  onRetry?(): void;
  onSettings?(): void;
}

export function ChatSignInView(p: ChatSignInViewProps) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const canApp = !!p.config && (p.config.app ?? p.config.google);
  return (
    <div className="chat-tab-empty chat-signin" data-chat-signin>
      <h2>Sign in to ChatForm</h2>
      <p>
        On this device ChatForm is on its own server, <strong>{p.server}</strong>. It has its own sign-in; your grids, files and agents stay on Foundation's server.
      </p>
      {p.note && !p.error && <p className="chat-signin-note">{p.note}</p>}
      {p.waiting ? (
        <div className="chat-signin-wait" role="status">
          <p>Waiting for Google in your browser. Check that the page there shows this code, then press <em>This is me</em>.</p>
          {p.code && <SignInCode code={p.code} />}
          <div className="chat-signin-acts">
            {p.link && (
              <a className="f-pill" href={p.link} target="_blank" rel="noreferrer" data-chat-signin-link>
                Open the sign-in page
              </a>
            )}
            <button type="button" className="f-pill" onClick={p.onCancel}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          {p.error && (
            <p className="chat-signin-error" role="alert">
              {p.error}
            </p>
          )}
          {!p.config && !p.error && <p className="chat-signin-note">Asking {p.server}…</p>}
          <div className="chat-signin-acts">
            {canApp && (
              <button type="button" className="f-pill is-accent" disabled={p.busy} onClick={p.onGoogle} data-chat-signin-google>
                Sign in with Google
              </button>
            )}
            {!p.config && p.error && (
              <button type="button" className="f-pill" onClick={p.onRetry}>
                Try again
              </button>
            )}
            <button type="button" className="f-pill" onClick={p.onSettings}>
              Change ChatForm's server
            </button>
          </div>
          {p.config && !canApp && !p.config.devLogin && <p className="chat-signin-note">Google sign-in isn't set up on {p.server} yet. Whoever runs it adds its Google client; then this button appears.</p>}
          {p.config?.devLogin && (
            <form
              className="chat-signin-dev"
              onSubmit={(e) => {
                e.preventDefault();
                if (email.trim()) p.onDev?.(email.trim(), name.trim());
              }}
            >
              <span className="chat-signin-dev-cap">A test server on this computer: sign in with an address alone</span>
              <label className="chat-field">
                <span>Email</span>
                <span className="chat-field-input">
                  <input value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.stopPropagation()} type="email" placeholder="you@formindustries.co" autoComplete="email" data-chat-signin-email />
                </span>
              </label>
              <label className="chat-field">
                <span>Name</span>
                <span className="chat-field-input">
                  <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} placeholder="Your name" autoComplete="name" />
                </span>
              </label>
              <button type="submit" className="f-pill" disabled={p.busy || !email.trim()} data-chat-signin-dev>
                Sign in
              </button>
            </form>
          )}
        </>
      )}
    </div>
  );
}

export function ChatSignIn({ note }: { note?: string }) {
  const [config, setConfig] = useState<ChatServerConfig | null>(null);
  const [error, setError] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [busy, setBusy] = useState(false);
  const cancel = useRef<(() => void) | null>(null);

  const ask = () => {
    setError("");
    chatConfig().then(setConfig, (e: Error) => setError(e.message));
  };
  useEffect(() => {
    ask();
    // leaving the panel ends the wait (the server's attempt expires by itself in five minutes)
    return () => cancel.current?.();
  }, []);

  const google = async () => {
    setError("");
    setBusy(true);
    // not the app: Google gets its own tab, opened in this press so the browser allows it
    const tab = inDesktop ? null : window.open("", "_blank");
    let live = true;
    cancel.current = () => {
      live = false;
      setWaiting(false);
      setCode(null);
      setLink(null);
    };
    try {
      const { url, poll, code, expiresIn } = await chatBegin();
      setCode(code);
      // the page's address stays on the panel: a browser that blocked the new tab, or a tab closed by mistake
      setLink(url);
      if (tab) tab.location.href = url;
      else if (inDesktop) await openUrl(url);
      setWaiting(true);
      const until = Date.now() + expiresIn * 1000;
      while (live && Date.now() < until) {
        await new Promise((ok) => setTimeout(ok, 1500));
        if (!live) return;
        const r = await chatPoll(poll);
        if (r.status === "ok" && r.user) return chatSignedIn(r.user);
        if (r.status === "error") throw new Error(r.error ?? "The sign-in didn't finish.");
      }
      if (live) throw new Error("The sign-in timed out. Try again.");
    } catch (e) {
      tab?.close();
      if (live) setError((e as Error).message);
    } finally {
      setBusy(false);
      setWaiting(false);
      setCode(null);
      setLink(null);
    }
  };

  const dev = async (email: string, name: string) => {
    setError("");
    setBusy(true);
    try {
      chatSignedIn(await chatDevLogin(email, name));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ChatSignInView
      server={CHAT_SERVER_NAME}
      config={config}
      error={error}
      note={note}
      code={code}
      link={link}
      waiting={waiting}
      busy={busy}
      onGoogle={() => void google()}
      onCancel={() => cancel.current?.()}
      onDev={(e, n) => void dev(e, n)}
      onRetry={ask}
      onSettings={() => goSettings("general")}
    />
  );
}

// ---------------------------------------------------------------- the strip's note

export function ChatServerNoteView({ server, who, onPress }: { server: string; who?: string; onPress?(): void }) {
  return (
    <button type="button" className="server-note" onClick={onPress} data-tip="The chat server ChatForm is on, on this device: open its setting" data-chat-server-note>
      Chat server · {server}
      {who ? ` · ${who}` : ""}
    </button>
  );
}

export function ChatServerNote() {
  const s = useChat();
  if (!CHAT_REMOTE) return null;
  return <ChatServerNoteView server={CHAT_SERVER_NAME} who={s.account?.name} onPress={() => goSettings("general")} />;
}
