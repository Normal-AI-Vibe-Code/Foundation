# Key labels per platform: ⌘ on a Mac, Ctrl elsewhere (2026-11-07)

On Windows the client printed Mac keys everywhere (the HUD pill said `⌘F`, the section welcome `⌘L` / `⌘U` / `⌘J`). The handlers already took Ctrl (`e.metaKey || e.ctrlKey`); only the labels were wrong.

- **One helper**: `apps/client/src/lib/keys.ts`. `IS_MAC` reads `navigator.userAgentData.platform` (Chromium, so WebView2) and falls back to `navigator.platform` (Safari, WKWebView, WebKitGTK). `keys("mod+K")` gives `⌘K` / `Ctrl+K`, `keys("shift+mod+Z")` gives `⇧⌘Z` / `Ctrl+Shift+Z`, and `keys("mod+enter")` gives `⌘↵` / `Ctrl+Enter`. Unit tests: `apps/client/test/keys.test.ts`.
- **Every label goes through it**: chips, `data-tip` / `data-kbd` roll-overs, `title`s, the ⌘K "ask the agent" row and its empty-state line, the side pane, the top bar, the section toolbar and the section welcome. Off a Mac, the top bar's commands button shows `≡` instead of the ⌘ key. Code comments still say ⌘, and so does the ⌥ glyph used for Vision Code tabs, which isn't a key.
- **Chips** (`.f-kbd`, tokens.css): `white-space: nowrap; flex-shrink: 0`, so `Ctrl+Enter` stays on one line and isn't squeezed.
- **Section welcome** (App.css, on tokens): a short, narrow welcome (two columns of about 170 px) drops its chips. Otherwise `Ctrl+L` pushed "Open an app or link" onto three lines; the roll-over still names the key. Separately, the glyph-only welcome at 260 px spilled out of its section on both platforms, because the hidden label tracks kept their gaps. It now fits (the 260 frames in `design-keys_*`).
- `#/design` → **Key labels** shows both platforms' chips, the HUD pill and a roll-over, then the real `SectionEmpty` at 260 / 400 / 560, tall (680) and short (440).

## How it was checked

`capture.mjs` (headless Chromium against `npm run dev`, dev login) emulates the platform with `navigator.platform` and `navigator.userAgentData.platform`, then captures day and night:

- `before/`: Windows, before the change (`⌘F` in the HUD, `⌘U` in the side pane, ⌘ on the top bar's commands button). This was taken with an earlier version of the script, so it has no tip, commands or welcome shots.
- `after/`: Windows and Mac. Shots: `design-keys` (the new section), `design-controls`, `design-hud`, and on the board `board-hud`, `board-topbar`, `board-sidepane`, `board-welcome` (an empty section, framed), `board-tip` (＋ → "New agent session (Ctrl+J)") and `board-commands` (Ctrl+K with no hits → `Ctrl+Enter` row and "Ctrl+Enter asks the agent").
- The script also reads every visible chip on the board: none is clipped (`scrollWidth ≤ clientWidth`), and Windows shows only `Ctrl+…`, `V`, `0` and `esc`.

`npm test` (client 29, server 46) and `npm run typecheck` are green.

Not done: neither a real Mac window nor a Linux window was used. Both platforms were emulated in Chromium on Windows.
