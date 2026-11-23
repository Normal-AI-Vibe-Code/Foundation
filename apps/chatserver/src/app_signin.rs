//! An app signs in (the Foundation app pointing ChatForm at this server), as Foundation's own desktop sign-in does
//! (`apps/server/src/flowform.ts`): like a device.
//!
//! 1. `POST /auth/app/begin`: the app gets Google's address to open in the system browser, a **poll** secret only it
//!    holds, and a short **code** it shows on its own screen. Nobody is signed in by beginning.
//! 2. Google comes back to `/auth/google/callback` with the attempt's state. The person is checked as any sign-in is
//!    (a verified address on the allowlist), and the browser lands on this server's own page: an app is asking to
//!    sign in as this person, here is its code, **This is me** or **Not me**. The page has no script, is never
//!    framed, and the browser holds a cookie for the press.
//! 3. `POST /auth/app/confirm/yes|no`: the press, only from that page in that browser, once.
//! 4. `POST /auth/app/poll` (the poll secret as `Authorization: Bearer`): `pending` until the press; after **This is
//!    me**, the person and a session for the app to keep as its bearer, once. **Not me**, a refusal or five minutes
//!    end it with nothing.
//!
//! Only hashes are stored (the state, the poll secret, the press cookie); the session never travels in a URL.

use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use rand::Rng;
use serde_json::{Value, json};

use crate::{
    St,
    auth::{User, bearer, cookie_value, create_session, google_person, google_url, html_escape, page_headers, page_with},
    error::{Result, http, not_found},
    util::{hash_token, now_ms, random_token},
};

/// an app sign-in, Google and the press included, is over in five minutes
pub const TTL_MS: i64 = 5 * 60_000;
const CONFIRM_COOKIE: &str = "chatform_app_confirm";
/// no 0/O, 1/I/L, 5/S or 2/Z to mix up when a code is read off one screen and checked on another
const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRTUVWXY346789";
/// attempts in flight at once; beginning is open to anyone who can reach the server, so it is bounded
const MAX_OPEN: i64 = 500;

/// eight characters from an alphabet with nothing to mix up, shown as ABCD-EFGH
pub fn sign_in_code() -> String {
    let mut rng = rand::thread_rng();
    let c: String = (0..8).map(|_| CODE_ALPHABET[rng.gen_range(0..CODE_ALPHABET.len())] as char).collect();
    format!("{}-{}", &c[..4], &c[4..])
}

async fn sweep(st: &St) -> Result<()> {
    sqlx::query("delete from app_signins where expires_at <= $1").bind(now_ms()).execute(&st.db).await?;
    Ok(())
}

pub async fn begin(State(st): State<St>) -> Result<Json<Value>> {
    let Some(client_id) = st.cfg.google_client_id.clone().filter(|_| st.cfg.google_ready()) else {
        return Err(http(StatusCode::SERVICE_UNAVAILABLE, "Google sign-in isn't set up on this server yet (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)."));
    };
    sweep(&st).await?;
    let (open,): (i64,) = sqlx::query_as("select count(*) from app_signins").fetch_one(&st.db).await?;
    if open >= MAX_OPEN {
        return Err(http(StatusCode::TOO_MANY_REQUESTS, "Too many sign-ins are waiting on this server. Try again in a few minutes."));
    }
    let state = random_token();
    let poll = random_token();
    let code = sign_in_code();
    let now = now_ms();
    sqlx::query("insert into app_signins (state_hash, poll_hash, code, created_at, expires_at) values ($1, $2, $3, $4, $5)")
        .bind(hash_token(&state))
        .bind(hash_token(&poll))
        .bind(&code)
        .bind(now)
        .bind(now + TTL_MS)
        .execute(&st.db)
        .await?;
    let url = google_url(&st, &client_id, &state)?;
    Ok(Json(json!({ "url": url.as_str(), "poll": poll, "code": code, "expiresIn": TTL_MS / 1000 })))
}

/// is this Google state an app's attempt (spent or not, expired or not): then the app's path answers it
pub async fn is_attempt(st: &St, state: &str) -> Result<bool> {
    let row: Option<(i32,)> = sqlx::query_as("select 1 from app_signins where state_hash = $1").bind(hash_token(state)).fetch_optional(&st.db).await?;
    Ok(row.is_some())
}

async fn finish(st: &St, state_hash: &str, user: Option<&str>, error: Option<&str>) -> Result<()> {
    sqlx::query("update app_signins set result_user_id = $2, result_error = $3 where state_hash = $1").bind(state_hash).bind(user).bind(error).execute(&st.db).await?;
    Ok(())
}

