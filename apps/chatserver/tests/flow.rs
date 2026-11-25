//! ChatForm's Rust server end to end, over real HTTP and sockets on a fresh Postgres database.
//! Needs a Postgres (CHATSERVER_TEST_ADMIN_URL, default postgres://postgres@127.0.0.1:15432/postgres); without
//! one the tests say so and pass. Locally: `docker run -d --name chatform-pg -e POSTGRES_HOST_AUTH_METHOD=trust
//! -p 127.0.0.1:15432:5432 postgres:17-alpine`.

use std::{net::SocketAddr, time::Duration};

use chatserver::{Config, app, state};
use futures_util::StreamExt;
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;

fn admin_url() -> String {
    std::env::var("CHATSERVER_TEST_ADMIN_URL").unwrap_or_else(|_| "postgres://postgres@127.0.0.1:15432/postgres".into())
}

/// a fresh database, or None when there's no Postgres to test against
async fn fresh_db() -> Option<String> {
    let admin = admin_url();
    let pool = match sqlx::PgPool::connect(&admin).await {
        Ok(p) => p,
        Err(e) => {
            eprintln!("skipped: no Postgres at {admin} ({e})");
            return None;
        }
    };
    let name = format!("chatform_test_{}", chatserver::util::random_token().to_lowercase().replace(['-', '_'], "").chars().take(12).collect::<String>());
    sqlx::query(&format!("create database {name}")).execute(&pool).await.expect("create database");
    let base = admin.rsplit_once('/').map(|(b, _)| b.to_string()).unwrap();
    Some(format!("{base}/{name}"))
}

fn config(db: &str) -> Config {
    let (google_auth_url, google_token_url, google_userinfo_url) = Config::google_urls();
    Config {
        google_auth_url,
        google_token_url,
        google_userinfo_url,
        google_jwks_url: Config::google_jwks(),
        trusted_client_ids: vec![],
        previews: true,
        preview_loopback: false,
        database_url: db.into(),
        listen_url: db.into(),
        public_url: "http://localhost:4420".into(),
        google_client_id: None,
        google_client_secret: None,
        allowlist: vec!["@formindustries.co".into(), "@normallab.co".into()],
        admins: vec!["boss@formindustries.co".into()],
        dev_login: true,
        cors_origins: vec!["http://localhost:31440".into()],
        on_vercel: false,
        port: 0,
    }
}

/// a running instance on a free port; two on one database are two Vercel instances
async fn instance(db: &str) -> String {
    serve(config(db)).await
}

async fn serve(cfg: Config) -> String {
    let st = state(cfg).await.expect("state");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app(st).into_make_service_with_connect_info::<SocketAddr>()).await.unwrap() });
    // the listener comes up a moment after start
    tokio::time::sleep(Duration::from_millis(300)).await;
    format!("http://{addr}")
}

struct Who {
    id: String,
    token: String,
}

async fn sign_in(base: &str, email: &str, name: &str) -> Who {
    let r: Value = reqwest::Client::new().post(format!("{base}/auth/dev")).json(&json!({ "email": email, "name": name, "bearer": true })).send().await.unwrap().json().await.unwrap();
    Who { id: r["user"]["id"].as_str().expect("signed in").into(), token: r["session"].as_str().unwrap().into() }
}

async fn call(method: &str, base: &str, path: &str, who: &Who, body: Option<Value>) -> (u16, Value) {
    let c = reqwest::Client::new();
    let mut rq = match method {
        "GET" => c.get(format!("{base}{path}")),
        "DELETE" => c.delete(format!("{base}{path}")),
        _ => c.post(format!("{base}{path}")),
    }
    .bearer_auth(&who.token);
    if let Some(b) = body {
        rq = rq.json(&b);
    }
    let res = rq.send().await.unwrap();
    let status = res.status().as_u16();
    (status, res.json().await.unwrap_or(Value::Null))
}

type Sock = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn socket(base: &str, who: &Who) -> Sock {
    let (_, t) = call("POST", base, "/api/ws-ticket", who, Some(json!({ "path": "/chat" }))).await;
    let url = format!("{}/chat?ticket={}", base.replace("http://", "ws://"), t["ticket"].as_str().unwrap());
    let (ws, _) = tokio_tungstenite::connect_async(url).await.expect("socket");
    ws
}

/// the next events on a socket until one matches, within a few seconds
async fn until(ws: &mut Sock, want: impl Fn(&Value) -> bool) -> Option<Value> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(left, ws.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => {
                let v: Value = serde_json::from_str(t.as_str()).unwrap();
                if want(&v) {
                    return Some(v);
                }
            }
            Ok(Some(Ok(_))) => continue,
            _ => return None,
        }
    }
}

#[tokio::test]
async fn sign_in_general_posts_threads_and_who_may_see_what() {
    let Some(db) = fresh_db().await else { return };
    let base = instance(&db).await;

    // only the allowlist signs in; dev login answers this computer
    let refused = reqwest::Client::new().post(format!("{base}/auth/dev")).json(&json!({ "email": "x@gmail.com" })).send().await.unwrap();
    assert_eq!(refused.status().as_u16(), 403);
    let ada = sign_in(&base, "ada@formindustries.co", "Ada Lovelace").await;
    let kai = sign_in(&base, "kai@normallab.co", "Kai Moana").await;
    let vic = sign_in(&base, "vic@formindustries.co", "Vic").await;
    let boss = sign_in(&base, "boss@formindustries.co", "Boss").await;
    let (_, me) = call("GET", &base, "/api/me", &boss, None).await;
    assert_eq!(me["user"]["role"], "admin", "the admin list makes an admin");

    // #general: made on first use, everyone in it
    let (s, list) = call("GET", &base, "/api/chat", &ada, None).await;
    assert_eq!(s, 200);
    assert_eq!(list["channels"][0]["name"], "general");
    let general = list["channels"][0]["id"].as_str().unwrap().to_string();
    call("GET", &base, "/api/chat", &kai, None).await;

    // a post with a request id lands once, however often it's sent
    let body = json!({ "text": "Morning @kai.moana, the kiln moved to Thursday", "request_id": "r1" });
    let (s, a) = call("POST", &base, &format!("/api/chat/channels/{general}/messages"), &ada, Some(body.clone())).await;
    assert_eq!(s, 200, "{a}");
    let (_, b) = call("POST", &base, &format!("/api/chat/channels/{general}/messages"), &ada, Some(body)).await;
    assert_eq!(a["message"]["id"], b["message"]["id"]);
    assert_eq!(a["message"]["seq"], 1);
    assert_eq!(a["message"]["author"]["id"], ada.id.as_str(), "who wrote it is the session's to say");
    assert_eq!(a["message"]["mentions"], json!([kai.id]));
    let root = a["message"]["id"].as_str().unwrap().to_string();

    // Kai has one unread, and it mentions him
    let (_, kl) = call("GET", &base, "/api/chat", &kai, None).await;
    let g = kl["channels"].as_array().unwrap().iter().find(|c| c["id"] == general.as_str()).unwrap().clone();
    assert_eq!(g["unread"], 1);
    assert_eq!(g["me"]["mentions"], 1);

    // a reply makes a thread; the main page leaves it out, the thread has both
    call("POST", &base, &format!("/api/chat/channels/{general}/messages"), &kai, Some(json!({ "text": "Thanks", "root": root }))).await;
    let (_, page) = call("GET", &base, &format!("/api/chat/channels/{general}/messages"), &ada, None).await;
    assert_eq!(page["messages"].as_array().unwrap().len(), 1);
    assert_eq!(page["messages"][0]["replyCount"], 1);
    assert_eq!(page["messages"][0]["repliers"], json!(["Kai Moana"]));
    let (_, thread) = call("GET", &base, &format!("/api/chat/channels/{general}/messages?root={root}"), &ada, None).await;
    assert_eq!(thread["messages"].as_array().unwrap().len(), 2);

    // a DM reaches its two alone: not Vic, not an admin; asked for again it's the same one
    let (_, dm) = call("POST", &base, "/api/chat/channels", &ada, Some(json!({ "kind": "dm", "members": [kai.id] }))).await;
    let dm_id = dm["channel"]["id"].as_str().unwrap().to_string();
    let (_, again) = call("POST", &base, "/api/chat/channels", &kai, Some(json!({ "kind": "dm", "members": [ada.id] }))).await;
    assert_eq!(again["channel"]["id"], dm_id.as_str());
    call("POST", &base, &format!("/api/chat/channels/{dm_id}/messages"), &ada, Some(json!({ "text": "just us" }))).await;
    for outsider in [&vic, &boss] {
        let (s, _) = call("GET", &base, &format!("/api/chat/channels/{dm_id}/messages"), outsider, None).await;
        assert_eq!(s, 404, "a DM answers outsiders like a missing one");
        let (_, l) = call("GET", &base, "/api/chat", outsider, None).await;
        assert!(!l["channels"].as_array().unwrap().iter().any(|c| c["id"] == dm_id.as_str()));
        let (_, hits) = call("GET", &base, "/api/chat/search?q=just", outsider, None).await;
        assert_eq!(hits["hits"], json!([]), "search keeps to what they can see");
    }
    let (_, hits) = call("GET", &base, "/api/chat/search?q=just", &kai, None).await;
    assert_eq!(hits["hits"].as_array().unwrap().len(), 1);

    // removing needs confirm, and keeps the row with its words gone
    let (s, _) = call("DELETE", &base, &format!("/api/chat/messages/{root}"), &ada, Some(json!({}))).await;
    assert_eq!(s, 400);
    let (s, _) = call("DELETE", &base, &format!("/api/chat/messages/{root}"), &kai, Some(json!({ "confirm": true }))).await;
    assert_eq!(s, 403, "only who wrote it, or an admin");
    let (s, gone) = call("DELETE", &base, &format!("/api/chat/messages/{root}"), &ada, Some(json!({ "confirm": true }))).await;
    assert_eq!(s, 200);
    assert_eq!(gone["message"]["text"], "");
    assert!(gone["message"]["deletedAt"].is_number());
    let (_, thread) = call("GET", &base, &format!("/api/chat/channels/{general}/messages?root={root}"), &ada, None).await;
    assert_eq!(thread["messages"].as_array().unwrap().len(), 2, "the thread holds together");
}

