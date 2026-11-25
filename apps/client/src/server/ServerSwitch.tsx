/**
 * The server switch (SPEC §3 "The server switch"; Josh, 2026-11-13: "an option button at the bottom
 * right to start the local server or connect to the flowform server for local testing. have it expand
 * to show both options"). Collapsed, a glass pill bottom right: a dot for whether the server this app
 * uses answers, and its address. Pressed, it opens upward into both ways to have a server:
 *  - **This computer**: Start runs Foundation's server here (the desktop app does it,
 *    src-tauri/src/local_server.rs), either the one built into the app (its data in the app's own
 *    folder; a teammate with no checkout has this) or a checkout's; once it answers, the app uses it
 *    and reloads. One a person started and didn't stop starts again when the app next opens.
 *  - **Remote server**: an address (Flowform's server to begin with); Connect points the app there and
 *    reloads, to sign in on that server.
 * Shown where the app can point elsewhere (the desktop app, or a page on another site's server),
 * over everything, the sign-in page included. `ServerSwitchView` is presentational for `#/design`.
 *
 * 2026-11-20 (Josh: "It's unclear to what server ChatForm is being connected to"): the panel first says which
 * server this is (ServerAbout.tsx: this computer, another on your network, or a hosted Foundation; its
 * address, version, what it serves, since when it's up, who's here, its data folder to an admin), then
 * **On your network** (the switch, the addresses, Invite someone, who's signed in from where), and folds
 * the two ways to change server under **Use another server** while the one in use answers.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { springs } from "@foundation/ui";
import { BEARER, SERVER, chooseServer } from "../lib/api";
import { inDesktop } from "../update/updater";
import { useUi } from "../state/ui";
import { RESTART_EVENT, answers, localStatus, startLocal, stopLocal } from "./desktop";
import {
  FOLDER_DEFAULT,
  LOCAL_PORT,
  LOCAL_SERVER,
  REMOTE_DEFAULT,
  initialKind,
  isAbsoluteFolder,
  isLocalServer,
  pillState,
  serverOrigin,
  shortAddress,
  startHelp,
  startsAtLaunch,
  type LocalKind,
  type LocalPhase,
  type Reach,
} from "./model";
import { ErrorCard } from "../components/ErrorCard";
import { NetworkSectionView, ServerAboutView, takeServerPanelWish, type NetworkSectionProps } from "./ServerAbout";
import { OPEN_SERVER_PANEL, buildPage, copyText, listSessions, makeInvite, setNetwork, signOutSession, useServerInfo, type Invite, type NetworkSession, type ServerInfo } from "./info";
import "./server.css";

const WINDOWS = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
const FOLDER_KEY = "foundation-server-folder";
const REMOTE_KEY = "foundation-server-remote";
/** which kind "This computer" offers (the person's last pick) */
const KIND_KEY = "foundation-server-kind";
/** the kind a person started here and hasn't stopped: started again when the app opens */
const LAST_KEY = "foundation-server-started";

