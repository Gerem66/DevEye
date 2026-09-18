//! Chemins CloudSync : conversion arborescence locale ↔ chemins relatifs du
//! protocole (slashes avant, NFC), et jonction sûre — `safe_join` est LE
//! portail anti-traversée de l'agent : tout chemin relatif reçu du serveur
//! passe par lui avant de toucher le disque.

use std::path::{Component, Path, PathBuf};

use anyhow::{bail, Result};
use unicode_normalization::UnicodeNormalization;

/// Dossiers réservés à la racine du partage (jamais synchronisés).
pub const RESERVED_TOP_DIRS: [&str; 2] = [".deveye-trash", ".deveye-tmp"];

pub fn is_reserved_top(name: &str) -> bool {
    RESERVED_TOP_DIRS.contains(&name)
}

fn nfc(value: &str) -> String {
    value.nfc().collect()
}

/// Le chemin relatif « wire » d'un fichier du partage : slashes avant, NFC.
/// `None` si le chemin sort de la racine ou n'est pas de l'UTF-8 valide.
pub fn rel_path_of(root: &Path, abs: &Path) -> Option<String> {
    let stripped = abs.strip_prefix(root).ok()?;
    let mut parts: Vec<String> = Vec::new();
    for comp in stripped.components() {
        match comp {
            Component::Normal(os) => parts.push(nfc(os.to_str()?)),
            _ => return None,
        }
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

/// Caractères qu'un nom NTFS/Win32 ne peut pas porter. Miroir exact de
/// `src/cloudSync/pathValidation.ts` : un partage doit rester identique sur les
/// trois OS, donc un nom irrecevable sous Windows est refusé PARTOUT — sinon
/// l'agent Windows échouerait sur ce fichier à chaque cycle, indéfiniment.
const WINDOWS_FORBIDDEN_CHARS: [char; 7] = ['"', '*', ':', '<', '>', '?', '|'];

/// Noms de périphériques DOS, réservés avec ou sans extension.
const WINDOWS_RESERVED_STEMS: [&str; 4] = ["con", "prn", "aux", "nul"];

/// Limite d'un composant de chemin sur la quasi-totalité des systèmes de fichiers.
const SEGMENT_MAX_BYTES: usize = 255;

fn is_windows_reserved(segment: &str) -> bool {
    let stem = segment
        .split('.')
        .next()
        .unwrap_or(segment)
        .to_ascii_lowercase();
    if WINDOWS_RESERVED_STEMS.contains(&stem.as_str()) {
        return true;
    }
    // COM0..COM9 et LPT0..LPT9.
    let Some(digit) = stem
        .strip_prefix("com")
        .or_else(|| stem.strip_prefix("lpt"))
    else {
        return false;
    };
    digit.len() == 1 && digit.chars().all(|c| c.is_ascii_digit())
}

fn segment_problem(segment: &str) -> Option<String> {
    if segment.is_empty() || segment == "." || segment == ".." {
        return Some("segment de chemin vide ou relatif".into());
    }
    if segment.len() > SEGMENT_MAX_BYTES {
        return Some(format!("nom de plus de {SEGMENT_MAX_BYTES} octets"));
    }
    if let Some(bad) = segment
        .chars()
        .find(|c| WINDOWS_FORBIDDEN_CHARS.contains(c))
    {
        return Some(format!("caractère « {bad} » interdit sous Windows"));
    }
    if is_windows_reserved(segment) {
        return Some(format!("« {segment} » est un nom réservé sous Windows"));
    }
    // Windows tronque silencieusement les points et espaces de fin.
    if segment.ends_with('.') {
        return Some("nom terminé par un point (impossible sous Windows)".into());
    }
    if segment.ends_with(' ') {
        return Some("nom terminé par une espace (impossible sous Windows)".into());
    }
    None
}

/// Le problème d'un chemin relatif, ou `None` s'il est synchronisable partout.
/// Miroir de `relPathProblem` côté serveur : les deux DOIVENT rester d'accord,
/// sinon un fichier accepté d'un côté et refusé de l'autre oscillerait sans fin.
pub fn rel_path_problem(rel_path: &str) -> Option<String> {
    if rel_path.is_empty() {
        return Some("chemin vide".into());
    }
    if rel_path.len() > 1024 {
        return Some("chemin de plus de 1024 caractères".into());
    }
    if rel_path.contains('\\') {
        return Some("antislash interdit dans un chemin".into());
    }
    if rel_path.chars().any(|c| c.is_control()) {
        return Some("caractère de contrôle interdit".into());
    }
    let normalized = nfc(rel_path);
    let mut segments = normalized.split('/');
    let Some(first) = segments.next() else {
        return Some("chemin vide".into());
    };
    if is_reserved_top(first) {
        return Some(format!("« {first} » est un dossier réservé à l'agent"));
    }
    if let Some(problem) = segment_problem(first) {
        return Some(problem);
    }
    segments.find_map(segment_problem)
}

/// Joint un chemin relatif du protocole sous `root`, en refusant tout ce qui
/// pourrait s'en échapper (segments vides, `.`/`..`, backslash, caractères de
/// contrôle, préfixes réservés) et tout ce qui n'est pas portable sur les trois
/// OS (voir [`rel_path_problem`]).
pub fn safe_join(root: &Path, rel_path: &str) -> Result<PathBuf> {
    if let Some(problem) = rel_path_problem(rel_path) {
        bail!("chemin relatif refusé : {problem}");
    }
    let normalized = nfc(rel_path);
    let mut out = root.to_path_buf();
    for seg in normalized.split('/') {
        out.push(seg);
    }
    Ok(out)
}

/// Les racines qu'aucun partage ne peut prendre, ni rien de ce qu'elles
/// contiennent : y écrire, c'est écrire le système (une tâche cron, une unité,
/// une clé autorisée). Le serveur choisit la racine d'un partage, et ce choix
/// passe par un droit qui n'est pas celui du terminal.
#[cfg(all(unix, not(target_os = "macos")))]
const DENIED_ROOTS: &[&str] = &[
    "/etc",
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/boot",
    "/sys",
    "/proc",
    "/dev",
    "/run",
    "/var/lib",
    "/root/.ssh",
];
#[cfg(target_os = "macos")]
const DENIED_ROOTS: &[&str] = &[
    "/etc",
    "/usr",
    "/bin",
    "/sbin",
    "/boot",
    "/sys",
    "/proc",
    "/dev",
    "/run",
    "/var/lib",
    "/Library",
    "/System",
    "/private",
    "/Applications",
];
#[cfg(windows)]
const DENIED_ROOTS: &[&str] = &[
    r"C:\Windows",
    r"C:\Program Files",
    r"C:\Program Files (x86)",
    r"C:\ProgramData",
];

/// `path` est-il `base`, ou dessous ? Composant par composant (`/etcetera`
/// n'est pas sous `/etc`), sans égard à la casse sous Windows.
fn is_under(path: &Path, base: &Path) -> bool {
    let mut p = path.components();
    for b in base.components() {
        match p.next() {
            Some(c) if same_component(c.as_os_str(), b.as_os_str()) => {}
            _ => return false,
        }
    }
    true
}

fn same_component(a: &std::ffi::OsStr, b: &std::ffi::OsStr) -> bool {
    if cfg!(windows) {
        a.to_string_lossy()
            .eq_ignore_ascii_case(&b.to_string_lossy())
    } else {
        a == b
    }
}

/// Là où un système monte les disques amovibles : sous `/run`, mais ce sont les
/// données de l'utilisateur, pas l'état du système.
const REMOVABLE_MOUNTS: &[&str] = &["/run/media", "/run/mount"];

/// Pourquoi cette racine de partage est refusée sur cette machine ; `None` si
/// elle est acceptable. `allowlist` est `sync_roots` de la config locale : vide,
/// tout dossier non système convient ; sinon la racine doit être l'une des
/// entrées, ou dessous, et ce choix écrit sur la machine l'emporte sur la liste
/// des dossiers système (l'opérateur sait ce qu'il ouvre, le serveur non).
/// `own_dir` est le dossier de l'agent, jamais partageable.
pub fn root_problem(
    local_path: &str,
    allowlist: &[String],
    own_dir: Option<&Path>,
) -> Option<String> {
    let trimmed = local_path.trim();
    let path = Path::new(trimmed);
    if trimmed.is_empty() || !path.is_absolute() {
        return Some("le dossier du partage doit être un chemin absolu".into());
    }
    if path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Some("le dossier du partage ne peut pas contenir « .. »".into());
    }
    // Un lien vers `/etc` ne doit pas passer pour un dossier ordinaire.
    let real = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    if real.parent().is_none() {
        return Some("la racine du système de fichiers ne peut pas être un partage".into());
    }
    if own_dir.is_some_and(|own| is_under(&real, own) || is_under(own, &real)) {
        return Some("le dossier de l'agent ne peut pas faire partie d'un partage".into());
    }
    let listed = allowlist.iter().any(|entry| {
        let entry = Path::new(entry.trim());
        let entry = entry.canonicalize().unwrap_or_else(|_| entry.to_path_buf());
        is_under(&real, &entry)
    });
    if !allowlist.is_empty() {
        return (!listed).then(|| {
            "ce dossier n'est pas dans `sync_roots` (agent.toml) de cette machine".into()
        });
    }
    let removable = REMOVABLE_MOUNTS
        .iter()
        .any(|m| is_under(&real, Path::new(m)));
    if let Some(denied) = DENIED_ROOTS.iter().find(|d| is_under(&real, Path::new(d))) {
        if !removable {
            return Some(format!(
                "« {denied} » est un dossier système, refusé comme partage (pour l'ouvrir quand même : `sync_roots` dans agent.toml)"
            ));
        }
    }
    None
}

/// [`safe_join`], puis la garantie que le chemin obtenu est réellement sous la
/// racine : la validation du chemin relatif est lexicale, et un lien symbolique
/// posé dans le partage (`lien -> /etc`) l'en ferait sortir. Le premier ancêtre
/// existant est résolu et doit rester sous la racine résolue.
pub fn confined_join(root: &Path, rel_path: &str) -> Result<PathBuf> {
    let joined = safe_join(root, rel_path)?;
    let real_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let mut probe = joined.clone();
    loop {
        if let Ok(real) = probe.canonicalize() {
            if !is_under(&real, &real_root) {
                bail!("chemin résolu hors du partage (lien symbolique)");
            }
            return Ok(joined);
        }
        if !probe.pop() {
            return Ok(joined);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    fn root_problem_denies_system_dirs() {
        for denied in [
            "/",
            "/etc",
            "/etc/ssh",
            "/usr/local/share",
            "/var/lib/x",
            "/proc/1",
            "relative/dir",
            "",
        ] {
            assert!(
                root_problem(denied, &[], None).is_some(),
                "{denied} doit être refusé"
            );
        }
        for fine in ["/home/u/Docs", "/data/share", "/etcetera", "/srv/sync"] {
            assert!(
                root_problem(fine, &[], None).is_none(),
                "{fine} doit passer"
            );
        }
        assert!(root_problem("/data/../etc", &[], None).is_some());

        assert!(
            root_problem("/run/media/u/USB", &[], None).is_none(),
            "un disque amovible"
        );
        assert!(root_problem("/run/user/1000", &[], None).is_some());
        // Ce que l'opérateur écrit dans sa config l'emporte sur la liste système.
        let opened = vec!["/var/lib/myapp".to_string()];
        assert!(root_problem("/var/lib/myapp/data", &opened, None).is_none());
        assert!(root_problem("/var/lib/other", &opened, None).is_some());

        let only_data = vec!["/data".to_string()];
        assert!(root_problem("/data/x", &only_data, None).is_none());
        assert!(root_problem("/data", &only_data, None).is_none());
        assert!(root_problem("/home/u", &only_data, None).is_some());
        assert!(
            root_problem("/database", &only_data, None).is_some(),
            "préfixe de nom, pas de chemin"
        );

        let own = Path::new("/home/u/.config/deveye");
        assert!(root_problem("/home/u/.config/deveye", &[], Some(own)).is_some());
        assert!(
            root_problem("/home/u/.config", &[], Some(own)).is_some(),
            "un partage qui contient l'agent"
        );
        assert!(root_problem("/home/u/Docs", &[], Some(own)).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn confined_join_rejects_symlink_escape() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("share");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();

        assert!(confined_join(&root, "link/x.txt").is_err());
        // Un dossier qui n'existe pas encore reste acceptable : il sera créé dans le partage.
        assert_eq!(
            confined_join(&root, "docs/x.txt").unwrap(),
            root.join("docs/x.txt")
        );
        assert!(confined_join(&root, "../outside/x").is_err());
    }

    #[test]
    fn safe_join_accepts_nested_paths() {
        let root = Path::new("/data/share");
        assert_eq!(
            safe_join(root, "docs/rapport.pdf").unwrap(),
            PathBuf::from("/data/share/docs/rapport.pdf")
        );
    }

    #[test]
    fn safe_join_rejects_escapes() {
        let root = Path::new("/data/share");
        for bad in [
            "../etc/passwd",
            "docs/../../etc/passwd",
            "/abs",
            "docs//x",
            "docs/./x",
            ".deveye-trash/x",
            ".deveye-tmp/x",
            "a\\b",
            "a\u{0000}b",
            "",
        ] {
            assert!(safe_join(root, bad).is_err(), "should reject {bad:?}");
        }
    }

    #[test]
    fn safe_join_rejects_unportable_windows_names() {
        let root = Path::new("/data/share");
        for bad in [
            "aux.txt",
            "CON",
            "docs/NUL.md",
            "com1",
            "LPT9.log",
            "a:b.txt",
            "quoi?.txt",
            "e<t>.txt",
            "pipe|x",
            "star*",
            "guillemet\".txt",
            "fin.",
            "fin ",
            "docs/sous-dossier./x",
        ] {
            assert!(safe_join(root, bad).is_err(), "should reject {bad:?}");
        }
    }

    #[test]
    fn safe_join_accepts_lookalikes_that_are_fine() {
        let root = Path::new("/data/share");
        // Ni des noms réservés, ni des caractères interdits : rien ne doit
        // partir en faux positif (le refus retire le fichier du cloud).
        for ok in [
            "console.log",
            "communication.txt",
            "auxiliaire/notes.md",
            "com10",
            "nullable.rs",
            "point.dans.le.nom.txt",
        ] {
            assert!(safe_join(root, ok).is_ok(), "should accept {ok:?}");
        }
    }

    #[test]
    fn rel_path_of_roundtrips() {
        let root = Path::new("/data/share");
        let abs = root.join("docs").join("rapport.pdf");
        assert_eq!(rel_path_of(root, &abs).unwrap(), "docs/rapport.pdf");
        assert!(rel_path_of(root, Path::new("/elsewhere/x")).is_none());
    }
}
