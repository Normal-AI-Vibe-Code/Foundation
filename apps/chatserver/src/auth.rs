//! Accounts: who a request is, and how a person signs in.
//!
//! - **Google**, with the company's own OAuth client (GOOGLE_CLIENT_ID/SECRET), returning to
//!   `<public url>/auth/google/callback`. The address Google verified must be on CHATFORM_ALLOWLIST; someone new
//!   arrives as a member, the CHATFORM_ADMIN_EMAILS as admins. The sign-in's state is bound to the browser (a cookie)
//!   and to this server (its hash, kept ten minutes, used once).
//! - **Dev login** (email alone) only off Vercel, with CHATFORM_DEV_LOGIN=1, from this computer: local runs and tests.
//! - **A session** is a random token: the browser holds it in an HttpOnly cookie, an app as a bearer it keeps itself.
//!   The server keeps only its SHA-256. It never travels in a URL: a socket opened from another origin takes a
//!   one-time ticket (30 s, hashed, for one path).
//! - **The cookie only from this server's pages**: a write or a socket signed in by the cookie must come from an
//!   allowed origin (Origin, or Sec-Fetch-Site same-origin when there's none). A bearer is never sent by a browser on
//!   its own, so a bearer request needs no Origin.

use std::net::SocketAddr;

use axum::{
    Json,
    extract::{ConnectInfo, Query, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Redirect, Response},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    St,
    error::{Error, Result, bad, forbidden, http},
    util::{color_for, hash_token, new_id, now_ms, random_token},
};

pub const COOKIE: &str = "chatform_session";
/// what of ChatForm this server has; a client leaves the rest out (files, pins, huddles, agents… stay on Foundation's own)
pub const FEATURES: [&str; 5] = ["channels", "direct", "threads", "reactions", "search"];
const STATE_COOKIE: &str = "chatform_oauth";
const SESSION_DAYS: i64 = 30;
const TICKET_MS: i64 = 30_000;

#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
pub struct User {
    pub id: String,
    pub email: String,
    pub name: String,
    pub color: String,
    pub role: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthKind {
    Bearer,
    Cookie,
}

pub fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    for h in headers.get_all(header::COOKIE) {
        let Ok(s) = h.to_str() else { continue };
        for part in s.split(';') {
            let mut kv = part.trim().splitn(2, '=');
            if kv.next() == Some(name)
                && let Some(v) = kv.next()
                    && !v.is_empty() {
                        return Some(v.to_string());
                    }
        }
    }
    None
}

pub fn bearer(headers: &HeaderMap) -> Option<String> {
    let v = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let t = v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer "))?.trim();
    (!t.is_empty()).then(|| t.to_string())
}

pub async fn user_by_token(st: &St, token: &str) -> Result<Option<User>> {
    Ok(sqlx::query_as::<_, User>("select u.id, u.email, u.name, u.color, u.role from sessions s join users u on u.id = s.user_id where s.token_hash = $1 and s.expires_at > $2")
        .bind(hash_token(token))
        .bind(now_ms())
        .fetch_optional(&st.db)
        .await?)
}

pub async fn user_from(st: &St, headers: &HeaderMap) -> Result<Option<(User, AuthKind)>> {
    if let Some(t) = bearer(headers) {
        return Ok(user_by_token(st, &t).await?.map(|u| (u, AuthKind::Bearer)));
    }
    if let Some(t) = cookie_value(headers, COOKIE) {
        return Ok(user_by_token(st, &t).await?.map(|u| (u, AuthKind::Cookie)));
    }
    Ok(None)
}

pub async fn require_user(st: &St, headers: &HeaderMap) -> Result<User> {
    match user_from(st, headers).await? {
        Some((u, _)) => Ok(u),
        None => Err(http(StatusCode::UNAUTHORIZED, "Sign in first.")),
    }
}

/// does this request say it comes from one of the pages allowed to use the cookie
pub fn origin_allowed(st: &St, headers: &HeaderMap) -> bool {
    match headers.get(header::ORIGIN).and_then(|o| o.to_str().ok()) {
        Some(o) => st.cfg.allowed_origins().iter().any(|a| a == o),
        None => matches!(headers.get("sec-fetch-site").and_then(|v| v.to_str().ok()), Some("same-origin") | Some("none")),
    }
}

