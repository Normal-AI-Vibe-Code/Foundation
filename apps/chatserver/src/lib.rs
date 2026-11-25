//! ChatForm's server in Rust (2026-11-21, Josh: "Host it on vercel for now. build a rust based server there").
//!
//! The same ChatForm the Foundation app draws, served from Vercel until it moves to HyperForm: accounts (the company's
//! own Google client, an allowlist of work domains), channels, direct messages, messages and threads, reactions,
//! read marks, search, and the live socket. Its routes and JSON are the Node server's (`apps/server/src/chat.ts`,
//! `packages/protocol/src/chat.ts`), so the ChatForm client talks to either. Grids, agents, huddles, bridges and the
//! Slack import stay on Foundation's own server.
//!
//! - **Storage**: Postgres (`DATABASE_URL`; Neon on Vercel). A function's disk doesn't last.
//! - **Live**: a socket at `/chat` (Vercel's WebSockets). A socket lives on one instance and closes at the function's
//!   time limit; the client reconnects and catches up. What one instance writes reaches every instance's sockets
//!   through Postgres `LISTEN/NOTIFY` (`hub.rs`; `DATABASE_URL_UNPOOLED` for the listener, which a pooler can't hold).
//! - **Invariants** (as Foundation's): session tokens are stored hashed and never travel in URLs (a socket from another
//!   origin takes a one-time 30-second ticket); who wrote a message is the session's to say; a DM or private channel
//!   reaches only its members, admins included; writes carry `request_id`; removing a message needs `confirm` and
//!   keeps the row; a page elsewhere can't use the cookie (Origin checked on writes and sockets).
//! - **Files** live in Postgres too (`files.rs`, 4 MB each): a file reaches its uploader and the readers of a message
//!   that carries it, and is archived, never deleted. **Link previews** (`preview.rs`) never fetch a private,
//!   loopback or link-local address. **Who is where** (`whereabouts.rs`) is what each window says of itself, named by
//!   its account. **The sign-in exchange** (`exchange.rs`) takes a Google ID token made for a trusted client.
//! - **An app signs in like a device** (`app_signin.rs`): Google in the system browser, a code shown on both screens,
//!   and a person's press on this server's own page before the app's poll gets a bearer, once.

pub mod app_signin;
pub mod auth;
pub mod chat;
pub mod config;
pub mod db;
pub mod error;
pub mod exchange;
pub mod files;
pub mod hub;
pub mod preview;
pub mod util;
pub mod whereabouts;
pub mod ws;

use std::sync::Arc;

use axum::{
    Router, middleware,
    routing::{get, post},
};
pub use config::Config;
use tower_http::cors::{AllowHeaders, AllowMethods, AllowOrigin, CorsLayer};

pub struct AppState {
    pub cfg: Config,
    pub db: sqlx::PgPool,
    pub hub: hub::Hub,
    pub http: reqwest::Client,
    /// Google's signing keys, as last read (exchange.rs)
    pub jwks: tokio::sync::Mutex<exchange::Keys>,
    pub exchange_limit: std::sync::Mutex<exchange::Limiter>,
    /// pictures being scaled at once (files.rs): two, so a burst of thumbnails can't take the instance's memory
    pub decodes: tokio::sync::Semaphore,
}
pub type St = Arc<AppState>;

/// connect to Postgres, bring the tables up to date, and start listening for other instances' events
pub async fn state(cfg: Config) -> Result<St, error::Error> {
    let db = db::connect(&cfg.database_url).await?;
    db::migrate(&db).await?;
    let st = state_with(cfg, db)?;
    hub::start_listener(st.clone());
    whereabouts::start_heartbeat(st.clone());
    Ok(st)
}

/// the state around a pool as it is: nothing migrated, nothing listening (`state` does those; a test that needs no
/// database hands in a pool that hasn't connected)
pub fn state_with(cfg: Config, db: sqlx::PgPool) -> Result<St, error::Error> {
    Ok(Arc::new(AppState {
        http: reqwest::Client::builder().timeout(std::time::Duration::from_secs(15)).build().map_err(|e| error::Error::Other(e.to_string()))?,
        hub: hub::Hub::default(),
        jwks: Default::default(),
        exchange_limit: Default::default(),
        decodes: tokio::sync::Semaphore::new(2),
        db,
        cfg,
    }))
}

pub fn app(st: St) -> Router {
    let origins: Vec<axum::http::HeaderValue> = st.cfg.allowed_origins().iter().filter_map(|o| o.parse().ok()).collect();
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_credentials(true)
        .allow_methods(AllowMethods::mirror_request())
        .allow_headers(AllowHeaders::mirror_request())
        // a page on another origin (the Foundation app's window) reads a picture's level and size from these
        .expose_headers(["etag", "content-range", "accept-ranges", "content-disposition", "x-image-level", "x-image-natural-width", "x-image-natural-height", "x-image-width", "x-image-height", "x-image-alpha"].map(axum::http::HeaderName::from_static));
    Router::new()
        .route("/", get(chat::home))
        .route("/api/health", get(chat::health))
        .route("/auth/config", get(auth::config_route))
        .route("/auth/google/start", get(auth::google_start))
        .route("/auth/google/callback", get(auth::google_callback))
        .route("/auth/app/begin", post(app_signin::begin))
        .route("/auth/app/poll", post(app_signin::poll))
        .route("/auth/app/confirm/{answer}", post(app_signin::confirm))
        .route("/auth/exchange", post(exchange::exchange))
        .route("/auth/dev", post(auth::dev_login))
        .route("/auth/logout", post(auth::logout))
        .route("/api/me", get(auth::me))
        .route("/api/ws-ticket", post(auth::ws_ticket))
        .route("/api/chat", get(chat::list))
        .route("/api/chat/channels", post(chat::create_channel))
        .route("/api/chat/channels/{id}", get(chat::get_channel))
        .route("/api/chat/channels/{id}/join", post(chat::join))
        .route("/api/chat/channels/{id}/leave", post(chat::leave))
        .route("/api/chat/channels/{id}/messages", get(chat::page).post(chat::post_message))
        .route("/api/chat/channels/{id}/read", post(chat::read))
        .route("/api/chat/messages/{id}", post(chat::edit_message).delete(chat::remove_message))
        .route("/api/chat/messages/{id}/react", post(chat::react))
        .route("/api/chat/messages/{id}/pin", post(chat::pin))
        .route("/api/chat/search", get(chat::search))
        .route("/api/chat/mentions", get(chat::mentions))
        // the upload reads its own body, to its own limit (4 MB), so the 2 MB default isn't what refuses it
        .route("/api/files", post(files::upload).layer(axum::extract::DefaultBodyLimit::disable()))
        .route("/files/{id}", get(files::serve))
        .route("/api/whereabouts", get(whereabouts::route))
        .route("/chat", get(ws::upgrade))
        .layer(middleware::from_fn_with_state(st.clone(), auth::cookie_origin_guard))
        .layer(cors)
        .with_state(st)
}
