//! Channels, direct messages, messages, threads, reactions, read marks and search: the Node server's routes and JSON
//! (`apps/server/src/chat.ts`), on Postgres.

use std::collections::HashMap;

use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    St,
    auth::{User, require_user},
    error::{Result, bad, forbidden, http, not_found},
    hub,
    util::{chat_handle, chat_slug, mention_handles, new_id, now_ms, snippet},
};

pub const TEXT_MAX: usize = 16_000;
const GENERAL: &str = "ch_general";

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct ChannelRow {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub topic: String,
    pub purpose: String,
    pub created_by: String,
    pub created_at: i64,
    pub archived_at: Option<i64>,
    pub last_seq: i64,
    pub last_post_at: i64,
    pub last_text: Option<String>,
}

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct MemberRow {
    pub user_id: String,
    pub read_seq: i64,
    pub notify: String,
    pub starred: bool,
    pub joined_at: i64,
}

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct MessageRow {
    pub id: String,
    pub channel_id: String,
    pub seq: i64,
    pub author_id: String,
    pub author_name: String,
    pub author_color: Option<String>,
    #[sqlx(rename = "type")]
    pub kind: String,
    pub text: String,
    pub root: Option<String>,
    pub created_at: i64,
    pub edited_at: Option<i64>,
    pub deleted_at: Option<i64>,
    pub reactions: Value,
    pub mentions: Value,
}

const CHANNEL_COLS: &str = "id, kind, name, topic, purpose, created_by, created_at, archived_at, last_seq, last_post_at, last_text";
const MESSAGE_COLS: &str = "id, channel_id, seq, author_id, author_name, author_color, type, text, root, created_at, edited_at, deleted_at, reactions, mentions";

/// only these are visible to everyone; every other kind reaches its members alone, admins included
pub fn is_open(kind: &str) -> bool {
    kind == "open"
}

pub async fn channel_row(st: &St, id: &str) -> Result<Option<ChannelRow>> {
    Ok(sqlx::query_as::<_, ChannelRow>(&format!("select {CHANNEL_COLS} from chat_channels where id = $1")).bind(id).fetch_optional(&st.db).await?)
}

pub async fn member_ids(st: &St, channel: &str) -> Result<Vec<String>> {
    let rows: Vec<(String,)> = sqlx::query_as("select user_id from chat_members where channel_id = $1").bind(channel).fetch_all(&st.db).await?;
    Ok(rows.into_iter().map(|r| r.0).collect())
}

async fn membership(st: &St, channel: &str, user: &str) -> Result<Option<MemberRow>> {
    Ok(sqlx::query_as::<_, MemberRow>("select user_id, read_seq, notify, starred, joined_at from chat_members where channel_id = $1 and user_id = $2").bind(channel).bind(user).fetch_optional(&st.db).await?)
}

/// may this person see this channel: an open one, or one they're in
pub async fn can_see(st: &St, user: &User, c: &ChannelRow) -> Result<bool> {
    if is_open(&c.kind) {
        return Ok(true);
    }
    Ok(membership(st, &c.id, &user.id).await?.is_some())
}

/// the channel, or "no such channel" for one this person can't see (its existence isn't confirmed to outsiders)
async fn require_channel(st: &St, user: &User, id: &str) -> Result<ChannelRow> {
    match channel_row(st, id).await? {
        Some(c) if can_see(st, user, &c).await? => Ok(c),
        _ => Err(not_found("no such channel")),
    }
}

fn person_party(id: &str, name: &str, color: Option<&str>) -> Value {
    let mut p = json!({ "kind": "person", "id": id, "name": name });
    if let Some(c) = color {
        p["color"] = json!(c);
    }
    p
}

