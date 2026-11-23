/**
 * An error, as a small card (Josh, 2026-11-22: "Error codes should come in small cards, and be
 * dismissable, also be copyable"): the code as a chip, the one line that says what went wrong, Copy
 * (the whole text, a log's tail included) and a cross that puts it away. More than one line stays
 * behind Details. `help` and `command` are the way out, when the app knows one.
 */
import { useEffect, useRef, useState } from "react";
import { errorCopyText, errorParts } from "../lib/errorParts";
import "./errorCard.css";

export interface ErrorCardProps {
  message: string;
  /** what a person can do about it */
  help?: string | null;
  /** a command that does it, shown as code */
  command?: string | null;
  onDismiss?: () => void;
  /** part of a record (a line in a transcript): it has no cross */
  fixed?: boolean;
}

export function ErrorCard({ message, help, command, onDismiss, fixed }: ErrorCardProps) {
  const { code, summary, detail } = errorParts(message);
  const [copied, setCopied] = useState(false);
  // put away here when nobody above holds the error; it comes back when the text changes or the error is raised again
  const [gone, setGone] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const copy = async () => {
    const text = errorCopyText(message, help, command);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // no clipboard permission (an unfocused window): the old way
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1400);
  };

  if (gone === message) return null;
  return (
    // a press on it selects or copies; it never drags the card or pane it sits in
    <div className="error-card" role="alert" onPointerDown={(e) => e.stopPropagation()}>
      <div className="error-card-head">
        {code ? <code className="error-card-code">{code}</code> : <p className="error-card-summary">{summary}</p>}
        <span className="error-card-tools">
          <button type="button" className="error-card-btn" onClick={() => void copy()} aria-live="polite">
            {copied ? "Copied" : "Copy"}
          </button>
          {!fixed && (
            <button
              type="button"
              className="error-card-btn error-card-close"
              onClick={() => {
                setGone(message);
                onDismiss?.();
              }}
              aria-label="Dismiss this error"
            >
              ×
            </button>
          )}
        </span>
      </div>
      {code && <p className="error-card-summary">{summary}</p>}
      {help && <p className="error-card-help">{help}</p>}
      {command && <code className="error-card-command">{command}</code>}
      {detail && (
        <details className="error-card-detail">
          <summary>Details</summary>
          <pre>{detail}</pre>
        </details>
      )}
    </div>
  );
}
