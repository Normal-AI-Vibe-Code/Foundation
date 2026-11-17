# The crew: agents you can see (2026-11-07)

Brief and the four questions: SPEC §0.3. Status: SPEC §3 "The crew".

## How it was checked

- **Server, `npm test`**: `apps/server/test/crew.test.ts`, 8 tests.
  - Two runs are two named presences, each with its asker.
  - An agent aims at the section before the table exists, then lands on it, and its activity is signed.
  - `bring_view` guides only the asker; an outside MCP agent can't move anyone's view.
  - A run is a crew member from start to finish: the lead calls in a helper, both sign their work, and none is left in awareness after the linger.
  - Helper caps: none outside an ask, two per ask, none from a helper.
  - A viewer's agent reads but can't write or call in help.
  - `arrange_section` reorders without new times; `rename_section` renames.
  - An MCP crew id counts only for its own person and board.
  - (After the real turns) A wiring step names its cards. A connector hooked up first doesn't hide the cards after it. The helper's brief isn't logged as the person's ask. Now 10 tests, plus `apps/client/test/markdown.test.ts` (3) for note tables.
- **Browser, `npm run e2e -w @foundation/client`**: `e2e/crew.spec.ts`, 5 tests in Chromium, with two people (Ada and Kai) in separate browser contexts. The server ran the `script` runtime (`FOUNDATION_AGENT_SCRIPT=1`: the real board tools, a fixed playbook, no model), so the run is the same every time.

| File | What it shows |
|---|---|
| `01_tap-space-types.png` | A tap of Space: the sheet opens for typing (a held Space that turned into a pan stood down first) |
| `02_ada-holding-space.png` | Holding Space: Ada's words as the stand-in recogniser hears them |
| `03_kai-watches-the-crew.png` | **Kai's** screen: Tern, Ada's agent, at the slot beside the table it just made, "hooking up FactoryForm" |
| `04_ada-brought-to-supply.png` | Ada brought to Supply (Back offered). Tern and its helper Basalt (· with Tern) both done where they finished |
| `05_asked-first-while-busy.png` | Ada was wheeling round the board, so the agent asked first (Go) and didn't move her |
| `06_stopped-seen-by-kai.png` | Ada pressed Stop; Kai's roster shows the agent stopped |
| `07_design-crew-{day,night}.png` | `#/design` → The crew: cursors, the guide pill (brought / asked), the sheet listening and typing |
| `08_v-listening.png`, `09_v-sent-to-the-crew.png` | V does the same as holding Space (`e2e/build.spec.ts`) |

**Measured** (Kai's browser, `e2e/crew.spec.ts`): how far ahead of each card the cursor was in the section.

| Card | Cursor ahead by |
|---|---|
| Parts (a table) | 534–549 ms |
| FactoryForm (a connector) | 989–1009 ms |
| What's here (a note) | 2438–2476 ms |
| Suppliers to call (the helper's note) | 2487–2563 ms |

For every card, a crew cursor was already inside the section when the card first appeared.

**Back** returned Ada's camera to within 2 px. Kai's camera stayed within 2 px of where he left it while Ada was brought.

## Real model turns (later the same day)

The first attempt stopped at Claude Code's sign-in ("OAuth session expired"). The agent (Onyx) joined, said that in a toast and left. The Claude desktop app's sign-in doesn't reach the CLI: `claude auth status` showed `loggedIn: false` until `claude auth login` was run.

Then a real Foundation ran on its own ports with a fresh board and **no script runtime**: real `claude -p` turns on Josh's subscription. The desktop app's `CLAUDE*`/`ANTHROPIC*` variables were dropped from the server's environment. Each ask was typed into the sheet after a real tap of Space in the in-app browser. The cursor log is what the asker's page showed, sampled every 100 ms.

**1 · "Make a section called Supply chain with a table of the parts we're short on and a note on who to call, hook up FactoryForm there, then bring me over to it."**
- The agent was **Swift**.
- 0–12.9 s: read the ask, planned, read FactoryForm and BomForm, and searched "supplier contact shortage", "supplier" and "low stock inventory".
- 12.9 s: made the section; 15.6 s the table; 17.7 s the note; 19.2 s hooked up FactoryForm; 23.2 s wired it.
- 23.8 s: brought Josh to Supply chain (Back offered). Done at 28.9 s.
- The note said, truthfully, that no supplier contacts were on the board and FactoryForm was offline.
- `10_real-swift-reading-the-ask.jpg`, `11_real-swift-brought-me-to-supply-chain.jpg`.
- Two faults:
  - The note's markdown table showed as raw pipes.
  - The cursor read "wiring port_mw7… → port_mw7…".
- Both are fixed. The table now renders: `12_real-note-table-renders.jpg`, `15_note-table-{night,day}.png`.

**2 · "Set up an Ops review section: a table of open work orders, a note on what's blocked, and FactoryForm hooked up. Get a helper to write Monday's standup checklist. Then tidy it and bring me there."**
- The agent was **Talc**. It made the section, called in **Mica** at 15.8 s, and hooked up FactoryForm *first* (17.1 s).
- Then it made the table and note. Meanwhile Mica wrote "Monday standup checklist" and finished at 26.2 s.
- Talc arranged the section, brought Josh there at 29 s, and was done at 34 s.
- **But the section showed only FactoryForm.** As the first card in an empty section, the connector became the section's host, which covers the body. The table and both notes were in the section, beneath it: `13_real-talc-cards-hidden-under-connector.jpg`.
- The scripted playbook always made the table first, so it never hit this.
- Fixed in `tools.ts`: a card an agent adds to a hosted section makes the app a card in the flow.

**3 · The same ask, after the fix.**
- The agent was **Jasper**, and it again hooked up FactoryForm before anything else (20.1 s).
- Its helper **Finch** was called in at 18 s and wrote the checklist (done at 30.7 s).
- Josh was brought to Ops review at 38.9 s; done at 44.4 s.
- All four cards are visible: table, "Blocked", FactoryForm, and Finch's checklist (`14_real-jasper-and-finch-fixed.jpg`). The section's `host` is empty.
- The activity log showed two more faults, both fixed with tests:
  - Finch's brief was logged as "Josh Test: asked the agent: You were called in by Jasper…". The lead now signs "called in Finch: …".
  - "arranged 4 cards in sec_…" now uses the section's name.

## Not checked

- **A real model driven by voice**, or watched by a second person. The real turns were typed, by one person.
- **A real microphone.** The in-app browser blocks the mic, and Playwright's recogniser is a stand-in. So the mic-level bars were seen breathing, not following a voice.
