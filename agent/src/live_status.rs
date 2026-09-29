//! What the running agent publishes about itself for the tray icon
//! (`deveye-agent tray`): connection state, ongoing work, the server to open.
//!
//! The tray runs in the user's desktop session, often under another account
//! than a root/SYSTEM agent, so the status is published where that session can
//! read it but not forge it: next to the user's own config for a per-user agent,
//! a root-owned runtime directory (Unix) or `HKLM` (Windows) for a privileged
//! one. It is rewritten on every change and every [`HEARTBEAT`]: a reader tells
//! a live agent from a crashed one by `updated_at` alone.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::Notify;

/// Rewrite period of an unchanged status.
pub const HEARTBEAT: Duration = Duration::from_secs(5);
/// A per-user agent's status, in its `deveye` config directory (Unix).
pub const USER_FILE: &str = "status.json";
/// Seconds without a rewrite after which a status describes an agent that is gone.
pub const STALE_AFTER: u64 = 20;
/// A burst of changes (CloudSync starts and ends files by the hundred) is
/// written once.
const COALESCE: Duration = Duration::from_millis(250);

/// Where the agent stands with its server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Conn {
    Connecting,
    Connected,
    /// Linked again, waiting for approval in DevEye (close code 4001).
    PendingApproval,
    /// Refused at the handshake (unknown, revoked or removed device).
    Rejected,
    /// Disconnected; the next attempt is at `retry_at` (unix seconds).
    #[serde(rename_all = "camelCase")]
    Offline {
        retry_at: u64,
    },
}

/// Long-running work in progress, by kind.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Work {
    pub sync_transfers: u32,
    pub sync_scans: u32,
    pub update: u32,
    pub deploy: u32,
    pub packages: u32,
}

impl Work {
    pub fn any(&self) -> bool {
        *self != Work::default()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveStatus {
    pub version: String,
    pub pid: u32,
    /// The agent's executable: what a tray relaunches itself from after an update.
    pub exe: String,
    /// The DevEye origin, which serves the web app too.
    pub server: String,
    /// A privileged agent can only be stopped with elevation.
    pub privileged: bool,
    pub updated_at: u64,
    pub conn: Conn,
    pub work: Work,
}

impl LiveStatus {
    pub fn is_fresh(&self, now: u64) -> bool {
        now.saturating_sub(self.updated_at) <= STALE_AFTER
    }
}

#[derive(Debug, Clone, Copy)]
pub enum Task {
    SyncTransfer,
    SyncScan,
    Update,
    Deploy,
    Packages,
}

static COUNTERS: [AtomicU32; 5] = [const { AtomicU32::new(0) }; 5];
static CONN: Mutex<Conn> = Mutex::new(Conn::Connecting);
static CHANGED: Notify = Notify::const_new();
/// Where this process publishes, once [`publish`] has started.
static PUBLISHED: OnceLock<Scope> = OnceLock::new();

pub fn set_conn(conn: Conn) {
    *CONN.lock().unwrap_or_else(|e| e.into_inner()) = conn;
    CHANGED.notify_one();
}

/// Marks one piece of work as running until dropped. Held by the thread or task
/// doing the work, so a panic or an early return still ends it.
#[must_use = "the work ends when this guard is dropped"]
pub struct Busy(Task);

pub fn begin(task: Task) -> Busy {
    COUNTERS[task as usize].fetch_add(1, Ordering::Relaxed);
    CHANGED.notify_one();
    Busy(task)
}

impl Drop for Busy {
    fn drop(&mut self) {
        COUNTERS[self.0 as usize].fetch_sub(1, Ordering::Relaxed);
        CHANGED.notify_one();
    }
}

fn work() -> Work {
    let n = |t: Task| COUNTERS[t as usize].load(Ordering::Relaxed);
    Work {
        sync_transfers: n(Task::SyncTransfer),
        sync_scans: n(Task::SyncScan),
        update: n(Task::Update),
        deploy: n(Task::Deploy),
        packages: n(Task::Packages),
    }
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Publish this agent's status until the process ends.
pub async fn publish(server: String) {
    let privileged = tokio::task::spawn_blocking(crate::report::is_privileged)
        .await
        .unwrap_or(false);
    let scope = if privileged {
        Scope::System
    } else {
        Scope::User
    };
    let _ = PUBLISHED.set(scope);
    let exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut warned = false;
    loop {
        let status = LiveStatus {
            version: env!("DEVEYE_VERSION").to_string(),
            pid: std::process::id(),
            exe: exe.clone(),
            server: server.clone(),
            privileged,
            updated_at: now_secs(),
            conn: *CONN.lock().unwrap_or_else(|e| e.into_inner()),
            work: work(),
        };
        let written = serde_json::to_string(&status)
            .map_err(std::io::Error::other)
            .and_then(|json| store::write(scope, &json));
        match written {
            Ok(()) => warned = false,
            Err(e) if !warned => {
                tracing::warn!(error = %e, "cannot publish the status for the tray icon");
                warned = true;
            }
            Err(_) => {}
        }
        tokio::select! {
            _ = CHANGED.notified() => tokio::time::sleep(COALESCE).await,
            _ = tokio::time::sleep(HEARTBEAT) => {}
        }
    }
}

/// Remove what [`publish`] wrote (clean exit).
pub fn withdraw() {
    if let Some(&scope) = PUBLISHED.get() {
        store::remove(scope);
    }
}

/// Remove every published status this process can reach (uninstall).
pub fn remove_all() {
    store::remove(Scope::User);
    store::remove(Scope::System);
}

/// Every status published on this machine that the current user can trust.
pub fn read_all() -> Vec<LiveStatus> {
    [Scope::User, Scope::System]
        .into_iter()
        .filter_map(store::read)
        .filter_map(|raw| serde_json::from_str(&raw).ok())
        .collect()
}

/// Who published: the user's own agent, or a privileged one for the whole machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Scope {
    User,
    System,
}

#[cfg(unix)]
mod store {
    use std::fs;
    use std::io::{self, Write};
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
    use std::path::PathBuf;

    use super::{Scope, USER_FILE as FILE};

    #[cfg(target_os = "macos")]
    const SYSTEM_DIR: &str = "/var/run/deveye-agent";
    #[cfg(not(target_os = "macos"))]
    const SYSTEM_DIR: &str = "/run/deveye-agent";

    fn dir(scope: Scope) -> Option<PathBuf> {
        match scope {
            Scope::System => Some(PathBuf::from(SYSTEM_DIR)),
            Scope::User => dirs::config_dir().map(|d| d.join("deveye")),
        }
    }

    fn euid() -> u32 {
        // SAFETY: `geteuid` has no preconditions and cannot fail.
        unsafe { libc::geteuid() }
    }

    /// Owned by us and writable by nobody else: a directory another account
    /// prepared could redirect or forge what we write.
    fn is_sound_dir(path: &std::path::Path, owner: u32) -> bool {
        fs::symlink_metadata(path)
            .map(|m| m.is_dir() && m.uid() == owner && m.mode() & 0o022 == 0)
            .unwrap_or(false)
    }

    pub(super) fn write(scope: Scope, json: &str) -> io::Result<()> {
        let dir = dir(scope).ok_or_else(|| io::Error::other("no config directory"))?;
        // The system status is for every user's tray, a per-user one for its owner's.
        let (dir_mode, file_mode) = match scope {
            Scope::System => (0o755, 0o644),
            Scope::User => (0o700, 0o600),
        };
        fs::DirBuilder::new()
            .recursive(true)
            .mode(dir_mode)
            .create(&dir)?;
        if scope == Scope::System {
            // A restrictive umask would leave the directory unreadable by users.
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o755))?;
            if !is_sound_dir(&dir, euid()) {
                return Err(io::Error::other(format!(
                    "{} is not a directory owned by this account alone",
                    dir.display()
                )));
            }
        }
        let tmp = dir.join(".status.json.tmp");
        let _ = fs::remove_file(&tmp);
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(file_mode)
            .open(&tmp)?;
        file.set_permissions(fs::Permissions::from_mode(file_mode))?;
        file.write_all(json.as_bytes())?;
        drop(file);
        fs::rename(&tmp, dir.join(FILE))
    }

