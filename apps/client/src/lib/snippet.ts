/**
 * A search snippet as HTML: escaped, the matches (between « and », from the
 * server's FTS5 snippet) in <mark>. Snippets show on one line, so a match far
 * into one is brought forward: the words well before it give way to "…", and
 * the match is never lost to the ellipsis at the end of the line.
 */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function snippetHtml(snippet: string, lead = 32): string {
  let s = snippet;
  const at = s.indexOf("«");
  if (at > lead) {
    // keep about `lead` characters before the match, starting at a word
    const from = s.lastIndexOf(" ", at - lead) + 1;
    let cut = s.indexOf(" ", Math.max(from, at - lead));
    if (cut < 0 || cut >= at) cut = at - lead;
    s = `…${s.slice(cut).trimStart()}`;
  }
  return esc(s).replace(/«/g, "<mark>").replace(/»/g, "</mark>");
}

/** a snippet as plain text (a note made from a result) */
export function snippetText(snippet: string) {
  return snippet.replace(/[«»]/g, "");
}
