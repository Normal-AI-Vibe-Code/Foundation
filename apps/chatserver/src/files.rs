//! Files in messages: pictures, GIFs, video, anything. The Node server's routes and JSON (`apps/server/src/files.ts`,
//! `apps/server/src/index.ts`): `POST /api/files?board=chat&name=<name>` with the raw bytes answers
//! `{ file: { id, name, mime, size, width, height, url: "/files/<id>", … } }`; `GET /files/<id>` serves them; a message
//! is posted with `files: [ids]` and carries `files: ChatFile[]` (with `w`/`h` for pictures, so nothing shifts).
//!
//! - **Kept in Postgres** (`chat_files.bytes`): a function on Vercel has no disk. One file holds at most 4 MB
//!   (Vercel's request body limit is 4.5 MB).
//! - **Who may open one**: whoever uploaded it, and anyone who can read a message (not removed) that carries it.
//!   Nobody else, admins included; to them it answers like a missing file.
//! - **Archived, never deleted**: there is no route that removes a file, and removing a message keeps its files' rows.
//! - **Served safely**: a file is shown in place only if it is one of a fixed list of passive types; everything else
//!   is a download of opaque bytes. Every answer carries nosniff and a CSP sandbox, `Cache-Control: private`, and an
//!   ETag (304 when it matches).
//! - **Width tiers** (`?w=64|256|512|1024|2048`, as `apps/server/src/imagelod.ts`): a JPEG, PNG or WebP wider than
//!   the tier is scaled down (JPEG, or PNG when it has alpha) and the result kept in `chat_file_variants`; anything
//!   else, or a picture over 64 megapixels (refused before it is decoded), is served as it is.

use std::io::Cursor;

