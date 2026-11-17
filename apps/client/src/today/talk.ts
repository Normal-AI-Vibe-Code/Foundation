/**
 * Today's small pure parts, kept apart from the page so they can be checked on their own: how the
 * Shiba's answer splits into prose and folded blocks, and how what's waiting on a person is counted.
 */

export type Part = { kind: "text"; text: string } | { kind: "code"; lang: string; text: string };

/** the answer in parts: prose, and each fenced block on its own (an unclosed fence, still arriving, is code too) */
export function partsOf(answer: string): Part[] {
  const out: Part[] = [];
  const lines = answer.split(/\r?\n/);
  let text: string[] = [];
  let code: string[] | null = null;
  let lang = "";
  const flush = () => {
    if (text.join("\n").trim()) out.push({ kind: "text", text: text.join("\n") });
    text = [];
  };
  for (const l of lines) {
    const fence = /^\s*```(.*)$/.exec(l);
    if (fence) {
      if (code) {
        out.push({ kind: "code", lang, text: code.join("\n") });
        code = null;
      } else {
        flush();
        code = [];
        lang = fence[1].trim().split(/\s+/)[0] ?? "";
      }
      continue;
    }
    if (code) code.push(l);
    else text.push(l);
  }
  if (code) out.push({ kind: "code", lang, text: code.join("\n") });
  flush();
  return out;
}


/** what waits on a person, by who it's from: other people, agents, and plain changes (work that merely relates isn't waiting) */
export function countNotices(focus: Array<{ kind: string; tone?: string }>): { people: number; agents: number; changes: number } {
  let people = 0;
  let agents = 0;
  let changes = 0;
  for (const f of focus) {
    if (f.kind === "related") continue;
    if (f.tone === "agent") agents++;
    else if (f.kind === "ask" || f.kind === "mention" || f.kind === "stage") people++;
    else changes++;
  }
  return { people, agents, changes };
}

