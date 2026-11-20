/**
 * The Browser tool (2026-11-18): a real browser on the server's computer, shown here.
 *
 * A framed page fails on every site that refuses framing, so for an admin this is the site's own page in Edge or
 * Chrome on the computer Foundation's server runs on (apps/server/src/hostbrowser.ts): the server sends the page
 * as pictures and this pane sends the pointer and the keys back. Nothing runs until Start is pressed (the server
 * mints a one-time key for the socket, as the terminal's does), and it ends when the pane closes. Agents can read
 * and use it only while it is open here and "Agents" is switched on; what they do is shown under the page.
 *
 * Everyone else gets the framed page this tool was before: fine for sites that allow it, with ↗ for the rest.
 *
 * The page holds the keys while the caret is in it (`data-holds-keys`, as a machine's shell does): the app's own
 * shortcuts stand down, and Esc twice or a click anywhere else gives them back.
 */

import "./browser-tool.css";
import { useState } from "react";
import { HOLDS_KEYS } from "../lib/keysHeld";
import { hostOf, useHostBrowser } from "./hostBrowser";
import { toast, useUi } from "../state/ui";
import { openExternal } from "../utils/media";
import { openUrlAsPanel } from "./CommandBar";
import { frameAllow, frameFor } from "../panels/frameSandbox";
import { useFrameContext } from "../lib/frames";

export function BrowserTool() {
  return useUi().role === "admin" ? <HostBrowser /> : <FramedBrowser />;
}

// ---------------------------------------------------------------- the real browser (an admin's)

