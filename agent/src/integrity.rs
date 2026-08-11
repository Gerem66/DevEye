//! Empreintes des surfaces de persistance : les endroits où un programme
//! s'installe pour survivre au redémarrage.
//!
//! C'est là que vivent réellement mineurs et portes dérobées. Un processus se
//! tue, un fichier de service se relance — donc surveiller les processus sans
//! surveiller ce qui les rallume ne détecte qu'une moitié du problème.
//!
//! # Jamais le contenu d'un fichier
//!
//! On ne remonte qu'une **empreinte** et des métadonnées : chemin, sha256,
//! taille, date, propriétaire, droits. C'est ce qui rend la sonde acceptable sur
//! une machine partagée — elle prouve qu'un fichier a changé sans jamais révéler
//! ce qu'il contient, et un sha256 suffit entièrement au diff que le serveur en
//! fait. L'agent a les droits de lire davantage ; il ne le fait pas.
//!
//! # Une liste fermée
//!
//! Les surfaces sont énumérées en dur, pas découvertes. Un balayage large
//! coûterait cher, remonterait des milliers d'entrées sans intérêt, et noierait
//! le signal. Ce qui compte tient en une page : cron, unités systemd, agents de
//! lancement, clés SSH autorisées, comptes, sudoers, préchargement du linker.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};

/// Plafond d'entrées d'un manifeste, aligné sur `PERSISTENCE_ENTRY_LIMIT` côté
/// serveur. Atteint, le drapeau `truncated` **coupe les suppressions** : un
/// manifeste tronqué ne prouve pas qu'une entrée a disparu, seulement qu'on a
/// cessé de regarder.
const MAX_ENTRIES: usize = 2000;

/// Taille au-delà de laquelle on n'empreinte pas.
///
/// Une unité systemd fait quelques centaines d'octets ; un `authorized_keys`
/// quelques kilo-octets. Un fichier de 8 Mio dans `/etc/cron.d` n'est pas une
/// tâche planifiée, et le lire entièrement à chaque cycle coûterait plus que
/// tout le reste de la sonde.
const MAX_FILE_BYTES: u64 = 1024 * 1024;

/// Profondeur maximale de descente dans un répertoire de surface.
///
/// `/etc/systemd/system` contient des répertoires `*.wants/` peuplés de liens :
/// deux niveaux suffisent à les voir sans partir dans une arborescence entière.
const MAX_DEPTH: usize = 2;

/// Une entrée du manifeste. Miroir de `persistenceEntrySchema` côté serveur.
#[derive(Debug, Clone, Serialize)]
pub struct PersistenceEntry {
    /// Famille d'origine : `cron`, `systemd`, `launchd`, `authorized_keys`…
    pub surface: &'static str,
    pub path: String,
    pub sha256: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
    /// Unix ms de dernière modification ; `None` si le système ne l'expose pas.
    pub mtime: Option<i64>,
    /// Mode POSIX en octal (`0644`) ; `None` sur Windows.
    pub mode: Option<String>,
    pub owner: Option<String>,
}

/// Le manifeste complet. Miroir d'`integrityReportSchema`.
#[derive(Debug, Clone, Serialize)]
pub struct IntegrityReport {
    #[serde(rename = "collectedAt")]
    pub collected_at: i64,
    pub entries: Vec<PersistenceEntry>,
    pub truncated: bool,
}

/// Une surface à relever : sa famille, et où regarder.
struct Surface {
    name: &'static str,
    /// Chemin d'un fichier **ou** d'un répertoire à parcourir.
    path: &'static str,
    /// Ne retenir que les fichiers dont le nom finit par l'un de ces suffixes.
    /// Vide = tout retenir.
    suffixes: &'static [&'static str],
}

const fn s(name: &'static str, path: &'static str) -> Surface {
    Surface {
        name,
        path,
        suffixes: &[],
    }
}

const fn s_ext(
    name: &'static str,
    path: &'static str,
    suffixes: &'static [&'static str],
) -> Surface {
    Surface {
        name,
        path,
        suffixes,
    }
}

