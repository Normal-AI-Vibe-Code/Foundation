# ChatForm's server, in Rust, on Vercel

Josh, 2026-11-21: *"Host it on vercel for now. build a rust based server there."* This is ChatForm's server until it
moves to HyperForm: accounts, channels, direct messages, messages and threads, files in messages, link previews,
reactions, pins, read marks, search, the mentions list, who is on which grid, and the live socket, on Postgres. Its
routes and JSON are the Node server's (`apps/server/src/chat.ts`), so ChatForm's client can talk to either. Grids,
agents, huddles, bridges and the Slack import stay on Foundation's own server.

## What it is

```
browsers / the Foundation app ──▶ https://<project>.vercel.app   (vercel.json: every path → api/chatform.rs)
                                        │  one axum app on Vercel's Rust runtime (beta), Fluid compute
                                        ├─ HTTP: /auth/*, /api/chat/*, /api/files, /files/:id, /api/whereabouts, /api/me, /api/ws-ticket, /api/health
                                        ├─ socket: /chat (Vercel WebSockets, beta)
                                        ▼
                                  Postgres (Neon, from the Vercel Marketplace)
                                        ├─ LISTEN/NOTIFY: an event written on one instance reaches every instance's sockets
                                        └─ uploaded files' bytes too (a function has no disk)
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
   project. That sets `DATABASE_URL` and `DATABASE_URL_UNPOOLED`. If it was connected with a prefix (the store's
   *Projects* tab shows it, e.g. `NEON_CHAT`, giving `NEON_CHAT_DATABASE_URL`), set `CHATFORM_DATABASE_PREFIX` to that
   prefix: the values are secret, so they can't be copied to the plain names.
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
   | `CHATFORM_CORS_ORIGINS` | `http://localhost:31440` (the Foundation app's window), plus any page that calls it. Without it the app says it can't reach the server |
   | `CHATFORM_TRUSTED_CLIENT_IDS` | optional: the Google client id(s) of Foundation's own sign-in, comma-separated, so being signed in to Foundation signs ChatForm in (see *The sign-in exchange*) |
   | `CHATFORM_PREVIEWS` | optional: `0` turns link previews off |

5. **Deploy** (a push to `main`, or *Redeploy*). Open `https://<project>.vercel.app/api/health`: `"database": true`
   and `"listening": true` mean it's up. Then `https://<project>.vercel.app` → *Sign in with Google*.

6. **Point the app at it.** In Foundation: *Settings → General → ChatForm's server* → the address → **Use**. The window
   reloads; open ChatForm and press *Sign in with Google*. The app shows a code, Google opens in the browser, and the
   server's page shows the same code and asks *This is me*. (A build can name the server for everyone with
   `VITE_CHATFORM_SERVER`.)

## An app signs in

As Foundation's own desktop sign-in does, like a device (`src/app_signin.rs`):

- `POST /auth/app/begin` → `{ url, poll, code, expiresIn }`: Google's address for the system browser, a secret only the
  app holds, and a code of eight the app shows. Nobody is signed in by beginning.
- Google returns to `/auth/google/callback`. The person is checked as any sign-in is, then lands on this server's own
  page (no script, never framed): *an app is asking to sign in as you, this is its code*, **This is me** / **Not me**.
- `POST /auth/app/poll` (the secret as `Authorization: Bearer`) → `pending` until the press; after *This is me*,
  `{ status: "ok", user, session }` once. The app keeps `session` as its bearer. *Not me*, a refusal or five minutes end it.

`GET /auth/config` says `app` (an app can sign in), `exchange` (the sign-in exchange below is set up) and `features`
(what of ChatForm this server has: `channels`, `direct`, `threads`, `reactions`, `search`, `files`, `pins`,
`previews`, `mentions`, `where`); the app leaves the rest out.

## The sign-in exchange

So Foundation's own Google sign-in signs ChatForm in without a second round (`src/exchange.rs`):

- `POST /auth/exchange` with `{ "id_token": "<Google's ID token>" }` → `{ user, session }`; `session` is a bearer,
  exactly as the app sign-in's poll gives one.
- The token is checked as Google's word: its RS256 signature against Google's published keys (kept an hour), `iss`
  is accounts.google.com, `exp` hasn't passed, `aud` is this server's `GOOGLE_CLIENT_ID` or one of
  `CHATFORM_TRUSTED_CLIENT_IDS`, `email_verified` is true; then the allowlist and admin list, as any sign-in.
  Anything else is 401 with a sentence. About ten tries a minute per address (429 after). The token is never logged
  or kept. With no client id to trust the route answers 503 and `exchange` is false.
- The keys' address is Google's own, always, on Vercel; only a local run with dev login and
  `CHATFORM_GOOGLE_STANDIN` reads them from the stand-in (`<stand-in>/certs`).

## Files in messages

As the Node server's (`src/files.rs`):

- `POST /api/files?board=chat&name=<name>`, the raw bytes as the body and their type as `Content-Type` →
  `{ file: { id, name, mime, size, sha256, width, height, uploaded_by, created_at, url: "/files/<id>", … } }`.
  `width`/`height` are there for pictures (a sideways phone photo is turned), so a message can hold their place.
