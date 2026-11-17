# ws-ticket: a header-capable sync transport (2026-11-08)

Plan card `ws-ticket` (issue 74). The packaged app's page is
http://localhost:31440, so a Foundation server anywhere else is cross-site and
its `SameSite=Lax` cookie never arrives. Now the client picks a transport:

- **cookie**: the page and the server are one origin (the web app, `npm run dev`). Unchanged.
- **bearer**: the server is another origin. `/auth/dev` (`{ bearer: true }`) and
  `/auth/flowform/poll?bearer=1` return an `app` session in the body instead of
  setting the cookie. The client keeps it in localStorage under the server's
  origin and sends it only as `Authorization: Bearer`. Sockets (sync, huddle,
  machine terminal) first `POST /api/ws-ticket { path }` and open
  `path?…&ticket=…`. SSE (`/api/connectors/events`) is read with fetch, not
  EventSource. Files shown in elements are fetched with the header and shown
  from `blob:` URLs (`lib/fileSrc.ts`).

A ticket (`apps/server/src/sockets.ts`, table `ws_tickets`): 32 random bytes,
only its sha256 kept, 30 s, deleted as it's read, valid only for the exact
socket path it was issued for, and only while its session is live. HTTP routes
never read it. Sessions now have a `kind`: `browser`, `app`, `agent`.
`requirePerson` (starting machines, moving plan cards) accepts the cookie or an
`app` bearer, never an `agent` bearer or the service token.

## How it was checked

**Server tests** (`apps/server/test/tickets.test.ts`, 11 checks, the server's
own upgrade handler on a real port with real `ws` sockets): issue → open → the
write lands; a second use is refused (401); expired after 30 s (clock moved);
another board, a huddle or a terminal path is refused and the try burns the
ticket; a bad ticket beside a good cookie is refused; tickets only for socket
paths of boards you can see, never for the service token; a ticket dies with
its session; a viewer's ticketed socket gets the board but its update is
dropped; a ticket is never a session (bearer, cookie, or `?ticket=` on HTTP);
every upgrade URL the server saw carries only `epoch`, `ticket`, `send` and no
minted session token; the app bearer is a person, an agent bearer isn't; and
the client source puts the bearer only in an Authorization header.
`npm test` (client 69, server 121: 115 pass, 6 skipped as before) and
`npm run typecheck` green.

**Browser, two origins** (Claude's browser pane, `?rafshim`):
server `FOUNDATION_PORT=16410` on http://127.0.0.1:16410 with its own data
dir; client `vite` on http://localhost:16430 with
`VITE_FOUNDATION_SERVER=http://127.0.0.1:16410` (no proxy in the path: every
call is cross-origin).

1. Dev login as Ada: `/auth/dev` preflighted and 200; `document.cookie` empty;
   localStorage holds `foundation-bearer:http://127.0.0.1:16410`.
2. Network: `OPTIONS` + `POST /api/ws-ticket` before the socket; board status `live`.
3. Second tab, same device: `live`. Renamed a section in tab A through the
   store; tab B had the new name a moment later.
4. Killed the server (only the PID started here) and restarted it: tab A
   reconnected by itself with a **fresh** ticket
   (`ws://127.0.0.1:16410/sync/company?epoch=ep_…&ticket=…`); the bearer is in
   no socket URL. Renamed another section in tab B; tab A had it
   (`01_tab-a_live-after-restart.jpg`, `02_tab-b_same-board.jpg`).
5. Replaying that exact socket URL from the page: refused (close 1006). A
   socket with no credentials: refused.
6. Upload with the bearer → `/files/:id` with the bearer and a range: 206;
   without it: 401. `/api/connectors/events` with the bearer: 200
   `text/event-stream`. A file card added in tab A showed its image in both
   tabs from a `blob:` URL (`03_tab-b_file-card-via-bearer.jpg`).
7. Signed out (the app's `logout()`): the device's bearer is gone, and the old
   bearer then gets `/api/me` → `user: null` and `/api/ws-ticket` → 401.
8. The sign-in page shows **Server · 127.0.0.1:16410**; it opens to a field and
   **Use this server** (`04_sign-in_server-picker.png`).

**Cookie path**: `npm run e2e -w @foundation/client` (same origin through the
Vite proxy, so the cookie transport; ports 15430/15440/15450): 31 passed,
2 skipped, 1 failed: `perf.spec.ts` pan p95 50–66.7 ms against a 34 ms budget.
The same spec on an untouched `origin/main` checkout, run right after on this
machine, fails the same way (pan p95 50 ms), so it's this machine's headless
frame rate under load, not this change (nothing here touches rendering).

## Open

- Not run in the packaged exe against a hosted server (the browser run is the
  same code on two origins). Flowform Google sign-in on a hosted server still
  needs flowform's loopback rule widened (SPEC §6 #2); dev login was used here.
- The bearer sits in localStorage, readable by script on the app's page (the
  cookie is HttpOnly). The app's page runs only its own code.
- Files on another origin load as blobs: a video downloads whole before it plays.
- An existing desktop cookie session keeps working (requests carry it; sockets
  without a bearer use it); the next sign-in gets a bearer.
- The Server line isn't on `#/design` yet (it reuses `.login-or`, `.f-input`,
  `.f-pill`; no new CSS).
