# Foundation for Chrome, ready for the Web Store: 2026-11-11

From `apps/client/e2e/extension.spec.ts`. The built extension is loaded into Playwright's Chromium (`--load-extension`, new headless) against the e2e's own server, signed in as a seeded person (Ada; Kai asked her for two things; three goals).

- `01_new-tab-is-today.png`: `chrome://newtab` → the extension's `newtab.html` → `/?from=chrome#/today`, signed in, with Ada's asks and goals.
- `02_popup-signed-in.png`: `chrome-extension://<id>/popup.html`, which reads `/api/today` from the extension's origin with Foundation's `SameSite=Lax` cookie: "Ada, 2 things want you.", her focus and goals.
- `03_popup-signed-out.png`: a fresh profile, so no sign-in: it says so and still lists the company's apps.
- `04_privacy-day.png`, `04_privacy-night.png`: `#/privacy`, which the Web Store listing links to, open without a sign-in.

The listing's images (`apps/extension/store/`) come from the same run with `STORE_ASSETS=1`.

Release build checks (`npm test -w @foundation/extension`, 9 tests):
- the release manifest has no localhost, grants Foundation and the company's domains, and takes `package.json`'s version;
- the placeholders are listed;
- the admin's policies (Admin console JSON, `windows.reg`, macOS plists) name the same Foundation;
- an admin's `foundationUrl` (Chrome policy) wins over the person's own, and an unsafe one is ignored;
- the privacy page's contact matches `release.json`.

Not checked here: branded Chrome with a hosted Foundation on HTTPS, a real force-install by policy, or the Web Store's review.
