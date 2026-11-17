import type { CharacterState } from "@foundation/protocol";
import type { Costs, Inspiration, StudioCharacter } from "../lib/characterStudio";
import { CharacterSheet } from "../panels/CharacterView";
import { PipeFlow, PipeNode } from "../panels/PipelineView";

/**
 * The Character studio's two surfaces, on `#/design` ("The council"), drawn by the components the grid
 * uses (panels/CharacterView.tsx `CharacterSheet`, panels/PipelineView.tsx `PipeFlow`), so what is here is
 * what ships:
 *
 *  - the character card as a sheet, at the three widths a card is read at (260, 400, 560) and at its own
 *    460 × 720, each in a different state: nothing drawn yet; in the making with its expressions; one
 *    from before expression sheets, finished and waiting on a person; approved and read by a viewer;
 *  - the flow as nodes: each with the characters that are at it, the Sheet node with ＋ New open.
 *
 * Nothing here reaches a server: the presses do nothing, and the pictures are stand-ins (a plain figure in
 * a neutral grey that reads on day and night paper; there is no archive on this page).
 */

const figure = (panels: number) => {
  const one = (x: number, y: number, s: number, open: boolean) =>
    `<g transform="translate(${x} ${y}) scale(${s})" fill="gray"><circle cx="48" cy="38" r="20" fill-opacity=".55"/><rect x="30" y="62" width="36" height="52" rx="12" fill-opacity=".4"/>${open ? `<rect x="42" y="42" width="12" height="7" rx="3" fill-opacity=".9"/>` : `<rect x="40" y="44" width="16" height="2" fill-opacity=".9"/>`}</g>`;
  const body = panels === 1 ? one(0, 0, 1, false) : Array.from({ length: 8 }, (_, i) => one((i % 4) * 48, Math.floor(i / 4) * 72, 0.5, i === 5)).join("");
  const [w, h] = panels === 1 ? [96, 128] : [192, 144];
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">${body}</svg>`)}`;
};
const ONE = figure(1);
const EIGHT = figure(8);

const price: Costs = { configured: true, balance: 1509, imageModel: "nano-banana-pro", costs: { model: { sheet: 9, expressions: 9, views: 18, model: 30, rig: 5, clips: 24 }, mesh: { sheet: 9, expressions: 9, views: 9, mesh: 0 } } };
const inspiration: Inspiration[] = [1, 2, 3, 4, 5, 6].map((n) => ({ file: `f_demo${n}`, src: ONE, name: `reference ${n}` }));

const done = (by = "Josh", credits = 9) => ({ state: "done" as const, by, credits });
const base = { refs: [], files: {}, stages: {}, height: 0.7, ready: false } satisfies Partial<CharacterState>;
const person = (c: Partial<CharacterState> & Pick<CharacterState, "id" | "name" | "set" | "form" | "identity">): StudioCharacter => ({ ...base, approval: "pending", ...c, panelId: `pnl_${c.id}` });

const fresh = person({ id: "demo_new", name: "New character", set: "animals", form: "mesh", identity: "" });
const making = person({
  id: "demo_kuro",
  name: "Kuro",
  set: "animals",
  form: "mesh",
  identity: "## A black shiba with a fox-like face\n\nFaces the viewer **with both eyes open and the mouth closed**.\n\n- cream muzzle and brow spots\n- a _teal_ scarf, knotted at the side\n- chunky vinyl-toy proportions, about two and a half heads tall",
  refs: ["f_demo1", "f_demo3"],
  stages: { sheet: done(), expressions: done() },
  files: { front: "f_a", expressions: "f_b", thumb: "f_a" },
});
const older = person({
  id: "demo_mochi",
  name: "Mochi",
  set: "animals",
  form: "mesh",
  identity: "A cheerful shiba in a teal scarf, facing the viewer with both eyes open and the mouth closed.",
  refs: ["f_demo2"],
  stages: { sheet: done("the starter set", 0), views: done("the starter set", 0), mesh: done("the starter set", 0) },
  files: { front: "f_c", portrait: "f_d", thumb: "f_d", mavatar: "f_e" },
  ready: true,
});
const approved: StudioCharacter = { ...older, id: "demo_sage", panelId: "pnl_demo_sage", name: "Sage", identity: "A calm snow monkey, from the torso up, fur tipped with frost.", approval: "approved", stages: { ...older.stages, expressions: done() }, files: { ...older.files, expressions: "f_f" } };

