/**
 * Settings (#/settings). Five tabs (Renderer is its own file: rune/RendererTab.tsx, which engine draws the board):
 *
 *  - **Plan** — Foundation's own kanban (docs/plan.json): the local copy of the
 *    issues on GitHub, as columns from Needs you to Done. Filters by kind and
 *    milestone, and a search. An admin moves a card by dragging it to another
 *    column (or with Move to… on the opened card); the move writes the file
 *    and the card says so until it's pushed to GitHub.
 *  - **Services** — what this server is connected to (Slack, GitHub, Google,
 *    the agent's runtimes), so a missing key reads as a fact, not a mystery.
 *  - **Places** — the folders on this computer Foundation may read (PlacesTab):
 *    an admin approves them here; the search pane and agents read only inside.
 *  - **Releases** — what each version changed (docs/blog/<version>.md),
 *    newest first, bundled with the app so they open offline.
 *
 * The night orb sits in the head, as on #/design.
 */

import { ErrorCard } from "../components/ErrorCard";
import { ReleaseCard } from "./ReleasePage";
import { useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { isNight, setNight, springs } from "@foundation/ui";
import { api } from "../lib/api";
import { NightOrb } from "../shell/NightOrb";
import { PlacesTab } from "./PlacesTab";
import { UpdatesSection } from "../update/UpdateCard";
import { renderMarkdown } from "../utils/markdown";
import clientPackage from "../../package.json";
import { longDate, releasesFrom, type ReleasePost } from "./releases";
import { RendererTab } from "../rune/RendererTab";
import { ago, boardColumns, counts, issueUrl, PLAN, syncSentence, waitingWords, type CardKind, type Plan, type PlanCard, type PlanFilter } from "./plan";

type Tab = "plan" | "services" | "places" | "renderer" | "releases";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "plan", label: "Plan" },
  { id: "services", label: "Services" },
  { id: "places", label: "Places" },
  { id: "renderer", label: "Renderer" },
  { id: "releases", label: "Releases" },
];

