/**
 * An error as a small card shows it (components/ErrorCard.tsx): its code, the one line that says what
 * went wrong, and the rest (a log's tail, say) kept behind Details. Pure, tested in test/error-card.test.ts.
 */
export interface ErrorParts {
  /** the system's own code when the text carries one: EACCES, EADDRINUSE, WSAEACCES, "exit 1" */
  code: string | null;
  /** the line a person reads */
  summary: string;
  /** everything, when there is more than the summary */
  detail: string | null;
}

const CODE = /\b(WSAE[A-Z]+|(?!ERRORS?\b)E[A-Z]{4,})\b/;
const EXIT = /\bexit(?: code| status|ed with)?:? (\d+)\b/i;
/** lines a log carries that are never the reason */
const NOISE = /^\(node:\d+\)|^\(Use `node --trace|^\[app \d+\]/;

export function errorParts(message: string): ErrorParts {
  const text = message.trim();
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const code = CODE.exec(text)?.[1] ?? (EXIT.test(text) ? `exit ${EXIT.exec(text)![1]}` : null);
  const telling = lines.filter((l) => !NOISE.test(l));
  // the line that names the code says the most; else the last thing the log said; else the first line
  const summary = [...telling].reverse().find((l) => CODE.test(l)) ?? (lines.length > 1 ? telling[telling.length - 1] : undefined) ?? lines[0] ?? "";
  return { code, summary, detail: lines.length > 1 ? text : null };
}

/** what Copy puts on the clipboard: the whole error, then the way out if the card names one */
export function errorCopyText(message: string, help?: string | null, command?: string | null): string {
  return [message.trim(), help?.trim(), command?.trim()].filter(Boolean).join("\n\n");
}
