//! System power actions: shutdown, reboot, suspend, hibernate and screen lock.
//!
//! Cross-platform and **best-effort**: each action shells out to the platform's
//! native mechanism. Anything the host can't do (hibernate without swap, lock on a
//! headless server, an action that needs privileges the agent lacks) surfaces as an
//! `Err` the server relays to the UI — we never fail silently or pretend success.
//!
//! Shutdown / reboot take the machine (and therefore this process) down moments
//! after the command returns; `runner` sends the `agent.powerResult` first so the
//! UI gets its confirmation before the host disappears.

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
/// tools without giving up on the first missing binary.
#[cfg(not(target_os = "windows"))]
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

// ───────────────────────────────── Linux ──────────────────────────────────
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
    run("loginctl", &["lock-sessions"])
}

// ───────────────────────────────── macOS ──────────────────────────────────
#[cfg(target_os = "macos")]
fn shutdown() -> Result<()> {
    run_first(&[
        (
            "osascript",
            &["-e", "tell application \"System Events\" to shut down"],
        ),
        ("shutdown", &["-h", "now"]),
    ])
}
#[cfg(target_os = "macos")]
fn reboot() -> Result<()> {
    run_first(&[
        (
            "osascript",
            &["-e", "tell application \"System Events\" to restart"],
        ),
        ("shutdown", &["-r", "now"]),
    ])
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
    // The old `CGSession -suspend` helper was removed from recent macOS. Sleeping
    // the display is the modern, daemon-friendly equivalent and locks the screen
    // when "require password after sleep" is set (the default).
    run("pmset", &["displaysleepnow"])
}

// ──────────────────────────────── Windows ─────────────────────────────────
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