#[tokio::test]
async fn the_socket_says_hello_then_counts_up_and_keeps_dms_to_their_people() {
    let Some(db) = fresh_db().await else { return };
    let base = instance(&db).await;
    let ada = sign_in(&base, "ada@formindustries.co", "Ada").await;
    let kai = sign_in(&base, "kai@formindustries.co", "Kai").await;
    let vic = sign_in(&base, "vic@formindustries.co", "Vic").await;
    let (_, list) = call("GET", &base, "/api/chat", &ada, None).await;
    let general = list["channels"][0]["id"].as_str().unwrap().to_string();

    let mut ks = socket(&base, &kai).await;
    let mut vs = socket(&base, &vic).await;
    let hello = until(&mut ks, |v| v["t"] == "hello").await.expect("hello");
    assert_eq!(hello["rev"], 0);
    assert_eq!(hello["you"], kai.id.as_str());

    call("POST", &base, &format!("/api/chat/channels/{general}/messages"), &ada, Some(json!({ "text": "hello all", "request_id": "q1" }))).await;
    let m = until(&mut ks, |v| v["t"] == "message").await.expect("Kai hears #general");
    assert_eq!(m["message"]["text"], "hello all");
    assert_eq!(m["requestId"], "q1");
    assert!(m["rev"].as_u64().unwrap() >= 1);
    assert!(until(&mut vs, |v| v["t"] == "message").await.is_some(), "an open channel reaches everyone");

    let (_, dm) = call("POST", &base, "/api/chat/channels", &ada, Some(json!({ "kind": "dm", "members": [kai.id] }))).await;
    let dm_id = dm["channel"]["id"].as_str().unwrap().to_string();
    call("POST", &base, &format!("/api/chat/channels/{dm_id}/messages"), &ada, Some(json!({ "text": "psst" }))).await;
    let got = until(&mut ks, |v| v["t"] == "message" && v["message"]["text"] == "psst").await;
    assert!(got.is_some(), "Kai gets the DM");
    let leaked = until(&mut vs, |v| v["t"] == "message" && v["message"]["text"] == "psst").await;
    assert!(leaked.is_none(), "Vic never sees it");

    // a ticket is spent once
    let (_, t) = call("POST", &base, "/api/ws-ticket", &kai, Some(json!({ "path": "/chat" }))).await;
    let url = format!("{}/chat?ticket={}", base.replace("http://", "ws://"), t["ticket"].as_str().unwrap());
    assert!(tokio_tungstenite::connect_async(url.clone()).await.is_ok());
    assert!(tokio_tungstenite::connect_async(url).await.is_err(), "a ticket opens one socket");
}

#[tokio::test]
async fn the_cookie_works_only_from_chatforms_own_pages() {
    let Some(db) = fresh_db().await else { return };
    let base = instance(&db).await;
    let ada = sign_in(&base, "ada@formindustries.co", "Ada").await;
    let (_, list) = call("GET", &base, "/api/chat", &ada, None).await;
    let general = list["channels"][0]["id"].as_str().unwrap().to_string();
    let c = reqwest::Client::new();
    let post = |origin: Option<&'static str>| {
        let mut r = c.post(format!("{base}/api/chat/channels/{general}/messages")).header("cookie", format!("chatform_session={}", ada.token)).json(&json!({ "text": "via cookie" }));
        if let Some(o) = origin {
            r = r.header("origin", o);
        }
        r.send()
    };
    assert_eq!(post(Some("https://evil.example")).await.unwrap().status().as_u16(), 403);
    assert_eq!(post(None).await.unwrap().status().as_u16(), 403, "no Origin and no Sec-Fetch-Site: refused");
    assert_eq!(post(Some("http://localhost:31440")).await.unwrap().status().as_u16(), 200, "the Foundation app's window is listed");
    // a bearer needs no Origin (a browser never sends one on its own)
    let (s, _) = call("POST", &base, &format!("/api/chat/channels/{general}/messages"), &ada, Some(json!({ "text": "via bearer" }))).await;
    assert_eq!(s, 200);
}

#[tokio::test]
async fn a_post_on_one_instance_reaches_a_socket_on_another() {
    let Some(db) = fresh_db().await else { return };
    let a = instance(&db).await;
    let b = instance(&db).await;
    let ada = sign_in(&a, "ada@formindustries.co", "Ada").await;
    let kai = sign_in(&b, "kai@formindustries.co", "Kai").await;
    let (_, list) = call("GET", &a, "/api/chat", &ada, None).await;
    let general = list["channels"][0]["id"].as_str().unwrap().to_string();
    let mut ks = socket(&b, &kai).await;
    until(&mut ks, |v| v["t"] == "hello").await.expect("hello");
    call("POST", &a, &format!("/api/chat/channels/{general}/messages"), &ada, Some(json!({ "text": "across instances" }))).await;
    let m = until(&mut ks, |v| v["t"] == "message").await;
    assert_eq!(m.expect("delivered through LISTEN/NOTIFY")["message"]["text"], "across instances");
    // and who's online is everyone's, across instances
    let (_, l) = call("GET", &a, "/api/chat", &ada, None).await;
    assert!(l["online"].as_array().unwrap().iter().any(|x| x == kai.id.as_str()));
}

// ---------------------------------------------------------------- an app signs in (app_signin.rs), against a stand-in Google

/// Google, for a test: the code is the address ("nobody" is refused), and an address starting "unverified" isn't verified
async fn google_standin() -> String {
    use axum::{Form, Json, Router, http::HeaderMap, routing::{get, post}};
    async fn token(Form(f): Form<std::collections::HashMap<String, String>>) -> Json<Value> {
        let code = f.get("code").cloned().unwrap_or_default();
        if code == "nobody" || f.get("client_secret").map(String::as_str) != Some("standin-secret") {
            return Json(json!({ "error": "invalid_grant" }));
        }
        Json(json!({ "access_token": code }))
    }
    async fn userinfo(h: HeaderMap) -> Json<Value> {
        let email = h.get("authorization").and_then(|v| v.to_str().ok()).unwrap_or("").trim_start_matches("Bearer ").to_string();
        Json(json!({ "email": email, "email_verified": !email.starts_with("unverified"), "name": "Ada Lovelace" }))
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, Router::new().route("/token", post(token)).route("/userinfo", get(userinfo))).await.unwrap() });
    format!("http://{addr}")
}

/// an instance whose Google is the stand-in; its public address is the one it listens on, so its own pages are its origin
async fn instance_with_google(db: &str) -> String {
    let google = google_standin().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let mut cfg = config(db);
    cfg.public_url = format!("http://{addr}");
    cfg.google_client_id = Some("standin-client".into());
    cfg.google_client_secret = Some("standin-secret".into());
    cfg.google_auth_url = format!("{google}/auth");
    cfg.google_token_url = format!("{google}/token");
    cfg.google_userinfo_url = format!("{google}/userinfo");
    let st = state(cfg).await.expect("state");
    tokio::spawn(async move { axum::serve(listener, app(st).into_make_service_with_connect_info::<SocketAddr>()).await.unwrap() });
    tokio::time::sleep(Duration::from_millis(300)).await;
    format!("http://{addr}")
}

struct Begun {
    state: String,
    poll: String,
    code: String,
}

async fn begin(base: &str) -> Begun {
    let r: Value = reqwest::Client::new().post(format!("{base}/auth/app/begin")).send().await.unwrap().json().await.unwrap();
    let url = url::Url::parse(r["url"].as_str().expect("a url to open")).unwrap();
    let q: std::collections::HashMap<String, String> = url.query_pairs().into_owned().collect();
    assert_eq!(q["redirect_uri"], format!("{base}/auth/google/callback"));
    assert_eq!(r["expiresIn"], 300);
    Begun { state: q["state"].clone(), poll: r["poll"].as_str().unwrap().into(), code: r["code"].as_str().unwrap().into() }
}

async fn poll(base: &str, secret: &str) -> (u16, Value) {
    let res = reqwest::Client::new().post(format!("{base}/auth/app/poll")).bearer_auth(secret).send().await.unwrap();
    let status = res.status().as_u16();
    (status, res.json().await.unwrap_or(Value::Null))
}

/// Google sends the browser back: the page it lands on, and the press cookie it was given
async fn back_from_google(base: &str, state: &str, code: &str) -> (u16, String, Option<String>) {
    let res = reqwest::Client::new().get(format!("{base}/auth/google/callback")).query(&[("state", state), ("code", code)]).send().await.unwrap();
    let status = res.status().as_u16();
    let cookie = res.headers().get_all("set-cookie").iter().filter_map(|v| v.to_str().ok()).find(|v| v.starts_with("chatform_app_confirm=")).map(|v| v.split(';').next().unwrap().to_string());
    (status, res.text().await.unwrap(), cookie)
}

