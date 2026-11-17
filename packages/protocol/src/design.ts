/**
 * The design language's chapters: the sections of the design grid (Settings → Design language), in order.
 * The server lays a section out for each (systemgrids.ts); the client draws each chapter's card from the
 * living reference (apps/client/src/design). Add a chapter here and it gets a section on a new design grid.
 */
export const DESIGN_CHAPTERS = [
  { id: "foundations", name: "Foundations" },
  { id: "controls", name: "Controls" },
  { id: "motion", name: "Motion and effects" },
  { id: "floor", name: "The floor and its chrome" },
  { id: "cards", name: "Cards" },
  { id: "search", name: "Search and the hand" },
  { id: "live", name: "Huddles and Slack" },
  { id: "machines", name: "Machines" },
  { id: "agents", name: "Agents" },
  { id: "council", name: "The council" },
  { id: "today", name: "Today" },
  { id: "own", name: "Foundation's own" },
] as const;
export type DesignChapter = (typeof DESIGN_CHAPTERS)[number]["id"];