#[cfg(target_os = "linux")]
const SURFACES: &[Surface] = &[
    s("cron", "/etc/crontab"),
    s("cron", "/etc/cron.d"),
    s("cron", "/etc/cron.hourly"),
    s("cron", "/etc/cron.daily"),
    s("cron", "/etc/cron.weekly"),
    s("cron", "/etc/cron.monthly"),
    s("cron", "/var/spool/cron/crontabs"),
    s("cron", "/var/spool/cron"),
    // `/etc/systemd/system` et non `/usr/lib/systemd/system` : le second est
    // peuplé par les paquets et compte des centaines d'unités qui changent à
    // chaque mise à jour. Le premier est celui de l'administrateur — et donc
    // celui où un intrus dépose son unité.
    s_ext(
        "systemd",
        "/etc/systemd/system",
        &[".service", ".timer", ".socket"],
    ),
    s_ext("systemd", "/run/systemd/system", &[".service", ".timer"]),
    s("accounts", "/etc/passwd"),
    s("sudoers", "/etc/sudoers"),
    s("sudoers", "/etc/sudoers.d"),
    // Le préchargement du linker : un rootkit en espace utilisateur y pose sa
    // bibliothèque, et elle s'injecte alors dans **tout** ce qui démarre.
    s("ld_preload", "/etc/ld.so.preload"),
    s("profile", "/etc/profile.d"),
];

#[cfg(target_os = "macos")]
const SURFACES: &[Surface] = &[
    s("launchd", "/Library/LaunchDaemons"),
    s("launchd", "/Library/LaunchAgents"),
    s("launchd", "/System/Library/LaunchAgents"),
    s("cron", "/etc/periodic"),
    s("accounts", "/etc/passwd"),
    s("sudoers", "/etc/sudoers"),
    s("sudoers", "/etc/sudoers.d"),
];

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
const SURFACES: &[Surface] = &[];

/// L'état d'un relevé en cours.
///
/// Regroupé plutôt que passé en trois paramètres : `owners` est lu une fois pour
/// tout le relevé, et le trimballer séparément invitait à le reconstruire par
/// entrée — ce qui, sur une surface de cinq cents fichiers, relirait
/// `/etc/passwd` cinq cents fois.
struct Scan {
    entries: Vec<PersistenceEntry>,
    seen: HashSet<String>,
    owners: std::collections::HashMap<u32, String>,
}

/// Relève le manifeste. Ne lève jamais : une surface illisible est une surface
/// absente, et le reste du relevé garde toute sa valeur.
pub fn collect() -> IntegrityReport {
    let mut scan = Scan {
        entries: Vec::new(),
        seen: HashSet::new(),
        owners: passwd_owners(),
    };
    let mut truncated = false;

    for surface in SURFACES {
        if walk(surface, Path::new(surface.path), 0, &mut scan) {
            truncated = true;
            break;
        }
    }

    if !truncated && collect_home_surfaces(&mut scan) {
        truncated = true;
    }

    #[cfg(target_os = "windows")]
    if !truncated {
        truncated = collect_windows(&mut scan);
    }

    let mut entries = scan.entries;

    // Ordre stable : le serveur diffe sur les chemins, mais un manifeste trié
    // se relit à l'œil quand on le déverse dans un journal de diagnostic.
    entries.sort_by(|a, b| a.path.cmp(&b.path));

    IntegrityReport {
        collected_at: now_millis(),
        entries,
        truncated,
    }
}

