/**
 * Every wire layer on the grid (app/pipeline wires, table→map and formula
 * wires) publishes its routes here, so over/under is decided across all of
 * them: a formula wire can tunnel under an app wire and vice versa, with one
 * stable order (by id) everywhere.
 */

import { pipeCrossings, type Crossing, type P } from "./wireGeometry";

const layers = new Map<string, Map<string, P[]>>();
let version = 0;
let cache: { version: number; crossings: Map<string, Crossing[]> } | null = null;

/** publish a layer's routes; cheap when nothing changed */
export function publishRoutes(layer: string, routes: Map<string, P[]>, signature: string) {
  const prev = layers.get(layer) as (Map<string, P[]> & { sig?: string }) | undefined;
  if (prev?.sig === signature) return;
  const next = new Map(routes) as Map<string, P[]> & { sig?: string };
  next.sig = signature;
  layers.set(layer, next);
  version++;
}

export function unpublishRoutes(layer: string) {
  if (layers.delete(layer)) version++;
}

export function routesVersion() {
  return version;
}

/** crossings over every published route, computed once per change */
export function allCrossings(): Map<string, Crossing[]> {
  if (cache?.version === version) return cache.crossings;
  const routes: { id: string; points: P[] }[] = [];
  for (const m of layers.values()) for (const [id, points] of m) routes.push({ id, points });
  cache = { version, crossings: pipeCrossings(routes) };
  return cache.crossings;
}
