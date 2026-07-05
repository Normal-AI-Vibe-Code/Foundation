/**
 * Spreadsheet formula engine: tokenizer + recursive descent parser + evaluator.
 *
 * Supported:
 *   numbers, strings ("..."), + - * / ^ %, unary minus, parentheses
 *   cell refs        A1, BC23
 *   ranges           A1:B3            (inside function args)
 *   cross-table refs Revenue!A1, 'My Table'!A1:B2
 *   functions        SUM AVG AVERAGE MIN MAX COUNT IF ROUND ABS SQRT
 *   comparisons      = <> < > <= >=   (for IF)
 *   string concat    &
 */

export type CellValue = number | string | boolean | null;

export interface CellRef {
  table: string | null; // null = same table
  col: number; // 0-based
  row: number; // 0-based
}

export interface RangeRef {
  table: string | null;
  c0: number;
  r0: number;
  c1: number;
  r1: number;
}

export type AstNode =
  | { kind: "num"; value: number }
  | { kind: "str"; value: string }
  | { kind: "ref"; ref: CellRef }
  | { kind: "range"; range: RangeRef }
  | { kind: "unary"; op: string; operand: AstNode }
  | { kind: "binary"; op: string; left: AstNode; right: AstNode }
  | { kind: "call"; name: string; args: AstNode[] };

export class FormulaError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

// ---------- column helpers ----------

export function colToName(col: number): string {
  let s = "";
  let n = col;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

export function nameToCol(name: string): number {
  let n = 0;
  for (let i = 0; i < name.length; i++) {
    n = n * 26 + (name.charCodeAt(i) - 64);
  }
  return n - 1;
}

// ---------- tokenizer ----------

type Token =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "ident"; v: string }
  | { t: "quoted"; v: string } // 'Table Name'
  | { t: "op"; v: string }
  | { t: "lparen" }
  | { t: "rparen" }
  | { t: "comma" }
  | { t: "colon" }
  | { t: "bang" };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    if (c >= "0" && c <= "9") {
      let j = i;
      while (j < n && /[0-9.]/.test(src[j])) j++;
      const num = parseFloat(src.slice(i, j));
      if (isNaN(num)) throw new FormulaError("#ERR", "bad number");
      tokens.push({ t: "num", v: num });
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = "";
      while (j < n && src[j] !== '"') {
        out += src[j];
        j++;
      }
      if (j >= n) throw new FormulaError("#ERR", "unterminated string");
      tokens.push({ t: "str", v: out });
      i = j + 1;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let out = "";
      while (j < n && src[j] !== "'") {
        out += src[j];
        j++;
      }
      if (j >= n) throw new FormulaError("#ERR", "unterminated name");
      tokens.push({ t: "quoted", v: out });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      tokens.push({ t: "ident", v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c === "(") {
      tokens.push({ t: "lparen" });
      i++;
      continue;
    }
    if (c === ")") {
      tokens.push({ t: "rparen" });
      i++;
      continue;
    }
    if (c === ",") {
      tokens.push({ t: "comma" });
      i++;
      continue;
    }
    if (c === ":") {
      tokens.push({ t: "colon" });
      i++;
      continue;
    }
    if (c === "!") {
      tokens.push({ t: "bang" });
      i++;
      continue;
    }
    // multi-char comparison ops
    if (c === "<" && src[i + 1] === "=") {
      tokens.push({ t: "op", v: "<=" });
      i += 2;
      continue;
    }
    if (c === ">" && src[i + 1] === "=") {
      tokens.push({ t: "op", v: ">=" });
      i += 2;
      continue;
    }
    if (c === "<" && src[i + 1] === ">") {
      tokens.push({ t: "op", v: "<>" });
      i += 2;
      continue;
    }
    if ("+-*/^%&<>=".includes(c)) {
      tokens.push({ t: "op", v: c });
      i++;
      continue;
    }
    throw new FormulaError("#ERR", `unexpected '${c}'`);
  }
  return tokens;
}

