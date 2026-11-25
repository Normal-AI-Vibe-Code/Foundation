use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};

#[derive(Debug)]
pub enum Error {
    /// an answer for the person: the status and what to say
    Http(StatusCode, String),
    Db(sqlx::Error),
    Other(String),
}

pub type Result<T> = std::result::Result<T, Error>;

pub fn http(status: StatusCode, msg: impl Into<String>) -> Error {
    Error::Http(status, msg.into())
}
pub fn bad(msg: impl Into<String>) -> Error {
    http(StatusCode::BAD_REQUEST, msg)
}
pub fn forbidden(msg: impl Into<String>) -> Error {
    http(StatusCode::FORBIDDEN, msg)
}
pub fn not_found(msg: impl Into<String>) -> Error {
    http(StatusCode::NOT_FOUND, msg)
}

impl From<sqlx::Error> for Error {
    fn from(e: sqlx::Error) -> Self {
        Error::Db(e)
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Http(s, m) => write!(f, "{s}: {m}"),
            Error::Db(e) => write!(f, "database: {e}"),
            Error::Other(m) => write!(f, "{m}"),
        }
    }
}
impl std::error::Error for Error {}

impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            Error::Http(s, m) => (s, m),
            Error::Db(e) => {
                eprintln!("database: {e}");
                (StatusCode::INTERNAL_SERVER_ERROR, "The chat server couldn't reach its database.".to_string())
            }
            Error::Other(m) => {
                eprintln!("error: {m}");
                (StatusCode::INTERNAL_SERVER_ERROR, "Something went wrong on the chat server.".to_string())
            }
        };
        (status, Json(serde_json::json!({ "error": msg }))).into_response()
    }
}
