//! The board, drawn: paper, the grid's frame and tracks, sections, empty cells and cards.
//!
//! The values here are the web renderer's (apps/client/src/App.css, DESIGN.md), named where
//! they come from, so a difference between the two engines is a bug in one of them. The camera
//! is two live values the client drives (it owns the springs, framing and keys for both
//! engines): a pan or zoom draws without re-running this view.

use std::cell::RefCell;
use std::collections::HashMap;
use std::ops::Range;
use std::rc::Rc;

use rune::{Cursor, Cx, Drag, El, Family, Image, ImageCache, Key, KeyEvent, Live, Phase, PointerPress, Shape, TextEdit, TextStyle, Tx, canvas, col, effect, el, row, text, text_input};
use pulldown_cmark::{Event as MdEvent, HeadingLevel, Options, Parser, Tag};
use rune_kit::markdown::{Markdown, MarkdownStyle};

use crate::bridge::{Event, emit};
use crate::paper::{MARK_DOTS, MARK_PAPER};
use crate::scene::{Card, DropTarget, Empty, Kind, Rgba, Scene, Section, Tokens, Tool, color, tint};

// DESIGN.md §4: radii, nothing in between
const R_PAPER: f32 = 3.0;
const R_CARD: f32 = 5.0;
const R_PANE: f32 = 8.0;
const R_PILL: f32 = 999.0;
/// store.ts SECTION_HEADER
const SECTION_HEADER: f32 = 42.0;
/// a held card lifts 2.5 % (DESIGN.md §1.5)
const LIFT: f32 = 1.025;

/// tokens.css --font-sans: Hanken Grotesk, handed to Rune as files (apps/rune/fonts). The Latin
/// Extended file is its own family (Rune keeps one face per family, weight and style); past
/// both, Rune's sans slot (Inter).
pub const FACE_NAMES: &str = "Hanken Grotesk, Hanken Grotesk Ext";
const FACE: Family = Family::Named(FACE_NAMES);
const fn face(size: f32, weight: f32) -> TextStyle {
    TextStyle::new(size, weight).family(FACE)
}

const NAME: TextStyle = face(14.0, 600.0).tracking(-0.07);
const COORDS: TextStyle = face(10.0, 600.0).tracking(0.8).features("'tnum' 1");
const COUNT: TextStyle = face(10.5, 600.0).features("'tnum' 1");
const TRACK: TextStyle = face(15.0, 700.0).tracking(2.1).features("'tnum' 1");
const ADD: TextStyle = face(12.5, 600.0);
const NOTE: TextStyle = face(13.5, 400.0).lh(13.5 * 1.55);
const NOTE_EDIT: TextStyle = TextStyle::new(12.5, 400.0).family(Family::Mono).lh(12.5 * 1.6);
const TABLE_NAME: TextStyle = face(15.0, 650.0).tracking(-0.15);
const TABLE_HEAD: TextStyle = face(10.5, 600.0).tracking(0.84).features("'tnum' 1");
const CELL: TextStyle = face(13.5, 400.0);
const CELL_NUM: TextStyle = face(13.5, 400.0).features("'tnum' 1");
const CELL_ERR: TextStyle = face(11.5, 600.0).tracking(0.35);
// store.ts: a table's own measures
const CELL_W: f32 = 148.0;
const CELL_H: f32 = 40.0;
const HEADER_H: f32 = 52.0;
const ROWNUM_W: f32 = 44.0;
const COLHEAD_H: f32 = 32.0;
const AGENT: TextStyle = face(11.0, 600.0);
const RENAME: TextStyle = face(13.0, 700.0);
const CONFIRM: TextStyle = face(12.5, 400.0);
const BUTTON: TextStyle = face(12.0, 600.0);
const BAR_TITLE: TextStyle = face(12.0, 650.0);
const DROP: TextStyle = face(13.0, 600.0);

/// A card following the pointer, and where it has got to (world points from its resting place).
pub struct Held {
    pub id: String,
    pub dx: f32,
    pub dy: f32,
    pub moved: bool,
    /// let go: it waits where it was dropped until the store's answer arrives
    pub dropped: bool,
}

/// A section following the pointer by its header, and how far it has travelled (world points).
pub struct SectionHeld {
    pub id: String,
    pub dx: f32,
    pub dy: f32,
    pub moved: bool,
    /// let go: it waits there until the store's answer arrives
    pub dropped: bool,
}

pub struct Board {
    pub scene: Scene,
    pub pan: Live<[f32; 2]>,
    pub zoom: Live<f32>,
    /// the paper's place: `lib.rs` moves it a hair to ask for a frame
    pub nudge: Live<[f32; 2]>,
    pub held: Option<Held>,
    /// the note being written, and its field
    pub editing: Option<String>,
    pub edit: TextEdit,
    pub section_held: Option<SectionHeld>,
    /// the section being renamed, and its field
    pub renaming: Option<String>,
    pub name_edit: TextEdit,
    /// the card whose corner is held, and the size it had when it was pressed
    pub resizing: Option<(String, f32, f32)>,
    pub cache: Option<ImageCache>,
    pub images: HashMap<String, Image>,
}

impl Board {
    pub fn new(pan: Live<[f32; 2]>, zoom: Live<f32>, nudge: Live<[f32; 2]>) -> Self {
        Board {
            scene: Scene::default(), pan, zoom, nudge, held: None, editing: None, edit: TextEdit::new(""), section_held: None, renaming: None,
            name_edit: TextEdit::new(""), resizing: None, cache: None, images: HashMap::new(),
        }
    }

