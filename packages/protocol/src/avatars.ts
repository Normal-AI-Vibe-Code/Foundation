/**
 * Foundation's avatars (2026-11-17, Josh: "visualize that the Characters are being exported to the Section on
 * the left through the pipes … a Node that can accept Character Input Cards through the flow interface, that
 * shows that they have been set as avatars for Foundation to use anywhere. Breaking a connection will remove
 * that … the uploader can force a manual upload, but also can set a timer").
 *
 * The uploader is a card (`panel: "uploader"`) with one input. What is wired into it is Foundation's set of
 * avatars: a character card's own output, a section (every character card in it), a collection (the
 * characters it holds) or a studio flow's Output node (its set's finished characters). A wired character
 * that is finished and approved is an avatar here, and is in the next upload; a wired one waiting for a
 * person's approval is shown as waiting. Taking a wire off archives the characters only it brought (kept,
 * not offered) and leaves them out of the next upload; wiring them back brings them back.
 *
 * An upload writes the set into main's starter set (`apps/server/starter/characters`) and pushes it, when
 * it changed. Every Foundation then has those characters when its server next starts, and the ones taken
 * out are withdrawn there (archived, files kept). An upload is a person's press or a person's timer.
 *
 * The server alone writes this, in the board's `uploaders` map.
 */

/** the uploader's input, by name, and the type every character wire carries */
export const UPLOADER_IN = "avatars";
export const CHARACTER_TYPE = "character";
/** a character card's output, by name */
export const CHARACTER_OUT = "character";
/** a wire whose source is a section, not a card, leaves by this port */
export const SECTION_PORT = "characters";

/** how often a timer uploads; 0 is off */
export const UPLOAD_EVERY: ReadonlyArray<{ ms: number; label: string }> = [
  { ms: 0, label: "Off" },
  { ms: 60 * 60 * 1000, label: "Every hour" },
  { ms: 6 * 60 * 60 * 1000, label: "Every 6 hours" },
  { ms: 24 * 60 * 60 * 1000, label: "Every day" },
  { ms: 7 * 24 * 60 * 60 * 1000, label: "Every week" },
];

/** one character on an uploader */
export interface UploaderEntry {
  /** the character (an original's id: a copy's card counts as its original) */
  id: string;
  name: string;
  set: string;
  form: "model" | "mesh";
  /** its card on this board */
  panel?: string;
  /** form:set:name, how every install knows it */
  key: string;
  /**
   * avatar: wired, finished and approved, an avatar here and in the next upload;
   * waiting: wired, but not finished or not approved yet;
   * removed: its wire was taken off, so it was archived here and leaves main at the next upload
   */
  state: "avatar" | "waiting" | "removed";
  /** why it waits, in a few words */
  why?: string;
  /** what brought it: "Characters · Anime", "its card" */
  via?: string;
}

export interface UploadResult {
  at: number;
  /** "pushed": a commit went to main; "same": main already had this set; "failed" */
  outcome: "pushed" | "same" | "failed";
  /** what happened, in a line */
  text: string;
  commit?: string;
  /** "manual" or "timer", and the person whose press or timer it was */
  by: string;
  how: "manual" | "timer";
  added?: string[];
  removed?: string[];
}

export interface UploaderState {
  entries: UploaderEntry[];
  /** the keys main's starter set has, as last read or uploaded */
  inMain: string[];
  /** a timer: how often (ms; 0 or absent: off), who set it, and when it next runs */
  every?: number;
  everyBy?: string;
  nextAt?: number;
  /** an upload under way */
  running?: boolean;
  last?: UploadResult;
  /** why this server can't upload (not a checkout of the repo, no git): shown on the card */
  cannot?: string;
  /** where an upload goes, for the card: "joshleong/Foundation · main" */
  target?: string;
}

/** how every install names a character of the starter set */
export const avatarKey = (c: { form: string; set: string; name: string }) => `${c.form}:${c.set.trim().toLowerCase()}:${c.name.trim().toLowerCase()}`;
