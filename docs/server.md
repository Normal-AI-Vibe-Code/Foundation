# Foundation's server: which one, where, and on the network

There is no Mattermost (or any other) chat server. ChatForm, the grids, files, huddles' signalling, search and
the agents are all served by **Foundation's own server** (`apps/server`, Node + SQLite). Which one you are on
is said in the server panel (the small pill right of **Settings** in the side menu's foot) and in ChatForm's
strip ("on this computer · localhost:4410"; press it for the panel). `GET /api/server` says the same to programs.

## Which server is which

| Server | Started by | Address | Data |
|---|---|---|---|
| **This computer, from a checkout** | `npm run dev` (server :4410, page :1430), or the desktop app's switch → *From a checkout* | `http://localhost:4410` | `<checkout>/data/foundation.db` (`FOUNDATION_DATA_DIR`) |
| **This computer, built in to the app** | the desktop app's switch → *Built in* (a bundled server and Node; `scripts/desktop-server.mjs`) | `http://localhost:4410`; the app's page is `http://localhost:31440` (bearer) | the app's own folder (`%APPDATA%\co.normallab.foundation`) |
| **Another computer on your network** | one of the above, with **On your network** switched on there | `http://192.168.x.y:4410`, `http://NAME.local:4410` | on that computer |
| **On the rack** (later) | a service on the rack machine (recipe below) | `https://foundation.example.com` | on the rack, backed up |

Off the switch, a server listens on `127.0.0.1` only and answers only to `localhost`/`127.0.0.1`/`[::1]`.

## On your network (the office LAN, for trying it)

At the server's computer, an admin opens the server panel → **On your network** and turns the switch on.
It takes effect at once (no restart) and is kept across restarts; turning it off closes the network
listeners and drops their connections. It is recorded in the audit log.

- **Listening.** The server keeps its loopback listener and adds one per private LAN address of this
  computer (10/8, 172.16/12, 192.168/16; not Hyper-V, WSL, Docker or VM adapters; never `0.0.0.0`), same
  port. `FOUNDATION_LAN_ADDRESSES=192.168.1.20` picks which; `FOUNDATION_NETWORK=1|0` fixes the switch.
- **Names.** It answers to those addresses and to this computer's name (`NAME`, `NAME.local`), each with the
  port, and nothing else: DNS rebinding stays refused (`origins.ts`).
- **The page.** Asked by one of those names, the server serves the built client from `apps/client/dist`
  (`npm run build`; or **Build the page** in the panel, an admin's press at that computer) at `/`, same
  origin, so the sign-in cookie works without CORS. Not on `localhost` (there a machine's relayed port,
  `/m/…`, shares the server's origin, so that origin is never trusted with the cookie); for the same reason
  `/m/` is refused on the network names. The desktop app's built-in server carries no page: teammates use
  the Foundation app pointed at the address, or a checkout builds the page.
- **Signing in from another computer: an invitation.** Google sign-in goes through Flowform, which only
  returns to a loopback address (`http://localhost:<port>`), so it can't finish on a teammate's computer.
  An admin at the server's computer presses **Invite**, with the teammate's name and work email (on
  `FOUNDATION_ALLOWLIST`; never an admin's). They get a link (`http://<address>/#/join/<code>`, the code in
  the fragment, which browsers never send) and a short code to type with their email on the sign-in page.
  Once, within 15 minutes, only from another computer on a private network, rate-limited; stored hashed;
  audit-logged when made and when used. It signs that browser in as that person with their own role (a
  member, for someone new) for a week. The panel lists who is signed in from other computers (person,
  browser, address, since) with **Sign out** per row, which ends the session and drops its sockets.
- **The Foundation app on a teammate's computer** can instead point its **Server** line (sign-in page) at
  `http://192.168.x.y:4410`: it uses a bearer, and the sign-in page offers **I have an invitation**. Its
  page is `http://localhost:31440`, a secure context, so huddles' camera and microphone work there.
- **Plain http.** Anyone on the network who can watch traffic could read it. Fine for trying it in the
  office; the rack server should have HTTPS.
- **Huddles in a browser.** Chrome, Edge and Safari offer the camera and microphone only to secure pages
  (https, or `localhost`). At `http://192.168.x.y:4410` a browser can't send video or sound. Use the app
  (above), or HTTPS on the rack.
- **Windows.** The first time a Node program listens on a network address, Windows may ask whether to allow
  it on private (and public) networks: the person at that computer presses **Allow** for private networks.
  If the network is marked *Public* in Windows, inbound connections are refused unless a rule allows Node
  there. The panel's "it answers at …" proves the listener is up from that computer, not that the firewall
  lets others in: try the address from a phone or another computer on the same Wi-Fi.

### This computer only

Whatever the switch, these answer only a request from the server's own computer (a loopback peer, asked by a
loopback name, with no proxy's forwarding headers; `X-Forwarded-For` is never trusted for anything else):

| Door | Why |
|---|---|
| The built-in terminal and browser (routes and sockets) | a shell and a browser with someone's sign-ins on this computer |
| Places (approved folders), attaching from a place | this computer's files |
| This server's settings: the switch, invitations, who's signed in, Build the page | admin of the server itself |
| A bridge's credentials (`POST /api/chat/bridges/:service`) | secrets for outside services |
| T3 on this computer: start, stop, add or turn on agents, local models, open | runs programs here |
| Machines and clusters: start, stop, exec, desktops, functions, pods, load, share; a kubeconfig; a machine's terminal and desktop sockets | runs code here |
| Running a job | runs code or Claude Code here |
| Saving or probing an app, allowing an app's tool | the server fetches and calls an address |
| Making an agent token | a week-long credential |
| Syncing the plan with GitHub | runs `gh` with the server's token |
| Spending credits on a character | spends money |
| A machine's relayed port (`/m/…`) on a network name | it would share the page's origin |

Teammates get ChatForm, grids, files, huddles' signalling, search and agents as usual.

## The rack (later)

1. Install Node 22.16+ and a Foundation checkout (or the desktop build's bundled server) on the rack machine.
2. Environment: `FOUNDATION_HOST=127.0.0.1` behind a reverse proxy (recommended) and
   `FOUNDATION_PUBLIC_URL=https://foundation.example.com`, `FOUNDATION_HOSTS=foundation.example.com`,
   `FOUNDATION_DATA_DIR=/srv/foundation/data`, `FOUNDATION_ALLOWLIST`, `FOUNDATION_ADMIN_EMAILS`. Never
   `FOUNDATION_DEV_LOGIN`.
3. HTTPS in front (Caddy or nginx with a certificate). The proxy must send `X-Forwarded-For` (Caddy does;
   nginx needs `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`), or set
   `FOUNDATION_BEHIND_PROXY=1`, so that nothing from outside counts as "this computer".
4. Google sign-in: Flowform's allow-list must accept the rack's address as a return address (SPEC §6 #2), or
   give the server its own Google client (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, redirect
   `https://foundation.example.com/auth/google/callback`).
5. The page: serve `apps/client/dist` from the proxy at the same origin, or point everyone's app at the address
   (Server line on the sign-in page).
6. Backups: `data/` (the SQLite file and `files/`) nightly; `data/secret.key` with them, kept apart.