async fn press(base: &str, answer: &str, cookie: Option<&str>, origin: Option<&str>, site: Option<&str>) -> (u16, String) {
    let mut r = reqwest::Client::new().post(format!("{base}/auth/app/confirm/{answer}"));
    if let Some(c) = cookie {
        r = r.header("cookie", c);
    }
    if let Some(o) = origin {
        r = r.header("origin", o);
    }
    if let Some(s) = site {
        r = r.header("sec-fetch-site", s);
    }
    let res = r.send().await.unwrap();
    (res.status().as_u16(), res.text().await.unwrap())
}

#[tokio::test]
async fn an_app_signs_in_only_after_the_person_says_this_is_me() {
    let Some(db) = fresh_db().await else { return };
    let base = instance_with_google(&db).await;
    let cfg: Value = reqwest::get(format!("{base}/auth/config")).await.unwrap().json().await.unwrap();
    assert_eq!(cfg["app"], true);
    assert!(cfg["features"].as_array().unwrap().iter().any(|f| f == "channels"));

    let b = begin(&base).await;
    assert_eq!(b.code.len(), 9);
    assert_eq!(poll(&base, &b.poll).await.1["status"], "pending");
    assert_eq!(poll(&base, "not-a-poll").await.0, 404);

    // Google is done, the person is who they say: still nothing for the app until the press
    let (status, page, cookie) = back_from_google(&base, &b.state, "ada@formindustries.co").await;
    assert_eq!(status, 200);
    assert!(page.contains(&b.code), "the page shows the app's code");
    assert!(page.contains("ada@formindustries.co") && page.contains("This is me"));
    let cookie = cookie.expect("a cookie for the press");
    assert!(cookie.len() > 30 && !page.contains(cookie.split('=').nth(1).unwrap()));
    assert_eq!(poll(&base, &b.poll).await.1["status"], "pending", "Google alone signs nobody's app in");

    // a press from elsewhere, or without this browser's cookie, does nothing
    assert_eq!(press(&base, "yes", Some(&cookie), Some("https://evil.example"), Some("cross-site")).await.0, 403);
    assert_eq!(press(&base, "yes", Some(&cookie), Some("null"), Some("cross-site")).await.0, 403);
    assert_eq!(press(&base, "yes", None, Some("null"), Some("same-origin")).await.0, 400);
    assert_eq!(press(&base, "yes", Some("chatform_app_confirm=guessed"), Some("null"), Some("same-origin")).await.0, 400);
    assert_eq!(poll(&base, &b.poll).await.1["status"], "pending");

    // Google comes back once: the same state again is a replay
    assert_eq!(back_from_google(&base, &b.state, "ada@formindustries.co").await.0, 400);

    // "This is me", from the page itself (its Origin is "null" under no-referrer, and the browser says same-origin)
    let (status, said) = press(&base, "yes", Some(&cookie), Some("null"), Some("same-origin")).await;
    assert_eq!(status, 200);
    assert!(said.contains("That app is signed in"));
    assert_eq!(press(&base, "yes", Some(&cookie), Some("null"), Some("same-origin")).await.0, 400, "one press");

    let (status, got) = poll(&base, &b.poll).await;
    assert_eq!(status, 200);
    assert_eq!(got["status"], "ok");
    assert_eq!(got["user"]["email"], "ada@formindustries.co");
    let who = Who { id: got["user"]["id"].as_str().unwrap().into(), token: got["session"].as_str().unwrap().into() };
    // the session is the app's bearer: it reads ChatForm, and opens the socket by ticket
    let (status, me) = call("GET", &base, "/api/me", &who, None).await;
    assert_eq!((status, me["user"]["id"].as_str()), (200, Some(who.id.as_str())));
    let (status, list) = call("GET", &base, "/api/chat", &who, None).await;
    assert_eq!(status, 200);
    assert_eq!(list["channels"][0]["name"], "general");
    let mut ws = socket(&base, &who).await;
    assert_eq!(until(&mut ws, |v| v["t"] == "hello").await.expect("hello")["you"], who.id.as_str());
    // collected once
    assert_eq!(poll(&base, &b.poll).await.0, 404);
    // only its hash was kept
    let pool = sqlx::PgPool::connect(&db).await.unwrap();
    let (kept,): (i64,) = sqlx::query_as("select count(*) from sessions where token_hash = $1").bind(&who.token).fetch_one(&pool).await.unwrap();
    assert_eq!(kept, 0);
    let (left,): (i64,) = sqlx::query_as("select count(*) from app_signins").fetch_one(&pool).await.unwrap();
    assert_eq!(left, 0);
}

#[tokio::test]
async fn not_me_a_stranger_or_an_unverified_address_sign_no_app_in() {
    let Some(db) = fresh_db().await else { return };
    let base = instance_with_google(&db).await;

    // "Not me": the app hears no, once, and gets no session
    let b = begin(&base).await;
    let (_, _, cookie) = back_from_google(&base, &b.state, "ada@formindustries.co").await;
    let (status, said) = press(&base, "no", cookie.as_deref(), Some(&base), Some("same-origin")).await;
    assert_eq!(status, 200);
    assert!(said.contains("Nothing was signed in"));
    let (_, got) = poll(&base, &b.poll).await;
    assert_eq!(got["status"], "error");
    assert!(got.get("session").is_none());
    assert_eq!(poll(&base, &b.poll).await.0, 404);

    // someone off the allowlist: the page says so, there is no press to make, and the app is told
    let b = begin(&base).await;
    let (status, page, cookie) = back_from_google(&base, &b.state, "mallory@elsewhere.example").await;
    assert_eq!(status, 403);
    assert!(page.contains("isn't on this server's list") && cookie.is_none());
    let (_, got) = poll(&base, &b.poll).await;
    assert_eq!(got["status"], "error");
    assert!(got["error"].as_str().unwrap().contains("mallory@elsewhere.example"));
    assert!(got.get("session").is_none());

    // an address Google hasn't verified, a code Google refuses, and a sign-in cancelled at Google
    for (code, error) in [("unverified@formindustries.co", None), ("nobody", None), ("", Some("access_denied"))] {
        let b = begin(&base).await;
        let mut q = vec![("state", b.state.as_str()), ("code", code)];
        if let Some(e) = error {
            q.push(("error", e));
        }
        let res = reqwest::Client::new().get(format!("{base}/auth/google/callback")).query(&q).send().await.unwrap();
        assert!(res.status().is_client_error());
        assert!(res.headers().get("set-cookie").is_none());
        let (_, got) = poll(&base, &b.poll).await;
        assert_eq!(got["status"], "error", "{code}");
        assert!(got.get("session").is_none());
    }

    // a state nobody began is not an app's: the browser's own sign-in answers it (and refuses: no cookie)
    let res = reqwest::Client::new().get(format!("{base}/auth/google/callback")).query(&[("state", "made-up"), ("code", "ada@formindustries.co")]).send().await.unwrap();
    assert_eq!(res.status().as_u16(), 403);
    assert!(res.headers().get("set-cookie").is_none());
}

#[tokio::test]
async fn an_app_sign_in_needs_google_set_up() {
    let Some(db) = fresh_db().await else { return };
    let base = instance(&db).await;
    let res = reqwest::Client::new().post(format!("{base}/auth/app/begin")).send().await.unwrap();
    assert_eq!(res.status().as_u16(), 503);
    let cfg: Value = reqwest::get(format!("{base}/auth/config")).await.unwrap().json().await.unwrap();
    assert_eq!(cfg["app"], false);
}

// ---------------------------------------------------------------- files in messages (files.rs)

fn png(w: u32, h: u32) -> Vec<u8> {
    let mut out = std::io::Cursor::new(Vec::new());
    image::RgbImage::from_fn(w, h, |x, y| image::Rgb([(x % 251) as u8, (y % 241) as u8, 90])).write_to(&mut out, image::ImageFormat::Png).unwrap();
    out.into_inner()
}

async fn upload(base: &str, who: &Who, board: &str, name: &str, mime: &str, body: Vec<u8>) -> (u16, Value) {
    let res = reqwest::Client::new().post(format!("{base}/api/files")).query(&[("board", board), ("name", name)]).bearer_auth(&who.token).header("content-type", mime).body(body).send().await.unwrap();
    let status = res.status().as_u16();
    (status, res.json().await.unwrap_or(Value::Null))
}

async fn file(base: &str, who: &Who, path: &str, headers: &[(&str, &str)]) -> reqwest::Response {
    let mut r = reqwest::Client::new().get(format!("{base}{path}")).bearer_auth(&who.token);
    for (k, v) in headers {
        r = r.header(*k, *v);
    }
    r.send().await.unwrap()
}

