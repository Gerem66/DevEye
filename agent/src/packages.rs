//! Package-update management: detect the managers present on the host with their
//! pending-update counts, and apply a manager's updates while streaming output.
//!
//! Detection is best-effort and read-only (no root): a manager is reported only if
//! its binary exists. Applying updates needs root for most system managers — if the
//! agent isn't privileged we refuse with a clear message (elevate it first, see the
//! service/privilege flow). Per-user managers (brew, flatpak --user) apply directly.
//! Update tooling DevEye does not drive (rpm-ostree, fwupd, nix…) is reported too,
//! without a count, so the device's table says what else keeps it up to date.

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

/// Échéance d'une sonde de détection. Large (`softwareupdate -l` interroge les
/// serveurs d'Apple, `apt-get -s upgrade` attend le verrou dpkg) mais finie : un
/// gestionnaire bloqué figerait sinon la détection entière.
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

/// Rows of `dnf check-update`: `name.arch  version  repo`. The « Obsoleting
/// Packages » section repeats packages already counted, and a key-import
/// prompt or a metadata notice is not a row.
#[cfg(any(target_os = "linux", test))]
fn count_dnf_updates(s: &str) -> u32 {
    s.lines()
        .take_while(|l| !l.starts_with("Obsoleting"))
        .filter(|l| !l.starts_with(char::is_whitespace))
        .filter(|l| {
            let fields: Vec<&str> = l.split_whitespace().collect();
            fields.len() == 3 && fields[0].contains('.')
        })
        .count() as u32
}

/// Rows of a Flatpak transaction plan: each begins with its number (` 1.`),
/// then a separator. An end-of-life notice such as « 22.08 is… » is not one.
#[cfg(any(target_os = "linux", test))]
fn count_plan_rows(s: &str) -> u32 {
    s.lines()
        .filter(|line| {
            let t = line.trim_start();
            let digits = t.bytes().take_while(u8::is_ascii_digit).count();
            digits > 0
                && t[digits..].starts_with('.')
                && t[digits + 1..]
                    .chars()
                    .next()
                    .is_none_or(char::is_whitespace)
        })
        .count() as u32
}

/// What Flatpak would really update, system and user installations summed.
/// `flatpak update` without `-y` prints its numbered plan, then answers « n »
/// to its own prompt off a terminal (`flatpak_yes_no_prompt`): nothing is
/// pulled or deployed. It stops at the first installation with a plan, hence
/// one probe each. `remote-ls --updates` compares commit ids, and an OCI
/// remote (Fedora's) serves ids that never match the installed ones: every
/// ref of it would stay « to update » forever.
#[cfg(target_os = "linux")]
fn flatpak_pending() -> Option<u32> {
    let counts: Vec<u32> = ["--system", "--user"]
        .iter()
        .filter_map(|installation| probe("flatpak", &["update", installation]))
        .map(|(_, s)| count_plan_rows(&s))
        .collect();
    (!counts.is_empty()).then(|| counts.iter().sum())
}

fn mgr(id: &'static str, pending: Option<u32>, needs_root: bool) -> PackageManagerInfo {
    PackageManagerInfo {
        id,
        pending_count: pending,
        needs_root,
        reboot_required: reboot_required(id),
    }
}

/// Present on the machine, not driven by DevEye: no count, no upgrade.
fn unmanaged_mgr(id: &'static str) -> PackageManagerInfo {
    PackageManagerInfo {
        id,
        pending_count: None,
        needs_root: false,
        reboot_required: false,
    }
}

#[cfg(windows)]
const EXEC_SUFFIXES: &[&str] = &[".exe", ".cmd", ".bat", ".ps1"];
#[cfg(not(windows))]
const EXEC_SUFFIXES: &[&str] = &[""];

