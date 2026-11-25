//! Who is connected to this instance, and how an event reaches every instance's sockets.
//!
//! On Vercel many instances run at once and a socket lives on one of them. A write anywhere is announced with
//! `pg_notify('chatform', …)` (a small JSON: what changed and its id, well under Postgres's 8000-byte payload);
//! every instance LISTENs and delivers it to its own sockets, reading what it needs from the database and
//! checking, socket by socket, that its person may see it. If the listener is down, this instance delivers its own
//! writes directly, so one instance alone (a local run) never loses an event.

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use serde_json::{Value, json};
use sqlx::postgres::PgListener;
use tokio::sync::mpsc;

use crate::{
    St,
    auth::User,
    chat::{can_see, channel_row, channel_view, is_open, member_ids, message_json},
    error::Result,
    util::now_ms,
};

/// a socket that hasn't said anything for this long is no longer online (the client pings every 25 s)
pub const ONLINE_MS: i64 = 90_000;
pub const CHANNEL: &str = "chatform";

pub struct Conn {
    pub id: String,
    pub user: User,
    tx: mpsc::UnboundedSender<String>,
    /// events on this socket count up by one from its hello (0); a gap tells the client to catch up
    rev: Mutex<u64>,
}

impl Conn {
    pub fn new(id: String, user: User, tx: mpsc::UnboundedSender<String>) -> Self {
        Self { id, user, tx, rev: Mutex::new(0) }
    }
    /// stamp the next rev and queue it, under one lock so revs leave in order
    pub fn send(&self, mut ev: Value) {
        let mut rev = self.rev.lock().expect("rev");
        *rev += 1;
        ev["rev"] = json!(*rev);
        let _ = self.tx.send(ev.to_string());
    }
}

#[derive(Default)]
pub struct Hub {
    conns: Mutex<HashMap<String, Arc<Conn>>>,
    listening: AtomicBool,
    /// who is where as this instance's sockets were last told (whereabouts.rs), and whether a look is already waiting
    pub where_last: Mutex<Option<String>>,
    pub where_pending: AtomicBool,
}

impl Hub {
    pub fn add(&self, c: Arc<Conn>) {
        self.conns.lock().expect("conns").insert(c.id.clone(), c);
    }
    pub fn remove(&self, id: &str) {
        self.conns.lock().expect("conns").remove(id);
    }
    pub fn all(&self) -> Vec<Arc<Conn>> {
        self.conns.lock().expect("conns").values().cloned().collect()
    }
    pub fn listening(&self) -> bool {
        self.listening.load(Ordering::Relaxed)
    }
    pub fn count(&self) -> usize {
        self.conns.lock().expect("conns").len()
    }
}

/// tell every instance (this one included) that something changed
pub async fn publish(st: &St, payload: Value) {
    if st.hub.listening() {
        match sqlx::query("select pg_notify($1, $2)").bind(CHANNEL).bind(payload.to_string()).execute(&st.db).await {
            Ok(_) => return,
            Err(e) => eprintln!("notify: {e}"),
        }
    }
    deliver(st, payload).await;
}

/// who is online: anyone with a socket on any instance that has spoken in the last 90 seconds
pub async fn online(st: &St) -> Result<Vec<String>> {
    let rows: Vec<(String,)> = sqlx::query_as("select distinct user_id from chat_online where seen_at > $1 order by user_id").bind(now_ms() - ONLINE_MS).fetch_all(&st.db).await?;
    Ok(rows.into_iter().map(|r| r.0).collect())
}

/// listen for every instance's events, for as long as this instance runs (reconnecting if the line drops)
pub fn start_listener(st: St) {
    tokio::spawn(async move {
        let mut wait = Duration::from_millis(500);
        loop {
            match PgListener::connect(&st.cfg.listen_url).await {
                Ok(mut l) => {
                    if let Err(e) = l.listen(CHANNEL).await {
                        eprintln!("listen: {e}");
                    } else {
                        st.hub.listening.store(true, Ordering::Relaxed);
                        wait = Duration::from_millis(500);
                        loop {
                            match l.recv().await {
                                Ok(n) => {
                                    if let Ok(v) = serde_json::from_str::<Value>(n.payload()) {
                                        let st = st.clone();
                                        tokio::spawn(async move { deliver(&st, v).await });
                                    }
                                }
                                Err(e) => {
                                    eprintln!("listener: {e}");
                                    break;
                                }
                            }
                        }
                        st.hub.listening.store(false, Ordering::Relaxed);
                    }
                }
                Err(e) => eprintln!("listener connect: {e}"),
            }
            tokio::time::sleep(wait).await;
            wait = (wait * 2).min(Duration::from_secs(30));
        }
    });
}

