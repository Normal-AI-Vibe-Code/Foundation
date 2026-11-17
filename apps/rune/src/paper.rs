//! The paper under the board, and the dots on a section's own paper.
//!
//! Rune's web canvas can't be see-through (its web host never asks WebGPU for an alpha canvas),
//! so the web renderer's paper can't show under it. This draws the same paper inside Rune's own
//! frame: `PAPER` below is apps/client/src/gl/background.ts's fragment shader, line for line
//! (the base and its diagonal, the film grain stepping twice a second, the dot grid that moves
//! with the camera, the light that follows the pointer, the vignette), in WGSL. A section's
//! body carries the CSS dots (App.css `.section-body`: 28 px, frost at 13 %).
//!
//! It hangs on Rune's compositor hook: the view marks where each goes with `El::effect`, and
//! the hook paints there, in painter order, inside Rune's own pass.

use std::cell::Cell;

use rune::Live;
use rune::compose::{Compositor, DeviceKey, Frame};

use crate::view::Board;

/// The board's paper: one slot, the whole canvas.
pub const MARK_PAPER: u32 = 0x5041_5001;
/// A section body's dots: `effect_data` is their colour, straight sRGB with alpha.
pub const MARK_DOTS: u32 = 0x5041_5002;

/// What the page tells the paper that the scene doesn't carry: where the pointer is (canvas
/// points), whether it's on the grid, and whether it's night.
#[derive(Clone, Copy)]
struct Light {
    x: f32,
    y: f32,
    inside: bool,
    night: bool,
    /// the page's clock, in seconds, as of its last tick (Rune's own only runs while it draws)
    time: f32,
}

thread_local! {
    static LIGHT: Cell<Light> = const { Cell::new(Light { x: -9999.0, y: -9999.0, inside: false, night: false, time: 0.0 }) };
    /// what the last frame drew with: the pointer's presence, the night, the pointer, and how many frames so far
    static DREW: Cell<[f32; 5]> = const { Cell::new([0.0; 5]) };
}

pub fn set_pointer(x: f32, y: f32, inside: bool) {
    LIGHT.with(|l| l.set(Light { x, y, inside, ..l.get() }));
}

/// The paper as the last frame drew it (presence, night, pointer x, y) and the frames drawn so far, for checks.
pub fn drew() -> [f32; 5] {
    DREW.with(Cell::get)
}

pub fn set_night(night: bool) {
    LIGHT.with(|l| l.set(Light { night, ..l.get() }));
}

/// The page's clock: the grain steps with it, twice a second.
pub fn set_time(seconds: f64) {
    // kept small, so a float still tells half seconds apart
    LIGHT.with(|l| l.set(Light { time: (seconds % 4096.0) as f32, ..l.get() }));
}

/// Slots a frame can paint: the paper and a section body each take one.
const SLOTS: usize = 128;
/// Each slot's uniforms sit at their own offset (WebGPU's alignment for one is 256 bytes).
const STRIDE: u64 = 256;
/// `Uniforms` below: five vec4.
const UNIFORM_BYTES: u64 = 80;

const SHADER: &str = "
struct Uniforms {
    // paper: the camera's offset (css px) and zoom. dots: the slot's origin (device px), device px per point
    place: vec4<f32>,   // x, y, scale, mode (0 paper, 1 dots)
    // paper: the pointer (css px), its presence 0..1, seconds. dots: the slot's size (device px)
    light: vec4<f32>,
    // the canvas (css px), device px per css px, night 0..1
    canvas: vec4<f32>,
    // this pass's origin in the window (device px), 1 when colours blend sRGB-encoded
    pass_: vec4<f32>,
    // dots: their colour, straight sRGB with alpha
    ink: vec4<f32>,
}
@group(0) @binding(0) var<uniform> u: Uniforms;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    return vec4<f32>(vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0, 0.0, 1.0);
}