#[tokio::test]
async fn a_file_reaches_its_uploader_and_the_readers_of_a_message_that_carries_it() {
    let Some(db) = fresh_db().await else { return };
    let base = instance(&db).await;
    let ada = sign_in(&base, "ada@formindustries.co", "Ada").await;
    let kai = sign_in(&base, "kai@formindustries.co", "Kai").await;
    let vic = sign_in(&base, "vic@formindustries.co", "Vic").await;
    let boss = sign_in(&base, "boss@formindustries.co", "Boss").await;
    let (_, list) = call("GET", &base, "/api/chat", &ada, None).await;
    let general = list["channels"][0]["id"].as_str().unwrap().to_string();
    for w in [&kai, &vic, &boss] {
        call("GET", &base, "/api/chat", w, None).await;
    }

    // an upload answers as the Node server's does, with the picture's size
    let bytes = png(300, 120);
    let (s, up) = upload(&base, &ada, "chat", "kiln plan.png", "image/png", bytes.clone()).await;
    assert_eq!(s, 200, "{up}");
    let f = &up["file"];
    let id = f["id"].as_str().unwrap().to_string();
    assert_eq!((f["name"].as_str(), f["mime"].as_str(), f["size"].as_u64(), f["width"].as_u64(), f["height"].as_u64()), (Some("kiln plan.png"), Some("image/png"), Some(bytes.len() as u64), Some(300), Some(120)));
    assert_eq!(f["url"], format!("/files/{id}"));
    assert_eq!(f["board_id"], "chat");
    assert_eq!(f["uploaded_by"], ada.id.as_str());
    // the same bytes from the same person are the same file; from someone else, their own
    let (_, again) = upload(&base, &ada, "chat", "again.png", "image/png", bytes.clone()).await;
    assert_eq!(again["file"]["id"], id.as_str());
    let (_, theirs) = upload(&base, &vic, "chat", "mine.png", "image/png", bytes.clone()).await;
    assert_ne!(theirs["file"]["id"], id.as_str());

    // what is refused, in words
    assert_eq!(upload(&base, &ada, "b_some_grid", "x.png", "image/png", bytes.clone()).await.0, 400, "only ChatForm's files live here");
    assert_eq!(upload(&base, &ada, "chat", "empty", "text/plain", vec![]).await.0, 400);
    let (s, big) = upload(&base, &ada, "chat", "big.bin", "application/octet-stream", vec![7u8; 4 * 1024 * 1024 + 1]).await;
    assert_eq!(s, 413);
    assert!(big["error"].as_str().unwrap().contains("4 MB"), "{big}");
    let (s, edge) = upload(&base, &ada, "chat", "edge.bin", "application/octet-stream", vec![7u8; 4 * 1024 * 1024]).await;
    assert_eq!(s, 200, "exactly 4 MB is kept: {edge}");
    let anon = reqwest::Client::new().post(format!("{base}/api/files?board=chat&name=x")).body("hi").send().await.unwrap();
    assert_eq!(anon.status().as_u16(), 401);

    // until a message carries it, it is its uploader's alone
    assert_eq!(file(&base, &ada, &format!("/files/{id}"), &[]).await.status().as_u16(), 200);
    for other in [&kai, &vic, &boss] {
        assert_eq!(file(&base, other, &format!("/files/{id}"), &[]).await.status().as_u16(), 404);
    }
    assert_eq!(reqwest::get(format!("{base}/files/{id}")).await.unwrap().status().as_u16(), 401);
    // and nobody else can put it on a message of their own to get at it
    let (s, e) = call("POST", &base, &format!("/api/chat/channels/{general}/messages"), &vic, Some(json!({ "text": "mine now", "files": [id] }))).await;
    assert_eq!(s, 400, "{e}");

    // a DM carries it, with no words at all: its two read it, nobody else does, an admin included
    let (_, dm) = call("POST", &base, "/api/chat/channels", &ada, Some(json!({ "kind": "dm", "members": [kai.id] }))).await;
    let dm_id = dm["channel"]["id"].as_str().unwrap().to_string();
    let (s, posted) = call("POST", &base, &format!("/api/chat/channels/{dm_id}/messages"), &ada, Some(json!({ "text": "", "files": [id, id], "request_id": "f1" }))).await;
    assert_eq!(s, 200, "{posted}");
    assert_eq!(posted["message"]["files"], json!([{ "id": id, "name": "kiln plan.png", "mime": "image/png", "size": bytes.len(), "w": 300, "h": 120 }]));
    let mid = posted["message"]["id"].as_str().unwrap().to_string();
    let (_, l) = call("GET", &base, "/api/chat", &kai, None).await;
    let row = l["channels"].as_array().unwrap().iter().find(|c| c["id"] == dm_id.as_str()).unwrap().clone();
    assert_eq!(row["lastText"], "kiln plan.png", "the list names the file when there are no words");
    let (_, page) = call("GET", &base, &format!("/api/chat/channels/{dm_id}/messages"), &kai, None).await;
    assert_eq!(page["messages"][0]["files"][0]["id"], id.as_str());

    let got = file(&base, &kai, &format!("/files/{id}"), &[]).await;
    assert_eq!(got.status().as_u16(), 200);
    let h = got.headers().clone();
    let head = |k: &str| h.get(k).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    assert_eq!(head("content-type"), "image/png");
    assert!(head("cache-control").starts_with("private"), "{}", head("cache-control"));
    assert_eq!(head("x-content-type-options"), "nosniff");
    assert!(head("content-disposition").starts_with("inline; filename*=UTF-8''kiln%20plan.png"));
    assert_eq!((head("x-image-level"), head("x-image-natural-width"), head("x-image-natural-height")), ("original".to_string(), "300".to_string(), "120".to_string()));
    let etag = head("etag");
    assert!(etag.starts_with('"') && etag.ends_with("-orig\""));
    assert_eq!(got.bytes().await.unwrap().as_ref(), bytes.as_slice());
    let again = file(&base, &kai, &format!("/files/{id}"), &[("if-none-match", &etag)]).await;
    assert_eq!(again.status().as_u16(), 304);
    assert!(again.headers()["cache-control"].to_str().unwrap().starts_with("private"));
    let part = file(&base, &kai, &format!("/files/{id}"), &[("range", "bytes=0-7")]).await;
    assert_eq!(part.status().as_u16(), 206);
    assert_eq!(part.headers()["content-range"].to_str().unwrap(), format!("bytes 0-7/{}", bytes.len()));
    assert_eq!(part.bytes().await.unwrap().as_ref(), &bytes[..8]);
    assert_eq!(file(&base, &kai, &format!("/files/{id}"), &[("range", "bytes=99999999-")]).await.status().as_u16(), 416);
    for outsider in [&vic, &boss] {
        assert_eq!(file(&base, outsider, &format!("/files/{id}"), &[]).await.status().as_u16(), 404, "no admin exception");
        assert_eq!(file(&base, outsider, &format!("/files/{id}?w=64"), &[]).await.status().as_u16(), 404);
    }
    // a file Kai can see, Kai can pass on
    let (s, _) = call("POST", &base, &format!("/api/chat/channels/{general}/messages"), &kai, Some(json!({ "text": "for everyone", "files": [id] }))).await;
    assert_eq!(s, 200);
    assert_eq!(file(&base, &vic, &format!("/files/{id}"), &[]).await.status().as_u16(), 200, "an open channel's readers");

    // a width tier: scaled down, kept, and its own ETag
    let small = file(&base, &kai, &format!("/files/{id}?w=60"), &[]).await;
    assert_eq!(small.status().as_u16(), 200);
    let sh = small.headers().clone();
    let shead = |k: &str| sh.get(k).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    assert_eq!((shead("content-type"), shead("x-image-level"), shead("x-image-width"), shead("x-image-height"), shead("x-image-natural-width"), shead("x-image-alpha")), ("image/jpeg".into(), "64".into(), "64".into(), "26".into(), "300".into(), "0".into()));
    assert!(shead("etag").ends_with("-w64\""));
    let small_bytes = small.bytes().await.unwrap();
    assert_eq!(chatserver::files::probe(&small_bytes), Some((64, 26)));
    assert_eq!(file(&base, &kai, &format!("/files/{id}?w=64"), &[("if-none-match", &shead("etag"))]).await.status().as_u16(), 304);
    let wide = file(&base, &kai, &format!("/files/{id}?w=1024"), &[]).await;
    assert_eq!(wide.headers()["x-image-level"], "original", "no wider than the picture: the original");

    // something a browser would run is kept as opaque bytes and handed over as a download
    let (_, page_up) = upload(&base, &ada, "chat", "page.html", "text/html", b"<script>alert(1)</script>".to_vec()).await;
    assert_eq!(page_up["file"]["mime"], "application/octet-stream");
    let dl = file(&base, &ada, page_up["file"]["url"].as_str().unwrap(), &[]).await;
    assert_eq!(dl.headers()["content-type"], "application/octet-stream");
    assert!(dl.headers()["content-disposition"].to_str().unwrap().starts_with("attachment"));
    assert!(dl.headers()["content-security-policy"].to_str().unwrap().contains("sandbox"));

    // at most twelve on a message, and only a list of ids
    let many: Vec<String> = (0..13).map(|_| id.clone()).collect();
    assert_eq!(call("POST", &base, &format!("/api/chat/channels/{dm_id}/messages"), &ada, Some(json!({ "text": "x", "files": many }))).await.0, 400);
    assert_eq!(call("POST", &base, &format!("/api/chat/channels/{dm_id}/messages"), &ada, Some(json!({ "text": "x", "files": "nope" }))).await.0, 400);
    assert_eq!(call("POST", &base, &format!("/api/chat/channels/{dm_id}/messages"), &ada, Some(json!({ "text": "x", "files": ["f_missing"] }))).await.0, 400);
    assert_eq!(call("POST", &base, &format!("/api/chat/channels/{dm_id}/messages"), &ada, Some(json!({ "text": "  " }))).await.0, 400, "no words and no files");

    // removing the messages that carry it: the rows and the file stay (archived, never deleted), its readers lose it
    let (_, gp) = call("GET", &base, &format!("/api/chat/channels/{general}/messages"), &kai, None).await;
    let passed_on = gp["messages"].as_array().unwrap().iter().find(|m| m["text"] == "for everyone").unwrap()["id"].as_str().unwrap().to_string();
    call("DELETE", &base, &format!("/api/chat/messages/{passed_on}"), &kai, Some(json!({ "confirm": true }))).await;
    let (_, gone) = call("DELETE", &base, &format!("/api/chat/messages/{mid}"), &ada, Some(json!({ "confirm": true }))).await;
    assert_eq!(gone["message"]["files"], json!([]));
    assert_eq!(file(&base, &kai, &format!("/files/{id}"), &[]).await.status().as_u16(), 404);
    assert_eq!(file(&base, &vic, &format!("/files/{id}"), &[]).await.status().as_u16(), 404);
    assert_eq!(file(&base, &ada, &format!("/files/{id}"), &[]).await.status().as_u16(), 200, "still its uploader's");
    let pool = sqlx::PgPool::connect(&db).await.unwrap();
    let (kept, size): (i64, i64) = sqlx::query_as("select count(*), coalesce(sum(octet_length(bytes)), 0)::bigint from chat_files where id = $1").bind(&id).fetch_one(&pool).await.unwrap();
    assert_eq!((kept, size), (1, bytes.len() as i64), "the file is kept");
    let (rows,): (i64,) = sqlx::query_as("select count(*) from chat_messages where id = any($1) and deleted_at is not null").bind(vec![mid, passed_on]).fetch_one(&pool).await.unwrap();
    assert_eq!(rows, 2, "and so are the messages' rows");
}