/// Parcourt une surface. Rend `true` si le plafond a été atteint.
fn walk(surface: &Surface, path: &Path, depth: usize, scan: &mut Scan) -> bool {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return false; // absent : la plupart des surfaces le sont sur une machine donnée
    };

    if meta.is_dir() {
        if depth >= MAX_DEPTH {
            return false;
        }
        let Ok(dir) = std::fs::read_dir(path) else {
            return false; // répertoire illisible sans les droits : ce n'est pas une erreur
        };
        for entry in dir.flatten() {
            if walk(surface, &entry.path(), depth + 1, scan) {
                return true;
            }
        }
        return false;
    }

    if !surface.suffixes.is_empty() {
        let name = path.file_name().map(|n| n.to_string_lossy().to_string());
        let matches = name
            .as_deref()
            .is_some_and(|n| surface.suffixes.iter().any(|ext| n.ends_with(ext)));
        if !matches {
            return false;
        }
    }

    let display = path.to_string_lossy().to_string();
    // Les surfaces se recoupent (`/var/spool/cron` et `/var/spool/cron/crontabs`)
    // et un lien peut viser un fichier déjà relevé : une entrée par chemin.
    if !scan.seen.insert(display.clone()) {
        return false;
    }

    if let Some(entry) = fingerprint(surface.name, path, &display, &scan.owners) {
        scan.entries.push(entry);
    }
    scan.entries.len() >= MAX_ENTRIES
}

/// Empreinte un fichier. `None` s'il est illisible, trop gros, ou pas un fichier.
fn fingerprint(
    surface: &'static str,
    path: &Path,
    display: &str,
    owners: &std::collections::HashMap<u32, String>,
) -> Option<PersistenceEntry> {
    // `metadata` et non `symlink_metadata` : on veut la cible d'un lien, parce
    // qu'un `*.wants/` de systemd n'est fait que de liens et que c'est bien
    // l'unité pointée qui compte.
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let size = meta.len();
    if size > MAX_FILE_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    let digest = Sha256::digest(&bytes);

    Some(PersistenceEntry {
        surface,
        path: display.to_string(),
        sha256: hex(&digest),
        size_bytes: size,
        mtime: meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64),
        mode: file_mode(&meta),
        owner: file_owner(&meta, owners),
    })
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(out, "{b:02x}");
    }
    out
}

#[cfg(unix)]
fn file_mode(meta: &std::fs::Metadata) -> Option<String> {
    use std::os::unix::fs::PermissionsExt;
    Some(format!("{:04o}", meta.permissions().mode() & 0o7777))
}

#[cfg(not(unix))]
fn file_mode(_meta: &std::fs::Metadata) -> Option<String> {
    None
}

#[cfg(unix)]
fn file_owner(
    meta: &std::fs::Metadata,
    owners: &std::collections::HashMap<u32, String>,
) -> Option<String> {
    use std::os::unix::fs::MetadataExt;
    let uid = meta.uid();
    // Le numéro à défaut du nom : « 0 » reste plus utile qu'un vide, et un uid
    // sans entrée dans `/etc/passwd` est en soi une information.
    Some(owners.get(&uid).cloned().unwrap_or_else(|| uid.to_string()))
}

#[cfg(not(unix))]
fn file_owner(
    _meta: &std::fs::Metadata,
    _owners: &std::collections::HashMap<u32, String>,
) -> Option<String> {
    None
}

/// uid → nom de compte, lu une fois par relevé.
#[cfg(unix)]
fn passwd_owners() -> std::collections::HashMap<u32, String> {
    let mut map = std::collections::HashMap::new();
    let Ok(text) = std::fs::read_to_string("/etc/passwd") else {
        return map;
    };
    for line in text.lines() {
        let mut f = line.split(':');
        let (Some(name), Some(_), Some(uid)) = (f.next(), f.next(), f.next()) else {
            continue;
        };
        if let Ok(uid) = uid.parse::<u32>() {
            map.insert(uid, name.to_string());
        }
    }
    map
}

#[cfg(not(unix))]
fn passwd_owners() -> std::collections::HashMap<u32, String> {
    std::collections::HashMap::new()
}

