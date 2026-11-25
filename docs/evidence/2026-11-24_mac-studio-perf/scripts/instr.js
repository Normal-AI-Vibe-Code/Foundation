(() => {
  const acc = (window.__js = { total: 0, by: {} });
  const name = (fn, kind) => kind + ":" + ((fn && fn.name) || "anon") + ":" + (new Error().stack || "").split("\n").slice(2, 4).map(s => s.replace(/.*\/src\//, "").replace(/\?[^:]*/, "").trim()).join("<");
  const wrap = (fn, kind) => { if (typeof fn !== "function") return fn; const key = name(fn, kind); return function (...a) { const t = performance.now(); try { return fn.apply(this, a); } finally { const d = performance.now() - t; acc.total += d; const e = acc.by[key] || (acc.by[key] = [0, 0, 0]); e[0] += d; e[1]++; e[2] = Math.max(e[2], d); } }; };
  const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = (cb) => raf(wrap(cb, "raf"));
  const st = window.setTimeout.bind(window); window.setTimeout = (cb, ...r) => st(wrap(cb, "timeout"), ...r);
  const si = window.setInterval.bind(window); window.setInterval = (cb, ...r) => si(wrap(cb, "interval"), ...r);
  const IO = window.IntersectionObserver; window.IntersectionObserver = class extends IO { constructor(cb, o) { super(wrap(cb, "io"), o); } };
  const ael = EventTarget.prototype.addEventListener; const map = new WeakMap();
  EventTarget.prototype.addEventListener = function (t, cb, o) { if (typeof cb === "function") { let w = map.get(cb); if (!w) { w = wrap(cb, "ev-" + t); map.set(cb, w); } return ael.call(this, t, w, o); } return ael.call(this, t, cb, o); };
  const rel = EventTarget.prototype.removeEventListener; EventTarget.prototype.removeEventListener = function (t, cb, o) { return rel.call(this, t, (typeof cb === "function" && map.get(cb)) || cb, o); };
})();
