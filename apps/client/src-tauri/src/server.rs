//! The Foundation server the packaged app carries and runs.
//!
//! A fresh install has nothing else on the computer: no repo, no `npm run dev`, maybe no Node. So
//! the app ships the server (`resources/server/`: a pinned Node and the server bundled into
//! `index.mjs`, built by `scripts/desktop-server.mjs`) and starts it before the window opens, with
//! its data under the app's own data directory.
//!
//! Which server the window talks to, in order:
//!  1. a Foundation server already answering on [`SERVER_PORT`] (ours from another moment);
//!  2. one answering on the developer's port, 4410 (`npm run dev` is running: use it, start nothing;
//!     `FOUNDATION_DESKTOP_USE_DEV_SERVER=0` in the app's environment skips this);
//!  3. the bundled one, started here on [`SERVER_PORT`] (or the next free port after it).
//!
//! It never outlives the app. Three things see to that, because any one can be skipped:
//!  - on quit, [`Sidecar::stop`] closes the child's stdin (the server leaves on that) and kills it
//!    if it hasn't gone in three seconds;
//!  - the server itself exits when stdin closes, which the OS does however the app ends;
//!  - on Windows the child is in a Job Object set to kill-on-close whose only handle this process
//!    holds, so a crash or Task Manager's End task takes the server and anything it started with it.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// Where the app's own server listens. Beside the window's port and for the same reason: above
/// the blocks Windows reserves at boot (1024–15000 on some machines) and below every OS's
/// ephemeral range. `FOUNDATION_DESKTOP_SERVER_PORT` at build time moves it for a check build.
pub const SERVER_PORT: u16 = match option_env!("FOUNDATION_DESKTOP_SERVER_PORT") {
    Some(p) => crate::parse_port(p),
    None => 31441,
};
/// `npm run dev`'s server (apps/server/src/config.ts).
const DEV_PORT: u16 = 4410;
/// how many ports after SERVER_PORT to try when it's held by something that isn't Foundation
const SPARE_PORTS: u16 = 8;
/// a cold first start seeds the company board; 250 ms is usual, an antivirus scan of node.exe isn't
const BOOT_WAIT: Duration = Duration::from_secs(25);
/// a server that dies while the app is open is started again, this many times
const RESTARTS: u32 = 3;

/// What the window is told (lib.rs puts it on `window` before the page's own scripts run).
pub struct Started {
    /// the server's address, as the page should call it
    pub url: String,
    /// why there's no server behind `url`, in a sentence a person can act on
    pub error: Option<String>,
}

struct Launch {
    node: PathBuf,
    script: PathBuf,
    home: PathBuf,
    log: PathBuf,
    port: u16,
    window_port: u16,
}

#[derive(Default)]
struct State {
    child: Option<Child>,
    /// held open for the child's whole life; dropping it is the signal to leave
    stdin: Option<ChildStdin>,
    #[cfg(windows)]
    job: Option<job::Job>,
}

/// The running server, if this app started one. Managed by Tauri; `stop` on exit.
#[derive(Default)]
pub struct Sidecar {
    state: Arc<Mutex<State>>,
    stopping: Arc<AtomicBool>,
}