/// the channel as one person's list shows it (ChatChannelView)
pub async fn channel_view(st: &St, user: &User, c: &ChannelRow) -> Result<Value> {
    let me = membership(st, &c.id, &user.id).await?;
    let count: (i64,) = sqlx::query_as("select count(*) from chat_members where channel_id = $1").bind(&c.id).fetch_one(&st.db).await?;
    let show_members = c.kind != "open" && (me.is_some() || c.kind != "private");
    let members: Option<Vec<Value>> = if show_members {
        let rows: Vec<(String, String, String)> = sqlx::query_as("select u.id, u.name, u.color from chat_members m join users u on u.id = m.user_id where m.channel_id = $1 order by m.joined_at").bind(&c.id).fetch_all(&st.db).await?;
        Some(rows.into_iter().map(|(id, name, color)| person_party(&id, &name, Some(&color))).collect())
    } else {
        None
    };
    let (me_json, unread) = match &me {
        Some(m) => {
            let mentions: (i64,) = sqlx::query_as("select count(*) from chat_messages where channel_id = $1 and seq > $2 and deleted_at is null and author_id <> $3 and (mentions ? $3 or mentions ? 'channel' or mentions ? 'here')")
                .bind(&c.id)
                .bind(m.read_seq)
                .bind(&user.id)
                .fetch_one(&st.db)
                .await?;
            let unread = match m.notify.as_str() {
                "none" => 0,
                "mentions" => mentions.0,
                _ => (c.last_seq - m.read_seq).max(0),
            };
            (json!({ "channel": c.id, "readSeq": m.read_seq, "mentions": mentions.0, "notify": m.notify, "starred": m.starred, "joinedAt": m.joined_at }), unread)
        }
        None => (Value::Null, 0),
    };
    let mut v = json!({
        "id": c.id, "kind": c.kind, "name": c.name, "topic": c.topic, "purpose": c.purpose,
        "createdBy": c.created_by, "createdAt": c.created_at, "archivedAt": c.archived_at,
        "lastSeq": c.last_seq, "lastPostAt": c.last_post_at, "memberCount": count.0,
        "huddle": null, "pinned": [], "me": me_json, "unread": unread,
    });
    if let Some(t) = &c.last_text {
        v["lastText"] = json!(t);
    }
    if let Some(m) = members {
        v["members"] = json!(m);
    }
    Ok(v)
}

/// messages as ChatForm reads them, with each thread's reply count, last reply and repliers
pub async fn messages_json(st: &St, rows: &[MessageRow]) -> Result<Vec<Value>> {
    let ids: Vec<String> = rows.iter().filter(|m| m.root.is_none()).map(|m| m.id.clone()).collect();
    let mut threads: HashMap<String, (i64, Option<i64>, Vec<String>)> = HashMap::new();
    if !ids.is_empty() {
        let stats: Vec<(String, i64, Option<i64>, Vec<String>)> = sqlx::query_as(
            "select root, count(*), max(created_at), (array_agg(distinct author_name))[1:5] from chat_messages where root = any($1) and deleted_at is null group by root",
        )
        .bind(&ids)
        .fetch_all(&st.db)
        .await?;
        for (root, n, last, who) in stats {
            threads.insert(root, (n, last, who));
        }
    }
    Ok(rows
        .iter()
        .map(|m| {
            let (n, last, who) = threads.get(&m.id).cloned().unwrap_or((0, None, vec![]));
            let gone = m.deleted_at.is_some();
            let mut v = json!({
                "id": m.id, "channel": m.channel_id, "seq": m.seq,
                "author": person_party(&m.author_id, &m.author_name, m.author_color.as_deref()),
                "type": m.kind, "text": if gone { "" } else { m.text.as_str() }, "root": m.root,
                "createdAt": m.created_at, "editedAt": m.edited_at, "deletedAt": m.deleted_at,
                "files": [], "reactions": if gone { json!([]) } else { m.reactions.clone() },
                "replyCount": n, "lastReplyAt": last, "pinned": false, "mentions": m.mentions,
            });
            if !who.is_empty() {
                v["repliers"] = json!(who);
            }
            if m.author_id == "system" {
                v["author"] = json!({ "kind": "system", "id": "system", "name": "ChatForm" });
            }
            v
        })
        .collect())
}

