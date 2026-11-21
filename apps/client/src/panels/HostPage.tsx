/**
 * A page card shown by the built-in browser (2026-11-19; PanelDoc.via === "browser").
 *
 * A frame can't show a site that refuses framing or sits behind a sign-in whose cookie doesn't travel into a frame:
 * everything on HyperForm (PartForm, DeployForm, FactoryForm, the dock itself). Such a card is a tab of the real
 * browser on the server's computer (apps/server/src/hostbrowser.ts), where a person signs in once and stays
 * signed in. It is drawn by distance, like every live thing on the grid:
 *
 *   far (or off screen)   the picture the server last kept of the page, with when it was seen;
 *   near                  the live page (the browser's pictures on a canvas), once this person has started it;
 *   in use (⌘/Ctrl-click) the pointer and the keys are the page's, with back, reload, the address and Agents.
 *
 * Nothing starts without a person: the browser starts on a press ("Go live" here, "Open in Foundation" on Today, or
 * the Browser tool's own Start), and that press holds for this visit (session storage), so the next card you come
 * near goes live by itself. Moving away pauses the pictures at once and closes this card's socket after a while;
 * the browser stops when nobody is looking at any page.
 *
 * It is an admin's (the browser holds a person's sign-ins). Everyone else sees the kept picture and ↗.
 */

import "../shell/browser-tool.css";
import { useEffect, useRef, useState } from "react";
import { useHostBrowser, hostOf } from "../shell/hostBrowser";
import { HOLDS_KEYS } from "../lib/keysHeld";
import { useFileSrc } from "../lib/fileSrc";
import { keys } from "../lib/keys";
import { modHeld, putInUse } from "../lib/cardUse";
import { openExternal } from "../utils/media";
import { updatePanel, type PanelMeta } from "../state/store";
import { useUi } from "../state/ui";
import { activeBoard } from "../sync/board";

const LIVE_KEY = "foundation-pages-live";
/** how long a card nobody is near keeps its socket (coming back within it is instant) */
const AWAY_MS = 45_000;
/** the board's copy of "seen at" is written at most this often (everyone on the board syncs it) */
const SEEN_WRITE_MS = 60_000;

/** has this person started the browser on this visit? */
export function pagesLive(): boolean {
  try {
    return sessionStorage.getItem(LIVE_KEY) === "1";
  } catch {
    return false;
  }
}
/** a person's press: pages near them may go live from now on (this visit) */
export function allowPagesLive(on = true) {
  try {
    if (on) sessionStorage.setItem(LIVE_KEY, "1");
    else sessionStorage.removeItem(LIVE_KEY);
  } catch {
    /* private window: one press per card */
  }
  window.dispatchEvent(new Event("foundation:pages-live"));
}

