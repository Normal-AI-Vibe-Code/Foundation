//! The server on this computer (SPEC §3 "The server switch"): the desktop app starts Foundation's own
//! server when a person presses Start in the switch, bottom right, one of two kinds, both on :4410:
//!  - **built in**: the server the app carries (server.rs), its data in the app's own folder; a
//!    computer with no checkout and no Node has this one;
//!  - **checkout**: `node --import tsx apps/server/src/index.ts` in a Foundation checkout, its data
//!    the checkout's.
//! Nothing here starts on its own. No console window; output in the app's log folder
//! (`local-server.log`); stopped when the app quits, and gone with it however it ends (server.rs).
//! A server that was already running is used, never started twice. One started the switch's way by an
//! earlier run of this app (it outlives an update's relaunch) is recognised by its command line and can
//! be stopped from here (2026-11-17: the app updated, the server it had started kept running code from
//! before desktops, and the card's "Stop, then Start" had no Stop to press). Anything else on the port
//! (`npm run dev`, another program) is never stopped from here.

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

/// The server's port: what `.env.desktop` builds the app to ask (VITE_FOUNDATION_SERVER).
pub const SERVER_PORT: u16 = 4410;
/// Node's own SQLite has full-text search (FTS5) from 22.16; the server dies at boot without it.
const NODE_NEEDS: (u32, u32) = (22, 16);

#[derive(Default)]
pub struct LocalServer(Mutex<Slot>);

#[derive(Default)]
struct Slot {
    running: Option<Running>,
    /// why the last one we started stopped by itself, until the next start
    exited: Option<String>,
    /// the process on the port when last asked, and whether it's a Foundation server started the switch's
    /// way (asking a process's command line takes a moment: asked again only for a new process)
    adopted: Option<(u32, Option<Kind>)>,
}

struct Running {
    child: Child,
    kind: Kind,
    /// the checkout it runs from, or the built-in server's data folder
    folder: String,
    log: PathBuf,
    /// held for the child's whole life: the server leaves when it closes (FOUNDATION_EXIT_WITH_PARENT)
    stdin: Option<ChildStdin>,
    #[cfg(windows)]
    _job: Option<crate::server::job::Job>,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    /// the server the app carries (server.rs)
    BuiltIn,
    /// a Foundation checkout's own server
    Checkout,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// something answers on the port (ours or not)
    listening: bool,
    /// this app started it and it's still running
    ours: bool,
    /// which kind this app started
    kind: Option<Kind>,
    /// the checkout it runs from, or the built-in server's data folder
    folder: Option<String>,
    /// this build carries its own server (an installed app; not `tauri dev`)
    built_in: bool,
    /// the one we started stopped by itself: its exit and the end of its log
    exited: Option<String>,
    /// what's on the port when this run didn't start it but an earlier run of the app (or another copy)
    /// did, the switch's way: it can be stopped (and so restarted) from here
    adopted: Option<Kind>,
}

fn listening(port: u16) -> bool {
    ["127.0.0.1", "[::1]"].iter().any(|h| {
        format!("{h}:{port}")
            .parse::<SocketAddr>()
            .map(|a| TcpStream::connect_timeout(&a, Duration::from_millis(250)).is_ok())
            .unwrap_or(false)
    })
}

#[cfg(windows)]
fn hidden(cmd: &mut Command) -> &mut Command {
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW: no console flashes up behind the app
    cmd.creation_flags(0x0800_0000)
}
#[cfg(not(windows))]
fn hidden(cmd: &mut Command) -> &mut Command {
    cmd
}

/// "v22.13.1" → (22, 13)
fn parse_node(v: &str) -> Option<(u32, u32)> {
    let mut it = v.trim().trim_start_matches('v').split('.');
    Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?))
}