pub async fn message_row(st: &St, id: &str) -> Result<Option<MessageRow>> {
    Ok(sqlx::query_as::<_, MessageRow>(&format!("select {MESSAGE_COLS} from chat_messages where id = $1")).bind(id).fetch_optional(&st.db).await?)
}

pub async fn message_json(st: &St, id: &str) -> Result<Option<Value>> {
    let Some(row) = message_row(st, id).await? else { return Ok(None) };
    Ok(messages_json(st, &[row]).await?.pop())
}

async fn add_member(st: &St, channel: &str, user: &str) -> Result<bool> {
    let r = sqlx::query("insert into chat_members (channel_id, user_id, read_seq, joined_at) values ($1, $2, (select last_seq from chat_channels where id = $1), $3) on conflict do nothing")
        .bind(channel)
        .bind(user)
        .bind(now_ms())
        .execute(&st.db)
        .await?;
    Ok(r.rows_affected() == 1)
}

/// #general: made on first use, and every person is in it
async fn ensure_general(st: &St, user: &User) -> Result<()> {
    let now = now_ms();
    let made = sqlx::query("insert into chat_channels (id, kind, name, topic, purpose, created_by, created_at, last_post_at) values ($1, 'open', 'general', '', 'The whole company, in one place.', $2, $3, $3) on conflict (id) do nothing")
        .bind(GENERAL)
        .bind(&user.id)
        .bind(now)
        .execute(&st.db)
        .await?;
    if add_member(st, GENERAL, &user.id).await? && made.rows_affected() == 0 {
        hub::publish(st, json!({ "t": "member", "channel": GENERAL, "user": user.id, "joined": true })).await;
    }
    Ok(())
}

/// what the message's `@handle`s name: people by their handle, and "channel" or "here"
async fn mentions_in(st: &St, text: &str) -> Result<Vec<String>> {
    let handles = mention_handles(text);
    if handles.is_empty() {
        return Ok(vec![]);
    }
    let people: Vec<(String, String)> = sqlx::query_as("select id, name from users").fetch_all(&st.db).await?;
    let mut out = vec![];
    for h in handles {
        if h == "channel" || h == "here" {
            out.push(h);
        } else if let Some((id, _)) = people.iter().find(|(_, n)| chat_handle(n) == h)
            && !out.contains(id) {
                out.push(id.clone());
            }
    }
    Ok(out)
}

/// post a message: its place in the channel is the next seq, given in one statement so two at once never share one
pub async fn post(st: &St, c: &ChannelRow, author: &User, text: &str, root: Option<&str>, request_id: Option<&str>) -> Result<Value> {
    if let Some(rid) = request_id {
        let again: Option<(String,)> = sqlx::query_as("select id from chat_messages where author_id = $1 and request_id = $2").bind(&author.id).bind(rid).fetch_optional(&st.db).await?;
        if let Some((id,)) = again {
            return Ok(message_json(st, &id).await?.unwrap_or(Value::Null));
        }
    }
    if let Some(r) = root {
        match message_row(st, r).await? {
            Some(m) if m.channel_id == c.id && m.root.is_none() => {}
            _ => return Err(bad("root: a message in this channel that starts a thread")),
        }
    }
    let mentions = mentions_in(st, text).await?;
    let now = now_ms();
    let id = new_id("m");
    let mut tx = st.db.begin().await?;
    let (seq,): (i64,) = sqlx::query_as("update chat_channels set last_seq = last_seq + 1, last_post_at = $2, last_text = case when $3::text is null then $4 else last_text end where id = $1 returning last_seq")
        .bind(&c.id)
        .bind(now)
        .bind(root)
        .bind(snippet(text, 120))
        .fetch_one(&mut *tx)
        .await?;
    sqlx::query("insert into chat_messages (id, channel_id, seq, author_id, author_name, author_color, type, text, root, created_at, mentions, request_id) values ($1, $2, $3, $4, $5, $6, 'text', $7, $8, $9, $10, $11)")
        .bind(&id)
        .bind(&c.id)
        .bind(seq)
        .bind(&author.id)
        .bind(&author.name)
        .bind(&author.color)
        .bind(text)
        .bind(root)
        .bind(now)
        .bind(json!(mentions))
        .bind(request_id)
        .execute(&mut *tx)
        .await?;
    // the author has read what they wrote
    sqlx::query("update chat_members set read_seq = greatest(read_seq, $3) where channel_id = $1 and user_id = $2").bind(&c.id).bind(&author.id).bind(seq).execute(&mut *tx).await?;
    tx.commit().await?;
    hub::publish(st, json!({ "t": "message", "id": id, "requestId": request_id })).await;
    Ok(message_json(st, &id).await?.unwrap_or(Value::Null))
}