    /// The store changed: take its board. A note being written keeps its own text (the field
    /// is ahead of the store), and a dropped card stops waiting.
    pub fn set_scene(&mut self, scene: Scene) {
        if self.held.as_ref().is_some_and(|h| h.dropped) {
            self.held = None;
        }
        if self.section_held.as_ref().is_some_and(|h| h.dropped) {
            self.section_held = None;
        }
        if let Some(id) = &self.renaming
            && !scene.sections.iter().any(|s| &s.id == id)
        {
            self.renaming = None;
        }
        if let Some(cache) = &self.cache {
            for card in scene.cards.iter().filter(|c| c.kind == Kind::Image && !c.src.is_empty()) {
                self.images.entry(card.src.clone()).or_insert_with(|| cache.url(&card.src, card.w, 1.0));
            }
            self.images.retain(|src, _| scene.cards.iter().any(|c| &c.src == src));
        }
        if let Some(id) = &self.editing
            && !scene.cards.iter().any(|c| &c.id == id)
        {
            self.editing = None;
        }
        self.scene = scene;
    }

    pub fn begin_edit(&mut self, id: &str) {
        let Some(card) = self.scene.cards.iter().find(|c| c.id == id && c.kind == Kind::Note) else { return };
        if self.scene.read_only {
            return;
        }
        self.edit = TextEdit::new(card.text.clone());
        self.edit.focused = true;
        self.editing = Some(id.to_owned());
        emit(Event::Edit { id: Some(id) });
    }

    /// Whatever field is open goes back to rest: a note keeps what was typed (it's already on
    /// the board), and a section takes its new name, as a field does when focus leaves it.
    pub fn end_edit(&mut self) {
        if self.editing.take().is_some() {
            self.edit.focused = false;
            emit(Event::Edit { id: None });
        }
        if let Some(id) = self.renaming.take() {
            self.name_edit.focused = false;
            emit(Event::Rename { id: &id, name: &self.name_edit.text });
            emit(Event::Edit { id: None });
        }
    }

    pub fn begin_rename(&mut self, id: &str) {
        let Some(sec) = self.scene.sections.iter().find(|s| s.id == id) else { return };
        if self.scene.read_only {
            return;
        }
        self.name_edit = TextEdit::new(sec.name.clone());
        self.name_edit.focused = true;
        self.renaming = Some(id.to_owned());
        emit(Event::Edit { id: Some(id) });
    }

    pub fn cancel_rename(&mut self) {
        if self.renaming.take().is_some() {
            self.name_edit.focused = false;
            emit(Event::Edit { id: None });
        }
    }
}

thread_local! {
    /// How many times the view has run. A pan or a zoom shouldn't add any (the camera is two live
    /// values), but Rune's frame step commits during them anyway: SPEC §7, and `e2e/rune-frames.spec.ts`
    /// records the count.
    pub static VIEWS: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

pub fn view(b: &Board, _: &mut Cx<Board>) -> El {
    VIEWS.with(|v| v.set(v.get() + 1));
    let sc = &b.scene;
    let t = &sc.tokens;
    let v = &sc.view;

    let mut world = el().key("world").absolute(-v.left, -v.top).size(sc.grid.w.max(1.0), sc.grid.h.max(1.0)).origin(0.0, 0.0).live_offset(&b.pan).live_scale(&b.zoom);
    world = world.child(grid_chrome(sc));
    for e in &sc.empties {
        world = world.child(empty_cell(e, t, sc.read_only));
    }
    // a section dragged by its header travels with its cards, over everything it passes
    let moving = b.section_held.as_ref().filter(|h| h.moved).map(|h| h.id.as_str());
    let held = b.held.as_ref().map(|h| h.id.as_str());
    for s in sc.sections.iter().filter(|s| Some(s.id.as_str()) != moving) {
        world = world.child(section(s, b));
    }
    for c in sc.cards.iter().filter(|c| Some(c.id.as_str()) != held && Some(c.section.as_str()) != moving) {
        world = world.child(card(c, b));
    }
    if let Some(d) = &sc.drop {
        world = world.child(drop_target(d, t));
    }
    if let Some(s) = moving.and_then(|id| sc.sections.iter().find(|s| s.id == id)) {
        world = world.child(section(s, b));
        for c in sc.cards.iter().filter(|c| c.section == s.id && Some(c.id.as_str()) != held) {
            world = world.child(card(c, b));
        }
    }
    // the held card goes last
    if let Some(c) = held.and_then(|id| sc.cards.iter().find(|c| c.id == id)) {
        world = world.child(card(c, b));
    }

    // the cards stop where the floor is (the top bar, an open pane), cut clean
    let clip = el().key("floor").pin(Some(v.left), Some(v.top), Some(v.right), Some(0.0)).clip_rounded(0.0).child(world);
    // Every right-click is Rune's to answer, so the browser's own menu never opens over the board:
    // a section says which it was (the client opens its menu there), anything else has none.
    let mut root = el().key("board").w_full().h_full();
    if sc.paper {
        // the paper: its token colour, and over it the web paper's own shader (paper.rs)
        root = root.fill(color(t.void)).child(effect(MARK_PAPER).key("paper").pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0)).live_offset(&b.nudge).inert());
    }
    let root = root.child(clip)
        .on_secondary_press(|_: &mut Board, p: PointerPress, _: &mut Tx| emit(Event::Menu { id: None, x: p.x, y: p.y }));
    root
}

