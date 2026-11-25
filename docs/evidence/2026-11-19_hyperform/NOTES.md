# HyperForm's apps on Today, opened in Foundation (2026-11-19)

SPEC §0.10. Shots are from `apps/client/e2e/pages.spec.ts` (Chromium driving Foundation on its own server and
data, ports above 15000; the server driving the Chrome installed on this machine). **DeployForm in these shots is
a stand-in page the checks serve**, not the real app: nobody has signed in to HyperForm in Foundation's browser yet.

| Shot | What it shows |
| --- | --- |
| 01-today-apps-day | Today's Apps: HyperForm, PartForm, DeployForm, FactoryForm first, each a link, each with ⤢ (open in Foundation) |
| 02-deployform-live-day | After ⤢ on DeployForm: a new section at the grid's right edge that the page fills, live (the server's Chrome, drawn on a canvas; no frame) |
| 03-deployform-in-use-agent | Ctrl-clicked: the page's bar (back, forward, reload, address, home, ↗, Agents). Agents on: an agent typed "Hilo" into the page's field, and what it did is said at the page's foot |
| 04-deployform-far-picture | Zoomed out to 23 %: the page is the picture kept of it, with its name and when it was seen; nothing runs for it |
| 05-member-picture-night | Kai, not an admin, at night: the kept picture and "Open in your browser ↗"; no live page, and the server refuses them the browser (403) |
| 06-design-app-rows | `#/design`: the app rows as Today has them (linked with ⤢, and one not linked) |

What the real addresses answered without a sign-in (read with curl, 2026-11-19):

- `dock.apps.normallab.co` 200, `X-Frame-Options: DENY` (HyperForm's landing page; sign-in is Google, work accounts only)
- `partform.apps.normallab.co` 307 → `/parts` → `/login`
- `deployform.apps.normallab.co` 401 "This app requires a hyperform sign-in"
- `factory-form-factoryform.apps.normallab.co` 401, the same (`…normalla.co`, as first written, does not resolve)

Not checked: the real apps inside Foundation (it needs a person's sign-in), and whether Google allows its
sign-in in the server's browser.

## HyperForm's dashboard, read after Josh signed in (Claude's browser pane)

| Project | Address | State | In Today's list |
| --- | --- | --- | --- |
| partform | partform.apps.normallab.co | Ready | PartForm ("Airform BOM"; then asks for an OnShape sign-in) |
| deployform | deployform.apps.normallab.co | Sleeping | DeployForm ("Inventory & Install Tracker") |
| factory-form | factory-form-factoryform.apps.normallab.co | Ready | FactoryForm |
| formindustries-metalform | formindustries-metalform.apps.normallab.co | Sleeping | MetalForm (added) |
| gnatt-chart | gnatt-chart-web.apps.normallab.co | Sleeping | Form Gantt (added) |
| form-chess | form-chess-web.apps.normallab.co | Sleeping | Form Chess (added) |
| airform | airform.space | Ready | Airform, the product site (added; public) |
| form-figma | form-figma-files.apps.normallab.co | Ready | no: a storage service, not a page |
| flowform | server.formresearch.ai | Stopped | no |
| git | none | Stopped | no |
