# The Vision loop (Phase 2, 2026-11-03)

A brief on the board becomes a Vision Code (T3) thread. What the thread makes comes back as cards beside the brief, and the reviewers are asked then. CAD cards show the part.

**Starting a thread** (`apps/server/src/vision.ts`), the pattern T3's own `project` CLI uses:
1. Mint a short-lived session (`t3 auth session issue --ttl 10m --label "Foundation hand-off" --json`).
2. Use it as the bearer on T3's `/ws`: `orchestration.subscribeShell` to find the "Foundation hand-offs" project (or `project.create` it), then `orchestration.dispatchCommand` `thread.turn.start`, the same command Vision's `code/handoff.ts` sends.
3. Revoke the session. Nothing is stored.

A thread runs a model on the person's plan, so `vision_brief` (and the pipeline's Concept/Simulate hand-offs) write the brief and a **hand-off card**, and a person presses **Run**. Threads start **Supervised** (approval-required), so anything that changes files asks first in Vision Code.

**Coming back.** Each hand-off has a folder (`data/handoffs/<slug>/BRIEF.md`, `exports/`). The thread is told to put its deliverables in `exports/`. The server watches running hand-offs every 4 s:
- New files are archived (searchable, never deleted) and placed beside the brief: images as image cards, everything else as file cards.
- When the thread has settled with something to show, each reviewer is asked, once.

**Checked:**
- `apps/server/test/vision.test.ts` (3), against a stand-in T3:
  - a fake `t3` CLI records the mint and revoke;
  - a fake `/ws` speaks the RPC;
  - checks that the brief waits for Run and nobody is asked; that Run uses a labelled 10-minute session as the bearer and revokes it; that the project is made once; that the thread starts approval-required with the brief and the exports path;
  - checks that the render, REPORT.md and STEP come back as cards (the render keeps its shape); that nobody is asked while the thread runs, the reviewer is asked once when it settles, and the hand-off is then done.
- **One real hand-off to Vision Code on :3783**, through Foundation's own code on a scratch data folder. It started thread `Foundation · Hand-off check` in a new project "Foundation hand-offs". Vision Code read BRIEF.md and asked for approval to write `exports/REPORT.md` (status *waiting*, 1 pending). The session was revoked: T3 lists the same 2 sessions as before. That project points at a scratch folder; remove it in Vision Code when you like.
- `e2e/vision.spec.ts`: the brief and its hand-off card on the board (handoff-waiting). Run stays clear of the card's hover bar, which used to cover it. With no Vision Code, Run says why on the card (handoff-no-vision-code). The e2e server is pointed away from the real Vision Code.
- `e2e/cad.spec.ts`: CAD cards show the part. Vision's own vane-board STEP is read by OpenCascade (`occt-import-js` 0.0.23, as Vision's ModelForm reads it): 150 × 54 × 40 mm, 2,184 triangles. An STL block shows too. Each renders once to a still and turns when dragged, one live viewer at a time. Shown day and night (cad-dark, cad-light, cad-turned). The STEP is read from the Vision repo on this machine and not copied into this public repo; the check skips it if it's absent.

**Fixed on the way:** a file dropped on the board never started its preview. The on-screen observer was set up on the upload bar's first render, when there was nothing to watch. This was latent for text and PDF previews too.

**Not done:**
- An export landing from a real thread: the real check stopped at Vision Code's approval prompt, which is yours to answer.
- Vision's review tools returning a verdict on their own: reviews come back as asks to people.