fn hash(q: vec2<f32>) -> f32 {
    var p = fract(q * vec2<f32>(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

fn to_linear(c: vec3<f32>) -> vec3<f32> {
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3<f32>(2.4)), step(vec3<f32>(0.04045), c));
}

// what the target wants of an sRGB colour: itself when the frame blends encoded, linear otherwise
fn encode(c: vec3<f32>) -> vec3<f32> {
    if (u.pass_.z > 0.5) { return c; }
    return to_linear(clamp(c, vec3<f32>(0.0), vec3<f32>(1.0)));
}

@fragment fn fs(@builtin(position) at: vec4<f32>) -> @location(0) vec4<f32> {
    let px = at.xy + u.pass_.xy;

    if (u.place.w > 0.5) {
        // a section's dots: CSS radial-gradient(circle, ink 1.1px, transparent 1.4px) every 28 px
        let local = (px - u.place.xy) / u.place.z;
        let size = u.light.xy / u.place.z;
        if (local.x < 0.0 || local.y < 0.0 || local.x > size.x || local.y > size.y) { discard; }
        let cell = local - 28.0 * floor(local / 28.0) - 14.0;
        // on screen: solid to 1.1 px, gone by 1.4 px, times the zoom; the edge is never thinner than a
        // device pixel, and a dot smaller than one fades by the share of the pixel it covers
        let scale = u.place.z;
        let mid = 1.25 * scale;
        let half = max(0.15 * scale, 0.5);
        let cover = min(1.0, (mid / 0.6) * (mid / 0.6));
        let a = (1.0 - smoothstep(mid - half, mid + half, length(cell) * scale)) * cover * u.ink.a;
        return vec4<f32>(encode(u.ink.rgb) * a, a);
    }

    let dpr = u.canvas.z;
    let night = u.canvas.w;
    let res = u.canvas.xy;
    let css = px / dpr;

    // paper base with a very soft diagonal tint: Vision paper #f6f3ec by day, graphite #0f0f10 by night
    var paper = mix(vec3<f32>(0.965, 0.953, 0.925), vec3<f32>(0.059, 0.059, 0.063), night);
    let diag = (css.x / res.x + css.y / res.y) * 0.5;
    paper -= diag * 0.012;

    // film grain, stepping twice a second
    let g = hash(css + floor(u.light.w * 2.0) * 17.0);
    paper += (g - 0.5) * 0.018;

    // dot grid in world space (moves with the camera)
    let scale = u.place.z;
    let world = (css - u.place.xy) / scale;
    let spacing = 28.0;
    let cell = world - spacing * floor(world / spacing) - spacing * 0.5;
    let dist = length(cell) * scale;
    let r = 1.1 * clamp(scale, 0.5, 1.6);
    let dot_ = 1.0 - smoothstep(r - 0.7, r + 0.7, dist);
    // fade dots out when zoomed way out
    let fade = smoothstep(0.25, 0.5, scale);
    let ink = mix(vec3<f32>(0.72, 0.71, 0.69), vec3<f32>(0.27, 0.27, 0.28), night);
    paper = mix(paper, ink, dot_ * 0.55 * fade);

    // pointer light: a soft warm glow that follows the cursor
    let d = length(css - u.light.xy);
    let glow = exp(-d * d / (2.0 * 220.0 * 220.0)) * mix(0.05, 0.035, night) * u.light.z;
    paper += glow;
    // brighten dots near the pointer
    let near = exp(-d * d / (2.0 * 140.0 * 140.0)) * u.light.z;
    paper = mix(paper, mix(vec3<f32>(0.42, 0.40, 0.38), vec3<f32>(0.62, 0.62, 0.62), night), dot_ * near * 0.5 * fade);

    // vignette
    let uv = css / res;
    let vig = smoothstep(1.25, 0.45, length(uv - 0.5) * 1.35);
    paper *= mix(0.965, 1.0, vig);

    return vec4<f32>(encode(paper), 1.0);
}
";

struct Gpu {
    device: DeviceKey,
    buffer: wgpu::Buffer,
    layout: wgpu::BindGroupLayout,
    group: wgpu::BindGroup,
    shader: wgpu::ShaderModule,
    pipelines: Vec<(wgpu::TextureFormat, wgpu::RenderPipeline)>,
}

impl Gpu {
    fn new(device: &wgpu::Device, key: DeviceKey) -> Gpu {
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("foundation paper"), size: STRIDE * SLOTS as u64, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false,
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("foundation paper"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0, visibility: wgpu::ShaderStages::FRAGMENT, count: None,
                ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: true, min_binding_size: wgpu::BufferSize::new(UNIFORM_BYTES) },
            }],
        });
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("foundation paper"), layout: &layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding { buffer: &buffer, offset: 0, size: wgpu::BufferSize::new(UNIFORM_BYTES) }),
            }],
        });
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("foundation paper"), source: wgpu::ShaderSource::Wgsl(SHADER.into()) });
        Gpu { device: key, buffer, layout, group, shader, pipelines: Vec::new() }
    }

    fn pipeline(&mut self, device: &wgpu::Device, format: wgpu::TextureFormat) -> usize {
        if let Some(i) = self.pipelines.iter().position(|(f, _)| *f == format) {
            return i;
        }
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("foundation paper"), bind_group_layouts: &[Some(&self.layout)], immediate_size: 0 });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("foundation paper"), layout: Some(&layout),
            vertex: wgpu::VertexState { module: &self.shader, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[] },
            fragment: Some(wgpu::FragmentState {
                module: &self.shader, entry_point: Some("fs"), compilation_options: Default::default(),
                // premultiplied, as everything Rune draws is
                targets: &[Some(wgpu::ColorTargetState { format, blend: Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING), write_mask: wgpu::ColorWrites::ALL })],
            }),
            primitive: Default::default(), depth_stencil: None, multisample: Default::default(), multiview_mask: None, cache: None,
        });
        self.pipelines.push((format, pipeline));
        self.pipelines.len() - 1
    }
}

