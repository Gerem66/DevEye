//! CloudSync côté agent : le serveur orchestre, l'agent exécute.
//!
//! L'agent ne décide jamais rien : il signale les changements locaux
//! (`sync.changed`, débouncé), scanne sur ordre (`sync.index`), transfère sur
//! ordre (`sync.chunk` / install atomique), et « supprime » vers une corbeille
//! locale (`.deveye-trash/`) uniquement quand le serveur — qui a déjà archivé
//! une version vérifiée — le demande.

mod index_cache;
pub mod paths;
mod scanner;
mod transfer;
mod watcher;

use std::collections::HashMap;
use std::path::PathBuf;

use tokio::sync::mpsc::Sender;
use tracing::{info, warn};

use crate::protocol::{SyncIndexEntry, SyncShareAssignment};
use transfer::{Applier, ApplyOutcome};
use watcher::ShareWatcher;

/// Événements que les tâches sync renvoient à la boucle (qui les met sur le fil).
pub enum SyncEvent {
    /// Le watcher (débouncé) a vu bouger le dossier d'un partage.
    Changed { share_id: i64 },
    /// Un lot d'index du scan (dernier lot `done`).
    Index {
        session_id: String,
        share_id: i64,
        entries: Vec<SyncIndexEntry>,
        done: bool,
        error: Option<String>,
    },
    /// Un chunk d'upload (`data` brut, encodé base64 à l'envoi).
    Chunk {
        op_id: String,
        data: Vec<u8>,
        done: bool,
        hash: Option<String>,
        size: Option<u64>,
        mtime: Option<i64>,
        error: Option<String>,
    },
    /// Crédit de flux d'un download.
    Ack { op_id: String, seq: u64 },
    /// Issue d'une op locale (`apply` | `delete` | `push`).
    OpResult {
        op_id: String,
        op: &'static str,
        ok: bool,
        error: Option<String>,
    },
}

struct ShareState {
    assignment: SyncShareAssignment,
    /// Présent seulement quand le partage est actif.
    _watcher: Option<ShareWatcher>,
}

/// Possède les assignations, les watchers et les installs en cours. Vit dans
/// la session WebSocket (comme `TermManager`) : le drop en fin de session
/// arrête les watchers et nettoie les temporaires ; le serveur re-pousse
/// `sync.config` à la reconnexion.
pub struct SyncManager {
    tx: Sender<SyncEvent>,
    shares: HashMap<i64, ShareState>,
    applier: Applier,
}

impl SyncManager {
    pub fn new(tx: Sender<SyncEvent>) -> Self {
        Self {
            tx,
            shares: HashMap::new(),
            applier: Applier::default(),
        }
    }

    /// Applique une config complète : la liste REMPLACE l'existante.
    pub fn apply_config(&mut self, assignments: Vec<SyncShareAssignment>) {
        let mut next: HashMap<i64, ShareState> = HashMap::new();
        for assignment in assignments {
            let share_id = assignment.share_id;
            let active = assignment.status == "active";
            let unchanged = self.shares.remove(&share_id).filter(|s| {
                s.assignment.local_path == assignment.local_path && (s._watcher.is_some()) == active
            });
            let watcher = match unchanged {
                Some(prev) => prev._watcher, // Watcher conservé tel quel.
                None if active => {
                    match watcher::start(
                        share_id,
                        PathBuf::from(&assignment.local_path),
                        self.tx.clone(),
                    ) {
                        Ok(w) => Some(w),
                        Err(e) => {
                            warn!(share_id, error = %e, "sync: watcher start failed (periodic scans still cover)");
                            None
                        }
                    }
                }
                None => None,
            };
            next.insert(
                share_id,
                ShareState {
                    assignment,
                    _watcher: watcher,
                },
            );
        }
        // Ce qui reste dans self.shares a été détaché : watchers droppés ici,
        // et leur cache de scan n'a plus de raison d'être.
        for share_id in self.shares.keys() {
            index_cache::IndexCache::remove(*share_id);
        }
        info!(count = next.len(), "sync: config applied");
        self.shares = next;
    }

