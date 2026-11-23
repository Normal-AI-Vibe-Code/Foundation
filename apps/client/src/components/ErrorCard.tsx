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
}

export function ErrorCard({ message, help, command, onDismiss }: ErrorCardProps) {
  const { code, summary, detail } = errorParts(message);
  const [copied, setCopied] = useState(false);
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

  return (
    <div className="error-card" role="alert">
      <div className="error-card-head">
        {code && <code className="error-card-code">{code}</code>}
        <span className="error-card-tools">
          <button type="button" className="error-card-btn" onClick={() => void copy()} aria-live="polite">
            {copied ? "Copied" : "Copy"}
          </button>
          {onDismiss && (
            <button type="button" className="error-card-btn error-card-close" onClick={onDismiss} aria-label="Dismiss this error">
              ×
            </button>
          )}
        </span>
      </div>
      <p className="error-card-summary">{summary}</p>
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
