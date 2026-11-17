/**
 * Live company data — the apps Form Industries runs on, read where they live:
 *
 * - FactoryForm (Express + SQLite, :3001): ERP summary, stations, work orders,
 *   and an SSE refresh stream. No CORS there, so Foundation reads it server-side.
 * - BomForm (remote MCP, stateless JSON-RPC over HTTP, bearer + private CA):
 *   projects, certification progress, critical components, BOM costs.
 * - Vision (desktop): no HTTP API yet — the connector reports what's reachable
 *   (Vision Code/T3 at its address, usually :3783 (t3paths.ts), the Archive on :63727).
 * - Airform Data Room: public site, linked.
 *
 * Every connector answers { ok, summary, metrics, flows } so the company
 * view can draw any of them the same way, and says plainly when it's offline.
 */

import { EventEmitter } from "node:events";
import { plural } from "./words.ts";
import { config } from "./config.ts";
import { callMcpTool } from "./mcpclient.ts";
import { one } from "./db.ts";
import { t3Url } from "./t3paths.ts";

export interface ConnectorState {
  id: string;
  name: string;
  ok: boolean;
  url: string;
  summary: string;
  metrics: Array<{ label: string; value: string | number; tone?: "ok" | "warn" | "bad" }>;
  /** small visual strips: one dot per thing (stations by status, cert items …) */
  strips?: Array<{ label: string; dots: Array<{ name: string; tone: "ok" | "warn" | "bad" | "idle" }> }>;
  /** short lists worth reading: open alerts, overdue POs … */
  lists?: Array<{ title: string; items: Array<{ text: string; tone?: "ok" | "warn" | "bad" }> }>;
  /** where the numbers come from, when it isn't the live system of record */
  provenance?: string;
  /** the badge: "prototype", "demo data" … */
  provenanceLabel?: string;
  /** pushed live (event stream) rather than polled */
  live?: boolean;
  detail?: unknown;
  checkedAt: number;
}

/** The company map: which app feeds which, and with what. */
export const COMPANY_FLOWS: Array<{ from: string; to: string; carries: string }> = [
  { from: "vision", to: "bomform", carries: "designs → parts & BOM lines" },
  { from: "bomform", to: "factoryform", carries: "BOMs & critical parts (packs, shared SKU NNNNN-NNNNN)" },
  { from: "bomform", to: "dataroom", carries: "cert progress & costs (daily sync)" },
  { from: "factoryform", to: "dataroom", carries: "builds, inventory value" },
  { from: "factoryform", to: "foundation", carries: "stations, work orders, alerts (live SSE)" },
  { from: "creation", to: "vision", carries: "brand & merchandise designs" },
  { from: "foundation", to: "vision", carries: "design briefs from agents" },
];

export const CONNECTORS = [
  { id: "vision", name: "Vision", role: "Design, simulation, CAD (ModelForm, ElectroForm, Lab)" },
  { id: "bomform", name: "BomForm", role: "BOMs, certification, critical components" },
  { id: "factoryform", name: "FactoryForm", role: "Inventory, stations, work orders, builds" },
  { id: "dataroom", name: "Airform Data Room", role: "Programs, economics, investors" },
  { id: "creation", name: "Creation", role: "Brand, merchandise, studio" },
  { id: "foundation", name: "Foundation", role: "This grid — people, apps and agents" },
];

const cache = new Map<string, ConnectorState>();
const TTL = 20_000;

async function timed<T>(p: Promise<T>, ms = 3000): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timed out")), ms))]);
}

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await timed(fetch(url, { headers }));
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

interface FfBootstrap {
  stations?: Array<{ id: string; name: string; shortName?: string; status: string; wip?: number; provenance?: string }>;
  units?: Array<{ id: string; serial: string; status: string; stationId?: string | null; provenance?: string }>;
  alerts?: Array<{ id: string; title: string; severity: string; status: string; provenance?: string }>;
  purchaseOrders?: Array<{ id: string; status?: string; provenance?: string }>;
  bom?: unknown[];
  deployments?: unknown[];
  meta?: { mode?: string; demoData?: boolean; sourceSnapshotDate?: string };
}

