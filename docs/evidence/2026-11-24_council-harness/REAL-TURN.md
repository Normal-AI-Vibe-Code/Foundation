# Two real claude-account turns, 2026-11-24

What ran: this worktree's server (`node --import tsx src/index.ts`, port 16411, an empty data folder, dev sign-in as ada@example.test), Claude Code 2.1.331 on this computer's Claude plan (Opus 5.5), started once with `FOUNDATION_AGENT_TOOLS=all` and once with `=code`. Each time, a section was seeded with a 1,009-character note, “Field report”, and a two-row table. Then one `POST /api/agent`: “In the “Notes A/B” section: read the long note “Field report” in full, then add a table in that section that lists its three main points, and say what you did.” The SSE events and the board's awareness (read over `/sync/company`) are in `real-turn-all.jsonl` and `real-turn-code.jsonl`, with bearers scrubbed.

| | all | code |
|---|---|---|
| finished | yes, 11.6 s | yes, 14.3 s |
| tool calls | 3: read_card, add_table, focus | 4: read_card, search_tools, run_code (1 inner add_table), bring_view |
| `done` usage | input 8, output 928 | input 8, output 1,124 |
| `thinking` events | none (the model didn't reason visibly this turn) | yes, 18 summarised pieces, after its last step |
| awareness | doing: thinking → read card → making table → the focus note → done; `plan` null (no set_plan); `thought` null | doing: thinking → read card → search tools → run code → making table → showing Ada … → done; `plan` null; `thought` showed its last 200 chars, then cleared at the end |
| result | “Field report · main points”, 3 correct rows (cracks at the fillet → 1.5 mm; plate lead time 3 → 6 weeks; torque sensor drift 4 % → recalibrate) | the same table, the same correct rows; it also said one next step was its own guess |

Both were correct. Code mode cost an extra round trip (search_tools) and about 20 % more output for a one-write ask, so the default stays `all`. Code mode is for asks with many steps.