// ---------- parser ----------

const CELL_RE = /^([A-Z]+)([0-9]+)$/;

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token | undefined {
    return this.tokens[this.pos++];
  }

  parse(): AstNode {
    const node = this.comparison();
    if (this.pos < this.tokens.length) throw new FormulaError("#ERR", "trailing tokens");
    return node;
  }

  private comparison(): AstNode {
    let left = this.concat();
    while (true) {
      const tok = this.peek();
      if (tok?.t === "op" && ["=", "<>", "<", ">", "<=", ">="].includes(tok.v)) {
        this.next();
        const right = this.concat();
        left = { kind: "binary", op: tok.v, left, right };
      } else break;
    }
    return left;
  }

  private concat(): AstNode {
    let left = this.additive();
    while (true) {
      const tok = this.peek();
      if (tok?.t === "op" && tok.v === "&") {
        this.next();
        const right = this.additive();
        left = { kind: "binary", op: "&", left, right };
      } else break;
    }
    return left;
  }

  private additive(): AstNode {
    let left = this.multiplicative();
    while (true) {
      const tok = this.peek();
      if (tok?.t === "op" && (tok.v === "+" || tok.v === "-")) {
        this.next();
        const right = this.multiplicative();
        left = { kind: "binary", op: tok.v, left, right };
      } else break;
    }
    return left;
  }

  private multiplicative(): AstNode {
    let left = this.power();
    while (true) {
      const tok = this.peek();
      if (tok?.t === "op" && (tok.v === "*" || tok.v === "/" || tok.v === "%")) {
        this.next();
        const right = this.power();
        left = { kind: "binary", op: tok.v, left, right };
      } else break;
    }
    return left;
  }

  private power(): AstNode {
    const left = this.unary();
    const tok = this.peek();
    if (tok?.t === "op" && tok.v === "^") {
      this.next();
      const right = this.power(); // right-assoc
      return { kind: "binary", op: "^", left, right };
    }
    return left;
  }

  private unary(): AstNode {
    const tok = this.peek();
    if (tok?.t === "op" && (tok.v === "-" || tok.v === "+")) {
      this.next();
      return { kind: "unary", op: tok.v, operand: this.unary() };
    }
    return this.primary();
  }

  private primary(): AstNode {
    const tok = this.next();
    if (!tok) throw new FormulaError("#ERR", "unexpected end");

    if (tok.t === "num") return { kind: "num", value: tok.v };
    if (tok.t === "str") return { kind: "str", value: tok.v };

    if (tok.t === "lparen") {
      const inner = this.comparison();
      const close = this.next();
      if (!close || close.t !== "rparen") throw new FormulaError("#ERR", "missing )");
      return inner;
    }

    if (tok.t === "quoted") {
      // 'Table Name'!A1
      const bang = this.next();
      if (!bang || bang.t !== "bang") throw new FormulaError("#ERR", "expected ! after table name");
      return this.refAfterTable(tok.v);
    }

    if (tok.t === "ident") {
      const upper = tok.v.toUpperCase();
      const after = this.peek();

      // function call
      if (after?.t === "lparen") {
        this.next();
        const args: AstNode[] = [];
        if (this.peek()?.t !== "rparen") {
          while (true) {
            args.push(this.comparison());
            const sep = this.peek();
            if (sep?.t === "comma") {
              this.next();
              continue;
            }
            break;
          }
        }
        const close = this.next();
        if (!close || close.t !== "rparen") throw new FormulaError("#ERR", "missing )");
        return { kind: "call", name: upper, args };
      }

      // cross-table ref: Ident!A1
      if (after?.t === "bang") {
        this.next();
        return this.refAfterTable(tok.v);
      }

      // booleans
      if (upper === "TRUE") return { kind: "num", value: 1 };
      if (upper === "FALSE") return { kind: "num", value: 0 };

      // plain cell ref / range
      const m = CELL_RE.exec(upper);
      if (m) return this.refOrRange(null, upper);

      throw new FormulaError("#NAME", `unknown name ${tok.v}`);
    }

    throw new FormulaError("#ERR", "unexpected token");
  }

  private refAfterTable(table: string): AstNode {
    const cellTok = this.next();
    if (!cellTok || cellTok.t !== "ident") throw new FormulaError("#REF", "expected cell after !");
    const upper = cellTok.v.toUpperCase();
    if (!CELL_RE.test(upper)) throw new FormulaError("#REF", `bad ref ${cellTok.v}`);
    return this.refOrRange(table, upper);
  }

  private refOrRange(table: string | null, first: string): AstNode {
    const m1 = CELL_RE.exec(first)!;
    const c0 = nameToCol(m1[1]);
    const r0 = parseInt(m1[2], 10) - 1;

    if (this.peek()?.t === "colon") {
      this.next();
      const endTok = this.next();
      if (!endTok || endTok.t !== "ident") throw new FormulaError("#REF", "bad range end");
      const m2 = CELL_RE.exec(endTok.v.toUpperCase());
      if (!m2) throw new FormulaError("#REF", "bad range end");
      const c1 = nameToCol(m2[1]);
      const r1 = parseInt(m2[2], 10) - 1;
      return {
        kind: "range",
        range: {
          table,
          c0: Math.min(c0, c1),
          r0: Math.min(r0, r1),
          c1: Math.max(c0, c1),
          r1: Math.max(r0, r1),
        },
      };
    }
    return { kind: "ref", ref: { table, col: c0, row: r0 } };
  }
}

