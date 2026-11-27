/**
 * The design page's look at FactoryForm's twin cards (2026-11-27): the simulated run as it moves, before any run,
 * the CAD downloads, and the two honest offline states (not answering, and an older FactoryForm), drawn with the
 * card's own component (panels/FactoryTwinView.tsx) from still data.
 */

import { FactoryTwinView, type FactoryTwin, type TwinConnectorState } from "../panels/FactoryTwinView";

const BASE = "http://127.0.0.1:3001";
const TWIN: Extract<FactoryTwin, { ok: true }> = {
  ok: true,
  base: BASE,
  revision: "2.0.0+80e2bf7",
  stale: false,
  facility: { id: "facility-kapaa", name: "Kapaʻa Factory" },
  twins: [
    { id: "chamber-03", name: "Hipot test cell" },
    { id: "brazing", name: "Flame brazing cell" },
    { id: "electronics", name: "UR3e demonstration bench" },
  ],
  run: { id: "run-1", station: "chamber-03", task: "hipot-cycle", taskName: "Hipot test cycle", steps: 11, state: "running", t: 17.4, seconds: 42, step: { index: 3, id: "clamp", label: "Clamp the unit" }, by: "Control", simulated: true },
  alertsOpen: 4,
  pages: { app: `${BASE}/`, floor: `${BASE}/twin`, stations: [] },
  cad: [
    { label: "Kapaʻa Factory floor · glTF", url: `${BASE}/api/twin/v1/facilities/facility-kapaa/floor.glb`, format: "glb", what: "the floor in 3D: slab, equipment, docks" },
    { label: "Kapaʻa Factory floor plan · DXF", url: `${BASE}/api/twin/v1/facilities/facility-kapaa/floor.dxf`, format: "dxf", what: "the plan from above, north up, in metres" },
    { label: "Hipot test cell (chamber-03) · glTF", url: `${BASE}/api/twin/v1/stations/chamber-03/cell.glb`, format: "glb", what: "the cell, arms at home, in its own frame" },
    { label: "Flame brazing cell (brazing) · glTF", url: `${BASE}/api/twin/v1/stations/brazing/cell.glb`, format: "glb", what: "the cell, arms at home, in its own frame" },
  ],
  stations: [],
};

const now = Date.now();
const live = (twin: FactoryTwin): TwinConnectorState => ({ ok: true, summary: "", url: BASE, live: true, provenance: "9 stations demo", provenanceLabel: "demo stations", detail: { twin }, checkedAt: now - 2000 });
const STATES: Array<{ note: string; name: string; view: "run" | "cad"; state: TwinConnectorState; canStart?: boolean }> = [
  { note: "a run moving: Simulated is always said", name: "Simulated run · FactoryForm", view: "run", state: live(TWIN) },
  { note: "nothing run since FactoryForm started; its page is older than its source", name: "Simulated run · FactoryForm", view: "run", state: live({ ...TWIN, run: null, stale: true }) },
  { note: "the CAD: the floor and each station cell", name: "CAD · FactoryForm twin", view: "cad", state: live(TWIN) },
  {
    note: "not answering: an admin at the server's computer may start it",
    name: "Simulated run · FactoryForm",
    view: "run",
    canStart: true,
    state: { ok: false, summary: "offline — nothing is running at 127.0.0.1:3001", url: "", checkedAt: now - 4000 },
  },
  {
    note: "an older FactoryForm, with no twin API (anyone else sees who can start it)",
    name: "Simulated run · FactoryForm",
    view: "run",
    state: {
      ok: false,
      summary: "",
      url: BASE,
      detail: { twin: { ok: false, base: BASE, older: true, reason: "FactoryForm at 127.0.0.1:3001 answers, but it is an older build with no twin API (/api/twin/v1 answered 404). Stop it and start the current checkout with npm run serve." } },
      checkedAt: now - 4000,
    },
  },
];

export function TwinSpecimens() {
  return (
    <div className="ftwin-specimens">
      {STATES.map((s) => (
        <figure key={s.note} className="ftwin-specimen">
          <div className="frame-card live-specimen" style={{ width: 400, height: 380, position: "relative" }}>
            <FactoryTwinView name={s.name} view={s.view} state={s.state} canStart={Boolean(s.canStart)} starting={false} />
          </div>
          <figcaption>{s.note}</figcaption>
        </figure>
      ))}
    </div>
  );
}