/** the release notes, bundled: every docs/blog/<version>.md, read as text at build time */
export const POSTS = releasesFrom(import.meta.glob("../../../../docs/blog/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>);

export function SettingsPage({ route }: { route: string }) {
  const tab: Tab = route.startsWith("#/settings/services") ? "services" : route.startsWith("#/settings/places") ? "places" : route.startsWith("#/settings/releases") ? "releases" : route.startsWith("#/settings/renderer") ? "renderer" : "plan";
  return (
    <div className="settings-page">
      <header className="design-head settings-head">
        <div>
          <div className="f-eyebrow">Foundation</div>
          <h1>Settings</h1>
        </div>
        <nav className="settings-tabs" aria-label="Settings">
          {TABS.map((t) => (
            <a key={t.id} href={`#/settings/${t.id}`} className={`settings-tab${tab === t.id ? " is-current" : ""}`} aria-current={tab === t.id ? "page" : undefined}>
              {t.label}
            </a>
          ))}
        </nav>
        <div className="settings-spacer" />
        <NightOrb onToggle={() => setNight(!isNight())} />
        <a className="f-pill" href="#/">
          ← Back to the board
        </a>
      </header>
      {tab === "plan" ? (
        <PlanTab />
      ) : tab === "releases" ? (
        <ReleasesTab posts={POSTS} route={route} />
      ) : tab === "places" ? (
        <PlacesTab />
      ) : tab === "renderer" ? (
        <RendererTab />
      ) : (
        <>
          <ServicesTab />
          <UpdatesSection />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- plan

export async function fetchPlan(): Promise<{ plan: Plan | null; canMove: boolean }> {
  return api("/api/plan");
}

export async function moveCard(id: string, status: string): Promise<PlanCard> {
  const r = await api<{ card: PlanCard }>(`/api/plan/cards/${encodeURIComponent(id)}`, { method: "POST", json: { status } });
  return r.card;
}

export async function syncWithGitHub(): Promise<{ plan: Plan; summary: { moved: number; created: number; cards: number } }> {
  return api("/api/plan/sync", { method: "POST", json: {} });
}

export async function addCard(card: NewCardInput): Promise<PlanCard> {
  const r = await api<{ card: PlanCard }>("/api/plan/cards", { method: "POST", json: card });
  return r.card;
}

export interface NewCardInput {
  title: string;
  kind: CardKind;
  milestone: string;
  area: string;
  body?: string;
  request_id: string;
}

export function PlanTab() {
  const [plan, setPlan] = useState<Plan>(PLAN);
  const [canMove, setCanMove] = useState(false);
  /** where the board came from: the copy bundled with the app, or the server's file */
  const [source, setSource] = useState<"bundled" | "server">("bundled");
  const [err, setErr] = useState<string | null>(null);
  const [sync, setSync] = useState<SyncState>({ busy: false });

  useEffect(() => {
    let live = true;
    fetchPlan()
      .then((r) => {
        if (!live) return;
        if (r.plan) {
          setPlan(r.plan);
          setSource("server");
        }
        setCanMove(r.canMove);
      })
      .catch(() => live && setSource("bundled"));
    return () => {
      live = false;
    };
  }, []);

  const onMove = async (id: string, status: string) => {
    const before = plan;
    // the card moves at once; the server's answer confirms it (or puts it back)
    setPlan((p) => ({ ...p, cards: p.cards.map((c) => (c.id === id ? { ...c, status } : c)) }));
    setErr(null);
    try {
      const card = await moveCard(id, status);
      setPlan((p) => ({ ...p, cards: p.cards.map((c) => (c.id === id ? card : c)) }));
    } catch (e) {
      setPlan(before);
      setErr((e as Error).message);
    }
  };

  const onSync = async () => {
    setSync({ busy: true });
    setErr(null);
    try {
      const r = await syncWithGitHub();
      setPlan(r.plan);
      setSync({ busy: false, said: syncSentence(r.summary) });
    } catch (e) {
      setSync({ busy: false });
      setErr((e as Error).message);
    }
  };

  const onCreate = async (input: NewCardInput) => {
    setErr(null);
    const card = await addCard(input);
    setPlan((p) => (p.cards.some((c) => c.id === card.id) ? p : { ...p, cards: [...p.cards, card] }));
    return card;
  };

  return <PlanBoard plan={plan} source={source} canMove={canMove} onMove={onMove} onSync={onSync} onCreate={onCreate} sync={sync} error={err} />;
}

export interface SyncState {
  busy: boolean;
  /** what the last sync did, in a sentence */
  said?: string;
}

const KIND_LABEL: Record<CardKind, string> = { bug: "Bug", plan: "Plan", hookup: "Needs a person" };

export function PlanBoard({
  plan,
  source,
  canMove,
  onMove,
  onSync,
  onCreate,
  sync,
  error,
  height,
}: {
  plan: Plan;
  source: "bundled" | "server";
  canMove: boolean;
  onMove(id: string, status: string): void;
  /** Sync with GitHub (admins; the server runs scripts/plan.mjs sync) */
  onSync?(): void;
  /** a new card (admins); resolves when the server has it */
  onCreate?(input: NewCardInput): Promise<PlanCard>;
  sync?: SyncState;
  error?: string | null;
  /** fixed board height (the design page's demo); the page lets it run */
  height?: number;
}) {
  const [filter, setFilter] = useState<PlanFilter>({});
  const [open, setOpen] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const cols = useMemo(() => boardColumns(plan, filter), [plan, filter]);
  const n = counts(plan);
  const pushed = plan.cards.some((c) => c.issue);
  const moved = plan.cards.filter((c) => c.moved).length;
  const fresh = plan.cards.filter((c) => !c.issue).length;

  return (
    <section className="kb" style={height ? { height } : undefined}>
      <div className="kb-head">
        <div className="kb-title">
          <div className="kb-title-row">
            <h2>The plan</h2>
            {canMove && (onCreate || onSync) && (
              <div className="kb-actions">
                {onCreate && (
                  <button type="button" className="f-pill kb-toggle" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>
                    + New card
                  </button>
                )}
                {onSync && (
                  <button type="button" className="f-pill kb-sync" onClick={onSync} disabled={sync?.busy} title={`Reads every issue on ${plan.repo}, then sends the columns moved here and the cards made here`}>
                    {sync?.busy ? (
                      <>
                        <span className="kb-spin" aria-hidden /> Syncing…
                      </>
                    ) : (
                      <>↻ Sync with GitHub</>
                    )}
                  </button>
                )}
                {sync?.said && !sync.busy && <span className="kb-said" role="status">{sync.said}</span>}
              </div>
            )}
          </div>
          <p>
            {n.open} open · {n.bug} {n.bug === 1 ? "bug" : "bugs"} · {n.plan} {n.plan === 1 ? "plan" : "plans"} · {n.hookup} waiting on a person.{" "}
            {pushed ? (
              <>
                The local copy of{" "}
                <a href={`https://github.com/${plan.repo}/issues?q=label%3Aplan`} target="_blank" rel="noopener">
                  the issues on GitHub ↗
                </a>
                {plan.syncedAt ? (
                  <>
                    , synced <time title={new Date(plan.syncedAt).toLocaleString()}>{ago(plan.syncedAt)}</time>
                  </>
                ) : (
                  ""
                )}
                .
              </>
            ) : (
              <>
                Not on GitHub yet: <code>npm run plan:push</code> makes an issue for every card.
              </>
            )}
            {pushed && moved + fresh > 0 && (
              <>
                {" "}
                <b className="kb-moved-count">{waitingWords(moved, fresh)}</b>, not on GitHub yet.
              </>
            )}
            {source === "bundled" && <span className="kb-source"> Showing the copy bundled with the app.</span>}
          </p>
        </div>
        <div className="kb-filters">
          <FilterChip on={!filter.kind} onClick={() => setFilter((f) => ({ ...f, kind: undefined }))}>
            All
          </FilterChip>
          {(["bug", "plan", "hookup"] as CardKind[]).map((k) => (
            <FilterChip key={k} on={filter.kind === k} onClick={() => setFilter((f) => ({ ...f, kind: f.kind === k ? undefined : k }))}>
              <span className={`kb-kind is-${k}`} />
              {KIND_LABEL[k]}
            </FilterChip>
          ))}
          <select className="kb-select" value={filter.milestone ?? ""} onChange={(e) => setFilter((f) => ({ ...f, milestone: e.target.value || undefined }))} aria-label="Milestone">
            <option value="">Every milestone</option>
            {plan.milestones.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <input className="kb-search" placeholder="Find a card or #issue" aria-label="Find a card or issue" value={filter.query ?? ""} onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value }))} />
        </div>
      </div>
      <AnimatePresence initial={false}>
        {adding && onCreate && (
          <motion.div key="new" className="kb-new-wrap" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={cardSpring}>
            <NewCardForm plan={plan} onCreate={onCreate} onDone={() => setAdding(false)} />
          </motion.div>
        )}
      </AnimatePresence>
      {error && <ErrorCard message={error} />}

      <LayoutGroup>
        <div className="kb-board">
          {cols.map((col) => (
            <div
              key={col.id}
              className={`kb-col is-${col.id}${over === col.id && dragging ? " is-over" : ""}`}
              onDragOver={(e) => {
                if (!dragging) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (over !== col.id) setOver(col.id);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver((o) => (o === col.id ? null : o));
              }}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData("text/plan-card") || dragging;
                setDragging(null);
                setOver(null);
                const card = plan.cards.find((c) => c.id === id);
                if (card && card.status !== col.id) onMove(card.id, col.id);
              }}
            >
              <div className="kb-col-head" title={col.hint}>
                <span className="kb-col-name">{col.name}</span>
                <span className="kb-col-count">{col.cards.length}</span>
              </div>
              <div className="kb-col-hint">{col.hint}</div>
              <div className="kb-col-cards">
                <AnimatePresence initial={false}>
                  {col.cards.map((card) => (
                    <PlanCardView
                      key={card.id}
                      plan={plan}
                      card={card}
                      open={open === card.id}
                      canMove={canMove}
                      dragging={dragging === card.id}
                      onToggle={() => setOpen((o) => (o === card.id ? null : card.id))}
                      onDragStart={() => setDragging(card.id)}
                      onDragEnd={() => {
                        setDragging(null);
                        setOver(null);
                      }}
                      onMove={onMove}
                    />
                  ))}
                </AnimatePresence>
                {col.cards.length === 0 && <div className="kb-col-empty">{filter.kind || filter.milestone || filter.query ? "Nothing here matches." : "Nothing here."}</div>}
              </div>
            </div>
          ))}
        </div>
      </LayoutGroup>
    </section>
  );
}

function FilterChip({ on, onClick, children }: { on: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <button type="button" className={`kb-chip${on ? " is-on" : ""}`} onClick={onClick} aria-pressed={on}>
      {children}
    </button>
  );
}

const cardSpring = { type: "spring", ...springs.camera } as const;

function PlanCardView({
  plan,
  card,
  open,
  canMove,
  dragging,
  onToggle,
  onDragStart,
  onDragEnd,
  onMove,
}: {
  plan: Plan;
  card: PlanCard;
  open: boolean;
  canMove: boolean;
  dragging: boolean;
  onToggle(): void;
  onDragStart(): void;
  onDragEnd(): void;
  onMove(id: string, status: string): void;
}) {
  const milestone = plan.milestones.find((m) => m.id === card.milestone);
  const body = useMemo(() => (open ? renderMarkdown(card.body) : ""), [open, card.body]);
  return (
    <motion.article
      layout="position"
      layoutId={`plan-${card.id}`}
      transition={cardSpring}
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: dragging ? 0.4 : 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97 }}
      className={`kb-card is-${card.kind}${open ? " is-open" : ""}${card.moved ? " is-moved" : ""}`}
    >
      <div
        className="kb-card-face"
        role="button"
        tabIndex={0}
        draggable={canMove}
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plan-card", card.id);
          e.dataTransfer.effectAllowed = "move";
          onDragStart();
        }}
        onDragEnd={onDragEnd}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        aria-expanded={open}
      >
        <div className="kb-card-title">{card.title}</div>
        <div className="kb-card-meta">
          <span className={`kb-kind is-${card.kind}`} title={KIND_LABEL[card.kind]} />
          <span>{milestone?.name ?? card.milestone}</span>
          <span className="kb-card-area">{card.area}</span>
          {card.issue ? (
            <a className="kb-card-issue" href={issueUrl(plan, card.issue)} target="_blank" rel="noopener" draggable={false} onClick={(e) => e.stopPropagation()} title={`Open #${card.issue} on GitHub`}>
              #{card.issue}
            </a>
          ) : (
            <span className="kb-card-issue is-local" title="Made here; the next sync makes it an issue">
              new
            </span>
          )}
        </div>
        {card.moved && (
          <div className="kb-card-moved">
            Moved from {plan.columns.find((c) => c.id === card.moved!.from)?.name ?? card.moved.from} by {card.moved.by}
          </div>
        )}
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div className="kb-card-more" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={cardSpring}>
            <div className="kb-card-body note-rendered" dangerouslySetInnerHTML={{ __html: body }} />
            <div className="kb-card-actions">
              {card.issue ? (
                <a className="f-pill" href={issueUrl(plan, card.issue)} target="_blank" rel="noopener">
                  Open #{card.issue} on GitHub ↗
                </a>
              ) : (
                <span className="kb-card-note">No issue yet</span>
              )}
              {canMove && (
                <label className="kb-move">
                  <span>Move to</span>
                  <select value={card.status} onChange={(e) => onMove(card.id, e.target.value)} onClick={(e) => e.stopPropagation()}>
                    {plan.columns.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.article>
  );
}

function NewCardForm({ plan, onCreate, onDone }: { plan: Plan; onCreate(input: NewCardInput): Promise<PlanCard>; onDone(): void }) {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<CardKind>("bug");
  const [milestone, setMilestone] = useState(plan.milestones[plan.milestones.length - 1]?.id ?? "");
  const [area, setArea] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // one id per card being written: a doubled press makes one card
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const ok = title.trim().length >= 4;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ok || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await onCreate({ title: title.trim(), kind, milestone, area: area.trim() || "general", body: body.trim() || undefined, request_id: requestId });
      setTitle("");
      setBody("");
      setRequestId(crypto.randomUUID());
      onDone();
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="kb-new" onSubmit={submit}>
      <input
        className="kb-new-title"
        autoFocus
        placeholder="What's wrong, or what should we build?"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={140}
        aria-label="Title"
        aria-invalid={err ? true : undefined}
        aria-describedby={err ? "kb-new-error" : undefined}
      />
      <div className="kb-new-row">
        <div className="kb-new-kinds" role="group" aria-label="Kind">
          {(["bug", "plan", "hookup"] as CardKind[]).map((k) => (
            <FilterChip key={k} on={kind === k} onClick={() => setKind(k)}>
              <span className={`kb-kind is-${k}`} />
              {KIND_LABEL[k]}
            </FilterChip>
          ))}
        </div>
        <select className="kb-select" value={milestone} onChange={(e) => setMilestone(e.target.value)} aria-label="Milestone">
          {plan.milestones.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <input className="kb-search kb-new-area" placeholder="Area: wires, sections…" value={area} onChange={(e) => setArea(e.target.value)} aria-label="Area" />
      </div>
      <textarea className="kb-new-body" placeholder="How to see it, or what done looks like (markdown)" value={body} onChange={(e) => setBody(e.target.value)} rows={3} aria-label="Description" />
      <div className="kb-new-row">
        <span className="kb-new-note">{kind === "hookup" ? "Goes to Needs you." : "Goes to Backlog."} Sync with GitHub makes it an issue.</span>
        <button type="button" className="f-pill" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="f-pill is-accent" disabled={!ok || busy}>
          {busy ? "Adding…" : "Add card"}
        </button>
      </div>
      {err && <div id="kb-new-error"><ErrorCard message={err} /></div>}
    </form>
  );
}

// ---------------------------------------------------------------- releases

/** the version this app was built as, so its post can say "this app" */
export const RUNNING = clientPackage.version;

export function ReleasesTab({ posts, route }: { posts: ReleasePost[]; route: string }) {
  // #/settings/releases/0.2.0 opens that post; otherwise the newest
  const asked = /#\/settings\/releases\/([\w.-]+)/.exec(route)?.[1];
  const current = posts.find((p) => p.version === asked) ?? posts[0];
  if (!current) return <p className="design-lede">No release notes yet: they go in docs/blog/&lt;version&gt;.md.</p>;
  return (
    <section className="releases">
      <nav className="releases-list" aria-label="Releases">
        {posts.map((p) => (
          <a key={p.version} href={`#/settings/releases/${p.version}`} className={`releases-item${p === current ? " is-current" : ""}`} aria-current={p === current ? "page" : undefined}>
            <span className="releases-version">
              {p.version}
              {p.version === RUNNING && <span className="releases-running">this app</span>}
            </span>
            <span className="releases-date">{longDate(p.date)}</span>
          </a>
        ))}
      </nav>
      <article className="releases-post">
        <div className="f-eyebrow">
          Foundation {current.version} · {longDate(current.date)}
        </div>
        <h2>{current.title}</h2>
        {/* what it's made of (the bar, the parts as tiles), then the notes: the release page's own pieces */}
        <ReleaseCard key={current.version} post={current} compact />
      </article>
    </section>
  );
}

// ---------------------------------------------------------------- services

interface FlowformLink {
  connected: boolean;
  server: string;
  scope?: string;
  connectedAt?: number;
  /** Foundation may download your Flowform files (it keeps your Flowform session for that, encrypted) */
  downloads?: boolean;
  since?: number;
}

const inDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Your own link to Flowform (its boards and files, read-only). Unlike the rows
 * under it, this one is per person and is connected here: Connect opens
 * Flowform's approval page (the system browser in the desktop app), and the
 * row waits for it.
 */
function FlowformRow() {
  const [link, setLink] = useState<FlowformLink | null>(null);
  const [tools, setTools] = useState<number | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [allowing, setAllowing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const live = useRef(true);
  const read = () => api<FlowformLink>("/api/flowform/link").then((l) => (live.current && setLink(l), l));
  useEffect(() => {
    live.current = true;
    read().catch((e: Error) => setErr(e.message));
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    if (!link?.connected) return setTools(null);
    api<{ tools: unknown[] }>("/api/flowform/tools").then(
      (t) => live.current && setTools(t.tools.length),
      (e: Error) => live.current && setErr(e.message),
    );
  }, [link?.connected]);

  const connect = async () => {
    setErr(null);
    // open the tab inside the click (a tab opened after an await is a blocked pop-up)
    const tab = inDesktop ? null : window.open("", "_blank");
    try {
      const { url } = await api<{ url: string }>("/api/flowform/link", { method: "POST" });
      if (tab) tab.location.href = url;
      else await openUrl(url);
      setWaiting(true);
      // the approval happens on Flowform's page; ask the server until it has landed (ten minutes, as the server allows)
      const until = Date.now() + 10 * 60_000;
      while (live.current && Date.now() < until) {
        await new Promise((ok) => setTimeout(ok, 1500));
        if ((await read().catch(() => null))?.connected) break;
      }
    } catch (e) {
      tab?.close();
      setErr((e as Error).message);
    } finally {
      if (live.current) setWaiting(false);
    }
  };
  /** run Flowform's own sign-in once more, so Foundation keeps that session for downloading your files */
  const allow = async () => {
    setErr(null);
    const tab = inDesktop ? null : window.open("", "_blank");
    try {
      const { url } = await api<{ url: string }>("/api/flowform/files/allow", { method: "POST" });
      if (tab) tab.location.href = url;
      else await openUrl(url);
      setAllowing(true);
      const until = Date.now() + 10 * 60_000;
      while (live.current && Date.now() < until) {
        await new Promise((ok) => setTimeout(ok, 1500));
        if ((await read().catch(() => null))?.downloads) break;
      }
    } catch (e) {
      tab?.close();
      setErr((e as Error).message);
    } finally {
      if (live.current) setAllowing(false);
    }
  };
  const stop = async () => {
    setErr(null);
    try {
      await api("/api/flowform/files/stop", { method: "POST" });
      await read();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const disconnect = async () => {
    setErr(null);
    try {
      await api("/api/flowform/unlink", { method: "POST" });
      await read();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const on = Boolean(link?.connected);
  return (
    <div className="services-row">
      <span className={`f-dot ${on ? "is-ok" : "is-warn"}`} />
      <span className="services-name">Flowform · your boards and files</span>
      <span className="services-detail">
        {!link
          ? "Asking the server…"
          : on
            ? `Connected to ${link.server}, read-only${tools === null ? "" : ` · ${tools} tools`}${link.connectedAt ? ` · since ${longDate(new Date(link.connectedAt).toLocaleDateString("en-CA"))}` : ""}`
            : waiting
              ? `Waiting for you to approve it on ${link.server}…`
              : "Not connected for you"}
      </span>
      <span className="services-act">
        {on ? (
          <button type="button" className="f-pill" onClick={disconnect} data-tip="Revokes Foundation's access at Flowform and forgets it here">
            Disconnect
          </button>
        ) : (
          <button type="button" className="f-pill is-accent" onClick={connect} disabled={!link || waiting}>
            {waiting ? "Waiting…" : "Connect Flowform"}
          </button>
        )}
      </span>
      {!on && link && <span className="services-how">Opens Flowform's own page to approve. Foundation asks only to read your boards and search your files (never to write), as you, and you can disconnect here.</span>}
      {err && <span className="services-how is-bad" role="alert">{err}</span>}
      {on && (
        <>
          <span className={`f-dot ${link?.downloads ? "is-ok" : "is-warn"}`} />
          <span className="services-name">Flowform · file downloads</span>
          <span className="services-detail">
            {link?.downloads
              ? `Allowed${link.since ? ` · since ${longDate(new Date(link.since).toLocaleDateString("en-CA"))}` : ""}: images, videos and files come in with your rooms`
              : allowing
                ? "Waiting for you to sign in to Flowform…"
                : "Not allowed: images and files in your rooms show by name"}
          </span>
          <span className="services-act">
            {link?.downloads ? (
              <button type="button" className="f-pill" onClick={stop} data-tip="Ends that Flowform session and forgets it here. Files already brought in stay">
                Stop
              </button>
            ) : (
              <button type="button" className="f-pill is-accent" onClick={allow} disabled={allowing}>
                {allowing ? "Waiting…" : "Allow file downloads"}
              </button>
            )}
          </span>
          {!link?.downloads && (
            <span className="services-how">
              Signs you in to Flowform once more and keeps that session, encrypted, to download your files and nothing else. It has to be the Flowform account you sign in to Foundation with.
            </span>
          )}
        </>
      )}
    </div>
  );
}

interface Integrations {
  slack: boolean;
  github: boolean | "cli";
  google: boolean;
  anthropicApi: boolean;
  agent: { subscription: boolean; subscriptionNote?: string | null; api: boolean; model: string };
}

export function ServicesTab() {
  const [s, setS] = useState<Integrations | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<Integrations>("/api/integrations").then(setS, (e: Error) => setErr(e.message));
  }, []);
  const rows: Array<{ name: string; on: boolean | null; detail: string; how: string }> = s
    ? [
        { name: "Agent · subscription", on: s.agent.subscription, detail: s.agent.subscription ? "Claude Code is installed here" : (s.agent.subscriptionNote ?? "Claude Code isn't on this computer's PATH"), how: "Install Claude Code and sign in (`claude`). A sign-in that has expired shows up when an agent runs." },
        { name: "Agent · API", on: s.agent.api, detail: s.agent.api ? `On credits, ${s.agent.model}` : "No API key", how: "Set ANTHROPIC_API_KEY." },
        { name: "Slack", on: s.slack, detail: s.slack ? "Bot token set" : "Not connected", how: "Create the app from docs/slack-app-manifest.yml and set SLACK_BOT_TOKEN." },
        { name: "GitHub", on: s.github === true || s.github === "cli", detail: s.github === "cli" ? "Through the gh login" : s.github ? "Token set" : "No token", how: "Set GITHUB_TOKEN, or sign in with gh." },
        { name: "Google sign-in (own client)", on: s.google, detail: s.google ? "Own client" : "Through flowform", how: "Optional: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET for a hosted server." },
      ]
    : [];
  return (
    <section className="services">
      <p className="design-lede">What this server is connected to. Every integration is off until its key exists; the server always starts. SPEC §6 has the full list.</p>
      {err && <ErrorCard message={err} />}
      {!s && !err && <div className="kb-col-empty" role="status">Asking the server…</div>}
      <div className="services-list">
        <FlowformRow />
        {rows.map((r) => (
          <div key={r.name} className="services-row">
            <span className={`f-dot ${r.on ? "is-ok" : "is-warn"}`} />
            <span className="services-name">{r.name}</span>
            <span className="services-detail">{r.detail}</span>
            {!r.on && <span className="services-how">{r.how}</span>}
          </div>
        ))}
      </div>
    </section>
  );
}
