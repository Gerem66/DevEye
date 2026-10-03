//! `deveye-agent uninstall` : le retrait complet, en une commande.
//!
//! Le désinstalleur vit dans l'agent parce que lui seul sait où il a écrit : le
//! service peut être dans deux foyers, la config ailleurs (`DEVEYE_CONFIG`), le
//! binaire système n'est pas celui téléchargé, et les dossiers réservés d'un
//! partage CloudSync ne sont nommés nulle part hors ligne.
//!
//! L'ordre compte : le démarrage automatique part en premier. Une unité systemd
//! en `Restart=always` avec `StartLimitIntervalSec=0` reboucle indéfiniment sur
//! un `ExecStart` effacé si on retire le binaire avant l'unité.
//!
//! La corbeille locale d'un partage (`.deveye-trash`) contient des fichiers de
//! l'utilisateur : elle n'est effacée que sur `--purge-shares`, sinon signalée.

use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};

use anyhow::{bail, Result};

use crate::config::{
    Config, CONFIG_FILE, SIBLING_FILES, SYNC_DEVICE_KEY_FILE, SYNC_INDEX_PREFIX, SYNC_INDEX_SUFFIX,
};
use crate::service::{self, ServiceScope};
use crate::sync::index_cache::IndexCache;

pub struct Options {
    /// Ne pas demander confirmation.
    pub yes: bool,
    /// Effacer aussi la corbeille locale des partages CloudSync.
    pub purge_shares: bool,
}

/// Dossiers réservés que l'agent crée à la racine d'un partage. `.deveye-tmp`
/// n'est que de la place de travail (fragments d'un téléchargement en cours) ;
/// `.deveye-trash` est la corbeille, donc des données de l'utilisateur.
const SHARE_SCRATCH: &str = ".deveye-tmp";
const SHARE_TRASH: &str = ".deveye-trash";

/// Le compte rendu au fil de l'eau, et ce qu'il reste à faire à la main.
#[derive(Default)]
struct Report {
    leftovers: Vec<String>,
}

impl Report {
    fn done(&mut self, what: impl AsRef<str>) {
        println!("  ✓ {}", what.as_ref());
    }

    fn skip(&mut self, what: impl AsRef<str>) {
        println!("  · {}", what.as_ref());
    }

    /// Une étape qui n'a pas abouti : affichée sur-le-champ et reprise dans
    /// l'épilogue, sans quoi un retrait partiel passe pour complet.
    fn warn(&mut self, what: impl Into<String>) {
        let what = what.into();
        println!("  ! {what}");
        self.leftovers.push(what);
    }
}

pub fn run(opts: Options) -> Result<()> {
    let scope = service::installed_scope();

    // Un service système ne se retire pas sans droits, et le retrait partiel est
    // pire que pas de retrait du tout : on refuse avant d'avoir touché quoi que ce soit.
    if scope == ServiceScope::System && !crate::report::is_privileged() {
        bail!(
            "un service système est installé : relancez avec les droits root\n  \
             sudo {} uninstall",
            std::env::current_exe()
                .unwrap_or_else(|_| PathBuf::from("deveye-agent"))
                .display()
        );
    }

    let dirs = config_dirs();
    let shares = share_roots(&dirs);

    if !opts.yes {
        if !std::io::stdin().is_terminal() {
            bail!("confirmation impossible hors d'un terminal : relancez avec « --yes »");
        }
        if !confirm(&dirs, &shares, scope, &opts)? {
            println!("Annulé. Rien n'a été touché.");
            return Ok(());
        }
    }

    let mut report = Report::default();
    println!("\nRetrait :");

    // Le démarrage automatique d'abord (voir l'en-tête du module).
    match service::uninstall() {
        Ok(()) if scope == ServiceScope::None => {
            report.skip("aucun démarrage automatique installé")
        }
        Ok(()) => report.done(format!("service ({}) retiré", scope.as_wire())),
        Err(e) => report.warn(format!("service non retiré : {e}")),
    }

    // Le « linger » ne nous revient que si nous avions posé un service utilisateur.
    if scope == ServiceScope::User {
        match service::disable_linger() {
            Ok(true) => report.done("« linger » désactivé"),
            Ok(false) => {}
            Err(e) => report.warn(e.to_string()),
        }
    }

    // Un `run --detach` lancé à la main survit au retrait du service.
    for dir in &dirs {
        stop_agent(dir, &mut report);
    }

    // L'icône de chaque session, et ce qui la relance à l'ouverture de session.
    crate::tray::stop_all();
    crate::tray::autostart::remove_all();
    crate::live_status::remove_all();
    report.done("icône de la zone de notification retirée");

    for dir in &dirs {
        wipe_config_dir(dir, &mut report);
    }

    for root in &shares {
        clean_share(root, opts.purge_shares, &mut report);
    }

    // Le nôtre en dernier : après lui, plus rien ne s'exécute.
    remove_update_leftovers(&mut report);
    remove_self(&mut report);

    epilogue(&report);
    Ok(())
}

