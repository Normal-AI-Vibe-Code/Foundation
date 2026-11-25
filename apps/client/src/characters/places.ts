/**
 * silhouettes on a council nobody has joined (2026-11-21, Josh: "the silhouettes should be closer to each other until an
 * agent is added, and then there should only be one silhouette to add new agents"): three, standing close as a group;
 * from the first agent on, the agents and one silhouette to add another
 */
export const COUNCIL_PLACES = 3;
/** how many silhouettes a council shows beside its agents */
export const ghostCount = (agents: number, canAsk: boolean) => (!canAsk ? 0 : agents ? 1 : COUNCIL_PLACES);