/// Draws Rune's frame, painting the paper and the sections' dots where the view marked them.
pub struct Paper {
    pan: Live<[f32; 2]>,
    zoom: Live<f32>,
    /// the pointer's presence and the night, eased as the web paper eases them
    presence: f32,
    night: Option<f32>,
    easing: bool,
    gpu: Option<Gpu>,
}

impl Paper {
    pub fn new(pan: Live<[f32; 2]>, zoom: Live<f32>) -> Paper {
        Paper { pan, zoom, presence: 0.0, night: None, easing: false, gpu: None }
    }
}

/// One step of the web paper's per-frame ease (`v += (target - v) * rate` at 60 Hz), over `dt`.
fn ease(v: f32, target: f32, rate: f32, dt: f64) -> f32 {
    let frames = (dt as f32 * 60.0).clamp(0.0, 12.0);
    let next = target + (v - target) * (1.0 - rate).powf(frames);
    if (target - next).abs() < 0.002 { target } else { next }
}

impl Compositor<Board> for Paper {
    fn render(&mut self, f: &mut Frame<'_, Board>) {
        let light = LIGHT.with(Cell::get);
        let night_to = if light.night { 1.0 } else { 0.0 };
        // it starts in the right light, and fades only when the light changes
        let night = self.night.map_or(night_to, |n| ease(n, night_to, 0.045, f.dt));
        self.night = Some(night);
        self.presence = ease(self.presence, if light.inside { 1.0 } else { 0.0 }, 0.08, f.dt);
        self.easing = night != night_to || self.presence != if light.inside { 1.0 } else { 0.0 };

        DREW.with(|d| d.set([self.presence, night, light.x, light.y, d.get()[4] + 1.0]));

        let (device, queue, clear) = (f.device, f.queue, f.rt.clear_color());
        let key = f.device_key();
        if self.gpu.as_ref().is_none_or(|g| g.device != key) {
            self.gpu = Some(Gpu::new(device, key));
        }
        let gpu = self.gpu.as_mut().expect("made above");
        let [pan_x, pan_y] = self.pan.get();
        let zoom = self.zoom.get();
        let (t, presence) = (light.time, self.presence);
        let canvas_px = (f.size.0 as f32, f.size.1 as f32);

        f.ui.prepare(device, queue, &mut f.rt.text.atlas, &f.rt.instances, f.size);
        let mut slot = 0usize;
        f.ui.draw_with(f.encoder, f.target, clear, &mut |pass, site| {
            if (site.mark != MARK_PAPER && site.mark != MARK_DOTS) || slot >= SLOTS {
                return;
            }
            let blend = if site.srgb_blend { 1.0 } else { 0.0 };
            let [x, y, w, h] = site.instance.rect;
            let uniforms: [f32; 20] = if site.mark == MARK_PAPER {
                let dpr = site.scale.max(0.01);
                [
                    pan_x, pan_y, zoom, 0.0,
                    light.x, light.y, presence, t,
                    canvas_px.0 / dpr, canvas_px.1 / dpr, dpr, night,
                    site.origin[0], site.origin[1], blend, 0.0,
                    0.0, 0.0, 0.0, 0.0,
                ]
            } else {
                let [r, g, b, a] = site.data;
                [
                    x, y, site.scale.max(0.001), 1.0,
                    w, h, 0.0, 0.0,
                    0.0, 0.0, 0.0, 0.0,
                    site.origin[0], site.origin[1], blend, 0.0,
                    r, g, b, a,
                ]
            };
            let bytes: Vec<u8> = uniforms.iter().flat_map(|v| v.to_le_bytes()).collect();
            let offset = slot as u64 * STRIDE;
            queue.write_buffer(&gpu.buffer, offset, &bytes);
            let i = gpu.pipeline(device, site.format);
            pass.set_pipeline(&gpu.pipelines[i].1);
            pass.set_bind_group(0, &gpu.group, &[offset as u32]);
            pass.draw(0..3, 0..1);
            slot += 1;
        });
    }

    /// The pointer's glow coming or going, or the night fading: keep drawing until it rests.
    /// (The grain's step, twice a second, is the page's to ask for, on its clock: `lib.rs` `tick`.)
    fn animating(&self) -> bool {
        self.easing
    }
}