use axum::{
    Json,
    body::Body,
    extract::{Path, Query, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use image::{DynamicImage, ImageDecoder, ImageReader, metadata::Orientation};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{
    St,
    auth::{User, require_user},
    error::{Error, Result, bad, forbidden, http, not_found},
    util::{new_id, now_ms},
};

/// one file: 4 MB (Vercel refuses a request body over 4.5 MB before this server sees it)
pub const FILE_MAX: usize = 4 * 1024 * 1024;
/// files on one message (packages/protocol CHAT_FILES_MAX)
pub const FILES_MAX: usize = 12;
pub const LOD_WIDTHS: [u32; 5] = [64, 256, 512, 1024, 2048];
const MAX_IMAGE_PIXELS: u64 = 64_000_000;
const MAX_IMAGE_DIM: u32 = 16_384;
const OCTET: &str = "application/octet-stream";
const CACHE: &str = "private, max-age=31536000, immutable";

const INLINE_TYPES: [&str; 35] = [
    "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif",
    "video/mp4", "video/webm",
    "audio/mpeg", "audio/mp3", "audio/mp4", "audio/x-m4a", "audio/m4a", "audio/aac", "audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave", "audio/ogg", "audio/webm",
    "application/pdf",
    "text/plain",
    "model/stl", "model/x.stl-binary", "model/x.stl-ascii", "application/sla", "application/vnd.ms-pki.stl",
    "model/obj", "model/3mf", "model/gltf-binary", "model/gltf+json", "model/step", "model/step+zip", "model/iges", "application/step", "application/iges",
];
const KNOWN_APPLICATION: [&str; 18] = [
    "application/json", "application/zip", "application/gzip", "application/x-gzip", "application/x-tar", "application/x-7z-compressed", "application/x-zip-compressed",
    "application/msword", "application/vnd.ms-excel", "application/vnd.ms-powerpoint", "application/rtf", "application/yaml", "application/x-yaml", "application/toml",
    "application/dxf", "application/acad", "application/x-step", "application/vnd.sqlite3",
];
/// the pictures a width tier can be made of
const RASTER: [&str; 3] = ["image/jpeg", "image/png", "image/webp"];

/// never trusted as itself: a browser could run it as a page, a script or a stylesheet
pub fn is_active_type(mime: &str) -> bool {
    let m = mime.to_ascii_lowercase();
    let (kind, sub) = m.split_once('/').unwrap_or((m.as_str(), ""));
    if kind == "multipart" || kind == "message" {
        return true;
    }
    if sub == "html" || sub == "xhtml+xml" || sub == "xml" || sub.ends_with("+xml") || sub == "xsl" || sub == "xslt" {
        return true;
    }
    if sub.contains("javascript") || sub.contains("ecmascript") || sub == "jscript" || sub == "livescript" {
        return true;
    }
    sub == "css" || sub == "x-shockwave-flash" || sub == "futuresplash"
}

fn mime_token(s: &str) -> bool {
    let mut c = s.chars();
    c.next().is_some_and(|f| f.is_ascii_lowercase() || f.is_ascii_digit()) && c.all(|x| x.is_ascii_lowercase() || x.is_ascii_digit() || matches!(x, '.' | '+' | '-'))
}

/// the type a new file is stored under: what the uploader said, if it is a known type that isn't active; anything
/// else (unknown, malformed, or something a browser would run) is opaque bytes
pub fn stored_mime(said: &str) -> String {
    let m = said.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    let Some((kind, sub)) = m.split_once('/') else { return OCTET.into() };
    if !mime_token(kind) || !mime_token(sub) || is_active_type(&m) {
        return OCTET.into();
    }
    let known = INLINE_TYPES.contains(&m.as_str())
        || KNOWN_APPLICATION.contains(&m.as_str())
        || matches!(kind, "image" | "video" | "audio" | "model" | "text")
        || m.starts_with("application/vnd.openxmlformats-officedocument.")
        || m.starts_with("application/vnd.oasis.opendocument.")
        || m.starts_with("application/vnd.ms-");
    if known { m } else { OCTET.into() }
}

/// is this stored type shown in place (one of the passive list), or handed over as a download
pub fn is_inline(mime: &str) -> bool {
    let m = mime.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    INLINE_TYPES.contains(&m.as_str()) && !is_active_type(&m)
}

fn percent(name: &str) -> String {
    let mut out = String::new();
    for b in name.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// a requested display width as one of the fixed tiers (so `?w=` can't ask for endless sizes), or None for the original
pub fn snap_width(w: Option<&str>) -> Option<u32> {
    let n: f64 = w?.trim().parse().ok()?;
    if !n.is_finite() || n <= 0.0 {
        return None;
    }
    Some(LOD_WIDTHS.iter().copied().find(|t| f64::from(*t) >= n).unwrap_or(LOD_WIDTHS[LOD_WIDTHS.len() - 1]))
}

fn turned(o: Orientation) -> bool {
    matches!(o, Orientation::Rotate90 | Orientation::Rotate270 | Orientation::Rotate90FlipH | Orientation::Rotate270FlipH)
}

/// a picture's size as it is shown (a phone's sideways photo is turned), read from its header alone
pub fn probe(bytes: &[u8]) -> Option<(u32, u32)> {
    let mut dec = ImageReader::new(Cursor::new(bytes)).with_guessed_format().ok()?.into_decoder().ok()?;
    let (w, h) = dec.dimensions();
    if w == 0 || h == 0 {
        return None;
    }
    let o = dec.orientation().unwrap_or(Orientation::NoTransforms);
    Some(if turned(o) { (h, w) } else { (w, h) })
}

/// may a picture of this size be decoded at all (a small file can claim to be enormous)
pub fn safe_dimensions(w: u32, h: u32) -> bool {
    w > 0 && h > 0 && w <= MAX_IMAGE_DIM && h <= MAX_IMAGE_DIM && u64::from(w) * u64::from(h) <= MAX_IMAGE_PIXELS
}

pub struct Variant {
    pub mime: &'static str,
    pub width: u32,
    pub height: u32,
    pub natural: (u32, u32),
    pub alpha: bool,
    pub bytes: Vec<u8>,
}

/// the picture scaled down to `tier` wide, or None: not a picture this can read, too large to decode, or already
/// no wider than the tier (the original is served)
pub fn make_variant(bytes: &[u8], tier: u32) -> Option<Variant> {
    let mut reader = ImageReader::new(Cursor::new(bytes)).with_guessed_format().ok()?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_DIM);
    limits.max_image_height = Some(MAX_IMAGE_DIM);
    limits.max_alloc = Some(512 * 1024 * 1024);
    reader.limits(limits);
    let mut dec = reader.into_decoder().ok()?;
    let (w, h) = dec.dimensions();
    // refused before a single pixel is decoded
    if !safe_dimensions(w, h) {
        return None;
    }
    let o = dec.orientation().unwrap_or(Orientation::NoTransforms);
    let (nw, nh) = if turned(o) { (h, w) } else { (w, h) };
    if nw <= tier {
        return None;
    }
    let mut img = DynamicImage::from_decoder(dec).ok()?;
    img.apply_orientation(o);
    let alpha = img.color().has_alpha();
    let th = ((u64::from(nh) * u64::from(tier) + u64::from(nw) / 2) / u64::from(nw)).max(1) as u32;
    let small = img.resize_exact(tier, th, image::imageops::FilterType::Triangle);
    let mut out = Cursor::new(Vec::new());
    let mime = if alpha {
        small.write_to(&mut out, image::ImageFormat::Png).ok()?;
        "image/png"
    } else {
        let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 82);
        small.to_rgb8().write_with_encoder(enc).ok()?;
        "image/jpeg"
    };
    Some(Variant { mime, width: tier, height: th, natural: (nw, nh), alpha, bytes: out.into_inner() })
}

#[derive(sqlx::FromRow)]
struct Meta {
    id: String,
    name: String,
    mime: String,
    size: i64,
    sha256: String,
    uploaded_by: String,
    created_at: i64,
    archived_at: Option<i64>,
    width: Option<i32>,
    height: Option<i32>,
}
const META_COLS: &str = "id, name, mime, size, sha256, uploaded_by, created_at, archived_at, width, height";

fn file_json(m: &Meta) -> Value {
    json!({
        "id": m.id, "board_id": "chat", "name": m.name, "mime": m.mime, "size": m.size, "sha256": m.sha256,
        "uploaded_by": m.uploaded_by, "created_at": m.created_at, "archived_at": m.archived_at, "about": null,
        "width": m.width, "height": m.height, "url": format!("/files/{}", m.id),
    })
}

#[derive(Deserialize)]
pub struct UploadQuery {
    board: Option<String>,
    name: Option<String>,
}

fn too_big() -> Error {
    http(StatusCode::PAYLOAD_TOO_LARGE, "That file is too big for this chat server: a file here holds at most 4 MB.")
}

/// POST /api/files?board=chat&name=<name>, the raw bytes as the body, their type as Content-Type
pub async fn upload(State(st): State<St>, headers: HeaderMap, Query(q): Query<UploadQuery>, req: Request) -> Result<Json<Value>> {
    let user = require_user(&st, &headers).await?;
    if q.board.as_deref() != Some("chat") {
        return Err(bad("board: chat (this server keeps ChatForm's files only)"));
    }
    if user.role == "viewer" {
        return Err(forbidden("View only: your account can't add files"));
    }
    // read to just past the limit and no further (the answer is in words either way)
    let body = axum::body::to_bytes(req.into_body(), FILE_MAX + 1).await.map_err(|_| too_big())?;
    if body.len() > FILE_MAX {
        return Err(too_big());
    }
    if body.is_empty() {
        return Err(bad("empty file"));
    }
    let name: String = q.name.unwrap_or_default().chars().filter(|c| !c.is_control()).take(240).collect();
    let name = if name.trim().is_empty() { "untitled".to_string() } else { name };
    let mime = stored_mime(headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or(""));
    let sha: String = Sha256::digest(&body).iter().map(|b| format!("{b:02x}")).collect();
    // the same bytes from the same person are one file; from someone else, their own
    let same: Option<Meta> = sqlx::query_as(&format!("select {META_COLS} from chat_files where sha256 = $1 and uploaded_by = $2 and archived_at is null order by created_at limit 1")).bind(&sha).bind(&user.id).fetch_optional(&st.db).await?;
    if let Some(m) = same {
        return Ok(Json(json!({ "file": file_json(&m) })));
    }
    let dims = if mime.starts_with("image/") { probe(&body) } else { None };
    let id = new_id("f");
    let m: Meta = sqlx::query_as(&format!("insert into chat_files (id, name, mime, size, sha256, uploaded_by, created_at, width, height, bytes) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning {META_COLS}"))
        .bind(&id)
        .bind(&name)
        .bind(&mime)
        .bind(body.len() as i64)
        .bind(&sha)
        .bind(&user.id)
        .bind(now_ms())
        .bind(dims.map(|d| d.0 as i32))
        .bind(dims.map(|d| d.1 as i32))
        .bind(body.as_ref())
        .fetch_one(&st.db)
        .await?;
    Ok(Json(json!({ "file": file_json(&m) })))
}

/// may this person open this file: they uploaded it, or they can read a message (not removed) that carries it
pub async fn can_see_file(st: &St, user: &User, file_id: &str) -> Result<bool> {
    let row: Option<(bool,)> = sqlx::query_as(
        "select f.uploaded_by = $2 or exists (
           select 1 from chat_file_uses fu
             join chat_messages m on m.id = fu.message_id
             join chat_channels c on c.id = m.channel_id
            where fu.file_id = f.id and m.deleted_at is null
              and (c.kind = 'open' or exists (select 1 from chat_members x where x.channel_id = c.id and x.user_id = $2)))
         from chat_files f where f.id = $1",
    )
    .bind(file_id)
    .bind(&user.id)
    .fetch_optional(&st.db)
    .await?;
    Ok(row.is_some_and(|r| r.0))
}

