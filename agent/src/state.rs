//! Runtime state the *running* agent records about itself, so out-of-process
//! commands (`status`) report **its** facts — the account it runs as, its pid —
//! instead of re-deriving them from the process that asks (which may be a
//! different user, e.g. you in a terminal vs. a root system service).
//!
//! Written next to the config when the monitoring loop starts and removed on a
//! clean exit. `read` self-validates against the recorded process's *identity*,
//! so a file left behind by a crash or a power cut is treated as "not running"
//! (and swept).

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
    /// Date de démarrage du processus, en secondes epoch — ce qui distingue *ce*
    /// processus d'un futur homonyme ayant hérité de son numéro (voir
    /// [`is_this_agent`]).
    pub started_at: u64,
}

/// Date de démarrage d'un processus vivant, telle que `sysinfo` la calcule.
///
/// Même source pour l'écriture et la relecture : la comparaison porte donc sur
/// deux mesures identiques, et non sur deux façons de dater un même instant.
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

/// Le processus enregistré est-il **toujours cet agent** ?
///
/// Un numéro de processus ne veut rien dire hors de son démarrage : le système
/// les recycle, et il repart de zéro à chaque amorçage. Se contenter de « un
/// processus porte ce numéro » faisait qu'un fichier d'état laissé par une
/// extinction brutale bloquait le démarrage suivant dès qu'un démon quelconque
/// avait hérité du numéro — ce qui est la règle, non l'exception, pour un agent
/// lancé tôt au démarrage et donc numéroté bas. L'agent refusait alors de
/// démarrer, le gestionnaire de service le relançait, il refusait de nouveau :
/// « lancement au démarrage » ne fonctionnait plus, sans que rien ne le dise.
///
/// La date de démarrage tranche : elle est propre à une instance, un numéro
/// recyclé ne la reproduit pas, et un redémarrage de la machine la rend
/// inatteignable.
fn is_this_agent(state: &RuntimeState) -> bool {
    let Some(started) = start_time(state.pid) else {
        return false;
    };
    // `started_at == 0` : la date n'a pas pu être lue à l'écriture. On ne peut
    // alors rien affirmer, et refuser de démarrer sur un doute est le pire des
    // deux risques.
    state.started_at != 0 && started == state.started_at
}

/// The recorded state of a *currently live* agent, or `None` when nothing is
/// running. A stale file (the process is gone, or its pid now belongs to
/// something else) is swept and reported as `None` — comme un fichier écrit par
/// une version antérieure, qu'aucune conversion ne rattrape : il ne décrit plus
/// rien de vérifiable, et le prochain démarrage le réécrit.
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
/// Sert au fichier de pid (`stop`, `status`), qui ne porte qu'un numéro : la
/// question y est bien « ce numéro est-il vivant ? ». La garde d'instance
/// unique, elle, exige une identité (voir [`is_this_agent`]).
pub fn process_alive(pid: u32) -> bool {
    let pid = Pid::from_u32(pid);
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
    sys.process(pid).is_some()
}
