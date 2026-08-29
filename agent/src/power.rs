//! System power actions: shutdown, reboot, suspend, hibernate and screen lock.
//!
//! Cross-platform and best-effort: each action shells out to the platform's
//! native mechanism. Anything the host can't do surfaces as an `Err` the server
//! relays to the UI; never a silent failure or a fake success.
//!
//! Shutdown / reboot take the machine (and this process) down moments after the
//! command returns. L'ordre réel est donc : exécuter (il faut savoir si ça a
//! échoué), envoyer `agent.powerResult` et une trame de fermeture, puis laisser
//! un court instant au serveur pour les recevoir.

use std::process::Command;

use anyhow::{bail, Context, Result};

/// Apply one power action by name. Unknown actions error (the server already
/// validates the enum — this is defence in depth).
pub fn execute(action: &str) -> Result<()> {
    match action {
        "shutdown" => shutdown(),
        "reboot" => reboot(),
        "suspend" => suspend(),
        "hibernate" => hibernate(),
        "lock" => lock(),
        other => bail!("action d'alimentation inconnue : {other}"),
    }
}

/// Run a command to completion and require success, naming the program in any
/// error. Every platform branch goes through this so they share failure semantics.
fn run(program: &str, args: &[&str]) -> Result<()> {
    let status = Command::new(program)
        .args(args)
        .status()
        .with_context(|| format!("lancement de « {program} »"))?;
    if status.success() {
        Ok(())
    } else {
        bail!(
            "« {program} » a échoué (code {})",
            status.code().unwrap_or(-1)
        )
    }
}

/// Try each candidate in order, returning on the first success and the last error
/// if all fail. Lets us prefer logind (`systemctl`) and fall back to the classic
/// tools.
///
/// Linux seul : sur macOS un `osascript` qui rend 0 sans rien faire n'est pas un
/// échec dont on peut se rattraper, donc pas d'enchaînement.
#[cfg(target_os = "linux")]
fn run_first(candidates: &[(&str, &[&str])]) -> Result<()> {
    let mut last: Option<anyhow::Error> = None;
    for (program, args) in candidates {
        match run(program, args) {
            Ok(()) => return Ok(()),
            Err(e) => last = Some(e),
        }
    }
    Err(last.unwrap_or_else(|| anyhow::anyhow!("aucune commande disponible")))
}

#[cfg(target_os = "linux")]
fn shutdown() -> Result<()> {
    run_first(&[("systemctl", &["poweroff"]), ("shutdown", &["-h", "now"])])
}
#[cfg(target_os = "linux")]
fn reboot() -> Result<()> {
    run_first(&[("systemctl", &["reboot"]), ("shutdown", &["-r", "now"])])
}
#[cfg(target_os = "linux")]
fn suspend() -> Result<()> {
    run("systemctl", &["suspend"])
}
#[cfg(target_os = "linux")]
fn hibernate() -> Result<()> {
    run("systemctl", &["hibernate"])
}
#[cfg(target_os = "linux")]
fn lock() -> Result<()> {
    // `lock-sessions` verrouille toutes les sessions et demande le privilège ;
    // `lock-session` sans argument vise celle de l'appelant.
    run_first(&[
        ("loginctl", &["lock-sessions"]),
        ("loginctl", &["lock-session"]),
    ])
}

// `osascript ... to shut down` envoie un Apple Event à System Events : hors
// session graphique (démon launchd) il n'atteint personne, et dans une session
// il déclenche l'extinction interactive, qu'une application refusant de quitter
// bloque. Dans les deux cas la commande rend 0. `shutdown(8)` est la voie
// autoritaire mais réservée à root : on la prend quand on en a le droit, et
// l'Apple Event reste le recours d'un agent non privilégié.
#[cfg(target_os = "macos")]
fn shutdown() -> Result<()> {
    if crate::report::is_privileged() {
        return run("shutdown", &["-h", "now"]);
    }
    run(
        "osascript",
        &["-e", "tell application \"System Events\" to shut down"],
    )
}
#[cfg(target_os = "macos")]
fn reboot() -> Result<()> {
    if crate::report::is_privileged() {
        return run("shutdown", &["-r", "now"]);
    }
    run(
        "osascript",
        &["-e", "tell application \"System Events\" to restart"],
    )
}
#[cfg(target_os = "macos")]
fn suspend() -> Result<()> {
    run("pmset", &["sleepnow"])
}
#[cfg(target_os = "macos")]
fn hibernate() -> Result<()> {
    bail!("La veille prolongée n'est pas une action distincte sur macOS — utilisez la veille")
}
#[cfg(target_os = "macos")]
fn lock() -> Result<()> {
    // `CGSession -suspend` no longer exists on recent macOS. Sleeping the display
    // locks the screen when "require password after sleep" is set (the default).
    run("pmset", &["displaysleepnow"])
}

#[cfg(target_os = "windows")]
fn shutdown() -> Result<()> {
    run("shutdown", &["/s", "/t", "0"])
}
#[cfg(target_os = "windows")]
fn reboot() -> Result<()> {
    run("shutdown", &["/r", "/t", "0"])
}
#[cfg(target_os = "windows")]
fn suspend() -> Result<()> {
    // SetSuspendState(Hibernate, ForceCritical, DisableWakeEvent): with hibernation
    // off this sleeps; with it on the OS may hibernate instead (documented quirk).
    run("rundll32.exe", &["powrprof.dll,SetSuspendState", "0,1,0"])
}
#[cfg(target_os = "windows")]
fn hibernate() -> Result<()> {
    run("shutdown", &["/h"])
}
#[cfg(target_os = "windows")]
fn lock() -> Result<()> {
    run("rundll32.exe", &["user32.dll,LockWorkStation"])
}
