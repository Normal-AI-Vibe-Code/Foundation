/**
 * Slack history (docs/chatform.md, package I1), the Inbox tab's last panel. Josh: "be able to download
 * the chats that we have so far … and have a seamless transition."
 *
 *  - where Slack's export comes from, in three steps;
 *  - the zip, dropped or picked, streamed to the server with its progress;
 *  - a dry run first: what would come in (conversations, people matched by email vs Slack people, bots,
 *    messages, files), then **Bring it in**; the job's progress live; the report with what was skipped;
 *  - a top-up from Slack's API when the server has a token (and a plain line when it hasn't);
 *  - **Download everything**: the asker's ChatForm as one zip, for anyone.
 * Bringing history in is an admin's, as a person: others see the controls, disabled, with the reason.
 */

import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import type { UserInfo } from "@foundation/protocol";
import { ApiError, BEARER, api, authHeaders, fetchFile, serverUrl } from "../../lib/api";
import "./history.css";

interface Progress {
  state: JobState;
  channel: string;
  done: number;
  total: number;
  messages: number;
  files: number;
  skipped: Array<{ why: string; count: number }>;
}
type JobState = "running" | "done" | "failed" | "interrupted";
export interface Job {
  id: string;
  kind: "export" | "api";
  dryRun: boolean;
  state: JobState;
  source: string;
  startedAt: number;
  finishedAt: number | null;
  progress: Progress;
  error?: string;
}
export interface Report {
  kind: "export" | "api";
  dryRun: boolean;
  source: string;
  conversations: Array<{ slackId: string; name: string; kind: string; messages: number; already: number; files: number; filesMissing: number; skipped: number; merged?: boolean; note?: string }>;
  people: { matched: Array<{ name: string; email: string; userName: string }>; ghosts: number; bots: number; total: number };
  totals: { conversations: number; open: number; private: number; dm: number; group: number; messages: number; already: number; replies: number; reactions: number; pins: number; files: number; filesBytes: number; filesMissing: number; filesSkipped: number };
  skipped: Array<{ why: string; count: number; examples: string[] }>;
  warnings: string[];
}
interface Overview {
  canImport: boolean;
  why?: string;
  token: { configured: boolean; kind: "user" | "bot" | null };
  jobs: Job[];
}
interface Upload {
  id: string;
  name: string;
  size: number;
}

