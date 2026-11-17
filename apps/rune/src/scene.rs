//! What the client hands Rune to draw: the board as the store has it, already laid out.
//!
//! The web renderer's geometry (`apps/client/src/state/store.ts`) stays the one source of where
//! things are, so both engines agree to the pixel: sections and cards arrive in grid world
//! points, colours arrive resolved from the design tokens (`packages/ui/src/tokens.css`), and
//! Rune decides nothing about either. `apps/client/src/rune/scene.ts` builds this; keep the two
//! in step (`SCENE_VERSION`).

use rune::Color;
use serde::Deserialize;

/// Bumped when the shape changes; the client refuses a module that speaks another version.
pub const SCENE_VERSION: u32 = 4;

/// sRGB, straight alpha, 0..1: what CSS computes a token to.
pub type Rgba = [f32; 4];

fn decode(c: f32) -> f32 {
    if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
}

/// Rune's colours are linear sRGB with straight alpha.
pub fn color(c: Rgba) -> Color {
    Color { r: decode(c[0]), g: decode(c[1]), b: decode(c[2]), a: c[3] }
}

/// `color-mix(in srgb, token pct%, transparent)`.
pub fn tint(c: Rgba, pct: f32) -> Color {
    color([c[0], c[1], c[2], c[3] * pct / 100.0])
}

#[derive(Deserialize, Clone, Default, PartialEq, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Scene {
    pub version: u32,
    pub view: View,
    /// Rune paints the paper itself (the canvas couldn't be made see-through over the WebGL paper).
    pub paper: bool,
    /// A viewer: nothing moves and nothing is written.
    pub read_only: bool,
    pub tokens: Tokens,
    pub grid: Grid,
    pub sections: Vec<Section>,
    pub empties: Vec<Empty>,
    pub cards: Vec<Card>,
    /// Where a section being dragged would land: a cell, or a band along an edge of the board.
    pub drop: Option<DropTarget>,
}

#[derive(Deserialize, Clone, Default, PartialEq, Debug)]
#[serde(default)]
pub struct DropTarget {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub label: String,
}

/// A button on a section's toolbar or a card's bar. The client decides which a section or card
/// has and what each does; Rune draws `icon` and says which was pressed.
#[derive(Deserialize, Clone, Default, PartialEq, Debug)]
#[serde(default)]
pub struct Tool {
    pub id: String,
    pub icon: String,
    /// "" (ink), "agent" (violet: an agent will act) or "danger".
    pub tone: String,
    /// Starts a new group: a hairline before it.
    pub gap: bool,
}

/// The floor: how much of each side the panes take. Cards stop there, cut clean.
#[derive(Deserialize, Clone, Default, PartialEq, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct View {
    pub left: f32,
    pub top: f32,
    pub right: f32,
}

#[derive(Deserialize, Clone, Default, PartialEq, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Tokens {
    pub void: Rgba,
    pub abyss: Rgba,
    pub panel: Rgba,
    pub raise: Rgba,
    pub frost: Rgba,
    pub mist: Rgba,
    pub dim: Rgba,
    pub pulse: Rgba,
    pub moss: Rgba,
    pub agent: Rgba,
    pub bad: Rgba,
    pub line: Rgba,
    pub line_strong: Rgba,
}

#[derive(Deserialize, Clone, Default, PartialEq, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Grid {
    pub w: f32,
    pub h: f32,
    pub cols: Vec<Track>,
    pub rows: Vec<Track>,
    pub lines: Vec<Line>,
}

/// A column or row: where it starts, how long it is, and its label (A, B… or 1, 2…).
#[derive(Deserialize, Clone, Default, PartialEq, Debug)]
#[serde(default)]
pub struct Track {
    pub at: f32,
    pub len: f32,
    pub label: String,
}

/// A track line where it divides two sections.
#[derive(Deserialize, Clone, Default, PartialEq, Debug)]
#[serde(default)]
pub struct Line {
    pub x: f32,
    pub y: f32,
    pub len: f32,
    pub vertical: bool,
}

#[derive(Deserialize, Clone, Default, PartialEq, Debug)]
#[serde(default)]
pub struct Section {
    pub id: String,
    pub name: String,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    /// "A1", or "A1:B2" for a merged one.
    pub coords: String,
    /// "3", or "▦ 4" for a section that is a grid of sections.
    pub count: String,
    pub active: bool,
    /// Its toolbar, shown while the pointer is on it (none for a viewer).
    pub tools: Vec<Tool>,
    /// It can be dragged to another cell (not an opened section filling its grid, not for a viewer).
    pub movable: bool,
    /// The question the remove confirmation asks, while it's asking.
    pub confirm: String,
    /// How many of its cards don't fit (it offers Expand).
    pub more: u32,
}

#[derive(Deserialize, Clone, Default, PartialEq, Debug)]
#[serde(default)]
pub struct Empty {
    pub c: u32,
    pub r: u32,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub label: String,
}

#[derive(Deserialize, Clone, Copy, Default, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    #[default]
    Note,
    Table,
    Image,
}

/// A table cell that holds something: where it is, what it shows, and whether that is a number
/// (right-aligned, tabular) or an error.
#[derive(Deserialize, Clone, Default, PartialEq, Debug)]
#[serde(default)]
pub struct Cell {
    pub c: u32,
    pub r: u32,
    pub t: String,
    pub n: bool,
    pub e: bool,
}

/// A card Rune draws, at its resting place: `x`, `y` in world points, `w`, `h` its own size,
/// drawn at `s` (its section's fit) from its top-left. Cards that are web content (apps, maps,
/// video, the table in hand) never arrive: the client places those over the canvas itself.
#[derive(Deserialize, Clone, Default, PartialEq, Debug)]
#[serde(default)]
pub struct Card {
    pub id: String,
    pub kind: Kind,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub s: f32,
    pub name: String,
    /// A note's markdown, as typed.
    pub text: String,
    /// An image's address (same origin: `/files/…`).
    pub src: String,
    /// The crew agent that made it, when one did.
    pub agent: String,
    pub active: bool,
    /// The section it's in (it travels with it while the section is dragged).
    pub section: String,
    /// Its chrome on hover: "bar" (a note: grip, title, tools), "icons" (an image) or "".
    pub chrome: String,
    pub tools: Vec<Tool>,
    pub resizable: bool,
    /// A table's size, and the cells that hold something.
    pub cols: u32,
    pub rows: u32,
    pub cells: Vec<Cell>,
}