fn confirm(
    dirs: &[PathBuf],
    shares: &[PathBuf],
    scope: ServiceScope,
    opts: &Options,
) -> Result<bool> {
    println!("Retrait complet de l'agent DevEye sur cette machine :");
    match scope {
        ServiceScope::None => println!("  · aucun démarrage automatique installé"),
        s => println!("  · démarrage automatique ({})", s.as_wire()),
    }
    for dir in dirs {
        println!("  · {} (config, jeton, journal, caches)", dir.display());
    }
    for root in shares {
        if opts.purge_shares {
            println!(
                "  · {} : {SHARE_SCRATCH} et {SHARE_TRASH} (corbeille comprise)",
                root.display()
            );
        } else {
            println!(
                "  · {} : {SHARE_SCRATCH} ({SHARE_TRASH} conservé)",
                root.display()
            );
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        println!("  · {} (ce binaire)", exe.display());
    }
    println!(
        "\nL'appareil restera visible dans DevEye → Appareils : supprimez-le là-bas \
         pour effacer son historique côté serveur."
    );
    print!("Continuer ? [o/N] ");
    let _ = std::io::stdout().flush();

    let mut answer = String::new();
    std::io::stdin().read_line(&mut answer)?;
    let answer = answer.trim().to_lowercase();
    Ok(answer == "o" || answer == "oui" || answer == "y" || answer == "yes")
}

/// Le sous-chemin du dossier de config sous un foyer, par plateforme. Miroir de
/// ce que `dirs::config_dir()` rend pour l'utilisateur courant, appliqué à un
/// autre foyer : celui de l'appelant derrière un `sudo`.
#[cfg(target_os = "linux")]
const CONFIG_SUBPATH: &str = ".config/deveye";
#[cfg(target_os = "macos")]
const CONFIG_SUBPATH: &str = "Library/Application Support/deveye";

/// Tous les dossiers de config à balayer : deux quand le retrait tourne élevé,
/// `dirs::config_dir()` suivant `$HOME`, que `sudo` et `pkexec` réécrivent en
/// celui de root. Ne regarder que le nôtre laisserait le vrai enrôlement intact.
fn config_dirs() -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = Config::path().parent() {
        candidates.push(dir.to_path_buf());
    }
    #[cfg(unix)]
    if let Some(home) = service::invoking_home() {
        candidates.push(home.join(CONFIG_SUBPATH));
    }

    // Dédoublonnage par chemin résolu : sur un système ostree `/home` est un
    // lien vers `/var/home`, et le même dossier se présenterait deux fois.
    let mut seen: Vec<PathBuf> = Vec::new();
    let mut out: Vec<PathBuf> = Vec::new();
    for dir in candidates {
        if !dir.is_dir() {
            continue;
        }
        let key = std::fs::canonicalize(&dir).unwrap_or_else(|_| dir.clone());
        if !seen.contains(&key) {
            seen.push(key);
            out.push(dir);
        }
    }
    out
}

/// Les dossiers de partage CloudSync connus, lus dans les caches de scan : hors
/// ligne, c'est la seule source (la liste des partages vient du serveur).
fn share_roots(dirs: &[PathBuf]) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    for path in dirs.iter().flat_map(|dir| sync_index_files(dir)) {
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(cache) = serde_json::from_str::<IndexCache>(&raw) else {
            continue;
        };
        if cache.root.is_empty() {
            continue;
        }
        let root = PathBuf::from(&cache.root);
        // Un partage détaché depuis, ou un dossier déplacé : plus rien à y faire.
        if root.is_dir() && !roots.contains(&root) {
            roots.push(root);
        }
    }
    roots
}

fn sync_index_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with(SYNC_INDEX_PREFIX) && n.ends_with(SYNC_INDEX_SUFFIX))
        })
        .collect()
}

