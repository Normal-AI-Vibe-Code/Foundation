//! Link previews: a message's first three web links, read for their social tags (Open Graph, Twitter Card, the
//! page's own title and description), after the post has answered. The shape is the Node server's
//! (`apps/server/src/chat.ts` linkPreview, `ChatLinkPreview`): `{ url, title?, description?, image?, site }`.
//!
//! **An invariant: a preview never fetches a private, loopback or link-local address.**
//! - http and https only, no name and password in the address, ports 80 and 443 only;
//! - the name is resolved first and *every* address it resolves to must be public (not private, loopback,
//!   link-local and cloud metadata, CGNAT, multicast, reserved, or one of those wrapped in IPv6); the connection is
//!   then pinned to the addresses that were checked, so a name can't answer differently the second time;
//! - redirects are followed by hand, at most three, each one checked the same way;
//! - five seconds for the whole thing, 512 KB of body, no cookies, no proxy, and a User-Agent that says what this
//!   is and nothing about anyone.
//!
//! A test's stand-in page is on loopback, on a port of its own: that is allowed only with the dev switch
//! (`Config::preview_loopback`: CHATFORM_PREVIEWS_LOOPBACK=1 together with dev login, never on Vercel), and then
//! only for loopback itself.

use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    time::Duration,
};

use serde_json::{Value, json};
use url::{Host, Url};

use crate::{St, hub, util::strip_code};

pub const TIMEOUT: Duration = Duration::from_secs(5);
pub const MAX_BYTES: usize = 512 * 1024;
pub const MAX_REDIRECTS: usize = 3;
pub const MAX_LINKS: usize = 3;
pub const USER_AGENT: &str = "ChatForm link preview";

/// what the fetcher may reach beyond the public internet (nothing, outside a test)
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Rules {
    /// loopback, on any port: a test's stand-in page
    pub loopback: bool,
}

fn v4_public(o: [u8; 4]) -> bool {
    let [a, b, c, _] = o;
    if a == 0 || a == 10 || a == 127 {
        return false;
    }
    if a == 100 && (64..=127).contains(&b) {
        return false; // CGNAT
    }
    if a == 169 && b == 254 {
        return false; // link-local, cloud metadata
    }
    if a == 172 && (16..=31).contains(&b) {
        return false;
    }
    if a == 192 && b == 168 {
        return false;
    }
    if a == 192 && b == 0 && (c == 0 || c == 2) {
        return false; // protocol assignments, documentation
    }
    if a == 192 && b == 88 && c == 99 {
        return false; // 6to4 relay anycast
    }
    if a == 198 && (b == 18 || b == 19) {
        return false; // benchmarking
    }
    if a == 198 && b == 51 && c == 100 {
        return false;
    }
    if a == 203 && b == 0 && c == 113 {
        return false;
    }
    if a >= 224 {
        return false; // multicast, reserved, broadcast
    }
    true
}

fn v6_public(g: [u16; 8]) -> bool {
    let v4of = |hi: u16, lo: u16| [(hi >> 8) as u8, (hi & 255) as u8, (lo >> 8) as u8, (lo & 255) as u8];
    if g[..5].iter().all(|x| *x == 0) && g[5] == 0xffff {
        return v4_public(v4of(g[6], g[7])); // ::ffff:a.b.c.d
    }
    if g[..6].iter().all(|x| *x == 0) {
        return false; // ::, ::1, ::a.b.c.d
    }
    if g[0] == 0x64 && g[1] == 0xff9b {
        return v4_public(v4of(g[6], g[7])); // NAT64
    }
    if g[0] == 0x2002 {
        return v4_public(v4of(g[1], g[2])); // 6to4
    }
    if (g[0] & 0xfe00) == 0xfc00 {
        return false; // unique local
    }
    if (g[0] & 0xffc0) == 0xfe80 || (g[0] & 0xffc0) == 0xfec0 {
        return false; // link-local, site-local
    }
    if (g[0] & 0xff00) == 0xff00 {
        return false; // multicast
    }
    if g[0] == 0x2001 && g[1] == 0x0db8 {
        return false; // documentation
    }
    if g[0] == 0x2001 && g[1] < 0x200 {
        return false; // Teredo, benchmarking, ORCHID
    }
    true
}