// ---------------------------------------------------------------- link previews (preview.rs)

/// a web site, for a test: a page with social tags, a GIF, a redirect to the page, one to a cloud's metadata
/// address, and one that never ends; `hits` counts every request that reached it
async fn web_standin() -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
    use axum::{Router, extract::State, http::{StatusCode, header}, response::IntoResponse, routing::get};
    use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};
    type Hits = Arc<AtomicUsize>;
    async fn page(State(h): State<Hits>, headers: axum::http::HeaderMap) -> impl IntoResponse {
        h.fetch_add(1, Ordering::SeqCst);
        // what the fetcher says of itself: what it is, and nothing of anyone
        assert_eq!(headers.get("user-agent").and_then(|v| v.to_str().ok()), Some("ChatForm link preview"));
        assert!(headers.get("cookie").is_none() && headers.get("authorization").is_none());
        (
            [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
            r#"<html><head><title>Plain title</title>
               <meta property="og:title" content="The kiln &amp; the glaze">
               <meta property="og:description" content="How Thursday's firing went.">
               <meta property="og:image" content="/kiln.jpg">
               <meta property="og:site_name" content="Form Notes">
               <meta name="twitter:card" content="summary_large_image"></head><body>…</body></html>"#,
        )
    }
    async fn gif(State(h): State<Hits>) -> impl IntoResponse {
        h.fetch_add(1, Ordering::SeqCst);
        ([(header::CONTENT_TYPE, "image/gif")], b"GIF89a".to_vec())
    }
    async fn hop(State(h): State<Hits>) -> impl IntoResponse {
        h.fetch_add(1, Ordering::SeqCst);
        (StatusCode::FOUND, [(header::LOCATION, "/page")])
    }
    async fn inside(State(h): State<Hits>) -> impl IntoResponse {
        h.fetch_add(1, Ordering::SeqCst);
        (StatusCode::FOUND, [(header::LOCATION, "http://169.254.169.254/latest/meta-data/")])
    }
    async fn around(State(h): State<Hits>) -> impl IntoResponse {
        h.fetch_add(1, Ordering::SeqCst);
        (StatusCode::FOUND, [(header::LOCATION, "/around")])
    }
    async fn quiet(State(h): State<Hits>) -> impl IntoResponse {
        h.fetch_add(1, Ordering::SeqCst);
        ([(header::CONTENT_TYPE, "text/html")], "<html><body>nothing to say</body></html>")
    }
    let hits: Hits = Arc::new(AtomicUsize::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let router = Router::new().route("/page", get(page)).route("/pic.gif", get(gif)).route("/hop", get(hop)).route("/inside", get(inside)).route("/around", get(around)).route("/quiet", get(quiet)).with_state(hits.clone());
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (format!("http://{addr}"), hits)
}

/// the fetcher alone, against the stand-in site: needs no Postgres
#[tokio::test]
async fn the_fetcher_reads_social_tags_follows_three_redirects_and_never_goes_inside() {
    use chatserver::preview::{Rules, link_preview};
    use std::sync::atomic::Ordering;
    let (site, hits) = web_standin().await;

    // the fetcher itself, with the test's loopback allowed: tags, a picture, a redirect followed and checked
    let dev = Rules { loopback: true };
    let card = link_preview(&format!("{site}/page"), dev).await.expect("a card");
    assert_eq!(card, json!({ "url": format!("{site}/page"), "title": "The kiln & the glaze", "description": "How Thursday's firing went.", "image": format!("{site}/kiln.jpg"), "site": "Form Notes" }));
    let pic = link_preview(&format!("{site}/pic.gif"), dev).await.expect("a picture");
    assert_eq!(pic, json!({ "url": format!("{site}/pic.gif"), "image": format!("{site}/pic.gif"), "site": "127.0.0.1" }));
    assert_eq!(link_preview(&format!("{site}/hop"), dev).await.expect("followed")["title"], "The kiln & the glaze");
    assert!(link_preview(&format!("{site}/quiet"), dev).await.is_none(), "a page that says nothing has no card");
    // a public-looking page that sends the fetcher inside: the hop is refused (even with the dev switch)
    assert!(link_preview(&format!("{site}/inside"), dev).await.is_none());
    // redirects stop at three
    let before = hits.load(Ordering::SeqCst);
    assert!(link_preview(&format!("{site}/around"), dev).await.is_none());
    assert_eq!(hits.load(Ordering::SeqCst) - before, 4, "the first request and three redirects, no more");
    // without the dev switch, loopback, private and metadata addresses are refused before any connection
    let before = hits.load(Ordering::SeqCst);
    for u in [format!("{site}/page"), site.replace("127.0.0.1", "localhost") + "/page", "http://10.0.0.1/".into(), "http://169.254.169.254/latest/meta-data/".into(), "http://[::1]/".into(), "ftp://example.com/".into()] {
        assert!(link_preview(&u, Rules::default()).await.is_none(), "{u}");
    }
    assert_eq!(hits.load(Ordering::SeqCst), before, "nothing reached the loopback site");
}

#[tokio::test]
async fn a_links_social_tags_become_a_card_and_a_private_address_is_never_fetched() {
    use chatserver::preview::{Rules, link_preview};
    use std::sync::atomic::Ordering;
    let Some(db) = fresh_db().await else { return };
    let (site, hits) = web_standin().await;
    let dev = Rules { loopback: true };
    let card = link_preview(&format!("{site}/page"), dev).await.expect("a card");
    let pic = link_preview(&format!("{site}/pic.gif"), dev).await.expect("a picture");

    // through ChatForm: a post answers at once, and the cards arrive as a change to the message
    let mut cfg = config(&db);
    cfg.preview_loopback = true;
    let base = serve(cfg).await;
    let ada = sign_in(&base, "ada@formindustries.co", "Ada").await;
    let kai = sign_in(&base, "kai@formindustries.co", "Kai").await;
    let (_, list) = call("GET", &base, "/api/chat", &ada, None).await;
    let general = list["channels"][0]["id"].as_str().unwrap().to_string();
    call("GET", &base, "/api/chat", &kai, None).await;
    let mut ks = socket(&base, &kai).await;
    until(&mut ks, |v| v["t"] == "hello").await.expect("hello");
    let text = format!("read {site}/page and see {site}/pic.gif, not `{site}/quiet`");
    let (s, posted) = call("POST", &base, &format!("/api/chat/channels/{general}/messages"), &ada, Some(json!({ "text": text }))).await;
    assert_eq!(s, 200);
    assert!(posted["message"].get("previews").is_none(), "the post doesn't wait for the web");
    let mid = posted["message"]["id"].as_str().unwrap().to_string();
    let changed = until(&mut ks, |v| v["t"] == "message-changed" && v["message"]["id"] == mid.as_str() && v["message"]["previews"].is_array()).await.expect("the cards arrive");
    let previews = changed["message"]["previews"].as_array().unwrap();
    assert_eq!(previews.len(), 2);
    assert_eq!(previews[0], card);
    assert_eq!(previews[1], pic);
    // an edit drops the old cards and reads the new links
    let (_, edited) = call("POST", &base, &format!("/api/chat/messages/{mid}"), &ada, Some(json!({ "text": format!("only {site}/hop now") }))).await;
    assert!(edited["message"].get("previews").is_none());
    let changed = until(&mut ks, |v| v["t"] == "message-changed" && v["message"]["previews"].is_array()).await.expect("the new card");
    assert_eq!(changed["message"]["previews"].as_array().unwrap().len(), 1);
    assert_eq!(changed["message"]["previews"][0]["url"], format!("{site}/hop"));
    // a removed message carries none
    let (_, gone) = call("DELETE", &base, &format!("/api/chat/messages/{mid}"), &ada, Some(json!({ "confirm": true }))).await;
    assert!(gone["message"].get("previews").is_none());

    // a server without the dev switch (as on Vercel): a link to this computer is never fetched, and the message has no card
    let plain = instance(&db).await;
    let before = hits.load(Ordering::SeqCst);
    let (_, p) = call("POST", &plain, &format!("/api/chat/channels/{general}/messages"), &ada, Some(json!({ "text": format!("{site}/page http://169.254.169.254/ http://192.168.1.1/admin") }))).await;
    let pid = p["message"]["id"].as_str().unwrap().to_string();
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(hits.load(Ordering::SeqCst), before, "the page was never asked for");
    let (_, page) = call("GET", &plain, &format!("/api/chat/channels/{general}/messages"), &ada, None).await;
    let m = page["messages"].as_array().unwrap().iter().find(|m| m["id"] == pid.as_str()).unwrap().clone();
    assert!(m.get("previews").is_none(), "{m}");
}

// ---------------------------------------------------------------- pins

#[tokio::test]
async fn a_member_pins_a_message_and_the_channel_says_so() {
    let Some(db) = fresh_db().await else { return };
    let base = instance(&db).await;
    let ada = sign_in(&base, "ada@formindustries.co", "Ada").await;
    let kai = sign_in(&base, "kai@formindustries.co", "Kai Moana").await;
    let vic = sign_in(&base, "vic@formindustries.co", "Vic").await;
    let (_, list) = call("GET", &base, "/api/chat", &ada, None).await;
    let general = list["channels"][0]["id"].as_str().unwrap().to_string();
    call("GET", &base, "/api/chat", &kai, None).await;
    let (_, a) = call("POST", &base, &format!("/api/chat/channels/{general}/messages"), &ada, Some(json!({ "text": "The kiln is on Thursdays" }))).await;
    let mid = a["message"]["id"].as_str().unwrap().to_string();
    assert_eq!(a["message"]["pinned"], false);

    let mut socket_ada = socket(&base, &ada).await;
    until(&mut socket_ada, |v| v["t"] == "hello").await.expect("hello");
    let (s, pinned) = call("POST", &base, &format!("/api/chat/messages/{mid}/pin"), &kai, Some(json!({ "on": true }))).await;
    assert_eq!(s, 200, "{pinned}");
    assert_eq!(pinned["message"]["pinned"], true);
    let heard = until(&mut socket_ada, |v| v["t"] == "channel" && v["channel"]["pinned"] == json!([mid])).await;
    assert!(heard.is_some(), "the channel's pinned list reaches its people");
    let (_, ch) = call("GET", &base, &format!("/api/chat/channels/{general}"), &ada, None).await;
    assert_eq!(ch["channel"]["pinned"], json!([mid]));
    let (_, page) = call("GET", &base, &format!("/api/chat/channels/{general}/messages"), &ada, None).await;
    let msgs = page["messages"].as_array().unwrap();
    assert_eq!(msgs[0]["pinned"], true);
    let line = msgs.last().unwrap();
    assert_eq!((line["type"].as_str(), line["text"].as_str(), line["author"]["kind"].as_str()), (Some("system"), Some("Kai Moana pinned a message."), Some("system")));
    // pinning again changes nothing (no second line); `on` left out means on
    let (_, again) = call("POST", &base, &format!("/api/chat/messages/{mid}/pin"), &ada, Some(json!({}))).await;
    assert_eq!(again["message"]["pinned"], true);
    let (_, page) = call("GET", &base, &format!("/api/chat/channels/{general}/messages"), &ada, None).await;
    assert_eq!(page["messages"].as_array().unwrap().len(), 2);

    // only someone in the channel pins; a private channel answers an outsider like a missing message's channel
    let (_, private) = call("POST", &base, "/api/chat/channels", &ada, Some(json!({ "kind": "private", "name": "glazes" }))).await;
    let pid = private["channel"]["id"].as_str().unwrap().to_string();
    let (_, pm) = call("POST", &base, &format!("/api/chat/channels/{pid}/messages"), &ada, Some(json!({ "text": "celadon recipe" }))).await;
    let pmid = pm["message"]["id"].as_str().unwrap().to_string();
    assert_eq!(call("POST", &base, &format!("/api/chat/messages/{pmid}/pin"), &kai, Some(json!({ "on": true }))).await.0, 404);
    // Vic can read #general without having joined it: pinning needs joining
    let (s, e) = call("POST", &base, &format!("/api/chat/messages/{mid}/pin"), &vic, Some(json!({ "on": false }))).await;
    assert_eq!(s, 403, "{e}");

    // unpin; and a removed message is no longer pinned
    let (_, off) = call("POST", &base, &format!("/api/chat/messages/{mid}/pin"), &ada, Some(json!({ "on": false }))).await;
    assert_eq!(off["message"]["pinned"], false);
    let (_, ch) = call("GET", &base, &format!("/api/chat/channels/{general}"), &ada, None).await;
    assert_eq!(ch["channel"]["pinned"], json!([]));
    call("POST", &base, &format!("/api/chat/messages/{mid}/pin"), &ada, Some(json!({ "on": true }))).await;
    call("DELETE", &base, &format!("/api/chat/messages/{mid}"), &ada, Some(json!({ "confirm": true }))).await;
    let (_, ch) = call("GET", &base, &format!("/api/chat/channels/{general}"), &ada, None).await;
    assert_eq!(ch["channel"]["pinned"], json!([]));
    assert_eq!(call("POST", &base, &format!("/api/chat/messages/{mid}/pin"), &ada, Some(json!({ "on": true }))).await.0, 409, "a removed message can't be pinned");
}

// ---------------------------------------------------------------- the mentions list

#[tokio::test]
async fn the_mentions_list_is_what_was_said_to_a_person_newest_first() {
    let Some(db) = fresh_db().await else { return };
    let base = instance(&db).await;
    let ada = sign_in(&base, "ada@formindustries.co", "Ada Lovelace").await;
    let kai = sign_in(&base, "kai@formindustries.co", "Kai Moana").await;
    let vic = sign_in(&base, "vic@formindustries.co", "Vic").await;
    let (_, list) = call("GET", &base, "/api/chat", &ada, None).await;
    let general = list["channels"][0]["id"].as_str().unwrap().to_string();
    call("GET", &base, "/api/chat", &kai, None).await;
    let say = |who: &'static str, channel: String, text: &'static str| {
        let (base, ada, kai, vic) = (base.clone(), Who { id: ada.id.clone(), token: ada.token.clone() }, Who { id: kai.id.clone(), token: kai.token.clone() }, Who { id: vic.id.clone(), token: vic.token.clone() });
        async move {
            let w = match who {
                "ada" => &ada,
                "kai" => &kai,
                _ => &vic,
            };
            let (s, m) = call("POST", &base, &format!("/api/chat/channels/{channel}/messages"), w, Some(json!({ "text": text }))).await;
            assert_eq!(s, 200, "{m}");
            tokio::time::sleep(Duration::from_millis(8)).await;
            m["message"]["id"].as_str().unwrap().to_string()
        }
    };
    let (_, dm) = call("POST", &base, "/api/chat/channels", &ada, Some(json!({ "kind": "dm", "members": [kai.id] }))).await;
    let dm_id = dm["channel"]["id"].as_str().unwrap().to_string();
    // a private channel Kai isn't in, and an open one Kai hasn't joined
    let (_, secret) = call("POST", &base, "/api/chat/channels", &ada, Some(json!({ "kind": "private", "name": "secret", "members": [vic.id] }))).await;
    let secret_id = secret["channel"]["id"].as_str().unwrap().to_string();
    let (_, open) = call("POST", &base, "/api/chat/channels", &ada, Some(json!({ "kind": "open", "name": "print-farm" }))).await;
    let open_id = open["channel"]["id"].as_str().unwrap().to_string();

    let by_name = say("ada", general.clone(), "@kai.moana the kiln moved").await;
    say("ada", general.clone(), "nothing to do with anyone").await;
    let everyone = say("vic", general.clone(), "@channel lunch").await;
    say("kai", general.clone(), "@kai.moana a note to myself, and @channel").await;
    let direct = say("ada", dm_id.clone(), "just saying hi").await;
    say("kai", dm_id.clone(), "hi back").await;
    say("vic", secret_id.clone(), "@kai.moana can't see this").await;
    say("ada", open_id.clone(), "@here in a channel Kai hasn't joined").await;
    let elsewhere = say("ada", open_id.clone(), "@kai.moana by name, where Kai can look").await;
    let removed = say("ada", general.clone(), "@kai.moana never mind").await;
    call("DELETE", &base, &format!("/api/chat/messages/{removed}"), &ada, Some(json!({ "confirm": true }))).await;

    let (s, got) = call("GET", &base, "/api/chat/mentions", &kai, None).await;
    assert_eq!(s, 200, "{got}");
    let ids: Vec<&str> = got["mentions"].as_array().unwrap().iter().map(|m| m["message"]["id"].as_str().unwrap()).collect();
    assert_eq!(ids, vec![elsewhere.as_str(), direct.as_str(), everyone.as_str(), by_name.as_str()], "newest first; not his own, a removed one, or one he can't see");
    let first = &got["mentions"][0];
    assert_eq!(first["channel"], json!({ "id": open_id, "name": "print-farm", "kind": "open" }));
    assert_eq!(first["message"]["author"]["id"], ada.id.as_str());
    assert_eq!(got["mentions"][1]["channel"]["kind"], "dm");
    assert_eq!(got["mentions"][1]["channel"]["name"], "Ada Lovelace, Kai Moana", "a direct message is named by its people");

    // a page at a time: `limit`, then `before` the oldest seen
    let (_, one) = call("GET", &base, "/api/chat/mentions?limit=1", &kai, None).await;
    assert_eq!(one["mentions"].as_array().unwrap().len(), 1);
    let at = got["mentions"][1]["message"]["createdAt"].as_i64().unwrap();
    let (_, older) = call("GET", &base, &format!("/api/chat/mentions?limit=100&before={at}"), &kai, None).await;
    let ids: Vec<&str> = older["mentions"].as_array().unwrap().iter().map(|m| m["message"]["id"].as_str().unwrap()).collect();
    assert_eq!(ids, vec![everyone.as_str(), by_name.as_str()]);
    let (_, capped) = call("GET", &base, "/api/chat/mentions?limit=5000", &kai, None).await;
    assert_eq!(capped["mentions"].as_array().unwrap().len(), 4);

    // Ada's are hers: Kai's reply in the DM and nothing of her own; Vic, who is in neither DM, sees no DM line
    let (_, hers) = call("GET", &base, "/api/chat/mentions", &ada, None).await;
    let texts: Vec<&str> = hers["mentions"].as_array().unwrap().iter().map(|m| m["message"]["text"].as_str().unwrap()).collect();
    assert_eq!(texts, vec!["hi back", "@kai.moana a note to myself, and @channel", "@channel lunch"]);
    let (_, vics) = call("GET", &base, "/api/chat/mentions", &vic, None).await;
    assert!(vics["mentions"].as_array().unwrap().iter().all(|m| m["channel"]["kind"] != "dm"));
    assert_eq!(reqwest::get(format!("{base}/api/chat/mentions")).await.unwrap().status().as_u16(), 401);
}

// ---------------------------------------------------------------- the sign-in exchange (exchange.rs), against a stand-in Google's keys

fn test_key() -> &'static rsa::RsaPrivateKey {
    static KEY: std::sync::OnceLock<rsa::RsaPrivateKey> = std::sync::OnceLock::new();
    KEY.get_or_init(|| rsa::RsaPrivateKey::new(&mut rand::thread_rng(), 2048).expect("a test key"))
}

