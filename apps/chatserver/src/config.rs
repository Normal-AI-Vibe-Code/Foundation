//! Settings, all from the environment (Vercel's project settings, or a shell locally).

fn env(k: &str) -> Option<String> {
    std::env::var(k).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}
fn list(k: &str) -> Vec<String> {
    env(k).map(|v| v.split(',').map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).collect()).unwrap_or_default()
}
fn origin_of(url: &str) -> Option<String> {
    let u = url::Url::parse(url).ok()?;
    Some(u.origin().ascii_serialization())
}

#[derive(Clone, Debug)]
pub struct Config {
    /// Postgres for queries (Neon's pooled address on Vercel)
    pub database_url: String,
    /// Postgres for LISTEN (a direct connection: a transaction pooler can't hold one); DATABASE_URL_UNPOOLED, else DATABASE_URL
    pub listen_url: String,
    /// where this server is reached: Google returns here, and the cookie's page is this origin
    pub public_url: String,
    pub google_client_id: Option<String>,
    pub google_client_secret: Option<String>,
    /// who may sign in: emails and @domains (CHATFORM_ALLOWLIST)
    pub allowlist: Vec<String>,
    /// who arrives as an admin (CHATFORM_ADMIN_EMAILS)
    pub admins: Vec<String>,
    /// email-only sign-in for local runs and tests; never on Vercel
    pub dev_login: bool,
    /// other pages that may use this server with credentials (the Foundation app's window, a dev client)
    pub cors_origins: Vec<String>,
    pub on_vercel: bool,
    pub port: u16,
    /// Google's three addresses: its sign-in page, its token exchange, and who the token is. Google's own, always, on
    /// Vercel; a local run with dev login may name a stand-in (CHATFORM_GOOGLE_STANDIN) so the sign-in can be walked
    pub google_auth_url: String,
    pub google_token_url: String,
    pub google_userinfo_url: String,
}

impl Config {
    pub fn from_env() -> Self {
        let on_vercel = env("VERCEL").is_some();
        let port = env("CHATFORM_PORT").and_then(|p| p.parse().ok()).unwrap_or(4420);
        let database_url = env("DATABASE_URL").or_else(|| env("POSTGRES_URL")).unwrap_or_else(|| "postgres://postgres@localhost:15432/chatform".into());
        let listen_url = env("DATABASE_URL_UNPOOLED").or_else(|| env("POSTGRES_URL_NON_POOLING")).unwrap_or_else(|| database_url.clone());
        let public_url = env("CHATFORM_PUBLIC_URL")
            .or_else(|| env("VERCEL_PROJECT_PRODUCTION_URL").map(|h| format!("https://{h}")))
            .unwrap_or_else(|| format!("http://localhost:{port}"));
        let dev_login = !on_vercel && env("CHATFORM_DEV_LOGIN").as_deref() == Some("1");
        let (google_auth_url, google_token_url, google_userinfo_url) = match env("CHATFORM_GOOGLE_STANDIN").filter(|_| dev_login) {
            Some(base) => {
                let b = base.trim_end_matches('/').to_string();
                (format!("{b}/auth"), format!("{b}/token"), format!("{b}/userinfo"))
            }
            None => Self::google_urls(),
        };
        Self {
            database_url,
            listen_url,
            public_url: public_url.trim_end_matches('/').to_string(),
            google_client_id: env("GOOGLE_CLIENT_ID"),
            google_client_secret: env("GOOGLE_CLIENT_SECRET"),
            allowlist: list("CHATFORM_ALLOWLIST"),
            admins: list("CHATFORM_ADMIN_EMAILS"),
            dev_login,
            cors_origins: list("CHATFORM_CORS_ORIGINS"),
            on_vercel,
            port,
            google_auth_url,
            google_token_url,
            google_userinfo_url,
        }
    }

    /// Google's own addresses (sign-in page, token exchange, userinfo)
    pub fn google_urls() -> (String, String, String) {
        ("https://accounts.google.com/o/oauth2/v2/auth".into(), "https://oauth2.googleapis.com/token".into(), "https://openidconnect.googleapis.com/v1/userinfo".into())
    }

    /// the pages that may call this server with credentials: its own, and the listed ones
    pub fn allowed_origins(&self) -> Vec<String> {
        let mut out: Vec<String> = origin_of(&self.public_url).into_iter().collect();
        for o in &self.cors_origins {
            if let Some(o) = origin_of(o)
                && !out.contains(&o) {
                    out.push(o);
                }
        }
        out
    }

    pub fn google_ready(&self) -> bool {
        self.google_client_id.is_some() && self.google_client_secret.is_some()
    }

    /// may this (verified) address sign in
    pub fn allowed(&self, email: &str) -> bool {
        let e = email.trim().to_lowercase();
        self.allowlist.iter().any(|a| if a.starts_with('@') { e.ends_with(a.as_str()) } else { *a == e })
    }

    pub fn is_admin_email(&self, email: &str) -> bool {
        let e = email.trim().to_lowercase();
        self.admins.contains(&e)
    }

    pub fn secure_cookie(&self) -> bool {
        self.public_url.starts_with("https://")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn cfg() -> Config {
        let (google_auth_url, google_token_url, google_userinfo_url) = Config::google_urls();
        Config {
            google_auth_url,
            google_token_url,
            google_userinfo_url,
            database_url: String::new(),
            listen_url: String::new(),
            public_url: "https://chatform.example.app".into(),
            google_client_id: None,
            google_client_secret: None,
            allowlist: vec!["@formindustries.co".into(), "@normallab.co".into(), "guest@gmail.com".into()],
            admins: vec!["boss@formindustries.co".into()],
            dev_login: false,
            cors_origins: vec!["http://localhost:31440".into(), "http://localhost:1430/".into()],
            on_vercel: true,
            port: 4420,
        }
    }
    #[test]
    fn the_allowlist_takes_domains_and_addresses_and_nothing_that_only_ends_alike() {
        let c = cfg();
        assert!(c.allowed("Josh@FormIndustries.co"));
        assert!(c.allowed("ada@normallab.co"));
        assert!(c.allowed("guest@gmail.com"));
        assert!(!c.allowed("other@gmail.com"));
        assert!(!c.allowed("x@notformindustries.com"));
        assert!(!c.allowed("x@formindustries.co.evil.com"));
    }
    #[test]
    fn origins_are_its_own_and_the_listed_ones() {
        assert_eq!(cfg().allowed_origins(), vec!["https://chatform.example.app", "http://localhost:31440", "http://localhost:1430"]);
    }
}