const rid = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `h-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const n = (x: number) => x.toLocaleString();
const size = (b: number) => (b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} GB` : b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} bytes`);
const when = (t: number) => new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const plural = (k: number, one: string, many = `${one}s`) => `${n(k)} ${k === 1 ? one : many}`;

/** the zip, streamed to the server (XHR: fetch can't say how far an upload has got) */
function sendZip(file: File, onProgress: (f: number) => void): Promise<Upload> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", serverUrl(`/api/chat/history/upload?name=${encodeURIComponent(file.name)}`));
    xhr.withCredentials = true;
    for (const [k, v] of Object.entries(authHeaders())) xhr.setRequestHeader(k, v);
    xhr.setRequestHeader("content-type", "application/zip");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText);
        if (xhr.status >= 300) reject(new ApiError(xhr.status, body.error ?? "upload failed"));
        else resolve(body.upload);
      } catch {
        reject(new ApiError(xhr.status, "upload failed"));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, "The upload stopped: the connection to the server dropped."));
    xhr.send(file);
  });
}

/** a download from the server: a plain link where the cookie rides along (it streams to disk), else fetched with the bearer */
async function download(path: string, fallback: string) {
  if (!BEARER) {
    const a = document.createElement("a");
    a.href = serverUrl(path);
    a.download = fallback;
    a.click();
    return;
  }
  const res = await fetchFile(path);
  if (!res.ok) throw new ApiError(res.status, ((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText);
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? fallback;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** bringing a Slack export in, as a hook: the upload, the rehearsal, Bring it in, the job and its report. The History panel and the Slack guide (SlackGuide.tsx) both use it */
export function useSlackImport() {
  const [ov, setOv] = useState<Overview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [upload, setUpload] = useState<Upload | null>(null);
  const [sending, setSending] = useState<number | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [withFiles, setWithFiles] = useState(true);
  const [busy, setBusy] = useState(false);
  const poll = useRef<number | null>(null);

  const load = useCallback(() => api<Overview>("/api/chat/history").then(setOv, (e: Error) => setErr(e.message)), []);
  useEffect(() => {
    void load();
    return () => {
      if (poll.current) window.clearTimeout(poll.current);
    };
  }, [load]);

  /** follow a job until it ends; then its report */
  const follow = useCallback(
    (id: string) => {
      if (poll.current) window.clearTimeout(poll.current);
      const tick = async () => {
        try {
          const r = await api<{ job: Job; report: Report | null }>(`/api/chat/history/jobs/${id}`);
          setJob(r.job);
          if (r.job.state === "running") {
            poll.current = window.setTimeout(() => void tick(), 800);
            return;
          }
          setReport(r.report);
          void load();
        } catch (e) {
          setErr((e as Error).message);
        }
      };
      void tick();
    },
    [load],
  );

  const run = async (fn: () => Promise<{ job: Job }>) => {
    setBusy(true);
    setErr(null);
    setReport(null);
    try {
      const r = await fn();
      setJob(r.job);
      follow(r.job.id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const take = async (file: File | undefined) => {
    if (!file || !ov?.canImport) return;
    if (!/\.zip$/i.test(file.name)) {
      setErr("That isn't a zip. Slack's export downloads as one .zip; bring it as it came.");
      return;
    }
    setErr(null);
    setReport(null);
    setJob(null);
    setSending(0);
    try {
      const up = await sendZip(file, setSending);
      setUpload(up);
      setSending(null);
      // a rehearsal first: what would come in, before anything is written
      await run(() => api(`/api/chat/history/import`, { method: "POST", json: { upload: up.id, dryRun: true, files: withFiles, request_id: rid() } }));
    } catch (e) {
      setSending(null);
      setErr((e as Error).message);
    }
  };

  const bringIn = () => upload && run(() => api(`/api/chat/history/import`, { method: "POST", json: { upload: upload.id, files: withFiles, request_id: rid() } }));
  const topUp = (dryRun: boolean) => run(() => api(`/api/chat/history/pull`, { method: "POST", json: { dryRun, files: withFiles, request_id: rid() } }));
  const open = (j: Job) => {
    setJob(j);
    setReport(null);
    follow(j.id);
  };
  const can = Boolean(ov?.canImport);
  const running = job?.state === "running";
  const locked = !can || running || busy || sending !== null;
  const dryDone = Boolean(job && job.dryRun && job.kind === "export" && job.state === "done" && upload && report);
  return { ov, err, setErr, upload, sending, job, report, withFiles, setWithFiles, busy, take, bringIn, topUp, open, can, running, locked, dryDone, load };
}
export type SlackImport = ReturnType<typeof useSlackImport>;

/** the dashed place the export zip is dropped (or picked) */
export function ExportDrop({ imp }: { imp: SlackImport }) {
  const [over, setOver] = useState(false);
  const pick = useRef<HTMLInputElement>(null);
  const { locked, can, sending, upload } = imp;
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void imp.take(e.dataTransfer.files[0]);
  };
  return (
    <div
      className={`hist-drop ${over ? "is-over" : ""} ${!can ? "is-locked" : ""}`}
      onDragOver={(e) => {
        if (locked) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => (locked ? e.preventDefault() : onDrop(e))}
      aria-disabled={locked}
      data-export-drop
    >
      {sending !== null ? (
        <div className="hist-sending">
          <span>Sending the export… {Math.round(sending * 100)}%</span>
          <div className="hist-bar" role="progressbar" aria-valuenow={Math.round(sending * 100)} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${sending * 100}%` }} />
          </div>
        </div>
      ) : (
        <>
          <span className="hist-drop-title">{upload ? `${upload.name} · ${size(upload.size)}` : "Drop Slack's export zip here"}</span>
          <button className="f-pill" disabled={locked} onClick={() => pick.current?.click()}>
            {upload ? "Choose another…" : "Choose the zip…"}
          </button>
        </>
      )}
      <input ref={pick} type="file" accept=".zip,application/zip" hidden onChange={(e) => void imp.take(e.target.files?.[0] ?? undefined)} />
    </div>
  );
}

