//! The chat socket (`/chat`), as Foundation's: a `hello`, then every event the person may see, each with its `rev`.
//! The client says only `typing` and `ping`; everything that changes anything goes over HTTP.
//!
//! On Vercel a socket closes when the function reaches its time limit (300 s on Hobby); the client reconnects and
//! catches up from the list and the open channel, as it does after any drop.

use std::{collections::HashMap, sync::Arc};

use axum::{
    extract::{
        Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, StatusCode},
    response::Response,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::{
    St,
    auth::{User, require_user, spend_ticket},
    chat::{can_see, channel_row},
    error::{Result, http},
    hub::{self, Conn},
    util::{new_id, now_ms},
};

const TYPING_EVERY_MS: i64 = 3_000;

pub async fn upgrade(State(st): State<St>, headers: HeaderMap, Query(q): Query<HashMap<String, String>>, ws: WebSocketUpgrade) -> Result<Response> {
    // a ticket (a socket from another origin: the bearer can't ride it), else the cookie or a bearer header;
    // the cookie's Origin is checked before this (auth::cookie_origin_guard)
    let user = match q.get("ticket") {
        Some(t) => spend_ticket(&st, t, "/chat").await?.ok_or_else(|| http(StatusCode::UNAUTHORIZED, "This socket's ticket is used or expired."))?,
        None => require_user(&st, &headers).await?,
    };
    Ok(ws.on_upgrade(move |socket| run(st, user, socket)))
}

async fn run(st: St, user: User, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();
    let hello = json!({ "t": "hello", "rev": 0, "you": user.id, "at": now_ms() });
    if sink.send(Message::Text(hello.to_string().into())).await.is_err() {
        return;
    }
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let conn = Arc::new(Conn::new(new_id("cc"), user, tx));
    st.hub.add(conn.clone());
    let _ = sqlx::query("insert into chat_online (conn_id, user_id, seen_at) values ($1, $2, $3) on conflict (conn_id) do update set seen_at = excluded.seen_at").bind(&conn.id).bind(&conn.user.id).bind(now_ms()).execute(&st.db).await;
    conn.send(json!({ "t": "presence", "online": hub::online(&st).await.unwrap_or_default() }));
    hub::publish(&st, json!({ "t": "presence" })).await;

    let writer = tokio::spawn(async move {
        while let Some(s) = rx.recv().await {
            if sink.send(Message::Text(s.into())).await.is_err() {
                break;
            }
        }
    });

    let mut last_typing: HashMap<String, i64> = HashMap::new();
    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Text(t) => {
                let Ok(m) = serde_json::from_str::<Value>(t.as_str()) else { continue };
                match m["t"].as_str() {
                    Some("ping") => {
                        let _ = sqlx::query("update chat_online set seen_at = $2 where conn_id = $1").bind(&conn.id).bind(now_ms()).execute(&st.db).await;
                    }
                    Some("typing") => {
                        let Some(channel) = m["channel"].as_str() else { continue };
                        let root = m["root"].as_str().map(str::to_string);
                        let key = format!("{channel}/{}", root.clone().unwrap_or_default());
                        let now = now_ms();
                        if now - last_typing.get(&key).copied().unwrap_or(0) < TYPING_EVERY_MS {
                            continue;
                        }
                        last_typing.insert(key, now);
                        let Ok(Some(c)) = channel_row(&st, channel).await else { continue };
                        if c.archived_at.is_some() || !can_see(&st, &conn.user, &c).await.unwrap_or(false) {
                            continue;
                        }
                        let party = json!({ "kind": "person", "id": conn.user.id, "name": conn.user.name, "color": conn.user.color });
                        hub::publish(&st, json!({ "t": "typing", "channel": c.id, "root": root, "party": party })).await;
                    }
                    _ => {}
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    st.hub.remove(&conn.id);
    writer.abort();
    let _ = sqlx::query("delete from chat_online where conn_id = $1").bind(&conn.id).execute(&st.db).await;
    hub::publish(&st, json!({ "t": "presence" })).await;
}
