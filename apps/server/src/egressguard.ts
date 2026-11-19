/**
 * The network seams' side of the outgoing gate (egress.ts). Kept apart, with
 * nothing but the audit log under it, so the Slack, GitHub and Flowform
 * clients can call it without importing the rest of the server.
 *
 * `guardEgress(service)` is called where a request is about to leave for that
 * service. Outside a gated call (a person's own request, the server's own
 * work) it does nothing. Inside an agent's call it lets through only the
 * services that call was allowed to reach, and otherwise nothing leaves.
 */

import { audit, callScope } from "./audit.ts";
import { HttpError } from "./http.ts";

export type SendKind = "query" | "message" | "read" | "call" | "spend";

const KIND_WORDS: Record<SendKind, string> = { query: "searches", read: "reads", message: "messages", call: "calls", spend: "spending" };
export const listWords = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** what an agent is told when nothing was sent */
export function heldSentence(held: Array<{ service: string; kind?: SendKind }>) {
  const what = listWords([...new Set(held.map((h) => `${h.kind ? KIND_WORDS[h.kind] : "sending"} to ${h.service}`))]);
  return `Nothing was sent to ${listWords([...new Set(held.map((h) => h.service))])}: a person has to allow ${what} from this board first. Someone who can edit the board turns it on in the board's pane (the ⓘ on its tab), under “Agents on this board may send to”. Tell the person what you wanted to send and why; don't try another way.`;
}

/** a send held at a network seam: nothing left */
export class EgressHeld extends HttpError {
  constructor(public service: string) {
    super(403, heldSentence([{ service }]));
  }
}

/**
 * For a step that comes before the send itself (finding out whose token to use): true when this call may
 * not reach the service, and the service is noted as held (and recorded) exactly as guardEgress would.
 * Nothing is thrown, so the caller can go on without that service.
 */
export function egressBlocked(service: string): boolean {
  try {
    guardEgress(service);
    return false;
  } catch (e) {
    if (e instanceof EgressHeld) return true;
    throw e;
  }
}

export function guardEgress(service: string) {
  const s = callScope.getStore();
  if (!s || !s.gated || s.allowed.has(service)) return;
  s.held.add(service);
  if (s.route) {
    const a = s.route.actor;
    audit({ actor_kind: a.kind, actor_id: a.id, actor_name: a.name, for_person: a.for ?? null, board_id: s.route.board, door: "route", action: s.route.action, target: service, provenance: "external", service, decision: "asked", reason: "no allowance on this board" });
  }
  throw new EgressHeld(service);
}
