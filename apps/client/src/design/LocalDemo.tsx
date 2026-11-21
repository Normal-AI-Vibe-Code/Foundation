import type { LocalProject, LocalWatch } from "@foundation/protocol";
import { LocalCard, LocalPill } from "../panels/LocalView";
import { ComputerGlyph } from "../shell/glyphs";

/**
 * This computer on `#/design`: one project's three cards (panels/LocalView.tsx `LocalCard`) at their sizes on the
 * grid (760 × 500, 440 × 500, 440 × 500), the local pill live and stopped, and the section's chip. Nothing here
 * reaches a server; the screenshot is a stand-in in a neutral grey that reads on day and night paper.
 */

const now = Date.now();
const shot = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400"><rect width="640" height="400" fill="gray" fill-opacity=".12"/><rect x="0" y="0" width="640" height="34" fill="gray" fill-opacity=".22"/><rect x="24" y="64" width="250" height="18" rx="4" fill="gray" fill-opacity=".45"/><rect x="24" y="96" width="380" height="10" rx="3" fill="gray" fill-opacity=".3"/><rect x="24" y="140" width="180" height="200" rx="6" fill="gray" fill-opacity=".25"/><rect x="224" y="140" width="180" height="200" rx="6" fill="gray" fill-opacity=".25"/><rect x="424" y="140" width="180" height="200" rx="6" fill="gray" fill-opacity=".25"/></svg>`,
)}`;

const project: LocalProject = {
  key: "c:/Dev/Gizmo",
  name: "Gizmo",
  path: "C:\\Dev\\Gizmo",
  git: {
    branch: "main",
    ahead: 2,
    behind: 0,
    dirty: 17,
    files: [
      { path: "apps/client/src/panels/Wheel.tsx", status: "M" },
      { path: "apps/client/src/panels/wheel.css", status: "??" },
      { path: "apps/server/src/axle.ts", status: "M" },
      { path: "apps/server/src/old-axle.ts", status: "D" },
      { path: "docs/evidence/2026-11-20_wheels/turning.png", status: "A" },
    ],
    commits: [
      { sha: "a92861f", subject: "Wheels turn on the axle's spring", at: now - 40 * 60_000 },
      { sha: "abd9872", subject: "Plan: the wheels cards", at: now - 5 * 3600_000 },
      { sha: "cf60273", subject: "An axle that holds", at: now - 26 * 3600_000 },
    ],
  },
  server: { name: "web", port: 1430, url: "http://localhost:1430", live: true },
  preview: { fileId: shot, at: now - 6 * 60_000, session: "Wheels that turn", mime: "image/svg+xml" },
  sessions: [
    {
      id: "a",
      title: "Wheels that turn",
      source: "claude-desktop",
      state: "working",
      at: now - 20_000,
      branch: "main",
      steps: [
        { text: "Read the axle and the wheel", state: "done" },
        { text: "Build the turning wheel", state: "done" },
        { text: "Show it on #/design", state: "doing" },
        { text: "Check it in the browser, day and night", state: "todo" },
        { text: "Commit", state: "todo" },
      ],
      recap: "The wheels turn on the axle's spring and the card shows it. Not yet checked at night; nothing committed.",
      pr: { number: 7, url: "https://github.com" },
      edits: 6,
    },
    { id: "b", title: "Spokes", source: "claude-cli", state: "idle", at: now - 3 * 3600_000, worktree: "spokes-1a2b", steps: [{ text: "Draw", state: "done" }, { text: "Ship", state: "doing" }], edits: 2 },
    { id: "c", title: "Tyre pressure check", source: "t3", state: "waiting", at: now - 12 * 60_000, edits: 0 },
  ],
  at: now - 20_000,
};

const watch: LocalWatch = { by: "u", byName: "Josh", since: now - 86_400_000, on: true, scannedAt: now, every: 10_000, projects: 6, working: 1, sources: { claude: true, t3: true, git: true } };
const stopped: LocalWatch = { ...watch, on: false, scannedAt: now - 3 * 3600_000 };

function Frame({ w, h, children }: { w: number; h: number; children: React.ReactNode }) {
  return (
    <div className="frame-card panel-card kind-local" style={{ width: w, height: h, position: "relative", borderRadius: "var(--radius-card)", background: "var(--color-raise)", boxShadow: "var(--shadow-sheet), 0 0 0 1px var(--color-line)", overflow: "hidden" }}>
      {children}
    </div>
  );
}

export function LocalDemo() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <LocalPill watch={watch} />
        <LocalPill watch={stopped} />
        <span className="sec-local-chip">
          <ComputerGlyph size={13} />1 working here
          <span className="f-dot is-ok" aria-hidden />
        </span>
        <span className="sec-local-chip">
          <ComputerGlyph size={13} />
          Local
          <span className="f-dot is-warn" aria-hidden />
        </span>
      </div>
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-start" }}>
        <Frame w={760} h={500}>
          <LocalCard node="preview" name="Preview" project={project} watch={watch} />
        </Frame>
        <Frame w={440} h={500}>
          <LocalCard node="progress" name="Progress" project={project} watch={watch} />
        </Frame>
        <Frame w={440} h={500}>
          <LocalCard node="changes" name="Changes" project={project} watch={watch} />
        </Frame>
        <Frame w={440} h={300}>
          <LocalCard node="changes" name="Changes" project={{ ...project, git: undefined }} watch={stopped} />
        </Frame>
      </div>
    </div>
  );
}
