//! Who is where, through this server. Teammates on different computers each run their own Foundation server, so a
//! grid's own presence never leaves the computer it is on; this server is where they can see each other.
//!
//! - **A window says** which grid it has open, on the chat socket: `{ t: "where", board: string | null, name:
//!   string | null }` (null when none; `name` is the grid's title, for people who don't have that grid). The board id
//!   is just a string the clients agree on. It is kept per connection (`chat_where`, one row a socket).
//! - **Everyone signed in hears** the protocol's `{ t: "where", rev, boards: Record<string, WhereBoard> }` when the
//!   list itself changes, gathered for a moment first (400 ms), and `GET /api/whereabouts` answers the same
//!   `{ boards }`. A person is there once per grid however many windows they have on it, and is named and coloured
//!   by their account, never by what a window claims. `agents` is always empty here: agents live on Foundation's own
//!   server. A board's `name` rides along beside `people` and `agents`.
//! - **Across instances**: a row carries a heartbeat. The instance holding a socket refreshes its rows every 20 s;
//!   a row not refreshed for 60 s no longer counts, so a dead instance's people fade within about a minute. Every
//!   instance looks again on its own heartbeat and tells its sockets if the picture changed.

use std::{collections::BTreeMap, sync::atomic::Ordering, time::Duration};

use axum::{Json, extract::State, http::HeaderMap};
use serde_json::{Map, Value, json};

use crate::{St, auth::require_user, error::Result, hub, util::now_ms};

/// a row not refreshed for this long is no longer there
pub const WHERE_MS: i64 = 60_000;
pub const HEARTBEAT: Duration = Duration::from_secs(20);
/// how long changes are gathered before anyone is told (a person arriving opens several sockets in a row)
pub const SETTLE: Duration = Duration::from_millis(400);
const TEXT_MAX: usize = 120;

/// what a window said, tidied: a board id (or none), and the grid's title
pub fn said(m: &Value) -> (Option<String>, Option<String>) {
    let clean = |v: &Value| v.as_str().map(|s| s.trim().chars().filter(|c| !c.is_control()).take(TEXT_MAX).collect::<String>()).filter(|s| !s.is_empty());
    let board = clean(&m["board"]);
    let name = if board.is_some() { clean(&m["name"]) } else { None };
    (board, name)
}

