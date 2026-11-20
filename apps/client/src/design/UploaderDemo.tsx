import { avatarKey, type UploaderEntry, type UploaderState } from "@foundation/protocol";
import { UploaderCard } from "../panels/UploaderView";

/**
 * Foundation's avatars on `#/design`, drawn by the card the grid uses (panels/UploaderView.tsx `UploaderCard`):
 * with nothing wired in, and with three sets wired, one character added since the last upload, one waiting
 * for approval and one leaving. Nothing here reaches a server; the stills are stand-ins in a neutral grey.
 */

const still = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><g fill="gray"><circle cx="48" cy="40" r="20" fill-opacity=".55"/><rect x="28" y="64" width="40" height="40" rx="14" fill-opacity=".4"/></g></svg>')}`;
const entry = (name: string, set: string, form: "mesh" | "model", via: string, state: UploaderEntry["state"] = "avatar", why?: string): UploaderEntry => ({ id: `chr_${name.toLowerCase()}`, name, set, form, key: avatarKey({ form, set, name }), state, via, why, panel: undefined });
const ENTRIES: UploaderEntry[] = [
  entry("Aoi", "anime", "mesh", "Characters · Anime"),
  entry("Hana", "anime", "mesh", "Characters · Anime"),
  entry("Midori", "anime", "mesh", "Characters · Anime"),
  entry("Kiko", "anime", "mesh", "Characters · Anime"),
  entry("Mochi", "animals", "mesh", "Characters · Animals"),
  entry("Kumo", "animals", "mesh", "Characters · Animals"),
  entry("Taro", "animals", "mesh", "Characters · Animals", "waiting", "waiting for a person to approve it"),
  entry("Ember", "abstract", "model", "Characters · Abstract"),
  entry("Dot", "abstract", "mesh", "Characters · Abstract"),
  entry("Quad", "abstract", "mesh", "Characters · Abstract", "removed", "leaves Foundation's avatars at the next upload"),
];
const full: UploaderState = {
  entries: ENTRIES,
  inMain: ENTRIES.filter((e) => e.name !== "Kiko" && e.name !== "Taro").map((e) => e.key),
  every: 86_400_000,
  everyBy: "Josh",
  nextAt: Date.UTC(2026, 10, 18, 9, 0),
  target: "joshleong/Foundation · main",
  last: { at: Date.UTC(2026, 10, 17, 9, 0), outcome: "pushed", text: "Uploaded 21 avatars to joshleong/Foundation · main (+Dot, Tri).", commit: "ccab7a1f00", by: "Josh", how: "manual" },
};
const stills = Object.fromEntries(ENTRIES.map((e) => [e.id, still]));

function Frame({ w, h, children }: { w: number; h: number; children: React.ReactNode }) {
  return (
    <div className="frame-card panel-card kind-uploader" style={{ width: w, height: h, position: "relative", borderRadius: "var(--radius-card)", background: "var(--color-raise)", boxShadow: "var(--shadow-sheet), 0 0 0 1px var(--color-line)" }}>
      {children}
    </div>
  );
}

export function UploaderDemo() {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-6)", alignItems: "flex-start" }} data-design-uploader>
      <Frame w={460} h={520}>
        <UploaderCard state={{ entries: [], inMain: [], target: "joshleong/Foundation · main" }} viewer={false} />
      </Frame>
      <Frame w={960} h={900}>
        <UploaderCard state={full} viewer={false} stills={stills} />
      </Frame>
      <Frame w={460} h={360}>
        <UploaderCard state={{ entries: ENTRIES.slice(0, 2), inMain: ENTRIES.slice(0, 2).map((e) => e.key), cannot: "Only a Foundation server started from a checkout of its code can upload. This one runs from its install: what main has arrives here when its server starts." }} viewer={false} stills={stills} />
      </Frame>
    </div>
  );
}