impl Sidecar {
    /// Find or start the server. Blocks until it answers (about a quarter of a second) so the
    /// page's first request already has someone to talk to.
    pub fn start(&self, resources: &Path, home: &Path, window_port: u16) -> Started {
        let local = |port: u16| format!("http://localhost:{port}");
        if answers(SERVER_PORT) {
            return Started { url: local(SERVER_PORT), error: None };
        }
        // FOUNDATION_DESKTOP_USE_DEV_SERVER=0 leaves a dev server alone and runs the app's own beside it
        let use_dev = std::env::var("FOUNDATION_DESKTOP_USE_DEV_SERVER").map(|v| v != "0").unwrap_or(true);
        if use_dev && answers(DEV_PORT) {
            return Started { url: local(DEV_PORT), error: None };
        }
        let fail = |error: String| Started { url: local(SERVER_PORT), error: Some(error) };

        let dir = plain(&resources.join("server"));
        let home = &plain(home);
        let node = dir.join(if cfg!(windows) { "node.exe" } else { "node" });
        let script = dir.join("index.mjs");
        if !node.is_file() || !script.is_file() {
            return fail(format!("This copy of Foundation was built without its server ({} is missing).", script.display()));
        }
        if let Err(e) = fs::create_dir_all(home.join("data")).and_then(|_| fs::create_dir_all(home.join("logs"))) {
            return fail(format!("Foundation can't make its data folder {}: {e}.", home.display()));
        }
        let Some(port) = (SERVER_PORT..=SERVER_PORT + SPARE_PORTS).find(|p| crate::port_free(*p)) else {
            return fail(format!(
                "Ports {SERVER_PORT}–{} on this computer are all in use or reserved, so Foundation's server has nowhere to listen.",
                SERVER_PORT + SPARE_PORTS
            ));
        };
        let launch = Launch { node, script, home: home.to_path_buf(), log: home.join("logs").join("server.log"), port, window_port };
        trim_log(&launch.log);

        if let Err(e) = spawn(&launch, &self.state) {
            return fail(format!("Foundation's server couldn't start: {e}."));
        }
        let t0 = Instant::now();
        loop {
            if answers(port) {
                break;
            }
            if let Some(status) = self.state.lock().unwrap().child.as_mut().and_then(|c| c.try_wait().ok().flatten()) {
                return fail(format!("Foundation's server stopped as it started ({status}). {}", last_words(&launch.log)));
            }
            if t0.elapsed() > BOOT_WAIT {
                return fail(format!(
                    "Foundation's server didn't answer within {} seconds. Its log is {}.",
                    BOOT_WAIT.as_secs(),
                    launch.log.display()
                ));
            }
            thread::sleep(Duration::from_millis(40));
        }
        self.keep_alive(launch);
        Started { url: local(port), error: None }
    }

    /// If the server dies while the app is open, start it again on the same port (a few times).
    fn keep_alive(&self, launch: Launch) {
        let state = self.state.clone();
        let stopping = self.stopping.clone();
        thread::spawn(move || {
            let mut restarts = 0;
            loop {
                thread::sleep(Duration::from_secs(1));
                if stopping.load(Ordering::SeqCst) {
                    return;
                }
                let died = state.lock().unwrap().child.as_mut().and_then(|c| c.try_wait().ok().flatten());
                let Some(status) = died else { continue };
                note(&launch.log, &format!("the server stopped ({status})"));
                if restarts == RESTARTS || stopping.load(Ordering::SeqCst) {
                    return;
                }
                restarts += 1;
                match spawn(&launch, &state) {
                    Ok(()) => note(&launch.log, &format!("started it again ({restarts} of {RESTARTS})")),
                    Err(e) => return note(&launch.log, &format!("couldn't start it again: {e}")),
                }
            }
        });
    }

    /// The app is quitting: ask the server to go, and make sure it has.
    pub fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        let mut s = self.state.lock().unwrap();
        drop(s.stdin.take());
        if let Some(mut child) = s.child.take() {
            let t0 = Instant::now();
            while t0.elapsed() < Duration::from_secs(3) {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    break;
                }
                thread::sleep(Duration::from_millis(25));
            }
            let _ = child.kill();
            let _ = child.wait();
        }
        // closing the job ends anything the server started that is still there (an agent's CLI)
        #[cfg(windows)]
        drop(s.job.take());
    }
}

fn spawn(l: &Launch, state: &Arc<Mutex<State>>) -> std::io::Result<()> {
    let log = OpenOptions::new().create(true).append(true).open(&l.log)?;
    let mut cmd = Command::new(&l.node);
    cmd.arg("--no-warnings")
        .arg(&l.script)
        .current_dir(&l.home)
        .env("FOUNDATION_PORT", l.port.to_string())
        .env("FOUNDATION_HOST", "127.0.0.1")
        // `.env` (keys, tokens) and `data/` live in the app's own folder, not beside the program
        .env("FOUNDATION_ROOT", &l.home)
        .env("FOUNDATION_DATA_DIR", l.home.join("data"))
        .env("FOUNDATION_CLIENT_URL", format!("http://localhost:{}", l.window_port))
        .env("FOUNDATION_EXIT_WITH_PARENT", "1")
        // an address set for a dev server in the person's environment isn't this server's
        .env_remove("FOUNDATION_PUBLIC_URL")
        .stdin(Stdio::piped())
        .stdout(Stdio::from(log.try_clone()?))
        .stderr(Stdio::from(log));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flashes up behind the app
    }
    let mut child = cmd.spawn()?;
    let mut s = state.lock().unwrap();
    #[cfg(windows)]
    {
        if s.job.is_none() {
            s.job = job::Job::new();
        }
        if let Some(j) = &s.job {
            j.assign(&child);
        }
    }
    s.stdin = child.stdin.take();
    s.child = Some(child);
    Ok(())
}