/** Bring files too */
export function FilesCheck({ imp }: { imp: SlackImport }) {
  return (
    <label className="hist-check">
      <input type="checkbox" checked={imp.withFiles} disabled={!imp.can} onChange={(e) => imp.setWithFiles(e.target.checked)} data-import-files />
      Bring files too (Slack's links in an export expire after a while; a file that won't come is kept as a named placeholder with its Slack link)
    </label>
  );
}

export default function History({ user }: { user: UserInfo }) {
  const imp = useSlackImport();
  const { ov, err, job, report, locked, can, dryDone } = imp;
  const [exportFiles, setExportFiles] = useState(false);

  return (
    <div className="hist" data-history>
      <p className="inbox-detail">
        Your Slack workspace's history comes in here once: every channel, thread, reaction, pin and file, with who wrote it and when. People whose Slack email is their Foundation email are themselves here; everyone else keeps their Slack name until they sign in. Bringing the same export in twice adds nothing.
      </p>

      <ol className="hist-steps">
        <li>
          In Slack, open <b>Workspace settings → Import/Export data → Export</b> (an owner or admin can).
        </li>
        <li>
          Pick <b>Entire history</b> and start it. Slack emails a link when the export is ready.
        </li>
        <li>Download the zip and drop it below. It stays on this server.</li>
      </ol>
      <p className="hist-note">On Slack's Free and Pro plans the export holds public channels only. Direct messages and private channels come through Slack's API (below) with a token.</p>

      {err && <p className="inbox-err">{err}</p>}
      {!ov && !err && <p className="inbox-quiet">Asking the server…</p>}

      {ov && (
        <>
          <ExportDrop imp={imp} />
          {!can && <p className="hist-why">{ov.why ?? "Only an admin brings in Slack history."}</p>}
          <FilesCheck imp={imp} />

          {job && <JobView job={job} />}
          {report && <ReportView report={report} jobId={job?.id ?? ""} onError={imp.setErr} />}

          {dryDone && (
            <div className="inbox-acts">
              <button className="f-pill is-primary" disabled={locked} onClick={() => void imp.bringIn()}>
                Bring it in
              </button>
              <span className="inbox-quiet">Writes the messages above into ChatForm, in their authors' names.</span>
            </div>
          )}

          <div className="hist-api">
            <h3>Top up from Slack's API</h3>
            {ov.token.configured ? (
              <>
                <p className="inbox-detail">
                  The server has a Slack {ov.token.kind} token. It can bring in what the export left out (direct messages and private channels {ov.token.kind === "bot" ? "the Foundation app was invited to" : "you're in"}) and anything said since. Nothing is doubled.
                </p>
                <div className="inbox-acts">
                  <button className="f-pill" disabled={locked} onClick={() => void imp.topUp(true)}>
                    See what's new
                  </button>
                  <button className="f-pill" disabled={locked} onClick={() => void imp.topUp(false)}>
                    Top up now
                  </button>
                </div>
              </>
            ) : (
              <p className="inbox-detail">
                No Slack token on this server, so only an export comes in. To bring in direct messages and private channels, an admin pastes the Slack app's bot token in the Slack guide (or sets <code>SLACK_USER_TOKEN</code>, a user token with the history, users and files read scopes, in the server's <code>.env</code>).
              </p>
            )}
            {!can && ov.token.configured && <p className="hist-why">{ov.why ?? "Only an admin tops up from Slack."}</p>}
          </div>

          {ov.jobs.length > 0 && (
            <div className="hist-jobs" aria-label="Earlier imports">
              <h3>Earlier</h3>
              {ov.jobs.map((j) => (
                <button key={j.id} className={`hist-job ${job?.id === j.id ? "is-on" : ""}`} onClick={() => imp.open(j)}>
                  <span className={`f-dot ${j.state === "done" ? "is-ok" : j.state === "running" ? "is-warn is-live" : j.state === "failed" ? "is-bad" : "is-warn"}`} />
                  <span className="hist-job-what">
                    {j.kind === "api" ? "Slack API" : j.source}
                    {j.dryRun ? " · dry run" : ""}
                  </span>
                  <span className="hist-job-n">{plural(j.progress.messages, "message")}</span>
                  <span className="hist-job-when">{when(j.startedAt)}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      <div className="hist-export">
        <h3>Download everything</h3>
        <p className="inbox-detail">Every conversation you can see in ChatForm, {user.name.split(" ")[0]}, as one zip: each one as JSON and as Markdown, with who's who.</p>
        <div className="inbox-acts">
          <button className="f-pill" onClick={() => void download(`/api/chat/history/export${exportFiles ? "?files=1" : ""}`, "chatform.zip").catch((e: Error) => imp.setErr(e.message))}>
            Download everything
          </button>
          <label className="hist-check is-inline">
            <input type="checkbox" checked={exportFiles} onChange={(e) => setExportFiles(e.target.checked)} />
            with files
          </label>
        </div>
      </div>
    </div>
  );
}

export function JobView({ job }: { job: Job }) {
  const p = job.progress;
  const frac = p.total ? p.done / p.total : 0;
  const what = job.dryRun ? "Reading the export" : job.kind === "api" ? "Bringing in from Slack" : "Bringing it in";
  return (
    <div className={`hist-job-live is-${job.state}`} aria-live="polite">
      {job.state === "running" ? (
        <>
          <span>
            {what}… {p.total ? `${p.done} of ${plural(p.total, "conversation")}` : ""}
            {p.channel ? ` · ${p.channel}` : ""}
          </span>
          <div className="hist-bar" role="progressbar" aria-valuenow={Math.round(frac * 100)} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${Math.max(3, frac * 100)}%` }} />
          </div>
          <span className="hist-job-n">
            {plural(p.messages, "message")} · {plural(p.files, "file")}
          </span>
        </>
      ) : job.state === "failed" ? (
        <span className="inbox-err">It stopped: {job.error ?? "something went wrong"}. Run it again: what came in stays, and nothing is doubled.</span>
      ) : job.state === "interrupted" ? (
        <span className="inbox-quiet">The server stopped while this ran. Run it again: it carries on where it stopped.</span>
      ) : null}
    </div>
  );
}

export function ReportView({ report: r, jobId, onError }: { report: Report; jobId: string; onError: (e: string) => void }) {
  const t = r.totals;
  return (
    <div className="hist-report">
      <h3>{r.dryRun ? "What would come in" : "What came in"}</h3>
      <div className="hist-stats">
        <Stat k={t.conversations} label="conversations" sub={`${n(t.open)} channels · ${n(t.private)} private · ${n(t.dm)} DMs · ${n(t.group)} groups`} />
        <Stat k={t.messages} label={r.dryRun ? "messages to bring" : "messages"} sub={`${n(t.replies)} in threads${t.already ? ` · ${n(t.already)} already here` : ""}`} />
        <Stat k={r.people.matched.length} label="people matched" sub={`${n(r.people.ghosts)} Slack people · ${n(r.people.bots)} bots`} />
        <Stat k={t.files} label={r.dryRun ? "files to fetch" : "files"} sub={`${size(t.filesBytes)}${t.filesMissing ? ` · ${n(t.filesMissing)} kept as placeholders` : ""}${t.filesSkipped ? ` · ${n(t.filesSkipped)} left out` : ""}`} />
      </div>
      {r.people.matched.length > 0 && (
        <p className="inbox-detail">
          Matched by email: {r.people.matched.map((m) => (m.userName === m.name ? m.name : `${m.name} (${m.userName})`)).join(", ")}.
        </p>
      )}
      {r.skipped.length > 0 && (
        <div className="hist-skipped">
          <h4>Skipped or changed</h4>
          <ul>
            {r.skipped.map((s) => (
              <li key={s.why}>
                <span className="hist-skip-n">{n(s.count)}</span>
                <span>
                  {s.why}
                  {s.examples.length > 0 && <span className="hist-skip-eg"> · e.g. {s.examples.slice(0, 3).join(", ")}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {r.warnings.length > 0 && (
        <ul className="hist-warn">
          {r.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      {jobId && (
        <div className="inbox-acts">
          <button className="f-pill" onClick={() => void download(`/api/chat/history/jobs/${jobId}/report`, "slack-import.md").catch((e: Error) => onError(e.message))}>
            Download the report
          </button>
        </div>
      )}
    </div>
  );
}

function Stat({ k, label, sub }: { k: number; label: string; sub: string }) {
  return (
    <div className="hist-stat">
      <span className="hist-stat-k">{n(k)}</span>
      <span className="hist-stat-label">{label}</span>
      <span className="hist-stat-sub">{sub}</span>
    </div>
  );
}
