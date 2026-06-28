//! Runtime state the *running* agent records about itself, so out-of-process
//! commands (`status`) report **its** facts — the account it runs as, its pid —
//! instead of re-deriving them from the process that asks (which may be a
//! different user, e.g. you in a terminal vs. a root system service).
//!
//! Written next to the config when the monitoring loop starts and removed on a
//! clean exit. `read` self-validates against process liveness, so a file left
//! behind by a crash is treated as "not running" (and swept).

use serde::{Deserialize, Serialize};

use crate::config::Config;

/// What the live agent recorded about itself.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeState {
    /// PID of the running monitoring process.
    pub pid: u32,
    /// OS account the agent runs as (e.g. `root` for an elevated system service).
    pub user: String,
    /// Whether that account is privileged (root / elevated token).
    pub privileged: bool,
}

/// Record this process as the running agent (call once the loop is up).
pub fn write_running() {
    let state = RuntimeState {
        pid: std::process::id(),
        user: crate::report::current_user(),
        privileged: crate::report::is_privileged(),
    };
    if let Ok(json) = serde_json::to_string(&state) {
        let _ = std::fs::write(Config::state_path(), json);
    }
}

/// Remove the runtime-state file (clean shutdown / teardown).
pub fn clear() {
    let _ = std::fs::remove_file(Config::state_path());
}

/// The recorded state of a *currently live* agent, or `None` when nothing is
/// running. A stale file (its pid is dead) is swept and reported as `None`.
pub fn read_running() -> Option<RuntimeState> {
    let raw = std::fs::read_to_string(Config::state_path()).ok()?;
    let state: RuntimeState = serde_json::from_str(&raw).ok()?;
    if process_alive(state.pid) {
        Some(state)
    } else {
        clear();
        None
    }
}

/// Whether a PID is a live process, regardless of which user owns it.
///
/// `ps -p` answers existence even for another user's process, unlike `kill -0`
/// (which a non-root caller gets `EPERM`, not success, for a root-owned agent) —
/// the very case that made `status` report a running elevated agent as stopped.
#[cfg(unix)]
pub fn process_alive(pid: u32) -> bool {
    std::process::Command::new("ps")
        .args(["-p", &pid.to_string()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(windows)]
pub fn process_alive(pid: u32) -> bool {
    let out = match std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
        .output()
    {
        Ok(o) if o.status.success() => o.stdout,
        _ => return false,
    };
    // CSV rows quote each field, e.g. `"deveye-agent.exe","1234",…`; absence prints
    // an "INFO: No tasks…" notice that won't contain the quoted PID.
    String::from_utf8_lossy(&out).contains(&format!("\"{pid}\""))
}