/// The files a person may put on a message, as the message names them (`ChatFile`): their own uploads and files
/// they can already see, at most twelve.
pub async fn attachable(st: &St, user: &User, ids: Option<&Value>) -> Result<Vec<Value>> {
    let Some(ids) = ids.filter(|v| !v.is_null()) else { return Ok(vec![]) };
    let list: Option<Vec<&str>> = ids.as_array().and_then(|a| a.iter().map(|x| x.as_str()).collect());
    let Some(list) = list else { return Err(bad("files: a list of file ids")) };
    if list.len() > FILES_MAX {
        return Err(bad(format!("at most {FILES_MAX} files on a message")));
    }
    let mut out: Vec<Value> = vec![];
    for id in list {
        if out.iter().any(|f| f["id"] == json!(id)) {
            continue;
        }
        if !can_see_file(st, user, id).await? {
            return Err(bad(format!("no such file: {id} (upload it first: POST /api/files?board=chat)")));
        }
        let m: Meta = sqlx::query_as(&format!("select {META_COLS} from chat_files where id = $1")).bind(id).fetch_one(&st.db).await?;
        let mut f = json!({ "id": m.id, "name": m.name, "mime": m.mime, "size": m.size });
        if let (Some(w), Some(h)) = (m.width, m.height)
            && w > 0
            && h > 0
        {
            f["w"] = json!(w);
            f["h"] = json!(h);
        }
        out.push(f);
    }
    Ok(out)
}