/// Arrête l'agent enregistré dans un dossier de config, s'il tourne encore.
/// Par le fichier de pid : le service est déjà parti, et un `run --detach`
/// lancé à la main n'a jamais été supervisé.
fn stop_agent(dir: &Path, report: &mut Report) {
    let pid_path = dir.join(SIBLING_FILES[0]);
    let Ok(raw) = std::fs::read_to_string(&pid_path) else {
        return;
    };
    let Ok(pid) = raw.trim().parse::<u32>() else {
        return;
    };
    if !crate::state::process_alive(pid) {
        return;
    }
    match crate::kill_process(&pid.to_string()) {
        Ok(()) => report.done(format!("agent arrêté (pid {pid})")),
        Err(e) => report.warn(format!("agent (pid {pid}) toujours en marche : {e}")),
    }
}

/// Efface les fichiers de l'agent dans un dossier de config, puis le dossier
/// s'il ne reste rien.
///
/// Par nom, jamais en récursif : `DEVEYE_CONFIG` peut désigner un fichier posé
/// dans un dossier partagé avec autre chose. Le dossier n'est retiré que s'il
/// s'appelle `deveye` et qu'il est vide (`remove_dir` échoue sinon).
fn wipe_config_dir(dir: &Path, report: &mut Report) {
    let mut names: Vec<String> = vec![CONFIG_FILE.to_string()];
    names.extend(SIBLING_FILES.iter().map(|n| n.to_string()));
    names.push(SYNC_DEVICE_KEY_FILE.to_string());
    names.extend(crate::tray::USER_FILES.iter().map(|n| n.to_string()));
    names.push(crate::live_status::USER_FILE.to_string());
    // Le fichier de config peut porter un autre nom (`DEVEYE_CONFIG`).
    if let Some(actual) = Config::path().file_name().and_then(|n| n.to_str()) {
        if !names.iter().any(|n| n == actual) && Config::path().parent() == Some(dir) {
            names.push(actual.to_string());
        }
    }

    let mut removed = 0usize;
    for name in &names {
        let path = dir.join(name);
        if path.exists() && std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    for path in sync_index_files(dir) {
        if std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }

    if removed == 0 {
        report.skip(format!("{} : rien à retirer", dir.display()));
    } else {
        report.done(format!(
            "{removed} fichier(s) retiré(s) de {}",
            dir.display()
        ));
    }

    if dir.file_name().and_then(|n| n.to_str()) != Some("deveye") {
        return;
    }
    match std::fs::remove_dir(dir) {
        Ok(()) => report.done(format!("dossier {} supprimé", dir.display())),
        Err(_) if dir.is_dir() => {
            let rest = remaining(dir);
            if !rest.is_empty() {
                report.warn(format!(
                    "{} conservé, il contient encore : {}",
                    dir.display(),
                    rest.join(", ")
                ));
            }
        }
        Err(_) => {}
    }
}

/// Ce qu'il reste dans un dossier, au plus cinq noms.
fn remaining(dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .take(5)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect()
}

/// Retire les dossiers réservés d'un partage CloudSync. `.deveye-tmp` part
/// toujours (fragments d'un transfert interrompu) ; `.deveye-trash` contient des
/// fichiers de l'utilisateur : effacé sur demande seulement, sinon signalé.
fn clean_share(root: &Path, purge: bool, report: &mut Report) {
    let scratch = root.join(SHARE_SCRATCH);
    if scratch.is_dir() {
        match std::fs::remove_dir_all(&scratch) {
            Ok(()) => report.done(format!("{} supprimé", scratch.display())),
            Err(e) => report.warn(format!("{} : {e}", scratch.display())),
        }
    }

    let trash = root.join(SHARE_TRASH);
    if !trash.is_dir() {
        return;
    }
    if purge {
        match std::fs::remove_dir_all(&trash) {
            Ok(()) => report.done(format!("{} supprimé", trash.display())),
            Err(e) => report.warn(format!("{} : {e}", trash.display())),
        }
    } else {
        report.warn(format!(
            "{} conservé (corbeille locale : vos fichiers supprimés) — \
             « uninstall --purge-shares » pour l'effacer aussi",
            trash.display()
        ));
    }
}

/// Balaie les binaires qu'une mise à jour interrompue a pu laisser à côté du
/// nôtre : le temporaire d'un échange atomique sous Unix, le `.old` mis de côté
/// sous Windows (nettoyé d'ordinaire au démarrage suivant, qui n'aura pas lieu).
fn remove_update_leftovers(report: &mut Report) {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let Some(dir) = exe.parent() else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for path in entries.flatten().map(|e| e.path()) {
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let is_leftover = name.starts_with(".deveye-agent.new") || name == "deveye-agent.old";
        if is_leftover && std::fs::remove_file(&path).is_ok() {
            report.done(format!("résidu de mise à jour {} supprimé", path.display()));
        }
    }
}

/// Supprime le binaire en cours d'exécution. Sous Unix un processus peut délier
/// son propre exécutable (l'inode survit jusqu'à la sortie) ; Windows verrouille
/// l'image d'un processus vivant, on ne peut que le dire.
fn remove_self(report: &mut Report) {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    #[cfg(unix)]
    match std::fs::remove_file(&exe) {
        Ok(()) => report.done(format!("binaire {} supprimé", exe.display())),
        Err(e) => report.warn(format!(
            "binaire {} à supprimer à la main : {e}",
            exe.display()
        )),
    }
    #[cfg(windows)]
    report.warn(format!(
        "binaire {} à supprimer à la main (Windows verrouille l'exécutable en cours)",
        exe.display()
    ));
}

fn epilogue(report: &Report) {
    if report.leftovers.is_empty() {
        println!("\n✓ Agent retiré. Il ne reste rien sur cette machine.");
    } else {
        println!("\n⚠ Agent retiré, sauf :");
        for item in &report.leftovers {
            println!("  · {item}");
        }
    }
    println!(
        "\nCôté serveur, l'appareil et son historique existent toujours : \
         supprimez-le dans DevEye → Appareils."
    );
    println!(
        "Les traces du service dans le journal systemd, elles, ne partent qu'à \
         la rotation du journal."
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Le dossier de config n'est retiré que s'il est vide et qu'il porte notre
    /// nom : `DEVEYE_CONFIG` peut désigner un fichier dans un dossier partagé.
    #[test]
    fn a_foreign_config_dir_survives_its_content() {
        let dir = std::env::temp_dir().join(format!("deveye-uninst-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(CONFIG_FILE), "server = \"x\"").unwrap();
        std::fs::write(dir.join("autre-chose.txt"), "à ne pas toucher").unwrap();

        let mut report = Report::default();
        wipe_config_dir(&dir, &mut report);

        assert!(!dir.join(CONFIG_FILE).exists(), "notre config doit partir");
        assert!(
            dir.join("autre-chose.txt").exists(),
            "un fichier étranger doit rester"
        );
        assert!(dir.is_dir(), "le dossier ne s'appelle pas « deveye »");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Un dossier `deveye` vidé de nos fichiers disparaît, lui.
    #[test]
    fn our_own_empty_config_dir_goes() {
        let base = std::env::temp_dir().join(format!("deveye-uninst-own-{}", std::process::id()));
        let dir = base.join("deveye");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(CONFIG_FILE), "server = \"x\"").unwrap();
        std::fs::write(dir.join(SIBLING_FILES[1]), "log").unwrap();
        std::fs::write(dir.join("sync-7.index.json"), "{}").unwrap();
        std::fs::write(dir.join(SYNC_DEVICE_KEY_FILE), [0u8; 32]).unwrap();

        let mut report = Report::default();
        wipe_config_dir(&dir, &mut report);

        assert!(!dir.exists(), "le dossier vidé doit être supprimé");
        assert!(report.leftovers.is_empty());
        std::fs::remove_dir_all(&base).ok();
    }

    /// La corbeille d'un partage est de la donnée utilisateur : elle ne part que
    /// sur demande, et son maintien est signalé.
    #[test]
    fn share_trash_is_kept_unless_asked() {
        let root = std::env::temp_dir().join(format!("deveye-share-{}", std::process::id()));
        std::fs::create_dir_all(root.join(SHARE_TRASH)).unwrap();
        std::fs::create_dir_all(root.join(SHARE_SCRATCH)).unwrap();

        let mut report = Report::default();
        clean_share(&root, false, &mut report);
        assert!(
            !root.join(SHARE_SCRATCH).exists(),
            "le scratch part toujours"
        );
        assert!(root.join(SHARE_TRASH).is_dir(), "la corbeille reste");
        assert_eq!(report.leftovers.len(), 1, "et c'est dit");

        clean_share(&root, true, &mut report);
        assert!(!root.join(SHARE_TRASH).exists());
        std::fs::remove_dir_all(&root).ok();
    }
}
