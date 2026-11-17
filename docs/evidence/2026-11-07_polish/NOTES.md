# Polish, overnight 2026-11-07

Cards from the plan board's Next column, each checked in a browser. Headless Chromium (Playwright) unless noted; the in-app browser pane was hidden, which freezes CSS animation there, so fades were measured headless. Agents ran on the `script` runtime (`FOUNDATION_AGENT_SCRIPT=1`): no model was spent.

| # | What | How it was checked |
|---|---|---|
| 01 | A person's table added into an app section shows beside the app (the app becomes a card) | ⊞ on the hosted Foundation section; `test/hosting.test.ts` (7) |
| 02 | Wires between sections that step back for an expanded one fade with them | Expanding Foundation: 5 of 7 wires 1 → 0.12 over ~280 ms, its own 2 stayed; Esc restored all |
| — | The gap + buttons ignore double-clicks | A double-click on a + added nothing and zoomed 105 → 160 %; a single press armed it and added the 10th section |
| 03–04 | Stop all | Two of Ada's agents → "2 of yours at work · Stop all" → both stopped, toast "Stopped all 2 of your agents" |
| — | Keys typed right after a tap of Space go to the sheet | 5 rounds of Space then "a plan" with no wait: the field read "a plan" each time, the agent layer never toggled |
| 05 | Notes and tables say which agent made them | A crew run's Parts table and note both show "✦ Mistral" |
| 06 | The sheet lists a finished ask | Reopened sheet: "Mistral done · Make a section called Supply… Open" |
| 07 | The side pane opened beside a session narrows the session | 1100 px window: session 460 → 388, grid kept 440 |
| 08 | Follow an agent | Zoomed out at 26 %, the view followed the agent through four targets; a wheel or drag on the grid ended it |
| 09 | A connector shown as a card names itself | 1 of 6 connectors un-hosted, and only it shows its name |
| 10 | Agents point at a cell | The laser's centre sat on D5 (52.62) |
| — | The mic meter never asks twice | Fake device: not yet allowed → 0 getUserMedia calls; allowed → 1, live bars |
| — | Framing a section keeps its tools in view | F on four sections at 1440×900: tools' right edge 1,561–1,841 px before, 1,002–1,304 after |

The full e2e suite on this branch: 29 of 30 pass; the perf trace's pan p95 (50 ms vs 34) failed here and failed the same way on `origin/main`, so it's this machine (software WebGL, other sessions running), not a regression. One 267 ms pan frame showed on the branch vs 67 ms on main, once.
