//! Chemins CloudSync : conversion arborescence locale ↔ chemins relatifs du
//! protocole (slashes avant, NFC), et jonction sûre — `safe_join` est LE
//! portail anti-traversée de l'agent : tout chemin relatif reçu du serveur
//! passe par lui avant de toucher le disque.

use std::path::{Component, Path, PathBuf};

use anyhow::{bail, Result};
use unicode_normalization::UnicodeNormalization;

/// Dossiers réservés à la racine du partage (jamais synchronisés).
pub const RESERVED_TOP_DIRS: [&str; 2] = [".deveye-trash", ".deveye-tmp"];

/// Without regard to case: `.DEVEYE-TRASH/x` would otherwise land INSIDE the
/// trash of a Windows or macOS peer.
pub fn is_reserved_top(name: &str) -> bool {
    RESERVED_TOP_DIRS
        .iter()
        .any(|reserved| name.eq_ignore_ascii_case(reserved))
}

/// Longest relative path the protocol carries, in UTF-8 bytes (mirror of `SYNC_REL_PATH_MAX`).
pub const REL_PATH_MAX_BYTES: usize = 1024;

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

/// The wire path of an entry whose name may not be valid UTF-8, lossily
/// (U+FFFD): only to name it as skipped, it never enters the index.
pub fn rel_path_lossy(root: &Path, abs: &Path) -> Option<String> {
    let stripped = abs.strip_prefix(root).ok()?;
    let parts: Vec<String> = stripped
        .components()
        .filter_map(|comp| match comp {
            Component::Normal(os) => Some(nfc(&os.to_string_lossy())),
            _ => None,
        })
        .collect();
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// Caractères qu'un nom NTFS/Win32 ne peut pas porter. Miroir exact de
/// `src/cloudSync/pathValidation.ts` : un partage doit rester identique sur les
/// trois OS, donc un nom irrecevable sous Windows est refusé PARTOUT — sinon
/// l'agent Windows échouerait sur ce fichier à chaque cycle, indéfiniment.
const WINDOWS_FORBIDDEN_CHARS: [char; 7] = ['"', '*', ':', '<', '>', '?', '|'];

/// Noms de périphériques DOS, réservés avec ou sans extension.
const WINDOWS_RESERVED_STEMS: [&str; 6] = ["con", "prn", "aux", "nul", "conin$", "conout$"];

/// Limite d'un composant de chemin sur la quasi-totalité des systèmes de fichiers (octets UTF-8).
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
    // COM0..COM9 et LPT0..LPT9, exposants compris : Windows les lit comme des chiffres.
    let Some(digit) = stem
        .strip_prefix("com")
        .or_else(|| stem.strip_prefix("lpt"))
    else {
        return false;
    };
    let mut chars = digit.chars();
    matches!(
        (chars.next(), chars.next()),
        (Some('0'..='9' | '\u{B9}' | '\u{B2}' | '\u{B3}'), None)
    )
}

