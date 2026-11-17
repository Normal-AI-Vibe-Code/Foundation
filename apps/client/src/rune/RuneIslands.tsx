/**
 * Web islands: the cards Rune doesn't draw (scene.ts `isIsland`: live apps,
 * pages, machines, huddles, Slack, connectors, maps, video, and the table in
 * hand), as the web renderer's own components, over Rune's canvas.
 *
 * Each section gets its own shell here: the section's box with nothing of its
 * own drawn (Rune draws the paper and the header), holding just those cards
 * in the same body, at the same fit, as the web renderer lays them out. The
 * markup is the web's (`.section-card > .section-body > .section-content >
 * .obj-slot`), so the cards' styles, their drag, carry and ports, and the
 * grid's own rules about what's under the pointer all apply unchanged. The
 * shell takes no pointer itself: a press between islands goes to Rune.
 */

import { Suspense, lazy, memo, useCallback, useMemo } from "react";
import { PanelView } from "../panels/PanelView";
import { MediaView } from "../components/MediaView";
import { NoteView } from "../components/NoteView";
import { TableView } from "../components/TableView";
import { CONTENT_PAD, effectivePos, getState, isPanel, sectionRestRect, useSection, type GridTracks, type Section } from "../state/store";
import type { Spring } from "../physics/spring";
import { runeImageSrc } from "./imageSrc";
import { isIsland } from "./scene";

// MapLibre is ~1 MB: load it only when a board has a map
const MapView = lazy(() => import("../components/MapView").then((m) => ({ default: m.MapView })));

const IslandSection = memo(function IslandSection({ section, grid, getScale, zoomSpring }: { section: Section; grid: GridTracks; getScale(): number; zoomSpring: Spring }) {
  const view = useSection(section.id);
  const rect = sectionRestRect(grid, section);
  const { host, objects, fit } = view;
  const islands = useMemo(
    // which table is in hand decides whether it's an island: the section's snapshot says when that changes
    () => objects.filter((o) => isIsland(getState(), o, { imageSrc: runeImageSrc })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [objects, view.activeObjectId],
  );
  // cards convert pointer moves with the scale they're drawn at: the camera's times the fit
  const getContentScale = useCallback(() => getScale() * fit, [getScale, fit]);
  if (!host && islands.length === 0) return null;
  return (
    <div className="section-card is-rune-shell" data-section-id={section.id} style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>
      <div className="section-body">
        <div className="section-content" style={{ transform: `scale(${fit})` }}>
          {islands.map((o) => {
            const pos = effectivePos(o);
            const active = view.activeObjectId === o.id;
            return (
              <div key={o.id} className="obj-slot" data-obj-id={o.id} style={{ left: CONTENT_PAD, top: CONTENT_PAD }}>
                {isPanel(o) ? (
                  <PanelView panel={o} pos={pos} isActive={active} getScale={getContentScale} />
                ) : "cols" in o ? (
                  <TableView table={o} framePos={pos} isActive={active} getScale={getContentScale} />
                ) : "sourceTableId" in o ? (
                  <Suspense fallback={null}>
                    <MapView map={o} framePos={pos} isActive={active} getScale={getContentScale} zoomSpring={zoomSpring} />
                  </Suspense>
                ) : "media" in o ? (
                  <MediaView item={o} pos={pos} isActive={active} getScale={getContentScale} />
                ) : "text" in o ? (
                  <NoteView note={o} pos={pos} isActive={active} getScale={getContentScale} />
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
      {/* the hosted app fills the section; its ports sit on the section's edges */}
      {host && <PanelView panel={host} pos={{ x: 0, y: 0 }} hosted isActive={view.activeObjectId === host.id} getScale={getScale} />}
    </div>
  );
});

export function RuneIslands({ sections, grid, getScale, zoomSpring }: { sections: Section[]; grid: GridTracks; getScale(): number; zoomSpring: Spring }) {
  return (
    <>
      {sections.map((s) => (
        <IslandSection key={s.id} section={s} grid={grid} getScale={getScale} zoomSpring={zoomSpring} />
      ))}
    </>
  );
}
