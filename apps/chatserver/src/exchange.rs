//! The sign-in exchange: Foundation's own Google sign-in signs ChatForm in without a second round.
//!
//! `POST /auth/exchange` with `{ "id_token": "<Google's ID token>" }` answers `{ user, session }`: `session` is a
//! bearer, exactly as the app sign-in's poll gives one (`app_signin.rs`). The token is Google's word for who this
//! is, and it is checked as such:
//!
//! - **Signed by Google**: RS256, against Google's published keys (kept for an hour; fetched again, at most once a
//!   minute, when a token names a key this server hasn't seen). The keys' address is Google's own, always, on
//!   Vercel; only a local run with dev login and a stand-in Google (`CHATFORM_GOOGLE_STANDIN`) reads them elsewhere.
//! - **From Google**: `iss` is accounts.google.com. **Still good**: `exp` hasn't passed.
//! - **Made for us**: `aud` is this server's own `GOOGLE_CLIENT_ID` or one of `CHATFORM_TRUSTED_CLIENT_IDS`
//!   (Foundation's client). A token made for any other app is refused, however real it is.
//! - **A verified address**, and then the same allowlist and admin rules as any sign-in.
//!
//! Everything else is refused with 401 and a sentence. The token is never logged and never kept. A few tries a
//! minute per address, so nobody uses this to guess.

use std::{collections::HashMap, net::SocketAddr};

use axum::{
    Json,
    extract::{ConnectInfo, Request, State},
    http::StatusCode,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};

use crate::{
    St,
    auth::{create_session, upsert_user},
    error::{Error, Result, http},
    util::now_ms,
};

const KEYS_FRESH_MS: i64 = 3_600_000;
const KEYS_RETRY_MS: i64 = 60_000;
/// tries per address per minute, and for everyone together on one instance
const PER_ADDRESS: u32 = 10;
const PER_INSTANCE: u32 = 120;
const TOKEN_MAX: usize = 8 * 1024;

#[derive(Clone, Debug)]
pub struct Jwk {
    pub kid: String,
    pub n: Vec<u8>,
    pub e: Vec<u8>,
}

/// Google's keys as this instance last read them
#[derive(Default)]
pub struct Keys {
    pub keys: Vec<Jwk>,
    pub read_at: i64,
    pub tried_at: i64,
}

/// how many tries each address has made in the current minute
#[derive(Default)]
pub struct Limiter {
    minute: i64,
    seen: HashMap<String, u32>,
    all: u32,
}

impl Limiter {
    /// count one try by `who` at `now` (ms): may it go ahead
    pub fn allow(&mut self, who: &str, now: i64) -> bool {
        let minute = now / 60_000;
        if minute != self.minute {
            self.minute = minute;
            self.seen.clear();
            self.all = 0;
        }
        self.all += 1;
        let n = self.seen.entry(who.to_string()).or_insert(0);
        *n += 1;
        *n <= PER_ADDRESS && self.all <= PER_INSTANCE
    }
}

/// the RSA signing keys in a JWKS document
pub fn parse_jwks(v: &Value) -> Vec<Jwk> {
    let mut out = vec![];
    for k in v["keys"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
        if k["kty"] != "RSA" || k.get("use").is_some_and(|u| u != "sig") || k.get("alg").is_some_and(|a| a != "RS256") {
            continue;
        }
        let (Some(kid), Some(n), Some(e)) = (k["kid"].as_str(), k["n"].as_str(), k["e"].as_str()) else { continue };
        let (Ok(n), Ok(e)) = (URL_SAFE_NO_PAD.decode(n.trim_end_matches('=')), URL_SAFE_NO_PAD.decode(e.trim_end_matches('='))) else { continue };
        out.push(Jwk { kid: kid.to_string(), n, e });
    }
    out
}

pub struct Parts<'a> {
    pub kid: String,
    pub claims: Value,
    /// what was signed: the header and the payload as sent
    pub signed: &'a str,
    pub signature: Vec<u8>,
}

