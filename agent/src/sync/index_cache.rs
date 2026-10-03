//! Cache de scan persistant par partage (`sync-<shareId>.index.json`, à côté
//! de la config) : relPath → (size, mtime, hash). Un fichier dont la taille et
//! le mtime n'ont pas bougé garde son hash sans relecture — c'est ce qui rend
//! les scans réguliers bon marché même sur de gros dossiers.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tracing::debug;

use crate::config::Config;

/// Une entrée du cache, avec exactement les champs d'un `SyncIndexEntry`.
///
/// `kind` et `mode` ne servent pas au cache de hachage mais à l'empreinte : sans
/// eux, un `chmod` (qui déplace le ctime, pas le mtime) ou un dossier vidé de
/// son dernier fichier lui seraient invisibles alors qu'un scan les voit.
///
/// Ils sont requis, sans `serde(default)` : un cache qui ne les porte pas cesse
/// de se désérialiser et `load` retombe sur un cache vide (un re-hachage par
/// partage), plutôt que de produire une empreinte fausse.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheEntry {
    pub size: u64,
    /// Millisecondes unix.
    pub mtime: i64,
    pub hash: String,
    /// `file` ou `dir` (un dossier n'est indexé que s'il est vide).
    pub kind: String,
    /// Bits de permission Unix ; `None` sous Windows, qui n'en a pas.
    pub mode: Option<u32>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct IndexCache {
    /// Le dossier local du partage au dernier scan. Ne sert pas au scan (qui
    /// reçoit sa racine du serveur) mais au retrait : `uninstall` tourne hors
    /// ligne, et c'est la seule trace locale de l'endroit où l'agent a posé ses
    /// `.deveye-tmp` / `.deveye-trash`.
    #[serde(default)]
    pub root: String,
    /// The naming key the hashes were computed under (`ShareKeys::scheme`),
    /// empty for plain SHA-256. Another one makes every hash worthless.
    #[serde(default)]
    pub scheme: String,
    pub entries: HashMap<String, CacheEntry>,
}

impl IndexCache {
    /// Charge le cache d'un partage ; un cache absent/corrompu = cache vide
    /// (le scan rehash tout, jamais d'erreur bloquante).
    pub fn load(share_id: i64) -> Self {
        let path = Config::sync_index_path(share_id);
        match std::fs::read_to_string(&path) {
            Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
            Err(_) => Self::default(),
        }
    }

    /// Sauvegarde best-effort (échec = simple debug log ; le prochain scan rehashera).
    pub fn save(&self, share_id: i64) {
        let path = Config::sync_index_path(share_id);
        match serde_json::to_string(self) {
            Ok(raw) => {
                // Le cache nomme chaque fichier du partage : lisible par son seul propriétaire.
                if let Err(e) = crate::config::write_private(&path, raw.as_bytes()) {
                    debug!(error = %e, path = %path.display(), "sync index cache save failed");
                }
            }
            Err(e) => debug!(error = %e, "sync index cache serialize failed"),
        }
    }

    pub fn remove(share_id: i64) {
        let _ = std::fs::remove_file(Config::sync_index_path(share_id));
    }
}
