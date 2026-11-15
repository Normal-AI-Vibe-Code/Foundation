/**
 * A character, drawn: a 3D model playing its mood's clip, a mesh avatar
 * wearing its mood's face, or a still while either loads (or isn't made yet).
 *
 * Seats inside a council share one stage (StageContext); an avatar on its
 * own (a character's card) makes a small stage of its own.
 */

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { MOOD_FACES, type Mood } from "@foundation/protocol";
import { useFileSrc } from "../lib/fileSrc";
import { Actor, AvatarStage, type Framing } from "./actor";
import { characterBytes, characterFilePath, type RosterCharacter } from "./roster";

export const StageContext = createContext<AvatarStage | null>(null);

interface Props {
  character: RosterCharacter | undefined;
  mood: Mood;
  framing: Framing;
  /** lean toward something, in radians (a seat turns to the middle of the table) */
  turn?: number;
}

export function Avatar({ character, mood, framing, turn = 0 }: Props) {
  if (!character) return <div className="avatar avatar-none" aria-hidden="true">✦</div>;
  if (character.form === "model" && character.files.clips) return <ModelAvatar character={character} mood={mood} framing={framing} turn={turn} />;
  // a mesh avatar is its portrait; head to toe, it's the sheet standing still
  if (character.form === "mesh" && character.files.mavatar && framing === "bust") return <MeshAvatarView character={character} mood={mood} />;
  return <Still character={character} role={framing === "full" && character.files.front ? "front" : character.files.portrait ? "portrait" : character.files.thumb ? "thumb" : "front"} mood={mood} />;
}

/** a character's picture by role, breathing a little so a still seat isn't dead */
export function Still({ character, role, mood }: { character: RosterCharacter; role: string; mood?: Mood }) {
  const has = Boolean((character.files as Record<string, string | undefined>)[role]);
  const src = useFileSrc(has ? characterFilePath(character.id, role) : null);
  if (!src) return <div className="avatar avatar-none" aria-hidden="true">✦</div>;
  return <img className={`avatar avatar-still${mood ? ` is-${mood}` : ""}`} src={src} alt={character.name} draggable={false} />;
}

function ModelAvatar({ character, mood, framing, turn }: Required<Props> & { character: RosterCharacter }) {
  const shared = useContext(StageContext);
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const actor = useRef<Actor | null>(null);
  const [state, setState] = useState<"loading" | "live" | "failed">("loading");
  const fileId = character.files.clips!;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let own: AvatarStage | null = null;
    let stage = shared;
    if (!stage) {
      if (!canvas.current) return;
      try {
        own = stage = new AvatarStage(canvas.current);
      } catch {
        setState("failed"); // no WebGL: the still stays
        return;
      }
    }
    const a = new Actor();
    actor.current = a;
    a.setFraming(framing, true);
    a.setMood(mood);
    stage.add(a, el);
    let gone = false;
    setState("loading");
    characterBytes(character.id, "clips", fileId)
      .then((b) => a.load(b))
      .then(() => !gone && setState("live"))
      .catch(() => !gone && setState("failed"));
    return () => {
      gone = true;
      stage!.remove(a);
      a.dispose();
      own?.dispose();
      actor.current = null;
    };
    // the stage and the file decide the actor; mood, framing and turn are pushed to it below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shared, character.id, fileId]);

  useEffect(() => actor.current?.setMood(mood), [mood]);
  useEffect(() => actor.current?.setFraming(framing), [framing]);
  useEffect(() => actor.current?.setTurn(turn), [turn]);

  return (
    <div ref={host} className={`avatar avatar-3d is-${state}`} data-character={character.name} data-mood={mood} data-framing={framing}>
      {state !== "live" && <Still character={character} role="thumb" />}
      {!shared && <canvas ref={canvas} className="avatar-canvas" />}
    </div>
  );
}

function MeshAvatarView({ character, mood }: { character: RosterCharacter; mood: Mood }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const avatar = useRef<import("mesh-avatar").MeshAvatar | null>(null);
  const [state, setState] = useState<"loading" | "live" | "failed">("loading");
  const fileId = character.files.mavatar!;

  useEffect(() => {
    let gone = false;
    setState("loading");
    void (async () => {
      try {
        const [{ loadMeshAvatar }, bytes] = await Promise.all([import("mesh-avatar"), characterBytes(character.id, "mavatar", fileId)]);
        if (gone || !canvas.current) return;
        // the runtime keeps what it's given: hand it its own copy
        const a = await loadMeshAvatar(canvas.current, bytes.slice(0), { fit: "contain" });
        if (gone) return a.destroy();
        avatar.current = a;
        setState("live");
      } catch {
        if (!gone) setState("failed");
      }
    })();
    return () => {
      gone = true;
      avatar.current?.destroy();
      avatar.current = null;
    };
  }, [character.id, fileId]);

  // the mood's face; while talking, the mouth follows a made-up voice (there is no audio to follow)
  useEffect(() => {
    const a = avatar.current;
    if (!a || state !== "live") return;
    const face = MOOD_FACES[mood];
    a.setEmotion(face.emotion === "neutral" ? null : face.emotion, { playMotion: true });
    a.setExpression(face.expression);
    a.setSpeaking(Boolean(face.speaking));
    if (!face.speaking) {
      a.setVoiceLevel(0);
      return;
    }
    let t = 0;
    const id = window.setInterval(() => {
      t += 0.11;
      a.setVoiceLevel(Math.max(0, 0.45 + 0.4 * Math.sin(t * 7.1) * Math.sin(t * 2.3)));
    }, 60);
    return () => window.clearInterval(id);
  }, [mood, state]);

  return (
    <div className={`avatar avatar-mesh is-${state}`} data-character={character.name} data-mood={mood}>
      {state !== "live" && <Still character={character} role={character.files.portrait ? "portrait" : "thumb"} />}
      <canvas ref={canvas} className="avatar-canvas" />
    </div>
  );
}