// ---------------------------------------------------------------- routes

pub async fn home(State(st): State<St>) -> Response {
    let html = format!(
        "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>ChatForm server</title><body style=\"font:15px/1.5 system-ui;max-width:34rem;margin:15vh auto;padding:0 1rem;color:#222\"><h1 style=\"font-size:20px\">ChatForm's server</h1><p>This is where Form Industries' ChatForm keeps its conversations. Open ChatForm in the Foundation app and point it at <code>{}</code>.</p><p><a href=\"/auth/google/start\">Sign in with Google</a> · <a href=\"/api/health\">health</a></p></body>",
        st.cfg.public_url
    );
    ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], html).into_response()
}

pub async fn health(State(st): State<St>) -> Json<Value> {
    let db = sqlx::query("select 1").execute(&st.db).await.is_ok();
    Json(json!({ "ok": db, "name": "ChatForm", "server": "chatform-rust", "version": env!("CARGO_PKG_VERSION"), "database": db, "listening": st.hub.listening(), "serves": ["chat"] }))
}

/// GET /api/chat: the channels this person can see, everyone, and who is online
pub async fn list(State(st): State<St>, headers: HeaderMap) -> Result<Json<Value>> {
    let user = require_user(&st, &headers).await?;
    ensure_general(&st, &user).await?;
    let rows: Vec<ChannelRow> = sqlx::query_as(&format!(
        "select {CHANNEL_COLS} from chat_channels c where c.kind = 'open' or exists (select 1 from chat_members m where m.channel_id = c.id and m.user_id = $1) order by last_post_at desc"
    ))
    .bind(&user.id)
    .fetch_all(&st.db)
    .await?;
    let mut channels = Vec::with_capacity(rows.len());
    for c in &rows {
        channels.push(channel_view(&st, &user, c).await?);
    }
    let people: Vec<(String, String, String)> = sqlx::query_as("select id, name, color from users order by name").fetch_all(&st.db).await?;
    let people: Vec<Value> = people.into_iter().map(|(id, name, color)| person_party(&id, &name, Some(&color))).collect();
    Ok(Json(json!({ "channels": channels, "people": people, "agents": [], "online": hub::online(&st).await? })))
}

#[derive(Deserialize)]
pub struct NewChannel {
    kind: Option<String>,
    name: Option<String>,
    topic: Option<String>,
    purpose: Option<String>,
    members: Option<Vec<String>>,
    request_id: Option<String>,
}

