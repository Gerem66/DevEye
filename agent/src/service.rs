//! OS-level persistence: install the agent as an autostart service at a per-user
//! or system level, inspect that state, and uninstall it. Backed by systemd
//! (Linux), launchd (macOS) and Task Scheduler (Windows).
//!
//! The service definition bakes the **absolute** executable + config paths and
//! runs `<exe> run --managed --config <path>`, so a system service (which has a
//! different HOME than the enrolling user) still finds the enrolled config, and
//! `--managed` tells a self-update to just exit and let the manager relaunch it.
//!
//! **Les deux pièges d'une installation système, tous deux invisibles en dev.**
//! Elle tourne sous `pkexec`/`sudo`, donc dans l'environnement de root : le
//! chemin de config calculé là désigne le foyer de root, pas celui de la machine
//! enrôlée — d'où [`invoking_config_path`], et un `--config` explicite quand
//! l'appelant le connaît. Et sur un système à SELinux (toute la famille Fedora),
//! `init` n'a pas le droit d'exécuter un fichier étiqueté `user_home_t` : un
//! service dont l'`ExecStart` pointe dans un `/home` échoue en boucle sur
//! `203/EXEC`. L'exécutable est donc recopié dans un emplacement système avant
//! d'être désigné (voir `stage_system_exe` sous Linux).

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

/// La clé `getent passwd` de l'appelant d'origine — son nom sous `sudo`, son uid
/// sous `pkexec`.
///
/// **`pkexec` ne pose pas `SUDO_USER`.** C'est pourtant lui qui élève l'agent sur
/// Linux (voir `elevate.rs`), et ne regarder que `SUDO_USER` revenait donc à ne
/// jamais reconnaître l'appelant sur le seul chemin qu'emprunte l'interface.
/// `PKEXEC_UID` est son équivalent, et `getent passwd` accepte les deux formes.
#[cfg(unix)]
fn invoking_key() -> Option<String> {
    sudo_user().or_else(|| {
        std::env::var("PKEXEC_UID")
            .ok()
            .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()))
    })
}

/// Le foyer de l'appelant d'origine sous `sudo`/`pkexec`, quand on peut le
/// nommer. Public au crate : le retrait doit balayer *son* dossier de config,
/// pas celui de root (voir `uninstall::config_dirs`).
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
/// **Le nôtre est le mauvais dès qu'on est élevé.** `Config::path()` suit
/// `dirs::config_dir()`, donc `$HOME` — que `pkexec` et `sudo` remplacent par
/// celui de root. Une installation système gravait ainsi
/// `/root/.config/deveye/agent.toml`, un fichier qui n'existe pas : le service
/// démarrait, ne trouvait pas d'enrôlement, et la machine ne revenait jamais en
/// ligne. On vise donc le foyer de l'appelant d'origine quand on peut le nommer.
///
/// `DEVEYE_CONFIG` reste prioritaire : c'est un choix explicite, et c'est aussi
/// ce que l'agent supervisé se transmet à lui-même lors d'un relais.
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
/// annonce à l'interface. En avoir deux, c'était pouvoir refuser une installation
/// système en se disant non privilégié pendant que l'interface affichait root —
/// ou l'inverse.
#[cfg(unix)]
fn is_root() -> bool {
    crate::report::is_privileged()
}

/// Install (or reinstall) the autostart service. `system` requires privilege.
///
/// **Installe sans lancer.** Le démarrage est une étape à part ([`start`]) parce
/// que l'ordre arrive *par* l'agent déjà en marche : demander au gestionnaire de
/// service de démarrer tout de suite faisait naître un second agent, aussitôt
/// refusé par la garde d'instance unique. Sous systemd la commande rendait
/// pourtant la main sans erreur (le processus est forké avant d'échouer), si
/// bien que l'installation se déclarait réussie tandis que l'unité rebouclait
/// indéfiniment ; sous launchd le travail respawnait toutes les dix secondes.
/// Le relais est donc explicite : on installe, on rend la main, puis l'appelant
/// cède la place (voir `commands::handle_service`).
///
/// `config` grave un fichier d'enrôlement précis dans la définition. L'appelant
/// qui élève l'agent le connaît — c'est le sien, il tourne dessus — là où le
/// processus élevé, lui, ne peut que le deviner (voir [`invoking_config_path`]).
pub fn install(system: bool, config: Option<&str>) -> Result<()> {
    if system {
        require_privilege()?;
    }
    install_impl(system, config)
}

