/**
 * ⌘K — one field for everything: search the board, files (CAD too), Slack,
 * GitHub and apps; open a link or an app as a live panel; ask the agent;
 * run any board action. Local results answer first (FTS, a few ms), remote
 * sources stream in after.
 */

import { goSettings, goToday } from "../lib/place";
import { openCouncil } from "../lib/councilOpen";
import { newCharacter, openCharacterStudio } from "../lib/characterStudio";
import { keys } from "../lib/keys";
import { openSlackBoard } from "../lib/slackBoard";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { SearchHit } from "@foundation/protocol";
import { isNight, setNight } from "@foundation/ui";
import { api, logout, search } from "../lib/api";
import { addNote, addPanel, appendSectionLocal, createTable, getState, requestSnap, startMachine, updatePanel } from "../state/store";
import { askAgent, setUi, toast, useUi } from "../state/ui";
import { activeBoard } from "../sync/board";
import { snippetHtml } from "../lib/snippet";
import { stopAllCrew } from "../state/sessions";

interface Action {
  id: string;
  label: string;
  hint?: string;
  glyph: string;
  keys?: string;
  run(): unknown;
}

const SOURCE_LABEL: Record<SearchHit["source"], string> = {
  board: "Board",
  file: "File",
  slack: "Slack",
  huddle: "Huddle",
  github: "GitHub",
  app: "App",
  activity: "Activity",
  flowform: "Flowform",
  chat: "ChatForm",
};

export function looksLikeUrl(q: string) {
  return /^(https?:\/\/|localhost:|[\w-]+\.[a-z]{2,}(\/|$))/i.test(q.trim());
}

