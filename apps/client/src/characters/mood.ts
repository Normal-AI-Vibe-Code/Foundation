/**
 * Each agent's mood, from what the board says about it: the protocol's mood
 * machine (nextMood) stepped whenever the crew changes, and once more when a
 * beat (a wave, a cheer) runs out.
 */

import { useEffect, useRef, useState } from "react";
import { MOOD_START, nextMood, type Mood, type MoodSignal, type MoodState } from "@foundation/protocol";

export interface MoodSource extends MoodSignal {
  id: string;
}

export function useMoods(crew: readonly MoodSource[]): Record<string, Mood> {
  const states = useRef(new Map<string, MoodState>());
  const [, tick] = useState(0);
  const now = Date.now();
  const seen = new Set<string>();
  let wake = 0;
  for (const c of crew) {
    seen.add(c.id);
    const next = nextMood(states.current.get(c.id) ?? MOOD_START, c, now);
    states.current.set(c.id, next);
    if (next.until && (!wake || next.until < wake)) wake = next.until;
  }
  for (const id of states.current.keys()) if (!seen.has(id)) states.current.delete(id);
  // when the nearest beat ends, look again
  useEffect(() => {
    if (!wake) return;
    const t = window.setTimeout(() => tick((n) => n + 1), Math.max(30, wake - Date.now() + 20));
    return () => window.clearTimeout(t);
  }, [wake]);
  return Object.fromEntries(crew.map((c) => [c.id, states.current.get(c.id)!.mood]));
}
