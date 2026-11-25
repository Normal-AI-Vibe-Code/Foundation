#!/usr/bin/env node
/**
 * What must never reach the public repository, checked before it does.
 *
 *   node scripts/check-security.mjs                every git-tracked file
 *   node scripts/check-security.mjs --diff [ref]   also every line added since ref (default origin/main):
 *                                                  each unpushed commit, its message, the working tree
 *                                                  and untracked files, so a secret added and removed
 *                                                  again in unpushed history is still caught
 *   … --diff [ref] --tree-if-no-ref                as --diff, but where ref doesn't exist here (no remote
 *                                                  yet, or not fetched) it warns and checks the tree only
 *                                                  (`npm run check` runs it this way)
 *
 * Rules (each finding names its rule; scripts/check-security.allow.json can
 * waive one exact finding, with a reason):
 *   secret         a key, token or private key in a file, a commit or a commit message
 *   secret-file    a .env file, a private key or data/secret.key tracked by git
 *   unpinned       runtime code fetched without an exact version (the latest tag, npx/uvx/pip
 *                  without a pin, curl piped to a shell, docker images with no tag)
 *   child-process  server code that starts processes outside the allowed files (child_process by
 *                  import, require, dynamic import or createRequire; process.binding; worker_threads
 *                  or cluster), or hands a child the server's whole environment
 *   gap            a public doc that cites code with a line number for a gap still open
 *   open-gap-words a public doc's open item ("still open", "not yet", "open:", "stays open", on
 *                  the line or in the heading or bullet it sits under) that names a route, a
 *                  tool or function in backticks, or an environment variable
 *
 * One sentence per problem, with file:line; exit 1 on any problem. Secret
 * values are never printed: only their first 6 characters, length and a
 * sha256 fingerprint, which is also what an allowlist entry can name. An
 * entry may also name the exact text of the line (`line`), so it waives that
 * line only and never a new, different line in the same file.
 * Run by `npm run check` and by the client tests (apps/client/test/security.test.ts).
 *
 * To run it before every push, use the sample hook once per clone:
 *   git config core.hooksPath scripts/hooks
 * (scripts/hooks/pre-push runs this with --diff origin/main.)
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Config: plain data, edited by people at merge time.
// ---------------------------------------------------------------------------
export const CONFIG = {
  // Rule child-process: the files under apps/server/src that may import
  // node:child_process. Everything else goes through these.
  allowChildProcess: [
    "apps/server/src/child.ts", // the one door every program the server starts goes through
  ],
  // Where the child-process rule looks.
  serverSrc: "apps/server/src/",
  // Rule gap: the public docs that must not describe open gaps in code-and-line detail.
  gapDocs: { files: ["SPEC.md", "README.md"], under: "docs/", extensions: [".md", ".html"], exclude: ["docs/evidence/"] },
  // Docs that cite code with line numbers for ordinary reasons (design notes, walkthroughs).
  noGapDocs: [],
  // Rule open-gap-words: docs that are about security throughout. Elsewhere it reads only marked security notes.
  securityDocs: ["docs/SECURITY.md", "docs/decisions/"],
  // Rule unpinned: where runtime code lives, and which files count as source there.
  codeRoots: ["apps/", "packages/", "scripts/"],
  codeExtensions: [".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx", ".json", ".sh", ".ps1", ".py", ".rs", ".toml", ".yml", ".yaml", ".html", ".bat", ".cmd"],
  // Markdown anywhere is checked for unpinned commands too: docs tell people what to run.
  // Files never scanned for secrets' generic rule (hashes, not keys).
  lockfiles: ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "bun.lockb", "poetry.lock", "uv.lock"],
  // Binary or media files, skipped (anything with a NUL byte near the start is skipped too).
  binaryExtensions: [
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".icns", ".bmp", ".tif", ".tiff", ".avif", ".psd",
    ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp3", ".mp4", ".m4a", ".mov", ".webm", ".wav", ".ogg", ".flac",
    ".pdf", ".zip", ".gz", ".tgz", ".7z", ".rar", ".wasm", ".glb", ".bin", ".exe", ".dll", ".so", ".dylib",
    ".stl", ".step", ".stp", ".3mf", ".blend", ".fbx", ".mavatar", ".sqlite", ".db",
  ],
  // Files bigger than this are skipped (generated bundles); a key is never the only thing in one.
  maxBytes: 8 * 1024 * 1024,
  // Generic secret rule: a value at least this long with at least this much Shannon entropy (bits per character).
  genericMinLength: 24,
  entropyThreshold: 3.5,
  allowFile: "scripts/check-security.allow.json",
};

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Rule secret: named patterns. Each regex is global; `group` picks the value.
// A boundary lookbehind keeps prefixes inside longer base64 runs from matching.
// ---------------------------------------------------------------------------
const B = "(?<![A-Za-z0-9_+/-])";
export const SECRET_PATTERNS = [
  { name: "an Anthropic API key", re: new RegExp(B + "sk-ant-[A-Za-z0-9_-]{20,}", "g") },
  { name: "an OpenAI project key", re: new RegExp(B + "sk-proj-[A-Za-z0-9_-]{20,}", "g") },
  { name: "an OpenAI API key", re: new RegExp(B + "sk-(?!ant-|proj-)(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{20,}", "g") },
  { name: "a Slack token", re: new RegExp(B + "xox[abprs]-(?=[A-Za-z0-9-]*[0-9])[A-Za-z0-9-]{10,}", "g") },
  { name: "a GitHub token", re: new RegExp(B + "gh[pousr]_[A-Za-z0-9]{30,}", "g") },
  { name: "a GitHub fine-grained token", re: new RegExp(B + "github_pat_[A-Za-z0-9_]{22,}", "g") },
  { name: "a Google API key", re: new RegExp(B + "AIza[0-9A-Za-z_-]{35}", "g") },
  { name: "a Google OAuth client secret", re: new RegExp(B + "GOCSPX-[A-Za-z0-9_-]{20,}", "g") },
  { name: "an AWS access key id", re: new RegExp(B + "(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Za-z])", "g") },
  { name: "a Stripe live key", re: new RegExp(B + "(?:sk|rk)_live_[0-9A-Za-z]{16,}", "g") },
  { name: "a JWT (a Supabase service key looks like this)", re: new RegExp(B + "eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{20,}", "g"), minLength: 80 },
  { name: "a private key", re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g, noPlaceholder: true },
  { name: "an npm token", re: new RegExp(B + "npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])", "g") },
  { name: "a Meshy API key", re: new RegExp(B + "msy_[A-Za-z0-9_-]{20,}", "g") },
  { name: "a password in a URL", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/'"`<>]+:([^\s@/'"`<>]{6,})@[^\s'"`<>]+/g, group: 1 },
];

/** The name side of the generic rule. */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;
/** `NAME = "value"`, `"name": "value"`, `name: 'value'` (quoted values, any file). */
const ASSIGN_QUOTED = /(["']?)([A-Za-z_$][\w$.-]*)\1\s*(?:[:=]|:=)\s*(["'`])([^"'`\s]+)\3/g;
/** `NAME=value` (bare values: env, shell, yaml, toml and Markdown only). */
const ASSIGN_BARE = /(?:^|[\s;])(?:export\s+)?([A-Za-z_][\w.-]*)\s*[:=]\s*([A-Za-z0-9_\-+/=.~]+)(?=$|[\s,;#])/g;
const BARE_EXTENSIONS = [".sh", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf", ".properties", ".md", ".env"];

/** Shannon entropy in bits per character. */
export function entropy(s) {
  if (!s) return 0;
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const PLACEHOLDER_WORDS = ["xxx", "your", "example", "changeme", "change-me", "change_me", "placeholder", "redacted", "dummy", "fake", "sample", "replace", "insert", "todo", "...", "***", "<", ">", "${", "{{", "process.env", "import.meta.env", "os.environ", "env.", "getenv", "secret_here", "key_here", "token_here"];

/** True for a value that only stands in for a secret. */
export function isPlaceholder(value) {
  const v = value.toLowerCase();
  if (PLACEHOLDER_WORDS.some((w) => v.includes(w))) return true;
  const body = v.replace(/^[a-z]+[-_]/, "");
  if (new Set(body).size <= 3) return true; // "aaaa…", "0000…" after any prefix
  if (/^(.{1,16}?)\1+$/.test(body)) return true; // one short run repeated ("0123456789abcdef" twice)
  return false;
}

/** sha256 fingerprint of a matched value: printable, allowlistable, not reversible. */
export function fingerprint(value) {
  return "sha256:" + createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/** How a matched secret is shown: never more than its first 6 characters. */
export function redact(value) {
  return `${value.slice(0, 6)}… (${value.length} chars, ${fingerprint(value)})`;
}

const ext = (file) => {
  const base = file.split("/").pop() ?? file;
  if (/^\.env(\..*)?$/.test(base)) return ".env";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i).toLowerCase() : "";
};
const basename = (file) => file.split("/").pop() ?? file;
const isLockfile = (file) => CONFIG.lockfiles.includes(basename(file));

/** Strip what lockfiles and SRI attributes carry that is a hash, not a key. */
function stripHashes(line) {
  return line.replace(/\bsha(?:1|256|384|512)-[A-Za-z0-9+/=]+/g, "").replace(/"integrity"\s*:\s*"[^"]*"/g, "");
}

/**
 * Secrets in one line. Returns [{ rule, name, value, column }].
 * `file` decides whether bare `NAME=value` assignments count.
 */
export function findSecrets(line, file = "") {
  const text = stripHashes(line);
  const hits = [];
  const taken = []; // [start, end) ranges already reported
  const overlaps = (s, e) => taken.some(([a, b]) => s < b && e > a);
  for (const p of SECRET_PATTERNS) {
    p.re.lastIndex = 0;
    for (const m of text.matchAll(p.re)) {
      const value = p.group ? m[p.group] : m[0];
      if (p.minLength && m[0].length < p.minLength) continue;
      if (!p.noPlaceholder && isPlaceholder(value)) continue;
      if (overlaps(m.index, m.index + m[0].length)) continue;
      taken.push([m.index, m.index + m[0].length]);
      hits.push({ name: p.name, value, column: m.index + 1 });
    }
  }
  if (!isLockfile(file)) {
    const consider = (name, value, at) => {
      if (!SECRET_NAME.test(name) || /pub(lic)?[-_]?key/i.test(name)) return; // public keys are published on purpose
      if (value.length < CONFIG.genericMinLength) return;
      if (!/[0-9]/.test(value) || !/[A-Za-z]/.test(value)) return;
      if (value.includes("://") || /^urn:/i.test(value) || isPlaceholder(value)) return;
      if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(value)) return; // a.dotted.path
      if (/^[./~]|\.(?:ts|tsx|js|mjs|json|md|png|svg|html|css)$/.test(value)) return; // a path
      if (entropy(value) < CONFIG.entropyThreshold) return;
      const start = text.indexOf(value, at);
      if (overlaps(start, start + value.length)) return;
      taken.push([start, start + value.length]);
      hits.push({ name: `a high-entropy value assigned to ${name}`, value, column: start + 1 });
    };
    for (const m of text.matchAll(ASSIGN_QUOTED)) consider(m[2], m[4], m.index);
    if (BARE_EXTENSIONS.includes(ext(file)) || basename(file) === "Dockerfile") {
      for (const m of text.matchAll(ASSIGN_BARE)) consider(m[1], m[2], m.index);
    }
  }
  return hits;
}

/** Rule secret-file: is this tracked path one that must never be tracked? */
export function isSecretFile(file) {
  const base = basename(file);
  if (/^\.env(\..+)?$/.test(base) && base !== ".env.example") return true;
  if (file === "data/secret.key") return true;
  return /\.(pem|p12|key|pfx)$/i.test(base);
}

// ---------------------------------------------------------------------------
// Rule unpinned.
// ---------------------------------------------------------------------------
const EXACT = /@\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;
/** Is an npm package spec pinned to an exact version? */
export function npmPinned(spec) {
  const s = spec.replace(/^["'`]|["'`,]$/g, "");
  return EXACT.test(s.startsWith("@") ? s.slice(1) : s);
}
const DOCKER_VALUE_FLAGS = new Set(["-p", "-v", "-e", "-w", "-u", "-l", "-m", "-h", "--name", "--network", "--net", "--env", "--env-file", "--mount", "--entrypoint", "--platform", "--label", "--user", "--workdir", "--volume", "--publish", "--gpus", "--memory", "--cpus", "--restart", "--add-host", "--hostname", "--device", "--shm-size", "--ulimit", "--cap-add", "--cap-drop", "--security-opt", "--log-driver", "--log-opt", "--pull"]);
/** Is a docker image reference pinned (a tag that is not "latest", or a digest)? */
export function imagePinned(ref) {
  const r = ref.replace(/^["'`]|["'`,]$/g, "");
  if (r.includes("@sha256:")) return true;
  if (r.includes("$")) return true; // a variable: checked where it is set
  const last = r.split("/").pop() ?? r;
  const i = last.indexOf(":");
  return i > 0 && last.slice(i + 1) !== "lat" + "est";
}

/** Unpinned runtime code in one line: [{ what, match }]. */
export function findUnpinned(line, file = "") {
  const hits = [];
  const add = (what, match) => hits.push({ what, match: match.trim() });
  for (const m of line.matchAll(/[\w@/.-]*@lat[e]st\b/g)) add("is fetched at the latest tag", m[0]);
  for (const m of line.matchAll(/\bnpx\s+(?:-{1,2}[\w-]+\s+)*?(?:-y|--yes)\s+(?:-{1,2}[\w-]+\s+)*([^\s'"`;|&)]+)/g)) {
    if (!npmPinned(m[1])) add("runs npx with a package that has no exact version", m[0]);
  }
  for (const m of line.matchAll(/["'`]npx["'`]\s*,\s*(?:["']?args["']?\s*:\s*)?\[([^\]]*)\]/g)) {
    const args = [...m[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((a) => a[1]);
    const pkg = args.find((a) => !a.startsWith("-"));
    if (pkg && args.some((a) => a === "-y" || a === "--yes") && !npmPinned(pkg)) add("runs npx with a package that has no exact version", m[0]);
  }
  for (const m of line.matchAll(/\buvx\s+(?:-{1,2}[\w-]+(?:[ =][^\s-][^\s]*)?\s+)*([A-Za-z0-9_.[\],-]+(?:==[^\s]+|@[^\s]+)?)/g)) {
    if (!/==|@\d/.test(m[1])) add("starts a package through uv's tool runner with no == version", m[0]);
  }
  for (const m of line.matchAll(/\bpip3?\s+install\s+([^;&|#\n`"']+)/g)) {
    const toks = m[1].trim().split(/\s+/);
    let skipNext = false;
    for (const t of toks) {
      if (skipNext) { skipNext = false; continue; }
      if (/^-(r|c|e|-requirement|-constraint|-editable|t|-target|i|-index-url)$/.test(t)) { skipNext = true; continue; }
      if (t.startsWith("-") || t === "." || t.includes("/") || t.includes("\\") || /\.(whl|txt|tar\.gz|zip)$/.test(t)) continue;
      if (!t.includes("==")) { add("installs a pip package that has no == version", m[0]); break; }
    }
  }
  for (const m of line.matchAll(/\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/g)) add("pipes a download straight into a shell", m[0]);
  for (const m of line.matchAll(/\b(?:irm|iwr|Invoke-RestMethod|Invoke-WebRequest)\b[^|\n]*\|\s*(?:iex|Invoke-Expression)\b/gi)) add("pipes a download straight into PowerShell", m[0]);
  for (const m of line.matchAll(/\bdocker\s+(?:run|pull|create)\s+([^\n;&|`"']*)/g)) {
    const toks = m[1].trim().split(/\s+/).filter(Boolean);
    let skipNext = false;
    let image;
    for (const t of toks) {
      if (skipNext) { skipNext = false; continue; }
      if (t.startsWith("-")) { if (!t.includes("=") && DOCKER_VALUE_FLAGS.has(t)) skipNext = true; continue; }
      image = t;
      break;
    }
    if (image && !imagePinned(image)) add("runs a docker image with no tag or the latest tag", m[0]);
  }
  const isCompose = /\.ya?ml$/.test(file);
  if (isCompose) for (const m of line.matchAll(/^\s*image:\s*["']?([^\s"'#]+)/g)) if (!imagePinned(m[1])) add("names a docker image with no tag or the latest tag", m[0]);
  if (basename(file).startsWith("Dockerfile") || ext(file) === ".md") {
    for (const m of line.matchAll(/^\s*FROM\s+(?:--platform=\S+\s+)?([^\s]+)/g)) if (m[1] !== "scratch" && !imagePinned(m[1])) add("builds FROM an image with no tag or the latest tag", m[0]);
  }
  return hits;
}

/** Does the unpinned rule apply to this file? */
export function unpinnedApplies(file) {
  if (file.includes("node_modules/") || isLockfile(file) || file === CONFIG.allowFile) return false;
  if (/(^|\/)(test|tests|__tests__)\//.test(file) || /\.test\.[cm]?[jt]sx?$/.test(file)) return false; // tests name dangerous commands on purpose
  const e = ext(file);
  if (e === ".md") return true;
  if (!CONFIG.codeRoots.some((r) => file.startsWith(r))) return false;
  return CONFIG.codeExtensions.includes(e) || basename(file).startsWith("Dockerfile") || /(^|\/)hooks\/[\w-]+$/.test(file);
}

// ---------------------------------------------------------------------------
// Rule child-process.
// ---------------------------------------------------------------------------
/** child_process by `from`, `require(`, `import(` or a `createRequire(…)(` call, quoted any way (template literals too) */
const CHILD_IMPORT = /(?:from\s+|require\(\s*|import\(\s*|\)\(\s*)["'`](?:node:)?child_process["'`]/;
/** the other ways to run code beside the server: its internal bindings, worker threads, a cluster */
const OTHER_RUNNERS = [
  { re: /\bprocess\s*\.\s*binding\b|\bprocess\s*\[\s*["'`]binding["'`]\s*\]/, what: "reaches the runtime's internal bindings (process.binding) outside the allowed files; start processes through apps/server/src/child.ts" },
  { re: /(?:from\s+|require\(\s*|import\(\s*|\)\(\s*)["'`](?:node:)?(?:worker_threads|cluster)["'`]/, what: "imports worker_threads or cluster outside the allowed files; code that runs beside the server goes through apps/server/src/child.ts, or is waived line by line with a reason" },
];
const WHOLE_ENV = /\benv\s*:\s*process\.env\b(?![.[])|\.\.\.\s*process\.env\b(?![.[])/g;

/** Child-process problems in one file's text: [{ line, what, match, text }]. */
export function findChildProcess(file, text, config = CONFIG) {
  if (!file.startsWith(config.serverSrc)) return [];
  const out = [];
  const lines = text.split(/\r?\n/);
  const allowed = config.allowChildProcess.includes(file);
  lines.forEach((l, i) => {
    const t = l.trim();
    if (!allowed && CHILD_IMPORT.test(l)) out.push({ line: i + 1, what: "imports child_process outside the allowed files; start processes through apps/server/src/childenv.ts", match: t, text: t });
    if (!allowed) for (const r of OTHER_RUNNERS) if (r.re.test(l)) out.push({ line: i + 1, what: r.what, match: t, text: t });
    for (const m of l.matchAll(WHOLE_ENV)) out.push({ line: i + 1, what: "hands a child (or an object) the server's whole environment; pass only the variables it needs", match: m[0], text: t });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Rule gap.
// ---------------------------------------------------------------------------
export const CODE_REF = /\b[\w./-]*[\w-]\.(?:ts|tsx|js|mjs|cjs|rs|py|json|toml|ya?ml):\d+(?:-\d+)?\b/g;
const CLOSED = /\bclosed in [0-9a-f]{7,40}\b|\bfixed\b[^\n]*?\b[0-9a-f]{7,40}\b/i;

/** Is this a public doc the gap rule watches? */
export function isGapDoc(file, config = CONFIG) {
  const g = config.gapDocs;
  if (g.exclude.some((x) => file.startsWith(x))) return false;
  if (config.noGapDocs.includes(file)) return false;
  if (g.files.includes(file)) return true;
  return file.startsWith(g.under) && g.extensions.includes(ext(file));
}

// ---------------------------------------------------------------------------
// Rule open-gap-words.
// Applies to the whole of a security doc (CONFIG.securityDocs), and in any other public doc only to the
// lines between <!-- security-notes --> and <!-- /security-notes -->.
export function isSecurityDoc(file, config = CONFIG) {
  return (config.securityDocs ?? []).some((p) => (p.endsWith("/") ? file.startsWith(p) : file === p));
}
/** the text with every line outside a security-notes region blanked (line numbers kept) */
export function securityNotesOnly(text) {
  let inside = false;
  return text
    .split("\n")
    .map((l) => {
      if (l.includes("<!-- security-notes -->")) {
        inside = true;
        return "";
      }
      if (l.includes("<!-- /security-notes -->")) {
        inside = false;
        return "";
      }
      return inside ? l : "";
    })
    .join("\n");
}
// ---------------------------------------------------------------------------
/** words that say an item is still open */
export const OPEN_WORDS = /\bstill open\b|\bnot yet\b|\bopen:|\bstays open\b/i;
/** what an open item must not name in public: a route, a tool or function in backticks, an environment variable */
export const OPEN_DETAIL = [
  { what: "a route", re: /(?<![\w.-])\/(?:api|auth)\/[^\s`'")\]]*|(?<![\w.-])\/mcp\b/g },
  { what: "a tool or function name", re: /`(?:[a-z][a-z0-9]*_[a-z0-9_]+|[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*|[A-Za-z_$][\w$.]*\(\))`/g },
  { what: "an environment variable", re: /(?<![\w-])[A-Z][A-Z0-9]*_[A-Z0-9_]*[A-Z0-9](?![\w-])/g },
];

/**
 * Lines of a public doc that describe an open item with a route, tool or setting name: [{ line, match, what }].
 * An item is open when its own line says so, or the heading or bullet it sits under does (a heading's
 * section runs to the next heading of the same or a higher level; a bullet's to its next sibling).
 */
export function findOpenGapWords(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let heading = { level: 0, open: false };
  /** open bullets above this line, by indent */
  let bullets = [];
  let fence = false;
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) fence = !fence;
    const h = fence ? null : /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) {
      const level = h[1].length;
      if (level <= heading.level || !heading.open) heading = { level, open: OPEN_WORDS.test(h[2]) };
      bullets = [];
    }
    const b = /^(\s*)(?:[-*+]|\d+[.)])\s+/.exec(l);
    const indent = b ? b[1].replace(/\t/g, "    ").length : /^\s*$/.test(l) ? -1 : (/^(\s*)/.exec(l)?.[1].length ?? 0);
    if (b) {
      bullets = bullets.filter((x) => x.indent < indent);
      bullets.push({ indent, open: OPEN_WORDS.test(l) });
    } else if (indent === 0 && !h) bullets = [];
    const open = OPEN_WORDS.test(l) || (heading.open && !h) || bullets.some((x) => x.open);
    if (!open) return;
    for (const d of OPEN_DETAIL) {
      d.re.lastIndex = 0;
      for (const m of l.matchAll(d.re)) out.push({ line: i + 1, match: m[0], what: d.what });
    }
  });
  return out;
}

/** Code references with line numbers that are not marked closed: [{ line, match }]. */
export function findGaps(text, file = "") {
  const lines = text.split(/\r?\n/);
  const out = [];
  let quiet = false;
  const html = file.endsWith(".html");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/<!--\s*not-a-gap\s*-->/.test(l)) quiet = true;
    if (/<!--\s*\/not-a-gap\s*-->/.test(l)) { quiet = false; continue; }
    if (quiet) continue;
    const refs = [...l.matchAll(CODE_REF)];
    if (!refs.length) continue;
    let row = l;
    if (html) {
      // the row is the enclosing <tr>…</tr>
      let a = i;
      while (a > 0 && !/<tr\b/i.test(lines[a]) && !/<\/tr>/i.test(lines[a - 1])) a--;
      let b = i;
      while (b < lines.length - 1 && !/<\/tr>/i.test(lines[b])) b++;
      if (/<tr\b/i.test(lines[a]) && /<\/tr>/i.test(lines[b])) row = lines.slice(a, b + 1).join("\n");
    }
    if (CLOSED.test(row)) continue;
    for (const m of refs) out.push({ line: i + 1, match: m[0] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Findings, allowlist, scanning.
// ---------------------------------------------------------------------------

/** A finding: { rule, file, line, match, fingerprint?, sentence, where? }. */
function secretFinding(file, line, hit, where) {
  const at = where ? `${file}:${line} (${where})` : `${file}:${line}`;
  return {
    rule: "secret", file, line, match: hit.value, fingerprint: fingerprint(hit.value), where,
    sentence: `${at}: ${hit.name} is here (${redact(hit.value)}); take it out, rotate it, and read it from the environment.`,
  };
}

/** All findings for one file's text (rules secret, unpinned, child-process, gap). */
export function scanText(file, text, config = CONFIG) {
  const out = [];
  const lines = text.split(/\r?\n/);
  const unp = unpinnedApplies(file);
  lines.forEach((l, i) => {
    for (const h of findSecrets(l, file)) out.push(secretFinding(file, i + 1, h));
    if (unp) for (const h of findUnpinned(l, file)) out.push({ rule: "unpinned", file, line: i + 1, match: h.match, sentence: `${file}:${i + 1}: this ${h.what} ("${h.match.slice(0, 80)}"); pin an exact version.` });
  });
  for (const h of findChildProcess(file, text, config)) out.push({ rule: "child-process", file, line: h.line, match: h.match, text: h.text, sentence: `${file}:${h.line}: this ${h.what}.` });
  if (isGapDoc(file, config)) for (const h of findGaps(text, file)) out.push({ rule: "gap", file, line: h.line, match: h.match, text: lines[h.line - 1].trim(), sentence: `${file}:${h.line}: ${h.match} is a code reference with a line number in a public doc: say it in general terms, or mark the row closed with its commit.` });
  // only where security status is written: the security docs, and a doc's own marked security notes.
  // A product's known issues say "not yet" and name functions all the time; the check can't tell those apart.
  if (isGapDoc(file, config))
    for (const h of findOpenGapWords(isSecurityDoc(file, config) ? text : securityNotesOnly(text))) out.push({ rule: "open-gap-words", file, line: h.line, match: h.match, text: lines[h.line - 1].trim(), sentence: `${file}:${h.line}: an open item described with a route, tool or setting name (${h.what} "${h.match.slice(0, 60)}"): say it in general terms.` });
  return out;
}

/** Is this file text we should read? */
function readable(file) {
  if (CONFIG.binaryExtensions.includes(ext(file))) return undefined;
  const abs = join(ROOT, file);
  let st;
  try { st = statSync(abs); } catch { return undefined; }
  if (!st.isFile() || st.size > CONFIG.maxBytes) return undefined;
  const buf = readFileSync(abs);
  if (buf.subarray(0, 8000).includes(0)) return undefined;
  return buf.toString("utf8");
}

const git = (args) => execFileSync("git", ["-c", "core.quotepath=off", ...args], { cwd: ROOT, encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });

export function trackedFiles() {
  return git(["ls-files", "-z"]).split("\0").filter(Boolean);
}

/** Every tracked file: secret-file by path, then the text rules. */
export function scanTracked(files = trackedFiles()) {
  const out = [];
  for (const file of files) {
    if (isSecretFile(file)) out.push({ rule: "secret-file", file, line: 1, match: file, sentence: `${file}:1: this file must not be tracked by git; remove it with git rm --cached, add it to .gitignore, and rotate anything it held.` });
    const text = readable(file);
    if (text !== undefined) out.push(...scanText(file, text));
  }
  return out;
}

/**
 * Added lines in a unified patch (git log -p with our --format, or git diff).
 * Returns { commits: [{ sha, message }], added: [{ sha, file, line, text }] }.
 */
export function parsePatch(patch) {
  const commits = [];
  const added = [];
  let sha = "working tree";
  let inMessage = false;
  let msg = [];
  let file;
  let newLine = 0;
  let inHunk = false;
  for (const l of patch.split("\n")) {
    if (l.startsWith("\x01")) { sha = l.slice(1).trim(); inMessage = true; msg = []; inHunk = false; continue; }
    if (inMessage) {
      if (l.includes("\x02")) { msg.push(l.replace("\x02", "")); commits.push({ sha, message: msg.join("\n").trim() }); inMessage = false; } else msg.push(l);
      continue;
    }
    if (l.startsWith("diff --git ")) { inHunk = false; file = undefined; continue; }
    if (!inHunk && l.startsWith("+++ ")) { const p = l.slice(4).trim(); file = p === "/dev/null" ? undefined : p.replace(/^"?b\//, "").replace(/"$/, ""); continue; }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) { newLine = Number(h[1]); inHunk = true; continue; }
    if (!inHunk || !file) continue;
    if (l.startsWith("+")) { added.push({ sha, file, line: newLine, text: l.slice(1).replace(/\r$/, "") }); newLine++; } else if (l.startsWith(" ")) newLine++;
    else if (!l.startsWith("-") && !l.startsWith("\\")) inHunk = false;
  }
  return { commits, added };
}

/** Findings from history since `ref`: secrets and gaps in added lines, secrets in messages, and untracked files whole. */
export function scanSince(ref) {
  const out = [];
  try { git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]); } catch {
    return [{ rule: "setup", file: ref, line: 0, match: ref, sentence: `${ref} is not a commit here; fetch it (git fetch origin) or name another ref.` }];
  }
  const history = parsePatch(git(["log", "-p", "--no-color", "--no-ext-diff", "--format=%x01%H%n%B%x02", `${ref}..HEAD`]));
  const working = parsePatch(git(["diff", "--no-color", "--no-ext-diff", "HEAD"]));
  for (const c of history.commits) {
    c.message.split("\n").forEach((l, i) => {
      for (const h of findSecrets(l, "")) out.push(secretFinding(`commit ${c.sha.slice(0, 7)} message`, i + 1, h));
    });
  }
  for (const a of [...history.added, ...working.added]) {
    const where = a.sha === "working tree" ? "working tree" : `commit ${a.sha.slice(0, 7)}`;
    for (const h of findSecrets(a.text, a.file)) out.push(secretFinding(a.file, a.line, h, where));
    if (isGapDoc(a.file) && !CLOSED.test(a.text)) {
      for (const m of a.text.matchAll(CODE_REF)) out.push({ rule: "gap", file: a.file, line: a.line, where, match: m[0], sentence: `${a.file}:${a.line} (${where}): ${m[0]} is a code reference with a line number in a public doc: say it in general terms, or mark the row closed with its commit.` });
    }
  }
  const untracked = git(["ls-files", "-z", "--others", "--exclude-standard"]).split("\0").filter(Boolean);
  out.push(...scanTracked(untracked).map((f) => ({ ...f, where: "untracked", sentence: f.sentence.replace(`${f.file}:${f.line}:`, `${f.file}:${f.line} (untracked):`) })));
  return out;
}

/** Read the allowlist; problems with it are findings too. */
export function readAllow(file = join(ROOT, CONFIG.allowFile)) {
  if (!existsSync(file)) return [];
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * Does an allowlist entry waive this finding? Match is the exact matched text or its fingerprint. An entry
 * that names `line` (the line's exact text, trimmed) waives that line only: a new, different line in the
 * same file with the same match is a new finding.
 */
export function waives(entry, f) {
  if (entry.rule !== f.rule || entry.file !== f.file) return false;
  if (!(entry.match === f.match || (f.fingerprint !== undefined && entry.match === f.fingerprint))) return false;
  return entry.line === undefined || (typeof f.text === "string" && entry.line === f.text);
}

/**
 * Apply the allowlist. Returns { problems, waived, warnings } where problems
 * include allowlist entries with no reason; stale entries are warnings.
 */
export function applyAllow(findings, allow) {
  const problems = [];
  const warnings = [];
  const used = new Set();
  allow.forEach((e, i) => {
    if (!e || typeof e.why !== "string" || !e.why.trim()) problems.push({ rule: "allowlist", file: CONFIG.allowFile, line: 0, match: String(i), sentence: `${CONFIG.allowFile}: entry ${i + 1} (${e?.rule} in ${e?.file}) has no reason; say why in "why" or remove it.` });
  });
  const kept = [];
  let waived = 0;
  const seen = new Set();
  for (const f of findings) {
    const key = `${f.rule}|${f.file}|${f.line}|${f.match}|${f.where ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const i = allow.findIndex((e) => e && e.why && String(e.why).trim() && waives(e, f));
    if (i >= 0) { used.add(i); waived++; continue; }
    kept.push(f);
  }
  allow.forEach((e, i) => {
    if (e && e.why && String(e.why).trim() && !used.has(i)) warnings.push(`${CONFIG.allowFile}: entry ${i + 1} (${e.rule} in ${e.file}) no longer matches anything; remove it.`);
  });
  return { problems: [...problems, ...kept], waived, warnings };
}

/** Config entries that point at nothing: warnings. */
export function configWarnings(files) {
  const set = new Set(files);
  const out = [];
  for (const f of CONFIG.allowChildProcess) {
    if (!set.has(f)) out.push(`allowChildProcess lists ${f}, which is not tracked (yet).`);
    else {
      const t = readable(f);
      if (t !== undefined && !CHILD_IMPORT.test(t)) out.push(`allowChildProcess lists ${f}, which no longer imports child_process; take it off the list.`);
    }
  }
  for (const f of CONFIG.noGapDocs) if (!set.has(f)) out.push(`noGapDocs lists ${f}, which is not tracked.`);
  return out;
}

/** Counts per rule and per file, for summaries. */
export function summarize(findings) {
  const byRule = {};
  const byFile = {};
  for (const f of findings) {
    byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
    const k = `${f.rule} ${f.file}`;
    byFile[k] = (byFile[k] ?? 0) + 1;
  }
  return { byRule, byFile };
}

/** does `ref` name a commit here */
export function refExists(ref) {
  try {
    git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function main(argv) {
  const i = argv.indexOf("--diff");
  const files = trackedFiles();
  let findings = scanTracked(files);
  const early = [];
  if (i >= 0) {
    const ref = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : "origin/main";
    if (!refExists(ref) && argv.includes("--tree-if-no-ref"))
      early.push(`${ref} is not a commit here (no remote yet, or not fetched): checked the tracked tree only, NOT the commits that would be pushed or their messages. Fetch it (git fetch origin) to check those.`);
    else findings = findings.concat(scanSince(ref));
  }
  const { problems, waived, warnings } = applyAllow(findings, readAllow());
  for (const w of early) console.warn(`warning: ${w}`);
  problems.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  for (const w of [...configWarnings(files), ...warnings]) console.warn(`warning: ${w}`);
  for (const p of problems) console.log(p.sentence);
  if (argv.includes("--summary")) {
    const s = summarize(problems);
    console.log("\nper rule:", JSON.stringify(s.byRule));
    for (const [k, n] of Object.entries(s.byFile).sort()) console.log(`  ${n}\t${k}`);
  }
  const tail = waived ? ` (${waived} waived by the allowlist)` : "";
  if (problems.length) {
    console.log(`\ncheck-security: ${problems.length} problem${problems.length === 1 ? "" : "s"}${tail}.`);
    process.exitCode = 1;
  } else console.log(`check-security: clean${tail}.`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main(process.argv.slice(2));
