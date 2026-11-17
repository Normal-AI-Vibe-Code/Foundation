# The crew, next (2026-11-08)

Josh: "continue to improve the multi-agents". Three plan cards, in order: `activity-roles`, `machine-agent-commands`, and helpers that see each other's work (`crew-shared-work`). Branch `feat/crew-next`.

## 1. Who did what (`activity-roles`)

- The HTTP tools door is the person only from their browser (session cookie, no bearer: `auth.isPerson`); their calls log `role: human` and put up no agent ring. A bearer token at the same door is "Name's agent", `role: agent`, `for: Name`. Crew agents sign with their name and `for` the person who asked.
- People's own grid edits (`gridlog.ts`): read from the person's sync socket (`boards.ts` `socketUserId`, `onBoardOpen`), only sections and cards added, removed, renamed or moved. Gathered until they pause (2.5 s, 15 s at most); add-then-remove is nothing, rename-rename is one rename, a repeat of the last line replaces it, three or more things are one summary line. Typing, cells, resizes, app outputs and the server's own writes aren't logged as the person.
- Checked: `apps/server/test/activity.test.ts` (4): the door's three cases; a name typed letter by letter and a 60-frame drag are one line each, a second drag replaces it; rename chains; a move across sections; typing, cells, a resize and make-and-unmake log nothing; six pasted cards are one line; 300 rounds of edits by two people stay at or under 400 entries.
- In the browser (`e2e/crew.spec.ts`, two people): Kai renamed "Shared" through his own socket and Ada's side pane said **Kai Test renamed the section "Shared" to "Shared parts"** (green), between the three agents' violet ✦ lines, each with `for: Ada Test` (21).

## 2. Agents run commands in a machine (`machine-agent-commands`)

- `machine_run` (`machineasks.ts`): one `/bin/sh` command in a running machine, with a why. The ask goes on the card (the board's `machineAsks` map, server-written) and the call waits (120 s by default). Only a person who can edit the board answers, from their browser: `POST /api/boards/:id/machines/:panel/asks/:ask/run|decline` (`requirePerson` + `canWrite`). Run → `machines.execOnce`: an Engine API exec without a TTY under `timeout`, framed stdout/stderr unframed as it streams, exit code from `/exec/:id/json`. The agent gets the output (the last 16 KB) and the exit code; declined, unanswered or withdrawn, nothing runs and the agent is told so.
- Activity: the ask (the agent, `for` its person) and the outcome (who ran it and the exit code, who declined it, or that nobody answered).
- Stand-in engine (`machines.test.ts` +2): frames split across writes, stderr order, exit 3, 20,000 lines cut to the end, a viewer's answer refused, a second ask from the same agent refused, decline, a 1.5 s timeout, withdrawn when the agent stops, a viewer's agent refused, a stopped machine refused. No exec reached the engine for any ask that wasn't Run.
- Real engine: `machine-asks.mjs` against Docker Desktop 28.3 (API 1.51) on this machine, Ada (admin), Kai and Vic (viewer) in Chromium:

  ```
  start: 200 running 13136 ms
  waiting on the card: {"by":"Ada Test's agent","for":"Ada Test","state":"waiting",...}
  viewer sees Run buttons: 0
  bearer presses Run: 403 Running an agent's command needs a person: press the button on the card. ...
  viewer presses Run: 403 View only: you can read "machine-asks-…" but not change it. ...
  still waiting: waiting
  agent's call returned after 8773 ms: {"status":"done","ran_by":"Ada Test","exit_code":0,
    "output":"NAME=\"Alpine Linux\"\nID=alpine\nx86_64\nto-stderr\n","ms":6190,...}
  declined: {"status":"declined","declined_by":"Kai Test","message":"Kai Test declined it, so nothing ran. ..."}
  activity: Ada Test's agent [agent for Ada Test] asked to run `cat /etc/os-release | head -n 2; ...` in asks-box
  activity: Ada Test [human] ran Ada Test's agent's `cat /etc/os-release | head -n 2; ...` in asks-box: exit 0
  activity: Ada Test's agent [agent for Ada Test] asked to run `rm -rf /srv/cache` in asks-box
  activity: Kai Test [human] declined Ada Test's agent's `rm -rf /srv/cache` in asks-box
  removed: 200 absent
  ```

  That first command took 6.2 s inside `execOnce` (a fresh container on Docker Desktop); `execOnce` straight against another alpine container measured 648, 397 and 178 ms for three in a row.
- Screens: 10 (Ada), 11 (Kai) and 12 (Vic, view only, no buttons) with the ask waiting; 13 ran, as Kai saw it; 14 declined, as Ada saw it; 15 the same card in day; 16 `#/design` day and night (560, 400 as a viewer with a running line, 260).

## 3. Helpers see each other's work (`crew-shared-work`)

- `set_plan` keeps the agent's plan on its crew member; a lead's crew is itself plus every helper it calls in, finished ones included. `crew_work` (read) returns the ask, the lead's plan, and each agent's state, what it's doing, its sections and its cards (by `createdBy`). A helper's brief starts with the same, in words, inside `<crew>`; the system prompt has helpers call `crew_work` before making each thing.
- The script runtime proves it: "…and get two helpers" calls the second one in after the first has written; the second reads `crew_work`, sees the first one's "Suppliers to call", and writes only "Lead times", saying so and quoting the lead's plan.
- Checked: `crew.test.ts` +2 (one supplier list, not two; the second helper's brief named the first one's note; `crew_work` with a finished helper). `e2e/crew.spec.ts` +1: Kai saw three named agents; the section held one "Suppliers to call" and one "Lead times" by a different agent, whose text names the first helper and the plan (20).

## Runs

- `npm test` (69 client + 118 server, 6 skipped as before) and `npm run typecheck` green.
- `E2E_CLIENT_PORT=15450 E2E_SERVER_PORT=15451 E2E_SLACK_PORT=15452 npm run e2e -w @foundation/client`: 32 passed, 2 skipped (the GPU frames check and a conditional split case, as before), 1 failed: `perf.spec.ts`, a pan leg at p95 50 ms against its 34 ms headless budget. It failed the same way (50 and 66.6 ms) with `main`'s client put back in place under the same load (several sessions on this machine), so it isn't this branch; it needs a quiet machine. One cold first run of `crew.spec.ts` timed out on the first dev login (10 s) and passed on rerun.
- Dev servers for the screenshots ran on :15410 (server, Docker only) and :15437 (client), not :4410/:1430.

## Open

- No real model has used `machine_run`, `crew_work` or the helper brief yet (a real turn spends the plan; not run here).
- Asks wait in the server's memory; a restart withdraws them. People with edit rights could write a fake ask into `machineAsks` through their socket (Run on it is 404, but the card shows it).
- The grid log gathers in memory too (a restart within 2.5–15 s drops those lines, not the edits).
