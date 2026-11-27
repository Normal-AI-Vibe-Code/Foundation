# Release notes

One post per release, named for its version: `docs/blog/<version>.md`.

```markdown
---
version: 0.3.0
date: 2026-11-09
title: One line on what the release is about
---

The post, in markdown: what changed, for the people who use Foundation.
```

- **In the app:** Settings → Releases shows every post, newest first. They're bundled with the app, so they open offline.
- **On GitHub:** `scripts/release.mjs` uses everything after the front-matter as the GitHub Release's description and the desktop updater's notes. It won't publish a version that has no post.

## The whole history: `docs/releases.json`

Every published version, not only the ones with a post: its date, the commit it was cut from, and its changes (the commit subjects since the version before, plan syncs and merges left out). `node scripts/release.mjs history` writes it from the `v*` tags; each CI build writes it again with the version it is building on top, so an installed app always knows itself and everything before it. The app's Changes panel (the bottom bar's tools → Changes → Releases) shows this app's version large with what it changed, then every release by day. A committed copy goes stale as CI publishes: run `git fetch --tags && node scripts/release.mjs history` now and then so a checkout's own client shows the newest ones too.

Write for the people using the board, not for the code: say what they can do now and what got fixed, in their words. Put the plan cards a release closes in its commits (`Fixes #67`), not in the post.
