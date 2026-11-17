# The plan as a kanban (2026-11-07)

Josh: "the plan forward should be a kanban board that we move through issues … add bugs and plans to github issues and planning … keep a local copy in the settings page."

- `docs/plan.json`: 72 cards — the open §7 known issues as bugs, the unfinished parts of the old §8 phases as plans, the §6 hookups and other person-only steps as "Needs you". Finished phases (1 Solid ground, 2 Vision loop) and finished to-dos were dropped from the plan.
- `scripts/plan.mjs` push / pull / project / check against GitHub issues through the `gh` login.
- Settings (`#/settings`) → Plan shows the board; Services lists integrations.

Checked in the browser (own server :16410 + Vite :16430, dev login as an admin, `?rafshim`):

1. `01_board-day_card-moved-by-admin.jpg` — 1440×900, day. "A crew-wide stop" opened and moved Next → Doing with Move to…; the card says "Moved from Next by Ada", the head counts "1 moved here, not yet pushed"; `docs/plan.json` on disk changed (status `doing`, `moved.from: next`). The test move was undone afterwards.
2. `02_board-night.jpg` — the same, night.
3. `03_board-400px-night-stacked.jpg` — 400 px wide: the columns stack into bands, filters wrap.
4. `04_design-page-night.jpg`, `05_design-page-day.jpg` — the board on `#/design` with a sample plan.

Tests: `apps/server/test/plan.test.ts` (reads the file; only an admin moves; unknown column/card refused; a move writes the file and marks the card; moving back clears the mark) and `apps/client/test/plan.test.ts` (the file is sound; every card shown once in its column; filters).

Not done: **pushing to GitHub**. Issues are disabled on `joshleong/Foundation` (a fork of Normal-AI-Vibe-Code/Foundation, where this login can only read), and turning them on and publishing 72 issues to a public repo was blocked as a publication Josh hadn't confirmed. Run `gh repo edit joshleong/Foundation --enable-issues` then `npm run plan:push`. `plan:project` needs `gh auth refresh -s project` and hasn't been run.
