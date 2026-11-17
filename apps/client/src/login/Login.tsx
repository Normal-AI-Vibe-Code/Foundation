/**
 * Sign-in: ordinary type and physical controls (light pills that lift and
 * press on springs, raised inputs) standing in the ASCII wind. There's no card
 * and no frame: the wind knows each element (`asciiWind.shapes`), parts
 * around it and traces its outline in faintly lit glyphs, text by its words
 * and controls by their rounded boxes; the one under the pointer or holding
 * focus lights up. Just Google; the email sign-in waits behind a click.
 * Always day colours (`.f-day`), whatever the room.
 *
 * The field answers. The outlines come up out of the wind on arrival, typing stirs
 * the wind at the cursor, a press ripples from the button, and an error
 * ripples where it's written. Signing in dissolves everything outward
 * from the press, a ragged front of bright glyphs, into the board
 * underneath. App keeps this page over the shell until `onGone`.
 *
 * Google is flowform-server's sign-in, the flowform client's own, with the
 * same server and Google client. In the browser the page goes to flowform and
 * comes back with ?arrive, and this page dissolves on arrival. In the desktop
 * app Google refuses the embedded webview, so the system browser signs in and
 * this window polls, then dissolves when you come back to it. Dev sign-in
 * (name + allowlisted email) is for this machine.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import type { UserInfo } from "@foundation/protocol";
import { openUrl } from "@tauri-apps/plugin-opener";
import { initAsciiWind2 } from "./asciiWind2";
import { activeBoard } from "../sync/board";
import { authConfig, BEARER, chooseServer, devLogin, flowformBegin, flowformPoll, SERVER, serverUrl } from "../lib/api";

const inDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** where the form sits: its width, and the paper around it, in wind cells */
const FRAME_COLS = 66;
const PAD_COLS = 6;
const PAD_ROWS = 3;
const OPEN_MS = 700;
const LEAVE_MS = 1300;
/** how ragged the dissolve front is, css px */
const BAND = 150;
const press = { type: "spring", stiffness: 520, damping: 32 } as const;

type Grid = { width: number; height: number; left: number; top: number; cw: number; ch: number };
type Rect = { x: number; y: number; width: number; height: number };

/** the grid the wind lays out (asciiWind2 resize), so the form's box falls between wind cells */
function measureGrid(el: HTMLElement): Grid {
  const { width, height } = el.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const cellDev = Math.max(5, Math.round(6.5 * dpr));
  const devW = Math.round(width * dpr);
  const devH = Math.round(height * dpr);
  const cols = Math.ceil(devW / cellDev);
  const rows = Math.ceil(devH / (cellDev * 2));
  return {
    width,
    height,
    left: Math.round((devW - cols * cellDev) / 2) / dpr,
    top: Math.round((devH - rows * cellDev * 2) / 2) / dpr,
    cw: cellDev / dpr,
    ch: (cellDev * 2) / dpr,
  };
}

const ease = (k: number) => 1 - Math.pow(1 - k, 3);