/// an address on the public internet
pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(a) => v4_public(a.octets()),
        IpAddr::V6(a) => v6_public(a.segments()),
    }
}

fn is_loopback(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(a) => a.is_loopback(),
        IpAddr::V6(a) => a == Ipv6Addr::LOCALHOST || a.to_ipv4_mapped().is_some_and(|m: Ipv4Addr| m.is_loopback()),
    }
}

/// may the fetcher connect to this address
pub fn address_allowed(ip: IpAddr, rules: Rules) -> bool {
    is_public(ip) || (rules.loopback && is_loopback(ip))
}

/// the address itself, before any name is looked up: http or https, nobody's name and password in it, and a host
pub fn url_allowed(u: &Url) -> bool {
    matches!(u.scheme(), "http" | "https") && u.username().is_empty() && u.password().is_none() && u.host().is_some()
}

/// may the fetcher use this port, given where the name led: 80 and 443, or any port of a test's loopback
pub fn port_allowed(port: u16, addrs: &[IpAddr], rules: Rules) -> bool {
    port == 80 || port == 443 || (rules.loopback && !addrs.is_empty() && addrs.iter().all(|a| is_loopback(*a)))
}

/// Where this address may be fetched from: every address its host resolves to, all of them allowed, and its port;
/// None when any part of it is refused.
pub async fn vet(u: &Url, rules: Rules) -> Option<(Vec<IpAddr>, u16)> {
    if !url_allowed(u) {
        return None;
    }
    let port = u.port_or_known_default()?;
    let addrs: Vec<IpAddr> = match u.host()? {
        Host::Ipv4(a) => vec![IpAddr::V4(a)],
        Host::Ipv6(a) => vec![IpAddr::V6(a)],
        Host::Domain(name) => {
            let found = tokio::net::lookup_host((name, port)).await.ok()?;
            let mut out: Vec<IpAddr> = vec![];
            for a in found {
                if !out.contains(&a.ip()) {
                    out.push(a.ip());
                }
            }
            out
        }
    };
    if addrs.is_empty() || addrs.iter().any(|a| !address_allowed(*a, rules)) || !port_allowed(port, &addrs, rules) {
        return None;
    }
    Some((addrs, port))
}

/// the first three http(s) links of a text, outside code
pub fn links_in(text: &str) -> Vec<String> {
    let plain = strip_code(text);
    let mut out: Vec<String> = vec![];
    let mut at = 0;
    while at < plain.len() {
        let rest = &plain[at..];
        let Some(i) = rest.find("http") else { break };
        let from = &rest[i..];
        let scheme = if from.starts_with("https://") {
            8
        } else if from.starts_with("http://") {
            7
        } else {
            at += i + 4;
            continue;
        };
        let end = from.char_indices().find(|(_, c)| c.is_whitespace() || matches!(c, '<' | '>' | '(' | ')' | '"' | '\'' | '`' | '[' | ']')).map(|(j, _)| j).unwrap_or(from.len());
        let link = from[..end].trim_end_matches(['.', ',', ';', ':', '!', '?', '*', '_', '~']);
        if link.len() > scheme && !out.iter().any(|o| o == link) {
            out.push(link.to_string());
            if out.len() >= MAX_LINKS {
                break;
            }
        }
        at += i + end.max(scheme);
    }
    out
}

fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        let Some(end) = tail.as_bytes().iter().take(12).position(|b| *b == b';') else {
            out.push('&');
            rest = &tail[1..];
            continue;
        };
        let name = &tail[1..end];
        let got = if let Some(hex) = name.strip_prefix("#x").or_else(|| name.strip_prefix("#X")) {
            u32::from_str_radix(hex, 16).ok().and_then(char::from_u32)
        } else if let Some(dec) = name.strip_prefix('#') {
            dec.parse::<u32>().ok().and_then(char::from_u32)
        } else {
            match name {
                "quot" => Some('"'),
                "apos" => Some('\''),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "nbsp" => Some(' '),
                "amp" => Some('&'),
                _ => None,
            }
        };
        match got {
            Some(c) => {
                out.push(c);
                rest = &tail[end + 1..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// a tag's attributes, names lower case: `name="…"`, `name='…'` or `name=word`
fn attributes(tag: &str) -> Vec<(String, String)> {
    let b = tag.as_bytes();
    let mut out = vec![];
    let mut i = 0;
    while i < b.len() {
        while i < b.len() && !(b[i].is_ascii_alphabetic()) {
            i += 1;
        }
        let start = i;
        while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b':' || b[i] == b'-' || b[i] == b'_') {
            i += 1;
        }
        if start == i {
            break;
        }
        let name = tag[start..i].to_ascii_lowercase();
        let mut j = i;
        while j < b.len() && b[j].is_ascii_whitespace() {
            j += 1;
        }
        if j >= b.len() || b[j] != b'=' {
            continue;
        }
        j += 1;
        while j < b.len() && b[j].is_ascii_whitespace() {
            j += 1;
        }
        if j >= b.len() {
            break;
        }
        let (value, next) = if b[j] == b'"' || b[j] == b'\'' {
            let q = b[j];
            let from = j + 1;
            let mut k = from;
            while k < b.len() && b[k] != q {
                k += 1;
            }
            (&tag[from..k], (k + 1).min(b.len()))
        } else {
            let from = j;
            let mut k = from;
            while k < b.len() && !b[k].is_ascii_whitespace() && b[k] != b'>' {
                k += 1;
            }
            (&tag[from..k], k)
        };
        out.push((name, value.to_string()));
        i = next;
    }
    out
}

fn clip(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// A page's social tags as a preview: Open Graph first, then Twitter Card, then the page's own title and
/// description. None when it has neither a title nor a description. `url` is where the page was finally read.
pub fn parse_open_graph(html: &str, url: &Url) -> Option<Value> {
    let lower = html.to_ascii_lowercase();
    let mut meta: Vec<(String, String)> = vec![];
    let mut at = 0;
    while let Some(i) = lower[at..].find("<meta") {
        let start = at + i + 5;
        let Some(end) = lower[start..].find('>') else { break };
        // "<metadata>" isn't a meta tag
        if html[start..].starts_with(|c: char| c.is_whitespace() || c == '/') {
            let attrs = attributes(&html[start..start + end]);
            let get = |k: &str| attrs.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
            let key = get("property").or_else(|| get("name")).unwrap_or("").to_lowercase();
            if let Some(content) = get("content")
                && !key.is_empty()
                && !meta.iter().any(|(k, _)| *k == key)
            {
                meta.push((key, decode_entities(content).trim().to_string()));
            }
        }
        at = start + end + 1;
    }
    let tag = |k: &str| meta.iter().find(|(n, v)| n == k && !v.is_empty()).map(|(_, v)| v.clone());
    let title_tag = lower.find("<title").and_then(|i| {
        let open = i + lower[i..].find('>')? + 1;
        let close = open + lower[open..].find("</title>")?;
        Some(decode_entities(&html[open..close]).split_whitespace().collect::<Vec<_>>().join(" "))
    });
    let title = tag("og:title").or_else(|| tag("twitter:title")).or(title_tag.filter(|t| !t.is_empty())).unwrap_or_default();
    let description = tag("og:description").or_else(|| tag("twitter:description")).or_else(|| tag("description")).unwrap_or_default();
    if title.is_empty() && description.is_empty() {
        return None;
    }
    let image = tag("og:image")
        .or_else(|| tag("og:image:url"))
        .or_else(|| tag("og:image:secure_url"))
        .or_else(|| tag("twitter:image"))
        .or_else(|| tag("twitter:image:src"))
        .and_then(|raw| url.join(&raw).ok())
        .filter(|u| matches!(u.scheme(), "http" | "https"));
    let mut p = json!({ "url": url.as_str() });
    if !title.is_empty() {
        p["title"] = json!(clip(&title, 200));
    }
    if !description.is_empty() {
        p["description"] = json!(clip(&description, 400));
    }
    if let Some(i) = image {
        p["image"] = json!(i.as_str());
    }
    p["site"] = json!(clip(&tag("og:site_name").unwrap_or_else(|| url.host_str().unwrap_or("").to_string()), 80));
    Some(p)
}

/// is this content type a picture a chat can show in place (a GIF included; never SVG, which is a document)
pub fn is_picture_type(content_type: &str) -> bool {
    let m = content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    matches!(m.as_str(), "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/avif")
}

struct Got {
    status: u16,
    location: Option<String>,
    content_type: String,
    body: Vec<u8>,
}

/// one request, to addresses already checked: no redirects followed, no cookies, no proxy, the body capped
async fn get_once(u: &Url, addrs: &[IpAddr], port: u16, left: Duration) -> Option<Got> {
    let mut b = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).no_proxy().timeout(left).connect_timeout(left).user_agent(USER_AGENT);
    // the connection goes to what was checked: the name isn't looked up a second time
    if let Some(Host::Domain(name)) = u.host() {
        let socks: Vec<SocketAddr> = addrs.iter().map(|a| SocketAddr::new(*a, port)).collect();
        b = b.resolve_to_addrs(name, &socks);
    }
    let client = b.build().ok()?;
    let mut res = client.get(u.clone()).header("accept", "text/html,application/xhtml+xml;q=0.9,image/*;q=0.8,*/*;q=0.1").send().await.ok()?;
    let status = res.status().as_u16();
    let head = |k: &str| res.headers().get(k).and_then(|v| v.to_str().ok()).map(str::to_string);
    let content_type = head("content-type").unwrap_or_default();
    let location = head("location");
    let mut body = vec![];
    if status == 200 && content_type.to_ascii_lowercase().contains("html") {
        while let Ok(Some(chunk)) = res.chunk().await {
            let room = MAX_BYTES - body.len();
            body.extend_from_slice(&chunk[..chunk.len().min(room)]);
            if body.len() >= MAX_BYTES {
                break;
            }
        }
    }
    Some(Got { status, location, content_type, body })
}

async fn fetch(raw: &str, rules: Rules) -> Option<Value> {
    let mut url = Url::parse(raw).ok()?;
    let deadline = tokio::time::Instant::now() + TIMEOUT;
    for _hop in 0..=MAX_REDIRECTS {
        // every hop is checked as the first was: a public page may not send the fetcher inside
        let (addrs, port) = vet(&url, rules).await?;
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        if left.is_zero() {
            return None;
        }
        let got = get_once(&url, &addrs, port, left).await?;
        if (300..400).contains(&got.status) {
            url = url.join(got.location.as_deref()?).ok()?;
            continue;
        }
        if got.status != 200 {
            return None;
        }
        if is_picture_type(&got.content_type) {
            return Some(json!({ "url": raw, "image": url.as_str(), "site": clip(url.host_str().unwrap_or(""), 80) }));
        }
        if got.body.is_empty() {
            return None;
        }
        let mut p = parse_open_graph(&String::from_utf8_lossy(&got.body), &url)?;
        p["url"] = json!(raw);
        return Some(p);
    }
    None
}

/// one link's preview, or None: refused, unreachable, too slow, or a page that says nothing about itself
pub async fn link_preview(raw: &str, rules: Rules) -> Option<Value> {
    tokio::time::timeout(TIMEOUT, fetch(raw, rules)).await.ok().flatten()
}

/// After a message is posted or its words change: read its links and, if any say something, keep the previews on
/// the message and tell its readers (`message-changed`). The message must still say what it said when this began.
pub fn queue(st: &St, id: &str, text: &str) {
    if !st.cfg.previews {
        return;
    }
    let urls = links_in(text);
    if urls.is_empty() {
        return;
    }
    let (st, id, text) = (st.clone(), id.to_string(), text.to_string());
    let rules = Rules { loopback: st.cfg.preview_loopback };
    tokio::spawn(async move {
        let mut previews = vec![];
        for got in futures_util::future::join_all(urls.iter().map(|u| link_preview(u, rules))).await.into_iter().flatten() {
            previews.push(got);
        }
        if previews.is_empty() {
            return;
        }
        let done = sqlx::query("update chat_messages set previews = $2 where id = $1 and deleted_at is null and text = $3").bind(&id).bind(json!(previews)).bind(&text).execute(&st.db).await;
        if matches!(done, Ok(r) if r.rows_affected() == 1) {
            hub::publish(&st, json!({ "t": "message-changed", "id": id })).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn private_loopback_link_local_cgnat_multicast_and_metadata_addresses_are_never_public() {
        for a in [
            "127.0.0.1", "127.8.9.1", "0.0.0.0", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.1", "192.168.1.1", "169.254.169.254", "169.254.0.1",
            "100.64.0.1", "100.127.255.254", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255", "192.0.0.1", "192.0.2.1", "198.18.0.1", "198.51.100.7",
            "203.0.113.9", "192.88.99.1",
            "::", "::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "::10.0.0.1", "fc00::1", "fd12:3456::1", "fe80::1", "fec0::1", "ff02::1",
            "2001:db8::1", "2001::1", "64:ff9b::10.0.0.1", "64:ff9b::7f00:1", "2002:0a00:0001::1", "2002:7f00:0001::1", "2002:a9fe:a9fe::1",
        ] {
            assert!(!is_public(ip(a)), "{a} must not be fetched");
            assert!(!address_allowed(ip(a), Rules::default()), "{a} must not be fetched");
        }
        for a in ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.0.1", "172.32.0.1", "100.63.0.1", "100.128.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808"] {
            assert!(is_public(ip(a)), "{a} is public");
        }
    }

    #[test]
    fn a_tests_loopback_is_the_only_thing_the_dev_switch_opens() {
        let dev = Rules { loopback: true };
        assert!(address_allowed(ip("127.0.0.1"), dev));
        assert!(address_allowed(ip("::1"), dev));
        for a in ["10.0.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "fe80::1", "fd00::1", "0.0.0.0"] {
            assert!(!address_allowed(ip(a), dev), "{a} stays refused with the dev switch");
        }
        // ports: 80 and 443 for everyone; another port only on a test's loopback
        assert!(port_allowed(443, &[ip("8.8.8.8")], Rules::default()));
        assert!(port_allowed(80, &[ip("8.8.8.8")], Rules::default()));
        assert!(!port_allowed(8080, &[ip("8.8.8.8")], Rules::default()));
        assert!(!port_allowed(22, &[ip("8.8.8.8")], dev));
        assert!(!port_allowed(6379, &[ip("127.0.0.1")], Rules::default()));
        assert!(port_allowed(18080, &[ip("127.0.0.1")], dev));
        assert!(!port_allowed(18080, &[ip("127.0.0.1"), ip("8.8.8.8")], dev));
    }

    #[test]
    fn only_plain_web_addresses_are_fetched() {
        let ok = |s: &str| url_allowed(&Url::parse(s).unwrap());
        assert!(ok("https://example.com/a"));
        assert!(ok("http://example.com"));
        assert!(!ok("ftp://example.com/x"));
        assert!(!ok("file:///etc/passwd"));
        assert!(!ok("https://user:pw@example.com/"));
        assert!(!ok("https://user@example.com/"));
        assert!(!ok("data:text/html,hi"));
    }

    #[tokio::test]
    async fn an_address_written_oddly_is_still_the_address_it_is() {
        let none = Rules::default();
        for u in [
            "http://127.0.0.1/", "http://localhost/", "http://2130706433/", "http://0x7f.0.0.1/", "http://017700000001/", "http://[::1]/", "http://[::ffff:127.0.0.1]/",
            "http://169.254.169.254/latest/meta-data/", "http://10.0.0.5/", "http://192.168.0.1:80/", "http://[fe80::1]/", "https://8.8.8.8:8443/", "http://8.8.8.8:22/",
        ] {
            assert!(vet(&Url::parse(u).unwrap(), none).await.is_none(), "{u} must be refused");
        }
        let (addrs, port) = vet(&Url::parse("https://8.8.8.8/").unwrap(), none).await.expect("a public address on 443");
        assert_eq!((addrs, port), (vec![ip("8.8.8.8")], 443));
        // the dev switch opens loopback (a stand-in page on its own port) and nothing else
        let dev = Rules { loopback: true };
        assert!(vet(&Url::parse("http://127.0.0.1:18080/page").unwrap(), dev).await.is_some());
        assert!(vet(&Url::parse("http://10.0.0.5:18080/page").unwrap(), dev).await.is_none());
        assert!(vet(&Url::parse("http://169.254.169.254/").unwrap(), dev).await.is_none());
    }

    #[test]
    fn links_are_the_first_three_outside_code() {
        assert_eq!(links_in("see https://a.example/x, and (http://b.example/y?z=1)."), vec!["https://a.example/x", "http://b.example/y?z=1"]);
        assert_eq!(links_in("`https://no.example` ```\nhttps://nor.example\n``` https://yes.example"), vec!["https://yes.example"]);
        assert_eq!(links_in("https://1.example https://2.example https://1.example https://3.example https://4.example"), vec!["https://1.example", "https://2.example", "https://3.example"]);
        assert_eq!(links_in("http and https:// alone, httpd, no links"), Vec::<String>::new());
        assert_eq!(links_in("naïve café https://é.example/ü!"), vec!["https://é.example/ü"]);
    }

    #[test]
    fn social_tags_are_read_open_graph_first() {
        let url = Url::parse("https://shop.example/things/kiln").unwrap();
        let html = r#"<!doctype html><html><head><title> The  Kiln
            page </title>
            <meta name="description" content="plain description">
            <meta property="og:title" content="Kiln &amp; Co &#8212; fired">
            <meta property='og:description' content='Hot &quot;stuff&quot;'>
            <meta content="/img/kiln.png" property="og:image">
            <meta property=og:site_name content=Shop>
            <meta name="twitter:title" content="tw title">
            <metadata property="og:title" content="not a meta tag">
            </head><body>hi</body></html>"#;
        let p = parse_open_graph(html, &url).unwrap();
        assert_eq!(p, json!({ "url": "https://shop.example/things/kiln", "title": "Kiln & Co — fired", "description": "Hot \"stuff\"", "image": "https://shop.example/img/kiln.png", "site": "Shop" }));
    }

    #[test]
    fn twitter_cards_and_the_plain_page_are_read_when_there_is_no_open_graph() {
        let url = Url::parse("https://blog.example/post").unwrap();
        let tw = r#"<META NAME="twitter:title" CONTENT="Card title"><meta name="twitter:description" content="Card words"><meta name="twitter:image" content="https://cdn.example/c.jpg">"#;
        assert_eq!(parse_open_graph(tw, &url).unwrap(), json!({ "url": "https://blog.example/post", "title": "Card title", "description": "Card words", "image": "https://cdn.example/c.jpg", "site": "blog.example" }));
        let plain = "<html><head><TITLE>Just a title</TITLE><meta name=description content='and words'></head></html>";
        assert_eq!(parse_open_graph(plain, &url).unwrap(), json!({ "url": "https://blog.example/post", "title": "Just a title", "description": "and words", "site": "blog.example" }));
        assert!(parse_open_graph("<html><body>nothing to say</body></html>", &url).is_none());
        // a picture that isn't a web address is left out; long words are cut
        let odd = format!(r#"<meta property="og:title" content="{}"><meta property="og:image" content="javascript:alert(1)">"#, "x".repeat(500));
        let p = parse_open_graph(&odd, &url).unwrap();
        assert_eq!(p["title"].as_str().unwrap().len(), 200);
        assert!(p.get("image").is_none());
    }

    #[test]
    fn a_picture_is_a_picture_by_its_content_type() {
        assert!(is_picture_type("image/gif"));
        assert!(is_picture_type("Image/PNG; charset=binary"));
        assert!(!is_picture_type("image/svg+xml"));
        assert!(!is_picture_type("text/html"));
    }
}
