/**
 * A CAD file's card shows the part, not a glyph. It renders once into a
 * still (so a board of CAD cards holds no WebGL contexts), and turns when
 * dragged — one live viewer at a time; letting go leaves the new view as the
 * still. The size and triangle count sit underneath.
 */

import { useEffect, useRef, useState } from "react";
import { isNight } from "@foundation/ui";
import { loadModel, stage, type Model } from "./model";
import { fetchFile } from "../lib/api";

let liveOwner: (() => void) | null = null; // the one card turning right now

export function CadPreview({ url, name }: { url: string; name: string }) {
  const box = useRef<HTMLDivElement>(null);
  const model = useRef<Model | null>(null);
  const [still, setStill] = useState<string | null>(null);
  const [info, setInfo] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const viewer = useRef<ReturnType<typeof stage> | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const bytes = new Uint8Array(await (await fetchFile(url)).arrayBuffer());
        const m = await loadModel(name, bytes);
        if (!alive) return;
        model.current = m;
        const r = box.current!.getBoundingClientRect();
        const v = stage(m, Math.max(160, r.width), Math.max(120, r.height), isNight());
        setStill(v.still());
        v.dispose();
        const s = m.size;
        const u = m.units === "mm" ? " mm" : "";
        setInfo(`${Math.round(s.x)} × ${Math.round(s.y)} × ${Math.round(s.z)}${u} · ${m.triangles.toLocaleString()} triangles`);
      } catch (e) {
        if (alive) setErr((e as Error).message);
      }
    })();
    return () => {
      alive = false;
    };
  }, [url, name]);

  const stop = () => {
    const v = viewer.current;
    if (!v) return;
    setStill(v.still());
    v.dispose();
    viewer.current = null;
    setLive(false);
  };

  const onDown = (e: React.PointerEvent) => {
    if (!model.current || !box.current) return;
    e.stopPropagation(); // turning the part, not dragging the card
    if (liveOwner && liveOwner !== stop) liveOwner();
    liveOwner = stop;
    const r = box.current.getBoundingClientRect();
    if (!viewer.current) {
      viewer.current = stage(model.current, r.width, r.height, isNight());
      viewer.current.canvas.className = "cad-live";
      box.current.appendChild(viewer.current.canvas);
      setLive(true);
    }
    let x = e.clientX;
    let y = e.clientY;
    const move = (ev: PointerEvent) => {
      viewer.current?.turn((ev.clientX - x) * 0.01, (ev.clientY - y) * 0.01);
      x = ev.clientX;
      y = ev.clientY;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      stop();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="cad-view">
      <div ref={box} className={`cad-stage${live ? " is-live" : ""}`} onPointerDown={onDown} title="Drag to turn">
        {still && !live && <img src={still} alt={`${name} in 3D`} draggable={false} />}
        {!still && !err && <div className="cad-loading">Reading {name}…</div>}
        {err && <div className="cad-error">{err}</div>}
      </div>
      {info && <div className="cad-info">{info}</div>}
    </div>
  );
}