pub async fn create_channel(State(st): State<St>, headers: HeaderMap, Json(b): Json<NewChannel>) -> Result<Json<Value>> {
    let user = require_user(&st, &headers).await?;
    if user.role == "viewer" {
        return Err(forbidden("View only: your account can't make channels"));
    }
    let kind = b.kind.unwrap_or_default();
    let now = now_ms();
    let others: Vec<String> = b.members.unwrap_or_default().into_iter().filter(|m| m != &user.id).collect();
    // the people named must exist
    let known: Vec<(String,)> = sqlx::query_as("select id from users where id = any($1)").bind(&others).fetch_all(&st.db).await?;
    if known.len() != others.iter().collect::<std::collections::HashSet<_>>().len() {
        return Err(bad("members: people on this server"));
    }
    let id = match kind.as_str() {
        "dm" | "group" => {
            if others.is_empty() {
                return Err(bad("members: who the conversation is with"));
            }
            let mut all = others.clone();
            all.push(user.id.clone());
            all.sort();
            all.dedup();
            let key = all.join("__");
            let k = if all.len() > 2 { "group" } else { "dm" };
            let existing: Option<(String,)> = sqlx::query_as("select id from chat_channels where direct_key = $1").bind(&key).fetch_optional(&st.db).await?;
            match existing {
                Some((id,)) => id,
                None => {
                    let id = new_id("ch");
                    sqlx::query("insert into chat_channels (id, kind, created_by, created_at, last_post_at, direct_key) values ($1, $2, $3, $4, $4, $5) on conflict (direct_key) do nothing")
                        .bind(&id)
                        .bind(k)
                        .bind(&user.id)
                        .bind(now)
                        .bind(&key)
                        .execute(&st.db)
                        .await?;
                    let (id,): (String,) = sqlx::query_as("select id from chat_channels where direct_key = $1").bind(&key).fetch_one(&st.db).await?;
                    for m in &all {
                        add_member(&st, &id, m).await?;
                    }
                    id
                }
            }
        }
        "open" | "private" => {
            let name = chat_slug(b.name.as_deref().unwrap_or(""));
            if name.is_empty() {
                return Err(bad("a channel needs a name"));
            }
            let taken: Option<(String,)> = sqlx::query_as("select id from chat_channels where kind in ('open', 'private') and name = $1 and archived_at is null").bind(&name).fetch_optional(&st.db).await?;
            if taken.is_some() {
                return Err(http(StatusCode::CONFLICT, format!("#{name} is taken")));
            }
            let id = new_id("ch");
            sqlx::query("insert into chat_channels (id, kind, name, topic, purpose, created_by, created_at, last_post_at) values ($1, $2, $3, $4, $5, $6, $7, $7)")
                .bind(&id)
                .bind(&kind)
                .bind(&name)
                .bind(b.topic.unwrap_or_default().chars().take(250).collect::<String>())
                .bind(b.purpose.unwrap_or_default().chars().take(250).collect::<String>())
                .bind(&user.id)
                .bind(now)
                .execute(&st.db)
                .await?;
            add_member(&st, &id, &user.id).await?;
            for m in &others {
                add_member(&st, &id, m).await?;
            }
            id
        }
        _ => return Err(bad("kind: open, private, dm or group (agents and portals live on Foundation's own server)")),
    };
    let _ = b.request_id;
    hub::publish(&st, json!({ "t": "channel", "channel": id })).await;
    let c = channel_row(&st, &id).await?.ok_or_else(|| not_found("no such channel"))?;
    Ok(Json(json!({ "channel": channel_view(&st, &user, &c).await? })))
}

pub async fn get_channel(State(st): State<St>, headers: HeaderMap, Path(id): Path<String>) -> Result<Json<Value>> {
    let user = require_user(&st, &headers).await?;
    let c = require_channel(&st, &user, &id).await?;
    Ok(Json(json!({ "channel": channel_view(&st, &user, &c).await? })))
}

pub async fn join(State(st): State<St>, headers: HeaderMap, Path(id): Path<String>) -> Result<Json<Value>> {
    let user = require_user(&st, &headers).await?;
    let c = require_channel(&st, &user, &id).await?;
    if membership(&st, &c.id, &user.id).await?.is_none() {
        if !is_open(&c.kind) {
            return Err(forbidden("a member has to add you"));
        }
        if c.archived_at.is_some() {
            return Err(http(StatusCode::CONFLICT, "this channel is archived"));
        }
        add_member(&st, &c.id, &user.id).await?;
        hub::publish(&st, json!({ "t": "member", "channel": c.id, "user": user.id, "joined": true })).await;
    }
    let c = channel_row(&st, &id).await?.ok_or_else(|| not_found("no such channel"))?;
    Ok(Json(json!({ "channel": channel_view(&st, &user, &c).await? })))
}