/// Google came back for an app's attempt: check the person, then show the code and ask for the press
pub async fn google_done(st: &St, state: &str, code: Option<&str>, error: Option<&str>) -> Result<Response> {
    let state_hash = hash_token(state);
    let now = now_ms();
    // Google comes back once: a second arrival with the same state is a replay
    let row: Option<(String,)> = sqlx::query_as("update app_signins set used_at = $2 where state_hash = $1 and used_at is null and expires_at > $2 returning code").bind(&state_hash).bind(now).fetch_optional(&st.db).await?;
    let Some((shown,)) = row else {
        return Ok(page_with(StatusCode::BAD_REQUEST, "Sign-in expired", "That sign-in took too long or was already used. Go back to the app and try again."));
    };
    if let Some(e) = error {
        let words = if e == "access_denied" { "The sign-in was cancelled at Google." } else { "Google didn't finish the sign-in." };
        finish(st, &state_hash, None, Some(words)).await?;
        return Ok(page_with(StatusCode::BAD_REQUEST, "Sign-in didn't finish", words));
    }
    let person = match google_person(st, code.unwrap_or("")).await {
        Ok(p) => p,
        Err(e) => {
            finish(st, &state_hash, None, Some("Something went wrong finishing the sign-in. Try again.")).await?;
            return Err(e);
        }
    };
    let user = match person {
        Ok(u) => u,
        Err((title, words)) => {
            finish(st, &state_hash, None, Some(&words)).await?;
            return Ok(page_with(StatusCode::FORBIDDEN, title, &words));
        }
    };
    // nothing reaches the app yet: the person says it is them, on this page, first
    let press = random_token();
    sqlx::query("update app_signins set result_user_id = $2, confirm_hash = $3 where state_hash = $1").bind(&state_hash).bind(&user.id).bind(hash_token(&press)).execute(&st.db).await?;
    let mut res = confirm_page(&user, &shown);
    let secure = if st.cfg.secure_cookie() { "; Secure" } else { "" };
    res.headers_mut().append(header::SET_COOKIE, HeaderValue::from_str(&format!("{CONFIRM_COOKIE}={press}; Path=/auth/app; HttpOnly; SameSite=Strict; Max-Age={}{secure}", TTL_MS / 1000)).expect("cookie"));
    Ok(res)
}