/// Les surfaces qui vivent dans les répertoires personnels.
///
/// `~/.ssh/authorized_keys` est la porte dérobée la plus discrète qui soit : une
/// ligne ajoutée dans un fichier que personne ne relit, et l'accès survit à tous
/// les changements de mot de passe.
fn collect_home_surfaces(scan: &mut Scan) -> bool {
    // `#[cfg]` ne s'applique pas aux éléments d'un tableau : la variante de
    // plateforme est donc portée par une constante, pas par le littéral.
    #[cfg(target_os = "macos")]
    const USER_UNITS: (&str, &str) = ("launchd", "Library/LaunchAgents");
    #[cfg(not(target_os = "macos"))]
    const USER_UNITS: (&str, &str) = ("systemd", ".config/systemd/user");

    for home in home_dirs() {
        let candidates: [(&'static str, PathBuf); 2] = [
            // La porte dérobée la plus discrète qui soit : une ligne ajoutée
            // dans un fichier que personne ne relit, et l'accès survit à tous
            // les changements de mot de passe.
            ("authorized_keys", home.join(".ssh/authorized_keys")),
            (USER_UNITS.0, home.join(USER_UNITS.1)),
        ];
        for (surface, path) in candidates {
            let descriptor = Surface {
                name: surface,
                // Non lu : `walk` reçoit le chemin directement, seuls `name` et
                // `suffixes` comptent ici.
                path: "",
                suffixes: &[],
            };
            if walk(&descriptor, &path, 0, scan) {
                return true;
            }
        }
    }
    false
}

/// Les répertoires personnels réels, lus dans `/etc/passwd`.
///
/// Bornés aux comptes « humains » (uid ≥ 1000 ou root) : une machine porte des
/// dizaines de comptes de service dont le home est `/nonexistent` ou `/`, et
/// parcourir `/` serait catastrophique.
#[cfg(unix)]
fn home_dirs() -> Vec<PathBuf> {
    let Ok(text) = std::fs::read_to_string("/etc/passwd") else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for line in text.lines() {
        let f: Vec<&str> = line.split(':').collect();
        let (Some(uid), Some(home)) = (f.get(2).and_then(|u| u.parse::<u32>().ok()), f.get(5))
        else {
            continue;
        };
        if uid != 0 && uid < 1000 {
            continue;
        }
        // `/` comme home est le marqueur d'un compte de service : le parcourir
        // reviendrait à empreinter le système de fichiers entier.
        if home.is_empty() || *home == "/" || home.starts_with("/nonexistent") {
            continue;
        }
        out.push(PathBuf::from(home));
    }
    out.sort();
    out.dedup();
    out
}

#[cfg(not(unix))]
fn home_dirs() -> Vec<PathBuf> {
    std::env::var_os("USERPROFILE")
        .map(|p| vec![PathBuf::from(p)])
        .unwrap_or_default()
}

/// Clés `Run`/`RunOnce` et tâches planifiées.
///
/// Windows n'a pas de fichiers à empreinter pour ces surfaces : ce sont des
/// valeurs de registre et des définitions de tâches. On empreinte donc leur
/// **texte rendu**, ce qui répond à la même question — « est-ce que ça a
/// changé ? » — avec le même mécanisme de diff côté serveur.
#[cfg(target_os = "windows")]
fn collect_windows(scan: &mut Scan) -> bool {
    const KEYS: [&str; 4] = [
        r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run",
        r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce",
        r"HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Run",
        r"HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce",
    ];
    for key in KEYS {
        let Some(text) = crate::report::run("reg", &["query", key]) else {
            continue;
        };
        if push_synthetic(scan, "run_key", key, &text) {
            return true;
        }
    }
    if let Some(text) = crate::report::run("schtasks", &["/query", "/fo", "csv"]) {
        if push_synthetic(scan, "scheduled_task", "schtasks", &text) {
            return true;
        }
    }
    false
}

/// Entrée dont la « source » n'est pas un fichier (registre, sortie de commande).
#[cfg(target_os = "windows")]
fn push_synthetic(scan: &mut Scan, surface: &'static str, id: &str, text: &str) -> bool {
    if !scan.seen.insert(id.to_string()) {
        return false;
    }
    scan.entries.push(PersistenceEntry {
        surface,
        path: id.to_string(),
        sha256: hex(&Sha256::digest(text.as_bytes())),
        size_bytes: text.len() as u64,
        mtime: None,
        mode: None,
        owner: None,
    });
    scan.entries.len() >= MAX_ENTRIES
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// L'empreinte doit être celle du contenu, et changer avec lui — c'est tout
    /// ce sur quoi repose la détection de modification côté serveur.
    #[test]
    fn fingerprint_tracks_content() {
        let dir = std::env::temp_dir().join(format!("deveye-int-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("unit.service");
        std::fs::write(&file, b"ExecStart=/usr/bin/true\n").unwrap();

        let display = file.to_string_lossy().to_string();
        let owners = passwd_owners();
        let a = fingerprint("systemd", &file, &display, &owners).expect("fichier lisible");
        assert_eq!(a.sha256.len(), 64, "sha256 en hexadécimal");
        assert_eq!(a.size_bytes, 24);

        std::fs::write(&file, b"ExecStart=/tmp/evil\n").unwrap();
        let b = fingerprint("systemd", &file, &display, &owners).unwrap();
        assert_ne!(a.sha256, b.sha256, "un contenu modifié change l'empreinte");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Un fichier trop gros n'est pas empreinté : ce n'est pas une tâche
    /// planifiée, et le lire à chaque cycle coûterait plus que la sonde entière.
    #[test]
    fn fingerprint_skips_oversized_files() {
        let dir = std::env::temp_dir().join(format!("deveye-int-big-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("huge.service");
        std::fs::write(&file, vec![b'x'; (MAX_FILE_BYTES + 1) as usize]).unwrap();
        let display = file.to_string_lossy().to_string();
        assert!(fingerprint("systemd", &file, &display, &passwd_owners()).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Le suffixe filtre : `/etc/systemd/system` contient aussi des répertoires
    /// et des fichiers qui ne sont pas des unités.
    #[test]
    fn walk_honours_suffix_filter() {
        let dir = std::env::temp_dir().join(format!("deveye-int-sfx-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.service"), b"x").unwrap();
        std::fs::write(dir.join("b.txt"), b"x").unwrap();

        let surface = Surface {
            name: "systemd",
            path: "",
            suffixes: &[".service"],
        };
        let mut scan = Scan {
            entries: Vec::new(),
            seen: HashSet::new(),
            owners: passwd_owners(),
        };
        walk(&surface, &dir, 0, &mut scan);

        assert_eq!(scan.entries.len(), 1);
        assert!(scan.entries[0].path.ends_with("a.service"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Le relevé complet sur la machine qui exécute les tests.
    ///
    /// N'affirme rien sur *ce que* la machine contient — cela varie — mais tout
    /// sur la **forme** de ce qui sort. C'est ce qui attrape une empreinte
    /// tronquée, un chemin relatif ou un doublon, trois défauts que le diff
    /// serveur transformerait en constats fantômes rejouant à chaque cycle.
    #[test]
    fn collect_yields_a_well_formed_manifest() {
        let report = collect();
        assert!(report.collected_at > 0);
        assert!(
            report.entries.len() <= MAX_ENTRIES,
            "le plafond est respecté"
        );

        let mut paths = HashSet::new();
        for e in &report.entries {
            assert_eq!(
                e.sha256.len(),
                64,
                "sha256 hexadécimal complet : {}",
                e.path
            );
            assert!(
                e.sha256.chars().all(|c| c.is_ascii_hexdigit()),
                "sha256 hexadécimal : {}",
                e.sha256
            );
            assert!(!e.surface.is_empty());
            assert!(
                std::path::Path::new(&e.path).is_absolute() || cfg!(windows),
                "chemin absolu, sinon le diff serveur compare des clés instables : {}",
                e.path
            );
            assert!(
                paths.insert(e.path.clone()),
                "un chemin ne doit apparaître qu'une fois : {}",
                e.path
            );
        }

        eprintln!(
            "manifeste de cette machine : {} entrées, tronqué={}",
            report.entries.len(),
            report.truncated
        );
        for e in report.entries.iter().take(8) {
            eprintln!("  [{}] {} ({} o)", e.surface, e.path, e.size_bytes);
        }
    }
}
