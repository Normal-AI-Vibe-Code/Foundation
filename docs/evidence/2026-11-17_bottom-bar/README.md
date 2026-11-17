# 2026-11-17 · The bottom bar, the tools, the councils at the right

Josh's ask: the grid's council at the right with the bar at the bottom left; a section's council at its right, three places, closer, breathing; a line under the agents panel's tabs; the top right's functions in the bottom bar (Ask on the right with settings in its pill, the council beside it, present and commands as icons, search popping over its pill and pinnable to the right with a grid-line separator); day/night that always reaches the paper, the orb left of you and the server pill above Settings; and the top right as built-in tools: terminal, browser, files, change log, T3 (server and Vision's client). Adding an agent through T3 "does not work here".

01–12 come from `apps/client/e2e/bottom-bar.spec.ts` (its own server and data, Chromium, 1440 × 900, night):

- `01_bars.png` the top bar's tools and the bottom bar, the agents panel's line under its tabs
- `02_search-over-the-bar.png`, `03_search-pinned.png` search over its pill, then pinned to the right
- `04_council-of-the-grid.png` three places at the bottom right; the bar at the bottom left
- `05_council-of-a-section.png` three places at the section's right, by its Council button
- `06_side-menu-foot.png` the server pill above Settings; the orb left of you
- `07_*.png`, `08_context-lost-still-switches.png` day/night after the paper's WebGL context was taken
- `09_terminal.png` a shell on the server's computer, for an admin
- `10_changes.png`, `11_browser.png`, `12_t3.png` the change log, the browser, T3 (the stand-in)

13–15 are from a dev server on a copy of the real data (ports 14411/15431), by a Playwright script:

- `13_t3-vision-code-real.png` the real T3 (0.0.44) started from the T3 tool, its own page (Vision Code) framed and paired
- `14_changes-real-checkout.png` this checkout's commits
- `15_design-floor-{day,night}.png` `#/design` → The floor: the top bar's tools, the side menu's foot, the bottom bar

The black or white strip across the top bar's right half in `11` and `13` is the headless capture with a frame open: read back as a 1 × 1 clip, those pixels are the paper.