fn b64(bytes: impl AsRef<[u8]>) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// an ID token as Google would sign it, by `key`, naming key `kid`
fn id_token(key: &rsa::RsaPrivateKey, kid: &str, claims: Value) -> String {
    use rsa::signature::{SignatureEncoding, Signer};
    let signed = format!("{}.{}", b64(json!({ "alg": "RS256", "kid": kid, "typ": "JWT" }).to_string()), b64(claims.to_string()));
    let sig = rsa::pkcs1v15::SigningKey::<rsa::sha2::Sha256>::new(key.clone()).sign(signed.as_bytes());
    format!("{signed}.{}", b64(sig.to_bytes()))
}

/// Google's published keys, for a test: one key, "standin-1"
async fn jwks_standin() -> String {
    use axum::{Json, Router, routing::get};
    use rsa::traits::PublicKeyParts;
    let key = test_key().to_public_key();
    let doc = json!({ "keys": [{ "kty": "RSA", "use": "sig", "alg": "RS256", "kid": "standin-1", "n": b64(key.n().to_bytes_be()), "e": b64(key.e().to_bytes_be()) }] });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, Router::new().route("/certs", get(move || { let doc = doc.clone(); async move { Json(doc) } }))).await.unwrap() });
    format!("http://{addr}/certs")
}