export function parseFormula(src: string): AstNode {
  return new Parser(tokenize(src)).parse();
}

// ---------- dependency extraction ----------

export function collectRefs(node: AstNode, out: { refs: CellRef[]; ranges: RangeRef[] }) {
  switch (node.kind) {
    case "ref":
      out.refs.push(node.ref);
      break;
    case "range":
      out.ranges.push(node.range);
      break;
    case "unary":
      collectRefs(node.operand, out);
      break;
    case "binary":
      collectRefs(node.left, out);
      collectRefs(node.right, out);
      break;
    case "call":
      for (const a of node.args) collectRefs(a, out);
      break;
  }
}

// ---------- evaluator ----------

export interface EvalContext {
  /** resolve a single cell's computed value */
  getCell(ref: CellRef): CellValue;
  /** resolve every value in a range (row-major) */
  getRange(range: RangeRef): CellValue[];
}

function toNum(v: CellValue): number {
  if (v === null || v === "") return 0;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  const n = parseFloat(v);
  if (isNaN(n)) throw new FormulaError("#VALUE", `'${v}' is not a number`);
  return n;
}

function toStr(v: CellValue): string {
  if (v === null) return "";
  return String(v);
}

function flattenNumeric(vals: CellValue[]): number[] {
  const out: number[] = [];
  for (const v of vals) {
    if (v === null || v === "") continue;
    if (typeof v === "number") out.push(v);
    else if (typeof v === "string") {
      const n = parseFloat(v);
      if (!isNaN(n)) out.push(n);
    }
  }
  return out;
}

