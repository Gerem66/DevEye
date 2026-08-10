//! Package-update management: detect the managers present on the host with their
//! pending-update counts, and apply a manager's updates while streaming output.
//!
//! Detection is best-effort and read-only (no root): a manager is reported only if
//! its binary exists. Applying updates needs root for most system managers — if the
//! agent isn't privileged we refuse with a clear message (elevate it first, see the
//! service/privilege flow). Per-user managers (brew, flatpak --user) apply directly.

use std::process::Stdio;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command as TokioCommand;
use tokio::sync::mpsc::Sender;

use crate::protocol::PackageManagerInfo;

/// Events streamed from a package task back to the session loop (which turns them
/// into wire messages carrying the device id).
pub enum PkgEvent {
    List(Vec<PackageManagerInfo>),
    Progress {
        manager: String,
        percent: Option<f64>,
        line: String,
    },
    Done {
        manager: String,
        ok: bool,
        reboot_required: bool,
        error: Option<String>,
    },
}

/// Échéance d'une sonde de détection.
///
/// Large — `softwareupdate -l` interroge les serveurs d'Apple, `apt-get -s
/// upgrade` attend le verrou dpkg — mais finie. `Command::output()`, qu'on
/// utilisait, attend son fils sans limite : un gestionnaire bloqué figeait la
/// détection entière, et l'écran restait sur « détection en cours… » sans que
/// rien n'arrive jamais.
const DETECT_TIMEOUT: Duration = Duration::from_secs(45);

/// Run a detection command; `None` when the binary is absent (spawn error) or the
/// probe timed out, else `(exit_success, stdout)`. Non-zero exits are still
/// returned (some tools signal "updates available" via the exit code).
fn probe(program: &str, args: &[&str]) -> Option<(bool, String)> {
    let out = crate::report::run_timeout(program, args, DETECT_TIMEOUT)?;
    Some((out.success, out.stdout))
}

/// Count non-blank lines — the pending-update heuristic for managers that print
/// one entry per line. Only the Linux/macOS managers use it; Windows parses winget
/// and Windows Update differently, so the helper isn't compiled there.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn count_nonempty(s: &str) -> u32 {
    s.lines().filter(|l| !l.trim().is_empty()).count() as u32
}

fn mgr(id: &'static str, pending: Option<u32>, needs_root: bool) -> PackageManagerInfo {
    PackageManagerInfo {
        id,
        pending_count: pending,
        needs_root,
        reboot_required: reboot_required(id),
    }
}

#[cfg(unix)]
fn privileged() -> bool {
    std::process::Command::new("id")
        .arg("-u")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim() == "0")
        .unwrap_or(false)
}

