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
    Config {
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
    let st = state(config(db)).await.expect("state");
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