fn confirm_page(user: &User, code: &str) -> Response {
    let html = format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Sign in an app? · ChatForm</title>
<style>body{{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f3ec;color:#201e19;font:15px/1.5 "Hanken Grotesk",system-ui,sans-serif}}
@media (prefers-color-scheme:dark){{body{{background:#0a111f;color:#e6ecf7}}}}main{{max-width:460px;padding:32px}}
h1{{font-size:28px;letter-spacing:-.02em;margin:0 0 8px}}p{{margin:0 0 12px}}.code{{font:600 32px/1.2 ui-monospace,Consolas,monospace;letter-spacing:.12em;margin:16px 0}}
form{{display:inline}}button{{font:inherit;padding:10px 18px;border-radius:999px;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer;margin:8px 8px 0 0}}
button.yes{{background:#201e19;color:#f6f3ec}}@media (prefers-color-scheme:dark){{button.yes{{background:#e6ecf7;color:#0a111f}}}}</style></head>
<body><main><h1>Sign in an app?</h1>
<p>An app on a computer is asking to sign in to ChatForm as <strong>{name}</strong> ({email}).</p>
<p>That app shows a code on its own screen. This is the code:</p>
<div class="code">{code}</div>
<p>Press <em>This is me</em> only if you started this sign-in and the app in front of you shows this same code. If someone sent you this link, press <em>Not me</em>.</p>
<form method="post" action="/auth/app/confirm/yes"><button class="yes" type="submit">This is me, sign that app in</button></form>
<form method="post" action="/auth/app/confirm/no"><button type="submit">Not me</button></form>
</main></body></html>"#,
        name = html_escape(&user.name),
        email = html_escape(&user.email),
        code = html_escape(code),
    );
    let mut res = (StatusCode::OK, html).into_response();
    page_headers(&mut res);
    res
}

/// did this press come from this server's own page
fn own_page(st: &St, headers: &HeaderMap) -> bool {
    let own = url::Url::parse(&st.cfg.public_url).map(|u| u.origin().ascii_serialization()).unwrap_or_default();
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok());
    let site = headers.get("sec-fetch-site").and_then(|v| v.to_str().ok());
    // The page is served with Referrer-Policy: no-referrer, so a browser's press says Origin "null"; it counts only
    // when the browser also says the press came from this same origin.
    let origin_ok = match origin {
        None => true,
        Some("null") => site == Some("same-origin"),
        Some(o) => o == own,
    };
    origin_ok && matches!(site, None | Some("same-origin") | Some("none"))
}

/// the person's answer on the page: only the browser holding the press cookie, from that page, before it expires, once
pub async fn confirm(State(st): State<St>, headers: HeaderMap, Path(answer): Path<String>) -> Result<Response> {
    if answer != "yes" && answer != "no" {
        return Err(not_found("no such answer"));
    }
    sweep(&st).await?;
    if !own_page(&st, &headers) {
        return Ok(page_with(StatusCode::FORBIDDEN, "Nothing was done", "That answer didn't come from ChatForm's own page."));
    }
    let clear = HeaderValue::from_static("chatform_app_confirm=; Path=/auth/app; HttpOnly; SameSite=Strict; Max-Age=0");
    let presented = cookie_value(&headers, CONFIRM_COOKIE).unwrap_or_default();
    let now = now_ms();
    let mut res = if presented.is_empty() {
        page_with(StatusCode::BAD_REQUEST, "Sign-in expired", "That sign-in took too long or was already answered. Start again from the app.")
    } else if answer == "yes" {
        let done = sqlx::query("update app_signins set confirmed_at = $2, confirm_hash = null where confirm_hash = $1 and expires_at > $2 and result_user_id is not null and confirmed_at is null")
            .bind(hash_token(&presented))
            .bind(now)
            .execute(&st.db)
            .await?;
        if done.rows_affected() == 1 {
            page_with(StatusCode::OK, "That app is signed in", "You can go back to the app and close this tab.")
        } else {
            page_with(StatusCode::BAD_REQUEST, "Sign-in expired", "That sign-in took too long or was already answered. Start again from the app.")
        }
    } else {
        // the app hears no, once, and gets nothing
        let done = sqlx::query("update app_signins set result_user_id = null, result_error = $3, confirm_hash = null where confirm_hash = $1 and expires_at > $2 and confirmed_at is null")
            .bind(hash_token(&presented))
            .bind(now)
            .bind("The sign-in was turned down in the browser.")
            .execute(&st.db)
            .await?;
        if done.rows_affected() == 1 {
            page_with(StatusCode::OK, "Nothing was signed in", "That app was not signed in. If you didn't start this, someone may have sent you the link: you can ignore it.")
        } else {
            page_with(StatusCode::BAD_REQUEST, "Sign-in expired", "That sign-in took too long or was already answered. Start again from the app.")
        }
    };
    res.headers_mut().append(header::SET_COOKIE, clear);
    Ok(res)
}

/// the app asks whether the browser finished: its session, once, only after "This is me"
pub async fn poll(State(st): State<St>, headers: HeaderMap) -> Result<Json<Value>> {
    sweep(&st).await?;
    let Some(presented) = bearer(&headers) else { return Err(not_found("no such sign-in (expired?)")) };
    let poll_hash = hash_token(&presented);
    let now = now_ms();
    // a finished attempt is collected once: read and deleted in one statement
    let finished: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        "delete from app_signins where poll_hash = $1 and expires_at > $2
           and ((result_user_id is not null and confirmed_at is not null) or result_error is not null) returning result_user_id, result_error",
    )
    .bind(&poll_hash)
    .bind(now)
    .fetch_optional(&st.db)
    .await?;
    let Some((user_id, error)) = finished else {
        let open: Option<(i32,)> = sqlx::query_as("select 1 from app_signins where poll_hash = $1 and expires_at > $2").bind(&poll_hash).bind(now).fetch_optional(&st.db).await?;
        return if open.is_some() { Ok(Json(json!({ "status": "pending" }))) } else { Err(not_found("no such sign-in (expired?)")) };
    };
    let Some(user_id) = user_id else {
        return Ok(Json(json!({ "status": "error", "error": error.unwrap_or_else(|| "Sign-in didn't finish".into()) })));
    };
    let user = sqlx::query_as::<_, User>("select id, email, name, color, role from users where id = $1").bind(&user_id).fetch_optional(&st.db).await?;
    let Some(user) = user else { return Err(http(StatusCode::INTERNAL_SERVER_ERROR, "user vanished")) };
    let session = create_session(&st, &user.id, "app").await?;
    Ok(Json(json!({ "status": "ok", "user": user, "session": session })))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_code_is_eight_unmistakable_characters_in_two_fours() {
        let c = sign_in_code();
        assert_eq!(c.len(), 9);
        assert_eq!(&c[4..5], "-");
        assert!(c.chars().filter(|x| *x != '-').all(|x| CODE_ALPHABET.contains(&(x as u8))));
        for bad in ['0', 'O', '1', 'I', 'L', '5', 'S', '2', 'Z'] {
            assert!(!CODE_ALPHABET.contains(&(bad as u8)));
        }
    }
}
