# Desktop updates, checked on a real install (2026-11-08, Windows 11)

The whole loop ran on this machine with `update-check.mjs` (in this folder), isolated from the installed Foundation: a check app named **Foundation Update Check** (its own identifier `co.normallab.foundation.updatecheck`, its own WebView2 profile, its page on :31441 via `FOUNDATION_DESKTOP_PORT`) was built twice from this branch, at 0.2.90 and 0.2.91, signed with Foundation's real updater key (`~/.tauri/foundation-updater.key`). Its feed pointed at a local server (`http://localhost:16999/latest.json`, `dangerousInsecureTransportProtocol` for the check only); release builds read GitHub over HTTPS.

From `update-check.log`:

```
05:05:27 installing 0.2.90 (Foundation Update Check_0.2.90_x64-setup.exe) with /S
05:05:31 old: attached to http://localhost:31441/
05:05:31 old: app version 0.2.90
05:05:39 feed ← GET /latest.json                       the launch check, 8 s after opening
05:05:39 old: card says "Foundation 0.2.91 is ready"
05:05:40 old: pressed Update and restart
05:05:40 feed ← GET /latest.json                       read again before installing
05:05:41 feed ← GET /files/Foundation%20Update%20Check_0.2.91_x64-setup.exe
05:05:46 new: attached to http://localhost:31441/      passive NSIS install, relaunched by itself
05:05:46 new: app version 0.2.91
05:05:47 new: card says "Updated to Foundation 0.2.91"
05:05:47 installer fetched 1× · result: PASS
```

- `01_offered.png`: the card on the sign-in page, in day tokens (the sign-in page is always day).
- `02_downloading.png`: after the press.
- `03_updated.png`: the relaunched 0.2.91 says what changed, once.

**What the check found, fixed before this run:**
1. **The window can load another app's page.** With Josh's installed Foundation 0.2.0 open (it holds `localhost:31440`), the first check build bound the same port on the other address family and its window ran 0.2.0's bundle (no updater in it). `lib.rs` now needs the port free on both 127.0.0.1 and ::1, else it says the port is taken.
2. **The card was under the sign-in page** (z-index 110 vs 900), so a person who isn't signed in couldn't update. It floats over sign-in now (910): an update can be what fixes signing in.
3. **Night glass over the always-day sign-in page** read muddy. Over sign-in the card wears `.f-day`.

**Not checked:** a release from GitHub (none is published yet; the feed 404s until the first one, and the card stays quiet). The MSI path. macOS and Linux (no builds here). The installed Foundation 0.1/0.2 has no updater: 0.3.0 must be installed by hand once.

The check app was uninstalled afterwards and its profile removed; Josh's Foundation wasn't touched.