/** the flow's cast: one character at each place a character can be */
const cast: StudioCharacter[] = [
  person({ id: "demo_f1", name: "Taro", set: "animals", form: "mesh", identity: "A shiba, standing.", stages: {} }),
  person({ id: "demo_f2", name: "Yuzu", set: "animals", form: "mesh", identity: "A tabby.", stages: { sheet: { state: "failed", error: "Meshy refused (402): not enough credits" } } }),
  making,
  person({ id: "demo_f3", name: "Kumo", set: "animals", form: "mesh", identity: "A white shiba.", stages: { sheet: done(), expressions: { state: "running", progress: 40 } }, files: { front: "f_g", thumb: "f_g" } }),
  person({ id: "demo_f4", name: "Shiro", set: "animals", form: "mesh", identity: "A fox-faced shiba.", stages: { sheet: done(), expressions: done(), views: done() }, files: { front: "f_h", portrait: "f_i", thumb: "f_i" } }),
  person({ id: "demo_f5", name: "Pip", set: "animals", form: "model", identity: "A round bird.", stages: { sheet: done(), expressions: done(), views: done("Josh", 18) }, files: { front: "f_j", thumb: "f_j" } }),
  person({ id: "demo_f6", name: "Bao", set: "animals", form: "model", identity: "A bun with legs.", stages: { sheet: done(), expressions: done(), views: done(), model: done("Josh", 30), rig: { state: "running", progress: 70 } }, files: { front: "f_k", thumb: "f_k" } }),
  older,
  approved,
];
const stillsOf = Object.fromEntries(cast.filter((c) => c.files.thumb).map((c) => [c.id, ONE]));
const pictures = { thumb: ONE, front: ONE, portrait: ONE, expressions: EIGHT };

function Card({ width, height = 720, note, children }: { width: number; height?: number; note: string; children: React.ReactNode }) {
  return (
    <figure className="studio-demo-card" style={{ width }}>
      <div className="studio-demo-frame" style={{ height }} data-design-character={width}>
        {children}
      </div>
      <figcaption>{note}</figcaption>
    </figure>
  );
}

export function CharacterStudioDemo() {
  return (
    <div className="studio-demo" data-design-studio>
      <div className="studio-demo-cards">
        <Card width={260} note="260 · nothing drawn yet: the stage is shorter, a stage's button sits under its words">
          <CharacterSheet character={fresh} price={price} inspiration={inspiration} />
        </Card>
        <Card width={400} note="400 · in the making: its words as formatted text, the expressions sheet large">
          <CharacterSheet character={making} price={price} inspiration={inspiration} stills={{ ...pictures, portrait: undefined }} />
        </Card>
        <Card width={460} note="460 × 720, as it's made · from before expression sheets: finished, waiting on a person, and offered one as an extra">
          <CharacterSheet character={older} price={price} inspiration={inspiration} stills={{ ...pictures, expressions: undefined }} />
        </Card>
        <Card width={560} note="560 · approved, as a viewer reads it: everything, and no buttons">
          <CharacterSheet character={approved} price={price} inspiration={inspiration} stills={pictures} viewer />
        </Card>
      </div>
      <div className="studio-demo-flow" data-design-flow>
        <PipeFlow set="animals" characters={cast} price={price} pictures={inspiration} stills={stillsOf} />
      </div>
      <figure className="studio-demo-card" style={{ width: 200 }}>
        <div className="studio-demo-frame" style={{ height: 620 }} data-design-flow-new>
          <PipeNode node="sheet" set="animals" characters={[]} price={price} pictures={inspiration} inline adding onNew={async () => false} />
        </div>
        <figcaption>＋ New, on the Sheet node: a name, a line, what to draw it from</figcaption>
      </figure>
    </div>
  );
}
