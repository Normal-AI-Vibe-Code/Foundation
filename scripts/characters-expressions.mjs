#!/usr/bin/env node
// Press the expressions stage for named characters, as yourself, against a running Foundation server.
//
// Every press spends Meshy credits (9 with nano-banana-pro: one image), so this is a person's press like the
// button on the card: it uses YOUR browser session, never an agent's token (the server refuses a bearer),
// and by default it presses nothing. It lists what it would press and what that costs; --press does it.
//
//   node scripts/characters-expressions.mjs Mochi Kumo Taro           what it would press, and the cost
//   node scripts/characters-expressions.mjs --press Mochi Kumo Taro   press them, one at a time
//   node scripts/characters-expressions.mjs --set animals             every character of a set
//   node scripts/characters-expressions.mjs --again --press Mochi     draw one again (it has a sheet already)
//
//   FOUNDATION_URL       the server (default http://localhost:4410, the desktop app's)
//   FOUNDATION_SESSION   your session: the value of the `foundation_session` cookie from a browser signed in
//                        to that server (DevTools → Application → Cookies). It is sent as a cookie header,
//                        never in a URL, and never written anywhere.
//
// What it holds to (the pipeline's rules, docs/characters.md):
//  - one press at a time, each followed to its end before the next;
//  - it never sends a press twice: a stage that failed, or one whose last send was never answered ("may
//    have been charged"), stops the run and is left for you to look at on the card;
//  - a character with an expressions sheet is skipped unless --again; one with no sheet can't have one;
//  - the server must know the stage (a server from before 2026-11-17 doesn't: it says so and stops).
//
// The expressions sheet adds to a character and replaces nothing: its views, model and avatar stay.

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const valueOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const press = flag("--press");
const again = flag("--again");
const set = valueOf("--set")?.toLowerCase();
const names = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--set").map((n) => n.toLowerCase());
const base = (process.env.FOUNDATION_URL ?? "http://localhost:4410").replace(/\/$/, "");
const session = (process.env.FOUNDATION_SESSION ?? "").trim();

// A stop throws to the bottom of this file, which sets the exit code and lets Node end by itself: process.exit()
// while fetch's sockets are still closing aborts Node on Windows (a libuv assertion), after the work is done.
class Stop extends Error {}
const stop = (why) => {
  throw new Stop(why);
};

async function call(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: body ? "POST" : "GET",
    // sent by you, from no web page: a press signed in by the cookie must say where it comes from (origins.ts)
    headers: { cookie: `foundation_session=${session}`, "sec-fetch-site": "none", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(180_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `${res.status} from ${path}`), { status: res.status });
  return data;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!names.length && !set) stop("Name the characters (or --set animals). Nothing is pressed without --press.");
  if (!session) stop("Set FOUNDATION_SESSION to your `foundation_session` cookie from a browser signed in to that server.");

  const costs = await call("/api/characters/costs").catch((e) => stop(`Couldn't reach ${base} as you: ${e.message}`));
  if (!costs.configured) stop("Meshy isn't connected on that server (MESHY_API_KEY), so nothing can be drawn.");
  if (costs.costs?.mesh?.expressions === undefined) stop(`The server at ${base} doesn't know the expressions stage: it is running code from before 2026-11-17. Start it from a checkout that has it.`);

  const { characters } = await call("/api/characters");
  const wanted = characters.filter((c) => (set ? c.set === set : true) && (names.length ? names.includes(c.name.toLowerCase()) : true) && c.approval !== "archived");
  for (const n of names) if (!wanted.some((c) => c.name.toLowerCase() === n)) console.log(`  ${n.padEnd(10)} no such character${set ? ` in ${set}` : ""}`);

  const plan = [];
  for (const c of wanted) {
    const cost = costs.costs[c.form].expressions;
    const has = c.stages.expressions?.state === "done";
    const busy = Object.entries(c.stages).find(([, s]) => s.state === "running")?.[0];
    const why = !c.files.front ? "no sheet yet: draw its sheet first" : busy ? `its ${busy} is running` : has && !again ? "has its expressions (--again to draw them again)" : null;
    console.log(`  ${c.name.padEnd(10)} ${c.form.padEnd(6)} ${c.set.padEnd(9)} ${why ? `skip: ${why}` : `${press ? "press" : "would press"} · ${cost} credits`}`);
    if (!why) plan.push({ c, cost });
  }
  const total = plan.reduce((n, p) => n + p.cost, 0);
  console.log(`\n  ${plan.length} to press, ${total} credits (images by ${costs.imageModel}); Meshy has ${costs.balance ?? "an unknown number of"} credits left.`);
  if (!plan.length) return;
  if (!press) {
    console.log("  Nothing was pressed. Run again with --press to spend them.\n");
    return;
  }
  if (typeof costs.balance === "number" && costs.balance < total) stop(`Not enough credits for all of them (${costs.balance} left, ${total} needed). Name fewer.`);

  let spent = 0;
  for (const { c } of plan) {
    process.stdout.write(`  ${c.name.padEnd(10)} `);
    try {
      // no `confirm`: a send that was never answered is yours to look at, not this script's to repeat
      await call(`/api/boards/${encodeURIComponent(c.boardId)}/characters/${c.panelId}/stages/expressions`, {});
    } catch (e) {
      stop(`${c.name}: ${e.message}\n  Stopped here. Nothing was sent twice; ${spent} credits were spent before this.`);
    }
    for (let waited = 0; ; waited += 3) {
      await sleep(3000);
      const now = (await call("/api/characters")).characters.find((x) => x.id === c.id);
      const st = now?.stages.expressions;
      if (st?.state === "done") {
        spent += st.credits ?? 0;
        console.log(`done · ${st.credits ?? 0} credits · file ${now.files.expressions}`);
        break;
      }
      if (st?.state === "failed") stop(`${c.name}: ${st.error ?? "it failed"}\n  Stopped here: look at its card before pressing again. ${spent} credits were spent before this.`);
      if (waited > 600) stop(`${c.name}: still running after ten minutes. It is being followed by the server; look at its card. ${spent} credits were spent before this.`);
      process.stdout.write(".");
    }
  }
  const after = await call("/api/characters/costs").catch(() => null);
  console.log(`\n  ${plan.length} expression sheets drawn, ${spent} credits. Meshy has ${after?.balance ?? "?"} left. Look at each on its card before using it.\n`);
}

try {
  await main();
} catch (e) {
  if (!(e instanceof Stop)) throw e;
  console.error(`\n  ${e.message}\n`);
  process.exitCode = 1;
}