async fn exchange(base: &str, body: Value) -> (u16, Value) {
    let res = reqwest::Client::new().post(format!("{base}/auth/exchange")).json(&body).send().await.unwrap();
    let status = res.status().as_u16();
    (status, res.json().await.unwrap_or(Value::Null))
}

/// a running instance whose pool has never connected: for what the server decides before it needs its database
async fn instance_without_a_database(mut cfg: Config) -> String {
    cfg.database_url = "postgres://postgres@127.0.0.1:1/none".into();
    let pool = sqlx::postgres::PgPoolOptions::new().acquire_timeout(Duration::from_millis(300)).connect_lazy(&cfg.database_url).unwrap();
    let st = chatserver::state_with(cfg, pool).expect("state");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app(st).into_make_service_with_connect_info::<SocketAddr>()).await.unwrap() });
    format!("http://{addr}")
}

/// needs no Postgres: every route is there, says what the server has, and answers nobody who isn't signed in
#[tokio::test]
async fn the_new_routes_are_there_and_answer_only_the_signed_in() {
    let base = instance_without_a_database(config("unused")).await;
    let conf: Value = reqwest::get(format!("{base}/auth/config")).await.unwrap().json().await.unwrap();
    assert_eq!(conf["exchange"], false, "no Google client trusted: no exchange");
    assert_eq!(conf["features"], json!(["channels", "direct", "threads", "reactions", "search", "files", "pins", "previews", "mentions", "where"]));
    let c = reqwest::Client::new();
    for path in ["/files/f_0123456789abcdef", "/files/f_0123456789abcdef?w=64", "/api/chat/mentions", "/api/chat/mentions?limit=5&before=1", "/api/whereabouts"] {
        let res = c.get(format!("{base}{path}")).send().await.unwrap();
        assert_eq!(res.status().as_u16(), 401, "{path}");
    }
    for path in ["/api/files?board=chat&name=x.png", "/api/chat/messages/m_1/pin"] {
        let res = c.post(format!("{base}{path}")).header("content-type", "application/json").body("{}").send().await.unwrap();
        assert_eq!(res.status().as_u16(), 401, "{path}");
    }
    // another page (the Foundation app's window) may read a picture's level and size from the answer
    let pre = c.get(format!("{base}/auth/config")).header("origin", "http://localhost:31440").send().await.unwrap();
    let exposed = pre.headers().get("access-control-expose-headers").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    assert!(exposed.contains("x-image-level") && exposed.contains("etag"), "{exposed}");
}

/// needs no Postgres: the exchange decides who a token is before it touches the database
#[tokio::test]
async fn the_exchange_refuses_everything_that_isnt_googles_word_for_us() {
    let mut cfg = config("unused");
    cfg.google_client_id = Some("chatform-client".into());
    cfg.trusted_client_ids = vec!["foundation-client".into()];
    cfg.google_jwks_url = jwks_standin().await;
    let base = instance_without_a_database(cfg).await;
    let conf: Value = reqwest::get(format!("{base}/auth/config")).await.unwrap().json().await.unwrap();
    assert_eq!(conf["exchange"], true);

    let soon = chatserver::util::now_ms() / 1000 + 600;
    let good = || json!({ "iss": "https://accounts.google.com", "aud": "foundation-client", "exp": soon, "email": "ada@formindustries.co", "email_verified": true, "name": "Ada Lovelace" });
    let with = |k: &str, v: Value| {
        let mut c = good();
        c[k] = v;
        c
    };
    let key = test_key();
    let other_key = rsa::RsaPrivateKey::new(&mut rand::thread_rng(), 2048).unwrap();
    let unsigned = format!("{}.{}.", b64(json!({ "alg": "none", "kid": "standin-1" }).to_string()), b64(good().to_string()));
    let real = id_token(key, "standin-1", good());
    let parts: Vec<&str> = real.split('.').collect();
    let forged = format!("{}.{}.{}", parts[0], b64(with("email", json!("boss@formindustries.co")).to_string()), parts[2]);
    let refused: Vec<(&str, String)> = vec![
        ("made for another app", id_token(key, "standin-1", with("aud", json!("someone-elses-client")))),
        ("expired", id_token(key, "standin-1", with("exp", json!(soon - 4000)))),
        ("an unverified address", id_token(key, "standin-1", with("email_verified", json!(false)))),
        ("not from Google", id_token(key, "standin-1", with("iss", json!("https://accounts.example.com")))),
        ("off the allowlist", id_token(key, "standin-1", with("email", json!("mallory@elsewhere.example")))),
        ("signed by someone else, naming Google's key", id_token(&other_key, "standin-1", good())),
        ("signed with a key Google doesn't publish", id_token(&other_key, "unknown-key", good())),
        ("claims changed after Google signed", forged),
        ("not signed at all", unsigned),
    ];
    for (why, token) in &refused {
        let (s, e) = exchange(&base, json!({ "id_token": token })).await;
        assert_eq!(s, 401, "{why}: {e}");
        let words = e["error"].as_str().unwrap_or("");
        assert!(words.len() > 10 && e.get("session").is_none() && !words.contains(token.as_str()), "{why}: {e}");
    }
    // (the tenth try this minute) Google's own word for us passes every check: it stops only at the database this
    // test doesn't have, never at a refusal
    let (s, e) = exchange(&base, json!({ "id_token": real })).await;
    assert_eq!(s, 500, "{e}");
    assert!(e["error"].as_str().unwrap().contains("database"), "{e}");
    // and guessing is slowed: a few tries a minute from one address
    let mut slowed = false;
    for _ in 0..25 {
        let (s, e) = exchange(&base, json!({ "id_token": "x.y.z" })).await;
        if s == 429 {
            assert!(e["error"].as_str().unwrap().contains("minute"));
            slowed = true;
            break;
        }
        assert_eq!(s, 401);
    }
    assert!(slowed, "the limiter never spoke");
}