pub async fn leave(State(st): State<St>, headers: HeaderMap, Path(id): Path<String>) -> Result<Json<Value>> {
    let user = require_user(&st, &headers).await?;
    let c = require_channel(&st, &user, &id).await?;
    if c.kind == "dm" || c.kind == "group" {
        return Err(bad("a direct message can't be left"));
    }
    sqlx::query("delete from chat_members where channel_id = $1 and user_id = $2").bind(&c.id).bind(&user.id).execute(&st.db).await?;
    hub::publish(&st, json!({ "t": "member", "channel": c.id, "user": user.id, "joined": false })).await;
    let view = if can_see(&st, &user, &c).await? { channel_view(&st, &user, &c).await? } else { Value::Null };
    Ok(Json(json!({ "channel": view })))
}

#[derive(Deserialize)]
pub struct PageQuery {
    before: Option<i64>,
    after: Option<i64>,
    since: Option<i64>,
    root: Option<String>,
    limit: Option<i64>,
}

pub async fn page(State(st): State<St>, headers: HeaderMap, Path(id): Path<String>, Query(q): Query<PageQuery>) -> Result<Json<Value>> {
    let user = require_user(&st, &headers).await?;
    let c = require_channel(&st, &user, &id).await?;
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let sel = format!("select {MESSAGE_COLS} from chat_messages");
    let (rows, before, after): (Vec<MessageRow>, bool, bool) = if let Some(root) = q.root.as_deref() {
        let rows = sqlx::query_as(&format!("{sel} where channel_id = $1 and (id = $2 or root = $2) order by seq")).bind(&c.id).bind(root).fetch_all(&st.db).await?;
        (rows, false, false)
    } else if let Some(after) = q.after.or(q.since) {
        let mut rows: Vec<MessageRow> = sqlx::query_as(&format!("{sel} where channel_id = $1 and root is null and seq > $2 order by seq limit $3")).bind(&c.id).bind(after).bind(limit + 1).fetch_all(&st.db).await?;
        let more = rows.len() as i64 > limit;
        rows.truncate(limit as usize);
        (rows, true, more)
    } else {
        let below = q.before.unwrap_or(i64::MAX);
        let mut rows: Vec<MessageRow> = sqlx::query_as(&format!("{sel} where channel_id = $1 and root is null and seq < $2 order by seq desc limit $3")).bind(&c.id).bind(below).bind(limit + 1).fetch_all(&st.db).await?;
        let more = rows.len() as i64 > limit;
        rows.truncate(limit as usize);
        rows.reverse();
        (rows, more, q.before.is_some())
    };
    Ok(Json(json!({ "messages": messages_json(&st, &rows).await?, "before": before, "after": after })))
}

#[derive(Deserialize)]
pub struct NewMessage {
    text: Option<String>,
    root: Option<String>,
    request_id: Option<String>,
    files: Option<Vec<Value>>,
}

