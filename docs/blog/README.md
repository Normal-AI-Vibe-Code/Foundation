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

Write for the people using the board, not for the code: say what they can do now and what got fixed, in their words. Put the plan cards a release closes in its commits (`Fixes #67`), not in the post.