fn etag_matches(headers: &HeaderMap, etag: &str) -> bool {
    headers.get_all(header::IF_NONE_MATCH).iter().filter_map(|v| v.to_str().ok()).flat_map(|v| v.split(',')).any(|part| {
        let t = part.trim();
        let t = t.strip_prefix("W/").or_else(|| t.strip_prefix("w/")).unwrap_or(t);
        t == "*" || t == etag
    })
}

fn set(h: &mut HeaderMap, k: &'static str, v: &str) {
    if let Ok(v) = HeaderValue::from_str(v) {
        h.insert(k, v);
    }
}

/// the headers every file answer carries: its own type in place only for the passive list, else a download
fn file_headers(mime: &str, name: &str, etag: &str) -> HeaderMap {
    let inline = is_inline(mime);
    let mut h = HeaderMap::new();
    set(&mut h, "content-type", if inline { mime } else { OCTET });
    set(&mut h, "content-disposition", &format!("{}; filename*=UTF-8''{}", if inline { "inline" } else { "attachment" }, percent(name)));
    set(&mut h, "x-content-type-options", "nosniff");
    set(&mut h, "content-security-policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'");
    set(&mut h, "etag", etag);
    set(&mut h, "cache-control", CACHE);
    h
}

fn not_modified(etag: &str) -> Response {
    let mut h = HeaderMap::new();
    set(&mut h, "etag", etag);
    set(&mut h, "cache-control", CACHE);
    (StatusCode::NOT_MODIFIED, h).into_response()
}