fn segment_problem(segment: &str) -> Option<String> {
    if segment.is_empty() || segment == "." || segment == ".." {
        return Some("segment de chemin vide ou relatif".into());
    }
    if segment.len() > SEGMENT_MAX_BYTES {
        return Some("nom trop long".into());
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
    if rel_path.contains('\\') {
        return Some("antislash interdit dans un chemin".into());
    }
    if rel_path.chars().any(|c| c.is_control()) {
        return Some("caractère de contrôle interdit".into());
    }
    let normalized = nfc(rel_path);
    // En octets de la forme NFC : c'est ce que les systèmes de fichiers comptent.
    if normalized.len() > REL_PATH_MAX_BYTES {
        return Some("chemin trop long".into());
    }
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

/// `\\?\C:\dir` → `C:\dir`, `\\?\UNC\srv\share` → `\\srv\share`.
///
/// Windows' `canonicalize` always answers with a verbatim path. The prefix is an
/// API detail that leaks: the client splits paths on the separator for its
/// breadcrumbs, so `\\?\` becomes a phantom `?` directory, and a verbatim path
/// never compares equal to the plain `C:\Windows` of a denied-roots list. std
/// re-adds the prefix when it needs it, so the plain form still opens long
/// paths. Device paths (`\\?\Volume{…}`) have no plain form and are left untouched.
pub fn strip_verbatim(s: String) -> String {
    let Some(rest) = s.strip_prefix(r"\\?\") else {
        return s;
    };
    if let Some(unc) = rest.strip_prefix(r"UNC\") {
        return format!(r"\\{unc}");
    }
    let mut c = rest.chars();
    let is_drive = matches!((c.next(), c.next()), (Some(l), Some(':')) if l.is_ascii_alphabetic());
    if is_drive {
        rest.to_owned()
    } else {
        s
    }
}

/// The real path (links resolved) in its plain form, comparable component by
/// component with a path typed by hand; the path itself when it does not exist.
pub fn plain_canonical(path: &Path) -> PathBuf {
    let Ok(real) = path.canonicalize() else {
        return path.to_path_buf();
    };
    // `cfg!` (not `#[cfg]`) so the Windows branch is still compiled and unit
    // tested on the Linux/macOS builds.
    if cfg!(windows) {
        PathBuf::from(strip_verbatim(real.to_string_lossy().into_owned()))
    } else {
        real
    }
}

/// Is one path the other, or inside it? Two share roots that overlap would
/// each sync the other's trash and conflict copies.
pub fn overlaps(a: &Path, b: &Path) -> bool {
    is_under(a, b) || is_under(b, a)
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
    let real = plain_canonical(path);
    if real.parent().is_none() {
        return Some("la racine du système de fichiers ne peut pas être un partage".into());
    }
    if own_dir.is_some_and(|own| is_under(&real, own) || is_under(own, &real)) {
        return Some("le dossier de l'agent ne peut pas faire partie d'un partage".into());
    }
    let listed = allowlist
        .iter()
        .any(|entry| is_under(&real, &plain_canonical(Path::new(entry.trim()))));
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
            ".DEVEYE-TRASH/x",
            ".Deveye-Tmp/x",
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
            "CONIN$",
            "conout$.txt",
            "COM\u{B9}",
            "lpt\u{B2}.log",
            "a\u{7F}b",
            "a\u{85}b",
        ] {
            assert!(safe_join(root, bad).is_err(), "should reject {bad:?}");
        }
    }

    /// The same cases as `pathValidation.test.ts`: lengths are UTF-8 bytes of
    /// the NFC form, so 600 two-byte characters (1200 bytes) are over the limit.
    #[test]
    fn lengths_are_counted_in_bytes() {
        let root = Path::new("/data/share");
        assert!(safe_join(root, &"a".repeat(255)).is_ok());
        assert!(safe_join(root, &format!("{}.txt", "a".repeat(255))).is_err());
        assert!(safe_join(root, &"é".repeat(200)).is_err());
        let long_ascii = (0..4)
            .map(|_| "a".repeat(200))
            .collect::<Vec<_>>()
            .join("/");
        assert!(safe_join(root, &long_ascii).is_ok());
        let long_utf8 = (0..5)
            .map(|_| "é".repeat(120))
            .collect::<Vec<_>>()
            .join("/");
        assert_eq!(long_utf8.chars().count(), 604);
        assert!(safe_join(root, &long_utf8).is_err());
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
            "com",
            "lpt\u{B9}\u{B9}",
            "conin",
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

    /// Runs on every platform (the Windows branch is `cfg!`, not `#[cfg]`).
    #[test]
    fn verbatim_prefixes_are_stripped_when_they_have_a_plain_form() {
        let strip = |s: &str| strip_verbatim(s.to_string());
        assert_eq!(strip(r"\\?\C:\Users\gerem"), r"C:\Users\gerem");
        assert_eq!(strip(r"\\?\c:\"), r"c:\");
        assert_eq!(strip(r"\\?\UNC\srv\partage\x"), r"\\srv\partage\x");
        // No plain equivalent, or nothing to strip: left alone.
        assert_eq!(strip(r"\\?\Volume{0c2e}\x"), r"\\?\Volume{0c2e}\x");
        assert_eq!(strip(r"C:\Users\gerem"), r"C:\Users\gerem");
        assert_eq!(strip("/home/gerem"), "/home/gerem");
    }

    #[test]
    fn plain_canonical_is_comparable_with_typed_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let real = plain_canonical(tmp.path());
        assert!(!real.to_string_lossy().starts_with(r"\\?\"));
        assert!(is_under(&plain_canonical(&tmp.path().join("x")), &real));
        let missing = tmp.path().join("nope").join("deeper");
        assert_eq!(plain_canonical(&missing), missing);
    }

    #[test]
    fn overlapping_roots() {
        let a = Path::new("/data/a");
        assert!(overlaps(a, Path::new("/data/a")));
        assert!(overlaps(a, Path::new("/data/a/b")));
        assert!(overlaps(Path::new("/data"), a));
        assert!(!overlaps(a, Path::new("/data/ab")));
        assert!(!overlaps(a, Path::new("/data/b")));
    }

    #[test]
    fn reserved_top_dirs_ignore_case() {
        assert!(is_reserved_top(".deveye-trash"));
        assert!(is_reserved_top(".DEVEYE-TRASH"));
        assert!(is_reserved_top(".Deveye-Tmp"));
        assert!(!is_reserved_top("..deveye-trash"));
        assert!(!is_reserved_top("deveye-trash"));
    }

    #[cfg(unix)]
    #[test]
    fn rel_path_lossy_names_what_rel_path_of_cannot() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;
        let root = Path::new("/data/share");
        let abs = root.join(OsStr::from_bytes(b"caf\xe9.txt"));
        assert!(rel_path_of(root, &abs).is_none());
        assert_eq!(rel_path_lossy(root, &abs).unwrap(), "caf\u{FFFD}.txt");
        assert!(rel_path_lossy(root, root).is_none());
    }
}
