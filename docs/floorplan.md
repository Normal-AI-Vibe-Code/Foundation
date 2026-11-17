# The app floorplan

`apps/client/public/floorplan.html` is a map of Foundation's own code: every part, file and connection, named and described in plain words. The side pane opens it from **Release & plan → App floorplan** (served at `/floorplan.html`).

It was made with the floorplan plugin for Claude Code (`claude plugin marketplace add haydenschmitty/floorplan`, then `claude plugin install floorplan@floorplan`). It's a snapshot, so refresh it after a release:

1. In Claude Code at the repo root, ask it to "update the floorplan" (or run `/floorplan:floorplan`). The map's sources live in `floorplan/`, which ignores itself in git; a fresh clone redraws them from the code.
2. Export it into the app, without the Ask bar, machine paths or the health list (this repo is public):
   `node floorplan/serve.mjs --export apps/client/public/floorplan.html --include flows,notes,recent`
3. Open it from the side pane, check it, and commit.
