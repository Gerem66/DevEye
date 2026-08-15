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
        return Ok(Outcome::Done); // already a system service
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
        Ok(Outcome::Done) // not elevated — nothing to undo
    }
}

fn current_exe_str() -> Result<String> {
    Ok(std::env::current_exe()?.to_string_lossy().into_owned())
}

/// Le fichier d'enrôlement que le service élevé devra lire.
///
/// C'est **nous** qui le connaissons : nous tournons dessus. Le processus élevé,
/// lui, hérite de l'environnement de root (`pkexec` comme `sudo` réécrivent
/// `$HOME`) et ne peut que le deviner — il gravait ainsi
/// `/root/.config/deveye/agent.toml`, un fichier qui n'existe pas, et le service
/// système démarrait sans jamais trouver d'enrôlement.
fn enrolled_config() -> String {
    crate::config::Config::path().to_string_lossy().into_owned()
}

// ───────────────────────── interactive-session probe ───────────────────────
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

// ───────────────────────── OS-prompted privileged install ───────────────────
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

#[cfg(target_os = "macos")]
fn run_elevated_install() -> Result<()> {
    let exe = current_exe_str()?;
    // `do shell script … with administrator privileges` shows the native auth
    // dialog and runs the command as root. Two quoting layers so an exe path with a
    // space or quote can't break out: the inner shell command single-quotes the
    // path, then the whole command is escaped for the AppleScript string literal.
    let shell_cmd = format!(
        "{} service install --system --config {}",
        shell_quote(&exe),
        shell_quote(&enrolled_config())
    );
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
fn run_elevated_install() -> Result<()> {
    let exe = current_exe_str()?;
    let status = Command::new("pkexec")
        .arg(&exe)
        .args(["service", "install", "--system", "--config"])
        .arg(enrolled_config())
        .status()?;
    if !status.success() {
        bail!("pkexec elevation did not complete");
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn run_elevated_install() -> Result<()> {
    let exe = current_exe_str()?;
    // Start-Process -Verb RunAs triggers UAC; -Wait blocks until it finishes.
    // A PowerShell single-quoted string escapes an embedded quote by doubling it,
    // so a path containing `'` can't terminate the -FilePath argument early.
    let exe_ps = exe.replace('\'', "''");
    let cfg_ps = enrolled_config().replace('\'', "''");
    let ps = format!(
        "Start-Process -FilePath '{exe_ps}' -ArgumentList 'service install --system --config \"{cfg_ps}\"' -Verb RunAs -Wait",
    );
    let status = Command::new("powershell")
        .args(["-NoProfile", "-Command", &ps])
        .status()?;
    if !status.success() {
        bail!("UAC elevation did not complete");
    }
    Ok(())
}
