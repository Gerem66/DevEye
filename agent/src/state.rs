//! Runtime state the running agent records about itself, so out-of-process
//! commands (`status`) report its facts (account, pid) instead of re-deriving
//! them from the asking process, which may run as a different user.
//!
//! Written next to the config when the monitoring loop starts, removed on a
//! clean exit. `read` validates against the recorded process's identity, so a
//! file left behind by a crash is treated as "not running" and swept.

use serde::{Deserialize, Serialize};
use sysinfo::{Pid, ProcessesToUpdate, System};

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
    /// Date de démarrage du processus, en secondes epoch : ce qui distingue ce
    /// processus d'un futur homonyme ayant hérité de son numéro (voir
    /// [`is_this_agent`]).
    pub started_at: u64,
}

/// Date de démarrage d'un processus vivant, telle que `sysinfo` la calcule :
/// même source à l'écriture et à la relecture, pour comparer deux mesures identiques.
fn start_time(pid: u32) -> Option<u64> {
    let pid = Pid::from_u32(pid);
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
    sys.process(pid).map(|p| p.start_time())
}

/// Record this process as the running agent (call once the loop is up).
pub fn write_running() {
    let pid = std::process::id();
    let state = RuntimeState {
        pid,
        user: crate::report::current_user(),
        privileged: crate::report::is_privileged(),
        started_at: start_time(pid).unwrap_or(0),
    };
    if let Ok(json) = serde_json::to_string(&state) {
        let _ = std::fs::write(Config::state_path(), json);
    }
}

/// Remove the runtime-state file (clean shutdown / teardown).
pub fn clear() {
    let _ = std::fs::remove_file(Config::state_path());
}

/// Le processus enregistré est-il toujours cet agent ?
///
/// Un numéro de processus est recyclé par le système et repart de zéro à chaque
/// amorçage : un fichier d'état laissé par une extinction brutale désignerait
/// vite un autre démon et bloquerait le démarrage suivant. La date de démarrage
/// est propre à une instance, un numéro recyclé ne la reproduit pas.
fn is_this_agent(state: &RuntimeState) -> bool {
    let Some(started) = start_time(state.pid) else {
        return false;
    };
    // `started_at == 0` : la date n'a pas pu être lue à l'écriture ; refuser de
    // démarrer sur un doute serait le pire des deux risques.
    state.started_at != 0 && started == state.started_at
}

/// The recorded state of a currently live agent, or `None` when nothing is
/// running. A stale file (process gone, pid reused, or unreadable) is swept and
/// reported as `None`.
pub fn read_running() -> Option<RuntimeState> {
    let raw = std::fs::read_to_string(Config::state_path()).ok()?;
    let state: RuntimeState = serde_json::from_str(&raw).ok()?;
    if is_this_agent(&state) {
        Some(state)
    } else {
        clear();
        None
    }
}

/// Whether a PID is a live process, regardless of which user owns it.
///
/// Sert au fichier de pid (`stop`, `status`), qui ne porte qu'un numéro. La
/// garde d'instance unique, elle, exige une identité (voir [`is_this_agent`]).
pub fn process_alive(pid: u32) -> bool {
    let pid = Pid::from_u32(pid);
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
    sys.process(pid).is_some()
}
