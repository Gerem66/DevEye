//! OS-level persistence: install the agent as an autostart service at a per-user
//! or system level, inspect that state, and uninstall it. Backed by systemd
//! (Linux), launchd (macOS) and Task Scheduler (Windows).
//!
//! The service definition bakes the **absolute** executable + config paths and
//! runs `<exe> run --managed --config <path>`, so a system service (which has a
//! different HOME than the enrolling user) still finds the enrolled config, and
//! `--managed` tells a self-update to just exit and let the manager relaunch it.
//!
//! Deux pièges d'une installation système. Elle tourne sous `pkexec`/`sudo`,
//! donc dans l'environnement de root : le chemin de config calculé là désigne le
//! foyer de root, d'où [`invoking_config_path`] et un `--config` explicite quand
//! l'appelant le connaît. Et sous SELinux (famille Fedora), `init` n'a pas le
//! droit d'exécuter un fichier étiqueté `user_home_t` : l'exécutable est recopié
//! dans un emplacement système avant d'être désigné (`stage_system_exe`).

use std::process::Command;

use anyhow::{bail, Context, Result};

use crate::config::Config;

/// How the agent is installed for persistence. Mirrors `@deveye/types`
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

/// L'appelant d'origine derrière un `sudo`. `dirs::home_dir()` suit `$HOME`,
/// que `sudo` réécrit en `/root` sur une partie des distributions
/// (`always_set_home`) : sans cela un agent lancé sous `sudo` cherche l'unité
/// utilisateur dans le foyer de root et annonce `serviceScope = none` à tort.
#[cfg(unix)]
fn sudo_user() -> Option<String> {
    std::env::var("SUDO_USER").ok().filter(|s| !s.is_empty())
}

/// La clé `getent passwd` de l'appelant d'origine : son nom sous `sudo`, son uid
/// sous `pkexec`, qui ne pose pas `SUDO_USER` mais `PKEXEC_UID`. C'est `pkexec`
/// qui élève l'agent sur Linux (voir `elevate.rs`).
#[cfg(unix)]
fn invoking_key() -> Option<String> {
    sudo_user().or_else(|| {
        std::env::var("PKEXEC_UID")
            .ok()
            .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()))
    })
}

/// Le foyer de l'appelant d'origine sous `sudo`/`pkexec`, quand on peut le
/// nommer. Le retrait doit balayer son dossier de config, pas celui de root
/// (voir `uninstall::config_dirs`).
#[cfg(unix)]
pub(crate) fn invoking_home() -> Option<std::path::PathBuf> {
    let key = invoking_key()?;
    let home = crate::report::run("getent", &["passwd", &key])
        .and_then(|line| line.split(':').nth(5).map(|h| h.trim().to_string()))
        .filter(|h| !h.is_empty())
        // Le repli ne vaut que pour un nom : `/home/1000` n'existe pas.
        .or_else(|| sudo_user().map(|user| format!("/home/{user}")))?;
    let path = std::path::PathBuf::from(home);
    path.is_dir().then_some(path)
}

/// Le fichier de config à graver dans la définition du service.
///
/// `Config::path()` suit `$HOME`, que `pkexec` et `sudo` remplacent par celui de
/// root : une installation système graverait `/root/.config/deveye/agent.toml`,
/// qui n'existe pas. On vise donc le foyer de l'appelant d'origine.
/// `DEVEYE_CONFIG` reste prioritaire : choix explicite, et ce que l'agent
/// supervisé se transmet lors d'un relais.
#[cfg(unix)]
fn invoking_config_path() -> String {
    if let Ok(explicit) = std::env::var("DEVEYE_CONFIG") {
        if !explicit.is_empty() {
            return explicit;
        }
    }
    match invoking_home() {
        Some(home) => home
            .join(".config/deveye/agent.toml")
            .to_string_lossy()
            .into_owned(),
        None => config_path(),
    }
}

#[cfg(windows)]
fn invoking_config_path() -> String {
    // `Start-Process -Verb RunAs` élève l'utilisateur courant : son profil, et
    // donc son `%APPDATA%`, ne changent pas. Rien à corriger ici.
    config_path()
}