/// The frame round the whole grid, the track lines where they divide sections, and the
/// spreadsheet labels above and beside it.
fn grid_chrome(sc: &Scene) -> El {
    let t = &sc.tokens;
    let g = &sc.grid;
    let mut chrome = el().key("grid").absolute(0.0, 0.0).size(g.w.max(1.0), g.h.max(1.0)).inert();
    chrome = chrome.child(el().key("frame").absolute(0.0, 0.0).size(g.w, g.h).radius(R_PANE).border(1.5, tint(t.frost, 14.0)));
    for (i, l) in g.lines.iter().enumerate() {
        let (w, h) = if l.vertical { (1.5, l.len) } else { (l.len, 1.5) };
        chrome = chrome.child(el().key(format!("line-{i}")).absolute(l.x, l.y).size(w, h).fill(tint(t.frost, 10.0)));
    }
    let label = |s: &str| text(s.to_owned()).font(TRACK).color(tint(t.frost, 30.0));
    for (i, c) in g.cols.iter().enumerate() {
        chrome = chrome.child(el().key(format!("col-{i}")).absolute(c.at, -46.0).size(c.len, 34.0).center().child(label(&c.label)));
    }
    for (i, r) in g.rows.iter().enumerate() {
        chrome = chrome.child(el().key(format!("row-{i}")).absolute(-46.0, r.at).size(34.0, r.len).center().child(label(&r.label)));
    }
    chrome
}

/// An empty cell: a dashed target with its coordinates, and "+ Section" once the pointer is on it.
fn empty_cell(e: &Empty, t: &Tokens, read_only: bool) -> El {
    let (c, r) = (e.c, e.r);
    let mut cell = col().key(format!("empty-{c}-{r}")).absolute(e.x, e.y).size(e.w, e.h).center().gap(10.0).radius(R_PANE)
        .border(2.0, tint(t.frost, 14.0)).border_dash(7.0, 5.0).hover_group()
        .child(text(e.label.clone()).font(TRACK).color(tint(t.frost, 18.0)));
    if !read_only {
        cell = cell.child(
            el().key("add").px(16.0).py(7.0).radius(R_PILL).fill(color(t.raise)).border(1.0, color(t.line_strong))
                .shadow(2.0, 8.0, tint(t.frost, 8.0)).group_opacity(0.0, 1.0).press_scale(0.97).cursor(Cursor::Pointer)
                .child(text("+ Section").font(ADD).color(color(t.mist)))
                .on_press(move |_: &mut Board| emit(Event::CreateSection { c, r })),
        );
    }
    cell
}

/// The ink a tool's tone asks for.
fn tone(t: &Tokens, tool: &Tool, rest: Rgba) -> Rgba {
    match tool.tone.as_str() {
        "agent" => t.agent,
        "danger" => t.bad,
        _ => rest,
    }
}

/// A 14 pt line icon, drawn (the web's glyphs are symbols Rune's face doesn't carry).
fn icon(name: &str, c: rune::Color) -> El {
    let w = 1.4;
    let sq = || vec![[2.0, 2.0], [12.0, 2.0], [12.0, 12.0], [2.0, 12.0], [2.0, 2.0]];
    let sh = Shape::new();
    let sh = match name {
        "app" => sh.stroke(sq(), w, c).stroke(vec![[7.0, 2.0], [7.0, 7.0], [12.0, 7.0]], w, c),
        "table" => sh.stroke(sq(), w, c).stroke(vec![[7.0, 2.0], [7.0, 12.0]], w, c).stroke(vec![[2.0, 7.0], [12.0, 7.0]], w, c),
        "map" => {
            let ring: Vec<[f32; 2]> = (0..=16).map(|i| { let a = i as f32 * std::f32::consts::TAU / 16.0; [7.0 + 5.0 * a.cos(), 7.0 + 5.0 * a.sin()] }).collect();
            sh.stroke(ring, w, c).stroke(vec![[6.5, 7.0], [7.5, 7.0]], 2.4, c)
        }
        "note" => sh.stroke(sq(), w, c).stroke(vec![[4.5, 5.0], [9.5, 5.0]], w, c).stroke(vec![[4.5, 7.0], [9.5, 7.0]], w, c).stroke(vec![[4.5, 9.0], [8.0, 9.0]], w, c),
        "upload" => sh.stroke(vec![[7.0, 10.0], [7.0, 2.5]], w, c).stroke(vec![[4.0, 5.5], [7.0, 2.5], [10.0, 5.5]], w, c).stroke(vec![[3.0, 12.0], [11.0, 12.0]], w, c),
        "split-h" => sh.stroke(sq(), w, c).stroke(vec![[7.0, 2.0], [7.0, 12.0]], w, c),
        "split-v" => sh.stroke(sq(), w, c).stroke(vec![[2.0, 7.0], [12.0, 7.0]], w, c),
        "open" | "frame" => sh.stroke(vec![[3.0, 11.0], [11.0, 3.0]], w, c).stroke(vec![[7.0, 3.0], [11.0, 3.0], [11.0, 7.0]], w, c).stroke(vec![[3.0, 7.0], [3.0, 11.0], [7.0, 11.0]], w, c),
        "up" => sh.stroke(vec![[3.0, 3.0], [11.0, 11.0]], w, c).stroke(vec![[3.0, 7.0], [3.0, 3.0], [7.0, 3.0]], w, c).stroke(vec![[11.0, 7.0], [11.0, 11.0], [7.0, 11.0]], w, c),
        "ask" => sh.fill(vec![[7.0, 1.0], [8.6, 5.4], [13.0, 7.0], [8.6, 8.6], [7.0, 13.0], [5.4, 8.6], [1.0, 7.0], [5.4, 5.4]], c),
        "remove" => sh.stroke(vec![[3.5, 3.5], [10.5, 10.5]], w, c).stroke(vec![[10.5, 3.5], [3.5, 10.5]], w, c),
        "unhost" => sh.stroke(sq(), w, c).stroke(vec![[2.0, 7.0], [7.0, 7.0], [7.0, 12.0]], w, c),
        "fill" => sh.stroke(sq(), w, c).stroke(vec![[4.5, 4.5], [9.5, 4.5], [9.5, 9.5], [4.5, 9.5], [4.5, 4.5]], w, c),
        // a floating card can be docked into the flow (a grid), a docked one set free (a cross)
        "dock" => sh.stroke(vec![[5.0, 2.0], [5.0, 12.0]], w, c).stroke(vec![[9.0, 2.0], [9.0, 12.0]], w, c).stroke(vec![[2.0, 5.0], [12.0, 5.0]], w, c).stroke(vec![[2.0, 9.0], [12.0, 9.0]], w, c),
        "float" => sh.stroke(vec![[7.0, 2.0], [7.0, 12.0]], w, c).stroke(vec![[2.0, 7.0], [12.0, 7.0]], w, c).stroke(vec![[5.5, 3.5], [7.0, 2.0], [8.5, 3.5]], w, c).stroke(vec![[5.5, 10.5], [7.0, 12.0], [8.5, 10.5]], w, c),
        _ => sh.stroke(vec![[6.5, 7.0], [7.5, 7.0]], 2.4, c),
    };
    canvas(sh.view_box(14.0, 14.0)).size(14.0, 14.0)
}

