/**
 * Characters: the avatars agents wear on a board (the council), and the art
 * pipeline that makes them. One character is one card on the Character studio
 * board; its pipeline state lives in the board's `characters` map, written by
 * the server alone (every stage spends credits, so only a person's press
 * starts one).
 *
 * The pipeline is WildChild's, staged so a person looks at each result before
 * credits go into the next:
 *
 *   inspiration → sheet (front view) → views → model → rig → clips      (form "model": a 3D skeletal character)
 *   inspiration → sheet (front view) → views (a portrait) → mesh         (form "mesh": a 2D mesh avatar)
 *
 * Lineage is the Vision Archive's: every generated image keeps its prompt
 * word for word, the provider's model, and the hashes of the references it
 * was drawn from (the server's `character_tasks`).
 */

/** 3D skeletal (Meshy: model, rig, clips) or 2D mesh avatar (mesh-avatar: a drawn portrait that blinks, talks and emotes) */
export type CharacterForm = "model" | "mesh";

export type CharacterStageKey = "sheet" | "views" | "model" | "rig" | "clips" | "mesh";

/** the stages of each form, in order */
export const CHARACTER_STAGES: Record<CharacterForm, CharacterStageKey[]> = {
  model: ["sheet", "views", "model", "rig", "clips"],
  mesh: ["sheet", "views", "mesh"],
};

export interface CharacterStage {
  state: "running" | "done" | "failed";
  /** 0–100 while running (the slowest task of the stage) */
  progress?: number;
  error?: string;
  /** credits the provider charged for the stage */
  credits?: number;
  /** who pressed it */
  by?: string;
  at?: number;
}

/** what a character has, by role: file ids in the archive */
export interface CharacterFiles {
  /** the sheet: the character from the front, whole body */
  front?: string;
  back?: string;
  side?: string;
  /** mesh form: head and shoulders, clear background (what the mesh avatar is cut from) */
  portrait?: string;
  /** a still of the finished character, for lists and seats that aren't live */
  thumb?: string;
  /** the textured model, before a skeleton */
  model?: string;
  /** the skinned model with every mood's clip in it: what a seat plays */
  clips?: string;
  /** a .mavatar archive (mesh-avatar) */
  mavatar?: string;
}

export interface CharacterState {
  id: string;
  name: string;
  /** the set it belongs to: "anime", "animal", "abstract", or one someone names */
  set: string;
  form: CharacterForm;
  /** the words that describe it; every prompt is these plus the stage's fixed rules */
  identity: string;
  /** inspiration: file ids of the references it's drawn from (at most five reach the image model) */
  refs: string[];
  stages: Partial<Record<CharacterStageKey, CharacterStage>>;
  files: CharacterFiles;
  /** metres, for the rig (a small creature is 0.6, a person 1.7) */
  height: number;
  /** it can sit on the council: a model with its clips, or a mesh avatar */
  ready: boolean;
  /**
   * A person's word on it (2026-11-16). A character made in the pipeline is "pending" until someone
   * approves it; only approved ones are offered when an agent's avatar is chosen; "archived" keeps it
   * and its files but takes it out of the choice. Absent on characters from before this (and the
   * starter set): they read as approved.
   */
  approval?: "pending" | "approved" | "archived";
}

/** offered as an agent's avatar: finished, and not waiting on (or turned down by) a person */
export const characterChoosable = (c: Pick<CharacterState, "ready" | "approval">) => c.ready && (c.approval === undefined || c.approval === "approved");

// ---------- moods: what an avatar shows ----------

/**
 * What an agent's avatar is doing. `idle`, `thinking`, `working` and
 * `talking` hold for as long as they're true; `happy`, `sad`, `surprised`
 * and `waving` are beats: they play once and the avatar settles back.
 */
export const MOODS = ["idle", "thinking", "working", "talking", "happy", "sad", "surprised", "waving"] as const;
export type Mood = (typeof MOODS)[number];

/** moods that play once and return to what the agent is doing */
export const BEAT_MOODS: readonly Mood[] = ["happy", "sad", "surprised", "waving"];

/**
 * Each mood's clip in Meshy's animation library (GET /openapi/v1/animations/library), and how long a beat holds.
 * Chosen by measuring them on a real skeleton (2026-11-14): a seat faces the room, so these are the clips whose
 * shoulders stay square to the camera. The library's plain "Idle" (0) swings the torso through 150°, "Victory
 * Cheer" spins, "Checkout Gesture" turns away; "Idle 3" keeps within 6°, the fist pump and the shrug within 4°.
 */
