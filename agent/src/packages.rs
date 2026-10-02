//! Package-update management: list the update tools present on the host, count
//! each managed one's pending updates, and apply a manager's updates while
//! streaming output.
//!
//! Presence is a file check (the binary in `PATH`), read-only and instant; the
//! counts shell out to each tool, one at a time, and leave as they come.
//! Applying updates needs root for most system managers: if the agent isn't
//! privileged we refuse with a clear message (elevate it first, see the
//! service/privilege flow). Per-user managers (brew, flatpak --user) apply
//! directly. Update tooling DevEye does not drive (rpm-ostree, fwupd, nix…) is
//! listed too, without a count, so the device's table says what else keeps it
//! up to date.

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
    Count {
        manager: &'static str,
        pending: Option<u32>,
    },
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

/// Échéance d'une sonde de comptage. Large (`softwareupdate -l` interroge les
/// serveurs d'Apple, `apt-get -s upgrade` attend le verrou dpkg) mais finie : un
/// gestionnaire bloqué ne ferait sinon jamais partir son compte.
const DETECT_TIMEOUT: Duration = Duration::from_secs(45);

/// Run a probe; `None` when the binary is absent (spawn error) or the probe
/// timed out, else `(exit_success, stdout)`. Non-zero exits are still returned
/// (some tools signal "updates available" via the exit code).
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

fn mgr(id: &'static str, needs_root: bool) -> PackageManagerInfo {
    PackageManagerInfo {
        id,
        needs_root,
        reboot_required: reboot_required(id),
    }
}

/// Present on the machine, not driven by DevEye: no count, no upgrade.
fn unmanaged_mgr(id: &'static str) -> PackageManagerInfo {
    PackageManagerInfo {
        id,
        needs_root: false,
        reboot_required: false,
    }
}

#[cfg(windows)]
const EXEC_SUFFIXES: &[&str] = &[".exe", ".cmd", ".bat", ".ps1"];
#[cfg(not(windows))]
const EXEC_SUFFIXES: &[&str] = &[""];

/// Whether an executable of this name sits in `PATH` or at one of `fallbacks`
/// (a service's `PATH` is short). A presence check only, nothing runs. A
/// managed tool gets no fallback: it is listed only where its probe and its
/// upgrade, which run through `PATH`, would find it.
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