/// the sockets here whose person may see a channel of this kind with these members
fn visible(conns: &[Arc<Conn>], kind: &str, members: &[String]) -> Vec<Arc<Conn>> {
    conns.iter().filter(|c| is_open(kind) || members.contains(&c.user.id)).cloned().collect()
}

/// deliver one event to this instance's sockets
pub async fn deliver(st: &St, v: Value) {
    if let Err(e) = deliver_inner(st, &v).await {
        eprintln!("deliver {}: {e}", v["t"]);
    }
}

async fn deliver_inner(st: &St, v: &Value) -> Result<()> {
    let conns = st.hub.all();
    if conns.is_empty() {
        return Ok(());
    }
    let t = v["t"].as_str().unwrap_or("");
    match t {
        "message" | "message-changed" => {
            let id = v["id"].as_str().unwrap_or("");
            let Some(message) = message_json(st, id).await? else { return Ok(()) };
            let channel = message["channel"].as_str().unwrap_or("").to_string();
            let Some(c) = channel_row(st, &channel).await? else { return Ok(()) };
            let members = member_ids(st, &c.id).await?;
            let to = visible(&conns, &c.kind, &members);
            let mut ev = json!({ "t": t, "message": message });
            if let Some(r) = v["requestId"].as_str() {
                ev["requestId"] = json!(r);
            }
            for conn in &to {
                conn.send(ev.clone());
            }
            // a reply changes its thread's first message (its count, last reply, repliers)
            if let Some(root) = message["root"].as_str()
                && let Some(rm) = message_json(st, root).await? {
                    for conn in &to {
                        conn.send(json!({ "t": "message-changed", "message": rm }));
                    }
                }
            // and the channel's place in everyone's list
            if t == "message" {
                for conn in &to {
                    conn.send(json!({ "t": "channel", "channel": channel_view(st, &conn.user, &c).await? }));
                }
            }
        }
        "channel" => {
            let id = v["channel"].as_str().unwrap_or("");
            let Some(c) = channel_row(st, id).await? else { return Ok(()) };
            for conn in &conns {
                if can_see(st, &conn.user, &c).await? {
                    conn.send(json!({ "t": "channel", "channel": channel_view(st, &conn.user, &c).await? }));
                }
            }
        }
        "member" => {
            let channel = v["channel"].as_str().unwrap_or("");
            let user = v["user"].as_str().unwrap_or("");
            let Some(c) = channel_row(st, channel).await? else { return Ok(()) };
            let who: Option<(String, String, String)> = sqlx::query_as("select id, name, color from users where id = $1").bind(user).fetch_optional(&st.db).await?;
            let Some((id, name, color)) = who else { return Ok(()) };
            let party = json!({ "kind": "person", "id": id, "name": name, "color": color });
            let members = member_ids(st, &c.id).await?;
            for conn in visible(&conns, &c.kind, &members) {
                conn.send(json!({ "t": "member", "channel": c.id, "party": party, "joined": v["joined"] }));
            }
            // the person who joined or left: the channel as their list shows it now
            for conn in conns.iter().filter(|x| x.user.id == user) {
                if can_see(st, &conn.user, &c).await? {
                    conn.send(json!({ "t": "channel", "channel": channel_view(st, &conn.user, &c).await? }));
                } else {
                    conn.send(json!({ "t": "channel-gone", "channel": c.id }));
                }
            }
        }
        "read" => {
            let user = v["user"].as_str().unwrap_or("");
            for conn in conns.iter().filter(|c| c.user.id == user) {
                conn.send(json!({ "t": "read", "channel": v["channel"], "readSeq": v["readSeq"], "mentions": v["mentions"] }));
            }
        }
        "typing" => {
            let channel = v["channel"].as_str().unwrap_or("");
            let Some(c) = channel_row(st, channel).await? else { return Ok(()) };
            let members = member_ids(st, &c.id).await?;
            let from = v["party"]["id"].as_str().unwrap_or("");
            for conn in visible(&conns, &c.kind, &members).into_iter().filter(|c| c.user.id != from) {
                conn.send(json!({ "t": "typing", "channel": c.id, "root": v["root"], "party": v["party"] }));
            }
        }
        // who is where may have changed: looked at once it settles, and told only if the list is different
        "where" => crate::whereabouts::may_have_changed(st),
        "presence" => {
            let list = online(st).await?;
            for conn in &conns {
                conn.send(json!({ "t": "presence", "online": list }));
            }
        }
        _ => {}
    }
    Ok(())
}
