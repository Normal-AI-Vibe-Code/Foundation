/**
 * A character, drawn: a 3D model playing its mood's clip, a mesh avatar
 * wearing its mood's face, or a still while either loads (or isn't made yet).
 *
 * Seats inside a council share one stage (StageContext); an avatar on its
 * own (a character's card) makes a small stage of its own.
 */

import { createContext, useContext, useEffect, useRef, useState, type CSSProperties } from "react";
import { MOOD_FACES, type Mood } from "@foundation/protocol";
import { arrivalStyle } from "../lib/arrival";
import { useFileSrc } from "../lib/fileSrc";
import { peekExactImage, viewportDistance } from "../lib/imageCache";
import { cutoutSrc, useCutout } from "./cutout";
import { Actor, AvatarStage, type Framing } from "./actor";
import { useModelStill } from "./portrait";
import { characterBytes, characterFilePath, type RosterCharacter } from "./roster";
import { CROSSFADE_MS, restPicture } from "./stagePolicy";

export const StageContext = createContext<AvatarStage | null>(null);

interface Props {
  character: RosterCharacter | undefined;
  mood: Mood;
  framing: Framing;
  /** lean toward something, in radians (a seat turns to the middle of the table) */
  turn?: number;
  /** hold its picture instead of playing (a card that has no place on the stage right now) */
  still?: boolean;
  /**
   * a card's way of resting and waking (2026-11-25; stagePolicy.ts): at rest it shows its kept picture (a 3D
   * character: the model drawn once, portrait.ts), and playing cross-fades the live character over that picture,
   * and back. Without it (a council seat) a live character materialises over its silhouette, as before.
   */
  poster?: boolean;
  /** the card has come near the screen: a poster may draw its model's still (default true) */
  near?: boolean;
}

/** the best picture a character has for a framing, among the ones it really has (never a role the server would 404) */
export function stillRole(c: Pick<RosterCharacter, "files" | "form">, framing: Framing): string | null {
  const f = c.files as Record<string, string | undefined>;
  const order = framing === "full" ? ["front", "thumb", "portrait"] : c.form === "mesh" ? ["portrait", "thumb", "front"] : ["thumb", "front", "portrait"];
  return order.find((r) => f[r]) ?? null;
}

export function Avatar({ character, mood, framing, turn = 0, still = false, poster = false, near = true }: Props) {
  if (!character) return <div className="avatar avatar-none" aria-hidden="true">✦</div>;
  if (poster) return <PosterAvatar character={character} mood={mood} framing={framing} turn={turn} still={still} near={near} />;
  if (still) return <Still character={character} role={stillRole(character, framing) ?? "thumb"} />;
  if (character.form === "model" && character.files.clips) return <ModelAvatar character={character} mood={mood} framing={framing} turn={turn} />;
  // a mesh avatar is its portrait; head to toe, it's the sheet standing still
  if (character.form === "mesh" && character.files.mavatar && framing === "bust") return <MeshAvatarView character={character} mood={mood} />;
  return <Still character={character} role={stillRole(character, framing) ?? "thumb"} mood={mood} />;
}

/** true while `on`, and for `ms` after it turns false: what's leaving stays for its fade */
function useLinger(on: boolean, ms: number): boolean {
  const [held, setHeld] = useState(on);
  useEffect(() => {
    if (on) return setHeld(true);
    const t = window.setTimeout(() => setHeld(false), ms);
    return () => window.clearTimeout(t);
  }, [on, ms]);
  return on || held;
}

/**
 * A still's picture. One that was already in memory (a remount, another card of the same character) shows at once;
 * one that had to be read or made fades in, a few steps later the farther it is from the middle of the screen
 * (lib/arrival.ts), so a board's characters arrive as a wave and none pops.
 */
function StillImage({ src, instant, className, alt, onError }: { src: string; instant: boolean; className: string; alt: string; onError?: () => void }) {
  // decided when the picture first shows: a later render neither restarts nor cancels its fade
  const [arriving] = useState(!instant);
  const el = useRef<HTMLImageElement>(null);
  const [style, setStyle] = useState<CSSProperties | undefined>(undefined);
  useEffect(() => {
    if (arriving && el.current) setStyle(arrivalStyle(viewportDistance(el.current)) as CSSProperties | undefined);
  }, [arriving]);
  return <img ref={el} className={`avatar ${className}${arriving ? " is-arriving" : ""}`} style={style} src={src} alt={alt} draggable={false} decoding="async" onError={onError} />;
}

