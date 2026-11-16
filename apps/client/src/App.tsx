import { useEffect, useState } from "react";
import type { UserInfo } from "@foundation/protocol";
import { initNight } from "@foundation/ui";
import "@foundation/ui/tokens.css";
import { Login } from "./login/Login";
import { Shell } from "./shell/Shell";
import { DesignPage } from "./design/DesignPage";
import { Privacy } from "./privacy/Privacy";
import { Tip } from "./shell/Tip";
import { WindowControls } from "./shell/WindowControls";
import { ServerSwitch } from "./server/ServerSwitch";
import { rememberMe, whoAmI } from "./lib/api";
import { UpdateShelf } from "./update/UpdateCard";
import { startUpdates } from "./update/updater";
import "./App.css";
import "./shell/shell.css";
import "./panels/live.css";
import "./shell/crew.css";
import "./shell/spaces.css";
import { initScrollbars } from "./lib/scrollbars";
import "./settings/settings.css";

initNight();
initScrollbars();
// the desktop app asks its signed feed for a new version a few seconds after it opens (inert in a browser)
startUpdates();

function useHashRoute() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

/**
 * Sign-in gate → the shell, which is the whole app (2026-11-15): Today (home, `#/today`),
 * the grids (`#/board`, and any `?board=…` / `?focus=…` link) and Settings (`#/settings/<tab>`)
 * are places inside it, so the top bar and the side menu never leave (lib/place.ts).
 *
 * #/design is the design language as a reference page of its own (open without a sign-in; Settings →
 * Design language shows it as a grid); #/design/sign-in shows the sign-in page even when signed in.
 * #/privacy is open to anyone (the Chrome Web Store links to it).
 *
 * The sign-in page stays over the shell until its dissolve has run, so
 * signing in turns into the board rather than cutting to it. Back from
 * flowform's Google sign-in in the browser (?arrive), it dissolves on arrival.
 */
function App() {
  const [user, setUser] = useState<UserInfo | null | undefined>(undefined);
  const route = useHashRoute();
  const [arrive] = useState(() => new URLSearchParams(window.location.search).has("arrive"));
  /** the sign-in page is still dissolving over the shell */
  const [veil, setVeil] = useState(arrive);

  useEffect(() => {
    void whoAmI().then((r) => setUser(r.user));
    if (arrive) window.history.replaceState(null, "", window.location.pathname + window.location.hash);
  }, [arrive]);

  const preview = route.startsWith("#/design/sign-in");
  if (route.startsWith("#/design") && !preview) {
    return (
      <>
        <DesignPage />
        <WindowControls />
        <Tip />
      </>
    );
  }
  // what the Chrome extension (and Foundation) does with your data: open to anyone, signed in or not
  if (route.startsWith("#/privacy")) {
    return (
      <>
        <Privacy />
        <Tip />
        <WindowControls />
      </>
    );
  }
  if (user === undefined && !preview) {
    return (
      <>
        <div className="boot" />
        <ServerSwitch day />
        <WindowControls />
      </>
    );
  }
  const signedOut = preview || !user || veil;
  return (
    <>
      {user && <Shell user={user} route={preview ? "#/board" : route} />}
      {(preview || !user || veil) && (
        <Login
          arriving={veil && arrive && !!user}
          onSignedIn={(u) => {
            rememberMe(u);
            setUser(u);
            setVeil(true);
          }}
          onGone={() => {
            setVeil(false);
            // signing in from the preview goes in
            if (preview) window.location.hash = "";
          }}
        />
      )}
      {/* over the sign-in page (always day), the card wears day too */}
      <UpdateShelf day={preview || !user || veil} />
      {/* signed in, the server's pill is in the top bar; before that there's no bar, so it keeps the corner */}
      {signedOut && <ServerSwitch day />}
      <WindowControls day={preview || !user || veil} />
      <Tip />
    </>
  );
}

export default App;