pub async fn post_message(State(st): State<St>, headers: HeaderMap, Path(id): Path<String>, Json(b): Json<NewMessage>) -> Result<Json<Value>> {
    let user = require_user(&st, &headers).await?;
    let c = require_channel(&st, &user, &id).await?;
    if user.role == "viewer" {
        return Err(forbidden("View only: your account can't post"));
    }
    if c.archived_at.is_some() {
        return Err(http(StatusCode::CONFLICT, "this channel is archived"));
    }
    if b.files.as_ref().is_some_and(|f| !f.is_empty()) {
        return Err(bad("Files aren't kept on this chat server yet."));
    }
    let text = b.text.unwrap_or_default();
    if text.trim().is_empty() {
        return Err(bad("a message needs words"));
    }
    if text.chars().count() > TEXT_MAX {
        return Err(bad(format!("a message holds at most {TEXT_MAX} characters")));
    }
    if membership(&st, &c.id, &user.id).await?.is_none() {
        // posting in an open channel joins it
        add_member(&st, &c.id, &user.id).await?;
        hub::publish(&st, json!({ "t": "member", "channel": c.id, "user": user.id, "joined": true })).await;
    }
    let request_id = b.request_id.map(|r| r.chars().take(120).collect::<String>());
    let message = post(&st, &c, &user, &text, b.root.as_deref(), request_id.as_deref()).await?;
    Ok(Json(json!({ "message": message })))
}

#[derive(Deserialize)]
pub struct ReadMark {
    seq: Option<i64>,
}

pub async fn read(State(st): State<St>, headers: HeaderMap, Path(id): Path<String>, Json(b): Json<ReadMark>) -> Result<Json<Value>> {
    let user = require_user(&st, &headers).await?;
    let c = require_channel(&st, &user, &id).await?;
    let seq = b.seq.unwrap_or(c.last_seq).clamp(0, c.last_seq);
    sqlx::query("update chat_members set read_seq = greatest(read_seq, $3) where channel_id = $1 and user_id = $2").bind(&c.id).bind(&user.id).bind(seq).execute(&st.db).await?;
    let view = channel_view(&st, &user, &c).await?;
    let me = view["me"].clone();
    hub::publish(&st, json!({ "t": "read", "channel": c.id, "user": user.id, "readSeq": me["readSeq"], "mentions": me["mentions"] })).await;
    Ok(Json(json!({ "me": me })))
}

#[derive(Deserialize)]
pub struct Edit {
    text: Option<String>,
}

async fn own_message(st: &St, user: &User, id: &str) -> Result<(MessageRow, ChannelRow)> {
    let m = message_row(st, id).await?.ok_or_else(|| not_found("no such message"))?;
    let c = require_channel(st, user, &m.channel_id).await?;
    Ok((m, c))
}

pub async fn edit_message(State(st): State<St>, headers: HeaderMap, Path(id): Path<String>, Json(b): Json<Edit>) -> Result<Json<Value>> {
    let user = require_user(&st, &headers).await?;
    let (m, _) = own_message(&st, &user, &id).await?;
    if m.author_id != user.id {
        return Err(forbidden("only who wrote a message edits it"));
    }
    if m.deleted_at.is_some() {
        return Err(http(StatusCode::CONFLICT, "this message was removed"));
    }
    let text = b.text.unwrap_or_default();
    if text.trim().is_empty() || text.chars().count() > TEXT_MAX {
        return Err(bad(format!("a message holds 1 to {TEXT_MAX} characters")));
    }
    let mentions = mentions_in(&st, &text).await?;
    sqlx::query("update chat_messages set text = $2, edited_at = $3, mentions = $4 where id = $1").bind(&id).bind(&text).bind(now_ms()).bind(json!(mentions)).execute(&st.db).await?;
    hub::publish(&st, json!({ "t": "message-changed", "id": id })).await;
    Ok(Json(json!({ "message": message_json(&st, &id).await? })))
}

#[derive(Deserialize)]
pub struct Remove {
    confirm: Option<bool>,
}

/// removing keeps the row (a thread holds together) and needs `confirm: true`
pub async fn remove_message(State(st): State<St>, headers: HeaderMap, Path(id): Path<String>, body: Option<Json<Remove>>) -> Result<Json<Value>> {
    let user = require_user(&st, &headers).await?;
    let (m, _) = own_message(&st, &user, &id).await?;
    if body.and_then(|b| b.0.confirm) != Some(true) {
        return Err(bad("removing a message needs confirm: true"));
    }
    if m.author_id != user.id && user.role != "admin" {
        return Err(forbidden("only who wrote a message, or an admin, removes it"));
    }
    sqlx::query("update chat_messages set deleted_at = coalesce(deleted_at, $2), text = '', reactions = '[]' where id = $1").bind(&id).bind(now_ms()).execute(&st.db).await?;
    hub::publish(&st, json!({ "t": "message-changed", "id": id })).await;
    Ok(Json(json!({ "message": message_json(&st, &id).await? })))
}