async function factoryform(): Promise<ConnectorState> {
  const base = config.connectors.factoryform.replace(/\/$/, "");
  const [s, boot] = await Promise.all([
    getJson<{ items: number; inventoryValue: number; negativeStock: number; belowReorderPoint: number; openPurchaseOrders: number; overduePurchaseOrders: number; buildsThisMonth: number }>(`${base}/api/erp/summary`),
    getJson<FfBootstrap>(`${base}/api/bootstrap`).catch(() => ({}) as FfBootstrap),
  ]);
  const stations = boot.stations ?? [];
  const units = boot.units ?? [];
  const alerts = (boot.alerts ?? []).filter((a) => a.status !== "resolved" && a.status !== "closed");
  const inProgress = units.filter((u) => u.status !== "completed" && u.status !== "shipped").length;
  const completed = units.filter((u) => u.status === "completed" || u.status === "shipped").length;
  const attention = stations.filter((st) => st.status === "attention").length;
  // FactoryForm's rule: provenance is shown, never hidden — say exactly what's demo and what's imported
  const count = (xs: Array<{ provenance?: string }>, p: string) => xs.filter((x) => x.provenance === p).length;
  const parts: string[] = [];
  if (count(stations, "demo")) parts.push(`stations demo`);
  if (count(units, "imported")) parts.push(`${count(units, "imported")} units imported${boot.meta?.sourceSnapshotDate ? ` (snapshot ${boot.meta.sourceSnapshotDate})` : ""}`);
  if (count(boot.alerts ?? [], "demo")) parts.push(`${count(boot.alerts ?? [], "demo")} demo alerts`);
  const provenance = boot.meta?.demoData || boot.meta?.mode === "prototype" ? `${boot.meta?.mode ?? "demo"}: ${parts.join(" · ")}` : undefined;
  const provenanceLabel = boot.meta?.mode === "prototype" ? "prototype" : provenance ? "demo data" : undefined;
  const erp = s.items > 0;
  const tone = (st: string) => (st === "running" ? "ok" : st === "attention" ? "warn" : st === "down" || st === "blocked" ? "bad" : "idle") as "ok" | "warn" | "bad" | "idle";
  return {
    id: "factoryform",
    name: "FactoryForm",
    ok: true,
    url: base,
    live: watching.has("factoryform"),
    provenance,
    provenanceLabel,
    summary: `${stations.length} stations · ${inProgress} units in progress · ${completed} completed${erp ? ` · $${Math.round(s.inventoryValue).toLocaleString()} on hand` : ""}`,
    metrics: [
      { label: "Units in progress", value: inProgress },
      { label: "Stations needing attention", value: attention, tone: attention ? "warn" : "ok" },
      { label: "Open alerts", value: alerts.length, tone: alerts.length ? "warn" : "ok" },
      ...(erp
        ? [
            { label: "Inventory value", value: `$${Math.round(s.inventoryValue).toLocaleString()}` },
            { label: "Below reorder", value: s.belowReorderPoint, tone: s.belowReorderPoint ? ("warn" as const) : ("ok" as const) },
            { label: "Overdue POs", value: s.overduePurchaseOrders, tone: s.overduePurchaseOrders ? ("warn" as const) : ("ok" as const) },
          ]
        : [
            { label: "Purchase orders", value: (boot.purchaseOrders ?? []).length },
            { label: "BOM lines", value: (boot.bom ?? []).length },
            { label: "Inventory (ERP)", value: "not imported" },
          ]),
    ],
    strips: stations.length ? [{ label: "Stations", dots: stations.map((st) => ({ name: `${st.shortName ?? st.name} · ${st.status}${st.wip ? ` · ${st.wip} WIP` : ""}`, tone: tone(st.status) })) }] : undefined,
    lists: alerts.length ? [{ title: "Open alerts", items: alerts.slice(0, 3).map((a) => ({ text: a.title, tone: a.severity === "critical" ? ("bad" as const) : ("warn" as const) })) }] : undefined,
    detail: { summary: s, stations, alerts },
    checkedAt: Date.now(),
  };
}

// ---------- live: FactoryForm's event stream ----------

/** emits "change" with a connector id whenever a pushed update lands */
export const connectorEvents = new EventEmitter();
connectorEvents.setMaxListeners(200);
const watching = new Set<string>();

/**
 * Follow FactoryForm's SSE stream (/api/events): every `refresh` drops the
 * cached state and tells every open Foundation client to refetch — the floor
 * updates on the board within a second instead of the 20 s poll.
 */