/// One toolbar button: 26 × 24, a tint under the pointer, its icon in the tone it asks for.
fn tool_button(t: &Tokens, tool: &Tool, w: f32, h: f32, rest: Rgba) -> El {
    let hover = if tool.tone == "danger" { tint(t.bad, 12.0) } else { tint(t.frost, 8.0) };
    el().key(format!("tool-{}", tool.id)).size(w, h).center().radius(R_PAPER).hover(hover).press_scale(0.92).cursor(Cursor::Pointer)
        .child(icon(&tool.icon, color(tone(t, tool, rest))))
}

/// Where a dragged section would land: the cell it's over, or a band along an edge of the board.
fn drop_target(d: &DropTarget, t: &Tokens) -> El {
    let mut target = el().key("drop").absolute(d.x, d.y).size(d.w, d.h).center().radius(R_PANE).fill(tint(t.pulse, 7.0)).border(2.5, color(t.pulse)).inert();
    if !d.label.is_empty() {
        target = target.child(text(d.label.clone()).font(DROP).color(color(t.pulse)));
    }
    target
}

/// What a press or a drag on a section's header does: it selects the section; dragged past
/// 7 pt it carries the section (the client says where it would land, and puts it there);
/// a press on the name that never moved opens it for renaming.
fn header_drag(id: String, on_name: bool, movable: bool) -> impl Fn(&mut Board, &mut Drag, &mut Tx) + 'static {
    move |b: &mut Board, d: &mut Drag, tx: &mut Tx| match d.phase {
        Phase::Down => {
            b.end_edit();
            emit(Event::Section { id: &id });
            b.section_held = Some(SectionHeld { id: id.clone(), dx: 0.0, dy: 0.0, moved: false, dropped: false });
        }
        Phase::Move => {
            let zoom = b.zoom.get().max(0.01);
            let [x, y] = d.window_point();
            if let Some(h) = b.section_held.as_mut().filter(|h| h.id == id && movable) {
                h.moved |= d.dx.hypot(d.dy) > 7.0;
                if h.moved {
                    (h.dx, h.dy) = (d.dx / zoom, d.dy / zoom);
                    tx.instant();
                    emit(Event::SectionDrag { id: &id, x, y, dx: h.dx, dy: h.dy, phase: "move" });
                }
            }
        }
        Phase::Up => {
            let [x, y] = d.window_point();
            let Some(h) = b.section_held.as_mut().filter(|h| h.id == id) else { return };
            let (moved, dx, dy) = (h.moved, h.dx, h.dy);
            if moved {
                // it waits where it was let go until the client has put it somewhere (or sent it back)
                h.dropped = true;
                emit(Event::SectionDrag { id: &id, x, y, dx, dy, phase: if d.cancelled() { "cancel" } else { "drop" } });
            } else {
                b.section_held = None;
                if on_name {
                    b.begin_rename(&id);
                }
            }
        }
    }
}

