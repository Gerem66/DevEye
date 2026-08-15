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

#[cfg(test)]
mod tests {
    use super::*;

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