/// a write or a socket signed in by the cookie must come from an allowed page (cross-site forgery, socket hijacking)
pub async fn cookie_origin_guard(State(st): State<St>, req: Request, next: Next) -> Response {
    let safe = matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS);
    let upgrade = req.headers().get(header::UPGRADE).is_some();
    let by_cookie = bearer(req.headers()).is_none() && cookie_value(req.headers(), COOKIE).is_some();
    // the press on the app sign-in's page checks where it came from itself (its Origin is "null": app_signin::confirm)
    let own_check = req.uri().path().starts_with("/auth/app/confirm/");
    if (!safe || upgrade) && by_cookie && !own_check && !origin_allowed(&st, req.headers()) {
        return forbidden("A page elsewhere can't use your ChatForm sign-in. Open ChatForm itself.").into_response();
    }
    next.run(req).await
}

fn session_cookie(st: &St, token: &str, max_age: i64) -> HeaderValue {
    let secure = if st.cfg.secure_cookie() { "; Secure" } else { "" };
    HeaderValue::from_str(&format!("{COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{secure}")).expect("cookie")
}

pub async fn create_session(st: &St, user_id: &str, kind: &str) -> Result<String> {
    let token = random_token();
    let now = now_ms();
    sqlx::query("insert into sessions (token_hash, user_id, kind, created_at, expires_at) values ($1, $2, $3, $4, $5)")
        .bind(hash_token(&token))
        .bind(user_id)
        .bind(kind)
        .bind(now)
        .bind(now + SESSION_DAYS * 86_400_000)
        .execute(&st.db)
        .await?;
    Ok(token)
}

/// the person with this verified address, made on first sign-in (a member, or an admin if listed)
pub async fn upsert_user(st: &St, email: &str, name: &str) -> Result<User> {
    let email = email.trim().to_lowercase();
    let name = if name.trim().is_empty() { email.split('@').next().unwrap_or("someone").to_string() } else { name.trim().chars().take(80).collect() };
    let role = if st.cfg.is_admin_email(&email) { "admin" } else { "member" };
    let u = sqlx::query_as::<_, User>(
        "insert into users (id, email, name, color, role, created_at) values ($1, $2, $3, $4, $5, $6)
         on conflict (email) do update set name = excluded.name, role = case when excluded.role = 'admin' then 'admin' else users.role end
         returning id, email, name, color, role",
    )
    .bind(new_id("u"))
    .bind(&email)
    .bind(&name)
    .bind(color_for(&email))
    .bind(role)
    .bind(now_ms())
    .fetch_one(&st.db)
    .await?;
    Ok(u)
}

