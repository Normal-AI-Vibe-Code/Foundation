/**
 * The company's own apps — the vibe-coded tools Form Industries runs on, in
 * the order people reach for them. One list for Today (server), the Chrome
 * extension (built from this file) and anything else that shows them. Where
 * an app lives can differ per machine, so its address comes from `env` (or
 * the server's connector config); with neither, it shows as "not linked".
 */
export interface CompanyAppDef {
  id: string;
  name: string;
  role: string;
  glyph: string;
  repo?: string;
  /** the connector Foundation reads live, for a status dot */
  connector?: string;
  /** the environment variable that holds its address */
  env?: string;
}

export const COMPANY_APPS: CompanyAppDef[] = [
  { id: "bomform", name: "BomForm", role: "BOMs, certification, critical components", glyph: "▤", connector: "bomform", env: "BOMFORM_URL" },
  { id: "factoryform", name: "FactoryForm", role: "Inventory, stations, work orders, builds", glyph: "⚙", repo: "joshleong/FactoryForm", connector: "factoryform", env: "FACTORYFORM_APP_URL" },
  { id: "hyperform", name: "HyperForm", role: "HyperForm programme", glyph: "◈", env: "HYPERFORM_URL" },
  { id: "vision", name: "Vision", role: "Design, simulation, CAD", glyph: "◎", connector: "vision", env: "VISION_URL" },
  { id: "dataroom", name: "Airform Data Room", role: "Programmes, economics, investors", glyph: "▥", repo: "joshleong/AirformDataRoom", connector: "dataroom", env: "DATAROOM_URL" },
  { id: "creation", name: "Creation", role: "Brand, merchandise, studio", glyph: "✎", repo: "joshleong/Creation", connector: "creation", env: "CREATION_URL" },
  { id: "fleetform", name: "FleetForm", role: "The fleet", glyph: "⛬", repo: "joshleong/FleetForm", env: "FLEETFORM_URL" },
  { id: "foundation", name: "Foundation boards", role: "The grid: people, apps and agents", glyph: "▦", repo: "joshleong/Foundation", connector: "foundation" },
];
