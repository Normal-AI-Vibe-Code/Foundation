/** The repo behind an app: README, recent commits, a door to GitHub, and a hand-off to the agent. */

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { api } from "../lib/api";
import { renderMarkdown } from "../utils/markdown";
import { askAgent } from "../state/ui";

interface RepoView {
  info: { fullName: string; url: string; description: string | null; pushedAt: string; language: string | null; defaultBranch: string };
  readme: string;
  commits: Array<{ sha: string; url: string; message: string; author: string; date: string }>;
}

export function RepoDrawer() {
  const [repo, setRepo] = useState<string | null>(null);
  const [data, setData] = useState<RepoView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const on = (e: Event) => setRepo((e as CustomEvent<string>).detail);
    window.addEventListener("foundation:repo", on);
    return () => window.removeEventListener("foundation:repo", on);
  }, []);

  useEffect(() => {
    if (!repo) return;
    setData(null);
    setError(null);
    api<RepoView>(`/api/repo?repo=${encodeURIComponent(repo)}`)
      .then(setData)
      .catch((e) => setError((e as Error).message));
  }, [repo]);

  return (
    <AnimatePresence>
      {repo && (
        <motion.aside
          className="repo-drawer f-glass"
          initial={{ x: 40, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 40, opacity: 0 }}
          transition={{ type: "spring", stiffness: 260, damping: 28 }}
        >
          <header className="dock-head">
            <span className="dock-title">{repo}</span>
            <button className="icon-btn" onClick={() => setRepo(null)}>
              ✕
            </button>
          </header>
          {error && <div className="turn-error">{error}</div>}
          {!data && !error && <div className="repo-loading">Reading the repository…</div>}
          {data && (
            <div className="repo-body">
              <p className="repo-desc">{data.info.description}</p>
              <div className="repo-meta">
                {data.info.language && <span className="f-pill">{data.info.language}</span>}
                <span className="f-pill">{data.info.defaultBranch}</span>
                <a className="f-pill" href={data.info.url} target="_blank" rel="noreferrer">
                  GitHub ↗
                </a>
                <button className="f-pill is-agent" onClick={() => askAgent(`Read ${data.info.fullName} and tell me how it works and how to connect it to the rest of the board.`)}>
                  ✦ Explain it
                </button>
              </div>
              <div className="f-eyebrow">Recent commits</div>
              <div className="repo-commits">
                {data.commits.map((c) => (
                  <a key={c.sha} className="repo-commit" href={c.url} target="_blank" rel="noreferrer">
                    <code>{c.sha}</code>
                    <span>{c.message}</span>
                    <span className="repo-commit-who">{c.author}</span>
                  </a>
                ))}
              </div>
              <div className="f-eyebrow">README</div>
              <div className="note-rendered repo-readme" dangerouslySetInnerHTML={{ __html: renderMarkdown(data.readme.slice(0, 20000)) }} />
            </div>
          )}
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