/// A section: paper on the desk, no bar; its name, coordinates and count sit on the paper, and
/// its tools wait in the top-right corner until the pointer is on it.
fn section(s: &Section, b: &Board) -> El {
    let t = &b.scene.tokens;
    let read_only = b.scene.read_only;
    let (dx, dy) = b.section_held.as_ref().filter(|h| h.id == s.id && h.moved).map_or((0.0, 0.0), |h| (h.dx, h.dy));
    let lift = if s.active { (6.0, 9.0, 14.0, 44.0) } else { (4.0, 5.0, 10.0, 30.0) };

    let name = if b.renaming.as_deref() == Some(s.id.as_str()) {
        text_input(&b.name_edit, RENAME).key("rename").single_line().color(color(t.frost)).caret(color(t.pulse), tint(t.pulse, 24.0))
            .w(160.0).px(6.0).py(2.0).radius(R_CARD).fill(color(t.raise)).border(1.5, color(t.pulse))
            .on_edit(|b: &mut Board| &mut b.name_edit)
            .on_submit(|b: &mut Board, _: &mut Tx| b.end_edit())
            .on_input_key(|b: &mut Board, ev: &KeyEvent, _: &mut Tx| {
                let esc = ev.key == Key::Escape;
                if esc {
                    b.cancel_rename();
                }
                esc
            })
    } else {
        let label = el().key("name").px(6.0).py(3.0).radius(R_CARD).child(text(s.name.clone()).font(NAME).color(color(t.frost)).truncate());
        if read_only { label } else { label.hover(tint(t.frost, 5.0)).on_drag(header_drag(s.id.clone(), true, s.movable)) }
    };
    let mut header = row().key("header").absolute(0.0, 0.0).w_full().h(SECTION_HEADER).center_y().gap(8.0).pl(10.0).pr(8.0).cursor(Cursor::Grab)
        .child(name)
        .child(el().px(6.0).py(2.0).radius(R_PAPER).fill(tint(t.moss, 9.0)).child(text(s.coords.clone()).font(COORDS).color(color(t.moss))));
    if !s.count.is_empty() {
        header = header.child(el().min_w(18.0).h(18.0).px(5.0).center().radius(R_PILL).fill(color(t.panel)).child(text(s.count.clone()).font(COUNT).color(color(t.mist))));
    }
    if !s.tools.is_empty() {
        let mut bar = row().key("tools").h(30.0).px(4.0).center_y().gap(1.0).radius(R_CARD).fill(tint(t.raise, 92.0)).border(1.0, color(t.line))
            .shadow(4.0, 12.0, tint(t.frost, 10.0)).group_opacity(0.0, 1.0);
        for (i, tool) in s.tools.iter().enumerate() {
            if tool.gap && i > 0 {
                bar = bar.child(el().size(1.0, 16.0).mx(3.0).fill(color(t.line)));
            }
            let (id, which) = (s.id.clone(), tool.id.clone());
            bar = bar.child(tool_button(t, tool, 26.0, 24.0, t.mist).on_press(move |_: &mut Board| emit(Event::SectionTool { id: &id, tool: &which })));
        }
        header = header.child(el().grow(1.0)).child(bar);
    }
    if !read_only {
        header = header.on_drag(header_drag(s.id.clone(), false, s.movable));
    }

    let id = s.id.clone();
    let mut card = el().key(format!("sec-{}", s.id)).absolute(s.x + dx, s.y + dy).size(s.w, s.h).radius(R_PANE).hover_group()
        .fill(tint(t.raise, 72.0))
        .border(1.0, color(if s.active { t.dim } else { t.line_strong }))
        .shadow(1.0, 2.0, tint(t.frost, lift.0))
        .shadow(lift.2, lift.3, tint(t.frost, lift.1))
        // App.css .section-body: the body's own dots, 28 px apart, frost at 13 %
        .child(effect(MARK_DOTS).key("dots").absolute(0.0, SECTION_HEADER).size(s.w, (s.h - SECTION_HEADER).max(0.0)).effect_data([t.frost[0], t.frost[1], t.frost[2], t.frost[3] * 0.13]).inert())
        .child(header)
        .on_press_tx(move |b: &mut Board, _: &mut Tx| {
            b.end_edit();
            emit(Event::Section { id: &id });
        });
    if !read_only {
        let id = s.id.clone();
        card = card.on_secondary_press(move |b: &mut Board, p: PointerPress, _: &mut Tx| {
            b.end_edit();
            emit(Event::Menu { id: Some(&id), x: p.x, y: p.y });
        });
    }
    if s.more > 0 {
        let id = s.id.clone();
        card = card.child(
            row().key("more").pin(None, None, Some(12.0), Some(12.0)).h(28.0).px(12.0).center_y().gap(6.0).radius(R_PILL).fill(color(t.raise)).border(1.0, color(t.line))
                .shadow(4.0, 12.0, tint(t.frost, 10.0)).press_scale(0.97).cursor(Cursor::Pointer)
                .child(text(format!("{} more", s.more)).font(COUNT.tracking(0.0)).color(color(t.mist)))
                .child(icon("open", color(t.pulse)))
                .child(text("Expand").font(BUTTON).color(color(t.mist)))
                .on_press(move |_: &mut Board| emit(Event::SectionTool { id: &id, tool: "open" })),
        );
    }
    if !s.confirm.is_empty() {
        let answer = |yes: bool| {
            let id = s.id.clone();
            let (fill, ink, line) = if yes { (color(t.bad), color(t.void), color(t.bad)) } else { (color(t.raise), color(t.mist), color(t.line_strong)) };
            el().key(if yes { "yes" } else { "no" }).px(12.0).py(5.0).radius(R_CARD).fill(fill).border(1.0, line).press_scale(0.94).cursor(Cursor::Pointer)
                .child(text(if yes { "Remove" } else { "Cancel" }).font(BUTTON).color(ink))
                .on_press(move |_: &mut Board| emit(Event::Confirm { id: &id, yes }))
        };
        card = card.child(
            row().key("confirm").pin(None, Some(48.0), Some(10.0), None).center_y().gap(10.0).px(12.0).py(10.0).radius(R_CARD).fill(color(t.raise)).border(1.0, color(t.line_strong))
                .shadow(14.0, 44.0, tint(t.frost, 16.0))
                .child(text(s.confirm.clone()).font(CONFIRM).color(color(t.mist)))
                .child(answer(true))
                .child(answer(false)),
        );
    }
    card
}

