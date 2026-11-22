use base64::Engine;
use rand::RngCore;
use sha2::{Digest, Sha256};

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// a secret for a session, a ticket or a sign-in's state: 32 random bytes
pub fn random_token() -> String {
    let mut b = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut b);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}

/// what is stored of a secret: its SHA-256 (the secret itself is never kept)
pub fn hash_token(t: &str) -> String {
    let d = Sha256::digest(t.as_bytes());
    d.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn new_id(prefix: &str) -> String {
    let mut b = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut b);
    format!("{prefix}_{}", b.iter().map(|x| format!("{x:02x}")).collect::<String>())
}

/// a person's colour, picked from their address so it stays the same everywhere
pub fn color_for(seed: &str) -> String {
    const COLORS: [&str; 8] = ["#e0564f", "#3f8f6b", "#4a7bd0", "#c9822b", "#8a5bc7", "#2f9aa6", "#c2477f", "#6b8f2f"];
    let h = seed.bytes().fold(7u32, |h, c| h.wrapping_mul(31).wrapping_add(c as u32));
    COLORS[(h % COLORS.len() as u32) as usize].to_string()
}

/// a channel's slug, as ChatForm makes it (packages/protocol chatSlug): lower case, letters, digits, _ and -
pub fn chat_slug(name: &str) -> String {
    let lower = name.trim().to_lowercase();
    let lower = lower.strip_prefix('#').unwrap_or(&lower);
    let mut out = String::new();
    let mut dash = false;
    for c in lower.chars() {
        if c.is_alphanumeric() || c == '_' || c == '-' {
            out.push(c);
            dash = false;
        } else if !dash {
            out.push('-');
            dash = true;
        }
    }
    let t = out.trim_matches('-');
    t.chars().take(80).collect()
}

/// a person's handle (packages/protocol chatHandle): "Josh Leong" → "josh.leong"
pub fn chat_handle(name: &str) -> String {
    let lower = name.trim().to_lowercase();
    let mut out = String::new();
    let mut space = false;
    for c in lower.chars() {
        if c.is_whitespace() {
            if !space && !out.is_empty() {
                out.push('.');
            }
            space = true;
            continue;
        }
        space = false;
        if c.is_alphanumeric() || c == '.' || c == '_' || c == '-' {
            out.push(c);
        }
    }
    if out.is_empty() { "someone".into() } else { out }
}

/// the `@handle`s in a text, outside code (packages/protocol chatMentionHandles), lower case
pub fn mention_handles(text: &str) -> Vec<String> {
    // drop fenced blocks and inline code first
    let mut plain = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find("```") {
        plain.push_str(&rest[..i]);
        match rest[i + 3..].find("```") {
            Some(j) => rest = &rest[i + 3 + j + 3..],
            None => {
                rest = "";
                break;
            }
        }
    }
    plain.push_str(rest);
    let mut no_code = String::with_capacity(plain.len());
    let mut in_code = false;
    for c in plain.chars() {
        if c == '`' {
            in_code = !in_code;
            no_code.push(' ');
        } else if c == '\n' {
            in_code = false;
            no_code.push(c);
        } else {
            no_code.push(if in_code { ' ' } else { c });
        }
    }
    let chars: Vec<char> = no_code.chars().collect();
    let mut out: Vec<String> = Vec::new();
    for i in 0..chars.len() {
        if chars[i] != '@' {
            continue;
        }
        if i > 0 {
            let p = chars[i - 1];
            if p.is_alphanumeric() || p == '_' || p == '@' || p == '.' || p == '/' {
                continue;
            }
        }
        let mut j = i + 1;
        if j >= chars.len() || !chars[j].is_alphanumeric() {
            continue;
        }
        let mut h = String::new();
        while j < chars.len() && (chars[j].is_alphanumeric() || chars[j] == '.' || chars[j] == '_' || chars[j] == '-') && h.chars().count() < 64 {
            h.push(chars[j]);
            j += 1;
        }
        let h = h.trim_end_matches('.').to_lowercase();
        if !h.is_empty() && !out.contains(&h) {
            out.push(h);
        }
    }
    out
}

/// a few words of a message for the list
pub fn snippet(text: &str, n: usize) -> String {
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= n { flat } else { format!("{}…", flat.chars().take(n).collect::<String>()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn slugs_and_handles_match_chatform() {
        assert_eq!(chat_slug("#Design Review!"), "design-review");
        assert_eq!(chat_slug("  --fan shroud--  "), "fan-shroud");
        assert_eq!(chat_handle("Josh Leong"), "josh.leong");
        assert_eq!(chat_handle("  Ada   Lovelace "), "ada.lovelace");
        assert_eq!(chat_handle("!!"), "someone");
    }
    #[test]
    fn mentions_skip_code_and_addresses() {
        assert_eq!(mention_handles("hey @josh.leong and @Ada, see @here."), vec!["josh.leong", "ada", "here"]);
        assert_eq!(mention_handles("mail me at x@y.com"), Vec::<String>::new());
        assert_eq!(mention_handles("`@nobody` and ```\n@nope\n``` but @kai"), vec!["kai"]);
    }
    #[test]
    fn a_secret_is_kept_only_as_its_hash() {
        let t = random_token();
        assert_eq!(t.len(), 43);
        assert_eq!(hash_token(&t).len(), 64);
        assert_ne!(hash_token(&t), t);
        assert_ne!(random_token(), t);
    }
}
