// Foundation's server keeps its search index in SQLite's FTS5, and Node's own SQLite (node:sqlite)
// only ships FTS5 from 22.16. On an older Node the server dies at boot ("no such module: fts5"),
// the launcher goes with it, and every request the app makes then fails to fetch — which reads
// as "nothing connects" rather than "the server never started". Say so before starting anything.

export const NEEDS = [22, 16];

/** true when this Node can run the server */
export function nodeIsNewEnough(version = process.versions.node) {
  const [major, minor] = version.split(".").map(Number);
  return major > NEEDS[0] || (major === NEEDS[0] && minor >= NEEDS[1]);
}

/** what to tell the person, in the terminal they started Foundation from */
export function oldNodeMessage(version = process.versions.node, platform = process.platform) {
  const fix =
    platform === "win32"
      ? "winget install OpenJS.NodeJS.LTS   (or the installer from nodejs.org), then open a new terminal"
      : platform === "darwin"
        ? "brew install node   (or the installer from nodejs.org)"
        : "install Node 22.16 or newer from nodejs.org or your package manager";
  return [
    "",
    `  Foundation's server can't start on Node ${version}.`,
    `  It needs Node ${NEEDS.join(".")} or newer: older Node 22 releases ship a SQLite without full-text search (FTS5).`,
    "  Without the server, the app opens but nothing in it connects: agents, Claude, files and data sources all fail to fetch.",
    "",
    `  Fix: ${fix}`,
    `  This terminal runs: ${process.execPath}`,
    "",
  ].join("\n");
}