/// A card at its place in its section, at the section's fit; lifted and following while held.
fn card(c: &Card, b: &Board) -> El {
    let t = &b.scene.tokens;
    let held = b.held.as_ref().filter(|h| h.id == c.id);
    let (dx, dy) = held.map_or((0.0, 0.0), |h| (h.dx, h.dy));
    let carried = held.is_some_and(|h| h.moved && !h.dropped);
    let editing = b.editing.as_deref() == Some(c.id.as_str());
    let bare_image = c.kind == Kind::Image && b.images.contains_key(&c.src);

    // its section is being dragged: it goes along
    let (sx, sy) = b.section_held.as_ref().filter(|h| h.id == c.section && h.moved).map_or((0.0, 0.0), |h| (h.dx, h.dy));
    let (dx, dy) = (dx + sx, dy + sy);
    let mut frame = el().key(format!("card-{}", c.id)).absolute(c.x + dx, c.y + dy).size(c.w, c.h).origin(0.0, 0.0).hover_group()
        .scale(c.s * if carried { LIFT } else { 1.0 }).radius(R_CARD).clip_rounded(R_CARD);
    // images rest bare; everything else is paper with a hairline (DESIGN.md §5 Card, Media card)
    if !bare_image {
        // App.css .frame-card: every card's paper is the raised one
        frame = frame.fill(color(t.raise)).border(1.0, color(t.line));
        frame = if carried { frame.shadow(14.0, 44.0, tint(t.frost, 16.0)) } else { frame.shadow(1.0, 2.0, tint(t.frost, 5.0)) };
    }
    if c.active || editing {
        frame = frame.border(2.0, color(t.pulse));
    }
    frame = frame.child(match c.kind {
        Kind::Note if editing => note_field(b, t),
        Kind::Note => note(c, t),
        Kind::Table => table(c, t),
        Kind::Image if bare_image => el().w_full().h_full().pixels(b.images[&c.src].pixels()),
        // an image still on its way: its paper, until the pixels land
        Kind::Image => el().w_full().h_full().fill(color(t.panel)),
    });
    if !c.agent.is_empty() {
        frame = frame.child(
            el().key("by").absolute(8.0, c.h - 26.0).h(18.0).px(7.0).center().radius(R_PILL).fill(tint(t.agent, 12.0))
                .child(text(format!("✦ {}", c.agent)).font(AGENT).color(color(t.agent))),
        );
    }
    if !b.scene.read_only {
        frame = card_chrome(frame, c, t);
    }
    if editing {
        return frame;
    }
    let (id, x, y, read_only) = (c.id.clone(), c.x, c.y, b.scene.read_only);
    frame.cursor(Cursor::Grab).on_drag(move |b: &mut Board, d: &mut Drag, tx: &mut Tx| match d.phase {
        Phase::Down => {
            b.end_edit();
            emit(Event::Object { id: &id });
            b.held = Some(Held { id: id.clone(), dx: 0.0, dy: 0.0, moved: false, dropped: false });
        }
        Phase::Move => {
            let zoom = b.zoom.get().max(0.01);
            if let Some(h) = b.held.as_mut().filter(|h| h.id == id && !read_only) {
                h.moved |= d.dx.hypot(d.dy) > 4.0;
                if h.moved {
                    (h.dx, h.dy) = (d.dx / zoom, d.dy / zoom);
                    tx.instant();
                }
            }
        }
        Phase::Up => {
            let Some(h) = b.held.as_mut().filter(|h| h.id == id) else { return };
            if h.moved && !d.cancelled() {
                h.dropped = true;
                emit(Event::Move { id: &id, x: x + h.dx, y: y + h.dy });
            } else {
                b.held = None;
            }
        }
    })
}

/// A card's chrome, called by the pointer: a note's bar over its top edge (grip, title, tools),
/// an image's round buttons, and the resize corner.
fn card_chrome(mut frame: El, c: &Card, t: &Tokens) -> El {
    let press = |tool: &Tool| {
        let (id, which) = (c.id.clone(), tool.id.clone());
        move |_: &mut Board| emit(Event::CardTool { id: &id, tool: &which })
    };
    if c.chrome == "bar" {
        let grip = col().gap(2.5).px(3.0).py(4.0).opacity(0.5).children((0..2).map(|_| el().size(14.0, 2.0).radius(2.0).fill(color(t.dim))));
        let mut bar = row().key("bar").absolute(5.0, 5.0).size(c.w - 10.0, 30.0).center_y().gap(8.0).px(6.0).radius(R_CARD)
            .fill(tint(t.abyss, 95.0)).border(1.0, tint(t.frost, 14.0)).shadow(4.0, 12.0, tint(t.frost, 10.0)).group_opacity(0.0, 1.0)
            .child(grip)
            .child(text(c.name.clone()).font(BAR_TITLE).color(color(t.mist)).truncate().grow(1.0));
        for tool in &c.tools {
            bar = bar.child(tool_button(t, tool, 26.0, 26.0, t.dim).on_press(press(tool)));
        }
        frame = frame.child(bar);
    } else if c.chrome == "icons" {
        let mut icons = col().key("icons").absolute(c.w - 36.0, 8.0).gap(6.0).group_opacity(0.0, 1.0);
        for tool in &c.tools {
            icons = icons.child(tool_button(t, tool, 28.0, 28.0, t.mist).radius(R_PILL).fill(tint(t.abyss, 95.0)).border(1.0, tint(t.frost, 14.0)).on_press(press(tool)));
        }
        frame = frame.child(icons);
    }
    if c.resizable {
        let (id, scale) = (c.id.clone(), c.s.max(0.01));
        let (w0, h0) = (c.w, c.h);
        let corner = canvas(Shape::new().stroke(vec![[15.0, 5.0], [15.0, 15.0], [5.0, 15.0]], 2.5, color(t.dim)).view_box(22.0, 22.0));
        frame = frame.child(
            corner.key("resize").absolute(c.w - 22.0, c.h - 22.0).size(22.0, 22.0).group_opacity(0.0, 1.0).on_drag(move |b: &mut Board, d: &mut Drag, _: &mut Tx| match d.phase {
                Phase::Down => b.resizing = Some((id.clone(), w0, h0)),
                Phase::Move => {
                    // the size it had when pressed, plus the pointer's travel at the scale it's drawn at
                    let k = b.zoom.get().max(0.01) * scale;
                    if let Some((_, w, h)) = b.resizing.as_ref().filter(|r| r.0 == id) {
                        emit(Event::Resize { id: &id, w: w + d.dx / k, h: h + d.dy / k });
                    }
                }
                Phase::Up => b.resizing = None,
            }),
        );
    }
    frame
}