/// a compact JWT pulled apart; None unless it is three parts, an RS256 header naming a key, and a JSON payload
pub fn split(token: &str) -> Option<Parts<'_>> {
    let mut it = token.split('.');
    let (h, p, s) = (it.next()?, it.next()?, it.next()?);
    if it.next().is_some() || h.is_empty() || p.is_empty() || s.is_empty() {
        return None;
    }
    let header: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(h).ok()?).ok()?;
    // only RS256: never "none", never a key of the sender's choosing
    if header["alg"] != "RS256" {
        return None;
    }
    let kid = header["kid"].as_str()?.to_string();
    let claims: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(p).ok()?).ok()?;
    if !claims.is_object() {
        return None;
    }
    Some(Parts { kid, claims, signed: &token[..h.len() + 1 + p.len()], signature: URL_SAFE_NO_PAD.decode(s).ok()? })
}

/// is this signature Google's over these bytes, by this key (RSA PKCS#1 v1.5 with SHA-256, 2048 bits or more)
pub fn signed_by(key: &Jwk, signed: &[u8], signature: &[u8]) -> bool {
    ring::signature::RsaPublicKeyComponents { n: &key.n, e: &key.e }.verify(&ring::signature::RSA_PKCS1_2048_8192_SHA256, signed, signature).is_ok()
}

/// who a verified token names: the address and the name
#[derive(Debug, PartialEq, Eq)]
pub struct Person {
    pub email: String,
    pub name: String,
}

/// The claims of a token whose signature is already known to be Google's: from Google, made for one of
/// `audiences`, not expired at `now_s` (seconds), and naming a verified address. Else why not, in words.
pub fn check_claims(claims: &Value, audiences: &[String], now_s: i64) -> std::result::Result<Person, &'static str> {
    if !matches!(claims["iss"].as_str(), Some("accounts.google.com") | Some("https://accounts.google.com")) {
        return Err("This sign-in didn't come from Google.");
    }
    // one audience, a string: a token made for several apps is not one made for us
    let aud = claims["aud"].as_str().unwrap_or("");
    if aud.is_empty() || !audiences.iter().any(|a| a == aud) {
        return Err("This sign-in was made for another app, not for ChatForm.");
    }
    match claims["exp"].as_i64() {
        Some(exp) if exp > now_s => {}
        _ => return Err("This sign-in has expired. Sign in to Foundation again."),
    }
    let verified = claims["email_verified"].as_bool().unwrap_or_else(|| claims["email_verified"] == "true");
    let email = claims["email"].as_str().unwrap_or("").trim();
    if !verified || !email.contains('@') {
        return Err("Google didn't give a verified address for this account.");
    }
    Ok(Person { email: email.to_string(), name: claims["name"].as_str().unwrap_or("").to_string() })
}

fn refuse(words: impl Into<String>) -> Error {
    http(StatusCode::UNAUTHORIZED, words)
}

/// the key a token names, reading Google's keys when they're old or the key is new to this instance
async fn key_for(st: &St, kid: &str) -> Result<Option<Jwk>> {
    let mut keys = st.jwks.lock().await;
    let now = now_ms();
    let known = keys.keys.iter().find(|k| k.kid == kid).cloned();
    let stale = now - keys.read_at > KEYS_FRESH_MS;
    if (known.is_none() || stale) && now - keys.tried_at > KEYS_RETRY_MS {
        keys.tried_at = now;
        let got = async { st.http.get(&st.cfg.google_jwks_url).send().await?.error_for_status()?.json::<Value>().await }.await;
        match got {
            Ok(v) => {
                let read = parse_jwks(&v);
                if !read.is_empty() {
                    keys.keys = read;
                    keys.read_at = now;
                }
            }
            Err(e) => {
                eprintln!("google keys: {}", e.without_url());
                if known.is_none() {
                    return Err(http(StatusCode::SERVICE_UNAVAILABLE, "Google's signing keys couldn't be read just now. Try again in a minute."));
                }
            }
        }
    }
    Ok(keys.keys.iter().find(|k| k.kid == kid).cloned())
}