pub async fn config_route(State(st): State<St>) -> Json<Value> {
    Json(json!({
        "google": st.cfg.google_ready(),
        "devLogin": st.cfg.dev_login,
        "provider": "google",
        "hosted": st.cfg.on_vercel,
        // an app can sign in here (app_signin.rs), and what of ChatForm this server has
        "app": st.cfg.google_ready(),
        "features": FEATURES,
        "server": "chatform-rust",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

pub async fn google_start(State(st): State<St>) -> Result<Response> {
    let Some(client_id) = st.cfg.google_client_id.clone().filter(|_| st.cfg.google_ready()) else {
        return Err(http(StatusCode::SERVICE_UNAVAILABLE, "Google sign-in isn't set up on this server yet (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)."));
    };
    let state = random_token();
    let now = now_ms();
    sqlx::query("delete from oauth_states where expires_at <= $1").bind(now).execute(&st.db).await?;
    sqlx::query("insert into oauth_states (state_hash, created_at, expires_at) values ($1, $2, $3)").bind(hash_token(&state)).bind(now).bind(now + 600_000).execute(&st.db).await?;
    let u = google_url(&st, &client_id, &state)?;
    let secure = if st.cfg.secure_cookie() { "; Secure" } else { "" };
    let mut res = Redirect::to(u.as_str()).into_response();
    res.headers_mut().append(header::SET_COOKIE, HeaderValue::from_str(&format!("{STATE_COOKIE}={state}; Path=/auth/google; HttpOnly; SameSite=Lax; Max-Age=600{secure}")).expect("cookie"));
    Ok(res)
}

/// Google's sign-in page for this state; it comes back to `<public url>/auth/google/callback`
pub fn google_url(st: &St, client_id: &str, state: &str) -> Result<url::Url> {
    let mut u = url::Url::parse(&st.cfg.google_auth_url).map_err(|e| Error::Other(format!("google url: {e}")))?;
    u.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", &format!("{}/auth/google/callback", st.cfg.public_url))
        .append_pair("response_type", "code")
        .append_pair("scope", "openid email profile")
        .append_pair("state", state)
        .append_pair("prompt", "select_account");
    Ok(u)
}

#[derive(Deserialize)]
pub struct Callback {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

/// these pages may hold a press: never framed, no script, forms only to this server
pub fn page_headers(res: &mut Response) {
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"));
    h.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
}

/// a plain page for a sign-in that ended in the browser (its words are escaped here)
pub fn page_with(status: StatusCode, title: &str, body: &str) -> Response {
    let (title, body) = (html_escape(title), html_escape(body));
    let html = format!(
        "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>{title}</title><body style=\"font:15px/1.5 system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#222\"><h1 style=\"font-size:20px\">{title}</h1><p>{body}</p></body>"
    );
    let mut res = (status, html).into_response();
    page_headers(&mut res);
    res
}

fn page(title: &str, body: &str) -> Response {
    page_with(StatusCode::FORBIDDEN, title, body)
}

/// Who Google says this code is: the person (a verified address on the allowlist, made here on first sign-in), or
/// the page to show instead (its title and words).
pub async fn google_person(st: &St, code: &str) -> Result<std::result::Result<User, (&'static str, String)>> {
    let (Some(id), Some(secret)) = (st.cfg.google_client_id.clone(), st.cfg.google_client_secret.clone()) else {
        return Err(http(StatusCode::SERVICE_UNAVAILABLE, "Google sign-in isn't set up on this server yet."));
    };
    let redirect = format!("{}/auth/google/callback", st.cfg.public_url);
    let tok: Value = st
        .http
        .post(&st.cfg.google_token_url)
        .form(&[("code", code), ("client_id", id.as_str()), ("client_secret", secret.as_str()), ("redirect_uri", redirect.as_str()), ("grant_type", "authorization_code")])
        .send()
        .await
        .map_err(|e| Error::Other(format!("google token: {e}")))?
        .json()
        .await
        .map_err(|e| Error::Other(format!("google token: {e}")))?;
    let Some(access) = tok.get("access_token").and_then(|v| v.as_str()) else {
        return Ok(Err(("Not signed in", "Google didn't accept this sign-in. Start again from ChatForm.".into())));
    };
    let info: Value = st
        .http
        .get(&st.cfg.google_userinfo_url)
        .bearer_auth(access)
        .send()
        .await
        .map_err(|e| Error::Other(format!("google userinfo: {e}")))?
        .json()
        .await
        .map_err(|e| Error::Other(format!("google userinfo: {e}")))?;
    let email = info.get("email").and_then(|v| v.as_str()).unwrap_or("");
    let verified = info.get("email_verified").and_then(|v| v.as_bool()).unwrap_or(false);
    if email.is_empty() || !verified {
        return Ok(Err(("Not signed in", "Google didn't give a verified address for this account.".into())));
    }
    if !st.cfg.allowed(email) {
        return Ok(Err(("Not on this ChatForm", format!("{email} isn't on this server's list of who may sign in. Ask an admin."))));
    }
    Ok(Ok(upsert_user(st, email, info.get("name").and_then(|v| v.as_str()).unwrap_or("")).await?))
}

pub async fn google_callback(State(st): State<St>, headers: HeaderMap, Query(q): Query<Callback>) -> Result<Response> {
    // an app began this one and is polling (app_signin.rs): it ends on a page that asks for a press, not in a cookie
    if let Some(state) = q.state.as_deref()
        && crate::app_signin::is_attempt(&st, state).await? {
            return crate::app_signin::google_done(&st, state, q.code.as_deref(), q.error.as_deref()).await;
        }
    if let Some(e) = q.error {
        return Ok(page("Not signed in", &format!("Google said: {e}.")));
    }
    let (Some(code), Some(state)) = (q.code, q.state) else { return Err(bad("This sign-in is missing its code.")) };
    // the state must be this browser's and this server's, and used once
    if cookie_value(&headers, STATE_COOKIE).as_deref() != Some(state.as_str()) {
        return Ok(page("Not signed in", "This sign-in was started in another browser, or it expired. Start again from ChatForm."));
    }
    let used = sqlx::query("delete from oauth_states where state_hash = $1 and expires_at > $2").bind(hash_token(&state)).bind(now_ms()).execute(&st.db).await?;
    if used.rows_affected() != 1 {
        return Ok(page("Not signed in", "This sign-in expired or was already used. Start again from ChatForm."));
    }
    let user = match google_person(&st, &code).await? {
        Ok(u) => u,
        Err((title, words)) => return Ok(page(title, &words)),
    };
    let token = create_session(&st, &user.id, "browser").await?;
    let mut res = Redirect::to("/").into_response();
    res.headers_mut().append(header::SET_COOKIE, session_cookie(&st, &token, SESSION_DAYS * 86_400));
    res.headers_mut().append(header::SET_COOKIE, HeaderValue::from_static("chatform_oauth=; Path=/auth/google; Max-Age=0"));
    Ok(res)
}

pub fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

#[derive(Deserialize)]
struct DevLogin {
    email: Option<String>,
    name: Option<String>,
    bearer: Option<bool>,
}

/// email alone, for local runs and tests: off unless CHATFORM_DEV_LOGIN=1, never on Vercel, only from this computer
pub async fn dev_login(State(st): State<St>, req: Request) -> Result<Response> {
    if !st.cfg.dev_login {
        return Err(forbidden("Dev login is off on this server."));
    }
    let loopback = req.extensions().get::<ConnectInfo<SocketAddr>>().map(|c| c.0.ip().is_loopback()).unwrap_or(false);
    if !loopback {
        return Err(forbidden("Dev login answers only this computer."));
    }
    let bytes = axum::body::to_bytes(req.into_body(), 64 * 1024).await.map_err(|_| bad("too big"))?;
    let body: DevLogin = serde_json::from_slice(&bytes).map_err(|_| bad("expected JSON"))?;
    let email = body.email.unwrap_or_default();
    if !email.contains('@') {
        return Err(bad("enter an email"));
    }
    if !st.cfg.allowed(&email) {
        return Err(forbidden(format!("{email} is not on this server's allowlist")));
    }
    let user = upsert_user(&st, &email, body.name.as_deref().unwrap_or("")).await?;
    if body.bearer == Some(true) {
        let token = create_session(&st, &user.id, "app").await?;
        return Ok(Json(json!({ "user": user, "session": token })).into_response());
    }
    let token = create_session(&st, &user.id, "browser").await?;
    let mut res = Json(json!({ "user": user })).into_response();
    res.headers_mut().append(header::SET_COOKIE, session_cookie(&st, &token, SESSION_DAYS * 86_400));
    Ok(res)
}

pub async fn logout(State(st): State<St>, headers: HeaderMap) -> Result<Response> {
    if let Some(t) = bearer(&headers).or_else(|| cookie_value(&headers, COOKIE)) {
        sqlx::query("delete from sessions where token_hash = $1").bind(hash_token(&t)).execute(&st.db).await?;
    }
    let mut res = Json(json!({ "ok": true })).into_response();
    res.headers_mut().append(header::SET_COOKIE, session_cookie(&st, "", 0));
    Ok(res)
}

pub async fn me(State(st): State<St>, headers: HeaderMap) -> Result<Json<Value>> {
    let u = require_user(&st, &headers).await?;
    Ok(Json(json!({ "user": u })))
}

#[derive(Deserialize)]
pub struct TicketAsk {
    path: Option<String>,
}

/// a one-time pass for a socket opened from another origin (a bearer can't ride a browser's socket)
pub async fn ws_ticket(State(st): State<St>, headers: HeaderMap, Json(ask): Json<TicketAsk>) -> Result<Json<Value>> {
    let u = require_user(&st, &headers).await?;
    let path = ask.path.unwrap_or_default();
    if path != "/chat" {
        return Err(bad("path: the socket's path (/chat)"));
    }
    let ticket = random_token();
    let now = now_ms();
    sqlx::query("delete from ws_tickets where expires_at <= $1").bind(now).execute(&st.db).await?;
    sqlx::query("insert into ws_tickets (ticket_hash, user_id, path, expires_at) values ($1, $2, $3, $4)").bind(hash_token(&ticket)).bind(&u.id).bind(&path).bind(now + TICKET_MS).execute(&st.db).await?;
    Ok(Json(json!({ "ticket": ticket, "expiresIn": TICKET_MS / 1000 })))
}

/// spend a ticket for `path`: who it was for, once, within its 30 seconds
pub async fn spend_ticket(st: &St, ticket: &str, path: &str) -> Result<Option<User>> {
    let row: Option<(String,)> = sqlx::query_as("delete from ws_tickets where ticket_hash = $1 and path = $2 and expires_at > $3 returning user_id").bind(hash_token(ticket)).bind(path).bind(now_ms()).fetch_optional(&st.db).await?;
    let Some((id,)) = row else { return Ok(None) };
    Ok(sqlx::query_as::<_, User>("select id, email, name, color, role from users where id = $1").bind(id).fetch_optional(&st.db).await?)
}