function HostBrowser() {
  const b = useHostBrowser();
  const { state, name, why, tabs, at, tab, url, text, setText, held, setHeld, painted, dialog, answer, setAnswer, agents, did, page, canvas, addr, editing, send, start, again, go, settle, onPointerDown, onPointerMove, onPointerUp, onKeyDown, onKeyUp } = b;

  if (state === "idle" || state === "opening")
    return (
      <div className="tool-browser btool">
        <div className="tool-empty">
          <b>A browser on the server's computer</b>
          <p>A real browser (Edge or Chrome), run on the computer Foundation's server is on and shown here, so any site works, and what you sign in to stays signed in. Nothing runs until you start it, and it ends when you close this pane.</p>
          {why && <p className="tool-note is-bad">{why}</p>}
          <button className="f-pill is-accent" onClick={() => void start()} disabled={state === "opening"} data-browser-start>
            {state === "opening" ? "Starting…" : "Start the browser"}
          </button>
        </div>
      </div>
    );

  return (
    <div className="tool-browser btool" data-browser-state={state}>
      <div className="btool-tabs" role="tablist" aria-label="Tabs" data-browser-tabs>
        <span className={`f-dot ${state === "open" ? "is-ok" : "is-warn"}`} data-tip={state === "open" ? `${name}, on the server's computer` : "The browser has closed"} />
        {tabs.map((t) => (
          <div key={t.id} role="tab" tabIndex={0} aria-selected={t.id === at} className={`btool-tab${t.id === at ? " is-on" : ""}${t.agent ? " is-agent" : ""}`} onClick={() => send({ t: "tab.select", tab: t.id })} onKeyDown={(e) => e.key === "Enter" && send({ t: "tab.select", tab: t.id })} data-browser-tab={t.id} data-tip={t.agent ? "An agent is working in this tab" : undefined}>
            {t.loading && <i className="f-dot is-live" aria-hidden />}
            <span className="btool-tab-name">{t.title || hostOf(t.url) || "New tab"}</span>
            <button
              type="button"
              className="btool-tab-x"
              aria-label={`Close ${t.title || hostOf(t.url) || "this tab"}`}
              onClick={(e) => {
                e.stopPropagation();
                send({ t: "tab.close", tab: t.id });
              }}
            >
              ✕
            </button>
          </div>
        ))}
        {state === "open" && (
          <button
            type="button"
            className="top-btn btool-tab-new"
            aria-label="New tab"
            data-tip="New tab"
            onClick={() => {
              send({ t: "tab.new" });
              addr.current?.focus();
            }}
            data-browser-newtab
          >
            ＋
          </button>
        )}
        {state === "closed" && (
          <button className="f-pill btool-again" onClick={again} data-browser-again>
            Start again
          </button>
        )}
      </div>
      <form
        className="tool-addr"
        onSubmit={(e) => {
          e.preventDefault();
          go(text);
        }}
      >
        <button type="button" className="top-btn" disabled={state !== "open" || !tab?.canBack} onClick={() => send({ t: "back" })} aria-label="Back" data-tip="Back">
          ←
        </button>
        <button type="button" className="top-btn" disabled={state !== "open" || !tab?.canForward} onClick={() => send({ t: "forward" })} aria-label="Forward" data-tip="Forward">
          →
        </button>
        <button type="button" className="top-btn" disabled={state !== "open" || !tab} onClick={() => send({ t: tab?.loading ? "stop" : "reload" })} aria-label={tab?.loading ? "Stop" : "Reload"} data-tip={tab?.loading ? "Stop loading" : "Reload"} data-browser-reload>
          {tab?.loading ? "✕" : "↻"}
        </button>
        <input
          ref={addr}
          className="tool-addr-field"
          value={text}
          disabled={state !== "open"}
          onChange={(e) => {
            editing.current = true;
            setText(e.target.value);
          }}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={() => {
            editing.current = false;
            setText(url);
          }}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            editing.current = false;
            setText(url);
            page.current?.focus({ preventScroll: true });
          }}
          placeholder="An address, or words to search"
          aria-label="Address"
          spellCheck={false}
          autoComplete="off"
          data-browser-addr
        />
        <button type="button" className="top-btn" disabled={!url} onClick={() => void openExternal(url)} aria-label="Open outside" data-tip="Open in your browser">
          ↗
        </button>
        <button type="button" className="f-pill" disabled={!url} onClick={() => void openUrlAsPanel(url, "app").then(() => toast("On the grid, in the section in use", "ok"))} data-tip="A live card on the grid, in the section in use">
          On the grid
        </button>
        <button
          type="button"
          className={`f-pill btool-agents${agents ? " is-agent" : ""}`}
          disabled={state !== "open"}
          aria-pressed={agents}
          onClick={() => send({ t: "agents", allow: !agents })}
          data-tip={agents ? "Agents can read and use this browser while it's open. Press to stop them." : "Let agents use this browser: they can read pages and press and type here, while it's open"}
          data-browser-agents
        >
          <i className={`f-dot${agents ? " is-agent" : ""}`} aria-hidden />
          Agents
        </button>
      </form>
      <div className={`btool-load${state === "open" && tab?.loading ? " is-on" : ""}`} aria-hidden />
      <div
        ref={page}
        className={`btool-page${held ? " has-keys" : ""}`}
        tabIndex={state === "open" ? 0 : -1}
        role="application"
        aria-label={tab?.title ? `The page: ${tab.title}` : "The page"}
        {...{ [HOLDS_KEYS]: "" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onPaste={(e) => {
          e.preventDefault();
          const t = e.clipboardData.getData("text/plain");
          if (t && !dialog) send({ t: "paste", text: t });
        }}
        onFocus={(e) => e.target === e.currentTarget && setHeld(true)}
        onBlur={(e) => e.target === e.currentTarget && setHeld(false)}
        data-browser-page
      >
        <canvas ref={canvas} className="btool-canvas" data-browser-canvas data-browser-painted={painted || undefined} />
        {state === "open" && !painted && <p className="tool-note btool-wait">Opening the page…</p>}
        {held && <span className="btool-held">Keys go to this page · Esc Esc to leave</span>}
        {did && (
          <div className="btool-did" role="status" key={did.n} data-browser-agent-did>
            <i className="btool-did-mark" aria-hidden>
              ✦
            </i>
            <span>
              <b>{did.who}</b> {did.did}
            </span>
          </div>
        )}
        {dialog && (
          <div className="btool-veil">
            <form
              className="btool-sheet"
              role="alertdialog"
              aria-label="The page says"
              onSubmit={(e) => {
                e.preventDefault();
                settle(true);
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Escape") settle(false);
              }}
              onKeyUp={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onPaste={(e) => e.stopPropagation()}
              data-browser-dialog
            >
              <span className="btool-sheet-from">{hostOf(tab?.url ?? "") || "The page"} says</span>
              <p>{dialog.message || (dialog.kind === "prompt" ? "It asks for an answer." : "(nothing)")}</p>
              {dialog.kind === "prompt" && <input className="tool-addr-field" value={answer} onChange={(e) => setAnswer(e.target.value)} autoFocus aria-label="Your answer" />}
              <span className="btool-sheet-presses">
                {dialog.kind !== "alert" && (
                  <button type="button" className="f-pill" onClick={() => settle(false)}>
                    Cancel
                  </button>
                )}
                <button type="submit" className="f-pill is-accent" autoFocus={dialog.kind !== "prompt"}>
                  OK
                </button>
              </span>
            </form>
          </div>
        )}
        {state === "closed" && (
          <div className="btool-veil">
            <div className="btool-sheet" data-browser-closed>
              <p>{why || "The browser has closed."}</p>
              <span className="btool-sheet-presses">
                <button className="f-pill is-accent" onClick={again}>
                  Start again
                </button>
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the framed page (everyone else's)

const normal = (raw: string) => {
  const t = raw.trim();
  if (!t) return "";
  if (/^https?:\/\//i.test(t)) return t;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return "";
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(t)) return `http://${t}`;
  if (/^[^\s/]+\.[^\s/]{2,}(\/|$)/.test(t)) return `https://${t}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(t)}`;
};

function FramedBrowser() {
  const [stack, setStack] = useState<{ list: string[]; at: number }>({ list: [], at: -1 });
  const [text, setText] = useState("");
  const [nonce, setNonce] = useState(0);
  const url = stack.list[stack.at] ?? "";
  const frameCtx = useFrameContext();
  const decision = url ? frameFor(url, frameCtx) : null;
  const go = (raw: string) => {
    const u = normal(raw);
    if (!u) return;
    setText(u);
    setStack((s) => ({ list: [...s.list.slice(0, s.at + 1), u], at: s.at + 1 }));
  };
  const step = (d: -1 | 1) =>
    setStack((s) => {
      const at = Math.max(0, Math.min(s.list.length - 1, s.at + d));
      setText(s.list[at] ?? "");
      return { ...s, at };
    });
  return (
    <div className="tool-browser">
      <form
        className="tool-addr"
        onSubmit={(e) => {
          e.preventDefault();
          go(text);
        }}
      >
        <button type="button" className="top-btn" disabled={stack.at <= 0} onClick={() => step(-1)} aria-label="Back" data-tip="Back">
          ←
        </button>
        <button type="button" className="top-btn" disabled={stack.at >= stack.list.length - 1} onClick={() => step(1)} aria-label="Forward" data-tip="Forward">
          →
        </button>
        <button type="button" className="top-btn" disabled={!url} onClick={() => setNonce((n) => n + 1)} aria-label="Reload" data-tip="Reload">
          ↻
        </button>
        <input className="tool-addr-field" value={text} onChange={(e) => setText(e.target.value)} placeholder="An address, or words to search" aria-label="Address" data-browser-addr />
        <button type="button" className="top-btn" disabled={!url} onClick={() => void openExternal(url)} aria-label="Open outside" data-tip="Open in your browser">
          ↗
        </button>
        <button type="button" className="f-pill" disabled={!url} onClick={() => void openUrlAsPanel(url, "app").then(() => toast("On the grid, in the section in use", "ok"))} data-tip="A live card on the grid, in the section in use">
          On the grid
        </button>
      </form>
      {url && !decision?.ok ? (
        <div className="tool-empty" data-frame-refused>
          <b>Not shown here</b>
          <p>{decision?.reason}</p>
        </div>
      ) : url && decision?.ok ? (
        // a typed address follows the frame rules (frameSandbox.ts): sandboxed, its own origin only for a saved app
        frameCtx.ready && <iframe key={`${url}#${nonce}`} className="tool-frame" src={decision.url} title={url} referrerPolicy="no-referrer" allow={frameAllow(decision)} sandbox={decision.sandbox} data-browser-frame />
      ) : (
        <div className="tool-empty">
          <b>A page, beside the grid</b>
          <p>Type an address or a search. Some sites won't show inside another app (they say so with a blank page); ↗ opens those in your browser. "On the grid" makes the page a live card everyone on the grid sees.</p>
          <p className="tool-note">An admin gets the full browser here: a real one on the server's computer, where every site works.</p>
          <span className="tool-chips">
            {["localhost:1430/#/design", "github.com/joshleong/Foundation", "docs.anthropic.com"].map((u) => (
              <button key={u} className="f-pill" onClick={() => go(u)}>
                {u}
              </button>
            ))}
          </span>
        </div>
      )}
    </div>
  );
}