export interface ServerSwitchViewProps {
  open: boolean;
  /** the server this app uses now (an origin) */
  current: string;
  reach: Reach;
  /** the desktop app: it can start a server here */
  desktop: boolean;
  local: LocalPhase;
  /** something answers on this computer's port */
  localListening: boolean;
  /** this app started that server */
  localOurs: boolean;
  /** an earlier run of this app started it (the switch's way): it can be stopped and restarted from here */
  localAdopted?: boolean;
  /** which kind Start runs: the app's own server or a checkout's */
  kind: LocalKind;
  /** this build carries its own server (not `tauri dev`) */
  builtIn: boolean;
  /** the kind and folder of the one this app started */
  runningKind?: LocalKind | null;
  runningFolder?: string | null;
  folder: string;
  /** why starting failed, in the server's or the app's own words */
  message?: string | null;
  /** this computer runs Windows (the way out of a reserved port is Windows's); #/design pins it */
  windows?: boolean;
  onDismissError?: () => void;
  remote: string;
  remoteError?: string | null;
  /** a still for #/design: no glass motion */
  still?: boolean;
  /** in the top bar: the panel drops down from the pill instead of rising from the corner */
  drop?: boolean;
  /** in the side menu (2026-11-18): the panel is drawn into this element, in the menu's own flow above the
   * Settings band, on the menu's paper instead of glass */
  host?: HTMLElement | null;
  /** #/design: the side menu's open panel alone, drawn where it stands (its pill is drawn in the band) */
  panelOnly?: boolean;
  onToggle?: () => void;
  onStart?: () => void;
  onStop?: () => void;
  onRestart?: () => void;
  onUseLocal?: () => void;
  onKind?: (k: LocalKind) => void;
  onFolder?: (v: string) => void;
  onRemote?: (v: string) => void;
  onConnect?: () => void;
  /** what the server says it is (GET /api/server); none: it isn't answering, or not asked yet */
  info?: ServerInfo | null;
  /** On your network, when the server says (signed in) */
  network?: Omit<NetworkSectionProps, "info"> | null;
  /** the two ways to change server are shown (else folded under "Use another server") */
  optionsOpen?: boolean;
  onOptions?: () => void;
  now?: number;
}

