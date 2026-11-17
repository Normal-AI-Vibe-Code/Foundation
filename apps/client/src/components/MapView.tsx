import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { workbook } from "../engine/workbook";
import {
  HEADER_H,
  MapMeta,
  bindMap,
  liveObjPos,
  moveMap,
  removeMap,
  resizeMap,
  setActiveObject,
  setObjectFloat,
  toggleMapPitch,
} from "../state/store";
import { parsePairs, tableOptionsSlice, useStoreSlice } from "../state/slices";
import { Spring, Spring2D, presets } from "../physics/spring";
import { countRender } from "../state/renders";
import { startCarry, type Carry } from "../lib/carry";
import { modHeld, putInUse } from "../lib/cardUse";
import { keys } from "../lib/keys";
import { useUi } from "../state/ui";
import { FullscreenBar, FullscreenButton, useFullscreenCard } from "./Fullscreen";

interface Props {
  map: MapMeta;
  /** effective position (flow-layout slot when docked, free when floating) */
  framePos: { x: number; y: number };
  /** this card is the current keyboard/interaction context */
  isActive: boolean;
  getScale(): number;
  /** grid zoom spring — maps are interactive when zoom ≈ 1 */
  zoomSpring: Spring;
}

interface Pt {
  lat: number;
  lng: number;
  label: string;
}

/** Free raster style — OpenStreetMap tiles, no API key required. */
const MAP_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [
    { id: "bg", type: "background", paint: { "background-color": "#e9e5dd" } },
    { id: "osm", type: "raster", source: "osm" },
  ],
};

/** Pull {lat, lng, label} rows out of a table: row 0 is the header row. */
function extractPoints(tableId: string): Pt[] {
  const t = workbook.getTable(tableId);
  if (!t) return [];
  const val = (c: number, r: number) => {
    const cell = t.cells.get(`${c},${r}`);
    return cell && !cell.error ? cell.value : null;
  };
  let latCol = -1;
  let lngCol = -1;
  let labelCol = -1;
  for (let c = 0; c < t.cols; c++) {
    const h = String(val(c, 0) ?? "").trim().toLowerCase();
    if (latCol < 0 && /^lat/.test(h)) latCol = c;
    else if (lngCol < 0 && /^(lng|lon)/.test(h)) lngCol = c;
    else if (labelCol < 0 && /(name|label|title|person|who|place|city)/.test(h)) labelCol = c;
  }
  if (latCol < 0 || lngCol < 0) return [];
  if (labelCol < 0) {
    for (let c = 0; c < t.cols; c++) {
      if (c !== latCol && c !== lngCol) {
        labelCol = c;
        break;
      }
    }
  }
  const pts: Pt[] = [];
  for (let r = 1; r < t.rows; r++) {
    const lat = Number(val(latCol, r));
    const lng = Number(val(lngCol, r));
    if (
      isFinite(lat) &&
      isFinite(lng) &&
      (lat !== 0 || lng !== 0) &&
      Math.abs(lat) <= 90 &&
      Math.abs(lng) <= 180
    ) {
      pts.push({ lat, lng, label: labelCol >= 0 ? String(val(labelCol, r) ?? "") : "" });
    }
  }
  return pts;
}