export function evaluate(node: AstNode, ctx: EvalContext): CellValue {
  switch (node.kind) {
    case "num":
      return node.value;
    case "str":
      return node.value;
    case "ref":
      return ctx.getCell(node.ref);
    case "range":
      throw new FormulaError("#VALUE", "range outside function");
    case "unary": {
      const v = toNum(evaluate(node.operand, ctx));
      return node.op === "-" ? -v : v;
    }
    case "binary": {
      const { op } = node;
      if (op === "&") {
        return toStr(evaluate(node.left, ctx)) + toStr(evaluate(node.right, ctx));
      }
      if (["=", "<>", "<", ">", "<=", ">="].includes(op)) {
        const l = evaluate(node.left, ctx);
        const r = evaluate(node.right, ctx);
        let cmp: number;
        if (typeof l === "string" || typeof r === "string") {
          cmp = toStr(l).localeCompare(toStr(r));
        } else {
          cmp = toNum(l) - toNum(r);
        }
        switch (op) {
          case "=":
            return cmp === 0;
          case "<>":
            return cmp !== 0;
          case "<":
            return cmp < 0;
          case ">":
            return cmp > 0;
          case "<=":
            return cmp <= 0;
          case ">=":
            return cmp >= 0;
        }
      }
      const l = toNum(evaluate(node.left, ctx));
      const r = toNum(evaluate(node.right, ctx));
      switch (op) {
        case "+":
          return l + r;
        case "-":
          return l - r;
        case "*":
          return l * r;
        case "/":
          if (r === 0) throw new FormulaError("#DIV/0");
          return l / r;
        case "%":
          if (r === 0) throw new FormulaError("#DIV/0");
          return l % r;
        case "^":
          return Math.pow(l, r);
      }
      throw new FormulaError("#ERR", `bad op ${op}`);
    }
    case "call":
      return callFunction(node.name, node.args, ctx);
  }
}

function argValues(args: AstNode[], ctx: EvalContext): CellValue[] {
  const out: CellValue[] = [];
  for (const a of args) {
    if (a.kind === "range") {
      out.push(...ctx.getRange(a.range));
    } else {
      out.push(evaluate(a, ctx));
    }
  }
  return out;
}

function callFunction(name: string, args: AstNode[], ctx: EvalContext): CellValue {
  switch (name) {
    case "SUM": {
      return flattenNumeric(argValues(args, ctx)).reduce((a, b) => a + b, 0);
    }
    case "AVG":
    case "AVERAGE": {
      const nums = flattenNumeric(argValues(args, ctx));
      if (nums.length === 0) throw new FormulaError("#DIV/0");
      return nums.reduce((a, b) => a + b, 0) / nums.length;
    }
    case "MIN": {
      const nums = flattenNumeric(argValues(args, ctx));
      return nums.length ? Math.min(...nums) : 0;
    }
    case "MAX": {
      const nums = flattenNumeric(argValues(args, ctx));
      return nums.length ? Math.max(...nums) : 0;
    }
    case "COUNT": {
      return flattenNumeric(argValues(args, ctx)).length;
    }
    case "COUNTA": {
      return argValues(args, ctx).filter((v) => v !== null && v !== "").length;
    }
    case "IF": {
      if (args.length < 2 || args.length > 3) throw new FormulaError("#ERR", "IF(cond, then, else)");
      const cond = evaluate(args[0], ctx);
      const truthy = typeof cond === "boolean" ? cond : toNum(cond) !== 0;
      if (truthy) return evaluate(args[1], ctx);
      return args.length === 3 ? evaluate(args[2], ctx) : 0;
    }
    case "ROUND": {
      if (args.length < 1) throw new FormulaError("#ERR", "ROUND(x, digits)");
      const x = toNum(evaluate(args[0], ctx));
      const d = args.length > 1 ? toNum(evaluate(args[1], ctx)) : 0;
      const f = Math.pow(10, d);
      return Math.round(x * f) / f;
    }
    case "ABS":
      return Math.abs(toNum(evaluate(args[0], ctx)));
    case "SQRT": {
      const v = toNum(evaluate(args[0], ctx));
      if (v < 0) throw new FormulaError("#NUM");
      return Math.sqrt(v);
    }
    case "FLOOR":
      return Math.floor(toNum(evaluate(args[0], ctx)));
    case "CEIL":
    case "CEILING":
      return Math.ceil(toNum(evaluate(args[0], ctx)));
    case "POW":
      return Math.pow(toNum(evaluate(args[0], ctx)), toNum(evaluate(args[1], ctx)));
    case "CONCAT":
      return argValues(args, ctx).map(toStr).join("");
    default:
      throw new FormulaError("#NAME", `unknown function ${name}`);
  }
}