/// Whether a PowerShell module sits in a `PSModulePath` directory: a file
/// check, where `Get-Module -ListAvailable` takes seconds.
#[cfg(windows)]
fn ps_module_installed(name: &str) -> bool {
    std::env::var_os("PSModulePath")
        .is_some_and(|paths| std::env::split_paths(&paths).any(|dir| dir.join(name).is_dir()))
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

/// The update tools present on this host, those DevEye drives first. A file
/// check only, answered at once: the counts follow, one by one.
pub fn present() -> Vec<PackageManagerInfo> {
    let mut out = Vec::new();

    #[cfg(target_os = "macos")]
    {
        if installed("brew", &[]) {
            out.push(mgr("brew", false));
        }
        if installed("softwareupdate", &[]) {
            out.push(mgr("softwareupdate", true));
        }
    }

    #[cfg(target_os = "linux")]
    {
        if installed("apt-get", &[]) {
            out.push(mgr("apt", true));
        }
        // Sur une image atomique, dnf lit les dépôts mais ne peut rien
        // appliquer : c'est rpm-ostree qui tient le système.
        if installed("dnf", &[]) && !std::path::Path::new("/run/ostree-booted").exists() {
            out.push(mgr("dnf", true));
        }
        if installed("pacman", &[]) {
            out.push(mgr("pacman", true));
        }
        if installed("pamac", &[]) {
            out.push(mgr("pamac", false));
        }
        if installed("flatpak", &[]) {
            out.push(mgr("flatpak", false));
        }
        if installed("snap", &[]) {
            out.push(mgr("snap", true));
        }
        if installed("zypper", &[]) {
            out.push(mgr("zypper", true));
        }
    }

    #[cfg(windows)]
    {
        if installed("winget", &[]) {
            out.push(mgr("winget", false));
        }
        // Windows Update via the PSWindowsUpdate module, when installed.
        if ps_module_installed("PSWindowsUpdate") {
            out.push(mgr("windowsupdate", true));
        }
    }

    out.extend(unmanaged().into_iter().map(unmanaged_mgr));
    out
}

/// The pending-update count of one managed tool, by its own probe. `None` when
/// it gave none: helper missing (`checkupdates` without pacman-contrib),
/// timeout, or output the parser does not read.
pub fn pending(manager: &str) -> Option<u32> {
    match manager {
        #[cfg(target_os = "macos")]
        "brew" => probe("brew", &["outdated", "--quiet"]).map(|(_, s)| count_nonempty(&s)),
        #[cfg(target_os = "macos")]
        "softwareupdate" => probe("softwareupdate", &["-l"]).map(|(_, s)| {
            s.lines()
                .filter(|l| l.contains("* Label:") || l.trim_start().starts_with("* "))
                .count() as u32
        }),
        #[cfg(target_os = "linux")]
        "apt" => probe("apt-get", &["-s", "upgrade"])
            .map(|(_, s)| s.lines().filter(|l| l.starts_with("Inst ")).count() as u32),
        #[cfg(target_os = "linux")]
        "dnf" => probe("dnf", &["-q", "check-update"]).map(|(_, s)| count_dnf_updates(&s)),
        #[cfg(target_os = "linux")]
        "pacman" => probe("checkupdates", &[]).map(|(_, s)| count_nonempty(&s)),
        #[cfg(target_os = "linux")]
        "pamac" => probe("pamac", &["checkupdates", "-q"]).map(|(_, s)| count_nonempty(&s)),
        #[cfg(target_os = "linux")]
        "flatpak" => flatpak_pending(),
        #[cfg(target_os = "linux")]
        "snap" => probe("snap", &["refresh", "--list"]).map(|(_, s)| {
            // "All snaps up to date." => 0; else a header line + one row per snap.
            if s.contains("up to date") {
                0
            } else {
                count_nonempty(&s).saturating_sub(1)
            }
        }),
        #[cfg(target_os = "linux")]
        "zypper" => probe("zypper", &["-q", "list-updates"]).map(|(_, s)| {
            // Table with a couple of header/separator lines; rows start with "v |".
            s.lines()
                .filter(|l| l.trim_start().starts_with("v |"))
                .count() as u32
        }),
        #[cfg(windows)]
        "winget" => probe("winget", &["upgrade", "--include-unknown"]).map(|(_, s)| {
            // Best-effort: rows after the header separator line (dashes).
            s.lines()
                .skip_while(|l| !l.trim_start().starts_with("---"))
                .skip(1)
                .filter(|l| !l.trim().is_empty())
                .count() as u32
        }),
        #[cfg(windows)]
        "windowsupdate" => probe(
            "powershell",
            &["-NoProfile", "-Command", "(Get-WindowsUpdate).Count"],
        )
        .filter(|(ok, _)| *ok)
        .and_then(|(_, s)| s.trim().parse::<u32>().ok()),
        _ => None,
    }
}

/// Whether DevEye drives this tool: it has an upgrade command.
pub fn is_managed(id: &str) -> bool {
    upgrade_command(id).is_ok()
}

/// Answer a `pkg.list`: the tools present at once, then each managed one's
/// count as its probe finishes. One probe at a time: run together, they would
/// fight over the OS package lock and the machine.
pub async fn run_list(tx: Sender<PkgEvent>) {
    let managers = tokio::task::spawn_blocking(present)
        .await
        .unwrap_or_default();
    let managed: Vec<&'static str> = managers
        .iter()
        .map(|m| m.id)
        .filter(|id| is_managed(id))
        .collect();
    if tx.send(PkgEvent::List(managers)).await.is_err() {
        return;
    }
    for manager in managed {
        let pending = tokio::task::spawn_blocking(move || pending(manager))
            .await
            .unwrap_or(None);
        if tx.send(PkgEvent::Count { manager, pending }).await.is_err() {
            return;
        }
    }
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
            error: Some(cap_error(&e.to_string())),
        },
    };
    let _ = tx.send(done).await;
}