fn node_version() -> Result<String, String> {
    let out = hidden(&mut Command::new("node"))
        .arg("-v")
        .stdin(Stdio::null())
        .output()
        .map_err(|_| "Node isn't installed on this computer, or isn't on its PATH. Install Node 22.16 or newer (winget install OpenJS.NodeJS.LTS), then open Foundation again.".to_string())?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// the folder must be a Foundation checkout with its packages installed: nothing else is run from here
fn check_folder(folder: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(folder.trim());
    if !root.is_absolute() {
        return Err("Give the folder's full path, like C:\\Dev\\Foundation.".into());
    }
    let pkg = fs::read_to_string(root.join("package.json")).map_err(|_| format!("{} isn't a Foundation checkout (no package.json).", root.display()))?;
    let named = serde_json::from_str::<serde_json::Value>(&pkg).ok().and_then(|v| v.get("name").and_then(|n| n.as_str()).map(str::to_owned));
    if named.as_deref() != Some("foundation") {
        return Err(format!("{} isn't a Foundation checkout.", root.display()));
    }
    if !root.join("apps/server/src/index.ts").is_file() {
        return Err(format!("{} has no server (apps/server/src/index.ts).", root.display()));
    }
    if !root.join("node_modules/tsx").is_dir() {
        return Err(format!("Its packages aren't installed: run npm install in {} first.", root.display()));
    }
    Ok(root)
}

/// the end of a log, for saying why a server stopped
fn tail(path: &Path, bytes: u64) -> String {
    let Ok(mut f) = File::open(path) else { return String::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let _ = f.seek(SeekFrom::Start(len.saturating_sub(bytes)));
    let mut s = String::new();
    let _ = f.read_to_string(&mut s);
    s.lines().filter(|l| !l.contains("ExperimentalWarning") && !l.contains("--trace-warnings")).collect::<Vec<_>>().join("\n").trim().to_string()
}

/// reap a child that stopped by itself and remember why
fn reap(slot: &mut Slot) {
    if let Some(r) = slot.running.as_mut() {
        if let Ok(Some(code)) = r.child.try_wait() {
            let last = tail(&r.log, 1600);
            slot.exited = Some(if last.is_empty() { format!("The server stopped ({code}).") } else { format!("The server stopped ({code}):\n{last}") });
            slot.running = None;
        }
    }
}

fn status_of(app: &AppHandle, slot: &mut Slot) -> Status {
    let on = listening(SERVER_PORT);
    let adopted = if on && slot.running.is_none() { adopted(slot) } else { None };
    Status {
        listening: on,
        adopted,
        ours: slot.running.is_some(),
        kind: slot.running.as_ref().map(|r| r.kind),
        folder: slot.running.as_ref().map(|r| r.folder.clone()),
        built_in: app.path().resource_dir().ok().and_then(|r| crate::server::builtin(&r)).is_some(),
        exited: slot.exited.clone(),
    }
}

#[tauri::command]
pub fn local_server_status(app: AppHandle, state: State<'_, LocalServer>) -> Status {
    let mut slot = state.0.lock().unwrap_or_else(|e| e.into_inner());
    reap(&mut slot);
    status_of(&app, &mut slot)
}

// ---------- a server this run of the app didn't start ----------

/// which kind of Foundation server a command line is, when it is one started the switch's way:
/// `node --import tsx apps/server/src/index.ts` (a checkout) or the app's own `server/node` running
/// `server/index.mjs` (built in). `npm run dev` (tsx watch, from apps/server) and anything else is None.
fn foundation_kind(cmdline: &str) -> Option<Kind> {
    let c = cmdline.replace('\\', "/").replace('"', "");
    if c.contains("--import tsx apps/server/src/index.ts") && !c.contains(" watch ") {
        return Some(Kind::Checkout);
    }
    if c.contains("/server/node") && c.trim_end().ends_with("/server/index.mjs") {
        return Some(Kind::BuiltIn);
    }
    None
}

/// the process listening on a port, from `netstat -ano`'s lines ("  TCP  127.0.0.1:4410  0.0.0.0:0  LISTENING  28840")
fn listener_in(netstat: &str, port: u16) -> Option<u32> {
    let end = format!(":{port}");
    netstat.lines().find_map(|l| {
        let f: Vec<&str> = l.split_whitespace().collect();
        if f.len() == 5 && f[0] == "TCP" && f[1].ends_with(&end) && f[3] == "LISTENING" {
            f[4].parse().ok()
        } else {
            None
        }
    })
}

#[cfg(windows)]
fn listener_pid(port: u16) -> Option<u32> {
    ["TCP", "TCPv6"].iter().find_map(|p| {
        let out = hidden(&mut Command::new("netstat")).args(["-ano", "-p", p]).stdin(Stdio::null()).output().ok()?;
        listener_in(&String::from_utf8_lossy(&out.stdout), port)
    })
}
#[cfg(not(windows))]
fn listener_pid(port: u16) -> Option<u32> {
    let out = Command::new("lsof").args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-t"]).stdin(Stdio::null()).output().ok()?;
    String::from_utf8_lossy(&out.stdout).lines().next()?.trim().parse().ok()
}

#[cfg(windows)]
fn command_line(pid: u32) -> Option<String> {
    let q = format!("(Get-CimInstance Win32_Process -Filter 'ProcessId={pid}').CommandLine");
    let out = hidden(&mut Command::new("powershell")).args(["-NoProfile", "-NonInteractive", "-Command", &q]).stdin(Stdio::null()).output().ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty()).then_some(s)
}
#[cfg(not(windows))]
fn command_line(pid: u32) -> Option<String> {
    let out = Command::new("ps").args(["-o", "command=", "-p", &pid.to_string()]).stdin(Stdio::null()).output().ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty()).then_some(s)
}