/// App.css `.note-rendered`, as a style for Rune's kit: the body, the four headings, code, quotes,
/// rules, links and lists in the web note's sizes and tokens.
fn note_style(t: &Tokens) -> MarkdownStyle {
    // the kit's defaults for what isn't set here (syntax colours, a task's box) come in two lights
    let dark = t.void[0] + t.void[1] + t.void[2] < 1.5;
    MarkdownStyle::neutral(dark)
        .text(color(t.frost)).muted(color(t.mist))
        .link(color(t.pulse)).link_underline(tint(t.pulse, 30.0)).link_hover(color(t.pulse))
        .body_font(NOTE)
        .heading_font(1, face(20.0, 700.0).tracking(-0.4).lh(20.0 * 1.55))
        .heading_font(2, face(16.5, 700.0).tracking(-0.165).lh(16.5 * 1.55))
        .heading_font(3, face(14.0, 700.0).lh(14.0 * 1.55))
        .heading_font(4, face(13.0, 700.0).lh(13.0 * 1.55))
        .strong_weight(700.0)
        .inline_code_bg(tint(t.frost, 6.0)).inline_code_font(12.0 / 13.5, 400.0).inline_code_pad(5.0)
        .code_block(tint(t.frost, 5.0), color(t.line)).code_block_padding(12.0, 10.0).code_margin(0.0, 0.0)
        .code_block_font(TextStyle::new(12.0, 400.0).family(Family::Mono).lh(12.0 * 1.55)).code_block_text(color(t.frost)).syntax_highlight(false)
        .quote(color(t.line_strong), 3.0, 12.0, color(t.mist))
        .rule(color(t.line))
        .list(20.0, 2.0)
        .selection(tint(t.pulse, 24.0))
}

/// A top-level block of a note, and the margins App.css `.note-rendered` gives it (above, below).
fn block_margins(tag: &Tag) -> (f32, f32) {
    match tag {
        Tag::Heading { level: HeadingLevel::H1, .. } => (8.0, 6.0),
        Tag::Heading { level: HeadingLevel::H2, .. } => (8.0, 5.0),
        Tag::Heading { .. } => (6.0, 4.0),
        Tag::BlockQuote(_) | Tag::CodeBlock(_) | Tag::Table(_) => (6.0, 6.0),
        _ => (4.0, 4.0),
    }
}

thread_local! {
    /// a note's text, cut into its top-level blocks (their byte ranges and margins): kept between views
    static BLOCKS: RefCell<HashMap<String, Rc<Vec<(Range<usize>, f32, f32)>>>> = RefCell::new(HashMap::new());
}

/// The note's top-level blocks. Rune's kit spaces blocks for a reading page (28 above a heading,
/// 12 below a paragraph); a note is tighter, so each block is rendered by the kit on its own and
/// spaced here with the web note's margins, collapsing as CSS does.
fn note_blocks(src: &str) -> Rc<Vec<(Range<usize>, f32, f32)>> {
    BLOCKS.with_borrow_mut(|cache| {
        if let Some(hit) = cache.get(src) {
            return hit.clone();
        }
        // the kit's own parser options, so a block here is a block there
        let opts = Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TABLES | Options::ENABLE_TASKLISTS;
        let mut blocks = Vec::new();
        let mut depth = 0usize;
        for (ev, range) in Parser::new_ext(src, opts).into_offset_iter() {
            match ev {
                MdEvent::Start(tag) => {
                    if depth == 0 {
                        let (above, below) = block_margins(&tag);
                        blocks.push((range, above, below));
                    }
                    depth += 1;
                }
                MdEvent::End(_) => depth = depth.saturating_sub(1),
                MdEvent::Rule if depth == 0 => blocks.push((range, 10.0, 10.0)),
                _ => {}
            }
        }
        if cache.len() > 512 {
            cache.clear();
        }
        let blocks = Rc::new(blocks);
        cache.insert(src.to_owned(), blocks.clone());
        blocks
    })
}

