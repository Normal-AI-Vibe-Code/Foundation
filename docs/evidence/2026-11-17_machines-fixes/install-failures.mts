/**
 * Add a desktop when it can't work, on the real engine here (Kiri): a package
 * mirror that never answers (the install goes quiet; a person stops it), no
 * DNS (it fails, and says the machine couldn't reach its package servers), a
 * Stop in the middle of a download, and Add a desktop again after that Stop.
 * It starts its own Ubuntu machine and removes it. Its own data folder.
 *
 *   cd apps/server && npx tsx ../../docs/evidence/2026-11-17_machines-fixes/install-failures.mts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "foundation-desk-fail-"));
process.env.FOUNDATION_DATA_DIR = dir;
process.env.FOUNDATION_DESKTOP_QUIET_MS = "4000";

const m = await import("../../../apps/server/src/machines.ts");
const desk = await import("../../../apps/server/src/machinedesktop.ts");
const mio = await import("../../../apps/server/src/machineio.ts");
const { editBoard, getBoard, closeBoards } = await import("../../../apps/server/src/boards.ts");
const { appendSection, boardMaps } = await import("@foundation/protocol");
const { runTool } = await import("../../../apps/server/src/tools.ts");
const { upsertUser } = await import("../../../apps/server/src/auth.ts");

const step = (s: string) => console.log(`· ${s}`);
const B = "fail";
let card = "";
const desktop = () => (boardMaps(getBoard(B).doc).objects.get(card) as { machine?: { desktop?: { state: string; detail?: string } } }).machine?.desktop;
const until = async (what: string, ok: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`never saw ${what} (the card says: ${JSON.stringify(desktop())})`);
    await new Promise((r) => setTimeout(r, 150));
  }
};
const sh = (script: string, user?: string) => m.execRaw(B, card, ["/bin/sh", "-c", script], { timeoutS: 20, ...(user ? { user } : {}) }).then((r) => r.stdout.toString("utf8").trim() || r.stderr.trim());
// alive ones by name; ones that were killed and not yet reaped by the machine's init are counted apart (they hold nothing)
const pkgProcs = () =>
  sh(
    `z=0; for p in /proc/[0-9]*; do c=$(cat $p/comm 2>/dev/null); case "$c" in apt*|dpkg*|http|https|gpgv|store) if grep -q '^State:[[:space:]]*Z' $p/status 2>/dev/null; then z=$((z+1)); else printf '%s ' "$c"; fi;; esac; done; [ $z -gt 0 ] && printf '(%s killed, not yet reaped)' $z`,
  );

try {
  const engine = (await m.engineStatus(true)).find((e) => e.up && e.id === "kiri");
  if (!engine) throw new Error("Kiri isn't answering here");
  step(`${engine.name} ${engine.version}`);
  const who = upsertUser("smoke@formindustries.com", "Smoke");
  editBoard(B, "smoke", (d) => appendSection(d, "Machines"));
  ({ card } = (await runTool({ boardId: B, actor: "Smoke", userId: who.id, person: true }, "propose_machine", { name: `desk-fail-${Date.now().toString(36)}`, image: "ubuntu" })) as { card: string });
  const started = await m.startMachine(B, card, "Smoke", { engine: "kiri" });
  step(`started machine-${started.name} (${started.image})`);

  // the engine runs an exec as the user it is asked for: the install asks for root whatever the image's user is
  step(`exec as the image's own user: uid ${await sh("id -u")}; asked for user "0": uid ${await sh("id -u", "0")}; asked for "nobody": uid ${await sh("id -u", "nobody")}`);

  // ---- a mirror that never answers: the install goes quiet, the card says so, a person stops it ----
  await sh(`cp /etc/hosts /tmp/hosts.keep; echo "203.0.113.1 archive.ubuntu.com security.ubuntu.com" >> /etc/hosts`);
  let t0 = Date.now();
  desk.addDesktop(B, card, who).done.catch(() => {});
  await until("the card to say the install is quiet", () => /no word from the package manager/.test(desktop()?.detail ?? ""), 60_000);
  step(`a mirror that never answers, after ${Math.round((Date.now() - t0) / 1000)} s the card says: “Adding a desktop: ${desktop()!.detail}”`);
  step(`  in the machine meanwhile: ${(await pkgProcs()).split("\n").join(" | ") || "(no package manager)"}`);
  t0 = Date.now();
  await desk.stopDesktopInstall(B, card, who);
  step(`Stop: ${Date.now() - t0} ms; the card's desktop is now ${JSON.stringify(desktop() ?? null)}; package managers left in the machine: ${(await pkgProcs()) || "none"}`);
  await sh(`cat /tmp/hosts.keep > /etc/hosts`);

  // ---- no DNS: it fails, and says the machine couldn't reach its package servers ----
  await sh(`cp /etc/resolv.conf /tmp/resolv.keep; : > /etc/resolv.conf`);
  t0 = Date.now();
  await desk.addDesktop(B, card, who).done.catch(() => {});
  step(`no DNS, after ${Math.round((Date.now() - t0) / 1000)} s the card says (${desktop()?.state}): “${desktop()?.detail}”`);
  await sh(`cat /tmp/resolv.keep > /etc/resolv.conf`);

  // ---- Stop in the middle of a real download, then Add a desktop again ----
  desk.addDesktop(B, card, who).done.catch(() => {});
  await until("packages unpacking", () => /Unpacking|Setting up/.test(desktop()?.detail ?? ""), 240_000);
  step(`a real install under way: “${desktop()!.detail}”`);
  t0 = Date.now();
  await desk.stopDesktopInstall(B, card, who);
  step(`Stop mid-install: ${Date.now() - t0} ms; desktop ${JSON.stringify(desktop() ?? null)}; package managers left: ${(await pkgProcs()) || "none"}`);
  t0 = Date.now();
  const again = await desk.addDesktop(B, card, who).done.then((s) => s.desktop, (e: Error) => ({ state: "error", detail: e.message }));
  step(`Add a desktop again after the Stop: ${JSON.stringify(again)} in ${Math.round((Date.now() - t0) / 1000)} s`);
  if (again?.state !== "ready") process.exitCode = 1;
} catch (e) {
  console.error(`✗ ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  if (card) await m.removeMachine(B, card, "Smoke", true).then(() => step("removed the machine and its disk"), (e: Error) => console.error(`  (couldn't remove it: ${e.message})`));
  mio.stopMachineIo();
  desk.closeDesktops();
  m.closeTerminals();
  closeBoards();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows keeps the database open until the process ends */
  }
  setTimeout(() => process.exit(), 200).unref();
}