/// one socket's row: (board, the grid's title, user id, account name, account colour)
pub type Row = (String, Option<String>, String, String, String);
/// a grid being gathered: its title, and its people as (id, name, colour)
type Grid<'a> = (Option<&'a str>, Vec<(&'a str, &'a str, &'a str)>);

/// One row per connection → the picture: per grid, each person once (by account), sorted by name.
pub fn picture_of(rows: &[Row]) -> Value {
    let mut boards: BTreeMap<&str, Grid> = BTreeMap::new();
    for (board, title, id, name, color) in rows {
        let b = boards.entry(board.as_str()).or_default();
        // one title a grid, the same whichever row is read first
        if let Some(t) = title.as_deref()
            && b.0.is_none_or(|cur| t < cur)
        {
            b.0 = Some(t);
        }
        if !b.1.iter().any(|p| p.0 == id) {
            b.1.push((id, name, color));
        }
    }
    let mut out = Map::new();
    for (board, (title, mut people)) in boards {
        people.sort_by(|a, b| a.1.to_lowercase().cmp(&b.1.to_lowercase()).then(a.0.cmp(b.0)));
        let mut v = json!({
            "people": people.iter().map(|(id, name, color)| json!({ "id": id, "name": name, "color": color })).collect::<Vec<_>>(),
            "agents": [],
        });
        if let Some(t) = title {
            v["name"] = json!(t);
        }
        out.insert(board.to_string(), v);
    }
    Value::Object(out)
}

/// who is on which grid now, across every instance
pub async fn picture(st: &St) -> Result<Value> {
    let rows: Vec<Row> =
        sqlx::query_as("select w.board, w.name, u.id, u.name, u.color from chat_where w join users u on u.id = w.user_id where w.seen_at > $1 order by w.board, w.conn_id").bind(now_ms() - WHERE_MS).fetch_all(&st.db).await?;
    Ok(picture_of(&rows))
}

/// GET /api/whereabouts → { boards }
pub async fn route(State(st): State<St>, headers: HeaderMap) -> Result<Json<Value>> {
    require_user(&st, &headers).await?;
    Ok(Json(json!({ "boards": picture(&st).await? })))
}

/// a window says where it is (or that it is nowhere); every instance is told to look
pub async fn say(st: &St, conn_id: &str, user_id: &str, board: Option<&str>, name: Option<&str>) {
    let done = match board {
        Some(b) => sqlx::query("insert into chat_where (conn_id, user_id, board, name, seen_at) values ($1, $2, $3, $4, $5) on conflict (conn_id) do update set board = excluded.board, name = excluded.name, seen_at = excluded.seen_at")
            .bind(conn_id)
            .bind(user_id)
            .bind(b)
            .bind(name)
            .bind(now_ms())
            .execute(&st.db)
            .await,
        None => sqlx::query("delete from chat_where where conn_id = $1").bind(conn_id).execute(&st.db).await,
    };
    match done {
        Ok(_) => hub::publish(st, json!({ "t": "where" })).await,
        Err(e) => eprintln!("where: {e}"),
    }
}

/// something about who is where may have changed: once it settles, tell this instance's sockets if it did
pub fn may_have_changed(st: &St) {
    if st.hub.where_pending.swap(true, Ordering::SeqCst) {
        return;
    }
    let st = st.clone();
    tokio::spawn(async move {
        tokio::time::sleep(SETTLE).await;
        st.hub.where_pending.store(false, Ordering::SeqCst);
        tell_if_changed(&st).await;
    });
}

async fn tell_if_changed(st: &St) {
    let conns = st.hub.all();
    if conns.is_empty() {
        // nobody to tell; the next socket reads the picture itself
        *st.hub.where_last.lock().expect("where") = None;
        return;
    }
    let Ok(now) = picture(st).await else { return };
    let key = now.to_string();
    {
        let mut last = st.hub.where_last.lock().expect("where");
        if last.as_deref() == Some(key.as_str()) {
            return;
        }
        *last = Some(key);
    }
    for c in conns {
        c.send(json!({ "t": "where", "boards": now }));
    }
}

/// for as long as this instance runs: keep its sockets' rows fresh, drop long-dead rows, and notice people who faded
pub fn start_heartbeat(st: St) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(HEARTBEAT).await;
            let ids: Vec<String> = st.hub.all().iter().map(|c| c.id.clone()).collect();
            if ids.is_empty() {
                continue;
            }
            let now = now_ms();
            let _ = sqlx::query("update chat_where set seen_at = $2 where conn_id = any($1)").bind(&ids).bind(now).execute(&st.db).await;
            let _ = sqlx::query("delete from chat_where where seen_at < $1").bind(now - 10 * WHERE_MS).execute(&st.db).await;
            tell_if_changed(&st).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(board: &str, title: Option<&str>, id: &str, name: &str) -> Row {
        (board.into(), title.map(str::to_string), id.into(), name.into(), "#4a7bd0".into())
    }

    #[test]
    fn a_person_is_on_a_grid_once_however_many_windows_and_is_named_by_their_account() {
        let p = picture_of(&[
            row("b_kiln", Some("Kiln"), "u_kai", "Kai Moana"),
            row("b_kiln", None, "u_ada", "Ada Lovelace"),
            row("b_kiln", Some("Kiln"), "u_ada", "Ada Lovelace"),
            row("b_shop", None, "u_ada", "Ada Lovelace"),
        ]);
        assert_eq!(
            p,
            json!({
                "b_kiln": { "name": "Kiln", "agents": [], "people": [
                    { "id": "u_ada", "name": "Ada Lovelace", "color": "#4a7bd0" },
                    { "id": "u_kai", "name": "Kai Moana", "color": "#4a7bd0" },
                ] },
                "b_shop": { "agents": [], "people": [{ "id": "u_ada", "name": "Ada Lovelace", "color": "#4a7bd0" }] },
            })
        );
        assert_eq!(picture_of(&[]), json!({}));
        // the same rows in another order are the same picture: nothing to tell anyone
        let a = picture_of(&[row("b", Some("One"), "u1", "A"), row("b", Some("Two"), "u2", "B")]);
        let b = picture_of(&[row("b", Some("Two"), "u2", "B"), row("b", Some("One"), "u1", "A")]);
        assert_eq!(a.to_string(), b.to_string());
    }

    #[test]
    fn what_a_window_says_is_tidied() {
        assert_eq!(said(&json!({ "t": "where", "board": " b_kiln ", "name": "Kiln\u{7}" })), (Some("b_kiln".into()), Some("Kiln".into())));
        assert_eq!(said(&json!({ "t": "where", "board": null, "name": "Kiln" })), (None, None));
        assert_eq!(said(&json!({ "t": "where", "board": "", "name": null })), (None, None));
        assert_eq!(said(&json!({ "t": "where", "board": 7 })), (None, None));
        assert_eq!(said(&json!({ "t": "where", "board": "x".repeat(500) })).0.unwrap().len(), 120);
    }
}