/// Le chemin de config de la définition de service : celui qu'on nous impose,
/// sinon celui de l'utilisateur pour qui on installe.
fn unit_config_path(config: Option<&str>) -> String {
    match config {
        Some(path) if !path.is_empty() => path.to_string(),
        _ => invoking_config_path(),
    }
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
/// annonce à l'interface.
#[cfg(unix)]
fn is_root() -> bool {
    crate::report::is_privileged()
}

/// Install (or reinstall) the autostart service. `system` requires privilege.
///
/// Installe sans lancer : l'ordre arrive par l'agent déjà en marche, et
/// démarrer tout de suite ferait naître un second agent, refusé par la garde
/// d'instance unique (sous systemd sans erreur visible, l'unité rebouclant ;
/// sous launchd un respawn toutes les dix secondes). Le relais est explicite :
/// installer, rendre la main, puis l'appelant cède la place ([`start`],
/// `commands::handle_service`).
///
/// `config` grave un fichier d'enrôlement précis : l'appelant qui élève l'agent
/// le connaît, le processus élevé ne peut que le deviner ([`invoking_config_path`]).
pub fn install(system: bool, config: Option<&str>, autostart: bool) -> Result<()> {
    if system {
        require_privilege()?;
    }
    install_impl(system, config, autostart)?;
    let scope = if system {
        crate::tray::autostart::Scope::System
    } else {
        crate::tray::autostart::Scope::User
    };
    if let Err(e) = crate::tray::autostart::ensure_if_desktop(scope) {
        tracing::warn!(error = %e, "cannot register the tray icon at login");
    }
    Ok(())
}

/// Démarre le service déjà installé. Utilisé par le passage de relais, une fois
/// le verrou d'instance unique libéré.
pub fn start(system: bool) -> Result<()> {
    start_impl(system)
}

/// Can this machine run the service at all? Checked by `link --autostart`
/// before the link code is spent, since the install itself comes after.
pub fn preflight(system: bool) -> Result<()> {
    if system {
        require_privilege()?;
    }
    preflight_impl(system)
}

/// Restart the installed service, so the agent reads its config again.
pub fn restart(system: bool) -> Result<()> {
    restart_impl(system)
}

/// Stop the installed service until the next boot (or login, for a per-user
/// one), without disabling it.
pub fn stop(system: bool) -> Result<()> {
    if system {
        require_privilege()?;
    }
    stop_impl(system)
}

/// Remove whatever autostart service is installed (user or system).
pub fn uninstall() -> Result<()> {
    uninstall_impl()
}

/// Éteint le « linger » qu'une installation *utilisateur* avait allumé. Rend
/// `true` s'il y avait effectivement quelque chose à éteindre.
///
/// Sans OS concerné (macOS, Windows), c'est un non-événement : le linger est une
/// notion systemd.
pub fn disable_linger() -> Result<bool> {
    disable_linger_impl()
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

/// Le service installé repartira-t-il au prochain démarrage (ou à la prochaine
/// ouverture de session) ? Toujours `false` sans service.
pub fn autostart_enabled(scope: ServiceScope) -> bool {
    match scope {
        ServiceScope::None => false,
        ServiceScope::User => autostart_enabled_impl(false),
        ServiceScope::System => autostart_enabled_impl(true),
    }
}

/// Arme ou désarme le service installé pour les démarrages suivants, sans le
/// démarrer ni l'arrêter : l'agent en marche continue de tourner.
pub fn set_autostart(system: bool, on: bool) -> Result<()> {
    if system {
        require_privilege()?;
    }
    set_autostart_impl(system, on)
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

    fn plist_xml(cfg: &str) -> Result<String> {
        let exe = exe()?;
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

    /// Domaine launchd visé : `system` pour un démon, `gui/<uid>` pour un agent.
    ///
    /// L'uid est celui de l'utilisateur **derrière** un éventuel `sudo`, comme le
    /// foyer où l'on écrit le plist : viser `gui/0` alors que le plist part dans
    /// `/Users/…/Library/LaunchAgents` désignerait deux utilisateurs différents.
    fn domain(system: bool) -> String {
        if system {
            return "system".to_string();
        }
        let uid = match sudo_user() {
            Some(user) => crate::report::run("id", &["-u", &user]),
            None => crate::report::run("id", &["-u"]),
        };
        let uid = uid
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "0".to_string());
        format!("gui/{uid}")
    }

    fn service_target(system: bool) -> String {
        format!("{}/{LABEL}", domain(system))
    }

    /// Retire le travail du domaine, sans le marquer désactivé.
    ///
    /// `bootout` défait ce que `bootstrap` a fait. `unload -w` basculerait en
    /// plus le label dans la base des travaux désactivés, un état qui survit à
    /// la suppression du plist et que seul un `enable` explicite efface.
    fn bootout(system: bool) {
        let _ = Command::new("launchctl")
            .args(["bootout", &service_target(system)])
            .output();
    }

    pub fn install_impl(system: bool, config: Option<&str>, autostart: bool) -> Result<()> {
        // Avant le ménage : `invoking_config_path` lit l'environnement, que la
        // désinstallation peut faire changer en nous arrêtant.
        let cfg = unit_config_path(config);
        // A clean slate: remove the *other* scope so we never run twice.
        let _ = uninstall_impl();
        let path = if system { system_plist() } else { user_plist() };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        std::fs::write(&path, plist_xml(&cfg)?)
            .with_context(|| format!("writing {}", path.display()))?;
        // Pose l'état voulu, et lève au passage un « désactivé » hérité d'un
        // `unload -w`.
        set_autostart_impl(system, autostart)
    }

    /// Désactivé, un travail reste chargé s'il l'est déjà, mais ne se charge
    /// plus : ni à l'amorçage, ni par `bootstrap`.
    pub fn set_autostart_impl(system: bool, on: bool) -> Result<()> {
        let verb = if on { "enable" } else { "disable" };
        run_checked(
            Command::new("launchctl").args([verb, &service_target(system)]),
            &format!("launchctl {verb}"),
        )
    }

    pub fn autostart_enabled_impl(system: bool) -> bool {
        crate::report::run("launchctl", &["print-disabled", &domain(system)])
            .is_some_and(|listing| !launchd_disabled(&listing, LABEL))
    }

    /// `bootstrap` enregistre le travail dans le domaine ; `RunAtLoad` le lance
    /// dans la foulée. Repli sur `load` pour les macOS d'avant `bootstrap`. Un
    /// travail désarmé est réarmé le temps du chargement, puis désarmé à nouveau.
    pub fn start_impl(system: bool) -> Result<()> {
        let path = if system { system_plist() } else { user_plist() };
        let armed = autostart_enabled_impl(system);
        if !armed {
            set_autostart_impl(system, true)?;
        }
        bootout(system);
        let mut cmd = Command::new("launchctl");
        cmd.arg("bootstrap").arg(domain(system)).arg(&path);
        let started = run_checked(&mut cmd, "launchctl bootstrap").or_else(|_| {
            run_checked(
                Command::new("launchctl").arg("load").arg(&path),
                "launchctl load",
            )
        });
        if !armed {
            set_autostart_impl(system, false)?;
        }
        started
    }

    /// A per-user agent lives in a login session: over SSH, without one,
    /// `bootstrap gui/<uid>` fails.
    pub fn preflight_impl(system: bool) -> Result<()> {
        if system {
            return Ok(());
        }
        run_checked(
            Command::new("launchctl").args(["print", &domain(false)]),
            "launchctl print",
        )
        .context("no login session for this user: run as root for a system service")
    }

    /// `start_impl` already begins with a `bootout`.
    pub fn restart_impl(system: bool) -> Result<()> {
        start_impl(system)
    }

    /// `bootout` without touching the plist: `RunAtLoad` loads it again at the
    /// next boot or login. Stopping alone would be undone by `KeepAlive`.
    pub fn stop_impl(system: bool) -> Result<()> {
        run_checked(
            Command::new("launchctl").args(["bootout", &service_target(system)]),
            "launchctl bootout",
        )
    }

    pub fn uninstall_impl() -> Result<()> {
        for (system, path) in [(true, system_plist()), (false, user_plist())] {
            if path.exists() {
                bootout(system);
                std::fs::remove_file(&path).ok();
            }
        }
        Ok(())
    }

    /// Pas de linger sous launchd : un `LaunchAgent` suit la session, un
    /// `LaunchDaemon` l'amorçage, et rien ne se règle en dehors du plist.
    pub fn disable_linger_impl() -> Result<bool> {
        Ok(false)
    }

    pub fn uninstall_user_impl() -> Result<()> {
        for path in user_plists() {
            if path.exists() {
                bootout(false);
                std::fs::remove_file(&path).ok();
            }
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

    /// Emplacements où une unité utilisateur peut déjà exister : le foyer
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

    /// Où le service **système** garde son exécutable.
    ///
    /// `/usr/local/bin` est étiqueté `bin_t` par la politique SELinux — y compris
    /// sur les systèmes ostree, où `/usr/local` est un lien vers `/var/usrlocal`
    /// et reste inscriptible. C'est ce qui rend le fichier exécutable par `init`,
    /// et c'est toute la raison de la recopie.
    const SYSTEM_EXE: &str = "/usr/local/bin/deveye-agent";

    /// Recopie l'exécutable hors du foyer de l'utilisateur, pour le service système.
    ///
    /// Sans elle, l'unité boucle sur `203/EXEC` sur toute machine à SELinux :
    /// dans un `/home` le binaire porte l'étiquette `user_home_t`, que `init_t`
    /// n'a pas le droit d'exécuter (refus visible seulement dans le journal
    /// d'audit). Cela détache aussi le service du fichier téléchargé.
    fn stage_system_exe() -> Result<String> {
        use std::os::unix::fs::PermissionsExt;

        let src = std::env::current_exe().context("locating executable")?;
        let dest = PathBuf::from(SYSTEM_EXE);
        // `current_exe` rend un chemin résolu (`/proc/self/exe`) : la comparaison
        // doit résoudre la destination aussi, sans quoi `/usr/local/bin` et
        // `/var/usrlocal/bin` (le même répertoire sur ostree) passeraient pour
        // deux endroits, et on se recopierait par-dessus soi-même.
        if std::fs::canonicalize(&dest)
            .map(|d| d == src)
            .unwrap_or(false)
        {
            return Ok(SYSTEM_EXE.to_string());
        }

        let parent = dest.parent().context("SYSTEM_EXE has no parent")?;
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;

        // Copie à côté puis `rename` : atomique, et surtout écrire *dans* la
        // destination échouerait en `ETXTBSY` si un agent tourne déjà dessus.
        let staged = parent.join(".deveye-agent.new");
        std::fs::copy(&src, &staged)
            .with_context(|| format!("copying {} to {}", src.display(), staged.display()))?;
        std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755))
            .with_context(|| format!("setting mode on {}", staged.display()))?;
        std::fs::rename(&staged, &dest)
            .with_context(|| format!("installing {}", dest.display()))?;

        // Filet, non requis : un fichier créé dans `/usr/local/bin` hérite déjà
        // de `bin_t`. La commande n'existe pas hors SELinux, d'où le silence.
        let _ = Command::new("restorecon").args(["-F", SYSTEM_EXE]).output();
        Ok(SYSTEM_EXE.to_string())
    }

    /// Le durcissement du service système, et pourquoi il est si court. Tout ce
    /// que systemd confine s'applique aussi aux enfants de l'agent, et ses
    /// enfants sont le shell root de l'opérateur et les mises à jour de paquets :
    /// `ProtectSystem`, `ProtectHome`, `NoNewPrivileges`, `PrivateTmp`,
    /// `ProtectKernelTunables` ou un jeu de capacités réduit casseraient `apt`
    /// (profils AppArmor, `sysctl`, fichiers setuid), `su`, `smartctl` ou
    /// l'explorateur. Ne restent que les directives qu'aucune de ces tâches ne
    /// rencontre. Ce qu'une machine refuse au serveur se règle dans sa
    /// `[policy]`, pas ici.
    const SYSTEM_HARDENING: &str = "RestrictRealtime=yes\nLockPersonality=yes\n";

    fn unit_text(system: bool, exe: &str, cfg: &str) -> String {
        let wanted_by = if system {
            "multi-user.target"
        } else {
            "default.target"
        };
        let hardening = if system { SYSTEM_HARDENING } else { "" };
        format!(
            "[Unit]\n\
             Description=DevEye monitoring agent\n\
             After=network-online.target\n\
             Wants=network-online.target\n\
             StartLimitIntervalSec=0\n\n\
             [Service]\n\
             ExecStart={exe} run --managed --config {cfg}\n\
             Restart=always\n\
             RestartSec=2\n\
             KillMode=process\n\
             {hardening}\n\
             [Install]\n\
             WantedBy={wanted_by}\n"
        )
    }

    /// Une unité utilisateur n'est lancée qu'à l'ouverture d'une session, sauf
    /// « linger », où systemd démarre le gestionnaire dès l'amorçage : toute la
    /// promesse de la fonction sur un serveur sans écran. On vérifie l'état
    /// plutôt que de faire confiance à la commande : polkit peut refuser.
    fn linger_enabled(user: &str) -> bool {
        crate::report::run("loginctl", &["show-user", user, "--property=Linger"])
            .map(|out| out.trim() == "Linger=yes")
            .unwrap_or(false)
    }

    /// L'utilisateur dont le linger nous concerne : l'appelant, pas l'utilisateur
    /// effectif (« root » sous `sudo`). Allumer celui de root ne démarre pas la
    /// session de l'appelant, et l'éteindre couperait un compte jamais touché.
    fn linger_user() -> String {
        sudo_user().unwrap_or_else(crate::report::current_user)
    }

    fn ensure_linger() -> Result<()> {
        let user = linger_user();
        if user.is_empty() {
            bail!("impossible de déterminer l'utilisateur pour activer le « linger »");
        }
        if linger_enabled(&user) {
            return Ok(());
        }
        let _ = Command::new("loginctl")
            .args(["enable-linger", &user])
            .output();
        if linger_enabled(&user) {
            return Ok(());
        }
        bail!(
            "service utilisateur installé, mais il ne démarrera qu'à l'ouverture d'une session : \
             activez le « linger » avec « sudo loginctl enable-linger {user} », ou passez l'agent \
             en service système (root)"
        );
    }

    /// Éteint le linger allumé par [`ensure_linger`]. Appelé par le retrait, et
    /// seulement quand un service utilisateur était installé : le seul cas où
    /// le linger est de notre fait.
    pub fn disable_linger_impl() -> Result<bool> {
        let user = linger_user();
        if user.is_empty() || !linger_enabled(&user) {
            return Ok(false);
        }
        let _ = Command::new("loginctl")
            .args(["disable-linger", &user])
            .output();
        if linger_enabled(&user) {
            bail!(
                "« linger » toujours actif pour {user} : retirez-le avec \
                 « sudo loginctl disable-linger {user} »"
            );
        }
        Ok(true)
    }

    pub fn install_impl(system: bool, config: Option<&str>, autostart: bool) -> Result<()> {
        // Le chemin de config avant la désinstallation : elle peut arrêter
        // l'unité qui nous supervise, et `invoking_config_path` lit l'environnement.
        let cfg = unit_config_path(config);
        let _ = uninstall_impl();
        // La recopie vient après le ménage, qui efface l'ancienne copie quand
        // elle ne sert plus (voir `uninstall_impl`).
        let target_exe = if system { stage_system_exe()? } else { exe()? };
        let path = if system { system_unit() } else { user_unit() };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        std::fs::write(&path, unit_text(system, &target_exe, &cfg))
            .with_context(|| format!("writing {}", path.display()))?;
        systemctl_bare(system, "daemon-reload")?;
        // `enable` sans `--now` : l'unité est armée pour les amorçages suivants,
        // et c'est le passage de relais qui la démarre, une fois le verrou
        // d'instance unique libéré (voir `install`).
        if autostart {
            set_autostart_impl(system, true)?;
        }
        Ok(())
    }

    /// Une unité utilisateur ne démarre avec la machine que sous « linger ».
    /// Le désarmement le laisse en place : l'éteindre arrêterait le gestionnaire
    /// de l'utilisateur, et l'agent avec lui, hors de toute session ouverte.
    pub fn set_autostart_impl(system: bool, on: bool) -> Result<()> {
        systemctl(system, if on { "enable" } else { "disable" })?;
        if on && !system {
            ensure_linger()?;
        }
        Ok(())
    }

    pub fn autostart_enabled_impl(system: bool) -> bool {
        let mut cmd = Command::new("systemctl");
        if !system {
            cmd.arg("--user");
        }
        cmd.args(["is-enabled", "--quiet", UNIT])
            .output()
            .is_ok_and(|o| o.status.success())
    }

    pub fn start_impl(system: bool) -> Result<()> {
        systemctl(system, "start")
    }

    pub fn restart_impl(system: bool) -> Result<()> {
        systemctl(system, "restart")
    }

    /// `Restart=always` does not relaunch a unit stopped on purpose; `enable`
    /// starts it again at the next boot.
    pub fn stop_impl(system: bool) -> Result<()> {
        systemctl(system, "stop")
    }

    fn systemctl(system: bool, verb: &str) -> Result<()> {
        let mut cmd = Command::new("systemctl");
        if !system {
            cmd.arg("--user");
        }
        cmd.args([verb, UNIT]);
        run_checked(&mut cmd, &format!("systemctl {verb}"))
    }

    fn systemctl_bare(system: bool, verb: &str) -> Result<()> {
        let mut cmd = Command::new("systemctl");
        if !system {
            cmd.arg("--user");
        }
        cmd.arg(verb);
        run_checked(&mut cmd, &format!("systemctl {verb}"))
    }

    /// Alpine (OpenRC), most containers and WSL1 have no systemd; `su` and
    /// `sudo -u` leave a user without a session bus.
    pub fn preflight_impl(system: bool) -> Result<()> {
        if !std::path::Path::new("/run/systemd/system").is_dir() {
            bail!(
                "systemd is not running on this machine: leave out --autostart and start the \
                 agent another way (`deveye-agent run --detach`)"
            );
        }
        if !system {
            run_checked(
                Command::new("systemctl").args(["--user", "show-environment"]),
                "systemctl --user",
            )
            .context(
                "no user session bus (su or sudo -u?): log in as this user, or run as root \
                 for a system service",
            )?;
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
        // Notre copie part avec le service qu'elle servait, sauf si c'est elle
        // qui tourne : l'arrêt du démarrage automatique passe le relais à une
        // copie autonome relancée depuis `current_exe()`.
        let staged = PathBuf::from(SYSTEM_EXE);
        let running_here = std::env::current_exe()
            .ok()
            .zip(std::fs::canonicalize(&staged).ok())
            .is_some_and(|(exe, dest)| exe == dest);
        if staged.exists() && !running_here {
            std::fs::remove_file(&staged).ok();
        }
        uninstall_user_impl()
    }

    /// Retire l'autostart utilisateur, où qu'il soit : après une élévation sous
    /// `sudo`, l'unité de l'appelant resterait sinon en place, et service système
    /// et service utilisateur se chasseraient l'un l'autre sur le même enrôlement
    /// (le hub ne garde qu'une session par appareil).
    pub fn uninstall_user_impl() -> Result<()> {
        for path in user_units() {
            if !path.exists() {
                continue;
            }
            // Arrêter l'unité demande de viser le bus de son utilisateur : en
            // root, `systemctl --user` parle au bus de root, qui ne la connaît
            // pas. Au pire l'arrêt échoue, mais le fichier part.
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

    #[cfg(test)]
    mod tests {
        use super::*;

        /// L'unité ne recalcule rien : elle grave l'exécutable et la config
        /// qu'on lui donne.
        #[test]
        fn unit_bakes_the_paths_it_is_given() {
            let unit = unit_text(
                true,
                "/usr/local/bin/deveye-agent",
                "/home/lea/.config/x.toml",
            );
            assert!(unit.contains(
                "ExecStart=/usr/local/bin/deveye-agent run --managed --config /home/lea/.config/x.toml"
            ));
            assert!(unit.contains("WantedBy=multi-user.target"));

            let user = unit_text(false, "/tmp/agent", "/tmp/x.toml");
            assert!(user.contains("WantedBy=default.target"));
        }

        /// Une unité utilisateur n'a aucun privilège à rendre, et plusieurs
        /// directives y exigent des espaces de noms non privilégiés.
        #[test]
        fn only_the_system_unit_is_hardened() {
            let system = unit_text(true, "/usr/local/bin/deveye-agent", "/x.toml");
            assert!(system.contains("LockPersonality=yes\n\n[Install]"));
            assert!(system.contains("RestrictRealtime=yes"));
            let user = unit_text(false, "/tmp/agent", "/tmp/x.toml");
            assert!(!user.contains("LockPersonality"));
            assert!(user.contains("KillMode=process\n\n[Install]"));
        }

        /// Un service système ne doit jamais désigner un exécutable resté dans un
        /// foyer : SELinux refuse à `init` de l'exécuter.
        #[test]
        fn system_exe_lands_outside_any_home() {
            assert!(!SYSTEM_EXE.starts_with("/home/"));
            assert!(!SYSTEM_EXE.starts_with("/var/home/"));
            assert!(SYSTEM_EXE.starts_with("/usr/local/bin/"));
        }
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use super::*;

    const TASK: &str = "DevEyeAgent";

    fn task_run(cfg: &str) -> Result<String> {
        // schtasks /TR takes a single string; quote the exe + bake --config.
        Ok(format!("\"{}\" run --managed --config \"{}\"", exe()?, cfg))
    }

    pub fn install_impl(system: bool, config: Option<&str>, autostart: bool) -> Result<()> {
        let cfg = unit_config_path(config);
        let _ = uninstall_impl();
        let tr = task_run(&cfg)?;
        let mut cmd = Command::new("schtasks");
        cmd.args(["/Create", "/F", "/TN", TASK, "/TR", &tr]);
        if system {
            // Boot, as SYSTEM (needs elevation). Avoids implementing an SCM service.
            cmd.args(["/SC", "ONSTART", "/RU", "SYSTEM", "/RL", "HIGHEST"]);
        } else {
            cmd.args(["/SC", "ONLOGON", "/RL", "LIMITED"]);
        }
        run_checked(&mut cmd, "schtasks /Create")?;
        if !autostart {
            set_autostart_impl(system, false)?;
        }
        Ok(())
    }

    /// Désactivée, la tâche ne part plus sur son déclencheur ; l'instance en
    /// cours n'est pas arrêtée.
    pub fn set_autostart_impl(_system: bool, on: bool) -> Result<()> {
        let flag = if on { "/ENABLE" } else { "/DISABLE" };
        run_checked(
            Command::new("schtasks").args(["/Change", "/TN", TASK, flag]),
            &format!("schtasks /Change {flag}"),
        )
    }

    pub fn autostart_enabled_impl(_system: bool) -> bool {
        match Command::new("schtasks")
            .args(["/Query", "/TN", TASK, "/XML"])
            .output()
        {
            Ok(o) if o.status.success() => task_xml_enabled(&decode_task_xml(&o.stdout)),
            _ => false,
        }
    }

    /// `/Create` n'exécute rien : la tâche attend son déclencheur. Le passage de
    /// relais la lance explicitement. `/Run` refuse une tâche désactivée : elle
    /// est réactivée le temps du lancement.
    pub fn start_impl(system: bool) -> Result<()> {
        let armed = autostart_enabled_impl(system);
        if !armed {
            set_autostart_impl(system, true)?;
        }
        let started = run_checked(
            Command::new("schtasks").args(["/Run", "/TN", TASK]),
            "schtasks /Run",
        );
        if !armed {
            set_autostart_impl(system, false)?;
        }
        started
    }

    pub fn uninstall_impl() -> Result<()> {
        let _ = Command::new("schtasks")
            .args(["/Delete", "/F", "/TN", TASK])
            .output();
        Ok(())
    }

    /// `schtasks /Create` itself says whether elevation was missing.
    pub fn preflight_impl(_system: bool) -> Result<()> {
        Ok(())
    }

    /// The task has no restart policy: ended, it waits for its next trigger.
    pub fn stop_impl(_system: bool) -> Result<()> {
        run_checked(
            Command::new("schtasks").args(["/End", "/TN", TASK]),
            "schtasks /End",
        )
    }

    /// `/End` fails when the task is not running: nothing to stop then.
    pub fn restart_impl(system: bool) -> Result<()> {
        let _ = Command::new("schtasks")
            .args(["/End", "/TN", TASK])
            .output();
        start_impl(system)
    }

    // Windows uses a single task name for both scopes; `install(system)` already
    // replaces it, so there's no separate per-user task to remove after elevating.
    pub fn uninstall_user_impl() -> Result<()> {
        Ok(())
    }

    /// Notion systemd, sans équivalent dans le planificateur de tâches.
    pub fn disable_linger_impl() -> Result<bool> {
        Ok(false)
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

use imp::{
    autostart_enabled_impl, disable_linger_impl, install_impl, installed_scope_impl,
    preflight_impl, restart_impl, set_autostart_impl, start_impl, stop_impl, uninstall_impl,
    uninstall_user_impl,
};

/// `launchctl print-disabled` liste `"<label>" => disabled` (ou `=> true` avant
/// macOS 13) pour chaque travail désactivé du domaine.
#[cfg(any(target_os = "macos", test))]
fn launchd_disabled(listing: &str, label: &str) -> bool {
    let quoted = format!("\"{label}\"");
    listing.lines().any(|line| {
        let line = line.trim();
        line.starts_with(&quoted)
            && line
                .rsplit("=>")
                .next()
                .is_some_and(|v| matches!(v.trim(), "disabled" | "true"))
    })
}

/// L'état d'une tâche d'après son XML (`schtasks /Query /XML`), qui ne dépend
/// pas de la langue du système, contrairement à `/FO LIST`. Seul `<Settings>`
/// compte : un déclencheur porte aussi un `<Enabled>`. Absent, il vaut `true`.
#[cfg(any(target_os = "windows", test))]
fn task_xml_enabled(xml: &str) -> bool {
    let settings = xml
        .split_once("<Settings>")
        .and_then(|(_, rest)| rest.split_once("</Settings>"))
        .map_or("", |(inner, _)| inner);
    !settings.contains("<Enabled>false</Enabled>")
}

/// La sortie de `schtasks /XML` arrive en UTF-16 ou dans la page de code de la
/// console selon les versions : un octet nul sur deux trahit la première.
#[cfg(any(target_os = "windows", test))]
fn decode_task_xml(bytes: &[u8]) -> String {
    let utf16 = bytes.len() >= 2
        && bytes.iter().skip(1).step_by(2).filter(|&&b| b == 0).count() > bytes.len() / 4;
    if utf16 {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Un `--config` explicite l'emporte sur toute déduction.
    #[test]
    fn explicit_config_wins_and_empty_falls_back() {
        assert_eq!(
            unit_config_path(Some("/etc/deveye/agent.toml")),
            "/etc/deveye/agent.toml"
        );

        // Vide ou absent : on retombe sur une déduction, jamais sur du vide.
        for guessed in [unit_config_path(None), unit_config_path(Some(""))] {
            assert!(guessed.ends_with("agent.toml"), "deviné : {guessed}");
        }
    }

    #[test]
    fn launchd_listing_names_disabled_jobs() {
        let listing = "disabled services = {\n\t\"com.apple.ftpd\" => disabled\n\t\"com.deveye.agent\" => enabled\n}";
        assert!(!launchd_disabled(listing, "com.deveye.agent"));
        assert!(launchd_disabled(listing, "com.apple.ftpd"));
        // Avant macOS 13, `true` voulait dire désactivé.
        assert!(launchd_disabled(
            "\t\"com.deveye.agent\" => true",
            "com.deveye.agent"
        ));
        assert!(!launchd_disabled("", "com.deveye.agent"));
    }

    #[test]
    fn task_state_reads_settings_only() {
        let disabled =
            "<Task><Triggers><BootTrigger><Enabled>true</Enabled></BootTrigger></Triggers>\
                        <Settings><Enabled>false</Enabled></Settings></Task>";
        assert!(!task_xml_enabled(disabled));
        let trigger_off =
            "<Task><Triggers><LogonTrigger><Enabled>false</Enabled></LogonTrigger></Triggers>\
                           <Settings><Hidden>false</Hidden></Settings></Task>";
        assert!(task_xml_enabled(trigger_off));

        let wide: Vec<u8> = disabled.encode_utf16().flat_map(u16::to_le_bytes).collect();
        assert!(!task_xml_enabled(&decode_task_xml(&wide)));
        assert_eq!(decode_task_xml(disabled.as_bytes()), disabled);
    }
}
