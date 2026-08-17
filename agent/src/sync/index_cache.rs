//! Cache de scan persistant par partage (`sync-<shareId>.index.json`, à côté
//! de la config) : relPath → (size, mtime, hash). Un fichier dont la taille et
//! le mtime n'ont pas bougé garde son hash sans relecture — c'est ce qui rend
//! les scans réguliers bon marché même sur de gros dossiers.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tracing::debug;

use crate::config::Config;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheEntry {
    pub size: u64,
    /// Millisecondes unix.
    pub mtime: i64,
    pub hash: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct IndexCache {
    /// Le dossier local du partage, tel qu'il était au dernier scan.
    ///
    /// Il ne sert pas au scan, qui reçoit sa racine du serveur : il sert au
    /// **retrait**. `uninstall` tourne hors ligne, sans config de partage, et
    /// c'est la seule trace locale de l'endroit où l'agent a posé ses
    /// `.deveye-tmp` / `.deveye-trash` — sans quoi la désinstallation les
    /// laisserait derrière elle sans même pouvoir les nommer.
    #[serde(default)]
    pub root: String,
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
                if let Err(e) = std::fs::write(&path, raw) {
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
