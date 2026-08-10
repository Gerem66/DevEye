//! OS-level persistence: install the agent as an autostart service at a per-user
//! or system level, inspect that state, and uninstall it. Backed by systemd
//! (Linux), launchd (macOS) and Task Scheduler (Windows).
//!
//! The service definition bakes the **absolute** executable + config paths and
//! runs `<exe> run --managed --config <path>`, so a system service (which has a
//! different HOME than the enrolling user) still finds the enrolled config, and
//! `--managed` tells a self-update to just exit and let the manager relaunch it.

use std::process::Command;

use anyhow::{bail, Context, Result};

use crate::config::Config;

/// How the agent is installed for persistence. Mirrors `deveye-types`
/// `agentServiceScopeSchema`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServiceScope {
    None,
    User,
    System,
}

impl ServiceScope {
    pub fn as_wire(self) -> &'static str {
        match self {
            ServiceScope::None => "none",
            ServiceScope::User => "user",
            ServiceScope::System => "system",
        }
    }
}

fn exe() -> Result<String> {
    Ok(std::env::current_exe()
        .context("locating executable")?
        .to_string_lossy()
        .into_owned())
}

fn config_path() -> String {
    Config::path().to_string_lossy().into_owned()
}

/// Le foyer de l'utilisateur **derrière** un éventuel `sudo`.
///
/// `dirs::home_dir()` suit `$HOME`, que `sudo` réécrit en `/root` sur une bonne
/// partie des distributions (`always_set_home`) — et pas sur les autres, d'où un
/// comportement qui change d'une machine à l'autre. Conséquence : un agent lancé
/// avec `sudo` cherchait l'unité *utilisateur* dans le foyer de root, ne l'y
/// trouvait pas, et annonçait `serviceScope = none` alors qu'un service
/// utilisateur était bel et bien installé — le bouton « Démarrage auto » de
/// l'interface s'en trouvait décoché, et l'élévation partait d'un état faux.
///
/// `SUDO_USER` nomme l'appelant d'origine ; on résout son foyer par `getent`, qui
/// interroge la vraie base de comptes (y compris LDAP), et on retombe sur
/// `/home/<user>` puis sur `$HOME` si rien ne répond.
#[cfg(unix)]
fn sudo_user() -> Option<String> {
    std::env::var("SUDO_USER").ok().filter(|s| !s.is_empty())
}

#[cfg(unix)]
fn invoking_home() -> Option<std::path::PathBuf> {
    let sudo_user = sudo_user()?;
    let home = crate::report::run("getent", &["passwd", &sudo_user])
        .and_then(|line| line.split(':').nth(5).map(|h| h.trim().to_string()))
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| format!("/home/{sudo_user}"));
    let path = std::path::PathBuf::from(home);
    path.is_dir().then_some(path)
}