/** resolves once `ok()` holds, checked each frame (or after `cap` ms) */
function until(ok: () => boolean, cap: number): Promise<void> {
  return new Promise((done) => {
    const start = performance.now();
    const step = (t: number) => (ok() || t - start > cap ? done() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
}

/** resolves once the page draws `run` frames in a row on time (or after `cap` ms, whatever happens) */
function calm(run = 6, cap = 1500): Promise<void> {
  return new Promise((done) => {
    const start = performance.now();
    let last = start;
    let good = 0;
    const step = (t: number) => {
      good = t - last < 20 ? good + 1 : 0;
      last = t;
      if (good >= run || t - start > cap) done();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

export function Login({
  onSignedIn,
  onGone,
  arriving = false,
}: {
  onSignedIn(u: UserInfo): void;
  /** the dissolve has finished; the page can go */
  onGone?(): void;
  /** already signed in (back from flowform): show the page and dissolve at once */
  arriving?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const form = useRef<HTMLDivElement>(null);
  const [g, setGrid] = useState<Grid | null>(null);
  const [contentH, setContentH] = useState(0);
  const [cfg, setCfg] = useState<{ google: boolean; devLogin: boolean; flowform?: { url: string } } | null>(null);
  const [email, setEmail] = useState(() => localStorage.getItem("foundation-last-email") ?? "");
  const [name, setName] = useState(() => localStorage.getItem("foundation-last-name") ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** desktop: waiting on the system browser */
  const [waiting, setWaiting] = useState(false);
  /** the email sign-in, folded away until asked for */
  const [byEmail, setByEmail] = useState(false);
  /** the app (or a page on another site) can be pointed at another server: the Server line, folded until asked for */
  const [pickServer, setPickServer] = useState(false);
  const [serverDraft, setServerDraft] = useState(SERVER);
  /** 0 → 1 as the outlines come up out of the wind */
  const [open, setOpen] = useState(0);
  const [leave, setLeave] = useState<{ ox: number; oy: number; radius: number } | null>(null);
  const cancelWait = useRef<() => void>(() => {});
  const lastPress = useRef<{ x: number; y: number } | null>(null);
  const leaving = useRef(false);
  const reduced = useMemo(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches, []);

  // the wind runs through the form, a little calmer behind it
  useEffect(() => initAsciiWind2(root.current!, "wind", { quiet: 0.7 }), []);
  useLayoutEffect(() => {
    const el = root.current!;
    const measure = () => setGrid(measureGrid(el));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    const el = form.current;
    if (!el) return;
    const measure = () => setContentH(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [g]);
  useEffect(() => {
    authConfig()
      .then(setCfg)
      .catch(() => setError("Can't reach the Foundation server. Start it with `npm run dev`."));
  }, []);
  useEffect(() => () => cancelWait.current(), []);

  const hooks = () => root.current?.asciiWind;

  /** the form's box, on wind cell boundaries (layout only: nothing draws it) */
  const frame = useMemo<Rect | null>(() => {
    if (!g || !contentH) return null;
    const cols = Math.min(FRAME_COLS, Math.floor((g.width - g.left) / g.cw) - 4);
    const rows = Math.ceil(contentH / g.ch) + PAD_ROWS * 2;
    const col = Math.round((g.width / 2 - g.left) / g.cw - cols / 2);
    const row = Math.max(2, Math.round((g.height * 0.47 - g.top) / g.ch - rows / 2));
    return { x: g.left + col * g.cw, y: g.top + row * g.ch, width: cols * g.cw, height: rows * g.ch };
  }, [g, contentH]);

  // on arrival the elements' outlines come up out of the wind, top to bottom
  useEffect(() => {
    if (!frame || open === 1) return;
    if (reduced || arriving) return setOpen(1);
    let raf = 0;
    const start = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - start) / OPEN_MS);
      setOpen(k);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame !== null]);

  // the wind knows each element: it parts around it and traces its outline
  // (a run of text by its words, a control by its rounded box), and the one
  // under the pointer or holding focus lights up
  useEffect(() => {
    const el = root.current;
    if (!el || !frame) return;
    const range = document.createRange();
    const send = () => {
      const r = el.getBoundingClientRect();
      const shapes = [...el.querySelectorAll<HTMLElement>("[data-shape]")].flatMap((node, i) => {
        const text = node.dataset.shape === "text";
        if (text) range.selectNodeContents(node);
        const b = text ? range.getBoundingClientRect() : node.getBoundingClientRect();
        if (!b.width || !b.height) return [];
        const k = ease(Math.min(1, Math.max(0, open * 1.6 - i * 0.07)));
        const lit = node.matches(":hover, :focus");
        return [
          {
            x: b.left - r.left,
            y: b.top - r.top,
            width: b.width,
            height: b.height,
            radius: text ? 3 : parseFloat(getComputedStyle(node).borderTopLeftRadius) || 0,
            gap: text ? 1 : 3,
            depth: (text ? 5 : 7) * k,
            light: k * (lit ? 0.6 : text ? 0.16 : 0.32),
          },
        ];
      });
      el.asciiWind?.shapes(shapes);
    };
    // follow the form's springs for a moment after anything changes
    let raf = 0;
    const until = performance.now() + 800;
    const follow = () => {
      send();
      if (performance.now() < until) raf = requestAnimationFrame(follow);
    };
    follow();
    const events = ["ascii-wind:ready", "pointerover", "pointerout", "focusin", "focusout"];
    // :hover and :focus settle after the event, so read them on the next frame
    let soon = 0;
    const later = () => {
      cancelAnimationFrame(soon);
      soon = requestAnimationFrame(send);
    };
    events.forEach((type) => el.addEventListener(type, later));
    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(soon);
      events.forEach((type) => el.removeEventListener(type, later));
    };
  }, [frame, open, byEmail, error, waiting, cfg]);

  /** centre of an element, in the root's box */
  const centreOf = (el: Element | null) => {
    const r = root.current?.getBoundingClientRect();
    const b = el?.getBoundingClientRect();
    return r && b ? { x: b.left - r.left + b.width / 2, y: b.top - r.top + b.height / 2 } : null;
  };
  const ripple = (el: Element | null, force = 1) => {
    const p = centreOf(el);
    if (!p) return;
    lastPress.current = p;
    hooks()?.tap(p.x, p.y, force);
  };

  // ---------- signing in: dissolve outward into the board ----------
  const dissolve = useCallback(
    async (origin?: { x: number; y: number }) => {
      if (leaving.current || !g) return;
      leaving.current = true;
      // back from the system browser: dissolve when the person is looking
      if (!document.hasFocus()) {
        await new Promise<void>((ok) => {
          const t = window.setTimeout(ok, 30_000);
          window.addEventListener("focus", () => (window.clearTimeout(t), ok()), { once: true });
        });
        await new Promise((ok) => setTimeout(ok, 350));
      }
      // the board mounts and syncs behind the page now; let that land first (the wind keeps turning), so
      // the dissolve isn't dropping frames to it: 100–200 ms of work on a 200-card board, measured in
      // e2e/frames.spec.ts. Offline, or a slow server: it goes after 2.5 s regardless.
      await until(() => activeBoard()?.status === "live", 2500);
      await calm();
      const o = origin ?? lastPress.current ?? (frame ? { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 } : { x: g.width / 2, y: g.height / 2 });
      const far =
        Math.max(...[[0, 0], [g.width, 0], [0, g.height], [g.width, g.height]].map(([x, y]) => Math.hypot(x - o.x, y - o.y))) + BAND;
      const duration = reduced ? 350 : LEAVE_MS;
      const start = performance.now();
      await new Promise<void>((done) => {
        const step = () => {
          const k = Math.min(1, (performance.now() - start) / duration);
          // slow out of the press, then it runs
          const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2.2) / 2;
          const radius = e * far;
          root.current?.asciiWind?.dissolve(o.x, o.y, Math.max(1, radius), BAND);
          setLeave({ ox: o.x, oy: o.y, radius });
          if (k < 1) requestAnimationFrame(step);
          else done();
        };
        requestAnimationFrame(step);
      });
      onGone?.();
    },
    [g, frame, reduced, onGone],
  );

  const signedIn = (u: UserInfo) => {
    onSignedIn(u);
    void dissolve();
  };

  // back from flowform in the browser: already in, so go straight through
  useEffect(() => {
    if (!arriving || !frame) return;
    const t = setTimeout(() => void dissolve({ x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 }), 450);
    return () => clearTimeout(t);
  }, [arriving, frame, dissolve]);

  const fail = (message: string) => {
    setError(message);
    // the error ripples where it's written (after it renders)
    requestAnimationFrame(() => ripple(root.current?.querySelector(".login-error") ?? null, 0.45));
  };

  const googleDesktop = async (e: React.MouseEvent) => {
    ripple(e.currentTarget);
    setError(null);
    // a page on another site's server (not the app) finishes the same way: Google in its own tab, this page polls
    const tab = inDesktop ? null : window.open("", "_blank");
    try {
      const { url, poll, expiresIn } = await flowformBegin();
      if (tab) tab.location.href = url;
      else await openUrl(url);
      setWaiting(true);
      let live = true;
      cancelWait.current = () => {
        live = false;
        setWaiting(false);
      };
      const until = Date.now() + expiresIn * 1000;
      while (live && Date.now() < until) {
        await new Promise((ok) => setTimeout(ok, 1500));
        if (!live) return;
        const r = await flowformPoll(poll);
        if (r.status === "ok" && r.user) {
          setWaiting(false);
          return signedIn(r.user);
        }
        if (r.status === "error") throw new Error(r.error ?? "Sign-in didn't finish");
      }
      if (live) throw new Error("Sign-in timed out — try again.");
    } catch (err) {
      fail((err as Error).message);
    } finally {
      setWaiting(false);
    }
  };

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    ripple(e.currentTarget.querySelector(".login-go"));
    setBusy(true);
    setError(null);
    try {
      const { user } = await devLogin(email.trim(), name.trim());
      localStorage.setItem("foundation-last-email", email.trim());
      localStorage.setItem("foundation-last-name", name.trim());
      signedIn(user);
    } catch (err) {
      fail((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // ---------- typing stirs the wind at the cursor ----------
  const measureCtx = useMemo(() => document.createElement("canvas").getContext("2d"), []);
  const typed = (el: HTMLInputElement, grew: boolean) => {
    if (!g || !frame || !measureCtx) return;
    const style = getComputedStyle(el);
    measureCtx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const caret = el.selectionStart ?? el.value.length;
    const box = el.getBoundingClientRect();
    const r = root.current!.getBoundingClientRect();
    const x = box.left - r.left + parseFloat(style.paddingLeft) + measureCtx.measureText(el.value.slice(0, caret)).width - el.scrollLeft;
    const y = box.top - r.top + box.height / 2;
    hooks()?.stir(x, y + (Math.random() - 0.5) * g.ch, (grew ? 1 : -1) * g.cw * 6, (Math.random() - 0.5) * g.ch, grew ? 0.6 : 0.4);
  };
  const focused = (el: HTMLInputElement) => {
    if (!g) return;
    const r = root.current!.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    hooks()?.stir(b.left - r.left, b.top - r.top + b.height / 2, b.width * 0.6, 0, 0.6);
  };
  const openEmail = (e: React.MouseEvent) => {
    ripple(e.currentTarget, 0.6);
    setByEmail(true);
  };

  const mask = leave
    ? `radial-gradient(circle at ${leave.ox}px ${leave.oy}px, transparent ${Math.max(0, leave.radius - BAND)}px, #000 ${leave.radius}px)`
    : undefined;
  const masked = mask ? { WebkitMaskImage: mask, maskImage: mask } : undefined;
  const google = cfg?.flowform || cfg?.google;
  const googleHref = cfg?.flowform ? serverUrl(`/auth/flowform/start?return=${encodeURIComponent("/?arrive")}`) : serverUrl("/auth/google/start");
  const shown = open > 0.55 || reduced;

  return (
    <div className={`login ascii-wind f-day${leave ? " is-leaving" : ""}`} ref={root} data-ascii-wind>
      <div className="login-paper" style={masked} />
      {g && (
        <div
          className="login-frame"
          style={{
            left: frame?.x ?? 0,
            top: frame?.y ?? 0,
            width: frame?.width ?? Math.min(FRAME_COLS * g.cw, g.width - 32),
            height: frame?.height,
            padding: `${PAD_ROWS * g.ch}px ${PAD_COLS * g.cw}px`,
            visibility: frame ? "visible" : "hidden",
            ...masked,
          }}
        >
          <motion.div
            ref={form}
            className="login-form"
            initial={false}
            animate={shown ? { opacity: 1, y: 0, scale: 1 } : { opacity: 0, y: 10, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 260, damping: 22 }}
          >
            <div className="f-eyebrow login-eyebrow" data-shape="text">
              Form Industries
            </div>
            <h1 className="login-title" data-shape="text">
              Foundation
            </h1>

            {waiting ? (
              <div className="login-waiting" role="status">
                <span className="f-dot is-live" />
                <span data-shape="text">Finish signing in with Google in your browser.</span>
                <motion.button type="button" className="f-pill login-cancel" data-shape="control" whileHover={{ y: -1 }} whileTap={{ scale: 0.97 }} transition={press} onClick={() => cancelWait.current()}>
                  Cancel
                </motion.button>
              </div>
            ) : (
              google && (
                <>
                  {(inDesktop || BEARER) && cfg?.flowform ? (
                    <motion.button type="button" className="f-pill login-btn" data-shape="control" whileHover={{ y: -1 }} whileTap={{ scale: 0.97 }} transition={press} onClick={googleDesktop}>
                      Connect with Google
                    </motion.button>
                  ) : (
                    <motion.a className="f-pill login-btn" data-shape="control" href={googleHref} whileHover={{ y: -1 }} whileTap={{ scale: 0.97 }} transition={press} onClick={(e) => ripple(e.currentTarget)}>
                      Connect with Google
                    </motion.a>
                  )}
                </>
              )
            )}

            {cfg?.devLogin && !waiting && google && !byEmail && (
              <button type="button" className="login-or" data-shape="text" onClick={openEmail}>
                Use your email
              </button>
            )}
            {cfg?.devLogin && !waiting && (byEmail || !google) && (
              <motion.form
                className="login-fields"
                onSubmit={submit}
                initial={google ? { opacity: 0, height: 0 } : false}
                animate={{ opacity: 1, height: "auto" }}
                transition={{ type: "spring", stiffness: 300, damping: 30 }}
              >
                <input
                  className="f-input"
                  data-shape="control"
                  placeholder="Your name"
                  value={name}
                  autoComplete="name"
                  onChange={(e) => {
                    typed(e.target, e.target.value.length >= name.length);
                    setName(e.target.value);
                  }}
                  onFocus={(e) => focused(e.currentTarget)}
                />
                <input
                  className="f-input"
                  data-shape="control"
                  placeholder="Work email"
                  type="email"
                  value={email}
                  autoComplete="email"
                  autoFocus={!arriving && (byEmail || !google)}
                  required
                  onChange={(e) => {
                    typed(e.target, e.target.value.length >= email.length);
                    setEmail(e.target.value);
                  }}
                  onFocus={(e) => focused(e.currentTarget)}
                />
                <motion.button className="f-pill login-btn login-go" data-shape="control" disabled={busy || !email} whileHover={{ y: -1 }} whileTap={{ scale: 0.97 }} transition={press}>
                  {busy ? "Signing in…" : "Enter Foundation"}
                </motion.button>
              </motion.form>
            )}
            {error && (
              <motion.div className="login-error" role="alert" data-shape="text" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} transition={press}>
                {error}
              </motion.div>
            )}
            {(inDesktop || BEARER) && !waiting && !pickServer && (
              <button type="button" className="login-or" data-shape="text" data-tip="The Foundation server this device signs in to" onClick={() => setPickServer(true)}>
                Server · {(SERVER || window.location.origin).replace(/^https?:\/\//, "")}
              </button>
            )}
            {pickServer && !waiting && (
              <motion.form
                className="login-fields"
                onSubmit={(e) => {
                  e.preventDefault();
                  chooseServer(serverDraft);
                }}
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                transition={{ type: "spring", stiffness: 300, damping: 30 }}
              >
                <input
                  className="f-input"
                  data-shape="control"
                  placeholder="https://foundation.example.com"
                  type="url"
                  value={serverDraft}
                  autoFocus
                  aria-label="Server"
                  onChange={(e) => setServerDraft(e.target.value)}
                />
                <motion.button className="f-pill login-btn" data-shape="control" whileHover={{ y: -1 }} whileTap={{ scale: 0.97 }} transition={press}>
                  Use this server
                </motion.button>
              </motion.form>
            )}
          </motion.div>
        </div>
      )}
      <div className="login-foot" data-shape="text">
        Move the cursor — it's the wind.
      </div>
    </div>
  );
}