/// A note at rest: its markdown, rendered (headings, emphasis, lists, tasks, code, quotes, links,
/// tables). A link says where it goes and the client opens it; a task's box doesn't tick here.
fn note(c: &Card, t: &Tokens) -> El {
    let style = note_style(t);
    let mut body = col().key("md").w_full();
    let mut below = None;
    for (i, (range, above, next_below)) in note_blocks(&c.text).iter().enumerate() {
        let block = Markdown::new(&c.text[range.clone()]).tasks_read_only().on_link(|_: &mut Board, url| emit(Event::Link { url })).render(&style);
        body = body.child(block.key(format!("b{i}")).mt(below.map_or(*above, |b: f32| b.max(*above))));
        below = Some(*next_below);
    }
    el().w_full().h_full().px(18.0).py(14.0).child(body)
}

/// A note being written: Rune's own field, in the code face like the web editor. It starts
/// 42 px down, below where the card's bar sits. Each keystroke goes to the store as typed.
fn note_field(b: &Board, t: &Tokens) -> El {
    let field = text_input(&b.edit, NOTE_EDIT).key("note-edit").color(color(t.frost)).caret(color(t.pulse), tint(t.pulse, 24.0))
        .w_full().h_full()
        .on_edit(|b: &mut Board| &mut b.edit)
        .on_input_change(|b: &mut Board, _: &mut Tx| {
            if let Some(id) = &b.editing {
                emit(Event::Text { id, text: &b.edit.text });
            }
        })
        .on_input_key(|b: &mut Board, ev: &KeyEvent, _: &mut Tx| {
            // Esc, or ⌘↵ / Ctrl+Enter: back to the note at rest (nothing to save, nothing to revert)
            let done = ev.key == Key::Escape || (ev.key == Key::Enter && ev.mods.cmd);
            if done {
                b.end_edit();
            }
            done
        });
    el().w_full().h_full().px(18.0).pt(42.0).pb(14.0).child(field)
}

/// A column's spreadsheet name: A, B … Z, AA …
fn col_name(mut n: u32) -> String {
    let mut s = String::new();
    loop {
        s.insert(0, (b'A' + (n % 26) as u8) as char);
        if n < 26 {
            return s;
        }
        n = n / 26 - 1;
    }
}

/// A table at rest: its header, the column and row heads, the ruling and what each cell shows.
/// Pressed, it becomes the card in hand and the web's live sheet takes its place (cells,
/// formulas, ranges and menus are the web's until Rune has them).
fn table(c: &Card, t: &Tokens) -> El {
    let (cols, rows) = (c.cols as f32, c.rows as f32);
    let sheet_w = ROWNUM_W + cols * CELL_W;
    let top = HEADER_H + COLHEAD_H;
    let grip = col().gap(3.0).px(4.0).py(6.0).opacity(0.5)
        .children((0..3).map(|_| el().size(14.0, 2.0).radius(2.0).fill(color(t.dim))));
    let header = row().absolute(0.0, 0.0).size(sheet_w, HEADER_H).center_y().gap(10.0).pl(10.0).pr(14.0)
        .gradient(color(t.abyss), color(t.void))
        .child(grip)
        .child(el().px(6.0).py(4.0).child(text(c.name.clone()).font(TABLE_NAME).color(color(t.frost)).truncate()));
    let mut sheet = el().w_full().h_full().fill(color(t.raise)).child(header)
        // the heads' wells, then the ruling over them: one line a track, not a border a cell
        .child(el().absolute(0.0, HEADER_H).size(sheet_w, COLHEAD_H).fill(color(t.panel)))
        .child(el().absolute(0.0, top).size(ROWNUM_W, rows * CELL_H).fill(color(t.panel)))
        .child(el().absolute(0.0, HEADER_H - 1.0).size(sheet_w, 1.0).fill(color(t.line)))
        .child(el().absolute(0.0, top - 1.0).size(sheet_w, 1.0).fill(color(t.line_strong)))
        .child(el().absolute(ROWNUM_W - 1.0, HEADER_H).size(1.0, COLHEAD_H + rows * CELL_H).fill(color(t.line_strong)));
    for i in 0..c.cols {
        let x = ROWNUM_W + i as f32 * CELL_W;
        sheet = sheet
            .child(el().key(format!("ch-{i}")).absolute(x, HEADER_H).size(CELL_W, COLHEAD_H).center().child(text(col_name(i)).font(TABLE_HEAD).color(color(t.dim))))
            .child(el().key(format!("cl-{i}")).absolute(x + CELL_W - 1.0, HEADER_H).size(1.0, COLHEAD_H + rows * CELL_H).fill(color(t.line)));
    }
    for i in 0..c.rows {
        let y = top + i as f32 * CELL_H;
        sheet = sheet
            .child(el().key(format!("rn-{i}")).absolute(0.0, y).size(ROWNUM_W, CELL_H).center().child(text((i + 1).to_string()).font(TABLE_HEAD).color(color(t.dim))))
            .child(el().key(format!("rl-{i}")).absolute(0.0, y + CELL_H - 1.0).size(sheet_w, 1.0).fill(color(t.line)));
    }
    for cell in &c.cells {
        let (x, y) = (ROWNUM_W + cell.c as f32 * CELL_W, top + cell.r as f32 * CELL_H);
        let label = text(cell.t.clone()).truncate();
        let label = if cell.e {
            label.font(CELL_ERR).color(color(t.bad))
        } else {
            label.font(if cell.n { CELL_NUM } else { CELL }).color(color(t.frost))
        };
        // numbers sit at the left like text, in tabular figures: what the web table draws (its
        // `.cell.num` asks for the right, but the text's own box fills the cell)
        let slot = row().key(format!("c-{}-{}", cell.c, cell.r)).absolute(x, y).size(CELL_W - 1.0, CELL_H - 1.0).center_y().px(12.0);
        sheet = sheet.child(slot.child(label));
    }
    sheet
}
