//! What Rune tells the client: presses, a card let go somewhere, a note's text as it's typed.
//! The client's store stays the board's one writer (viewers, sync, undo and the invariants all
//! live there), so Rune never changes the board itself: it says what the person did.

use std::cell::RefCell;

use serde::Serialize;

#[derive(Serialize)]
#[serde(tag = "t", rename_all = "kebab-case")]
pub enum Event<'a> {
    /// A press on a section's paper.
    Section { id: &'a str },
    /// A press on a card.
    Object { id: &'a str },
    /// A card let go with its top-left at this world point.
    Move { id: &'a str, x: f32, y: f32 },
    /// A note's text, as typed.
    Text { id: &'a str, text: &'a str },
    /// A note opened for writing (or `None`: back at rest).
    Edit { id: Option<&'a str> },
    /// "+ Section" in an empty cell.
    CreateSection { c: u32, r: u32 },
    /// A button on a section's toolbar (or its "n more" pill).
    SectionTool { id: &'a str, tool: &'a str },
    /// A button on a card's bar.
    CardTool { id: &'a str, tool: &'a str },
    /// The remove confirmation's answer.
    Confirm { id: &'a str, yes: bool },
    /// A section's new name.
    Rename { id: &'a str, name: &'a str },
    /// A section dragged by its header: the pointer in window points, its travel in world points,
    /// and "move", "drop" or "cancel".
    SectionDrag { id: &'a str, x: f32, y: f32, dx: f32, dy: f32, phase: &'a str },
    /// A card's size while its corner is dragged.
    Resize { id: &'a str, w: f32, h: f32 },
    /// A link in a note was pressed.
    Link { url: &'a str },
    /// A right-click on a section's paper, in window points (`None`: on the board, where there's no menu).
    Menu { id: Option<&'a str>, x: f32, y: f32 },
}

thread_local! {
    static SINK: RefCell<Option<Box<dyn Fn(&str)>>> = const { RefCell::new(None) };
}

pub fn set_sink(sink: Option<Box<dyn Fn(&str)>>) {
    SINK.with(|s| *s.borrow_mut() = sink);
}

pub fn emit(event: Event) {
    let Ok(json) = serde_json::to_string(&event) else { return };
    SINK.with(|s| {
        if let Some(sink) = s.borrow().as_ref() {
            sink(&json);
        }
    });
}