/// Run a command, turning a non-zero exit into an error carrying stderr.
fn run_checked(cmd: &mut Command, what: &str) -> Result<()> {
    let out = cmd.output().with_context(|| format!("running {what}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        bail!("{what} failed: {}", err.trim());
    }
    Ok(())
}

/// Une seule définition de « suis-je root », partagée avec ce que le rapport
/// annonce à l'interface. En avoir deux, c'était pouvoir refuser une installation
/// système en se disant non privilégié pendant que l'interface affichait root —
/// ou l'inverse.
#[cfg(unix)]
fn is_root() -> bool {
    crate::report::is_privileged()
}

/// Install (or reinstall) the autostart service. `system` requires privilege.
pub fn install(system: bool) -> Result<()> {
    if system {
        require_privilege()?;
    }
    install_impl(system)
}

/// Remove whatever autostart service is installed (user or system).
pub fn uninstall() -> Result<()> {
    uninstall_impl()
}

/// Remove only the **per-user** autostart, leaving any system service in place.
/// Used after a successful elevation: the user-scope agent drops its own autostart
/// so the new system service is the single one that runs.
pub fn uninstall_user() -> Result<()> {
    uninstall_user_impl()
}

/// What's currently installed (filesystem/registry inspection, not how *this*
/// process was started).
pub fn installed_scope() -> ServiceScope {
    installed_scope_impl()
}

#[cfg(unix)]
fn require_privilege() -> Result<()> {
    if !is_root() {
        bail!("élévation requise : installez le service système avec les droits root");
    }
    Ok(())
}

#[cfg(windows)]
fn require_privilege() -> Result<()> {
    // The schtasks call itself fails without elevation; we surface that there.
    Ok(())
}

// ───────────────────────────── macOS (launchd) ─────────────────────────────
#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use std::path::PathBuf;

    const LABEL: &str = "com.deveye.agent";

    /// Emplacement d'écriture du plist utilisateur : toujours le foyer courant.
    fn user_plist() -> PathBuf {
        dirs::home_dir()
            .unwrap_or_default()
            .join("Library/LaunchAgents")
            .join(format!("{LABEL}.plist"))
    }

    /// Emplacements où un plist utilisateur peut *déjà* exister (cf. `invoking_home`).
    fn user_plists() -> Vec<PathBuf> {
        let mut paths = vec![user_plist()];
        if let Some(home) = invoking_home() {
            paths.push(
                home.join("Library/LaunchAgents")
                    .join(format!("{LABEL}.plist")),
            );
        }
        paths
    }
    fn system_plist() -> PathBuf {
        PathBuf::from("/Library/LaunchDaemons").join(format!("{LABEL}.plist"))
    }

    fn plist_xml() -> Result<String> {
        let exe = exe()?;
        let cfg = config_path();
        let log = Config::log_path();
        let log = log.to_string_lossy();
        Ok(format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{exe}</string>
    <string>run</string>
    <string>--managed</string>
    <string>--config</string>
    <string>{cfg}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <!-- 10 s between respawns: plenty for a self-update relaunch, but a broken
       binary or an instance-lock conflict can't hammer restarts every second. -->
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>{log}</string>
  <key>StandardErrorPath</key><string>{log}</string>
</dict>
</plist>
"#
        ))
    }

    pub fn install_impl(system: bool) -> Result<()> {
        // A clean slate: remove the *other* scope so we never run twice.
        let _ = uninstall_impl();
        let path = if system { system_plist() } else { user_plist() };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        std::fs::write(&path, plist_xml()?)
            .with_context(|| format!("writing {}", path.display()))?;
        // `load -w` works in the current domain (user session, or system when root).
        let _ = Command::new("launchctl").arg("unload").arg(&path).output();
        run_checked(
            Command::new("launchctl").arg("load").arg("-w").arg(&path),
            "launchctl load",
        )?;
        Ok(())
    }

    pub fn uninstall_impl() -> Result<()> {
        for path in [system_plist(), user_plist()] {
            if path.exists() {
                let _ = Command::new("launchctl")
                    .arg("unload")
                    .arg("-w")
                    .arg(&path)
                    .output();
                std::fs::remove_file(&path).ok();
            }
        }
        Ok(())
    }

    pub fn uninstall_user_impl() -> Result<()> {
        let path = user_plist();
        if path.exists() {
            let _ = Command::new("launchctl")
                .arg("unload")
                .arg("-w")
                .arg(&path)
                .output();
            std::fs::remove_file(&path).ok();
        }
        Ok(())
    }

    pub fn installed_scope_impl() -> ServiceScope {
        if system_plist().exists() {
            ServiceScope::System
        } else if user_plists().iter().any(|p| p.exists()) {
            ServiceScope::User
        } else {
            ServiceScope::None
        }
    }
}

// ───────────────────────────── Linux (systemd) ─────────────────────────────
#[cfg(target_os = "linux")]
mod imp {
    use super::*;
    use std::path::PathBuf;

    const UNIT: &str = "deveye-agent.service";

    /// Emplacement d'écriture de l'unité utilisateur : toujours le foyer courant.
    fn user_unit() -> PathBuf {
        dirs::config_dir()
            .unwrap_or_default()
            .join("systemd/user")
            .join(UNIT)
    }

    /// Emplacements où une unité utilisateur peut *déjà* exister — le foyer
    /// courant, et celui de l'appelant quand on tourne sous `sudo`.
    fn user_units() -> Vec<PathBuf> {
        let mut paths = vec![user_unit()];
        if let Some(home) = invoking_home() {
            paths.push(home.join(".config/systemd/user").join(UNIT));
        }
        paths
    }
    fn system_unit() -> PathBuf {
        PathBuf::from("/etc/systemd/system").join(UNIT)
    }

    fn unit_text(system: bool) -> Result<String> {
        let exe = exe()?;
        let cfg = config_path();
        let wanted_by = if system {
            "multi-user.target"
        } else {
            "default.target"
        };
        Ok(format!(
            "[Unit]\n\
             Description=DevEye monitoring agent\n\
             After=network-online.target\n\
             Wants=network-online.target\n\
             StartLimitIntervalSec=0\n\n\
             [Service]\n\
             ExecStart={exe} run --managed --config {cfg}\n\
             Restart=always\n\
             RestartSec=2\n\
             KillMode=process\n\n\
             [Install]\n\
             WantedBy={wanted_by}\n"
        ))
    }

