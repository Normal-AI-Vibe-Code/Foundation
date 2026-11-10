# The desktop app starts its own server (2026-11-09)

The packaged exe from `npm run tauri build` (`target/release/tauri-app.exe`, `server/` beside it), on Windows 11,
driven over WebView2's DevTools port by `check.mjs`. Its data folder and WebView profile were pointed at
scratch folders (`FOUNDATION_DESKTOP_HOME`, `WEBVIEW2_USER_DATA_FOLDER`) so the real ones weren't touched,
except one launch with the default folder to see where the data lands (`%APPDATA%co.normallab.foundation`).
Another session's `npm run dev` was on :4410 throughout, so the runs of the app's own server set
`FOUNDATION_DESKTOP_USE_DEV_SERVER=0`.

| File | What it shows |
|---|---|
| `dev-server-reused_01_opened.png` | With a dev server on :4410, the window used it (Server · localhost:4410) and started nothing |
| `own-server_01_opened.png` | Its own server on :31441: signed in with dev login, the company board open |
| `own-server_03_asking.png` … `05_agent-done.png` | One agent turn on the subscription: Lark adds the note and finishes |
| `quit-and-kill.txt` | Closing the window, then `taskkill /F` on the app alone: no server process, :31441 free |
| `server-cant-start_01_opened.png` | A database that isn't one: the board opens from the device's copy; the window was told why (below) |

What the page was told when the server couldn't start:

    Foundation's server stopped as it started (exit code: 1). It said: Error: file is not a database
    (the rest is in …home2logsserver.log)

On the sign-in page that reads "Foundation's own server isn't running. …" in the error line (seen on the first
packaged run, which failed for a real reason: Tauri's `\?C:…` resource path; fixed).

Later the same day the NSIS installer was run on this machine, over an installed 0.3.0 (`installed.txt`):

| File | What it shows |
|---|---|
| `installed.txt` | What the installer put down; the installed app starting its own server, signing in, quitting clean; the dev server reused |
| `installed_01_opened.png`, `installed_02_signed-in-board.png` | The installed app (scratch data folder): Josh signing in with Google through the browser, then the board |
| `installed-own_01_opened.png` | The installed app on its default folders and its own server: the sign-in page, Server · localhost:31441 |

Not run: the MSI, a clean machine, macOS, Linux.