export function watchFactoryForm() {
  const base = config.connectors.factoryform.replace(/\/$/, "");
  let backoff = 1000;
  const connect = async () => {
    try {
      const res = await fetch(`${base}/api/events`, { headers: { accept: "text/event-stream" } });
      if (!res.ok || !res.body) throw new Error(`${res.status}`);
      watching.add("factoryform");
      backoff = 1000;
      cache.delete("factoryform");
      connectorEvents.emit("change", "factoryform");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (/^event:\s*refresh/m.test(chunk)) {
            cache.delete("factoryform");
            connectorEvents.emit("change", "factoryform");
          }
        }
      }
      throw new Error("stream ended");
    } catch {
      if (watching.delete("factoryform")) {
        cache.delete("factoryform");
        connectorEvents.emit("change", "factoryform");
      }
      setTimeout(connect, backoff);
      backoff = Math.min(30_000, backoff * 2);
    }
  };
  void connect();
}

interface DataRoomBomform {
  fetchedAt: string;
  lastSync: string | null;
  counts: { reviews: number; itemsOpen: number; itemsWithUs: number; todosOpen: number; testsPassed: number; testsPlanned: number; testsFailed: number; criticalTotal: number; criticalDocumented: number };
  certProjects: Array<{ code: string; name: string; agency: string | null; stage: string | null; itemsTotal: number; itemsResolved: number; itemsOpen: number }>;
  critical: { total: number; documented: number; undocumented: Array<{ partNumber: string; name: string; vendor: string | null; docStatus: string }> };
  costs: Array<{ code: string; partCount: number; pricedPartCount: number; missingPriceCount: number }>;
  submissions: Array<{ vendor: string | null; title: string | null; shippedAt: string | null }>;
}

/**
 * BomForm, read two ways: directly over its MCP when this server holds a
 * BomForm key, otherwise from the copy the Airform Data Room syncs daily
 * (its read-only /api/foundation/bomform digest). The copy says how old it is.
 */
