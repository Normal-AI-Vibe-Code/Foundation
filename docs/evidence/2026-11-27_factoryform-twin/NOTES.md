# FactoryForm's twin section, 2026-11-27 (SPEC §0.26)

Chromium (Playwright), Foundation's dev server on :4471 with its client on :1471, signed in with dev login as a test admin (`FOUNDATION_ADMIN_EMAILS`) and as a member.

The FactoryForm was a copy serving the twin API on :3312, at revision `2.0.0+80e2bf7`. A looping simulated run of chamber-03 (`hipot-cycle`) was started on it through FactoryForm's own loopback Control route, and stopped afterwards.

The sections were laid on a fresh grid, *FactoryForm twin check*, through `lay_factoryform_twin` as a person, which is the call ⌘K makes.

| Shot | What it shows |
|---|---|
| `1_section_{1440,900}_{day,night}.png` | The whole section: the floor twin and chamber-03's station twin running in their frames (`allow-same-origin`, saved as "FactoryForm (this computer)"), the run card, the stations table wired from it (9 of 9 rows, `provenance` demo), the CAD card, the note |
| `4_run_*` | The run card close: Simulated, Running, "Hipot test cycle on chamber-03 · run by …", step n of 11, the bar and the time moving between shots |
| `5_cad_*` | The CAD card: floor GLB and DXF, each station cell GLB, and chamber-03's cell as the run poses it |
| `2_offline_member_day.png` | FactoryForm set to :3313, where nothing runs. A member sees "FactoryForm isn't answering", why, and who can start it |
| `2_offline_admin_day.png` | The same as an admin: *Start FactoryForm* |
| `3_started_admin_day.png` | After the press, the card is Live in 2.3 s, with the toast "FactoryForm started at 127.0.0.1:3313" |
| `6_design_{day,night}.png` | `#/design` → FactoryForm's twin. The page's sticky header covers the top of the first row in the element shot |

How Start was checked: `FOUNDATION_SIBLINGS` pointed at a scratch folder whose `FactoryForm/package.json` had a `serve` script standing in for FactoryForm's launcher. It started a detached proxy to :3312 on the port it was given, then printed the launcher's `{url, pid, twin, api}` line. The real checkout was not started from Foundation.

Before the saved app, the frames ran opaque. FactoryForm's page then failed to load its own module scripts and CSS ("from origin 'null' has been blocked by CORS policy"). That is why a person's lay saves the app.
