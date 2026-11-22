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

pub mod auth;
pub mod chat;
pub mod config;
pub mod db;
pub mod error;
pub mod hub;
pub mod util;
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
}
pub type St = Arc<AppState>;

/// connect to Postgres, bring the tables up to date, and start listening for other instances' events
pub async fn state(cfg: Config) -> Result<St, error::Error> {
    let db = db::connect(&cfg.database_url).await?;
    db::migrate(&db).await?;
    let st = Arc::new(AppState { http: reqwest::Client::builder().timeout(std::time::Duration::from_secs(15)).build().map_err(|e| error::Error::Other(e.to_string()))?, hub: hub::Hub::default(), db, cfg });
    hub::start_listener(st.clone());
    Ok(st)
}

pub fn app(st: St) -> Router {
    let origins: Vec<axum::http::HeaderValue> = st.cfg.allowed_origins().iter().filter_map(|o| o.parse().ok()).collect();
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_credentials(true)
        .allow_methods(AllowMethods::mirror_request())
        .allow_headers(AllowHeaders::mirror_request());
    Router::new()
        .route("/", get(chat::home))
        .route("/api/health", get(chat::health))
        .route("/auth/config", get(auth::config_route))
        .route("/auth/google/start", get(auth::google_start))
        .route("/auth/google/callback", get(auth::google_callback))
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
        .route("/api/chat/search", get(chat::search))
        .route("/api/whereabouts", get(chat::whereabouts))
        .route("/chat", get(ws::upgrade))
        .layer(middleware::from_fn_with_state(st.clone(), auth::cookie_origin_guard))
        .layer(cors)
        .with_state(st)
}