/// `bytes=a-b`, `bytes=a-` or `bytes=-n` against a file of `size`: the first and last byte, or Err when it can't be met
pub fn byte_range(header: &str, size: u64) -> Option<std::result::Result<(u64, u64), ()>> {
    let spec = header.trim().strip_prefix("bytes=")?;
    let (a, b) = spec.split_once('-')?;
    let (a, b) = (a.trim(), b.trim());
    if a.is_empty() && b.is_empty() || spec.contains(',') {
        return None;
    }
    let (start, end) = if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        (size.saturating_sub(n), size.saturating_sub(1))
    } else {
        let start: u64 = a.parse().ok()?;
        let end = if b.is_empty() { size.saturating_sub(1) } else { b.parse::<u64>().ok()?.min(size.saturating_sub(1)) };
        (start, end)
    };
    Some(if size == 0 || start >= size || start > end { Err(()) } else { Ok((start, end)) })
}

#[derive(Deserialize)]
pub struct ServeQuery {
    w: Option<String>,
}

/// GET /files/<id> (and HEAD): the bytes, to whoever may see them. `?w=` asks for a width tier of a picture.
pub async fn serve(State(st): State<St>, headers: HeaderMap, Path(id): Path<String>, Query(q): Query<ServeQuery>) -> Result<Response> {
    let user = require_user(&st, &headers).await?;
    // a file this person can't see answers like a missing one
    if !can_see_file(&st, &user, &id).await? {
        return Err(not_found("no such file"));
    }
    let m: Meta = sqlx::query_as(&format!("select {META_COLS} from chat_files where id = $1")).bind(&id).fetch_optional(&st.db).await?.ok_or_else(|| not_found("no such file"))?;
    let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok()).map(str::to_string);
    let tier = if RASTER.contains(&m.mime.as_str()) && range.is_none() { snap_width(q.w.as_deref()) } else { None };
    let orig_etag = format!("\"{}-orig\"", m.sha256);
    let natural = match (m.width, m.height) {
        (Some(w), Some(h)) if w > 0 && h > 0 => Some((w as u32, h as u32)),
        _ => None,
    };

    // a width tier, when the picture is wider than it (and small enough to decode)
    if let Some(tier) = tier
        && natural.is_some_and(|(w, h)| w > tier && safe_dimensions(w, h))
    {
        let etag = format!("\"{}-w{tier}\"", m.sha256);
        if etag_matches(&headers, &etag) {
            return Ok(not_modified(&etag));
        }
        if let Some(v) = variant(&st, &m, tier).await? {
            let mut h = file_headers(v.mime, &m.name, &etag);
            set(&mut h, "x-image-level", &v.width.to_string());
            set(&mut h, "x-image-natural-width", &v.natural.0.to_string());
            set(&mut h, "x-image-natural-height", &v.natural.1.to_string());
            set(&mut h, "x-image-width", &v.width.to_string());
            set(&mut h, "x-image-height", &v.height.to_string());
            set(&mut h, "x-image-alpha", if v.alpha { "1" } else { "0" });
            return Ok((StatusCode::OK, h, Body::from(v.bytes)).into_response());
        }
    }

    if range.is_none() && etag_matches(&headers, &orig_etag) {
        return Ok(not_modified(&orig_etag));
    }
    let mut h = file_headers(&m.mime, &m.name, &orig_etag);
    set(&mut h, "accept-ranges", "bytes");
    set(&mut h, "x-image-level", "original");
    if let Some((w, hh)) = natural {
        set(&mut h, "x-image-natural-width", &w.to_string());
        set(&mut h, "x-image-natural-height", &hh.to_string());
    }
    let size = m.size.max(0) as u64;
    if let Some(Some(r)) = range.as_deref().map(|r| byte_range(r, size)) {
        let Ok((start, end)) = r else {
            let mut h = HeaderMap::new();
            set(&mut h, "content-range", &format!("bytes */{size}"));
            return Ok((StatusCode::RANGE_NOT_SATISFIABLE, h).into_response());
        };
        let (part,): (Vec<u8>,) = sqlx::query_as("select substring(bytes from $2::int for $3::int) from chat_files where id = $1").bind(&id).bind(start as i32 + 1).bind((end - start + 1) as i32).fetch_one(&st.db).await?;
        set(&mut h, "content-range", &format!("bytes {start}-{end}/{size}"));
        return Ok((StatusCode::PARTIAL_CONTENT, h, Body::from(part)).into_response());
    }
    let (bytes,): (Vec<u8>,) = sqlx::query_as("select bytes from chat_files where id = $1").bind(&id).fetch_one(&st.db).await?;
    Ok((StatusCode::OK, h, Body::from(bytes)).into_response())
}

