# 2026-11-09 · Panel edges, places, the Flowform link, and why nothing connected

Josh asked for four things: fix the fetch failures (Claude, agents, data sources), bring Flowform's files and boards in, let Foundation pull from approved files and places, and make the side panels end in a line (like an editor's panels) instead of a fade.

| File | What it shows |
|---|---|
| `01_search-pane-edge-night.jpg` | Search open: the cards stop at its hairline, cut clean. `clip-path: inset(44px 380px 0 0)`, no mask |
| `02_side-pane-edge-night.jpg` | The side pane the same way: `inset(44px 0 0 272px)` |
| `03_side-pane-edge-day.jpg` | Day. Dragging the hairline took the pane from 272 to 360 px (the clip followed), a double-click put it back |
| `04_services-flowform-row.jpg` | Settings → Services: the Flowform row, not connected, with **Connect Flowform** |
| `05_settings-places.jpg` | Settings → Places on a test server (its own data, :24430): the sample folder approved. Before it, the home folder, `C:\` and the temp folder were refused in the server's words |
| `06_this-computer-browser.jpg` | The search pane's **This computer** chip: the place's `fan` folder and `readme.md`. The `.env` beside them isn't listed |
| `07_dragged-onto-board.jpg` | `sketch.png` and `parts.csv` dragged from the place onto the board: an image card and a file card, both in the archive with where they came from |
| `sample-place/` | The folder that was approved (its `.env` is ignored by git, as it should be) |

## The fetch failures

- The system Node here is 22.13.1. Its SQLite has no FTS5, so the server died at boot (`no such module: fts5`), the launcher went with it, and every request the app made failed to fetch. The installed desktop app starts no server of its own, so it showed the same thing.
- On Node 22.22 the same checkout ran: `npm test` 100 + 156 pass (6 skipped, the Flowform fixtures), typecheck clean, an agent turn on the subscription answered (`run → crew → text → done`), `/api/agent/token` and the connectors answered.
- Now `npm run dev` on the old Node prints what's wrong and the fix, and exits 1, and the client says *Can't reach the Foundation server (host)…* instead of "Failed to fetch".

## The Flowform link

Found by asking the server, with no credentials: `/.well-known/oauth-protected-resource` (resource `…/mcp`, scopes `search:read canvas:read canvas:write code:read admin:write`), `/.well-known/oauth-authorization-server` (register, authorize, token, revoke; PKCE S256; public clients), and `POST /mcp` → 401 with `resource_metadata`. The installed Flowform client's binary also names its own routes (`/me/files`, `/rooms`, `/rooms/:id/assets`, `/connectors/google/accounts`); those take Flowform's session bearer, which Foundation revokes at sign-in.

`test/flowformlink.test.ts` (5) runs the whole hand-off against a stand-in. **It has not been approved against production**: that takes a person on Flowform's page.

## Checked with

`npm test` (client 100, server 162: 156 pass, 6 skipped), `npm run typecheck`, `node scripts/plan.mjs check`. Not re-run: the Playwright e2e suite and the GPU frames check.