/** "seen 14:02", "seen yesterday", "seen 12 Nov" */
export function seenWords(at: number, now = Date.now()): string {
  const d = new Date(at);
  const days = Math.floor((new Date(now).setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days <= 0) return `seen ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
  if (days === 1) return "seen yesterday";
  return `seen ${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
}

export function HostPage({ panel, near }: { panel: PanelMeta; near: boolean }) {
  const ui = useUi();
  const admin = ui.role === "admin";
  const engaged = ui.engaged === panel.id;
  const board = activeBoard()?.boardId ?? "company";
  const url = panel.url ?? "";

  const [allowed, setAllowed] = useState(pagesLive);
  useEffect(() => {
    const on = () => setAllowed(pagesLive());
    window.addEventListener("foundation:pages-live", on);
    return () => window.removeEventListener("foundation:pages-live", on);
  }, []);

  // the picture: the board's "seen at", or what the server told this socket just now
  const [seen, setSeen] = useState(0);
  const seenAt = Math.max(seen, panel.seenAt ?? 0);
  const wrote = useRef(panel.seenAt ?? 0);
  const b = useHostBrowser({
    page: { board, card: panel.id, url },
    layout: true,
    onSeen: (at) => {
      setSeen(at);
      if (at - wrote.current < SEEN_WRITE_MS) return;
      wrote.current = at;
      updatePanel(panel.id, { seenAt: at });
    },
  });
  const { state, tab, painted, dialog, did, agents, held } = b;

  // near, and a person has started the browser on this visit: go live. Away for a while: let the socket go.
  const want = admin && near && allowed && Boolean(url);
  useEffect(() => {
    if (want && state === "idle") void b.start();
  }, [want, state]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (near || state === "idle") return;
    const t = setTimeout(() => b.stop(), AWAY_MS);
    return () => clearTimeout(t);
  }, [near, state]); // eslint-disable-line react-hooks/exhaustive-deps
  // in use: the keys go to the page
  useEffect(() => {
    if (engaged && state === "open") b.page.current?.focus({ preventScroll: true });
  }, [engaged, state]); // eslint-disable-line react-hooks/exhaustive-deps

  const live = near && state === "open";
  const showPage = live && painted;
  const picture = useFileSrc(seenAt ? `/api/boards/${encodeURIComponent(board)}/pages/${encodeURIComponent(panel.id)}/picture?at=${seenAt}` : null, true);
  const domain = hostOf(tab?.url || url);
  const goLive = () => {
    allowPagesLive();
    if (state === "closed") b.again();
  };

  return (
    <div className={`host-page${engaged ? " is-engaged" : ""}`} data-host-page={panel.id} data-host-page-state={live ? (painted ? "live" : "opening") : seenAt ? "picture" : "poster"}>
      {/* in use: where it is, and the browser's own presses */}
      {live && engaged && (
        <form
          className="tool-addr host-page-bar"
          onSubmit={(e) => {
            e.preventDefault();
            b.go(b.text);
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button type="button" className="top-btn" disabled={!tab?.canBack} onClick={() => b.send({ t: "back" })} aria-label="Back" data-tip="Back">
            ←
          </button>
          <button type="button" className="top-btn" disabled={!tab?.canForward} onClick={() => b.send({ t: "forward" })} aria-label="Forward" data-tip="Forward">
            →
          </button>
          <button type="button" className="top-btn" onClick={() => b.send({ t: tab?.loading ? "stop" : "reload" })} aria-label={tab?.loading ? "Stop" : "Reload"} data-tip={tab?.loading ? "Stop loading" : "Reload"}>
            {tab?.loading ? "✕" : "↻"}
          </button>
          <input
            ref={b.addr}
            className="tool-addr-field"
            value={b.text}
            onChange={(e) => {
              b.editing.current = true;
              b.setText(e.target.value);
            }}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={() => {
              b.editing.current = false;
              b.setText(b.url);
            }}
            aria-label="Address"
            spellCheck={false}
            autoComplete="off"
            data-host-page-addr
          />
          <button type="button" className="top-btn" onClick={() => b.go(url)} aria-label="Home" data-tip={`Back to ${panel.name}`}>
            ⌂
          </button>
          <button type="button" className="top-btn" onClick={() => void openExternal(b.url || url)} aria-label="Open outside" data-tip="Open in your browser">
            ↗
          </button>
          <button
            type="button"
            className={`f-pill btool-agents${agents ? " is-agent" : ""}`}
            aria-pressed={agents}
            onClick={() => b.send({ t: "agents", allow: !agents })}
            data-tip={agents ? "Your agents can read and use this page (and the browser's other pages) while it's open. Press to stop them." : "Let your agents read and use this page: they can press and type here, while it's open"}
            data-host-page-agents
          >
            <i className={`f-dot${agents ? " is-agent" : ""}`} aria-hidden />
            Agents
          </button>
        </form>
      )}

      <div className="host-page-view">
        {/* the live page: kept mounted while the socket is, hidden when far (a hidden box tells the server to pause) */}
        {state === "open" && (
          <div
            ref={b.page}
            className={`btool-page host-page-live${held ? " has-keys" : ""}`}
            style={near ? undefined : { display: "none" }}
            tabIndex={engaged ? 0 : -1}
            role="application"
            aria-label={tab?.title ? `The page: ${tab.title}` : panel.name}
            {...{ [HOLDS_KEYS]: "" }}
            onPointerDown={(e) => {
              e.stopPropagation();
              b.onPointerDown(e);
            }}
            onPointerMove={b.onPointerMove}
            onPointerUp={b.onPointerUp}
            onContextMenu={(e) => e.preventDefault()}
            onKeyDown={b.onKeyDown}
            onKeyUp={b.onKeyUp}
            onPaste={(e) => {
              e.preventDefault();
              const t = e.clipboardData.getData("text/plain");
              if (t && !dialog) b.send({ t: "paste", text: t });
            }}
            onFocus={(e) => e.target === e.currentTarget && b.setHeld(true)}
            onBlur={(e) => e.target === e.currentTarget && b.setHeld(false)}
          >
            <canvas ref={b.canvas} className="btool-canvas" data-host-page-canvas data-browser-painted={painted || undefined} />
            {did && (
              <div className="btool-did" role="status" key={did.n}>
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
                    b.settle(true);
                  }}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Escape") b.settle(false);
                  }}
                  onKeyUp={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                  onPaste={(e) => e.stopPropagation()}
                >
                  <span className="btool-sheet-from">{domain || "The page"} says</span>
                  <p>{dialog.message || (dialog.kind === "prompt" ? "It asks for an answer." : "(nothing)")}</p>
                  {dialog.kind === "prompt" && <input className="tool-addr-field" value={b.answer} onChange={(e) => b.setAnswer(e.target.value)} autoFocus aria-label="Your answer" />}
                  <span className="btool-sheet-presses">
                    {dialog.kind !== "alert" && (
                      <button type="button" className="f-pill" onClick={() => b.settle(false)}>
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
          </div>
        )}

        {/* far, or not live yet: the picture kept of it, or its name while there is none */}
        {!showPage && (
          <div className={`host-page-still${picture ? " has-picture" : ""}`}>
            {picture ? (
              <img className="host-page-picture" src={picture} alt={`${panel.name}, as last seen`} draggable={false} data-host-page-picture />
            ) : (
              <div className="frame-poster">
                <div className="frame-poster-name">{panel.name}</div>
                <div className="frame-poster-domain">{domain || "no address yet"}</div>
                {panel.text && <div className="frame-poster-text">{panel.text}</div>}
              </div>
            )}
            <div className="host-page-foot">
              <span className="host-page-seen">
                <b>{panel.name}</b>
                {seenAt ? ` · ${seenWords(seenAt)}` : domain ? ` · ${domain}` : ""}
              </span>
              {near && live && !painted && <span className="host-page-note">Opening the page…</span>}
              {near && state === "opening" && <span className="host-page-note">Starting the browser…</span>}
              {near && admin && (state === "closed" || (!allowed && state === "idle")) && (
                <button
                  type="button"
                  className="f-pill is-accent"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={goLive}
                  data-tip="Run the live page in the browser on the server's computer. Pages you come near go live by themselves for the rest of this visit."
                  data-host-page-live
                >
                  {state === "closed" ? "Go live again" : "Go live"}
                </button>
              )}
              {near && state === "closed" && b.why && <span className="host-page-note is-bad">{b.why}</span>}
              {near && state === "idle" && b.why && <span className="host-page-note is-bad">{b.why}</span>}
              {near && !admin && (
                <button type="button" className="f-pill" onPointerDown={(e) => e.stopPropagation()} onClick={() => void openExternal(url)} data-tip="The live page runs in a browser on the server's computer, which an admin opens. This opens it in yours.">
                  Open in your browser ↗
                </button>
              )}
            </div>
          </div>
        )}

        {/* a plain click selects the card; ⌘/Ctrl-click uses the page (lib/cardUse.ts) */}
        {showPage && !engaged && (
          <div
            className="frame-engage"
            onClick={(e) => {
              if (!modHeld(e)) return;
              e.preventDefault();
              e.stopPropagation();
              putInUse(panel.id);
            }}
          >
            <span className="f-pill frame-engage-pill">
              {keys("mod+click")} to use · {keys("mod+enter")} full screen
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