export const MOOD_CLIPS: Record<Mood, { actionId: number; name: string; holdMs: number }> = {
  idle: { actionId: 243, name: "Idle 3", holdMs: 0 },
  thinking: { actionId: 36, name: "Confused Scratch", holdMs: 0 },
  working: { actionId: 314, name: "Talk with Right Hand Open", holdMs: 0 },
  talking: { actionId: 313, name: "Talk with Hands Open", holdMs: 0 },
  happy: { actionId: 403, name: "Victory Fist Pump", holdMs: 3000 },
  sad: { actionId: 391, name: "Head Hold in Pain", holdMs: 3700 },
  surprised: { actionId: 317, name: "Shrug", holdMs: 2000 },
  waving: { actionId: 28, name: "Big Wave Hello", holdMs: 3200 },
};

/** a mesh avatar's face for each mood (mesh-avatar's emotion tags and expressions) */
export const MOOD_FACES: Record<Mood, { emotion: "happy" | "sad" | "angry" | "surprised" | "relaxed" | "neutral"; expression: "neutral" | "smile" | "shy" | "surprise" | "halfLidded" | "angry" | "sad" | "wink"; speaking?: boolean }> = {
  idle: { emotion: "relaxed", expression: "neutral" },
  thinking: { emotion: "neutral", expression: "halfLidded" },
  working: { emotion: "neutral", expression: "neutral" },
  talking: { emotion: "neutral", expression: "neutral", speaking: true },
  happy: { emotion: "happy", expression: "smile" },
  sad: { emotion: "sad", expression: "sad" },
  surprised: { emotion: "surprised", expression: "surprise" },
  waving: { emotion: "happy", expression: "wink" },
};

/** what the board knows about an agent at one moment (its awareness, reduced to what a mood reads) */
export interface MoodSignal {
  status: "working" | "done" | "stopped" | "error";
  /** what its cursor says it's doing */
  doing: string;
  /** it is asking its person something (a guide waiting on Go) */
  asking?: boolean;
  /** it is aiming at something it's about to change */
  aiming?: boolean;
}

const READS = /^(read|look|search|find|check|list|think|plan|decid|work(ing)? out|study|compar|review|wait|ask)/i;

/** the mood an agent's state holds (never a beat: beats come from changes, in `nextMood`) */
export function baseMood(s: MoodSignal): Mood {
  if (s.status === "error") return "sad";
  if (s.status !== "working") return "idle";
  if (s.asking) return "talking";
  if (!s.doing.trim() || READS.test(s.doing.trim())) return "thinking";
  return "working";
}

export interface MoodState {
  mood: Mood;
  /** the held mood under a beat, to settle back to */
  base: Mood;
  /** when the current beat ends (0: not in a beat) */
  until: number;
  /** the last status seen, to tell a change from a steady state */
  status: MoodSignal["status"] | null;
}

export const MOOD_START: MoodState = { mood: "idle", base: "idle", until: 0, status: null };

/**
 * The avatar's state machine, one step: the state before, what the board says
 * now, and the time. An agent arriving waves; finishing cheers; failing holds
 * its head; being stopped is a surprise. A beat is never cut short by a held
 * mood (so a cheer plays out), but a newer beat replaces it.
 */
export function nextMood(prev: MoodState, s: MoodSignal, now: number): MoodState {
  const base = baseMood(s);
  let beat: Mood | null = null;
  if (prev.status === null) beat = s.status === "working" ? "waving" : null;
  else if (prev.status !== s.status) {
    if (s.status === "done") beat = "happy";
    else if (s.status === "error") beat = "sad";
    else if (s.status === "stopped") beat = "surprised";
    else if (s.status === "working") beat = "waving";
  }
  if (beat) return { mood: beat, base: beat === "sad" ? "sad" : base, until: now + MOOD_CLIPS[beat].holdMs, status: s.status };
  if (prev.until && now < prev.until) return { ...prev, base, status: s.status };
  return { mood: base, base, until: 0, status: s.status };
}

/** a steady pick from a list by name: the same agent name wears the same character everywhere */
export function pickByName<T>(name: string, from: readonly T[]): T | undefined {
  if (!from.length) return undefined;
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  return from[(h >>> 0) % from.length];
}

/**
 * Seat a crew: each agent's character. A choice someone made for that name
 * wins; otherwise a steady pick by name, moved along when another agent in
 * the room already wears it (while there are enough to go round).
 */
export function seatCrew(names: readonly string[], ready: readonly string[], chosen: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  const taken = new Set<string>();
  for (const n of names) {
    const c = chosen[n];
    if (c && ready.includes(c)) {
      out[n] = c;
      taken.add(c);
    }
  }
  for (const n of names) {
    if (out[n] || !ready.length) continue;
    const first = ready.indexOf(pickByName(n, ready)!);
    let pick = ready[first];
    for (let i = 0; i < ready.length; i++) {
      const c = ready[(first + i) % ready.length];
      if (!taken.has(c)) {
        pick = c;
        break;
      }
    }
    out[n] = pick;
    taken.add(pick);
  }
  return out;
}