/// Démarre le service déjà installé. Utilisé par le passage de relais, une fois
/// le verrou d'instance unique libéré.
pub fn start(system: bool) -> Result<()> {
    start_impl(system)
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
    /// `bootout` défait ce que `bootstrap` a fait. `unload -w`, qu'on utilisait,
    /// faisait *en plus* basculer le label dans la base des travaux désactivés de
    /// l'utilisateur — un état qui survit à la suppression du plist et que seul
    /// un `enable` explicite efface. Un `load -w` en échec laissait donc le
    /// démarrage automatique éteint pour de bon : launchd sautait le plist à
    /// chaque ouverture de session, alors que sa présence sur le disque suffisait
    /// à faire afficher « activé » côté interface.
    fn bootout(system: bool) {
        let _ = Command::new("launchctl")
            .args(["bootout", &service_target(system)])
            .output();
    }

    pub fn install_impl(system: bool, config: Option<&str>) -> Result<()> {
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
        // Lève un éventuel « désactivé » hérité d'un `unload -w` (le nôtre, ou
        // celui d'une version antérieure) : sans ça le travail est enregistré
        // mais jamais lancé.
        let _ = Command::new("launchctl")
            .args(["enable", &service_target(system)])
            .output();
        Ok(())
    }

    /// `bootstrap` enregistre le travail dans le domaine ; `RunAtLoad` le lance
    /// dans la foulée. Repli sur `load -w` pour les macOS d'avant `bootstrap`.
    pub fn start_impl(system: bool) -> Result<()> {
        let path = if system { system_plist() } else { user_plist() };
        bootout(system);
        let mut cmd = Command::new("launchctl");
        cmd.arg("bootstrap").arg(domain(system)).arg(&path);
        if run_checked(&mut cmd, "launchctl bootstrap").is_ok() {
            return Ok(());
        }
        run_checked(
            Command::new("launchctl").arg("load").arg("-w").arg(&path),
            "launchctl load",
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

    /// Où le service **système** garde son exécutable.
    ///
    /// `/usr/local/bin` est étiqueté `bin_t` par la politique SELinux — y compris
    /// sur les systèmes ostree, où `/usr/local` est un lien vers `/var/usrlocal`
    /// et reste inscriptible. C'est ce qui rend le fichier exécutable par `init`,
    /// et c'est toute la raison de la recopie.
    const SYSTEM_EXE: &str = "/usr/local/bin/deveye-agent";

    /// Recopie l'exécutable hors du foyer de l'utilisateur, pour le service système.
    ///
    /// **Sans elle, l'unité boucle sur `203/EXEC` sur toute machine à SELinux.**
    /// L'agent se télécharge dans un `/home`, où il porte l'étiquette
    /// `user_home_t` ; `init_t` n'a pas le droit de l'exécuter, et refuse — un
    /// refus qui ne se voit que dans le journal d'audit, pendant que `systemctl
    /// status` répète « Permission denied » sur un fichier pourtant en `0755`.
    /// Une machine sans SELinux, elle, marchait très bien : d'où un bogue qui
    /// n'existait que sur Fedora et ses dérivés.
    ///
    /// Accessoirement, cela détache le service du fichier téléchargé : le
    /// déplacer ou l'effacer ne casse plus le démarrage automatique.
    fn stage_system_exe() -> Result<String> {
        use std::os::unix::fs::PermissionsExt;

        let src = std::env::current_exe().context("locating executable")?;
        let dest = PathBuf::from(SYSTEM_EXE);
        // `current_exe` rend un chemin résolu (`/proc/self/exe`) : la comparaison
        // doit résoudre la destination aussi, sans quoi `/usr/local/bin` et
        // `/var/usrlocal/bin` — le même répertoire sur ostree — passeraient pour
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

    fn unit_text(system: bool, exe: &str, cfg: &str) -> String {
        let wanted_by = if system {
            "multi-user.target"
        } else {
            "default.target"
        };
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
             KillMode=process\n\n\
             [Install]\n\
             WantedBy={wanted_by}\n"
        )
    }

    /// Une unité *utilisateur* n'est lancée qu'à l'ouverture d'une session, sauf
    /// si l'utilisateur est en « linger » — auquel cas systemd démarre son
    /// gestionnaire dès l'amorçage. C'est exactement la différence entre « au
    /// démarrage de ma session » et « au démarrage de la machine », donc toute la
    /// promesse de la fonction sur un serveur sans écran.
    ///
    /// L'appel visait `$USER`, variable absente d'un processus lancé par un
    /// gestionnaire de service ou détaché d'un terminal : sur une machine sans
    /// écran, le linger n'était alors jamais demandé, et l'agent ne revenait
    /// jamais après un redémarrage. On nomme donc l'utilisateur réel, et on
    /// **vérifie** — polkit peut refuser en session non active.
    fn linger_enabled(user: &str) -> bool {
        crate::report::run("loginctl", &["show-user", user, "--property=Linger"])
            .map(|out| out.trim() == "Linger=yes")
            .unwrap_or(false)
    }

    /// L'utilisateur dont le linger nous concerne.
    ///
    /// `current_user()` est l'utilisateur *effectif* : sous `sudo`, il dit
    /// « root ». Or le service utilisateur qu'on installe (ou qu'on retire) est
    /// celui de l'appelant, et son linger aussi — allumer celui de root ne fait
    /// pas démarrer sa session à lui, et l'éteindre à la désinstallation
    /// couperait le linger d'un compte auquel on n'a jamais touché.
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

    /// Éteint le linger allumé par [`ensure_linger`].
    ///
    /// Rien ne le faisait, et il survivait donc à l'agent : un compte que
    /// l'installation avait rendu « toujours actif au démarrage » le restait
    /// pour de bon, longtemps après la disparition du service qui l'exigeait.
    /// Appelé par le retrait, et **seulement** quand un service utilisateur
    /// était installé : c'est le seul cas où le linger est de notre fait.
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

    pub fn install_impl(system: bool, config: Option<&str>) -> Result<()> {
        // Le chemin de config **avant** la désinstallation : elle peut arrêter
        // l'unité qui nous supervise, et `invoking_config_path` lit encore
        // l'environnement à ce moment-là.
        let cfg = unit_config_path(config);
        let _ = uninstall_impl();
        // La recopie vient après le ménage, qui efface justement l'ancienne
        // copie quand elle ne sert plus (voir `uninstall_impl`).
        let target_exe = if system { stage_system_exe()? } else { exe()? };
        let path = if system { system_unit() } else { user_unit() };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        std::fs::write(&path, unit_text(system, &target_exe, &cfg))
            .with_context(|| format!("writing {}", path.display()))?;
        // `enable` sans `--now` : l'unité est armée pour les amorçages suivants,
        // et c'est le passage de relais qui la démarre, une fois le verrou
        // d'instance unique libéré (voir `install`).
        if system {
            run_checked(
                Command::new("systemctl").arg("daemon-reload"),
                "systemctl daemon-reload",
            )?;
            run_checked(
                Command::new("systemctl").args(["enable", UNIT]),
                "systemctl enable",
            )?;
        } else {
            run_checked(
                Command::new("systemctl").args(["--user", "daemon-reload"]),
                "systemctl --user daemon-reload",
            )?;
            run_checked(
                Command::new("systemctl").args(["--user", "enable", UNIT]),
                "systemctl --user enable",
            )?;
            ensure_linger()?;
        }
        Ok(())
    }

    pub fn start_impl(system: bool) -> Result<()> {
        let mut cmd = Command::new("systemctl");
        if system {
            cmd.args(["start", UNIT]);
        } else {
            cmd.args(["--user", "start", UNIT]);
        }
        run_checked(&mut cmd, "systemctl start")
    }

    pub fn uninstall_impl() -> Result<()> {
        if system_unit().exists() {
            let _ = Command::new("systemctl")
                .args(["disable", "--now", UNIT])
                .output();
            std::fs::remove_file(system_unit()).ok();
            let _ = Command::new("systemctl").arg("daemon-reload").output();
        }
        // Notre copie part avec le service qu'elle servait — **sauf** si c'est
        // elle qui tourne en ce moment : l'arrêt du démarrage automatique passe
        // le relais à une copie autonome relancée depuis `current_exe()`, et
        // effacer le fichier sous ses pieds ferait disparaître la machine de la
        // supervision au lieu de la sortir du seul service.
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

    #[cfg(test)]
    mod tests {
        use super::*;

        /// L'unité ne recalcule **rien** : elle grave l'exécutable et la config
        /// qu'on lui donne. C'est toute la correction — elle les devinait, et sous
        /// `pkexec` elle devinait le foyer de root.
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

        /// Un service système ne doit jamais désigner un exécutable resté dans un
        /// foyer : SELinux refuse à `init` de l'exécuter, en boucle et en silence.
        #[test]
        fn system_exe_lands_outside_any_home() {
            assert!(!SYSTEM_EXE.starts_with("/home/"));
            assert!(!SYSTEM_EXE.starts_with("/var/home/"));
            assert!(SYSTEM_EXE.starts_with("/usr/local/bin/"));
        }
    }
}

// ─────────────────────────── Windows (Task Scheduler) ───────────────────────
#[cfg(target_os = "windows")]
mod imp {
    use super::*;

    const TASK: &str = "DevEyeAgent";

    fn task_run(cfg: &str) -> Result<String> {
        // schtasks /TR takes a single string; quote the exe + bake --config.
        Ok(format!("\"{}\" run --managed --config \"{}\"", exe()?, cfg))
    }

    pub fn install_impl(system: bool, config: Option<&str>) -> Result<()> {
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
        Ok(())
    }

    /// `/Create` n'exécute rien : la tâche attend son déclencheur. Le passage de
    /// relais la lance explicitement.
    pub fn start_impl(_system: bool) -> Result<()> {
        run_checked(
            Command::new("schtasks").args(["/Run", "/TN", TASK]),
            "schtasks /Run",
        )
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
    disable_linger_impl, install_impl, installed_scope_impl, start_impl, uninstall_impl,
    uninstall_user_impl,
};

#[cfg(test)]
mod tests {
    use super::*;

    /// Un `--config` explicite l'emporte sur toute déduction. C'est le chemin que
    /// prend l'élévation : l'agent en marche connaît son enrôlement, le processus
    /// élevé ne pourrait que le deviner depuis l'environnement de root.
    #[test]
    fn explicit_config_wins_and_empty_falls_back() {
        assert_eq!(
            unit_config_path(Some("/etc/deveye/agent.toml")),
            "/etc/deveye/agent.toml"
        );

        // Vide ou absent : on retombe sur une déduction, jamais sur du vide —
        // une définition de service sans fichier de config ne démarre nulle part.
        for guessed in [unit_config_path(None), unit_config_path(Some(""))] {
            assert!(guessed.ends_with("agent.toml"), "deviné : {guessed}");
        }
    }
}