function makePinElement(label: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "map-pin";
  el.innerHTML =
    '<div class="pin-pulse"></div><div class="pin-dot"></div>' +
    (label ? `<div class="pin-label">${escapeHtml(label)}</div>` : "");
  return el;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export const MapView = memo(function MapView({ map: meta, framePos, isActive, getScale, zoomSpring }: Props) {
  countRender("MapView");
  // the table picker's ids and names only: a keystroke or a drag elsewhere doesn't render the map
  const tableOptions = useStoreSlice(tableOptionsSlice);
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const lastFitKey = useRef("");
  const [pointCount, setPointCount] = useState(0);

  // ----- drag by header (same spring physics as tables) -----
  const pos = useMemo(
    () => new Spring2D(framePos.x, framePos.y, presets.drag),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [meta.id],
  );
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const apply = (x: number, y: number) => {
      el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      liveObjPos.set(meta.id, { x, y });
    };
    apply(pos.x.value, pos.y.value);
    const unsub = pos.onChange(apply);
    return () => {
      unsub();
      liveObjPos.delete(meta.id);
    };
  }, [pos, meta.id]);
  useEffect(() => {
    if (!dragRef.current.active) pos.to(framePos.x, framePos.y);
  }, [framePos.x, framePos.y, pos]);

  const dragRef = useRef({ active: false, moved: false, startX: 0, startY: 0, origX: 0, origY: 0, carry: null as Carry | null });

  const onHeaderPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest("button, select")) return;
      e.stopPropagation();
      if (!meta.float) setObjectFloat(meta.id, true); // grabbing undocks it
      const d = dragRef.current;
      d.active = true;
      d.moved = false;
      d.startX = e.clientX;
      d.startY = e.clientY;
      d.origX = pos.x.goal;
      d.origY = pos.y.goal;
      rootRef.current?.classList.add("dragging");
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch { /* synthetic */ }
    },
    [pos, meta.id, meta.float],
  );
  const onHeaderPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (!d.active) return;
      if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) >= 4) {
        d.moved = true;
        // out of its section, it lifts out and can land in another (lib/carry.ts)
        const anchor = rootRef.current;
        const card = anchor?.querySelector<HTMLElement>(".map-card");
        if (anchor && card) d.carry = startCarry(meta.id, anchor, card, e.clientX, e.clientY);
      }
      if (d.carry?.move(e.clientX, e.clientY)) return;
      const s = getScale();
      pos.to(d.origX + (e.clientX - d.startX) / s, d.origY + (e.clientY - d.startY) / s);
    },
    [pos, getScale],
  );
  const onHeaderPointerUp = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d.active) return;
    d.active = false;
    rootRef.current?.classList.remove("dragging");
    const carry = d.carry;
    d.carry = null;
    if (carry && (e.type === "pointercancel" ? (carry.cancel(), false) : carry.end(e.clientX, e.clientY))) {
      pos.set(d.origX, d.origY);
      return;
    }
    moveMap(meta.id, pos.x.goal, pos.y.goal);
  }, [pos, meta.id]);

  // ----- resize handle -----
  const resizeRef = useRef({ active: false, startX: 0, startY: 0, origW: 0, origH: 0 });
  const onResizeDown = useCallback(
    (e: React.PointerEvent) => {
      e.stopPropagation();
      const d = resizeRef.current;
      d.active = true;
      d.startX = e.clientX;
      d.startY = e.clientY;
      d.origW = meta.w;
      d.origH = meta.h;
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch { /* synthetic */ }
    },
    [meta.w, meta.h],
  );
  const onResizeMove = useCallback(
    (e: React.PointerEvent) => {
      const d = resizeRef.current;
      if (!d.active) return;
      const s = getScale();
      resizeMap(
        meta.id,
        d.origW + (e.clientX - d.startX) / s,
        d.origH + (e.clientY - d.startY) / s,
      );
    },
    [meta.id, getScale],
  );
  const onResizeUp = useCallback(() => {
    resizeRef.current.active = false;
  }, []);

  // ----- maplibre init -----
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const m = new maplibregl.Map({
      container: body,
      style: MAP_STYLE,
      center: [-30, 25],
      zoom: 1.4,
      pitch: meta.pitched ? 50 : 0,
      attributionControl: { compact: true },
      canvasContextAttributes: { antialias: true, powerPreference: "high-performance" },
    });
    m.dragRotate.enable();
    m.touchZoomRotate.enable();
    mapRef.current = m;
    const ro = new ResizeObserver(() => m.resize());
    ro.observe(body);
    return () => {
      ro.disconnect();
      markersRef.current.forEach((mk) => mk.remove());
      markersRef.current = [];
      m.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta.id]);

  // ----- 3D pitch toggle -----
  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;
    m.easeTo({ pitch: meta.pitched ? 50 : 0, duration: 900, easing: easeSpringy });
  }, [meta.pitched]);

  // ----- markers from the bound table -----
  const refreshMarkers = useCallback(() => {
    const m = mapRef.current;
    if (!m) return;
    const pts = meta.sourceTableId ? extractPoints(meta.sourceTableId) : [];
    setPointCount(pts.length);
    markersRef.current.forEach((mk) => mk.remove());
    markersRef.current = pts.map((p) =>
      new maplibregl.Marker({ element: makePinElement(p.label), anchor: "center" })
        .setLngLat([p.lng, p.lat])
        .addTo(m),
    );
    // auto-fit when the constellation of points changes
    const key =
      (meta.sourceTableId ?? "none") +
      "|" +
      pts.map((p) => `${p.lat.toFixed(3)},${p.lng.toFixed(3)}`).sort().join(";");
    if (pts.length > 0 && key !== lastFitKey.current) {
      lastFitKey.current = key;
      if (pts.length === 1) {
        m.easeTo({ center: [pts[0].lng, pts[0].lat], zoom: 9, duration: 1100, easing: easeSpringy });
      } else {
        const b = new maplibregl.LngLatBounds();
        for (const p of pts) b.extend([p.lng, p.lat]);
        m.fitBounds(b, { padding: 70, maxZoom: 11, duration: 1200, easing: easeSpringy });
      }
    }
  }, [meta.sourceTableId]);

  useEffect(() => {
    refreshMarkers();
    if (!meta.sourceTableId) return;
    return workbook.subscribe(meta.sourceTableId, () => refreshMarkers());
  }, [meta.sourceTableId, refreshMarkers]);

  // ----- in use: only when asked (⌘/Ctrl-click, or full screen), never by zooming close (lib/cardUse.ts) -----
  const ui = useUi();
  const fullscreen = useFullscreenCard() === meta.id;
  const engaged = ui.engaged === meta.id || fullscreen;
  void zoomSpring;

  const engage = useCallback(
    (e: React.PointerEvent) => {
      if (!modHeld(e)) return; // a plain press selects the card; the grid keeps the pointer
      e.stopPropagation();
      putInUse(meta.id);
    },
    [meta.id],
  );

  const tables = useMemo(() => parsePairs(tableOptions).map(([id, name]) => ({ id, name })), [tableOptions]);

  return (
    <div ref={rootRef} className="map-anchor" style={{ width: meta.w }}>
      <motion.div
        className={"map-card fs-able" + (isActive ? " ctx-active" : "")}
        style={{ width: meta.w }}
        initial={{ scale: 0.55, opacity: 0, y: 60, rotate: 1.5 }}
        animate={{ scale: 1, opacity: 1, y: 0, rotate: 0 }}
        transition={{ type: "spring", stiffness: 230, damping: 19, mass: 1.05 }}
        onPointerDown={() => setActiveObject(meta.id)}
      >
        {fullscreen && <FullscreenBar id={meta.id} title={meta.name} />}
        <div
          className="table-header map-header"
          style={{ height: HEADER_H }}
          onPointerDown={onHeaderPointerDown}
          onPointerMove={onHeaderPointerMove}
          onPointerUp={onHeaderPointerUp}
          onPointerCancel={onHeaderPointerUp}
        >
          <div className="grip">
            <span />
            <span />
            <span />
          </div>
          <div className="table-name map-title">{meta.name}</div>
          <select
            className="map-bind"
            value={meta.sourceTableId ?? ""}
            onChange={(e) => bindMap(meta.id, e.target.value || null)}
            onPointerDown={(e) => e.stopPropagation()}
            title="Table that drives the markers (needs lat / lng columns)"
          >
            <option value="">— no table —</option>
            {tables.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <span className="map-count">
            {meta.sourceTableId
              ? pointCount > 0
                ? `${pointCount} pin${pointCount === 1 ? "" : "s"}`
                : "no lat/lng"
              : ""}
          </span>
          <div className="header-actions">
            <button
              className={"icon-btn float-btn" + (meta.float ? " floating" : "")}
              data-tip={meta.float ? "Dock into the section" : "Float freely"}
              onClick={() => setObjectFloat(meta.id, !meta.float)}
            >
              {meta.float ? "✥" : "⌗"}
            </button>
            <FullscreenButton id={meta.id} />
            <button
              className={"icon-btn map-3d" + (meta.pitched ? " on" : "")}
              data-tip="Tilt into 3D"
              onClick={() => toggleMapPitch(meta.id)}
            >
              3D
            </button>
            <button
              className="icon-btn is-remove"
              data-tip="Delete map"
              onClick={() => removeMap(meta.id)}
            >
              ✕
            </button>
          </div>
        </div>

        <div className="map-body-wrap" style={{ height: meta.h }}>
          <div ref={bodyRef} className="map-body" />
          {!engaged && (
            <div
              className="map-shield"
              onPointerDown={engage}
            >
              <span className="map-shield-hint">
                {keys("mod+click")} to use · {keys("mod+enter")} full screen
              </span>
            </div>
          )}
        </div>

        <div
          className="map-resize"
          onPointerDown={onResizeDown}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
          onPointerCancel={onResizeUp}
          title="Resize map"
        />
      </motion.div>
    </div>
  );
});

/** overshooting ease that reads as springy inside maplibre's easing hook */
function easeSpringy(t: number): number {
  const s = 1.35;
  const u = t - 1;
  return u * u * ((s + 1) * u + s) + 1;
}
