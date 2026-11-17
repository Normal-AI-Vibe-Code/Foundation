# Voice and agent construction (2026-11-03)

**Talking.** A mic pill sits beside search, and V does the same. The words show as they're heard (00). When the speaker stops, they go to the agent session on screen, or a new one, and run (01). Esc drops them. `e2e/build.spec.ts` uses a stand-in speech recogniser in place of a microphone. The composer's mic and the HUD's share `lib/voice.ts`. Not tried with a real voice (headless).

**Construction tools:**
- `find_images` looks in Foundation's archive (full text, and where imported images came from), on the board, and in Slack. Slack search uses `search.files` with the user token, searching the phrase and then each word, ranked by how many words match. Without a user token it falls back to the bot's `files.list` filtered by name. With no Slack keys it says Slack wasn't searched.
- `lay_out` builds a section from the items in one of four styles:
  - **grid**: masonry;
  - **board**: a mood board, every third image wide where two columns end level;
  - **document**: one column, with a heading, an intro, and each image with its caption;
  - **timeline**: left to right by date, fitted to the section.
- Slack images are copied into the archive (searchable, archived, never deleted; one file per image however often it's laid out). Captions carry the title, where it came from and when.

**The four layouts.** Photographed (02–05) from a stand-in Slack (`e2e/slack-standin.mjs`, real PNGs: four PTHP pictures and one lunch photo), each checked for overlapping cards and images that didn't load.

**A real agent turn** (Claude Code on the subscription) on an isolated copy wired to the stand-in Slack:
- "Please lay out all the images from Slack related to the Airform PTHP" → find_images, lay_out, focus. It laid out 3 images as a grid and said it had searched only Slack (06). It missed "PTHP manifold, printed", whose title lacks "Airform", so phrase-then-word search was added.
- "…as a mood board" → all 4, as a mood board. It offered to remove the older 3-image page and didn't do it (07).

**Not done:** the real Slack. It needs `SLACK_USER_TOKEN` (search:read) or `SLACK_BOT_TOKEN` with `files:read`, which is now in `docs/slack-app-manifest.yml` (SPEC §6).