export function ServerSwitchView(p: ServerSwitchViewProps) {
  const currentIsLocal = isLocalServer(p.current);
  const pill = pillState(p.reach, p.local, currentIsLocal);
  const starting = p.local === "starting";
  const panel = (
    <section
      className={`server-switch-panel${p.host !== undefined ? " is-inline" : " f-glass"}`}
      role={p.host === undefined && !p.still ? "dialog" : "region"}
      aria-modal={p.host === undefined && !p.still ? "true" : undefined}
      aria-label="Server settings"
      id="server-switch-panel"
    >
      <header className="server-switch-head">
        <span className="f-eyebrow">Server</span>
        <span className="server-switch-now">
          <i className="server-switch-dot" data-tone={pill.tone} />
          <code>{shortAddress(p.current)}</code>
          <span>{pill.word}</span>
        </span>
      </header>

      {p.info && <ServerAboutView info={p.info} current={p.current} now={p.now} />}
      {p.info?.network && p.network && <NetworkSectionView info={p.info} {...p.network} now={p.now} />}
      {p.info && !p.optionsOpen && (
        <button type="button" className="server-switch-more" aria-expanded={false} onClick={p.onOptions}>
          Use another server <span aria-hidden>›</span>
        </button>
      )}

      {(!p.info || p.optionsOpen) && (
      <>
      <div className="server-switch-option" data-current={currentIsLocal || undefined}>
        <div className="server-switch-option-head">
          <strong>This computer</strong>
          {currentIsLocal && <span className="server-switch-tag">In use</span>}
        </div>
        {p.desktop && p.builtIn && !p.localListening && (
          <div className="server-switch-kinds" role="radiogroup" aria-label="Which server to start">
            {(
              [
                ["builtIn", "Built in"],
                ["checkout", "From a checkout"],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={p.kind === k}
                className="f-pill server-switch-kind"
                disabled={starting}
                onClick={() => p.onKind?.(k)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <p className="server-switch-lede">
          Foundation’s own server on <code>localhost:{LOCAL_PORT}</code>
          {p.localOurs && p.runningKind === "builtIn"
            ? ", built into this app. Its data is in "
            : p.localOurs && p.runningFolder
              ? ", from "
              : !p.desktop
                ? "."
                : p.kind === "builtIn"
                  ? ", built into this app: nothing else to install. Its data stays in this app’s folder."
                  : ", started from this checkout:"}
          {p.localOurs && p.runningFolder && <code>{p.runningFolder}</code>}
          {p.localOurs && p.runningKind === "builtIn" && "."}
        </p>
        {p.desktop && p.kind === "checkout" && !p.localOurs && (
          <input
            className="f-input server-switch-field server-switch-folder"
            value={p.folder}
            spellCheck={false}
            aria-label="Foundation checkout folder"
            disabled={starting || p.localOurs}
            onChange={(e) => p.onFolder?.(e.target.value)}
          />
        )}
        {p.local === "failed" && p.message && <ErrorCard message={p.message} {...(startHelp(p.message, p.windows ?? WINDOWS) ?? {})} onDismiss={p.onDismissError} />}
        <div className="server-switch-actions">
          {p.localListening ? (
            <>
              <span className="server-switch-state">
                <i className="server-switch-dot" data-tone="ok" />
                {p.localOurs ? "Running · started here" : p.localAdopted ? "Running · started here earlier" : "Running"}
              </span>
              {!currentIsLocal && (
                <button type="button" className="f-pill is-accent" onClick={p.onUseLocal}>
                  Use this server
                </button>
              )}
              {(p.localOurs || p.localAdopted) && (
                <>
                  <button type="button" className="f-pill" onClick={p.onRestart} data-tip="Stop it and start it again: it runs the code that's there now (after an update, say)">
                    Restart
                  </button>
                  <button type="button" className="f-pill" onClick={p.onStop}>
                    Stop
                  </button>
                </>
              )}
            </>
          ) : p.desktop ? (
            <button type="button" className="f-pill is-accent" onClick={p.onStart} disabled={starting} aria-busy={starting || undefined}>
              {starting ? "Starting…" : p.local === "failed" ? "Try again" : "Start the server"}
            </button>
          ) : (
            <span className="server-switch-hint">
              Not running. Start it with <code>npm run dev</code>.
            </span>
          )}
        </div>
      </div>

      <form
        className="server-switch-option"
        data-current={!currentIsLocal || undefined}
        onSubmit={(e) => {
          e.preventDefault();
          p.onConnect?.();
        }}
      >
        <div className="server-switch-option-head">
          <strong>Remote server</strong>
          {!currentIsLocal && <span className="server-switch-tag">In use</span>}
        </div>
        <div className="server-switch-row">
          <input
            className="f-input server-switch-field"
            value={p.remote}
            spellCheck={false}
            inputMode="url"
            aria-label="Remote server address"
            onChange={(e) => p.onRemote?.(e.target.value)}
          />
          <button type="submit" className="f-pill">
            Connect
          </button>
        </div>
        {p.remoteError ? <p className="server-switch-error" role="alert">{p.remoteError}</p> : <p className="server-switch-hint">Foundation reloads and signs in on that server.</p>}
      </form>
      </>
      )}
    </section>
  );

  // in the side menu: the panel grows in place above the Settings band, pushing the grids up
  const inline = p.host !== undefined;
  if (p.panelOnly) return <div className="server-switch-inline">{panel}</div>;
  const inlinePanel =
    inline &&
    (p.still ? (
      p.open && panel
    ) : (
      <AnimatePresence initial={false}>
        {p.open && (
          <motion.div
            key="panel"
            className="server-switch-inline"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0, transition: { duration: 0.16 } }}
            transition={{ type: "spring", ...springs.camera }}
          >
            {panel}
          </motion.div>
        )}
      </AnimatePresence>
    ));
  return (
    <div className="server-switch" data-open={p.open || undefined} data-still={p.still || undefined} data-drop={p.drop || undefined} data-inline={inline || undefined}>
      {inline ? (
        p.host ? createPortal(inlinePanel, p.host) : null
      ) : p.still ? (
        p.open && panel
      ) : (
        <AnimatePresence>
          {p.open && (
            <motion.div
              key="panel"
              className="server-switch-lift f-paper"
              initial={{ opacity: 0, y: p.drop ? -8 : 10, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.98, transition: { duration: 0.14 } }}
              transition={{ type: "spring", ...springs.pop }}
            >
              {panel}
            </motion.div>
          )}
        </AnimatePresence>
      )}
      <button
        type="button"
        className={`server-switch-pill${p.drop ? "" : " f-glass"}`}
        aria-expanded={p.open}
        aria-controls="server-switch-panel"
        data-tip={p.open ? undefined : "The server this app uses: start one here, or connect to another"}
        onClick={p.onToggle}
      >
        <i className="server-switch-dot" data-tone={pill.tone} />
        <span className="server-switch-addr">{shortAddress(p.current)}</span>
        <span className="server-switch-caret" aria-hidden>
          {p.open !== !!p.drop ? "▾" : "▴"}
        </span>
      </button>
    </div>
  );
}

const read = (k: string, d: string) => {
  try {
    return localStorage.getItem(k) ?? d;
  } catch {
    return d;
  }
};
const keep = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private window */
  }
};

/** the launch check runs once per page, though the switch is mounted again as the app moves past sign-in */
let launchChecked = false;

/**
 * The switch itself. Signed in, it is a small pill right of Settings in the side menu's foot (`where="pane"`, 2026-11-17;
 * from 2026-11-15 it was in the top bar, `where="bar"`: always there, so the server this app talks to is
 * never a mystery); before that there is no bar, and it keeps the bottom-right
 * corner wherever the app can point at another server. `day` pins day tokens over the sign-in page.
 */
export function ServerSwitch({ day = false, where = "corner", host }: { day?: boolean; where?: "corner" | "bar" | "pane"; host?: HTMLElement | null }) {
  const current = (SERVER || window.location.origin).replace(/\/$/, "");
  // signed in: in the side menu's foot, above Settings (2026-11-17), or in the top bar
  const bar = where !== "corner";
  const shown = bar || inDesktop || BEARER;
  const ui = useUi();
  const [open, setOpen] = useState(false);
  const [reach, setReach] = useState<Reach>("checking");
  const [local, setLocal] = useState<LocalPhase>("unknown");
  const [listening, setListening] = useState(false);
  const [ours, setOurs] = useState(false);
  const [adopted, setAdopted] = useState<LocalKind | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [folder, setFolder] = useState(() => read(FOLDER_KEY, FOLDER_DEFAULT));
  const [builtIn, setBuiltIn] = useState(false);
  const [kindPick, setKindPick] = useState<string | null>(() => read(KIND_KEY, "") || null);
  const kind = initialKind(kindPick, read(FOLDER_KEY, "") !== "", builtIn);
  const [running, setRunning] = useState<{ kind: LocalKind | null; folder: string | null }>({ kind: null, folder: null });
  const [remote, setRemote] = useState(() => read(REMOTE_KEY, isLocalServer(current) ? REMOTE_DEFAULT : current));
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const startingRef = useRef(false);
  /** the failure a person put away: the app still reports that exit, and it isn't shown again */
  const dismissedRef = useRef<string | null>(null);
  // what the server says it is, and On your network (ServerAbout.tsx)
  const { info, setInfo, refresh: refreshInfo } = useServerInfo(shown && open && reach !== "down", 5000);
  const [optionsOpen, setOptionsOpen] = useState(!bar);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [sessions, setSessions] = useState<NetworkSession[]>([]);
  const [netBusy, setNetBusy] = useState<string | null>(null);
  const [netError, setNetError] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: "", email: "" });
  const [copied, setCopied] = useState<string | null>(null);
  const managing = Boolean(info?.canManage && info.network?.on);
  useEffect(() => {
    if (!open || !managing) return;
    const load = () => void listSessions().then((r) => setSessions(r.sessions)).catch(() => null);
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [open, managing]);
  // asked from elsewhere (ChatForm's strip): open, now or as the switch mounts in the side menu's foot
  useEffect(() => {
    if (!shown) return;
    if (takeServerPanelWish()) setOpen(true);
    const go = () => {
      takeServerPanelWish();
      setOpen(true);
    };
    window.addEventListener(OPEN_SERVER_PANEL, go);
    return () => window.removeEventListener(OPEN_SERVER_PANEL, go);
  }, [shown]);
  const netDo = async (what: string, fn: () => Promise<unknown>) => {
    setNetBusy(what);
    setNetError(null);
    try {
      await fn();
    } catch (e) {
      setNetError(e instanceof Error ? e.message : String(e));
    } finally {
      setNetBusy(null);
    }
  };
  const network: Omit<NetworkSectionProps, "info"> = {
    invite,
    sessions,
    busy: netBusy,
    error: netError,
    draft,
    copied,
    onToggle: (on) => void netDo("switch", async () => setInfo(await setNetwork(on))),
    onDraft: setDraft,
    onInvite: () =>
      void netDo("invite", async () => {
        setInvite(await makeInvite(draft.email.trim(), draft.name.trim()));
        setDraft({ name: "", email: "" });
      }),
    onDoneInvite: () => setInvite(null),
    onSignOut: (id) =>
      void netDo(id, async () => {
        await signOutSession(id);
        setSessions((list) => list.filter((s) => s.id !== id));
      }),
    onBuild: () =>
      void netDo("build", async () => {
        await buildPage();
        await refreshInfo();
      }),
    onCopy: (text) =>
      void copyText(text).then((ok) => {
        if (!ok) return;
        setCopied(text);
        setTimeout(() => setCopied((c) => (c === text ? null : c)), 1600);
      }),
  };

  // the corner is shared: the call chip and the upload tray move up while the switch is there (server.css)
  useEffect(() => {
    if (!shown || bar || ui.presenting) return;
    document.documentElement.setAttribute("data-server-switch", "");
    return () => document.documentElement.removeAttribute("data-server-switch");
  }, [shown, bar, ui.presenting]);

  // does the server this app uses answer? now, then every 15 s (5 s while open)
  useEffect(() => {
    if (!shown) return;
    let alive = true;
    const check = () => void answers(current).then((ok) => alive && setReach(ok ? "up" : "down"));
    check();
    const t = setInterval(check, open ? 5000 : 15000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [shown, current, open]);

  // what's on this computer's port: the desktop app asks itself; a page elsewhere asks the port
  const refreshLocal = useCallback(async () => {
    if (inDesktop) {
      const s = await localStatus().catch(() => null);
      if (!s) return null;
      setListening(s.listening);
      setOurs(s.ours);
      setAdopted(s.adopted ?? null);
      setBuiltIn(s.builtIn);
      setRunning({ kind: s.kind, folder: s.folder });
      if (startingRef.current) return s;
      if (s.exited && s.exited !== dismissedRef.current) {
        setLocal("failed");
        setMessage(s.exited);
      } else setLocal(s.listening ? "running" : "stopped");
      return s;
    } else {
      const ok = await answers(LOCAL_SERVER, 1500);
      setListening(ok);
      setLocal(ok ? "running" : "stopped");
      return null;
    }
  }, []);
  useEffect(() => {
    if (!shown || !open) return;
    void refreshLocal();
    const t = setInterval(() => void refreshLocal(), 3000);
    return () => clearInterval(t);
  }, [shown, open, refreshLocal]);

  // Esc and a press outside put it away (Escape restores focus to the pill)
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      root.current?.querySelector<HTMLButtonElement>(".server-switch-pill")?.focus();
    };
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (root.current && !root.current.contains(t) && !host?.contains(t)) setOpen(false);
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("pointerdown", down, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("pointerdown", down, true);
    };
  }, [open, host]);

  const goLocal = () => (isLocalServer(current) ? window.location.reload() : chooseServer(LOCAL_SERVER));

  const start = async (k: LocalKind = kind) => {
    const f = folder.trim();
    if (k === "checkout" && !isAbsoluteFolder(f)) {
      setLocal("failed");
      setMessage("Give the checkout's full path, like C:\\Dev\\Foundation.");
      return;
    }
    if (k === "checkout") keep(FOLDER_KEY, f);
    setMessage(null);
    // a new try: the same failure, if it comes again, is shown again
    dismissedRef.current = null;
    setLocal("starting");
    startingRef.current = true;
    try {
      await startLocal(k, k === "checkout" ? f : undefined);
      // up when it answers; a server stops by itself when it can't start (its log says why)
      const until = Date.now() + 45_000;
      while (Date.now() < until) {
        if (await answers(LOCAL_SERVER, 1500)) {
          startingRef.current = false;
          setLocal("running");
          setListening(true);
          // started by a person: started again when the app next opens, until they press Stop
          keep(LAST_KEY, k);
          goLocal();
          return;
        }
        const s = await localStatus().catch(() => null);
        if (s?.exited) throw new Error(s.exited);
        await new Promise((r) => setTimeout(r, 700));
      }
      throw new Error("The server didn't answer within 45 seconds. Its log is local-server.log in Foundation's log folder.");
    } catch (e) {
      startingRef.current = false;
      setLocal("failed");
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  // as the app opens: what this build carries, and the server a person started here last time, again
  useEffect(() => {
    if (!shown || !inDesktop || launchChecked) return;
    launchChecked = true;
    void refreshLocal().then((s) => {
      const k = s ? startsAtLaunch(read(LAST_KEY, "") || null, isLocalServer(current), s.listening) : null;
      if (!k || (k === "builtIn" && !s?.builtIn)) return;
      setOpen(true);
      void start(k);
    });
    // once per page: start reads the latest state when it runs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);

  const stop = async () => {
    await stopLocal().catch(() => null);
    // a person stopped it: not again at the next launch
    try {
      localStorage.removeItem(LAST_KEY);
    } catch {
      /* private window */
    }
    setOurs(false);
    setListening(false);
    setLocal("stopped");
    if (isLocalServer(current)) setReach("down");
  };

  // stop, then start the same kind again: it runs what's in its folder now
  const restart = async () => {
    const k = running.kind ?? adopted ?? kind;
    setOpen(true);
    setLocal("starting");
    startingRef.current = true;
    await stopLocal().catch(() => null);
    setOurs(false);
    setAdopted(null);
    setListening(false);
    await start(k);
  };
  const restartRef = useRef(restart);
  restartRef.current = restart;
  // asked from elsewhere (a machine's card found the server older than the app)
  useEffect(() => {
    if (!shown || !inDesktop) return;
    const go = () => void restartRef.current();
    window.addEventListener(RESTART_EVENT, go);
    return () => window.removeEventListener(RESTART_EVENT, go);
  }, [shown]);

  const connect = () => {
    const r = serverOrigin(remote);
    if (!r.ok) {
      setRemoteError(r.reason);
      return;
    }
    keep(REMOTE_KEY, r.origin);
    chooseServer(r.origin);
  };

  if (!shown || ui.presenting) return null;
  // beside the search pane when it's open, not over its clipboard
  const right = 16 + (!day && ui.search ? ui.searchW : 0);
  return (
    <div ref={root} className={`server-switch-place${bar ? " is-bar" : ""}${where === "pane" ? " is-pane" : ""}${day ? " f-day" : ""}`} style={bar ? undefined : { right }} data-server-where={where}>
      <ServerSwitchView
        drop={where === "bar"}
        host={where === "pane" ? (host ?? null) : undefined}
        open={open}
        current={current}
        reach={reach}
        desktop={inDesktop}
        local={local}
        localListening={listening}
        localOurs={ours}
        localAdopted={Boolean(adopted)}
        kind={kind}
        builtIn={builtIn}
        runningKind={running.kind}
        runningFolder={running.folder}
        folder={folder}
        message={message}
        remote={remote}
        remoteError={remoteError}
        onToggle={() => setOpen((o) => !o)}
        onDismissError={() => {
          dismissedRef.current = message;
          setLocal("stopped");
          setMessage(null);
        }}
        onStart={() => void start()}
        onStop={() => void stop()}
        onRestart={() => void restart()}
        onUseLocal={goLocal}
        onKind={(k) => {
          setKindPick(k);
          keep(KIND_KEY, k);
          if (local === "failed") {
            setLocal("stopped");
            setMessage(null);
          }
        }}
        onFolder={setFolder}
        onRemote={(v) => {
          setRemote(v);
          setRemoteError(null);
        }}
        onConnect={connect}
        info={reach === "down" ? null : info}
        network={network}
        optionsOpen={optionsOpen || reach === "down"}
        onOptions={() => setOptionsOpen(true)}
      />
    </div>
  );
}