/// Tauri gives Windows paths in their verbatim form (`\\?\C:\…`), which Node can't resolve its
/// entry script through (`EISDIR: lstat 'C:'`, found on the first packaged run). The plain form.
fn plain(p: &Path) -> PathBuf {
    match p.to_str().and_then(|s| s.strip_prefix(r"\\?\")) {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => p.to_path_buf(),
    }
}

/// Whether a Foundation server answers `GET /api/health` on this port, on either loopback family.
pub fn answers(port: u16) -> bool {
    ["127.0.0.1", "::1"].iter().any(|host| health(host, port).unwrap_or(false))
}

fn health(host: &str, port: u16) -> std::io::Result<bool> {
    let addr: SocketAddr = match host.parse::<std::net::IpAddr>() {
        Ok(ip) => SocketAddr::new(ip, port),
        Err(_) => return Ok(false),
    };
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_millis(250))?;
    s.set_read_timeout(Some(Duration::from_millis(800)))?;
    s.set_write_timeout(Some(Duration::from_millis(800)))?;
    s.write_all(b"GET /api/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")?;
    let mut body = Vec::new();
    let _ = s.take(4096).read_to_end(&mut body);
    let text = String::from_utf8_lossy(&body);
    Ok(text.starts_with("HTTP/1.1 200") && text.contains("\"ok\":true"))
}

/// The log starts over once it passes 2 MB, keeping the old one beside it.
fn trim_log(log: &Path) {
    if fs::metadata(log).map(|m| m.len() > 2 * 1024 * 1024).unwrap_or(false) {
        let _ = fs::rename(log, log.with_extension("old.log"));
    }
    note(log, "Foundation started its server");
}

fn note(log: &Path, line: &str) {
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(log) {
        let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let _ = writeln!(f, "[app {at}] {line}");
    }
}

/// The last thing the server said before it died: usually exactly why.
fn last_words(log: &Path) -> String {
    let mut text = String::new();
    if let Ok(mut f) = File::open(log) {
        use std::io::{Seek, SeekFrom};
        let len = f.metadata().map(|m| m.len()).unwrap_or(0);
        let _ = f.seek(SeekFrom::Start(len.saturating_sub(4000)));
        let mut buf = Vec::new();
        let _ = f.read_to_end(&mut buf);
        text = String::from_utf8_lossy(&buf).into_owned();
    }
    let said: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with("[app ")).collect();
    // the error's own line ("Error: …", or the server's one-line reason), not the stack under it
    let line = said
        .iter()
        .rev()
        .find(|l| l.contains("Error: ") || l.starts_with("Foundation's server"))
        .or_else(|| said.iter().rev().find(|l| !l.starts_with("at ") && !l.starts_with("Node.js v") && **l != "}"));
    match line {
        Some(l) => format!("It said: {} (the rest is in {})", l.chars().take(300).collect::<String>(), log.display()),
        None => format!("Its log is {}.", log.display()),
    }
}

/// Windows: a Job Object that takes every process in it down when its last handle closes.
#[cfg(windows)]
mod job {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct Job(HANDLE);
    // a kernel handle; nothing about it is tied to the thread that made it
    unsafe impl Send for Job {}

    impl Job {
        pub fn new() -> Option<Job> {
            unsafe {
                let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if h.is_null() {
                    return None;
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    h,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    CloseHandle(h);
                    return None;
                }
                Some(Job(h))
            }
        }

        pub fn assign(&self, child: &Child) -> bool {
            unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as HANDLE) != 0 }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}