- A message is posted with `files: [ids]` (at most 12; words are optional when there is a file) and carries
  `files: [{ id, name, mime, size, w?, h? }]`.
- `GET /files/<id>` serves the bytes to whoever is signed in and may see them (a bearer or the cookie, as every
  route): `Cache-Control: private`, an ETag (304 when it matches), ranges for video, nosniff and a CSP sandbox. Only a
  fixed list of passive types (pictures, GIFs, video, audio, PDF, plain text, models) is shown in place; anything
  else is a download of opaque bytes.
- `?w=64|256|512|1024|2048` gives a JPEG, PNG or WebP scaled down to that width tier (JPEG, or PNG with alpha),
  made on first ask and kept in Postgres, with the Node server's `x-image-*` headers. A picture no wider than the
  tier, a GIF, or a picture over 64 megapixels (refused before decoding) is served as it is.
- **Kept in Postgres**, 4 MB a file (Vercel refuses a request over 4.5 MB): a bigger one is refused in words (413).
- **Who may open one**: its uploader, and anyone who can read a message, not removed, that carries it. Nobody else,
  admins included. **Archived, never deleted**: no route removes a file, and removing a message keeps its row and
  its files.

## Link previews

When a message is posted or its words change, its first three web links are read in the background for their social
tags (Open Graph, Twitter Card, the page's title and description) and kept on the message as `previews:
[{ url, title?, description?, image?, site }]`; a `message-changed` carries them to its readers. A link straight to a
picture or GIF (by its content type) becomes `{ url, image, site }`. The fetcher (`src/preview.rs`) never reaches a
private, loopback, link-local, CGNAT, multicast or metadata address: http and https only, ports 80 and 443 only,
the name resolved first and every address checked, the connection pinned to what was checked, redirects followed by
hand (three at most, each checked the same way), five seconds, 512 KB, no cookies, and a User-Agent that says only
`ChatForm link preview`.

## Pins and mentions

- `POST /api/chat/messages/<id>/pin` with `{ on }` (a member of the channel) → `{ message }`; the message's `pinned`
  and the channel's `pinned: [ids]` say so, and the channel gets a line, *Ada pinned a message.*
- `GET /api/chat/mentions?limit=<n≤100>&before=<ms>` → `{ mentions: [{ message, channel: { id, name, kind } }] }`,
  newest first: what others said that names this person where they can see it, `@channel` and `@here` where they are
  a member, and everything said to them in a direct message or group.

## Who is where

People on different computers each run their own Foundation server, so this is where they see each other
(`src/whereabouts.rs`):

- A window says which grid it has open on the chat socket: `{ t: "where", board: <id> | null, name: <the grid's
  title> | null }`, again whenever that changes (and after every reconnect: it is kept per socket).
- Everyone signed in gets `{ t: "where", rev, boards: { <id>: { people: [{ id, name, color }], agents: [], name? } } }`
  when the list changes (gathered for 400 ms), and `GET /api/whereabouts` → `{ boards }` says the same. A person is
  on a grid once however many windows, named and coloured by their account.
- A socket's row has a heartbeat from its instance (every 20 s) and stops counting after 60 s, so a dead instance's
  people fade within about a minute.

## Run it here

```sh
docker run -d --name chatform-pg -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=chatform -p 127.0.0.1:15432:5432 postgres:17-alpine
DATABASE_URL=postgres://postgres@127.0.0.1:15432/chatform CHATFORM_DEV_LOGIN=1 CHATFORM_ALLOWLIST=@formindustries.co cargo run
cargo test          # unit tests, and the end-to-end ones against that Postgres (they skip without one)
```

Three of the end-to-end tests need no Postgres and always run: the preview fetcher against a stand-in site, the
exchange's refusals against a stand-in Google's keys, and that every route is there and answers only the signed in.

Dev login (`POST /auth/dev`, email alone) answers only with `CHATFORM_DEV_LOGIN=1`, only from this computer, and never
on Vercel.

## Not built yet

- Starring and notify settings, channel topics after creation, archiving, exporting a channel, the threads list,
  agents (and their mentions), huddles, portals and bridges, the Slack import: Foundation's own server only.
- Files: nothing over 4 MB (so most video is out until files move to object storage); no text is read out of
  documents for search; CAD summaries and grid files stay on Foundation's own server. Width tiers are made on the
  function itself, and a very large picture's first tier takes a moment and memory.
- Link previews are read in a task that outlives the request. Vercel may pause an instance once it has answered and
  holds no socket, and then a card arrives late or not at all; nothing retries it.
- Who is where shows people only (agents work on Foundation's own server), and every signed-in person sees every
  grid that a window names: there is no per-grid membership here.
- The 2026-11-25 additions (files, previews, pins, mentions, the exchange, who is where) were written with their
  end-to-end tests, but on the day only the unit tests and the three tests that need no Postgres were run: Docker
  would not start on the build machine. Run the whole of the suite against a Postgres before relying on them, and
  none of it has run on Vercel or against Google's real keys.
- The app sign-in is tested against a stand-in Google (`tests/flow.rs`; a local run with dev login can name one
  with `CHATFORM_GOOGLE_STANDIN`, which Vercel never reads).
- While the app's ChatForm is here, its Agents, Inbox and Huddles tabs are hidden.