/** a character's picture by role, breathing a little so a still seat isn't dead */
export function Still({ character, role, mood }: { character: RosterCharacter; role: string; mood?: Mood }) {
  const files = character.files as Record<string, string | undefined>;
  // the role asked for, or the nearest picture there is
  const use = files[role] ? role : (["thumb", "portrait", "front"].find((r) => files[r]) ?? null);
  // which file that is rides in the address (roster.ts): a sheet drawn again is a new picture, never the kept one
  const path = use ? characterFilePath(character.id, use, files[use]) : null;
  // its cut-out already in memory: there on the first frame, with no fade
  // (asked once per picture: another role, or a sheet drawn again, arrives as its own)
  const first = useRef<{ path: string | null; instant: boolean } | null>(null);
  if (!first.current || first.current.path !== path) first.current = { path, instant: path ? peekExactImage(cutoutSrc(path), "orig") !== null : false };
  const instant = first.current.instant;
  // a seat is at most a few hundred pixels and its cutout is drawn at 384: the 512 tier, cached, never the original
  // (an original per character, decoded on the main thread, was most of a studio's first load)
  const file = useFileSrc(path, true, { width: 512 });
  // without its flat ground (characters/cutout.ts): the figure alone, so a silhouette is a figure and not a box.
  // Cut in a worker and kept under the file's own address, in memory and between launches
  const src = useCutout(file, path ?? undefined);
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  // nothing drawn yet, still fetching, or a picture that didn't load: the agent's mark, never a broken image
  if (!src || broken) return <div className="avatar avatar-none" aria-hidden="true">✦</div>;
  return <StillImage key={path ?? ""} src={src} instant={instant} className={`avatar-still${mood ? ` is-${mood}` : ""}`} alt={character.name} onError={() => setBroken(true)} />;
}

/**
 * A card's character (the `poster` way): its picture at rest, the live character cross-faded over it while it
 * plays. The picture stays underneath until the live one is drawing, and is back before the live one goes, so
 * there is never a frame with neither.
 */
function PosterAvatar({ character, mood, framing, turn, still, near }: { character: RosterCharacter; mood: Mood; framing: Framing; turn: number; still: boolean; near: boolean }) {
  const files = character.files as Record<string, string | undefined>;
  const rest = restPicture({ form: character.form, framing, files });
  const playable = character.form === "model" ? Boolean(files.clips) : Boolean(files.mavatar) && framing === "bust";
  const playing = !still && playable;
  // the live one stays through its fade out
  const mounted = useLinger(playing, CROSSFADE_MS);
  const [live, setLive] = useState(false);
  useEffect(() => {
    if (!mounted) setLive(false);
  }, [mounted]);
  const render = useModelStill(character, rest.kind === "render" ? rest.file : undefined, framing, near);
  // until the model's still is drawn (its first visit) the drawn sheet stands in, and stays under the still's fade in
  const sheet = useLinger(rest.kind !== "render" || !render.url, CROSSFADE_MS);
  const sheetRole = rest.kind === "picture" ? rest.role : (stillRole(character, framing) ?? "thumb");
  const state = playing && live ? "live" : render.url ? "render" : "picture";
  return (
    <div className={`avatar avatar-poster${state === "live" ? " is-playing" : ""}`} data-character={character.name} data-poster={state}>
      <div className="avatar-rest">
        {sheet && <Still character={character} role={sheetRole} />}
        {render.url && <StillImage src={render.url} instant={render.instant} className="avatar-still avatar-render" alt={character.name} />}
      </div>
      {mounted &&
        (character.form === "model" ? (
          <ModelAvatar character={character} mood={mood} framing={framing} turn={turn} bare onState={setLive} />
        ) : (
          <MeshAvatarView character={character} mood={mood} bare onState={setLive} />
        ))}
    </div>
  );
}

interface LiveProps {
  /** inside a poster: no silhouette of its own (the poster's picture is underneath) */
  bare?: boolean;
  /** told when it starts and stops drawing */
  onState?: (live: boolean) => void;
}

function ModelAvatar({ character, mood, framing, turn, bare = false, onState }: { character: RosterCharacter; mood: Mood; framing: Framing; turn: number } & LiveProps) {
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
  useEffect(() => onState?.(state === "live"), [state]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={host} className={`avatar avatar-3d is-${state}`} data-character={character.name} data-mood={mood} data-framing={framing}>
      {state !== "live" && !bare && <Still character={character} role="thumb" />}
      {!shared && <canvas ref={canvas} className="avatar-canvas" />}
    </div>
  );
}

