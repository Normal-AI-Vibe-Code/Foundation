/**
 * Global editing session — lets a formula editor capture clicks on other
 * cells (in any table) and insert references like `B3` or `Revenue!B3`.
 */

export interface EditingSession {
  tableId: string;
  /** current editor text (kept in sync by the editor) */
  getText(): string;
  /** insert a reference string at the caret */
  insertRef(ref: string): void;
}

let session: EditingSession | null = null;

export function startEditingSession(s: EditingSession) {
  session = s;
}

export function endEditingSession(s: EditingSession) {
  if (session === s) session = null;
}

/**
 * Called on cell mousedown anywhere. Returns true if the click was consumed
 * as a reference insertion (the caller should not change selection).
 */
export function tryInsertRef(targetTableId: string, targetTableName: string, refA1: string): boolean {
  if (!session) return false;
  const text = session.getText();
  if (!text.startsWith("=")) return false;
  // only insert when the caret follows an operator/opening context,
  // i.e. the formula visibly "wants" an operand
  const trimmed = text.trimEnd();
  const last = trimmed[trimmed.length - 1];
  if (!"=+-*/^%&<>(,:".includes(last)) return false;

  let ref = refA1;
  if (targetTableId !== session.tableId) {
    const safe = /^[A-Za-z_][A-Za-z0-9_]*$/.test(targetTableName)
      ? targetTableName
      : `'${targetTableName}'`;
    ref = `${safe}!${refA1}`;
  }
  session.insertRef(ref);
  return true;
}

export function hasEditingSession(): boolean {
  return session !== null;
}