#[cfg(windows)]
fn privileged() -> bool {
    std::process::Command::new("net")
        .arg("session")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn reboot_required(_id: &str) -> bool {
    #[cfg(target_os = "linux")]
    {
        std::path::Path::new("/var/run/reboot-required").exists()
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

// ───────────────────────────────── detection ───────────────────────────────
/// Enumerate the package managers present on this host + their pending counts.
/// Synchronous (shells out); the caller runs it off the runtime via spawn_blocking.
pub fn detect() -> Vec<PackageManagerInfo> {
    let mut out = Vec::new();

    #[cfg(target_os = "macos")]
    {
        if let Some((_, s)) = probe("brew", &["outdated", "--quiet"]) {
            out.push(mgr("brew", Some(count_nonempty(&s)), false));
        }
        // softwareupdate is always present on macOS; `-l` is slow but on-demand.
        if let Some((_, s)) = probe("softwareupdate", &["-l"]) {
            let n = s
                .lines()
                .filter(|l| l.contains("* Label:") || l.trim_start().starts_with("* "))
                .count() as u32;
            out.push(mgr("softwareupdate", Some(n), true));
        }
    }

    #[cfg(target_os = "linux")]
    {
        if let Some((_, s)) = probe("apt-get", &["-s", "upgrade"]) {
            let n = s.lines().filter(|l| l.starts_with("Inst ")).count() as u32;
            out.push(mgr("apt", Some(n), true));
        }
        if let Some((_, s)) = probe("dnf", &["-q", "check-update"]) {
            out.push(mgr("dnf", Some(count_nonempty(&s)), true));
        }
        if let Some((_, s)) = probe("checkupdates", &[]) {
            out.push(mgr("pacman", Some(count_nonempty(&s)), true));
        }
        if let Some((_, s)) = probe("pamac", &["checkupdates", "-q"]) {
            out.push(mgr("pamac", Some(count_nonempty(&s)), false));
        }
        if let Some((_, s)) = probe("flatpak", &["remote-ls", "--updates"]) {
            out.push(mgr("flatpak", Some(count_nonempty(&s)), false));
        }
        if let Some((_, s)) = probe("snap", &["refresh", "--list"]) {
            // "All snaps up to date." => 0; else a header line + one row per snap.
            let n = if s.contains("up to date") {
                0
            } else {
                count_nonempty(&s).saturating_sub(1)
            };
            out.push(mgr("snap", Some(n), true));
        }
        if let Some((_, s)) = probe("zypper", &["-q", "list-updates"]) {
            // Table with a couple of header/separator lines; rows start with "v |".
            let n = s
                .lines()
                .filter(|l| l.trim_start().starts_with("v |"))
                .count() as u32;
            out.push(mgr("zypper", Some(n), true));
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Some((_, s)) = probe("winget", &["upgrade", "--include-unknown"]) {
            // Best-effort: rows after the header separator line (dashes).
            let n = s
                .lines()
                .skip_while(|l| !l.trim_start().starts_with("---"))
                .skip(1)
                .filter(|l| !l.trim().is_empty())
                .count() as u32;
            out.push(mgr("winget", Some(n), false));
        }
        // Windows Update via the PSWindowsUpdate module, when installed.
        if let Some((ok, s)) = probe(
            "powershell",
            &["-NoProfile", "-Command", "if (Get-Module -ListAvailable PSWindowsUpdate) { (Get-WindowsUpdate).Count } else { 'na' }"],
        ) {
            if ok && !s.contains("na") {
                let n = s.trim().parse::<u32>().ok();
                out.push(mgr("windowsupdate", n, true));
            }
        }
    }

    out
}

// ───────────────────────────────── upgrade ─────────────────────────────────
struct UpgradeSpec {
    program: &'static str,
    args: Vec<&'static str>,
    needs_root: bool,
}

fn upgrade_command(manager: &str) -> Result<UpgradeSpec> {
    let spec = match manager {
        "apt" => UpgradeSpec {
            program: "apt-get",
            args: vec!["-y", "upgrade"],
            needs_root: true,
        },
        "dnf" => UpgradeSpec {
            program: "dnf",
            args: vec!["-y", "upgrade"],
            needs_root: true,
        },
        "pacman" => UpgradeSpec {
            program: "pacman",
            args: vec!["-Syu", "--noconfirm"],
            needs_root: true,
        },
        "pamac" => UpgradeSpec {
            program: "pamac",
            args: vec!["upgrade", "--no-confirm"],
            needs_root: false,
        },
        "flatpak" => UpgradeSpec {
            program: "flatpak",
            args: vec!["update", "-y"],
            needs_root: false,
        },
        "snap" => UpgradeSpec {
            program: "snap",
            args: vec!["refresh"],
            needs_root: true,
        },
        "zypper" => UpgradeSpec {
            program: "zypper",
            args: vec!["-n", "update"],
            needs_root: true,
        },
        "brew" => UpgradeSpec {
            program: "brew",
            args: vec!["upgrade"],
            needs_root: false,
        },
        "softwareupdate" => UpgradeSpec {
            program: "softwareupdate",
            args: vec!["-i", "-a"],
            needs_root: true,
        },
        "winget" => UpgradeSpec {
            program: "winget",
            args: vec![
                "upgrade",
                "--all",
                "--silent",
                "--accept-source-agreements",
                "--accept-package-agreements",
            ],
            needs_root: false,
        },
        "windowsupdate" => UpgradeSpec {
            program: "powershell",
            args: vec![
                "-NoProfile",
                "-Command",
                "Install-WindowsUpdate -AcceptAll -IgnoreReboot",
            ],
            needs_root: true,
        },
        other => bail!("gestionnaire inconnu : {other}"),
    };
    Ok(spec)
}

/// Extract a percentage (e.g. "42%", "12.5%") from a line, if present.
fn parse_percent(line: &str) -> Option<f64> {
    let idx = line.find('%')?;
    let bytes = line.as_bytes();
    let mut start = idx;
    while start > 0 {
        let c = bytes[start - 1];
        if c.is_ascii_digit() || c == b'.' {
            start -= 1;
        } else {
            break;
        }
    }
    if start == idx {
        return None;
    }
    line[start..idx]
        .parse::<f64>()
        .ok()
        .filter(|v| (0.0..=100.0).contains(v))
}

/// Apply a manager's updates, streaming each output line as a `PkgEvent::Progress`
/// then a terminal `PkgEvent::Done`. Refuses (clear error) when root is required
/// and the agent isn't privileged.
pub async fn run_upgrade(manager: String, tx: Sender<PkgEvent>) {
    let result = upgrade_inner(&manager, &tx).await;
    let done = match result {
        Ok(reboot) => PkgEvent::Done {
            manager,
            ok: true,
            reboot_required: reboot,
            error: None,
        },
        Err(e) => PkgEvent::Done {
            manager,
            ok: false,
            reboot_required: false,
            error: Some(e.to_string()),
        },
    };
    let _ = tx.send(done).await;
}

async fn upgrade_inner(manager: &str, tx: &Sender<PkgEvent>) -> Result<bool> {
    let spec = upgrade_command(manager)?;
    if spec.needs_root && !privileged() {
        bail!("Agent non privilégié — élevez-le en service système (root) pour appliquer les mises à jour de {manager}");
    }

    let mut child = TokioCommand::new(spec.program)
        .args(&spec.args)
        .env("DEBIAN_FRONTEND", "noninteractive")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("lancement de {}", spec.program))?;

    let stdout = child.stdout.take().context("stdout")?;
    let stderr = child.stderr.take().context("stderr")?;

    // stderr in its own task so both streams flow live without one blocking the other.
    let tx_err = tx.clone();
    let mgr_err = manager.to_string();
    let err_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = tx_err.send(progress(&mgr_err, &line)).await;
        }
    });

    let mut lines = BufReader::new(stdout).lines();
    while let Some(line) = lines.next_line().await.context("reading output")? {
        let _ = tx.send(progress(manager, &line)).await;
    }
    let _ = err_task.await;

    let status = child.wait().await.context("waiting for process")?;
    if !status.success() {
        bail!("{} a échoué (code {:?})", manager, status.code());
    }
    Ok(reboot_required(manager))
}

fn progress(manager: &str, line: &str) -> PkgEvent {
    PkgEvent::Progress {
        manager: manager.to_string(),
        percent: parse_percent(line),
        line: line.trim_end().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_percent_extracts_values() {
        assert_eq!(parse_percent("Progress: 42%"), Some(42.0));
        assert_eq!(parse_percent("12.5% done"), Some(12.5));
        assert_eq!(parse_percent("0% complete"), Some(0.0));
        assert_eq!(parse_percent("Unpacking 100%"), Some(100.0));
    }

    #[test]
    fn parse_percent_rejects_garbage_and_out_of_range() {
        assert_eq!(parse_percent("no percent here"), None);
        assert_eq!(parse_percent("just a % sign"), None); // no digits before '%'
        assert_eq!(parse_percent("150%"), None); // out of 0..=100
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn count_nonempty_skips_blank_lines() {
        assert_eq!(count_nonempty("a\n\nb\n   \nc"), 3);
        assert_eq!(count_nonempty(""), 0);
        assert_eq!(count_nonempty("\n\n"), 0);
    }
}