/// the kind of the Foundation server on the port that this run didn't start, if it is one
fn adopted(slot: &mut Slot) -> Option<Kind> {
    let pid = listener_pid(SERVER_PORT)?;
    if let Some((p, k)) = slot.adopted {
        if p == pid {
            return k;
        }
    }
    let k = command_line(pid).as_deref().and_then(foundation_kind);
    slot.adopted = Some((pid, k));
    k
}

/// stops the Foundation server on the port that this run didn't start (and what it started: agents' runs);
/// anything that isn't one is left alone
fn stop_adopted(slot: &mut Slot) {
    let Some(pid) = listener_pid(SERVER_PORT) else { return };
    // asked afresh: the pid could have been reused since it was last looked at
    if command_line(pid).as_deref().and_then(foundation_kind).is_none() {
        return;
    }
    #[cfg(windows)]
    {
        let _ = hidden(&mut Command::new("taskkill")).args(["/PID", &pid.to_string(), "/T", "/F"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill").args(["-TERM", &pid.to_string()]).status();
    }
    slot.adopted = None;
    // until the port is free, so a Start straight after doesn't find it taken
    let t0 = std::time::Instant::now();
    while listening(SERVER_PORT) && t0.elapsed() < Duration::from_secs(6) {
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// the built-in server's home: the app's data folder (FOUNDATION_DESKTOP_HOME moves it, for a check
/// run that mustn't touch the real one)
fn builtin_home(app: &AppHandle) -> Result<PathBuf, String> {
    match std::env::var_os("FOUNDATION_DESKTOP_HOME") {
        Some(dir) if !dir.is_empty() => Ok(PathBuf::from(dir)),
        _ => app.path().app_data_dir().map_err(|e| e.to_string()),
    }
}

#[tauri::command]
pub fn start_local_server(app: AppHandle, state: State<'_, LocalServer>, kind: Kind, folder: Option<String>) -> Result<Status, String> {
    let mut slot = state.0.lock().unwrap_or_else(|e| e.into_inner());
    reap(&mut slot);
    // already answering (npm run dev, or ours): use it, never a second one on the same port
    if slot.running.is_some() || listening(SERVER_PORT) {
        return Ok(status_of(&app, &mut slot));
    }
    let log = app.path().app_log_dir().map_err(|e| e.to_string())?.join("local-server.log");
    let (mut cmd, shown) = match kind {
        Kind::BuiltIn => {
            let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
            let home = crate::server::plain(&builtin_home(&app)?);
            (crate::server::builtin_command(&resources, &home, &log, SERVER_PORT, crate::PORT)?, home.display().to_string())
        }
        Kind::Checkout => {
            let root = check_folder(folder.as_deref().unwrap_or(""))?;
            let v = node_version()?;
            match parse_node(&v) {
                Some(n) if n >= NODE_NEEDS => {}
                _ => {
                    return Err(format!(
                        "Foundation's server needs Node {}.{} or newer (its search needs SQLite's FTS5), and this computer has {}. Install it with winget install OpenJS.NodeJS.LTS, or start the built-in server instead.",
                        NODE_NEEDS.0,
                        NODE_NEEDS.1,
                        if v.is_empty() { "an unknown version".to_string() } else { v }
                    ))
                }
            }
            let out = crate::server::open_log(&log)?;
            let err = out.try_clone().map_err(|e| e.to_string())?;
            let mut cmd = Command::new("node");
            cmd.args(["--import", "tsx", "apps/server/src/index.ts"])
                .current_dir(&root)
                .env("FOUNDATION_PORT", SERVER_PORT.to_string())
                .stdout(out)
                .stderr(err);
            (cmd, root.display().to_string())
        }
    };
    // it leaves when the app's end of stdin closes, however the app ends
    let mut child = hidden(&mut cmd)
        .env("FOUNDATION_EXIT_WITH_PARENT", "1")
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Couldn't start the server: {e}"))?;
    #[cfg(windows)]
    let job = crate::server::job::Job::holding(&child);
    let stdin = child.stdin.take();
    slot.exited = None;
    slot.adopted = None;
    slot.running = Some(Running {
        child,
        kind,
        folder: shown,
        log,
        stdin,
        #[cfg(windows)]
        _job: job,
    });
    Ok(status_of(&app, &mut slot))
}

/// stop the server this app started (and what it started); one it didn't start is left alone
fn stop(slot: &mut Slot) {
    if let Some(mut r) = slot.running.take() {
        // asked first: the server ends its agents' runs and goes when stdin closes
        drop(r.stdin.take());
        let t0 = std::time::Instant::now();
        while t0.elapsed() < Duration::from_millis(1500) {
            if matches!(r.child.try_wait(), Ok(Some(_))) {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        #[cfg(windows)]
        {
            let _ = hidden(&mut Command::new("taskkill")).args(["/PID", &r.child.id().to_string(), "/T", "/F"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
        }
        let _ = r.child.kill();
        let _ = r.child.wait();
    }
}

#[tauri::command]
pub fn stop_local_server(app: AppHandle, state: State<'_, LocalServer>) -> Status {
    let mut slot = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if slot.running.is_some() {
        stop(&mut slot);
    } else {
        // started the switch's way by an earlier run of this app: a person can stop it from here too
        stop_adopted(&mut slot);
    }
    slot.exited = None;
    status_of(&app, &mut slot)
}

/// the app is quitting: a server it started goes with it
pub fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<LocalServer>() {
        let mut slot = state.0.lock().unwrap_or_else(|e| e.into_inner());
        stop(&mut slot);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_versions() {
        assert_eq!(parse_node("v22.13.1"), Some((22, 13)));
        assert_eq!(parse_node("v24.11.1\r\n"), Some((24, 11)));
        assert!(parse_node("v22.13.1").unwrap() < NODE_NEEDS);
        assert!(parse_node("v22.16.0").unwrap() >= NODE_NEEDS);
        assert!(parse_node("v24.0.0").unwrap() >= NODE_NEEDS);
        assert_eq!(parse_node(""), None);
    }

    #[test]
    fn which_servers_can_be_stopped_from_here() {
        // the switch's own two ways, as Windows reports them
        assert!(foundation_kind(r#""node" --import tsx apps/server/src/index.ts"#) == Some(Kind::Checkout));
        assert!(foundation_kind(r#""C:\Users\a\AppData\Local\Foundation\server\node.exe" --no-warnings "C:\Users\a\AppData\Local\Foundation\server\index.mjs""#) == Some(Kind::BuiltIn));
        // npm run dev (tsx watch, from apps/server) and anything else on the port: never
        assert!(foundation_kind(r#"node C:\Dev\Foundation\node_modules\tsx\dist\cli.mjs watch src/index.ts"#).is_none());
        assert!(foundation_kind("node --import tsx apps/server/src/other.ts").is_none());
        assert!(foundation_kind("python -m http.server 4410").is_none());
    }

    #[test]
    fn the_listener_from_netstat() {
        let n = "\nActive Connections\n\n  Proto  Local Address          Foreign Address        State           PID\n  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1200\n  TCP    127.0.0.1:44100        0.0.0.0:0              LISTENING       9\n  TCP    127.0.0.1:4410         127.0.0.1:50000        ESTABLISHED     77\n  TCP    127.0.0.1:4410         0.0.0.0:0              LISTENING       28840\n";
        assert_eq!(listener_in(n, 4410), Some(28840));
        assert_eq!(listener_in(n, 4411), None);
        assert_eq!(listener_in("  TCP    [::1]:4410             [::]:0                 LISTENING       31\n", 4410), Some(31));
    }

    #[test]
    fn only_a_foundation_checkout() {
        assert!(check_folder("relative\\path").is_err());
        let dir = std::env::temp_dir().join(format!("fdn-check-{}", std::process::id()));
        fs::create_dir_all(dir.join("apps/server/src")).unwrap();
        fs::write(dir.join("package.json"), r#"{"name":"something-else"}"#).unwrap();
        assert!(check_folder(dir.to_str().unwrap()).unwrap_err().contains("isn't a Foundation checkout"));
        fs::write(dir.join("package.json"), r#"{"name":"foundation"}"#).unwrap();
        fs::write(dir.join("apps/server/src/index.ts"), "").unwrap();
        assert!(check_folder(dir.to_str().unwrap()).unwrap_err().contains("npm install"));
        fs::create_dir_all(dir.join("node_modules/tsx")).unwrap();
        assert!(check_folder(dir.to_str().unwrap()).is_ok());
        let _ = fs::remove_dir_all(&dir);
    }
}