#[tokio::test]
async fn foundations_google_sign_in_signs_chatform_in_and_nothing_else_does() {
    let Some(db) = fresh_db().await else { return };
    let mut cfg = config(&db);
    cfg.google_client_id = Some("chatform-client".into());
    cfg.trusted_client_ids = vec!["foundation-client".into()];
    cfg.google_jwks_url = jwks_standin().await;
    let base = serve(cfg).await;
    let conf: Value = reqwest::get(format!("{base}/auth/config")).await.unwrap().json().await.unwrap();
    assert_eq!(conf["exchange"], true);
    for f in ["files", "pins", "previews", "mentions", "where"] {
        assert!(conf["features"].as_array().unwrap().iter().any(|x| x == f), "{f}");
    }

    let soon = chatserver::util::now_ms() / 1000 + 600;
    let good = || json!({ "iss": "https://accounts.google.com", "aud": "foundation-client", "exp": soon, "iat": soon - 660, "sub": "1234", "email": "Ada@FormIndustries.co", "email_verified": true, "name": "Ada Lovelace" });
    let with = |k: &str, v: Value| {
        let mut c = good();
        c[k] = v;
        c
    };
    let key = test_key();

    // a token Google signed, for Foundation's client, naming a verified address on the allowlist
    let (s, got) = exchange(&base, json!({ "id_token": id_token(key, "standin-1", good()) })).await;
    assert_eq!(s, 200, "{got}");
    assert_eq!((got["user"]["email"].as_str(), got["user"]["name"].as_str(), got["user"]["role"].as_str()), (Some("ada@formindustries.co"), Some("Ada Lovelace"), Some("member")));
    let who = Who { id: got["user"]["id"].as_str().unwrap().into(), token: got["session"].as_str().unwrap().into() };
    let (s, me) = call("GET", &base, "/api/me", &who, None).await;
    assert_eq!((s, me["user"]["id"].as_str()), (200, Some(who.id.as_str())), "the session is a bearer like any app's");
    let mut ws = socket(&base, &who).await;
    assert_eq!(until(&mut ws, |v| v["t"] == "hello").await.expect("hello")["you"], who.id.as_str());
    let pool = sqlx::PgPool::connect(&db).await.unwrap();
    let (plain,): (i64,) = sqlx::query_as("select count(*) from sessions where token_hash = $1").bind(&who.token).fetch_one(&pool).await.unwrap();
    assert_eq!(plain, 0, "only the session's hash is kept");

    // everything else is refused, 401, in words, and signs nobody in
    let (before,): (i64,) = sqlx::query_as("select count(*) from sessions").fetch_one(&pool).await.unwrap();
    let other_key = rsa::RsaPrivateKey::new(&mut rand::thread_rng(), 2048).unwrap();
    let unsigned = format!("{}.{}.", b64(json!({ "alg": "none", "kid": "standin-1" }).to_string()), b64(good().to_string()));
    let refused: Vec<(&str, String)> = vec![
        ("made for another app", id_token(key, "standin-1", with("aud", json!("someone-elses-client")))),
        ("expired", id_token(key, "standin-1", with("exp", json!(soon - 4000)))),
        ("an unverified address", id_token(key, "standin-1", with("email_verified", json!(false)))),
        ("not from Google", id_token(key, "standin-1", with("iss", json!("https://accounts.example.com")))),
        ("off the allowlist", id_token(key, "standin-1", with("email", json!("mallory@elsewhere.example")))),
        ("signed by someone else, naming Google's key", id_token(&other_key, "standin-1", good())),
        ("signed with a key Google doesn't publish", id_token(&other_key, "unknown-key", good())),
        ("not signed at all", unsigned),
    ];
    for (why, token) in &refused {
        let (s, e) = exchange(&base, json!({ "id_token": token })).await;
        assert_eq!(s, 401, "{why}: {e}");
        let words = e["error"].as_str().unwrap_or("");
        assert!(words.len() > 10 && e.get("session").is_none() && !words.contains(token.as_str()), "{why}: {e}");
    }
    // (the tenth try this minute) not a token at all
    assert_eq!(exchange(&base, json!({ "id_token": "not.a.token" })).await.0, 401);
    let (after,): (i64,) = sqlx::query_as("select count(*) from sessions").fetch_one(&pool).await.unwrap();
    assert_eq!(after, before);
    // and guessing is slowed: a few tries a minute from one address
    let mut slowed = false;
    for _ in 0..25 {
        let (s, e) = exchange(&base, json!({ "id_token": "x.y.z" })).await;
        if s == 429 {
            assert!(e["error"].as_str().unwrap().contains("minute"));
            slowed = true;
            break;
        }
        assert_eq!(s, 401);
    }
    assert!(slowed, "the limiter never spoke");

    // a server that trusts no Google client says so, and exchanges nothing
    let bare = instance(&db).await;
    let conf: Value = reqwest::get(format!("{bare}/auth/config")).await.unwrap().json().await.unwrap();
    assert_eq!(conf["exchange"], false);
    assert_eq!(exchange(&bare, json!({ "id_token": id_token(key, "standin-1", good()) })).await.0, 503);
}

#[tokio::test]
async fn a_token_altered_after_google_signed_it_is_refused() {
    let Some(db) = fresh_db().await else { return };
    let mut cfg = config(&db);
    cfg.trusted_client_ids = vec!["foundation-client".into()];
    cfg.google_jwks_url = jwks_standin().await;
    let base = serve(cfg).await;
    let soon = chatserver::util::now_ms() / 1000 + 600;
    let claims = |email: &str| json!({ "iss": "accounts.google.com", "aud": "foundation-client", "exp": soon, "email": email, "email_verified": true, "name": "Kai" });
    let token = id_token(test_key(), "standin-1", claims("kai@normallab.co"));
    // the same signature under other claims: someone else's address, signed for Kai
    let parts: Vec<&str> = token.split('.').collect();
    let forged = format!("{}.{}.{}", parts[0], b64(claims("boss@formindustries.co").to_string()), parts[2]);
    assert_eq!(exchange(&base, json!({ "id_token": forged })).await.0, 401);
    assert_eq!(exchange(&base, json!({})).await.0, 401);
    assert_eq!(exchange(&base, json!({ "id_token": "" })).await.0, 401);
    // untouched, it signs Kai in (this server has no Google client of its own: the trusted one is enough)
    let (s, got) = exchange(&base, json!({ "id_token": token })).await;
    assert_eq!((s, got["user"]["email"].as_str()), (200, Some("kai@normallab.co")));
}

// ---------------------------------------------------------------- who is where (whereabouts.rs)

async fn say(ws: &mut Sock, v: Value) {
    use futures_util::SinkExt;
    ws.send(Message::Text(v.to_string().into())).await.unwrap();
}

#[tokio::test]
async fn who_is_on_which_grid_reaches_everyone_signed_in_across_instances() {
    let Some(db) = fresh_db().await else { return };
    let a = instance(&db).await;
    let b = instance(&db).await;
    let ada = sign_in(&a, "ada@formindustries.co", "Ada Lovelace").await;
    let kai = sign_in(&b, "kai@formindustries.co", "Kai Moana").await;
    let (s, none) = call("GET", &b, "/api/whereabouts", &kai, None).await;
    assert_eq!((s, &none["boards"]), (200, &json!({})));
    assert_eq!(reqwest::get(format!("{b}/api/whereabouts")).await.unwrap().status().as_u16(), 401);

    let mut ada1 = socket(&a, &ada).await;
    let mut ada2 = socket(&a, &ada).await;
    let mut ks = socket(&b, &kai).await;
    for ws in [&mut ada1, &mut ada2, &mut ks] {
        until(ws, |v| v["t"] == "hello").await.expect("hello");
    }

    // Ada's window says which grid it has open; Kai, on another instance, hears it, named by her account
    say(&mut ada1, json!({ "t": "where", "board": "b_kiln", "name": "Kiln schedule", "user": "u_someone_else", "person": "Mallory" })).await;
    let heard = until(&mut ks, |v| v["t"] == "where" && v["boards"]["b_kiln"].is_object()).await.expect("Kai hears where Ada is");
    assert_eq!(heard["boards"], json!({ "b_kiln": { "name": "Kiln schedule", "agents": [], "people": [{ "id": ada.id, "name": "Ada Lovelace", "color": heard["boards"]["b_kiln"]["people"][0]["color"] }] } }));
    assert!(heard["rev"].as_u64().unwrap() >= 1);
    let (_, now) = call("GET", &b, "/api/whereabouts", &kai, None).await;
    assert_eq!(now["boards"], heard["boards"], "the first look says the same");

    // a second window on the same grid: she is there once; Kai joins her
    say(&mut ada2, json!({ "t": "where", "board": "b_kiln", "name": "Kiln schedule" })).await;
    say(&mut ks, json!({ "t": "where", "board": "b_kiln", "name": null })).await;
    let both = until(&mut ada1, |v| v["t"] == "where" && v["boards"]["b_kiln"]["people"].as_array().is_some_and(|p| p.len() == 2)).await.expect("Ada hears Kai arrive");
    let names: Vec<&str> = both["boards"]["b_kiln"]["people"].as_array().unwrap().iter().map(|p| p["name"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["Ada Lovelace", "Kai Moana"]);

    // one of her windows moves to another grid: she is on both; then it closes its grid
    say(&mut ada2, json!({ "t": "where", "board": "b_shop", "name": "Shop" })).await;
    let moved = until(&mut ks, |v| v["t"] == "where" && v["boards"]["b_shop"].is_object()).await.expect("moved");
    assert_eq!(moved["boards"]["b_kiln"]["people"].as_array().unwrap().len(), 2);
    say(&mut ada2, json!({ "t": "where", "board": null, "name": null })).await;
    until(&mut ks, |v| v["t"] == "where" && v["boards"].get("b_shop").is_none()).await.expect("b_shop empties");

    // her last window closes: she leaves the grid without saying so
    ada1.close(None).await.unwrap();
    let left = until(&mut ks, |v| v["t"] == "where" && v["boards"]["b_kiln"]["people"].as_array().is_some_and(|p| p.len() == 1)).await.expect("Ada left");
    assert_eq!(left["boards"]["b_kiln"]["people"][0]["id"], kai.id.as_str());

    // a dead instance's people fade: a row nobody has refreshed for a minute no longer counts
    let pool = sqlx::PgPool::connect(&db).await.unwrap();
    sqlx::query("insert into chat_where (conn_id, user_id, board, name, seen_at) values ('cc_dead', $1, 'b_ghost', 'Ghost', $2)").bind(&ada.id).bind(chatserver::util::now_ms() - 61_000).execute(&pool).await.unwrap();
    let (_, now) = call("GET", &a, "/api/whereabouts", &ada, None).await;
    assert!(now["boards"].get("b_ghost").is_none(), "{now}");
    assert!(now["boards"]["b_kiln"].is_object());
    sqlx::query("update chat_where set seen_at = $1 where conn_id = 'cc_dead'").bind(chatserver::util::now_ms()).execute(&pool).await.unwrap();
    let (_, now) = call("GET", &a, "/api/whereabouts", &ada, None).await;
    assert_eq!(now["boards"]["b_ghost"]["people"][0]["name"], "Ada Lovelace", "a fresh row counts, and is named by the account");
}