/// POST /auth/exchange { id_token } → { user, session }
pub async fn exchange(State(st): State<St>, req: Request) -> Result<Json<Value>> {
    let audiences = st.cfg.exchange_audiences();
    if audiences.is_empty() {
        return Err(http(StatusCode::SERVICE_UNAVAILABLE, "Signing in from Foundation isn't set up on this chat server (it needs a Google client id to trust)."));
    }
    // who is asking, for the limiter: the connection, or behind Vercel the address it forwards
    let who = req
        .headers()
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty() && st.cfg.on_vercel)
        .or_else(|| req.extensions().get::<ConnectInfo<SocketAddr>>().map(|c| c.0.ip().to_string()))
        .unwrap_or_else(|| "unknown".into());
    if !st.exchange_limit.lock().expect("limiter").allow(&who, now_ms()) {
        return Err(http(StatusCode::TOO_MANY_REQUESTS, "Too many sign-in tries. Wait a minute and try again."));
    }
    let bytes = axum::body::to_bytes(req.into_body(), TOKEN_MAX * 2).await.map_err(|_| refuse("That isn't a Google sign-in."))?;
    let body: Value = serde_json::from_slice(&bytes).map_err(|_| refuse("That isn't a Google sign-in."))?;
    let token = body["id_token"].as_str().unwrap_or("");
    if token.is_empty() || token.len() > TOKEN_MAX {
        return Err(refuse("That isn't a Google sign-in."));
    }
    let Some(parts) = split(token) else { return Err(refuse("That isn't a Google sign-in.")) };
    let Some(key) = key_for(&st, &parts.kid).await? else { return Err(refuse("This sign-in wasn't signed by Google.")) };
    if !signed_by(&key, parts.signed.as_bytes(), &parts.signature) {
        return Err(refuse("This sign-in wasn't signed by Google."));
    }
    let person = check_claims(&parts.claims, &audiences, now_ms() / 1000).map_err(refuse)?;
    if !st.cfg.allowed(&person.email) {
        return Err(refuse(format!("{} isn't on this server's list of who may sign in. Ask an admin.", person.email)));
    }
    let user = upsert_user(&st, &person.email, &person.name).await?;
    let session = create_session(&st, &user.id, "app").await?;
    Ok(Json(json!({ "user": user, "session": session })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claims() -> Value {
        json!({ "iss": "https://accounts.google.com", "aud": "foundation-client", "exp": 2_000, "email": "ada@formindustries.co", "email_verified": true, "name": "Ada Lovelace" })
    }
    fn ours() -> Vec<String> {
        vec!["chatform-client".into(), "foundation-client".into()]
    }

    #[test]
    fn a_good_token_names_its_person() {
        assert_eq!(check_claims(&claims(), &ours(), 1_000), Ok(Person { email: "ada@formindustries.co".into(), name: "Ada Lovelace".into() }));
        let mut c = claims();
        c["iss"] = json!("accounts.google.com");
        c["email_verified"] = json!("true");
        assert!(check_claims(&c, &ours(), 1_000).is_ok());
    }

    #[test]
    fn another_issuer_another_app_an_old_token_or_an_unverified_address_is_refused() {
        let with = |k: &str, v: Value| {
            let mut c = claims();
            c[k] = v;
            c
        };
        assert!(check_claims(&with("iss", json!("https://accounts.google.com.evil.example")), &ours(), 1_000).unwrap_err().contains("Google"));
        assert!(check_claims(&with("iss", Value::Null), &ours(), 1_000).is_err());
        assert!(check_claims(&with("aud", json!("someone-elses-app")), &ours(), 1_000).unwrap_err().contains("another app"));
        assert!(check_claims(&with("aud", json!(["foundation-client", "other"])), &ours(), 1_000).is_err(), "several audiences isn't ours");
        assert!(check_claims(&with("aud", json!("")), &ours(), 1_000).is_err());
        assert!(check_claims(&claims(), &[], 1_000).is_err(), "no audience trusted: nobody");
        assert!(check_claims(&claims(), &ours(), 2_000).unwrap_err().contains("expired"), "exp itself has passed");
        assert!(check_claims(&claims(), &ours(), 9_999).is_err());
        assert!(check_claims(&with("exp", Value::Null), &ours(), 1_000).is_err());
        assert!(check_claims(&with("exp", json!("2000")), &ours(), 1_000).is_err());
        assert!(check_claims(&with("email_verified", json!(false)), &ours(), 1_000).unwrap_err().contains("verified"));
        assert!(check_claims(&with("email_verified", Value::Null), &ours(), 1_000).is_err());
        assert!(check_claims(&with("email", json!("")), &ours(), 1_000).is_err());
    }

    #[test]
    fn only_an_rs256_token_naming_a_key_is_read() {
        let part = |v: Value| URL_SAFE_NO_PAD.encode(v.to_string());
        let token = |h: Value| format!("{}.{}.{}", part(h), part(claims()), URL_SAFE_NO_PAD.encode(b"sig"));
        let good = token(json!({ "alg": "RS256", "kid": "k1", "typ": "JWT" }));
        let p = split(&good).expect("read");
        assert_eq!(p.kid, "k1");
        assert_eq!(p.claims["email"], "ada@formindustries.co");
        assert_eq!(p.signed, good.rsplit_once('.').unwrap().0);
        assert_eq!(p.signature, b"sig");
        assert!(split(&token(json!({ "alg": "none", "kid": "k1" }))).is_none());
        assert!(split(&token(json!({ "alg": "HS256", "kid": "k1" }))).is_none());
        assert!(split(&token(json!({ "alg": "RS256" }))).is_none(), "no key named");
        assert!(split("a.b").is_none());
        assert!(split(&format!("{good}.more")).is_none());
        assert!(split("not a token").is_none());
        assert!(split(&format!("{}.{}.", part(json!({ "alg": "RS256", "kid": "k1" })), part(claims()))).is_none(), "unsigned");
    }

    #[test]
    fn keys_are_the_rsa_signing_ones_and_a_wrong_signature_is_not_googles() {
        let jwks = json!({ "keys": [
            { "kty": "RSA", "use": "sig", "alg": "RS256", "kid": "a", "n": "AQAB", "e": "AQAB" },
            { "kty": "EC", "kid": "b", "crv": "P-256" },
            { "kty": "RSA", "use": "enc", "kid": "c", "n": "AQAB", "e": "AQAB" },
            { "kty": "RSA", "kid": "d", "n": "!!", "e": "AQAB" },
        ] });
        let keys = parse_jwks(&jwks);
        assert_eq!(keys.iter().map(|k| k.kid.as_str()).collect::<Vec<_>>(), vec!["a"]);
        assert_eq!(keys[0].e, vec![1, 0, 1]);
        assert!(!signed_by(&keys[0], b"header.payload", b"not a signature"));
        assert!(parse_jwks(&json!({})).is_empty());
    }

    #[test]
    fn tries_are_counted_by_address_within_a_minute() {
        let mut l = Limiter::default();
        let t = 1_700_000_000_000;
        for _ in 0..PER_ADDRESS {
            assert!(l.allow("1.2.3.4", t));
        }
        assert!(!l.allow("1.2.3.4", t + 1_000), "the eleventh in a minute waits");
        assert!(l.allow("5.6.7.8", t + 1_000), "someone else isn't held up");
        assert!(l.allow("1.2.3.4", t + 61_000), "a new minute");
    }
}
