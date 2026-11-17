/**
 * The toolbar popup: your day at a glance, read from Foundation's own
 * /api/today with your Foundation sign-in. Signed out or unreachable, it says
 * so and still offers the apps and a way in.
 */
import { foundationUrl, night, todayUrl } from "./store.js";
import { FALLBACK_APPS } from "./apps.js";

night();
const base = await foundationUrl();
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter((k) => k !== null && k !== undefined));
  return n;
};
$("date").textContent = new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
$("open-today").href = todayUrl(base);
$("open-boards").href = `${base}/#/board`;
$("where").textContent = base.replace(/^https?:\/\//, "");

const GLYPH = { ask: "?", stage: "◆", mention: "@", file: "⇪", changes: "↻", related: "∿" };
const boardLink = (f) => (f.id.startsWith("file:") && !f.objectId ? `${base}/files/${f.id.slice(5)}` : `${base}/?board=${encodeURIComponent(f.board)}${f.objectId ? `&focus=${encodeURIComponent(f.objectId)}` : ""}`);

function apps(list) {
  $("apps").replaceChildren(
    ...list
      .filter((a) => a.id !== "foundation")
      .map((a) =>
        a.url
          ? el("a", { className: "ext-app", href: a.url, target: "_blank", title: a.role }, el("span", { className: "ext-glyph", textContent: a.glyph }), a.name)
          : el("span", { className: "ext-app", title: `${a.role} · not linked yet` }, el("span", { className: "ext-glyph", textContent: a.glyph }), a.name),
      ),
  );
  for (const n of $("apps").querySelectorAll("span.ext-app")) n.dataset.unlinked = "";
}

try {
  const res = await fetch(`${base}/api/today`, { credentials: "include" });
  if (res.status === 401) throw Object.assign(new Error("signed out"), { signedOut: true });
  if (!res.ok) throw new Error(`Foundation answered ${res.status}`);
  const t = await res.json();
  const wants = t.focus.filter((f) => f.kind !== "related").length;
  $("hello").textContent = `${t.person.first}, ${wants === 0 ? "nothing is waiting on you" : wants === 1 ? "one thing wants you" : `${wants} things want you`}.`;
  if (t.focus.length) {
    $("focus").hidden = false;
    $("focus-n").textContent = String(t.focus.length);
    $("focus-list").replaceChildren(
      ...t.focus.slice(0, 6).map((f) =>
        el(
          "li",
          {},
          el(
            "a",
            { className: "ext-row", href: boardLink(f), target: "_blank" },
            el("span", { className: "ext-glyph", textContent: GLYPH[f.kind] ?? "·" }),
            el("span", { className: "ext-row-text" }, el("b", { textContent: f.title }), el("small", { textContent: f.why })),
          ),
        ),
      ),
    );
    for (const [i, f] of t.focus.slice(0, 6).entries()) if (f.tone) $("focus-list").children[i].firstChild.dataset.tone = f.tone;
  }
  const goals = t.goals.filter((g) => g.status === "active");
  if (goals.length) {
    $("goals").hidden = false;
    $("goal-list").replaceChildren(
      ...goals.slice(0, 5).map((g) =>
        el("li", { className: "ext-goal" }, el("span", { textContent: g.title }), el("i", { className: "ext-bar" }, el("i", { style: `width:${Math.round(g.progress * 100)}%` })), el("small", { textContent: `${Math.round(g.progress * 100)}%` })),
      ),
    );
  }
  apps(t.apps);
} catch (e) {
  apps(FALLBACK_APPS);
  $("state").replaceChildren(
    e.signedOut ? "You're signed out of Foundation. " : `Foundation isn't answering at ${base}. `,
    el("a", { href: todayUrl(base), target: "_blank", textContent: e.signedOut ? "Sign in" : "Open it" }),
  );
}