export function normalizeUrl(q: string) {
  const t = q.trim();
  if (/^https?:\/\//i.test(t)) return t;
  if (/^localhost:/i.test(t)) return `http://${t}`;
  return `https://${t}`;
}

/** Open any URL as a live panel: probe it (title, repo, MCP, ports, frame policy) first. */
export async function openUrlAsPanel(
  raw: string,
  kind: "app" | "link" | "machine" = "app",
  known: { name?: string; repo?: string | null; mcp?: string | null; description?: string | null } = {},
  into?: string,
  /** called as soon as the card exists, before the probe answers (drops place it) */
  created?: (id: string) => void,
) {
  const url = normalizeUrl(raw);
  const st = getState();
  const sectionId = into && st.sections[into] ? into : st.activeSectionId in st.sections ? st.activeSectionId : Object.keys(st.sections)[0];
  // what the registry already knows shows at once; the probe fills in the rest
  const p = addPanel(sectionId, {
    panel: kind,
    name: known.name ?? new URL(url).host,
    url,
    repo: known.repo ?? undefined,
    mcp: known.mcp ?? undefined,
    text: known.description ?? undefined,
  }, into ? { focus: false } : {});
  created?.(p.id);
  try {
    const probe = await api<{ name?: string; description?: string; repo?: string; mcp?: string; ports?: Array<{ name: string; dir: "in" | "out"; type?: string }>; embeddable: boolean; reason?: string }>(
      "/api/apps/probe",
      { method: "POST", json: { url } },
    );
    updatePanel(p.id, {
      name: known.name ?? (probe.name?.slice(0, 60) || p.name),
      repo: probe.repo ?? known.repo ?? undefined,
      mcp: probe.mcp ?? known.mcp ?? undefined,
      text: probe.embeddable ? (probe.description ?? known.description ?? undefined) : `${probe.reason ?? "can't be framed"} — opens in a tab`,
      ports: (probe.ports ?? []).map((pt) => ({ ...pt, id: `port_${Math.random().toString(36).slice(2, 9)}` })),
      ...(probe.embeddable ? {} : { panel: "link" as const }),
    });
    if (probe.repo) toast(`Found its repo · ${probe.repo}`, "ok");
  } catch {
    /* the panel still works without the probe */
  }
  return p;
}

export function CommandBar() {
  const ui = useUi();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [sel, setSel] = useState(0);
  const [loading, setLoading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const board = activeBoard()?.boardId ?? "company";

  useEffect(() => {
    if (ui.command) {
      setQ("");
      setHits([]);
      setSel(0);
      requestAnimationFrame(() => input.current?.focus());
    }
  }, [ui.command]);

  // local first, then everything
  useEffect(() => {
    const term = q.trim();
    if (!term || looksLikeUrl(term)) {
      setHits([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const local = await search(term, board, false, ctrl.signal);
        setHits(local.hits);
        const all = await search(term, board, true, ctrl.signal);
        setHits(all.hits);
      } catch {
        /* aborted */
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }, 90);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q, board]);

  const close = () => setUi({ command: false });

  const actions: Action[] = useMemo(() => {
    const st = getState();
    const sec = st.activeSectionId;
    const term = q.trim();
    const list: Action[] = [];
    if (term && looksLikeUrl(term)) {
      list.push(
        { id: "open-app", glyph: "◳", label: `Open ${term} as a live app`, hint: "finds its repo, MCP and ports", run: () => openUrlAsPanel(term, "app") },
        { id: "open-machine", glyph: "▤", label: `Open ${term} as a machine`, hint: "VM, container, noVNC, ttyd, code-server", run: () => openUrlAsPanel(term, "machine") },
        { id: "rea", glyph: "⌬", label: `Reverse-engineer ${term}`, hint: "REA — queued, you press Run", run: () => askAgent(`Reverse-engineer ${normalizeUrl(term)} — map how it works and what we could reuse.`) },
      );
    }
    if (term) list.push({ id: "ask", glyph: "✦", label: `Ask the agent: “${term}”`, keys: keys("mod+enter"), run: () => askAgent(term) });
    if (term && !looksLikeUrl(term))
      list.push({ id: "pipeline-named", glyph: "◆", label: `Start a design pipeline: “${term}”`, hint: "Brief → Concept → CAD → Simulate → Review → Release", run: () => startPipeline(term) });
    list.push(
      { id: "present", glyph: "▶", label: "Present this grid", keys: "P", run: () => setUi({ presenting: true }) },
      { id: "company", glyph: "◉", label: "Go to the company grid", hint: "every app we run, live", run: () => void window.dispatchEvent(new CustomEvent("foundation:board", { detail: "company" })) },
      { id: "slack-board", glyph: "#", label: "Open the Slack board", hint: "a section for every channel, kept live", run: () => void openSlackBoard() },
      { id: "council", glyph: "⚇", label: "Council: the agents on this grid", hint: "each agent as a character, in its cursor's colour", run: () => openCouncil({ kind: "board" }) },
      ...(sec && st.allSections[sec] ? [{ id: "council-section", glyph: "⚇", label: `Council: the agents in ${st.allSections[sec].name}`, hint: "who's at work in this section", run: () => openCouncil({ kind: "section", id: sec }) }] : []),
      { id: "character-studio", glyph: "☺", label: "Open the Character studio", hint: "inspiration → sheet → 3D model or mesh avatar, for the council", run: () => void openCharacterStudio() },
      ...(sec ? [{ id: "character", glyph: "☺", label: "Add a character to this section", hint: "a card that draws, models and animates an avatar", run: () => void newCharacter(sec) }] : []),
      { id: "note", glyph: "▤", label: "Add a note", run: () => void addNote(sec) },
      { id: "table", glyph: "⊞", label: "Add a table", run: () => void createTable(sec) },
      { id: "machine", glyph: "▣", label: "Start a machine in this section", hint: "Linux on Kiri or Docker, with a shared terminal", run: () => void startMachine(sec) },
      { id: "section", glyph: "▥", label: "New section", run: () => void appendSectionLocal(term && !looksLikeUrl(term) ? term : "New section") },
      { id: "upload", glyph: "⇪", label: "Upload files…", hint: "designs, CAD, PDFs, video", run: () => void window.dispatchEvent(new CustomEvent("foundation:upload")) },
      { id: "cad", glyph: "✉", label: "Ask someone for the latest CAD…", hint: "Hermes keeps following up", run: () => askAgent("Ask ") },
      { id: "pipeline", glyph: "◆", label: "Start a design pipeline…", hint: "design → CAD → simulation → release, panel by panel", run: () => askAgent("Start a design pipeline for ") },
      { id: "vision", glyph: "◈", label: "Design something with Vision…", run: () => askAgent("Brief Vision: design ") },
      { id: "stop-crew", glyph: "■", label: "Stop all my agents on this board", hint: "the crew-wide stop, helpers too", run: () => void stopAllOnBoard() },
      { id: "connect", glyph: "⌁", label: "Connect Claude Code / Codex to this grid", hint: "copies an MCP command; more in Settings → Agents", run: copyMcpCommand },
      { id: "today", glyph: "◌", label: "Today", hint: "the Shiba, your todos, the company's apps", run: () => goToday() },
      { id: "settings", glyph: "⚙", label: "Settings", hint: "appearance, agents, avatars, the plan, releases", run: () => goSettings() },
      { id: "design", glyph: "◐", label: "Design language", hint: "tokens, type, motion, effects", run: () => goSettings("design") },
      { id: "night", glyph: isNight() ? "☀" : "☾", label: isNight() ? "Day" : "Night", run: () => setNight(!isNight()) },
      { id: "logout", glyph: "⏻", label: "Sign out", run: async () => {
          await logout();
          window.location.reload();
        } },
    );
    if (!term || looksLikeUrl(term)) return list;
    const t = term.toLowerCase();
    return list.filter((a) => a.id === "ask" || a.id === "section" || a.id === "pipeline-named" || a.label.toLowerCase().includes(t) || a.hint?.toLowerCase().includes(t));
  }, [q]);

  const rows: Array<{ kind: "action"; a: Action } | { kind: "hit"; h: SearchHit }> = [
    ...actions.slice(0, q ? 4 : 20).map((a) => ({ kind: "action" as const, a })),
    ...hits.slice(0, 14).map((h) => ({ kind: "hit" as const, h })),
  ];

  const choose = (i: number) => {
    const r = rows[i];
    if (!r) return;
    close();
    if (r.kind === "action") void r.a.run();
    else openHit(r.h);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(rows.length - 1, s + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) {
        close();
        askAgent(q);
      } else choose(sel);
    } else if (e.key === "Escape") {
      close();
    }
  };

  return (
    <AnimatePresence>
      {ui.command && (
        <motion.div className="cmd-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }} onPointerDown={close}>
          <motion.div
            className="cmd f-glass"
            initial={{ opacity: 0, y: -14, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.985 }}
            transition={{ type: "spring", stiffness: 260, damping: 26 }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="cmd-field">
              <span className="cmd-glyph">⌕</span>
              <input
                ref={input}
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setSel(0);
                }}
                onKeyDown={onKey}
                autoFocus
                placeholder="Search everything, paste a link, or ask the agent…"
                spellCheck={false}
              />
              {loading && <span className="cmd-spin" />}
              <span className="f-kbd">esc</span>
            </div>
            <div className="cmd-list">
              {rows.map((r, i) =>
                r.kind === "action" ? (
                  <button key={r.a.id} className={`cmd-row${i === sel ? " is-sel" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => choose(i)}>
                    <span className="cmd-row-glyph">{r.a.glyph}</span>
                    <span className="cmd-row-label">{r.a.label}</span>
                    {r.a.hint && <span className="cmd-row-hint">{r.a.hint}</span>}
                    {r.a.keys && <span className="f-kbd">{r.a.keys}</span>}
                  </button>
                ) : (
                  <button key={r.h.id + i} className={`cmd-row is-hit${i === sel ? " is-sel" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => choose(i)}>
                    <span className={`cmd-src src-${r.h.source}`}>{SOURCE_LABEL[r.h.source]}</span>
                    <span className="cmd-row-label">{r.h.title}</span>
                    <span className="cmd-row-hint" dangerouslySetInnerHTML={{ __html: snippetHtml(r.h.snippet) }} />
                  </button>
                ),
              )}
              {q && !loading && hits.length === 0 && !looksLikeUrl(q) && <div className="cmd-empty">Nothing found yet — {keys("mod+enter")} asks the agent.</div>}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}


export function openHit(h: SearchHit) {
  if (h.objectId && (getState().panels[h.objectId] || getState().notes[h.objectId] || getState().tables[h.objectId] || getState().media[h.objectId] || getState().maps[h.objectId])) {
    requestSnap({ kind: "object", id: h.objectId });
    return;
  }
  if (h.source === "file" && h.url) {
    const st = getState();
    const fileId = h.id.replace(/^file:/, "");
    addPanel(st.activeSectionId, { panel: "file", name: h.title, fileId });
    return;
  }
  if (h.source === "app" && h.url) {
    void openUrlAsPanel(h.url, "app", { name: h.title, description: h.snippet });
    return;
  }
  if (h.url) return void window.open(h.url, "_blank", "noopener");
  // a Flowform file with no address of its own: it comes in by being put somewhere, so open where that's done
  if (h.source === "flowform") {
    setUi({ search: true });
    toast("Pull it out of Search onto the grid to bring it in");
  }
}

/** a pipeline straight from ⌘K: the six stages land in a new section and the camera goes there */
async function startPipeline(name: string) {
  try {
    const board = activeBoard()?.boardId ?? "company";
    const r = await api<{ result: { section: string } }>(`/api/boards/${encodeURIComponent(board)}/tools/start_design_pipeline`, {
      method: "POST",
      json: { name, goal: `Write the brief for ${name}: what it is, for whom, and how we'll know it's right.` },
    });
    requestSnap({ kind: "section", id: r.result.section });
    toast(`Pipeline “${name}” — start with the brief`, "ok");
  } catch (e) {
    toast((e as Error).message, "bad");
  }
}

export async function copyMcpCommand() {
  try {
    const { token, mcp } = await api<{ token: string; mcp: string }>("/api/agent/token", { method: "POST" });
    const board = activeBoard()?.boardId ?? "company";
    const url = mcp.replace(/board=[^&]+/, `board=${board}`);
    const cmd = `claude mcp add foundation --transport http "${url}" --header "Authorization: Bearer ${token}"`;
    await navigator.clipboard.writeText(cmd);
    toast("Copied — paste it in a terminal to give Claude Code this board", "ok");
  } catch (e) {
    toast((e as Error).message, "bad");
  }
}

/** ⌘K → Stop all my agents: the crew-wide stop, said in a toast */
export async function stopAllOnBoard() {
  const board = activeBoard()?.boardId;
  if (!board) return;
  try {
    const n = await stopAllCrew(board);
    toast(n ? `Stopped ${n === 1 ? "your agent" : `all ${n} of your agents`}` : "None of your agents were working here");
  } catch (e) {
    toast(`Couldn't stop them: ${(e as Error).message}`, "bad");
  }
}
