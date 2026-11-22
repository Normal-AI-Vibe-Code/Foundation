# ChatForm's server, in Rust, on Vercel

Josh, 2026-11-21: *"Host it on vercel for now. build a rust based server there."* This is ChatForm's server until it
moves to HyperForm: accounts, channels, direct messages, messages and threads, reactions, read marks, search and the
live socket, on Postgres. Its routes and JSON are the Node server's (`apps/server/src/chat.ts`), so ChatForm's client
can talk to either. Grids, agents, huddles, bridges and the Slack import stay on Foundation's own server.

## What it is

```
browsers / the Foundation app ──▶ https://<project>.vercel.app   (vercel.json: every path → api/chatform.rs)
                                        │  one axum app on Vercel's Rust runtime (beta), Fluid compute
                                        ├─ HTTP: /auth/*, /api/chat/*, /api/me, /api/ws-ticket, /api/health
                                        ├─ socket: /chat (Vercel WebSockets, beta)
                                        ▼
                                  Postgres (Neon, from the Vercel Marketplace)
                                        └─ LISTEN/NOTIFY: an event written on one instance reaches every instance's sockets
```

- **A socket lives on one instance and closes at the function's time limit** (300 s on Hobby; up to 800 s on Pro,
  set by `maxDuration`). ChatForm's client reconnects and catches up, as after any drop.
- **Live across instances** goes through Postgres `LISTEN/NOTIFY` on a direct connection (`DATABASE_URL_UNPOOLED`;
  Neon's pooled address can't hold a LISTEN). No Redis or other service.
- **Accounts**: Google, with the company's own OAuth client; who may join is `CHATFORM_ALLOWLIST`. Sessions are random
  tokens stored only as SHA-256 hashes, in an HttpOnly cookie for a browser or as a bearer for an app, never in a URL
  (a socket from another origin takes a one-time 30-second ticket). A write or socket signed in by the cookie must come
  from an allowed origin.

## Deploy it (what a person does)

I can't sign in to Vercel, Google or Neon for you; these are the steps, about fifteen minutes.

1. **Vercel project.** <https://vercel.com/new> → import `joshleong/Foundation` → **Root Directory** `apps/chatserver`
   → Framework Preset *Other*. (Or, from a terminal in `apps/chatserver`: `npx vercel login`, then `npx vercel link`.)
2. **Postgres.** In the project: *Storage* → *Create Database* → **Neon** (free plan is plenty) → connect it to the
   project. That sets `DATABASE_URL` and `DATABASE_URL_UNPOOLED`.
3. **Google sign-in.** Google Cloud console, in the company's Workspace: *OAuth consent screen* → **Internal**;
   *Credentials* → *OAuth client ID* → **Web application**, authorized redirect URI
   `https://<project>.vercel.app/auth/google/callback`. A second Workspace (formindustries.co and normallab.co are two)
   can't use an Internal client: make it **External** and let the allowlist be the fence.
4. **Settings** (*Project → Settings → Environment Variables*):

   | Name | Value |
   |---|---|
   | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | from step 3 |
   | `CHATFORM_ALLOWLIST` | `@formindustries.co,@normallab.co` |
   | `CHATFORM_ADMIN_EMAILS` | the admins' addresses, comma-separated |
   | `CHATFORM_PUBLIC_URL` | `https://<project>.vercel.app` (or your own domain); defaults to the production URL Vercel gives |
   | `CHATFORM_CORS_ORIGINS` | `http://localhost:31440` (the Foundation app's window), plus any page that calls it |

5. **Deploy** (a push to `main`, or *Redeploy*). Open `https://<project>.vercel.app/api/health`: `"database": true`
   and `"listening": true` mean it's up. Then `https://<project>.vercel.app` → *Sign in with Google*.

## Run it here

```sh
docker run -d --name chatform-pg -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=chatform -p 127.0.0.1:15432:5432 postgres:17-alpine
DATABASE_URL=postgres://postgres@127.0.0.1:15432/chatform CHATFORM_DEV_LOGIN=1 CHATFORM_ALLOWLIST=@formindustries.co cargo run
cargo test          # unit tests, and the end-to-end ones against that Postgres (they skip without one)
```

Dev login (`POST /auth/dev`, email alone) answers only with `CHATFORM_DEV_LOGIN=1`, only from this computer, and never
on Vercel.

## Not built yet

- **ChatForm in the Foundation app doesn't point here yet**: it talks to the Foundation server it's signed in to. The
  next step is a "chat server" setting and an app sign-in (a code the app shows, Google in the system browser, a
  bearer back), as the hosted Foundation does.
- Files in messages, pins, starring and notify settings, channel topics after creation, archiving, typing in threads,
  link previews, agents, huddles, portals and bridges, the Slack import: Foundation's own server only.
- It has run only here (Windows, and a Linux build in Docker) against a local Postgres; not yet on Vercel, Neon or a
  real Google client.