/// Plafond du message d'échec, celui du schéma (`agentPkgDonePayloadSchema`,
/// en unités UTF-16) : au-delà, le serveur rejetterait la trame entière et la
/// mise à jour resterait « en cours » à l'écran.
const ERROR_MAX: usize = 500;

fn cap_error(message: &str) -> String {
    if message.encode_utf16().count() <= ERROR_MAX {
        return message.to_string();
    }
    let mut out = String::new();
    let mut units = 0;
    for c in message.chars() {
        units += c.len_utf16();
        if units > ERROR_MAX - 1 {
            break;
        }
        out.push(c);
    }
    out.push('…');
    out
}

/// La dernière ligne lisible d'une sortie : une barre de progression réécrit
/// sa ligne par des retours chariot, seul le dernier état compte.
fn last_state(line: &str) -> Option<String> {
    let t = line
        .rsplit('\r')
        .find(|part| !part.trim().is_empty())?
        .trim();
    (!t.is_empty()).then(|| t.to_string())
}

/// Le message d'un échec : la commande, son code, et la dernière ligne que
/// l'outil a écrite, qui en dit d'ordinaire la raison.
fn failure_message(step: &Step, code: Option<i32>, reason: Option<&str>) -> String {
    let code = match code {
        Some(c) => format!("code {c}"),
        None => "interrompue par un signal".to_string(),
    };
    let base = format!("{} {} a échoué ({code})", step.program, step.args.join(" "));
    match reason {
        Some(r) => format!("{base} : {r}"),
        None => base,
    }
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
        let mut last = None;
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            last = last_state(&line).or(last);
            let _ = tx_err.send(progress(&mgr_err, &line)).await;
        }
        last
    });

    let mut last_out = None;
    let mut lines = BufReader::new(stdout).lines();
    while let Some(line) = lines.next_line().await.context("reading output")? {
        last_out = last_state(&line).or(last_out);
        let _ = tx.send(progress(manager, &line)).await;
    }
    let last_err = err_task.await.ok().flatten();

    let status = child.wait().await.context("waiting for process")?;
    if !status.success() {
        // L'erreur d'un outil va sur stderr ; sinon, sa dernière ligne tout court.
        let reason = last_err.or(last_out);
        bail!(
            "{}",
            failure_message(step, status.code(), reason.as_deref())
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
    fn failure_says_the_tool_reason_with_a_plain_code() {
        let step = Step {
            program: "flatpak",
            args: vec!["update", "-y"],
        };
        assert_eq!(
            failure_message(&step, Some(1), Some("error: No remote refs found")),
            "flatpak update -y a échoué (code 1) : error: No remote refs found"
        );
        assert_eq!(
            failure_message(&step, None, None),
            "flatpak update -y a échoué (interrompue par un signal)"
        );
        assert_eq!(
            last_state("Téléchargement 10%\rTéléchargement 80%\r  ").as_deref(),
            Some("Téléchargement 80%")
        );
        assert_eq!(last_state("   "), None);
    }

    #[test]
    fn error_fits_the_schema_cap() {
        let long = "é".repeat(ERROR_MAX + 50);
        let capped = cap_error(&long);
        assert_eq!(capped.encode_utf16().count(), ERROR_MAX);
        assert!(capped.ends_with('…'));
        assert_eq!(cap_error("court"), "court");
        let emoji = "😀".repeat(ERROR_MAX);
        assert!(cap_error(&emoji).encode_utf16().count() <= ERROR_MAX);
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
