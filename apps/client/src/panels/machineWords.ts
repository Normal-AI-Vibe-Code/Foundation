/**
 * Words and numbers a machine card needs that don't need a browser (tested in
 * test/machine-words.test.ts).
 */

/**
 * Why a press on a machine's desktop didn't work, in words for the card. One
 * case gets its own: a server that answers its router's "not found" for the
 * route itself is a Foundation server from before machines had desktops
 * (2026-11-17: the app updates by itself, but a server started from a
 * checkout runs what it was started with until it is restarted; the press
 * said only "not found", in a toast). A 404 with other words is the server's
 * own answer (no such board, no such machine) and is passed on as it is.
 */
export function desktopRefusal(e: unknown, server: string, doing = "add a desktop"): string {
  const err = (e ?? {}) as { status?: number; message?: string };
  if (olderServer(e)) {
    return `The Foundation server at ${server} is older than this app and can't ${doing} yet. Restart it (Restart, here or in the server pill at the foot of the side menu; or stop and start it where it runs), then try again. Nothing was changed in the machine.`;
  }
  return err.message || "The server didn't say why.";
}

/** whether a refusal is a server from before the route existed: its router's own "not found" */
export function olderServer(e: unknown): boolean {
  const err = (e ?? {}) as { status?: number; message?: string };
  return err.status === 404 && /^not found$/i.test((err.message ?? "").trim());
}

/**
 * Whether Add a desktop has a recipe for an image (machinedesktop.ts installs with apt or apk): "yes" for
 * Ubuntu, Debian and Alpine (and images named for them), "no" for the Start picker's other four, "maybe"
 * for any other image (one built on Debian or Alpine works; the card says so if it doesn't).
 */
export function desktopRecipe(image: string): "yes" | "no" | "maybe" {
  const name = image.trim().toLowerCase().split("@")[0].split(":")[0].split("/").pop() ?? "";
  if (/^(ubuntu|debian|alpine)$/.test(name)) return "yes";
  if (/^(fedora|archlinux|arch|rockylinux|rocky|tumbleweed|leap|opensuse|centos|almalinux)$/.test(name) || image.toLowerCase().startsWith("opensuse/")) return "no";
  return "maybe";
}

/**
 * The in-use ring's width in the card's own pixels, for 2 px on the screen: a
 * card is drawn scaled (the camera × its section's fit). Never under 1 or
 * over 8 of the card's pixels (a card drawn at under a quarter, or over
 * double, its size).
 */
export const ringWidth = (drawnScale: number) => (drawnScale > 0 && Number.isFinite(drawnScale) ? Math.round(Math.max(1, Math.min(8, 2 / drawnScale)) * 100) / 100 : 2);

// ---------- a terminal's copy and paste (machineTerminal.ts) ----------

/** lines as a terminal holds them (a wrapped row continues the one before it), without the empty ones at the end */
export function joinRows(rows: { text: string; wrapped: boolean }[]): string {
  const lines: string[] = [];
  for (const r of rows) {
    if (r.wrapped && lines.length) lines[lines.length - 1] += r.text;
    else lines.push(r.text);
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join("\n");
}

/** which copy-and-paste key this is, if any: "copy" takes the selection, "paste" is left to the browser's paste */
export function clipKey(e: { type: string; code: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }, hasSelection: boolean, mac: boolean): "copy" | "paste" | null {
  if (e.type !== "keydown") return null;
  const mod = mac ? e.metaKey : e.ctrlKey;
  if (!mod || e.altKey) return null;
  // Ctrl+C with nothing selected is the shell's interrupt
  if (e.code === "KeyC") return e.shiftKey || mac || hasSelection ? "copy" : null;
  if (e.code === "KeyV") return "paste";
  return null;
}