async function bomform(): Promise<ConnectorState> {
  const url = process.env.BOMFORM_MCP_URL;
  const key = process.env.BOMFORM_API_KEY;
  if (url && key) return bomformDirect(url, key);
  const roomUrl = process.env.DATAROOM_BOMFORM_URL;
  const roomToken = process.env.DATAROOM_READ_TOKEN;
  if (!roomUrl || !roomToken) throw new Error("no BomForm key here and no Data Room copy configured (SPEC §6.5)");
  const res = await timed(fetch(roomUrl, { headers: { authorization: `Bearer ${roomToken}` } }), 20_000);
  if (res.status === 404) throw new Error("the Data Room hasn't stored a BomForm snapshot yet");
  if (!res.ok) throw new Error(`the Data Room answered ${res.status}`);
  const d = (await res.json()) as DataRoomBomform;
  const c = d.counts;
  const items = d.certProjects.reduce((a, p) => a + p.itemsTotal, 0);
  const resolved = d.certProjects.reduce((a, p) => a + p.itemsResolved, 0);
  const missingPrice = d.costs.reduce((a, p) => a + p.missingPriceCount, 0);
  const syncedAt = d.lastSync ?? d.fetchedAt;
  const ageDays = Math.floor((Date.now() - Date.parse(syncedAt)) / 864e5);
  const when = new Date(syncedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const stale = ageDays >= 2;
  return {
    id: "bomform",
    name: "BomForm",
    ok: true,
    url: roomUrl.replace(/\/api\/foundation\/bomform$/, "/admin"),
    provenance: `Airform Data Room's copy, synced ${when} (${ageDays === 0 ? "today" : `${ageDays} day${ageDays === 1 ? "" : "s"} ago`})${stale ? " — the daily sync has stopped; check BOMFORM_API_KEY and CRON_SECRET on the Data Room" : ""}`,
    provenanceLabel: stale ? `copy · ${ageDays}d old` : "Data Room copy",
    summary: `${plural(d.certProjects.length, "cert program")} · ${plural(c.itemsOpen, "item")} open (${c.itemsWithUs} with us) · ${c.criticalDocumented}/${c.criticalTotal} critical parts documented`,
    metrics: [
      { label: "Cert items resolved", value: items ? `${Math.round((resolved / items) * 100)}%` : "unknown" },
      { label: "Open items with us", value: c.itemsWithUs, tone: c.itemsWithUs ? "warn" : "ok" },
      { label: "Critical parts documented", value: `${c.criticalDocumented}/${c.criticalTotal}`, tone: c.criticalDocumented < c.criticalTotal ? "warn" : "ok" },
      { label: "Tests passed", value: `${c.testsPassed}/${c.testsPassed + c.testsPlanned + c.testsFailed}`, tone: c.testsFailed ? "bad" : undefined },
      { label: "Parts missing a price", value: missingPrice, tone: missingPrice ? "warn" : "ok" },
      { label: "Open to-dos", value: c.todosOpen },
    ],
    strips: d.certProjects.length
      ? [
          {
            label: "Cert items",
            dots: d.certProjects.flatMap((p) => {
              // one dot per tenth of a program's items: resolved green, open amber
              const n = Math.max(1, Math.round(p.itemsTotal / 10));
              const done = Math.round((p.itemsResolved / Math.max(1, p.itemsTotal)) * n);
              return Array.from({ length: n }, (_, i) => ({ name: `${p.code} · ${p.agency ?? ""} · ${p.stage ?? ""} · ${p.itemsResolved}/${p.itemsTotal}`, tone: (i < done ? "ok" : "warn") as "ok" | "warn" }));
            }),
          },
        ]
      : undefined,
    lists: [
      {
        title: "Certification",
        items: d.certProjects.map((p) => ({ text: `${p.code} · ${p.agency ?? "—"} · ${(p.stage ?? "").replace(/_/g, " ")} · ${p.itemsResolved}/${p.itemsTotal}`, tone: p.itemsOpen ? ("warn" as const) : ("ok" as const) })),
      },
    ],
    detail: d,
    checkedAt: Date.now(),
  };
}

async function bomformDirect(url: string, key: string): Promise<ConnectorState> {
  const headers = { authorization: `Bearer ${key}` };
  const certs = await timed(callMcpTool(url, "list_cert_projects", {}, headers), 6000);
  const critical = await timed(callMcpTool(url, "list_critical_components", {}, headers), 6000).catch(() => null);
  let certRows: Array<{ code: string; name: string; itemsTotal: number; itemsResolved: number }> = [];
  try {
    const parsed = JSON.parse(certs.text);
    certRows = Array.isArray(parsed) ? parsed : (parsed.certProjects ?? []);
  } catch {
    /* text answer */
  }
  const total = certRows.reduce((a, c) => a + (c.itemsTotal ?? 0), 0);
  const resolved = certRows.reduce((a, c) => a + (c.itemsResolved ?? 0), 0);
  return {
    id: "bomform",
    name: "BomForm",
    ok: true,
    url,
    summary: certRows.length ? `${plural(certRows.length, "certification program")} · ${resolved}/${total} items resolved` : certs.text.slice(0, 160),
    metrics: [
      { label: "Cert programs", value: certRows.length },
      { label: "Cert items resolved", value: total ? `${Math.round((resolved / total) * 100)}%` : "unknown" },
      { label: "Critical components", value: critical ? critical.text.split("\n").length : "unknown" },
    ],
    detail: { certRows },
    checkedAt: Date.now(),
  };
}

async function probe(id: string, name: string, url: string, path = "/"): Promise<ConnectorState> {
  const res = await timed(fetch(url.replace(/\/$/, "") + path, { method: "GET" }), 2500);
  return { id, name, ok: res.ok, url, summary: res.ok ? "reachable" : `answered ${res.status}`, metrics: [], checkedAt: Date.now() };
}

function foundation(): ConnectorState {
  const n = (sql: string, ...p: unknown[]) => (one<{ n: number }>(sql, ...p)?.n ?? 0);
  const day = Date.now() - 864e5;
  const boards = n("select count(*) n from boards");
  const files = n("select count(*) n from files where archived_at is null");
  const asks = n("select count(*) n from asks where status = 'open'");
  const runs = n("select count(*) n from agent_runs where created_at > ?", day);
  const people = n("select count(*) n from users");
  return {
    id: "foundation",
    name: "Foundation",
    ok: true,
    url: config.publicUrl,
    summary: `${plural(people, "person", "people")} · ${plural(boards, "board")} · ${plural(files, "file")}`,
    metrics: [
      { label: "Boards", value: boards },
      { label: "Files", value: files },
      { label: "Open asks", value: asks, tone: asks ? "warn" : "ok" },
      { label: "Agent runs today", value: runs },
      { label: "People", value: people },
    ],
    checkedAt: Date.now(),
  };
}

async function creation(): Promise<ConnectorState> {
  const app = process.env.CREATION_URL || "http://127.0.0.1:5173";
  const hubUrl = process.env.CREATION_HUB_URL || "http://127.0.0.1:4317";
  const [appUp, hub] = await Promise.all([
    timed(fetch(app), 1500).then((r) => r.ok).catch(() => false),
    timed(fetch(`${hubUrl}/v1/health`), 1500)
      .then((r) => (r.ok ? (r.json() as Promise<{ version?: string }>) : null))
      .catch(() => null),
  ]);
  if (!appUp && !hub) throw new Error("not running — `npm run services` starts it beside Foundation");
  return {
    id: "creation",
    name: "Creation",
    ok: true,
    url: app,
    summary: [appUp ? `studio at ${app.replace(/^https?:\/\//, "")}` : null, hub ? `Hub v${hub.version ?? "?"} (agents + key vault)` : null].filter(Boolean).join(" · "),
    metrics: [
      { label: "Studio", value: appUp ? "up" : "down", tone: appUp ? "ok" : "warn" },
      { label: "Creation Hub", value: hub ? "up" : "down", tone: hub ? "ok" : "warn" },
    ],
    checkedAt: Date.now(),
  };
}

async function vision(): Promise<ConnectorState> {
  const reach: string[] = [];
  const t3Base = t3Url(); // T3_URL, or where Vision Code says it's serving (t3paths.ts)
  const t3 = await timed(fetch(`${t3Base}/.well-known/t3/environment`), 1200).then((r) => r.ok).catch(() => false);
  if (t3) reach.push(`Vision Code (T3) at ${t3Base.replace(/^https?:\/\//, "")}`);
  const archive = await timed(fetch("http://127.0.0.1:63727/api/health"), 1200).then((r) => r.ok).catch(() => false);
  if (archive) reach.push("Archive on :63727");
  const web = await timed(fetch(config.connectors.vision), 1200).then((r) => r.ok).catch(() => false);
  if (web) reach.push(`browser edition at ${config.connectors.vision}`);
  return {
    id: "vision",
    name: "Vision",
    ok: reach.length > 0,
    url: config.connectors.vision,
    summary: reach.length ? reach.join(" · ") : "not running on this machine — open Vision to connect",
    metrics: [
      { label: "Vision Code (T3)", value: t3 ? "up" : "down", tone: t3 ? "ok" : "warn" },
      { label: "Archive", value: archive ? "up" : "down", tone: archive ? "ok" : "warn" },
    ],
    checkedAt: Date.now(),
  };
}

/**
 * Why a service didn't answer, in words: Node's fetch says only "fetch failed",
 * with the real reason (refused, no such host, reset) on its cause.
 */
export function offlineReason(e: unknown, url?: string): string {
  const err = e as Error & { cause?: { code?: string; message?: string } };
  let host = "";
  try {
    host = url ? new URL(url).host : "";
  } catch {
    /* not a URL */
  }
  const at = host ? ` at ${host}` : "";
  if (err?.message !== "fetch failed") return err?.message === "timed out" ? `nothing answered${at} within a few seconds` : (err?.message ?? String(e));
  const code = err.cause?.code ?? "";
  if (code === "ECONNREFUSED") return `nothing is running${at}`;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `${host || "its address"} can't be found from here (offline, or a typo in its URL)`;
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET") return `it hung up${at}`;
  if (/CERT|SSL|TLS/.test(code)) return `its certificate isn't trusted${at}`;
  return `it didn't answer${at}${code ? ` (${code})` : ""}`;
}

export async function readConnector(id: string, fresh = false): Promise<ConnectorState> {
  const hit = cache.get(id);
  if (!fresh && hit && Date.now() - hit.checkedAt < TTL) return hit;
  const meta = CONNECTORS.find((c) => c.id === id);
  let state: ConnectorState;
  try {
    if (id === "factoryform") state = await factoryform();
    else if (id === "bomform") state = await bomform();
    else if (id === "vision") state = await vision();
    else if (id === "dataroom") state = await probe(id, "Airform Data Room", config.connectors.dataroom);
    else if (id === "foundation") state = foundation();
    else if (id === "creation") state = await creation();
    else throw new Error("unknown connector");
  } catch (e) {
    state = {
      id,
      name: meta?.name ?? id,
      ok: false,
      url: "",
      summary: `offline — ${offlineReason(e, (config.connectors as Record<string, string>)[id])}`,
      metrics: [],
      checkedAt: Date.now(),
    };
  }
  cache.set(id, state);
  return state;
}

export async function companySnapshot(fresh = false) {
  const states = await Promise.all(CONNECTORS.map((c) => readConnector(c.id, fresh)));
  return { connectors: CONNECTORS.map((c, i) => ({ ...c, state: states[i] })), flows: COMPANY_FLOWS };
}
