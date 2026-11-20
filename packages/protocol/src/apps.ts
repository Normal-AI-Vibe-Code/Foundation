/**
 * The company's own apps — the vibe-coded tools Form Industries runs on, in
 * the order people reach for them. One list for Today (server), the Chrome
 * extension (built from this file) and anything else that shows them. Where
 * an app lives can differ per machine, so its address comes from `env` (or
 * the server's connector config), else the address it is hosted at (`url`);
 * with none of them, it shows as "not linked".
 *
 * Most of them are hosted on HyperForm (2026-11-19): `https://<name>.apps.normallab.co`,
 * behind HyperForm's own sign-in (a work Google account, at dock.apps.normallab.co).
 * Those are marked `signIn: "hyperform"`: a frame can't show them (the sign-in
 * refuses framing, and its cookie doesn't travel into a frame), so in Foundation
 * they open as a page of the server's own browser (PanelDoc.via === "browser").
 *
 * PartForm is the app once called BomForm (its own page is titled "Airform BOM"); behind HyperForm's sign-in it
 * asks for a second one, OnShape's, by invitation.
 */
export interface CompanyAppDef {
  id: string;
  name: string;
  role: string;
  glyph: string;
  repo?: string;
  /** the connector Foundation reads live, for a status dot */
  connector?: string;
  /** the environment variables that may hold its address, first one set wins */
  env?: string | string[];
  /** where it is hosted, when nothing on this machine says otherwise */
  url?: string;
  /** whose sign-in stands in front of it */
  signIn?: "hyperform";
}

/** HyperForm: where the company's apps are deployed, and whose sign-in they share */
export const HYPERFORM_URL = "https://dock.apps.normallab.co/";
/** the hosts HyperForm serves apps on: `<name>.apps.normallab.co` */
export const HYPERFORM_APPS_DOMAIN = "apps.normallab.co";

/** is this address one of HyperForm's (the dock, or an app it hosts)? */
export function onHyperForm(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname.endsWith(`.${HYPERFORM_APPS_DOMAIN}`);
  } catch {
    return false;
  }
}

export const COMPANY_APPS: CompanyAppDef[] = [
  { id: "hyperform", name: "HyperForm", role: "Where our apps are deployed: projects, builds, addresses", glyph: "◈", env: "HYPERFORM_URL", url: HYPERFORM_URL, signIn: "hyperform" },
  { id: "partform", name: "PartForm", role: "Airform BOM: every part and assembly, from OnShape", glyph: "▤", connector: "bomform", env: ["PARTFORM_URL", "BOMFORM_URL"], url: "https://partform.apps.normallab.co/", signIn: "hyperform" },
  { id: "deployform", name: "DeployForm", role: "Unit inventory and installs, by project", glyph: "⚑", env: "DEPLOYFORM_URL", url: "https://deployform.apps.normallab.co/", signIn: "hyperform" },
  { id: "factoryform", name: "FactoryForm", role: "Inventory, stations, work orders, builds", glyph: "⚙", repo: "joshleong/FactoryForm", connector: "factoryform", env: "FACTORYFORM_APP_URL", url: "https://factory-form-factoryform.apps.normallab.co/", signIn: "hyperform" },
  // the rest of what HyperForm's dashboard lists (read 2026-11-19); its storage, stopped and empty projects are left out
  { id: "metalform", name: "MetalForm", role: "Hawaiʻi community fabrication: quotes and jobs", glyph: "⬡", env: "METALFORM_URL", url: "https://formindustries-metalform.apps.normallab.co/", signIn: "hyperform" },
  { id: "gantt", name: "Form Gantt", role: "Gantt charts, shared by group", glyph: "▬", env: "GANTT_URL", url: "https://gnatt-chart-web.apps.normallab.co/", signIn: "hyperform" },
  { id: "airform", name: "Airform", role: "The product site (airform.space)", glyph: "◌", env: "AIRFORM_URL", url: "https://airform.space/" },
  { id: "chess", name: "Form Chess", role: "Play a colleague", glyph: "♞", env: "CHESS_URL", url: "https://form-chess-web.apps.normallab.co/", signIn: "hyperform" },
  { id: "vision", name: "Vision", role: "Design, simulation, CAD", glyph: "◎", connector: "vision", env: "VISION_URL" },
  { id: "dataroom", name: "Airform Data Room", role: "Programmes, economics, investors", glyph: "▥", repo: "joshleong/AirformDataRoom", connector: "dataroom", env: "DATAROOM_URL" },
  { id: "creation", name: "Creation", role: "Brand, merchandise, studio", glyph: "✎", repo: "joshleong/Creation", connector: "creation", env: "CREATION_URL" },
  { id: "fleetform", name: "FleetForm", role: "The fleet", glyph: "⛬", repo: "joshleong/FleetForm", env: "FLEETFORM_URL" },
  { id: "foundation", name: "Foundation boards", role: "The grid: people, apps and agents", glyph: "▦", repo: "joshleong/Foundation", connector: "foundation" },
];