/// Whether an executable of this name sits in `PATH` or at one of `fallbacks`
/// (a service's `PATH` is short). A presence check only: these tools are
/// listed, never run.
fn installed(name: &str, fallbacks: &[&str]) -> bool {
    let in_path = std::env::var_os("PATH").is_some_and(|paths| {
        std::env::split_paths(&paths).any(|dir| {
            EXEC_SUFFIXES
                .iter()
                .any(|ext| dir.join(format!("{name}{ext}")).is_file())
        })
    });
    in_path || fallbacks.iter().any(|p| std::path::Path::new(p).exists())
}

/// Update tooling present on this host that DevEye does not drive.
fn unmanaged() -> Vec<&'static str> {
    let mut ids = Vec::new();

    #[cfg(target_os = "linux")]
    {
        // Une image atomique (Silverblue, Kinoite, CoreOS) : rpm-ostree la
        // tient, bootc n'en est que l'autre porte.
        if installed("rpm-ostree", &[]) {
            ids.push("rpm-ostree");
        } else if installed("bootc", &[]) {
            ids.push("bootc");
        }
        if installed("fwupdmgr", &[]) {
            ids.push("fwupd");
        }
        if installed(
            "nix-env",
            &[
                "/nix/var/nix/profiles/default/bin/nix-env",
                "/run/current-system/sw/bin/nix-env",
            ],
        ) {
            ids.push("nix");
        }
        for (bin, id) in [
            ("apk", "apk"),
            ("xbps-install", "xbps"),
            ("emerge", "emerge"),
            ("eopkg", "eopkg"),
        ] {
            if installed(bin, &[]) {
                ids.push(id);
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        if installed("mas", &["/opt/homebrew/bin/mas", "/usr/local/bin/mas"]) {
            ids.push("mas");
        }
        if installed("port", &["/opt/local/bin/port"]) {
            ids.push("macports");
        }
    }

    #[cfg(windows)]
    {
        if installed("choco", &[r"C:\ProgramData\chocolatey\bin\choco.exe"]) {
            ids.push("choco");
        }
        if installed("scoop", &[]) {
            ids.push("scoop");
        }
    }

    ids
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
        // Sur une image atomique, dnf lit les dépôts mais ne peut rien
        // appliquer : c'est rpm-ostree qui tient le système.
        if !std::path::Path::new("/run/ostree-booted").exists() {
            if let Some((_, s)) = probe("dnf", &["-q", "check-update"]) {
                out.push(mgr("dnf", Some(count_dnf_updates(&s)), true));
            }
        }
        if let Some((_, s)) = probe("checkupdates", &[]) {
            out.push(mgr("pacman", Some(count_nonempty(&s)), true));
        }
        if let Some((_, s)) = probe("pamac", &["checkupdates", "-q"]) {
            out.push(mgr("pamac", Some(count_nonempty(&s)), false));
        }
        if let Some(n) = flatpak_pending() {
            out.push(mgr("flatpak", Some(n), false));
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

    out.extend(unmanaged().into_iter().map(unmanaged_mgr));
    out
}

/// One command of an upgrade.
struct Step {
    program: &'static str,
    args: Vec<&'static str>,
}

/// An upgrade: its commands, run in order, the first failure ending it.
struct UpgradeSpec {
    steps: Vec<Step>,
    needs_root: bool,
}

fn one(program: &'static str, args: Vec<&'static str>, needs_root: bool) -> UpgradeSpec {
    UpgradeSpec {
        steps: vec![Step { program, args }],
        needs_root,
    }
}

fn upgrade_command(manager: &str) -> Result<UpgradeSpec> {
    let spec = match manager {
        // Les listes d'abord : sans elles, `upgrade` n'applique que ce que le
        // cache connaissait. Les deux options tranchent d'avance la question
        // qu'un fichier de configuration modifié poserait à dpkg, qu'aucun
        // terminal ne lirait.
        "apt" => UpgradeSpec {
            steps: vec![
                Step {
                    program: "apt-get",
                    args: vec!["update"],
                },
                Step {
                    program: "apt-get",
                    args: vec![
                        "-y",
                        "-o",
                        "Dpkg::Options::=--force-confdef",
                        "-o",
                        "Dpkg::Options::=--force-confold",
                        "upgrade",
                    ],
                },
            ],
            needs_root: true,
        },
        "dnf" => one("dnf", vec!["-y", "upgrade"], true),
        "pacman" => one("pacman", vec!["-Syu", "--noconfirm"], true),
        "pamac" => one("pamac", vec!["upgrade", "--no-confirm"], false),
        "flatpak" => one("flatpak", vec!["update", "-y", "--noninteractive"], false),
        "snap" => one("snap", vec!["refresh"], true),
        "zypper" => one("zypper", vec!["-n", "update"], true),
        "brew" => one("brew", vec!["upgrade"], false),
        "softwareupdate" => one("softwareupdate", vec!["-i", "-a"], true),
        "winget" => one(
            "winget",
            vec![
                "upgrade",
                "--all",
                "--silent",
                "--accept-source-agreements",
                "--accept-package-agreements",
            ],
            false,
        ),
        "windowsupdate" => one(
            "powershell",
            vec![
                "-NoProfile",
                "-Command",
                "Install-WindowsUpdate -AcceptAll -IgnoreReboot",
            ],
            true,
        ),
        other => bail!("gestionnaire non pris en charge : {other}"),
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
    for step in &spec.steps {
        run_step(manager, step, tx).await?;
    }
    Ok(reboot_required(manager))
}

/// Run one command, streaming both outputs as progress lines.
async fn run_step(manager: &str, step: &Step, tx: &Sender<PkgEvent>) -> Result<()> {
    let mut child = TokioCommand::new(step.program)
        .args(&step.args)
        .env("DEBIAN_FRONTEND", "noninteractive")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("lancement de {}", step.program))?;

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
        bail!(
            "{} {} a échoué (code {:?})",
            step.program,
            step.args.join(" "),
            status.code()
        );
    }
    Ok(())
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

    #[test]
    fn flatpak_plan_rows_are_the_numbered_ones() {
        let plan = "Looking for updates…\n\
Info: org.kde.Platform is end-of-life, with reason:\n\
   22.08 is no longer supported.\n\
\n\
 1.\t   \torg.freedesktop.Platform.GL.default\t23.08\tu\tflathub\t< 139,1 MB\n\
 2.\t   \tnet.thunderbird.Thunderbird\tstable\tu\tfedora\t< 90 MB\n\
10.\t   \torg.kde.Platform.Locale\t6.7\tr\t\n\
\n\
Proceed with these changes to the system installation? [Y/n]: n\n";
        assert_eq!(count_plan_rows(plan), 3);
        assert_eq!(
            count_plan_rows("Looking for updates…\n\nNothing to update.\n"),
            0
        );
    }

    #[test]
    fn dnf_rows_skip_obsoletes_and_notices() {
        let out = "\n\
code.x86_64                1.139.1-1790309585.el8        code\n\
kernel-core.x86_64         6.11.4-301.fc41               updates\n\
Last metadata expiration check: 0:10:02 ago on Sat 27 Sep 2026.\n\
Obsoleting Packages\n\
grub2-tools.x86_64         1:2.12-10.fc41                updates\n\
    grub2-tools.x86_64     1:2.12-9.fc41                 @updates\n";
        assert_eq!(count_dnf_updates(out), 2);
        assert_eq!(count_dnf_updates(""), 0);
    }

    #[test]
    fn apt_upgrade_refreshes_lists_first() {
        let spec = upgrade_command("apt").expect("apt is driven");
        assert_eq!(spec.steps.len(), 2);
        assert_eq!(spec.steps[0].args, vec!["update"]);
        assert!(spec.steps[1]
            .args
            .contains(&"Dpkg::Options::=--force-confold"));
        assert!(upgrade_command("rpm-ostree").is_err());
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn count_nonempty_skips_blank_lines() {
        assert_eq!(count_nonempty("a\n\nb\n   \nc"), 3);
        assert_eq!(count_nonempty(""), 0);
        assert_eq!(count_nonempty("\n\n"), 0);
    }
}
