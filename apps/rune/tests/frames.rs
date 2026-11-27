//! Rune's frames on a board of notes (plan *rune-frame-cost*): a camera that moves, with the
//! pointer resting over the board, should draw without running the view again. The camera is two
//! live values (`Board::pan`, `Board::zoom`); only what the store hands over (`set_scene`) or the
//! person does to a card should commit.

use foundation_rune::scene::Scene;
use foundation_rune::view::{Board, VIEWS, view};
use rune::{Env, Live, Runtime};

const NOTE: &str = "## Note\n\nA line with **strong** words, *emphasis* and `code`, long enough to wrap onto a second line of the card.\n\n- one thing\n- another thing\n- a third\n";

/// 300 notes, 25 across, on one section, with the bar and its tools the client gives each
fn notes() -> Scene {
    let cards: Vec<serde_json::Value> = (0..300)
        .map(|i| {
            serde_json::json!({
                "id": format!("o{i}"), "kind": "note", "x": 120 + (i % 25) * 610, "y": 120 + (i / 25) * 420, "w": 540, "h": 360, "s": 1.0,
                "section": "plane", "name": format!("note {i}"), "text": NOTE, "chrome": "bar", "resizable": true,
                "tools": [{ "id": "ask", "icon": "ask", "tone": "agent" }, { "id": "frame", "icon": "frame" }, { "id": "remove", "icon": "remove", "tone": "danger" }],
            })
        })
        .collect();
    let json = serde_json::json!({
        "version": 5, "view": { "left": 0, "top": 48, "right": 0 },
        "tokens": { "void": [0.06, 0.06, 0.06, 1], "frost": [1, 1, 1, 1], "raise": [0.1, 0.1, 0.1, 1], "line": [1, 1, 1, 0.1] },
        "grid": { "w": 15500, "h": 5200 },
        "sections": [{ "id": "plane", "name": "Plane", "x": 0, "y": 0, "w": 15500, "h": 5200, "coords": "A1", "movable": true,
            "tools": [{ "id": "note", "icon": "note" }, { "id": "table", "icon": "table" }] }],
        "cards": cards,
    });
    serde_json::from_value(json).expect("scene")
}

struct Camera {
    pan: Live<[f32; 2]>,
    zoom: Live<f32>,
    nudge: Live<[f32; 2]>,
}

fn board() -> (Runtime<Board>, Camera) {
    let (pan, zoom, nudge) = (Live::new([0.0, 0.0]), Live::new(0.1), Live::new([0.0, 0.0]));
    let mut b = Board::new(pan.clone(), zoom.clone(), nudge.clone());
    b.set_scene(notes());
    let mut rt = Runtime::new(b, view, (1440.0, 900.0), Env::new(true, 1.0));
    rt.frame(0.0);
    (rt, Camera { pan, zoom, nudge })
}

fn views() -> u32 {
    VIEWS.with(std::cell::Cell::get)
}

/// commits and view runs over `n` frames of a camera that pans (and zooms, if asked) with the pointer at the middle
fn pan(rt: &mut Runtime<Board>, cam: &Camera, n: usize, zoom: bool, wheel: bool) -> (u64, u32) {
    rt.pointer_move(720.0, 450.0);
    rt.frame(1.0 / 60.0);
    let (c0, v0) = (rt.stats.commits, views());
    for i in 0..n {
        let [x, y] = cam.pan.get();
        cam.pan.set([x - 12.0, y - 6.0]);
        if zoom {
            cam.zoom.set(0.1 + (i as f32) * 0.002);
        }
        if wheel && zoom {
            rt.wheel_event(rune::WheelEvent::new(0.0, 4.0).at(720.0, 450.0).mods(rune::Mods { ctrl: true, cmd: true, ..Default::default() }));
        } else if wheel {
            rt.wheel_event(rune::WheelEvent::new(18.0, 10.0).at(720.0, 450.0));
        }
        if std::env::var_os("PER_FRAME_POINTER").is_some() {
            rt.pointer_move(720.0, 450.0);
        }
        rt.frame(1.0 / 60.0);
    }
    (rt.stats.commits - c0, views() - v0)
}

#[test]
fn a_camera_that_moves_under_a_resting_pointer_runs_no_view() {
    let (mut rt, cam) = board();
    let (commits, runs) = pan(&mut rt, &cam, 120, false, false);
    eprintln!("pan: {commits} commits, {runs} view runs over 120 frames");
    assert_eq!(runs, 0, "the camera is two live values: panning shouldn't run the view");
}

#[test]
fn a_pinch_runs_no_view() {
    let (mut rt, cam) = board();
    let (commits, runs) = pan(&mut rt, &cam, 120, true, false);
    eprintln!("pinch: {commits} commits, {runs} view runs over 120 frames");
    assert_eq!(runs, 0);
}

#[test]
fn the_wheel_over_the_board_runs_no_view() {
    let (mut rt, cam) = board();
    let (commits, runs) = pan(&mut rt, &cam, 120, false, true);
    eprintln!("pan with the wheel: {commits} commits, {runs} view runs over 120 frames");
    assert_eq!(runs, 0);
}

#[test]
fn the_paper_asked_to_draw_again_runs_no_view() {
    let (mut rt, cam) = board();
    let (c0, v0) = (rt.stats.commits, views());
    for i in 0..20 {
        cam.nudge.set(if i % 2 == 0 { [0.001, 0.0] } else { [0.0, 0.0] });
        rt.frame(1.0 / 60.0);
    }
    let (commits, runs) = (rt.stats.commits - c0, views() - v0);
    eprintln!("nudge: {commits} commits, {runs} view runs over 20 frames");
    assert_eq!(runs, 0);
}

#[test]
fn a_ctrl_wheel_pinch_over_the_board_runs_no_view() {
    let (mut rt, cam) = board();
    let (commits, runs) = pan(&mut rt, &cam, 120, true, true);
    eprintln!("pinch with ctrl-wheel: {commits} commits, {runs} view runs over 120 frames");
    assert_eq!(runs, 0);
}

#[test]
fn a_note_carried_runs_the_view_only_as_it_lifts() {
    let (mut rt, cam) = board();
    cam.zoom.set(1.0);
    rt.frame(1.0 / 60.0);
    // the first note's paper, below its bar (the world starts under the 48 pt floor)
    let (x, y) = (300.0, 48.0 + 300.0);
    rt.pointer_move(x, y);
    rt.frame(1.0 / 60.0);
    rt.pointer_down(x, y);
    rt.frame(1.0 / 60.0);
    let v0 = views();
    for i in 1..=40 {
        rt.pointer_move(x + i as f32 * 3.0, y + i as f32 * 2.0);
        rt.frame(1.0 / 60.0);
    }
    let runs = views() - v0;
    let lifted = rt.state.held.as_ref().is_some_and(|h| h.moved);
    eprintln!("carry: {runs} view runs over 40 moves, lifted {lifted}, hand {:?}", rt.state.hand.get());
    assert!(lifted, "the note is in hand");
    assert!(runs <= 2, "it lifts (and its drag begins) once; then only the live value moves ({runs} runs)");
    assert_eq!(rt.state.hand.get(), [120.0, 80.0]);
}
