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
