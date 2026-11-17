# CLAUDE.md — Foundation

You're working on Foundation, the company brain of Form Industries: a shared grid for people, apps and agents. Josh directs.

Every session:
1. Read `SPEC.md` (status, hookups, known issues) and `DESIGN.md` (the visual contract). The plan is a kanban: `docs/plan.json`, mirrored to GitHub issues and shown in the app under Settings → Plan.
2. `npm install && npm test && npm run typecheck`. A red build is the session.
3. Take the top card in **Next** on the plan board (or a §7 issue that's worse); move it to Doing, then Review or Done when it's checked (`docs/plan.json`, then `npm run plan:push`).
4. UI: on tokens only (`packages/ui/src/tokens.css`), shown on `#/design` first, checked in day and night.
5. Verify in the browser (`npm run dev`, http://localhost:1430; `?rafshim` for hidden/headless panes) and capture evidence in `docs/evidence/<date>_<slice>/`. `npm run e2e -w @foundation/client` runs the real-browser checks (two people, sections moved and split, voice, layouts, the perf trace) on its own server and data. `PERF_GPU=1 … -- frames` holds every surface to 60 fps on this machine's GPU (add `E2E_BUILD=1` for the production build).
6. Update SPEC §3 status and §7 honestly, and the card's column on the board. Commit with what changed and how it was checked.

Invariants (tested in `apps/server/test`): one board schema (`packages/protocol`); writes name their board; `request_id` idempotency; deletes need `confirm`; uploaded files are archived, never deleted; session tokens are stored hashed and never travel in URLs; nothing that spends money or runs third-party code starts without a person; viewers can't write a board (socket, tools or HTTP).