    fn assignment(&self, share_id: i64) -> Option<&SyncShareAssignment> {
        self.shares.get(&share_id).map(|s| &s.assignment)
    }

    /// Scan complet (thread dédié) ; partage inconnu/en pause → lot d'erreur.
    pub fn start_scan(&self, session_id: String, share_id: i64) {
        match self.assignment(share_id) {
            Some(a) if a.status == "active" => {
                scanner::spawn_scan(session_id, a.clone(), self.tx.clone());
            }
            _ => {
                let _ = self.tx.try_send(SyncEvent::Index {
                    session_id,
                    share_id,
                    entries: Vec::new(),
                    done: true,
                    error: Some("Partage inconnu ou en pause sur cet appareil".to_string()),
                });
            }
        }
    }

    /// Upload d'un fichier local (thread dédié).
    pub fn start_push(&self, op_id: String, share_id: i64, rel_path: String) {
        match self.assignment(share_id) {
            Some(a) => transfer::spawn_push(
                op_id,
                PathBuf::from(&a.local_path),
                rel_path,
                self.tx.clone(),
            ),
            None => {
                let _ = self.tx.try_send(SyncEvent::Chunk {
                    op_id,
                    data: Vec::new(),
                    done: true,
                    hash: None,
                    size: None,
                    mtime: None,
                    error: Some("Partage inconnu sur cet appareil".to_string()),
                });
            }
        }
    }

    /// Un chunk de download à installer (séquentiel, appelé inline par la boucle).
    /// Retourne les événements à renvoyer au serveur.
    #[allow(clippy::too_many_arguments)]
    pub fn apply_chunk(
        &mut self,
        op_id: &str,
        share_id: i64,
        rel_path: &str,
        seq: u64,
        data: &[u8],
        done: bool,
        hash: &str,
        size: u64,
        mtime: i64,
    ) -> Vec<SyncEvent> {
        let Some(assignment) = self.assignment(share_id).cloned() else {
            return vec![SyncEvent::OpResult {
                op_id: op_id.to_string(),
                op: "apply",
                ok: false,
                error: Some("Partage inconnu sur cet appareil".to_string()),
            }];
        };
        let root = PathBuf::from(&assignment.local_path);
        match self.applier.apply_chunk(
            op_id, share_id, &root, rel_path, seq, data, done, hash, size, mtime,
        ) {
            ApplyOutcome::Ack { seq } => vec![SyncEvent::Ack {
                op_id: op_id.to_string(),
                seq,
            }],
            ApplyOutcome::Installed { seq } => vec![
                SyncEvent::Ack {
                    op_id: op_id.to_string(),
                    seq,
                },
                SyncEvent::OpResult {
                    op_id: op_id.to_string(),
                    op: "apply",
                    ok: true,
                    error: None,
                },
            ],
            ApplyOutcome::Failed { error } => vec![SyncEvent::OpResult {
                op_id: op_id.to_string(),
                op: "apply",
                ok: false,
                error: Some(error),
            }],
        }
    }

    /// Suppression propagée : corbeille locale, puis `sync.opResult`.
    pub fn delete(&self, op_id: &str, share_id: i64, rel_path: &str) -> SyncEvent {
        let outcome = match self.assignment(share_id) {
            Some(a) => transfer::delete_to_trash(&PathBuf::from(&a.local_path), rel_path)
                .map_err(|e| e.to_string()),
            None => Err("Partage inconnu sur cet appareil".to_string()),
        };
        SyncEvent::OpResult {
            op_id: op_id.to_string(),
            op: "delete",
            ok: outcome.is_ok(),
            error: outcome.err(),
        }
    }
}

impl Drop for SyncManager {
    fn drop(&mut self) {
        // Fin de session : les temporaires d'installs en cours sont nettoyés
        // (les watchers, eux, s'arrêtent via leur propre Drop).
        self.applier.abort_all();
    }
}
