/**
 * An empty section shouldn't be a void: it offers the three ways work arrives
 * (open an app, drop files, ask the agent) and a shelf of the company's
 * registered apps, one click from being live in this section.
 */

import { keys } from "../lib/keys";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { setUi } from "../state/ui";
import { openUrlAsPanel } from "../shell/CommandBar";

interface AppRow {
  id: string;
  name: string;
  url: string | null;
  repo: string | null;
  mcp: string | null;
  description: string | null;
}

let shelfCache: AppRow[] | null = null;
let shelfPromise: Promise<AppRow[]> | null = null;
function loadShelf() {
  shelfPromise ??= api<{ apps: AppRow[] }>("/api/apps")
    .then((r) => (shelfCache = r.apps.filter((a) => a.url)))
    .catch(() => (shelfCache = []));
  return shelfPromise;
}

export function SectionEmpty({ name, onUpload, onNote, onText, onAsk, onFocus }: { name: string; onUpload(): void; onNote(): void; onText(): void; onAsk(): void; onFocus(): void }) {
  const [apps, setApps] = useState<AppRow[]>(shelfCache ?? []);
  useEffect(() => {
    if (!shelfCache) void loadShelf().then(setApps);
  }, []);

  return (
    <div className="section-empty" onPointerDown={(e) => e.stopPropagation()}>
      <div className="empty-card">
        <div className="f-eyebrow">{name}</div>
        <div className="empty-title">Bring work here</div>
        <div className="empty-actions">
          <button
            className="empty-action"
            data-tip={`Open an app or link (${keys("mod+L")})`}
            onClick={() => {
              onFocus();
              setUi({ command: true });
            }}
          >
            <span className="empty-glyph">◳</span>
            <span>
              <b>Open an app or link</b>
              <small>Paste a URL — it finds the repo, MCP and ports</small>
            </span>
            <span className="f-kbd">{keys("mod+L")}</span>
          </button>
          <button className="empty-action" data-tip={`Drop files (${keys("mod+U")})`} onClick={onUpload}>
            <span className="empty-glyph">⇪</span>
            <span>
              <b>Drop files</b>
              <small>Designs, CAD, PDFs, video — or drag them here</small>
            </span>
            <span className="f-kbd">{keys("mod+U")}</span>
          </button>
          <button className="empty-action is-agent" data-tip="Ask an agent to build it here, where you can watch" onClick={onAsk}>
            <span className="empty-glyph">✦</span>
            <span>
              <b>Ask an agent to build it</b>
              <small>It works here under its own name, with you</small>
            </span>
          </button>
          <button className="empty-action" data-tip="Write in a text box: formatted as you type" onClick={onText}>
            <span className="empty-glyph">¶</span>
            <span>
              <b>Write</b>
              <small>
                A text box, formatted as you type · or a{" "}
                <span
                  role="button"
                  tabIndex={0}
                  className="empty-inline"
                  onClick={(e) => {
                    e.stopPropagation();
                    onNote();
                  }}
                  onKeyDown={(e) => e.key === "Enter" && (e.stopPropagation(), onNote())}
                >
                  markdown note
                </span>
              </small>
            </span>
          </button>
        </div>
        {apps.length > 0 && (
          <>
            <div className="f-eyebrow empty-shelf-label">Company apps</div>
            <div className="empty-shelf">
              {apps.slice(0, 8).map((a) => (
                <button
                  key={a.id}
                  className="shelf-app"
                  title={a.description ?? a.url ?? ""}
                  onClick={() => {
                    onFocus();
                    void openUrlAsPanel(a.url!, "app", a);
                  }}
                >
                  <span className="shelf-mark">{a.name.slice(0, 1)}</span>
                  {a.name}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