/**
 * Mesh avatars that have left the screen, kept ready (2026-11-25). Opening one is the costly part: the runtime
 * reads its portrait's pixels and builds its mesh on the page, 170–520 ms in one task (measured on the studio), and
 * a card that woke, slept and woke again paid it each time. So a card that stops playing hands its avatar here
 * instead of destroying it, canvas and all, and the next card to play that character takes it back and is live on
 * its first frame. A kept avatar costs nothing while it waits: it is opened in the runtime's manual mode (no frame
 * loop of its own) and only the card showing it advances it. A few at most (each holds a WebGL context, and a page
 * has about sixteen); the one kept longest is destroyed.
 */
type KeptMesh = { canvas: HTMLCanvasElement; avatar: import("mesh-avatar").MeshAvatar };
const MESH_KEPT = 3;
const meshKept = new Map<string, KeptMesh>();
function keepMesh(key: string, kept: KeptMesh) {
  meshKept.get(key)?.avatar.destroy();
  meshKept.delete(key);
  meshKept.set(key, kept);
  while (meshKept.size > MESH_KEPT) {
    const [oldest, gone] = meshKept.entries().next().value as [string, KeptMesh];
    meshKept.delete(oldest);
    gone.avatar.destroy();
  }
}
/** for the checks: how many wait */
export const meshAvatarsKept = () => meshKept.size;

function MeshAvatarView({ character, mood, bare = false, onState }: { character: RosterCharacter; mood: Mood } & LiveProps) {
  const host = useRef<HTMLDivElement>(null);
  const avatar = useRef<import("mesh-avatar").MeshAvatar | null>(null);
  const fileId = character.files.mavatar!;
  const key = `${character.id}/${fileId}`;
  // one that's waiting is live at once: no silhouette, no load
  const [state, setState] = useState<"loading" | "live" | "failed">(() => (meshKept.has(key) ? "live" : "loading"));

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let gone = false;
    let raf = 0;
    let mine: KeptMesh | null = null;
    // the runtime is opened without a frame loop (manual): this card draws it, a frame at a time, while it shows it
    const run = (kept: KeptMesh) => {
      mine = kept;
      avatar.current = kept.avatar;
      let last = performance.now();
      const frame = (now: number) => {
        raf = requestAnimationFrame(frame);
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        if (dt > 0 && !document.hidden) kept.avatar.advance(dt, 1 / dt);
      };
      kept.avatar.advance(0);
      raf = requestAnimationFrame(frame);
      setState("live");
    };
    const waiting = meshKept.get(key);
    if (waiting) {
      meshKept.delete(key);
      el.appendChild(waiting.canvas);
      run(waiting);
    } else {
      setState("loading");
      const canvas = document.createElement("canvas");
      canvas.className = "avatar-canvas";
      el.appendChild(canvas);
      void (async () => {
        try {
          const [{ loadMeshAvatar }, bytes] = await Promise.all([import("mesh-avatar"), characterBytes(character.id, "mavatar", fileId)]);
          if (gone) return canvas.remove();
          // the runtime keeps what it's given: hand it its own copy
          const a = await loadMeshAvatar(canvas, bytes.slice(0), { fit: "contain", manual: true });
          if (gone) {
            // opened while the card was leaving: it's paid for, so it waits for the next one
            canvas.remove();
            return keepMesh(key, { canvas, avatar: a });
          }
          run({ canvas, avatar: a });
        } catch {
          canvas.remove();
          if (!gone) setState("failed");
        }
      })();
    }
    return () => {
      gone = true;
      cancelAnimationFrame(raf);
      avatar.current = null;
      if (!mine) return;
      mine.canvas.remove();
      keepMesh(key, mine);
    };
  }, [character.id, fileId, key]);

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
  useEffect(() => onState?.(state === "live"), [state]); // eslint-disable-line react-hooks/exhaustive-deps

  // the canvas is the kept avatar's own (or a new one), put in by hand above: it outlives this card
  return (
    <div ref={host} className={`avatar avatar-mesh is-${state}`} data-character={character.name} data-mood={mood}>
      {state !== "live" && !bare && <Still character={character} role={character.files.portrait ? "portrait" : "thumb"} />}
    </div>
  );
}
