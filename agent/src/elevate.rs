//! Privilege changes for the persistence service: become a root/system service
//! ("elevate") or step back to a per-user one ("drop").
//!
//! Elevation needs a one-time OS authorization that can only be granted from an
//! **interactive session on the device** (UAC / macOS auth dialog / polkit). The
//! flow is hybrid: if the agent detects such a session it pops the prompt itself;
//! otherwise it reports `NeedsManual` and the web UI shows the exact command to
//! run on the device. Tearing a system service back down likewise has to happen in
//! a session on the device, so `drop` from a system scope also returns `NeedsManual`.

use std::process::Command;

use anyhow::{bail, Result};

use crate::service::{self, ServiceScope};

/// Result of an elevate/drop attempt.
pub enum Outcome {
    /// The change was applied on-device.
    Done,
    /// No interactive session (or the prompt was declined): the user must run the
    /// guided command on the device. The UI already shows it.
    NeedsManual,
}

/// Try to become a root/system service. See the module docs for the hybrid flow.
pub fn elevate() -> Result<Outcome> {
    if service::installed_scope() == ServiceScope::System {
        return Ok(Outcome::Done);
    }
    if !has_interactive_session() {
        return Ok(Outcome::NeedsManual);
    }
    match run_elevated_install() {
        Ok(()) => Ok(Outcome::Done),
        Err(e) => {
            tracing::warn!(error = %e, "elevation prompt failed/declined; guiding the user");
            Ok(Outcome::NeedsManual)
        }
    }
}

/// Step back from a root/system service to a per-user one. The teardown of a
/// system service must run privileged in a session on the device, so we guide it.
pub fn drop_privileges() -> Result<Outcome> {
    if service::installed_scope() == ServiceScope::System {
        Ok(Outcome::NeedsManual)
    } else {
        Ok(Outcome::Done)
    }
}

fn current_exe_str() -> Result<String> {
    Ok(std::env::current_exe()?.to_string_lossy().into_owned())
}

/// Le fichier d'enrôlement que le service élevé devra lire.
///
/// C'est nous qui le connaissons : nous tournons dessus. Le processus élevé
/// hérite de l'environnement de root (`pkexec` comme `sudo` réécrivent `$HOME`)
/// et graverait `/root/.config/deveye/agent.toml`, qui n'existe pas.
fn enrolled_config() -> String {
    crate::config::Config::path().to_string_lossy().into_owned()
}

#[cfg(target_os = "macos")]
fn has_interactive_session() -> bool {
    // The owner of /dev/console is the GUI console user, or "root" when nobody is
    // logged into the desktop — only a real user session can show the auth dialog.
    Command::new("stat")
        .args(["-f%Su", "/dev/console"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| {
            let u = s.trim();
            !u.is_empty() && u != "root"
        })
        .unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn has_interactive_session() -> bool {
    // A graphical session is needed for a polkit prompt agent to appear.
    std::env::var_os("DISPLAY").is_some() || std::env::var_os("WAYLAND_DISPLAY").is_some()
}

#[cfg(target_os = "windows")]
fn has_interactive_session() -> bool {
    // Let the UAC attempt decide; a Session-0/service context simply fails the
    // ShellExecute and we fall back to the guided command.
    true
}

/// Quote a string for a POSIX shell (single-quoted; an embedded `'` becomes `'\''`).
#[cfg(target_os = "macos")]
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Escape a string for embedding inside an AppleScript double-quoted literal.
#[cfg(target_os = "macos")]
fn applescript_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Le service système reprend le démarrage automatique du service actuel :
/// les privilèges et le démarrage se règlent séparément.
fn run_elevated_install() -> Result<()> {
    let config = enrolled_config();
    let mut args = vec!["service", "install", "--system", "--config", &config];
    if !service::autostart_enabled(service::installed_scope()) {
        args.push("--no-autostart");
    }
    run_elevated(&args)
}

/// Run this executable with `args` as root/administrator, behind the OS
/// authorization prompt, and wait for it. Fails when the prompt is declined.
#[cfg(target_os = "macos")]
pub fn run_elevated(args: &[&str]) -> Result<()> {
    let exe = current_exe_str()?;
    // `do shell script … with administrator privileges` shows the native auth
    // dialog and runs the command as root. Two quoting layers so an exe path with a
    // space or quote can't break out: the inner shell command single-quotes each
    // word, then the whole command is escaped for the AppleScript string literal.
    let shell_cmd = std::iter::once(exe.as_str())
        .chain(args.iter().copied())
        .map(shell_quote)
        .collect::<Vec<_>>()
        .join(" ");
    let script = format!(
        "do shell script \"{}\" with administrator privileges",
        applescript_escape(&shell_cmd)
    );
    let status = Command::new("osascript").arg("-e").arg(&script).status()?;
    if !status.success() {
        bail!("osascript elevation did not complete");
    }
    Ok(())
}

#[cfg(target_os = "linux")]
pub fn run_elevated(args: &[&str]) -> Result<()> {
    let exe = current_exe_str()?;
    let status = Command::new("pkexec").arg(&exe).args(args).status()?;
    if !status.success() {
        bail!("pkexec elevation did not complete");
    }
    Ok(())
}

/// One argument of a Windows command line, quoted when it needs to be.
#[cfg(target_os = "windows")]
fn windows_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '"']) {
        return arg.to_string();
    }
    format!("\"{}\"", arg.replace('"', "\\\""))
}

#[cfg(target_os = "windows")]
pub fn run_elevated(args: &[&str]) -> Result<()> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let exe = current_exe_str()?;
    // Start-Process -Verb RunAs triggers UAC; -Wait blocks until it finishes.
    // A PowerShell single-quoted string escapes an embedded quote by doubling it,
    // so a path containing `'` can't terminate the -FilePath argument early.
    let exe_ps = exe.replace('\'', "''");
    let args_ps = args
        .iter()
        .map(|a| windows_arg(a))
        .collect::<Vec<_>>()
        .join(" ")
        .replace('\'', "''");
    let ps = format!(
        "Start-Process -FilePath '{exe_ps}' -ArgumentList '{args_ps}' -Verb RunAs -WindowStyle Hidden -Wait",
    );
    // Started from the tray, a console program would open its own window.
    let status = Command::new("powershell")
        .args(["-NoProfile", "-Command", &ps])
        .creation_flags(CREATE_NO_WINDOW)
        .status()?;
    if !status.success() {
        bail!("UAC elevation did not complete");
    }
    Ok(())
}
