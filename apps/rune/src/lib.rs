//! Foundation's board drawn by Rune, for the browser and the desktop app's webview (WebGPU).
//!
//! It runs beside the web renderer, never instead of it: Settings → Renderer picks which one
//! draws the grid, and the web one is the default. The client keeps the store, sync and the
//! camera; this crate draws what it's handed (`scene`) and reports what the person did
//! (`bridge`). `apps/client/src/rune/` is the other half.

pub mod bridge;
pub mod paper;
pub mod scene;
pub mod view;

#[cfg(target_arch = "wasm32")]
mod web {
    use std::cell::RefCell;

    use rune::{App, AppHandle, AppSpec, ImageCache, Live, Waker, WindowOptions};
    use wasm_bindgen::prelude::*;

    use crate::bridge;
    use crate::paper::{self, Paper};
    use crate::scene::{SCENE_VERSION, Scene};
    use crate::view::{Board, view};

    thread_local! {
        static CAMERA: (Live<[f32; 2]>, Live<f32>) = (Live::new([0.0, 0.0]), Live::new(0.5));
        /// The paper's place, moved a hair to ask for a frame when only the paper changed (its light, its
        /// grain): Rune draws when a live value moves, and not for an update that changed nothing.
        static NUDGE: Live<[f32; 2]> = Live::new([0.0, 0.0]);
        static HANDLE: RefCell<Option<AppHandle<Board>>> = const { RefCell::new(None) };
    }

    fn init() -> Board {
        CAMERA.with(|(pan, zoom)| Board::new(pan.clone(), zoom.clone(), NUDGE.with(Live::clone)))
    }

    fn setup(board: &mut Board, waker: Waker) {
        board.cache = Some(ImageCache::new(waker));
    }

    /// Draw the paper again (nothing else changed).
    fn redraw() {
        NUDGE.with(|n| n.set(if n.get()[0] == 0.0 { [0.001, 0.0] } else { [0.0, 0.0] }));
    }

    fn update(f: impl FnOnce(&mut Board) + Send + 'static) {
        HANDLE.with(|h| {
            if let Some(handle) = h.borrow().as_ref() {
                handle.update(move |board, _| f(board));
            }
        });
    }

    /// The scene shape this module reads; the client checks it before mounting.
    #[wasm_bindgen(js_name = sceneVersion)]
    pub fn scene_version() -> u32 {
        SCENE_VERSION
    }

    /// Draw onto `<canvas id>`, covering the viewport; `on_event` hears each `bridge::Event` as
    /// JSON. `transparent` asks for a see-through canvas (Rune's web host has none yet, so the
    /// paper is drawn here: `paper.rs`). `fonts` is the folder the faces are served from.
    #[wasm_bindgen]
    pub fn mount(canvas_id: String, transparent: bool, fonts: String, on_event: js_sys::Function) -> Result<(), String> {
        bridge::set_sink(Some(Box::new(move |json| {
            let _ = on_event.call1(&JsValue::NULL, &JsValue::from_str(json));
        })));
        let base = AppSpec::new("Foundation", (1280.0, 800.0), init, view);
        // the sans slot is the app's face, for everything that doesn't name one (the kit's markdown);
        // the code slot is the face Rune carries on the web
        let spec = AppSpec { setup: Some(setup), families: (crate::view::FACE_NAMES, "IBM Plex Mono"), ..base };
        let paper = CAMERA.with(|(pan, zoom)| Paper::new(pan.clone(), zoom.clone()));
        // the app's own face (apps/rune/fonts, beside the wasm), fetched once the first frame is up: a font
        // handed over before it would replace Rune's built-in faces, the code face among them. Until they
        // arrive, and for scripts they don't carry, Rune sets Inter.
        let app = App::new(spec).canvas_id(canvas_id).full_viewport().window_options(WindowOptions { transparent, ..WindowOptions::default() })
            .compositor(paper)
            .font_url_later(&format!("{fonts}HankenGrotesk-Latin.ttf"))
            .font_url_later(&format!("{fonts}HankenGrotesk-Latin-Italic.ttf"))
            .font_url_later(&format!("{fonts}HankenGrotesk-LatinExt.ttf"))
            .font_url_later(&format!("{fonts}HankenGrotesk-LatinExt-Italic.ttf"));
        HANDLE.with(|h| *h.borrow_mut() = Some(app.handle()));
        app.try_run()
    }

    /// The board as the store has it now (`scene::Scene`, as JSON).
    #[wasm_bindgen(js_name = setScene)]
    pub fn set_scene(json: String) -> Result<(), String> {
        let scene: Scene = serde_json::from_str(&json).map_err(|e| e.to_string())?;
        update(move |board| board.set_scene(scene));
        Ok(())
    }

    /// The camera, every frame it moves: draws without re-running the view.
    #[wasm_bindgen(js_name = setCamera)]
    pub fn set_camera(x: f32, y: f32, scale: f32) {
        CAMERA.with(|(pan, zoom)| {
            pan.set([x, y]);
            zoom.set(scale);
        });
    }

    /// Where the pointer is over the grid (canvas points), for the paper's light; `inside` false when it left.
    #[wasm_bindgen(js_name = setPointer)]
    pub fn set_pointer(x: f32, y: f32, inside: bool) {
        paper::set_pointer(x, y, inside);
        redraw();
    }

    /// Day or night: the paper fades between them as the web's does.
    #[wasm_bindgen(js_name = setNight)]
    pub fn set_night(night: bool) {
        paper::set_night(night);
        redraw();
    }

    /// The paper as the last frame drew it: the pointer's presence, the night, the pointer, frames so far.
    #[wasm_bindgen(js_name = paperDrew)]
    pub fn paper_drew() -> Vec<f32> {
        let mut drew = paper::drew().to_vec();
        // and how many times the view has run
        drew.push(crate::view::VIEWS.with(std::cell::Cell::get) as f32);
        drew
    }

    /// The page's clock, twice a second: the paper's grain steps, though nothing else changed.
    #[wasm_bindgen]
    pub fn tick(seconds: f64) {
        paper::set_time(seconds);
        redraw();
    }

    /// Open a note for writing (the client decides when: a double-click on a note already framed).
    #[wasm_bindgen(js_name = beginEdit)]
    pub fn begin_edit(id: String) {
        update(move |board| board.begin_edit(&id));
    }

    #[wasm_bindgen(js_name = endEdit)]
    pub fn end_edit() {
        update(|board| board.end_edit());
    }

    /// Stop drawing and give the canvas back (the engine was switched, or the board closed).
    #[wasm_bindgen]
    pub fn unmount() {
        HANDLE.with(|h| {
            if let Some(handle) = h.borrow_mut().take() {
                handle.quit();
            }
        });
        bridge::set_sink(None);
    }
}