    pub(super) fn remove(scope: Scope) {
        if let Some(dir) = dir(scope) {
            let _ = fs::remove_file(dir.join(FILE));
            if scope == Scope::System {
                let _ = fs::remove_dir(&dir);
            }
        }
    }

    /// The system status only counts when root wrote it, in a directory only
    /// root controls: the tray opens the URL it names.
    pub(super) fn read(scope: Scope) -> Option<String> {
        let dir = dir(scope)?;
        let path = dir.join(FILE);
        let meta = fs::symlink_metadata(&path).ok()?;
        let trusted = match scope {
            Scope::System => is_sound_dir(&dir, 0) && meta.uid() == 0,
            Scope::User => meta.uid() == euid(),
        };
        if !meta.is_file() || !trusted {
            return None;
        }
        fs::read_to_string(path).ok()
    }
}

#[cfg(windows)]
mod store {
    use std::io;

    use super::Scope;
    use crate::winreg::{self, Hive};

    const KEY: &str = r"Software\DevEye";
    const VALUE: &str = "AgentStatus";

    fn hive(scope: Scope) -> Hive {
        match scope {
            Scope::System => Hive::LocalMachine,
            Scope::User => Hive::CurrentUser,
        }
    }

    pub(super) fn write(scope: Scope, json: &str) -> io::Result<()> {
        winreg::set_string(hive(scope), KEY, VALUE, json)
    }

    pub(super) fn remove(scope: Scope) {
        let _ = winreg::delete_value(hive(scope), KEY, VALUE);
    }

    pub(super) fn read(scope: Scope) -> Option<String> {
        winreg::get_string(hive(scope), KEY, VALUE)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_status_round_trips_through_json() {
        let status = LiveStatus {
            version: "1.2.3".into(),
            pid: 42,
            exe: "/usr/local/bin/deveye-agent".into(),
            server: "https://app.deveye.fr".into(),
            privileged: true,
            updated_at: 1_000,
            conn: Conn::Offline { retry_at: 1_012 },
            work: Work {
                sync_transfers: 3,
                ..Work::default()
            },
        };
        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains(r#""conn":{"state":"offline","retryAt":1012}"#));
        assert_eq!(serde_json::from_str::<LiveStatus>(&json).unwrap(), status);
    }

    #[test]
    fn a_status_goes_stale_without_heartbeat() {
        let mut status: LiveStatus = serde_json::from_str(
            r#"{"version":"1","pid":1,"exe":"","server":"","privileged":false,
                "updatedAt":100,"conn":{"state":"connected"},"work":{}}"#,
        )
        .unwrap();
        assert!(status.is_fresh(100 + STALE_AFTER));
        assert!(!status.is_fresh(101 + STALE_AFTER));
        status.updated_at = 200;
        assert!(status.is_fresh(150), "a clock step back is not staleness");
    }

    #[test]
    fn work_is_counted_until_its_guard_drops() {
        let before = work().deploy;
        let first = begin(Task::Deploy);
        let second = begin(Task::Deploy);
        assert_eq!(work().deploy, before + 2);
        drop(first);
        assert_eq!(work().deploy, before + 1);
        drop(second);
        assert_eq!(work().deploy, before);
    }
}
