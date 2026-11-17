/**
 * The floor keeps the grid at least MIN_PAPER wide. Opening the side pane by
 * hand beside a session on a narrow window keeps the pane (it was asked for)
 * and narrows the session instead, then closes search, then narrows the pane.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const win = { innerWidth: 1100, addEventListener() {}, removeEventListener() {} };
(globalThis as unknown as { window: typeof win }).window = win;

const { setUi, getUi, floorInsets, MIN_PAPER, WIDTHS } = await import("../src/state/ui");
const paper = () => win.innerWidth - floorInsets().left - floorInsets().right;

test("the pane opened by hand beside a session: the session narrows, the grid keeps its paper", () => {
  win.innerWidth = 1100;
  setUi({ pane: false, session: "s1", sessions: [{ id: "s1", kind: "agent", title: "x" }], sessionW: 460, paneW: 272, search: false });
  assert.ok(paper() >= MIN_PAPER);
  setUi({ pane: true });
  assert.equal(getUi().pane, true, "the pane opened");
  assert.ok(paper() >= MIN_PAPER, `paper ${paper()}`);
  assert.ok(getUi().sessionW < 460 && getUi().sessionW >= WIDTHS.session.min);
});

test("not enough even with the session at its narrowest: search closes, then the pane narrows", () => {
  win.innerWidth = 1000;
  setUi({ pane: false, session: "s1", sessions: [{ id: "s1", kind: "agent", title: "x" }], sessionW: 460, paneW: 272, search: true, searchW: 380 });
  setUi({ pane: true });
  assert.equal(getUi().pane, true);
  assert.equal(getUi().search, false);
  assert.equal(getUi().sessionW, WIDTHS.session.min);
  assert.ok(paper() >= MIN_PAPER - 1 || getUi().paneW === WIDTHS.pane.min, `paper ${paper()}, pane ${getUi().paneW}`);
});

test("on a wide window nothing narrows", () => {
  win.innerWidth = 1920;
  setUi({ pane: false, session: "s1", sessions: [{ id: "s1", kind: "agent", title: "x" }], sessionW: 460, paneW: 272, search: true, searchW: 380 });
  setUi({ pane: true });
  assert.equal(getUi().sessionW, 460);
  assert.equal(getUi().search, true);
  assert.equal(getUi().paneW, 272);
});

// ----- the top bar's tabs are spaces; a session is not one -----

const { noteSpaceOpen, closeSpaceTab, newSession, toggleSession } = await import("../src/state/ui");

test("opening a space gives it a tab once; closing the showing tab says which to show next; the last tab stays", () => {
  setUi({ spaces: [] });
  noteSpaceOpen("a");
  noteSpaceOpen("b");
  noteSpaceOpen("c");
  noteSpaceOpen("b");
  assert.deepEqual(getUi().spaces, ["a", "b", "c"]);
  assert.equal(closeSpaceTab("a", "b"), null); // not the showing one: nothing to switch to
  assert.deepEqual(getUi().spaces, ["b", "c"]);
  assert.equal(closeSpaceTab("c", "c"), "b");
  assert.equal(closeSpaceTab("b", "b"), null);
  assert.deepEqual(getUi().spaces, ["b"]);
});

test("a session never makes a tab; the bottom bar's button puts it away and brings it back", () => {
  setUi({ spaces: ["b"], sessions: [], session: null });
  toggleSession(); // none yet: starts one
  const id = getUi().session;
  assert.ok(id);
  assert.deepEqual(getUi().spaces, ["b"]);
  toggleSession();
  assert.equal(getUi().session, null);
  toggleSession();
  assert.equal(getUi().session, id);
  newSession();
  assert.equal(getUi().sessions.length, 2);
  assert.deepEqual(getUi().spaces, ["b"]);
});
