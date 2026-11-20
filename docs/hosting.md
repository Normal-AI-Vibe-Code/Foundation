# Hosting Foundation for the company

One Foundation server that everyone signs in to: the same boards, the same ChatForm, from the desktop app or a browser. This is how company-wide chat works (Josh, 2026-11-20: Foundation's own server, hosted; not Mattermost, and not Tailscale as the way in).

Built and checked on 2026-11-20 against a local copy of this exact setup with a stand-in Google (`docs/evidence/2026-11-20_hosted/`). **It has not met a real domain, a real certificate or a real Google client yet**: those are the three things below that only a person can bring.

## What you get

```
people's browsers ──┐
desktop apps ───────┼──▶ https://foundation.<company>  (Caddy: the certificate)
agents (/mcp) ──────┘            │
                                 ▼
                         foundation  (one container: the server + the web client, :4410)
                                 │
                         volume `data`  → /foundation/data  (SQLite, the file archive, secret.key)
                         volume `backups` ← nightly copy (backup service)
```

- **One program at one address.** The server serves the web client itself (`FOUNDATION_CLIENT_DIR`), so pages and API are one origin and the sign-in cookie is same-origin.
- **Sign-in is Google, with Foundation's own Google client.** Flowform's sign-in only returns to a loopback address, so a hosted server can't use it; with `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` set, every Google button (browser and desktop app, old releases included) goes to Google and comes back to `https://<address>/auth/google/callback`.
- **Who may join** is `FOUNDATION_ALLOWLIST` (emails or `@domains`), checked against the address Google verified. Anyone else gets a page that says so and no session. A person new to the server arrives as a **member**; the addresses in `FOUNDATION_ADMIN_EMAILS` arrive as **admins**.
- **The desktop app** signs in the same way it does on a local server: it shows a code, opens Google in the system browser, the browser shows the same code and asks *This is me*, and only then does the app get its session (a bearer it keeps itself; never a cookie, never in a URL).

## What a person brings

1. **A machine and a name.** A small Linux VM (2 vCPU, 4 GB, 40 GB disk is plenty to start) with Docker, reachable on ports 80 and 443, and a DNS name pointed at it (for example `foundation.formindustries.co`). Or an always-on office computer with no open ports and a Cloudflare Tunnel (below).
2. **A Google OAuth client.** Google Cloud console, in the company's Workspace organisation:
   - *APIs & Services → OAuth consent screen*: user type **Internal** (only the company's Workspace accounts can use it), app name *Foundation*.
   - *Credentials → Create credentials → OAuth client ID*: type **Web application**; authorized redirect URI `https://<address>/auth/google/callback`.
   - Copy the client ID and secret into `deploy/.env`. The secret lives only there.
   - People in a second Workspace (another domain) can't use an Internal client: either make the consent screen External (the allowlist is still the fence) or keep to one organisation.
3. **The allowlist and the admins**, in `deploy/.env`.

## Start it

On the machine, in a checkout of this repo:

```sh
cp deploy/foundation.env.example deploy/.env      # then fill it in (it is never committed)
docker compose -f deploy/compose.yml up -d --build
docker compose -f deploy/compose.yml logs -f foundation
```

The server's first lines say its address, `sign-in  Google`, and where the web client is. If it says `sign-in  NOT SET UP for this address`, the Google client is missing. Open `https://<address>`: the first person on `FOUNDATION_ADMIN_EMAILS` to sign in is an admin.

To update: `git pull`, then the same `up -d --build`. The data volume is untouched.

**No open ports (a tunnel instead of Caddy).** Create a Cloudflare Tunnel for the name, set its public hostname's service to `http://foundation:4410`, put its token in `deploy/.env` as `CLOUDFLARE_TUNNEL_TOKEN`, and start `docker compose -f deploy/compose.yml --profile tunnel up -d --build foundation backup cloudflared`. Cloudflare holds the certificate. Uploads over 100 MB don't pass a free tunnel.

## Everyone else

- **Desktop (Windows):** install from <https://github.com/joshleong/Foundation/releases/latest> (`Foundation_<version>_x64-setup.exe`). On the sign-in page press **Server ·** at the bottom, enter `https://<address>`, then **Continue with Google**. The app remembers the server and updates itself from then on.
- **Any browser (Mac, Linux, phones):** open `https://<address>`. There is no Mac or Linux installer yet.
- **Agents** (Claude Code, Codex, Vision): `https://<address>/mcp?board=company` with a token a person makes in Settings.

## Settings

All in `deploy/.env` (`deploy/foundation.env.example` lists them with what each is for):

| Setting | What it is |
|---|---|
| `FOUNDATION_DOMAIN` | The name, without `https://`. The compose file sets `FOUNDATION_PUBLIC_URL=https://<it>` from it |
| `FOUNDATION_ALLOWLIST` | Who may sign in |
| `FOUNDATION_ADMIN_EMAILS` | Who arrives as an admin |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Foundation's own Google client |
| `ANTHROPIC_API_KEY` | Agent turns on the hosted server (there is no signed-in Claude Code on it). Each turn spends credits, and each starts from a person |
| `FOUNDATION_ICE_SERVERS` | A TURN server for huddles across strict networks (huddles connect browsers directly; STUN only by default) |
| `FOUNDATION_SERVICE_TOKEN` | A bearer for other services (32+ characters) |
| `FOUNDATION_MIN_CLIENT` | The oldest desktop release the server still works with, once that release is published |
| `FOUNDATION_BACKUP_KEEP` | Nightly database copies kept (default 14) |

The image sets the rest: `FOUNDATION_HOST=0.0.0.0`, `FOUNDATION_ROOT=/foundation`, `FOUNDATION_CLIENT_DIR=/app/client`. The server answers only to its own name (`FOUNDATION_PUBLIC_URL`'s host; add others with `FOUNDATION_HOSTS`), and admits the desktop app's window as a caller because it is hosted. **Never set `FOUNDATION_DEV_LOGIN` on a hosted server.**

## Backups and restore

The `backup` service copies, a minute after start and then every 24 hours (`scripts/hosted-backup.mjs`):

- `backups:/db/<date_time>/foundation.db`: the database as one consistent file (`vacuum into`, integrity-checked), with `secret.key` beside it when there is one. The newest 14 are kept.
- `backups:/files/`: the file archive. Files are named by their content, so each is copied once; nothing is ever removed from it.

A backup holds `secret.key` and the tokens it unseals: keep it as private as the server. **The backups volume is on the same disk as the data until you move it**: copy it off the machine (a bucket, another disk) or it protects against mistakes, not against losing the machine.

Take one now: `docker compose -f deploy/compose.yml exec backup node /app/backup.mjs`

Restore (the server stopped, so nothing writes meanwhile):

```sh
docker compose -f deploy/compose.yml stop foundation
docker compose -f deploy/compose.yml run --rm --user root -v foundation_backups:/backups:ro foundation sh -c '
  cp /backups/db/<date_time>/foundation.db /foundation/data/foundation.db &&
  rm -f /foundation/data/foundation.db-wal /foundation/data/foundation.db-shm &&
  ( [ ! -f /backups/db/<date_time>/secret.key ] || cp /backups/db/<date_time>/secret.key /foundation/data/secret.key ) &&
  mkdir -p /foundation/data/files && cp -rn /backups/files/. /foundation/data/files/ &&
  chown -R node:node /foundation/data'
docker compose -f deploy/compose.yml start foundation
```

Checked 2026-11-20: the backup ran in the stack and its copy passed SQLite's integrity check. **The restore commands above have not been run end to end.**

**Moving a computer's Foundation to the hosted one.** The same shape as a restore: a `vacuum into` copy of that computer's `data/foundation.db`, its `data/files/` and `data/secret.key`, into the data volume before the first start. People are matched by email, so someone who signed in there with the address Google gives them is the same person on the hosted server.

## What a hosted server doesn't do (yet)

These run on the server's own computer, which here is the hosted machine, not anyone's desk:

- **Machines (Kiri, Docker), local VMs, the desktop in a section:** the container has no container engine, so the cards say none is available.
- **The built-in browser and the built-in terminal:** admin-only and a person's press, as everywhere; on a hosted server they would act inside the container. Leave them alone there.
- **Vision Code hand-offs and T3 threads:** they need Vision on the same computer (plan: *vision-pairing*).
- **The crew on a Claude subscription:** there is no signed-in `claude` in the image; agent turns need `ANTHROPIC_API_KEY`.
- **Huddles across networks** need a TURN server (`FOUNDATION_ICE_SERVERS`).
- **ChatForm's bridges** (mail, WhatsApp, Instagram, WeChat) need exactly this: a public HTTPS address. Their redirect and webhook addresses become `https://<address>/api/chat/bridges/gmail/callback` and `https://<address>/api/chat/hooks/<service>`; the Gmail bridge can use the same Google Cloud project (plan: *chatform-bridge-keys*).

What machines and the built-in browser should do on a hosted server (who may start what, on whose hardware) is a decision still to make (plan: *hosted-local-features*).

## Checking a change to this setup

`docs/evidence/2026-11-20_hosted/` holds the check: `compose.check.yml` runs this compose file at `https://foundation.localhost` with a local certificate and a stand-in Google (`standin-google.mjs`), and `check.mjs` drives two people through it in real browsers (a browser sign-in, the desktop app's page with its code and press, someone off the allowlist, one board, ChatForm, a dropped connection). The server's side is tested in `apps/server/test/hosted-signin.test.ts`.
