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

/// Joint un chemin relatif du protocole sous `root`, en refusant tout ce qui
/// pourrait s'en échapper : segments vides, `.`/`..`, backslash, caractères de
/// contrôle, préfixes réservés.
pub fn safe_join(root: &Path, rel_path: &str) -> Result<PathBuf> {
    if rel_path.is_empty() || rel_path.len() > 1024 {
        bail!("chemin relatif vide ou trop long");
    }
    if rel_path.contains('\\') || rel_path.chars().any(|c| c.is_control()) {
        bail!("chemin relatif invalide");
    }
    let normalized = nfc(rel_path);
    let mut out = root.to_path_buf();
    for (i, seg) in normalized.split('/').enumerate() {
        if seg.is_empty() || seg == "." || seg == ".." {
            bail!("segment de chemin interdit");
        }
        if i == 0 && is_reserved_top(seg) {
            bail!("préfixe réservé");
        }
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
    fn rel_path_of_roundtrips() {
        let root = Path::new("/data/share");
        let abs = root.join("docs").join("rapport.pdf");
        assert_eq!(rel_path_of(root, &abs).unwrap(), "docs/rapport.pdf");
        assert!(rel_path_of(root, Path::new("/elsewhere/x")).is_none());
    }
}