#[derive(sqlx::FromRow)]
struct Kept {
    mime: String,
    width: i32,
    height: i32,
    natural_width: i32,
    natural_height: i32,
    alpha: bool,
    bytes: Vec<u8>,
}

/// the kept width tier of this file's bytes, made now if it hasn't been (two decodes at a time, off the async threads)
async fn variant(st: &St, m: &Meta, tier: u32) -> Result<Option<Variant>> {
    let kept: Option<Kept> = sqlx::query_as("select mime, width, height, natural_width, natural_height, alpha, bytes from chat_file_variants where sha256 = $1 and w = $2").bind(&m.sha256).bind(tier as i32).fetch_optional(&st.db).await?;
    if let Some(k) = kept {
        let mime = if k.mime == "image/png" { "image/png" } else { "image/jpeg" };
        return Ok(Some(Variant { mime, width: k.width as u32, height: k.height as u32, natural: (k.natural_width as u32, k.natural_height as u32), alpha: k.alpha, bytes: k.bytes }));
    }
    let (bytes,): (Vec<u8>,) = sqlx::query_as("select bytes from chat_files where id = $1").bind(&m.id).fetch_one(&st.db).await?;
    let Ok(_permit) = st.decodes.acquire().await else { return Ok(None) };
    let made = tokio::task::spawn_blocking(move || make_variant(&bytes, tier)).await.ok().flatten();
    let Some(v) = made else { return Ok(None) };
    sqlx::query("insert into chat_file_variants (sha256, w, mime, width, height, natural_width, natural_height, alpha, bytes) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict do nothing")
        .bind(&m.sha256)
        .bind(tier as i32)
        .bind(v.mime)
        .bind(v.width as i32)
        .bind(v.height as i32)
        .bind(v.natural.0 as i32)
        .bind(v.natural.1 as i32)
        .bind(v.alpha)
        .bind(&v.bytes)
        .execute(&st.db)
        .await?;
    Ok(Some(v))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(w: u32, h: u32, alpha: bool) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        if alpha {
            image::RgbaImage::from_pixel(w, h, image::Rgba([10, 120, 200, 128])).write_to(&mut out, image::ImageFormat::Png).unwrap();
        } else {
            image::RgbImage::from_pixel(w, h, image::Rgb([10, 120, 200])).write_to(&mut out, image::ImageFormat::Png).unwrap();
        }
        out.into_inner()
    }

    #[test]
    fn a_type_a_browser_would_run_is_stored_as_opaque_bytes() {
        assert_eq!(stored_mime("image/png"), "image/png");
        assert_eq!(stored_mime("Image/GIF; charset=binary"), "image/gif");
        assert_eq!(stored_mime("video/mp4"), "video/mp4");
        assert_eq!(stored_mime("application/pdf"), "application/pdf");
        assert_eq!(stored_mime("application/vnd.openxmlformats-officedocument.wordprocessingml.document"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
        for active in ["text/html", "image/svg+xml", "application/xhtml+xml", "text/javascript", "application/javascript", "text/css", "text/xml", "multipart/related", "application/x-shockwave-flash"] {
            assert_eq!(stored_mime(active), OCTET, "{active}");
            assert!(!is_inline(active), "{active}");
        }
        assert_eq!(stored_mime(""), OCTET);
        assert_eq!(stored_mime("nonsense"), OCTET);
        assert_eq!(stored_mime("application/x-something-unknown"), OCTET);
        assert!(is_inline("image/gif") && is_inline("video/mp4") && is_inline("application/pdf"));
        assert!(!is_inline("application/zip") && !is_inline("text/markdown") && !is_inline(OCTET));
    }

    #[test]
    fn a_pictures_size_is_read_and_widths_snap_to_tiers() {
        assert_eq!(probe(&png(300, 120, false)), Some((300, 120)));
        assert_eq!(probe(b"not a picture at all"), None);
        assert_eq!(snap_width(Some("1")), Some(64));
        assert_eq!(snap_width(Some("65")), Some(256));
        assert_eq!(snap_width(Some("512")), Some(512));
        assert_eq!(snap_width(Some("99999")), Some(2048));
        assert_eq!(snap_width(Some("0")), None);
        assert_eq!(snap_width(Some("-4")), None);
        assert_eq!(snap_width(Some("wide")), None);
        assert_eq!(snap_width(None), None);
    }

    #[test]
    fn a_tier_is_made_only_of_a_wider_picture_and_never_of_an_enormous_one() {
        let v = make_variant(&png(300, 120, false), 64).expect("scaled");
        assert_eq!((v.width, v.height, v.natural, v.alpha, v.mime), (64, 26, (300, 120), false, "image/jpeg"));
        assert_eq!(probe(&v.bytes), Some((64, 26)));
        let a = make_variant(&png(300, 120, true), 256).expect("scaled, alpha kept");
        assert_eq!((a.width, a.height, a.alpha, a.mime), (256, 102, true, "image/png"));
        assert!(make_variant(&png(60, 60, false), 64).is_none(), "no wider than the tier: the original is served");
        assert!(make_variant(b"junk", 64).is_none());
        // 64 megapixels and 16384 a side are the limits, checked from the header before any decode
        assert!(safe_dimensions(8000, 8000));
        assert!(!safe_dimensions(8001, 8000));
        assert!(!safe_dimensions(16_385, 10));
        assert!(!safe_dimensions(0, 10));
        // a PNG whose header claims 20000 × 20000 (a bomb): refused without decoding
        let mut bomb = png(4, 4, false);
        bomb[16..20].copy_from_slice(&20_000u32.to_be_bytes());
        bomb[20..24].copy_from_slice(&20_000u32.to_be_bytes());
        assert!(make_variant(&bomb, 64).is_none());
    }

    #[test]
    fn ranges_are_read_as_a_player_sends_them() {
        assert_eq!(byte_range("bytes=0-99", 1000), Some(Ok((0, 99))));
        assert_eq!(byte_range("bytes=900-", 1000), Some(Ok((900, 999))));
        assert_eq!(byte_range("bytes=-100", 1000), Some(Ok((900, 999))));
        assert_eq!(byte_range("bytes=0-5000", 1000), Some(Ok((0, 999))));
        assert_eq!(byte_range("bytes=1000-", 1000), Some(Err(())));
        assert_eq!(byte_range("bytes=5-2", 1000), Some(Err(())));
        assert_eq!(byte_range("lines=1-2", 1000), None);
        assert_eq!(byte_range("bytes=0-1,5-6", 1000), None);
    }

    #[test]
    fn a_name_is_safe_in_a_header() {
        assert_eq!(percent("kiln plan (v2).pdf"), "kiln%20plan%20%28v2%29.pdf");
        assert_eq!(percent("a\"b\r\nc"), "a%22b%0D%0Ac");
        assert_eq!(percent("café.png"), "caf%C3%A9.png");
    }
}
