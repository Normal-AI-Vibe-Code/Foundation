//! Postgres: the pool, and the tables (made if missing at start; additive only, so an older instance still running
//! beside a newer one keeps working).

use sqlx::postgres::{PgPool, PgPoolOptions};

pub async fn connect(url: &str) -> Result<PgPool, sqlx::Error> {
    // few connections per instance: a serverless deployment has many instances, and Neon's pooler fans them in
    PgPoolOptions::new().max_connections(5).acquire_timeout(std::time::Duration::from_secs(10)).connect(url).await
}

pub const SCHEMA: &str = r#"
create table if not exists users (
  id text primary key,
  email text not null unique,
  name text not null,
  color text not null,
  role text not null default 'member',
  created_at bigint not null
);
create table if not exists sessions (
  token_hash text primary key,
  user_id text not null references users(id) on delete cascade,
  kind text not null,
  created_at bigint not null,
  expires_at bigint not null
);
create table if not exists oauth_states (
  state_hash text primary key,
  created_at bigint not null,
  expires_at bigint not null
);
create table if not exists ws_tickets (
  ticket_hash text primary key,
  user_id text not null references users(id) on delete cascade,
  path text not null,
  expires_at bigint not null
);
create table if not exists app_signins (
  state_hash text primary key,
  poll_hash text not null unique,
  code text not null,
  created_at bigint not null,
  expires_at bigint not null,
  used_at bigint,
  result_user_id text,
  result_error text,
  confirm_hash text,
  confirmed_at bigint
);
create table if not exists chat_channels (
  id text primary key,
  kind text not null,
  name text not null default '',
  topic text not null default '',
  purpose text not null default '',
  created_by text not null,
  created_at bigint not null,
  archived_at bigint,
  last_seq bigint not null default 0,
  last_post_at bigint not null,
  last_text text,
  direct_key text unique
);
create unique index if not exists chat_channels_open_name on chat_channels (name) where kind in ('open', 'private') and archived_at is null;
create table if not exists chat_members (
  channel_id text not null references chat_channels(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  read_seq bigint not null default 0,
  notify text not null default 'all',
  starred boolean not null default false,
  joined_at bigint not null,
  primary key (channel_id, user_id)
);
create table if not exists chat_messages (
  id text primary key,
  channel_id text not null references chat_channels(id),
  seq bigint not null,
  author_id text not null,
  author_name text not null,
  author_color text,
  type text not null default 'text',
  text text not null,
  root text,
  created_at bigint not null,
  edited_at bigint,
  deleted_at bigint,
  reactions jsonb not null default '[]',
  mentions jsonb not null default '[]',
  request_id text,
  unique (channel_id, seq)
);
create unique index if not exists chat_messages_request on chat_messages (author_id, request_id) where request_id is not null;
create index if not exists chat_messages_root on chat_messages (root) where root is not null;
create table if not exists chat_online (
  conn_id text primary key,
  user_id text not null,
  seen_at bigint not null
);
"#;

pub async fn migrate(db: &PgPool) -> Result<(), sqlx::Error> {
    // two instances starting at once mustn't race on the same create
    let mut tx = db.begin().await?;
    sqlx::query("select pg_advisory_xact_lock(4420)").execute(&mut *tx).await?;
    sqlx::raw_sql(SCHEMA).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}
