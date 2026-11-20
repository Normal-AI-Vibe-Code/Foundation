/** Browser acceptance on the host. A real boot is opt-in: VM_E2E_ISO names verified install media.
 * No fake desktop is presented as WildOS; without media/QEMU only the design checks run.
 */
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { CLIENT, person, waitLive } from "./helpers";

const evidence = resolve(import.meta.dirname, "../../../docs/evidence/2026-11-20_native-vms");
mkdirSync(evidence, { recursive: true });

test("full-OS setup on the design page, day and night, at three card widths", async ({ page }) => {
  await page.goto(`${CLIENT}/?rafshim#/design/machines`);
  const heading = page.getByRole("heading", { name: "Full operating systems · native QEMU" });
  await heading.scrollIntoViewIfNeeded();
  await expect(page.getByRole("textbox", { name: "VM name" })).toHaveCount(3);
  const forms = page.locator(".vm-setup");
  for (let n = 0; n < 3; n++) {
    const form = forms.nth(n);
    await expect(form.getByRole("button", { name: "Add VM to this section" })).toBeVisible();
    await expect(form.getByLabel("Operating system ISO")).toHaveValue("demo-iso");
  }
  // The design page's own orb exercises the actual token engine.
  for (const look of ["day", "night"] as const) {
    const orb = page.locator(".night-orb").first();
    const current = await page.evaluate(() => document.documentElement.classList.contains("is-night"));
    if (current !== (look === "night")) await orb.click();
    await page.waitForTimeout(1600);
    await heading.scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(evidence, `setup-${look}.png`), fullPage: true });
  }
});

test("import install media, configure and start a full OS in a section, then shut it down", async ({ browser }) => {
  test.setTimeout(240000);
  const iso = process.env.VM_E2E_ISO;
  test.skip(!iso, "Set VM_E2E_ISO to a verified WildOS ISO on the host for a real boot");
  const { context, page } = await person(browser, "VM Test", "vm@normal.dev");
  const host = await (await context.request.get(`${CLIENT}/api/vms/host`)).json();
  test.skip(!host.available, "Native QEMU is not installed on the server computer");
  const made = await (await context.request.post(`${CLIENT}/api/boards`, { data: { name: `WildOS test ${Date.now()}` } })).json();
  const board = made.id;
  const tool = async (name: string, data: object) => (await context.request.post(`${CLIENT}/api/boards/${board}/tools/${name}`, { data })).json();
  await tool("add_section", { name: "WildOS" });
  const panel = (await tool("propose_machine", { section: "WildOS", name: "WildOS" })).result.card;
  await page.goto(`${CLIENT}/?board=${board}`); await waitLive(page);
  await page.getByRole("tab", { name: "Full OS / WildOS VM" }).click();
  await page.getByLabel("Import OS ISO").setInputFiles(iso!);
  await expect(page.getByRole("button", { name: "Add VM to this section" })).toBeEnabled({ timeout: 120000 });
  await page.getByLabel("Software emulation", { exact: false }).check();
  await page.getByRole("button", { name: "Add VM to this section" }).click();
  await page.getByRole("button", { name: "Start VM", exact: true }).click();
  try {
    await expect(page.locator(".vm-state")).toHaveText("running", { timeout: 30000 });
    const console = page.frameLocator('iframe[title="WildOS\'s desktop"]');
    await expect(console.locator("canvas")).toBeVisible({ timeout: 60000 });
    await page.screenshot({ path: resolve(evidence, "real-iso-console.png") });
    await page.getByRole("tab", { name: "Commands", exact: true }).click();
    await page.getByLabel("Guest shell command").fill("uname -a");
    await page.getByRole("button", { name: "Run in VM", exact: true }).click();
    await expect(page.locator(".vm-output")).toContainText(/Linux|guest agent/i, { timeout: 10000 });
  } finally {
    await context.request.post(`${CLIENT}/api/boards/${board}/vms/${panel}/shutdown`, { data: {} });
    await context.close();
  }
});
