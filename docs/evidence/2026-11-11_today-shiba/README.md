# Today and the Shiba · 2026-11-11

Run on an isolated copy (server :4420 on a `sqlite3 .backup` of the dev database, client :1440), signed in by dev login as a test person, Ada Park, with a few asks, a note that tags her, a profile and three goals seeded through the API. The Shiba's turns ran for real on the subscription runtime (Claude Code headless with Foundation's MCP).

- `01-today-day.jpg`: Today at 1440×900 by day: the Shiba's room, the greeting, Focus and Goals on glass, the company apps in the top bar (BomForm, HyperForm and FleetForm dashed: not linked here).
- `02-today-night.jpg`: the same at night (1024×768).
- `03-thinking.jpg`: asked "What should I tackle first today, and how am I doing on my goals?". The room turns to its thinking grade.
- `04-answer-points.jpg`: the answer, from the page's own data, with `point_at` (since renamed `point_today`) ringing the two focus items and two goals it named.
- `05-goals-changed-by-shiba.jpg`: "Kai's onboarding is done. And add a goal: get the Today page in front of the team by Friday." It closed one goal (struck, 100 %) and added the other (due Fri 13 Nov), and the page changed with it.
- `06-phone-resumed.jpg`: 375 px wide after a reload. The conversation came back; no sideways scroll.
- `07-design-page-day.jpg`, `08-design-page-night-speaking.png`: `#/design` → Today and the Shiba (moods, rows, goals, chips), day and night.
- `09-chrome-popup.jpg`: the extension's popup page reading `/api/today` with the signed-in session (served as a plain page on localhost; not yet inside Chrome).
- `10-chrome-newtab-to-today.jpg`: the extension's new tab handing off to `/?from=chrome#/today`.
- `e2e-today.png`: from `e2e/today.spec.ts` (its own server and data, no agent runtime).

Checks: `apps/server/test/today.test.ts` (5), `apps/extension/test/extension.test.mjs` (4), `apps/client/e2e/today.spec.ts` (1).

Not checked: the extension loaded into a real Chrome (so the popup's cookie read from the extension origin), a real voice into the mic, and the API runtime.
