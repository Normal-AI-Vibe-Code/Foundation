# The grid behind the grid: evidence (2026-11-26, SPEC §0.23)

Taken by `apps/client/e2e/trail.spec.ts` and `council.spec.ts` on the e2e server. T3 here is the stand-in (`apps/server/test/t3-standin.mjs`, `T3_STANDIN_WORK`), and the council runs on the scripted runtime. No model ran and nothing was spent.

| File | What it shows |
|---|---|
| `01_thinking-expanded-council-day.png` | A council agent (Mica) after its run. **Expand ⤢** on its thinking module opened the map, following it: Supply, written with a check; its run card with its plan and last steps; its chain under Supply (the ask, then each thought, the plan, and every tool with what it was given and answered). |
| `02_two-t3-agents-one-section-day.png` | Two of T3's agents (Claude, Claude 2) asked in Depot at once. Depot is outlined *Two at once*. Each agent's folder shows `src/prices.ts` and `data/suppliers.csv`, and each run card shows its last four steps with their times (the failed read in red). |
| `03_following-claude-chain-day.png` | Claude followed: Claude 2 dims, and Claude's chain hangs under Depot. The `concurrent_work` answer reads "1 other agent is working on …". The failed read shows *Failed: no card*. |
| `04_following-claude-2-night.png` | The same at night. |
| `05_design-day.png`, `05_design-night.png` | `#/design` → The council → *Behind the grid*: wires between sections, a shared section, a finished agent, and a T3 agent's plan, reasoning and folder. |

The API check is in the same spec. Kai, a member who didn't ask, gets both lanes with steps but no arguments, answers or reasoning. A board he can't see is a 404.