#[derive(Deserialize)]
pub struct React {
    emoji: Option<String>,
}

/// a reaction by this person: on if it was off, off if it was on
pub async fn react(State(st): State<St>, headers: HeaderMap, Path(id): Path<String>, Json(b): Json<React>) -> Result<Json<Value>> {
    let user = require_user(&st, &headers).await?;
    let (m, _) = own_message(&st, &user, &id).await?;
    let emoji: String = b.emoji.unwrap_or_default().trim().chars().take(40).collect();
    if emoji.is_empty() || m.deleted_at.is_some() {
        return Err(bad("emoji: what to react with"));
    }
    let mut list: Vec<Value> = m.reactions.as_array().cloned().unwrap_or_default();
    let mut found = false;
    for r in list.iter_mut() {
        if r["emoji"] == json!(emoji) {
            found = true;
            let by = r["by"].as_array().cloned().unwrap_or_default();
            let mut names: Vec<Value> = by.into_iter().filter(|n| n != &json!(user.name)).collect();
            if names.len() == r["by"].as_array().map(|a| a.len()).unwrap_or(0) {
                names.push(json!(user.name));
            }
            r["by"] = json!(names);
        }
    }
    if !found {
        list.push(json!({ "emoji": emoji, "by": [user.name] }));
    }
    list.retain(|r| r["by"].as_array().is_some_and(|a| !a.is_empty()));
    sqlx::query("update chat_messages set reactions = $2 where id = $1").bind(&id).bind(json!(list)).execute(&st.db).await?;
    hub::publish(&st, json!({ "t": "message-changed", "id": id })).await;
    Ok(Json(json!({ "message": message_json(&st, &id).await? })))
}

#[derive(Deserialize)]
pub struct SearchQuery {
    q: Option<String>,
}

pub async fn search(State(st): State<St>, headers: HeaderMap, Query(q): Query<SearchQuery>) -> Result<Json<Value>> {
    let user = require_user(&st, &headers).await?;
    let needle = q.q.unwrap_or_default();
    let needle = needle.trim();
    if needle.chars().count() < 2 {
        return Ok(Json(json!({ "hits": [] })));
    }
    let like = format!("%{}%", needle.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
    let rows: Vec<MessageRow> = sqlx::query_as(&format!(
        "select {} from chat_messages m join chat_channels c on c.id = m.channel_id
         where m.deleted_at is null and m.text ilike $2
           and (c.kind = 'open' or exists (select 1 from chat_members x where x.channel_id = c.id and x.user_id = $1))
         order by m.created_at desc limit 50",
        MESSAGE_COLS.split(", ").map(|c| format!("m.{c}")).collect::<Vec<_>>().join(", ")
    ))
    .bind(&user.id)
    .bind(&like)
    .fetch_all(&st.db)
    .await?;
    let msgs = messages_json(&st, &rows).await?;
    let mut hits = vec![];
    for (row, m) in rows.iter().zip(msgs) {
        let Some(c) = channel_row(&st, &row.channel_id).await? else { continue };
        hits.push(json!({ "message": m, "channel": { "id": c.id, "name": c.name, "kind": c.kind }, "snippet": snippet(&row.text, 160) }));
    }
    Ok(Json(json!({ "hits": hits })))
}

/// grids live on Foundation's own server: nobody is on one here
pub async fn whereabouts(State(st): State<St>, headers: HeaderMap) -> Result<Json<Value>> {
    require_user(&st, &headers).await?;
    Ok(Json(json!({ "boards": {} })))
}