    pub fn install_impl(system: bool) -> Result<()> {
        let _ = uninstall_impl();
        let path = if system { system_unit() } else { user_unit() };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        std::fs::write(&path, unit_text(system)?)
            .with_context(|| format!("writing {}", path.display()))?;
        if system {
            run_checked(
                Command::new("systemctl").arg("daemon-reload"),
                "systemctl daemon-reload",
            )?;
            run_checked(
                Command::new("systemctl").args(["enable", "--now", UNIT]),
                "systemctl enable",
            )?;
        } else {
            run_checked(
                Command::new("systemctl").args(["--user", "daemon-reload"]),
                "systemctl --user daemon-reload",
            )?;
            run_checked(
                Command::new("systemctl").args(["--user", "enable", "--now", UNIT]),
                "systemctl --user enable",
            )?;
            // Best effort: survive reboot without an interactive login.
            if let Some(user) = std::env::var("USER").ok().filter(|s| !s.is_empty()) {
                let _ = Command::new("loginctl")
                    .args(["enable-linger", &user])
                    .output();
            }
        }
        Ok(())
    }

    pub fn uninstall_impl() -> Result<()> {
        if system_unit().exists() {
            let _ = Command::new("systemctl")
                .args(["disable", "--now", UNIT])
                .output();
            std::fs::remove_file(system_unit()).ok();
            let _ = Command::new("systemctl").arg("daemon-reload").output();
        }
        uninstall_user_impl()
    }

    /// Retire l'autostart utilisateur, **où qu'il soit**.
    ///
    /// Ne regarder que le foyer courant laissait, après une élévation lancée sous
    /// `sudo`, l'unité de l'appelant en place : le service système et le service
    /// utilisateur tournaient alors tous les deux sur le même enrôlement, et le
    /// hub ne garde qu'une session par appareil — les deux se chassaient l'un
    /// l'autre en boucle. D'où une élévation qui « ne prend pas », par
    /// intermittence, selon celui des deux qui s'était reconnecté en dernier.
    pub fn uninstall_user_impl() -> Result<()> {
        for path in user_units() {
            if !path.exists() {
                continue;
            }
            // Arrêter l'unité demande de viser le bus de *son* utilisateur : en
            // root, `systemctl --user` parle au bus de root, qui ne la connaît
            // pas. `runuser` rebascule sur le bon. Au pire l'arrêt échoue, mais
            // le fichier part et l'unité ne reviendra pas au redémarrage.
            match sudo_user().filter(|_| is_root()) {
                Some(user) => {
                    let _ = Command::new("runuser")
                        .args([
                            "-u",
                            &user,
                            "--",
                            "systemctl",
                            "--user",
                            "disable",
                            "--now",
                            UNIT,
                        ])
                        .output();
                }
                None => {
                    let _ = Command::new("systemctl")
                        .args(["--user", "disable", "--now", UNIT])
                        .output();
                }
            }
            std::fs::remove_file(&path).ok();
            let _ = Command::new("systemctl")
                .args(["--user", "daemon-reload"])
                .output();
        }
        Ok(())
    }

    pub fn installed_scope_impl() -> ServiceScope {
        if system_unit().exists() {
            ServiceScope::System
        } else if user_units().iter().any(|p| p.exists()) {
            ServiceScope::User
        } else {
            ServiceScope::None
        }
    }
}

// ─────────────────────────── Windows (Task Scheduler) ───────────────────────
#[cfg(target_os = "windows")]
mod imp {
    use super::*;

    const TASK: &str = "DevEyeAgent";

    fn task_run() -> Result<String> {
        // schtasks /TR takes a single string; quote the exe + bake --config.
        Ok(format!(
            "\"{}\" run --managed --config \"{}\"",
            exe()?,
            config_path()
        ))
    }

    pub fn install_impl(system: bool) -> Result<()> {
        let _ = uninstall_impl();
        let tr = task_run()?;
        let mut cmd = Command::new("schtasks");
        cmd.args(["/Create", "/F", "/TN", TASK, "/TR", &tr]);
        if system {
            // Boot, as SYSTEM (needs elevation). Avoids implementing an SCM service.
            cmd.args(["/SC", "ONSTART", "/RU", "SYSTEM", "/RL", "HIGHEST"]);
        } else {
            cmd.args(["/SC", "ONLOGON", "/RL", "LIMITED"]);
        }
        run_checked(&mut cmd, "schtasks /Create")?;
        Ok(())
    }

    pub fn uninstall_impl() -> Result<()> {
        let _ = Command::new("schtasks")
            .args(["/Delete", "/F", "/TN", TASK])
            .output();
        Ok(())
    }

    // Windows uses a single task name for both scopes; `install(system)` already
    // replaces it, so there's no separate per-user task to remove after elevating.
    pub fn uninstall_user_impl() -> Result<()> {
        Ok(())
    }

    pub fn installed_scope_impl() -> ServiceScope {
        let out = match Command::new("schtasks")
            .args(["/Query", "/TN", TASK, "/FO", "LIST", "/V"])
            .output()
        {
            Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).into_owned(),
            _ => return ServiceScope::None,
        };
        // The "Run As User" line carries SYSTEM for a system-scope task.
        if out.to_uppercase().contains("SYSTEM") {
            ServiceScope::System
        } else {
            ServiceScope::User
        }
    }
}

use imp::{install_impl, installed_scope_impl, uninstall_impl, uninstall_user_impl};
