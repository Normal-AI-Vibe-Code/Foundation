//! The Foundation server the packaged app carries (SPEC §3 "The server switch", "Desktop").
//!
//! A teammate's computer may have no checkout and no Node, so the app ships the server
//! (`resources/server/`: a pinned Node and the server bundled into `index.mjs`, built by
//! `scripts/desktop-server.mjs`) and the switch's Start can run it (local_server.rs), with its
//! `.env` and `data/` under the app's own data folder (%APPDATA%\co.normallab.foundation on Windows).
//! Nothing here starts on its own: a person presses Start, or the app starts again the server a
//! person last started here (ServerSwitch.tsx).
//!
//! A server the app started never outlives it. Three things see to that, because any one can be
//! skipped:
//!  - on quit or Stop, local_server.rs closes the child's stdin (the server leaves on that) and
//!    ends its process tree;
//!  - the server itself exits when stdin closes (FOUNDATION_EXIT_WITH_PARENT), which the OS does
//!    however the app ends;
//!  - on Windows the child is in a Job Object set to kill-on-close whose only handle this process
//!    holds, so a crash or Task Manager's End task takes the server and anything it started with it.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Where the built-in server is in the installed app, if this build carries one (a `tauri dev`
/// build has only the folder's README).
pub fn builtin(resources: &Path) -> Option<(PathBuf, PathBuf)> {
    let dir = plain(&resources.join("server"));
    let node = dir.join(if cfg!(windows) { "node.exe" } else { "node" });
    let script = dir.join("index.mjs");
    (node.is_file() && script.is_file()).then_some((node, script))
}

/// The command that runs the built-in server on `port`, its data in `home`, its output in `log`.
pub fn builtin_command(resources: &Path, home: &Path, log: &Path, port: u16, window_port: u16) -> Result<Command, String> {
    let Some((node, script)) = builtin(resources) else {
        return Err("This copy of Foundation was built without its own server. Start one from a checkout instead.".into());
    };
    let home = plain(home);
    fs::create_dir_all(home.join("data")).map_err(|e| format!("Foundation can't make its data folder {}: {e}.", home.display()))?;
    let out = open_log(log)?;
    let err = out.try_clone().map_err(|e| e.to_string())?;
    let mut cmd = Command::new(node);
    cmd.arg("--no-warnings")
        .arg(script)
        .current_dir(&home)
        .env("FOUNDATION_PORT", port.to_string())
        .env("FOUNDATION_HOST", "127.0.0.1")
        // `.env` (keys, tokens) and `data/` live in the app's own folder, not beside the program
        .env("FOUNDATION_ROOT", &home)
        .env("FOUNDATION_DATA_DIR", home.join("data"))
        .env("FOUNDATION_CLIENT_URL", format!("http://localhost:{window_port}"))
        // an address set for a dev server in the person's environment isn't this server's
        .env_remove("FOUNDATION_PUBLIC_URL")
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err));
    Ok(cmd)
}

/// The log starts over once it passes 2 MB, keeping the old one beside it.
pub fn open_log(log: &Path) -> Result<std::fs::File, String> {
    if let Some(dir) = log.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    if fs::metadata(log).map(|m| m.len() > 2 * 1024 * 1024).unwrap_or(false) {
        let _ = fs::rename(log, log.with_extension("old.log"));
    }
    let mut f = OpenOptions::new().create(true).append(true).open(log).map_err(|e| format!("Can't write {}: {e}", log.display()))?;
    let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let _ = writeln!(f, "[app {at}] Foundation started its server");
    Ok(f)
}

/// Tauri gives Windows paths in their verbatim form (`\\?\C:\…`), which Node can't resolve its
/// entry script through (`EISDIR: lstat 'C:'`, found on the first packaged run). The plain form.
pub fn plain(p: &Path) -> PathBuf {
    match p.to_str().and_then(|s| s.strip_prefix(r"\\?\")) {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => p.to_path_buf(),
    }
}

/// Windows: a Job Object that takes every process in it down when its last handle closes.
#[cfg(windows)]
pub mod job {
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
        /// a kill-on-close job holding `child` (and what it starts), or None if Windows said no
        pub fn holding(child: &Child) -> Option<Job> {
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
                let job = Job(h);
                if ok == 0 || AssignProcessToJobObject(job.0, child.as_raw_handle() as HANDLE) == 0 {
                    return None;
                }
                Some(job)
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verbatim_paths_made_plain() {
        assert_eq!(plain(Path::new(r"\\?\C:\Program Files\Foundation\server")), PathBuf::from(r"C:\Program Files\Foundation\server"));
        assert_eq!(plain(Path::new(r"\\?\UNC\host\share")), PathBuf::from(r"\\?\UNC\host\share"));
        assert_eq!(plain(Path::new(r"C:\x")), PathBuf::from(r"C:\x"));
    }

    #[test]
    fn no_builtin_server_in_a_bare_folder() {
        let dir = std::env::temp_dir().join(format!("fdn-builtin-{}", std::process::id()));
        fs::create_dir_all(dir.join("server")).unwrap();
        assert!(builtin(&dir).is_none());
        assert!(builtin_command(&dir, &dir, &dir.join("x.log"), 4410, 31440).unwrap_err().contains("without its own server"));
        let _ = fs::remove_dir_all(&dir);
    }
}
