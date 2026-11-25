/**
 * Who is on the grid with you, across computers (2026-11-25). Foundation's own server reads its grids' presence
 * and tells every window (lib/whereabouts.ts). A chat server of its own has no grids: when ChatForm is on one,
 * this window tells it which grid it has open, and it tells the others (protocol `ChatSay` / `ChatEvent` `where`),
 * so two people on the same grid from different computers see each other in the conversation's card and list.
 *
 * `useTellWhere` is mounted once, with the top bar's ChatForm button (so it lives wherever someone is signed in):
 *  - it says the open grid's id whenever the place or the grid changes (chat/gridChat.ts `whereToSay`: only to a
 *    server that has `where`, never the grid's name), and chat/model.ts says it again when the socket comes back;
 *  - on a chat server of its own, Foundation's own answer no longer arrives live (its chat socket isn't the one
 *    open), so it is read again every 20 s while the window is showing.
 */

import { useEffect, useState } from "react";
import { placeOf } from "../lib/place";
import { loadWhereabouts } from "../lib/whereabouts";
import { activeBoard, onBoardChange } from "../sync/board";
import { whereToSay } from "./gridChat";
import { sayWhere, useChat } from "./model";

const OWN_EVERY_MS = 20_000;

export function useTellWhere() {
  const s = useChat();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const again = () => setTick((n) => n + 1);
    window.addEventListener("hashchange", again);
    const off = onBoardChange(again);
    return () => {
      window.removeEventListener("hashchange", again);
      off();
    };
  }, []);
  useEffect(() => {
    const say = whereToSay({ remote: s.remote, features: s.features, onGrid: placeOf(window.location.hash).kind === "grid", boardId: activeBoard()?.boardId ?? null });
    if (say) sayWhere(say.board, say.name);
  }, [s.remote, s.features, tick]);
  // leaving (the window closes, the page reloads): the socket's end tells the server; nothing to say here
  useEffect(() => {
    if (!s.remote || s.status !== "live") return;
    const t = setInterval(() => !document.hidden && void loadWhereabouts(), OWN_EVERY_MS);
    return () => clearInterval(t);
  }, [s.remote, s.status]);
}
