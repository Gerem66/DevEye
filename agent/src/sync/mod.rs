//! CloudSync côté agent : le serveur orchestre, l'agent exécute.
//!
//! L'agent ne décide jamais rien : il signale les changements locaux
//! (`sync.changed`, débouncé), scanne sur ordre (`sync.index`), transfère sur
//! ordre (`sync.chunk` / install atomique), et « supprime » vers une corbeille
//! locale (`.deveye-trash/`) uniquement quand le serveur — qui a déjà archivé
//! une version vérifiée — le demande.

pub mod fingerprint;
pub mod index_cache;
pub mod paths;
pub mod scanner;
mod transfer;
mod watcher;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::mpsc::Sender;
use tracing::{info, warn};

use crate::protocol::{SyncIndexEntry, SyncShareAssignment};
use transfer::{Applier, ApplyOutcome, PushCredits, PushWindow, PUSH_ACK_TIMEOUT};
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
        /// Le disque a-t-il réellement été parcouru ? `false` = réponse rapide.
        scanned: bool,
        /// Empreinte de l'index détenu, portée par le lot final uniquement.
        fingerprint: Option<String>,
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
        /// Rank of the frame within a windowed push, `None` on a free stream.
        seq: Option<u64>,
    },
    /// Crédit de flux d'un download.
    Ack { op_id: String, seq: u64 },
    /// Issue d'une op locale (`apply` | `applyDir` | `applyLocal` | `applyReady`
    /// | `delete` | `push`).
    OpResult {
        op_id: String,
        op: &'static str,
        ok: bool,
        /// `applyReady` seulement : octets de clair déjà détenus.
        resume_from: Option<u64>,
        error: Option<String>,
    },
}

/// Ce que l'agent sait de la fraîcheur d'un partage.
///
/// « Propre » : le dernier scan complet s'est terminé sans qu'aucun événement de
/// watcher ne soit survenu depuis, donc `fingerprint` décrit encore ce qu'un
/// nouveau scan produirait. `epoch: None` est l'état de départ et porte toute
/// l'invalidation : partage attaché, agent qui démarre, chemin ou exclusions
/// modifiés forcent un parcours complet sans traitement particulier.
#[derive(Default)]
pub struct CleanMark {
    pub epoch: Option<u64>,
    pub fingerprint: String,
}

struct ShareState {
    assignment: SyncShareAssignment,
    /// Présent seulement quand le partage est actif.
    _watcher: Option<ShareWatcher>,
    /// Compteur d'événements du watcher, `None` quand il n'a pas pu démarrer.
    events: Option<Arc<AtomicU64>>,
    clean: Arc<Mutex<CleanMark>>,
}

/// Possède les assignations, les watchers et les installs en cours. Vit dans
/// la session WebSocket (comme `TermManager`) : le drop en fin de session
/// arrête les watchers et nettoie les temporaires ; le serveur re-pousse
/// `sync.config` à la reconnexion.
pub struct SyncManager {
    tx: Sender<SyncEvent>,
    shares: HashMap<i64, ShareState>,
    applier: Applier,
    /// `sync_roots` de la config locale : où cette machine accepte un partage.
    sync_roots: Vec<String>,
    /// Les partages dont la racine a été refusée, et pourquoi : le serveur
    /// l'apprend par la réponse à sa première opération.
    refused: HashMap<i64, String>,
    push_credits: PushCredits,
}

impl SyncManager {
    pub fn new(tx: Sender<SyncEvent>, sync_roots: Vec<String>) -> Self {
        Self {
            tx,
            shares: HashMap::new(),
            applier: Applier::default(),
            sync_roots,
            refused: HashMap::new(),
            push_credits: PushCredits::default(),
        }
    }

    /// Ce qu'on répond d'un partage qui n'est pas servi ici : le refus de sa
    /// racine s'il y en a un, sinon qu'il est inconnu.
    fn unknown_reason(&self, share_id: i64) -> String {
        match self.refused.get(&share_id) {
            Some(reason) => format!("Partage refusé par cette machine : {reason}"),
            None => "Partage inconnu sur cet appareil".to_string(),
        }
    }

    /// Applique une config complète : la liste REMPLACE l'existante.
    pub fn apply_config(&mut self, assignments: Vec<SyncShareAssignment>) {
        let mut next: HashMap<i64, ShareState> = HashMap::new();
        self.refused.clear();
        let own_dir = crate::config::Config::path()
            .parent()
            .map(|p| p.canonicalize().unwrap_or_else(|_| p.to_path_buf()));
        for assignment in assignments {
            let share_id = assignment.share_id;
            // La racine vient du serveur, qui n'en vérifie que la forme : c'est
            // ici qu'un dossier système, ou un dossier hors de `sync_roots`, se refuse.
            if let Some(reason) =
                paths::root_problem(&assignment.local_path, &self.sync_roots, own_dir.as_deref())
            {
                tracing::error!(share_id, path = %assignment.local_path, %reason, "sync: share root refused");
                self.shares.remove(&share_id);
                self.refused.insert(share_id, reason);
                continue;
            }
            let active = assignment.status == "active";
            let previous = self.shares.remove(&share_id);
            // Le cache de scan est indexé par partage, pas par dossier : le
            // garder après un changement de `local_path` reviendrait à faire
            // confiance aux hashes de l'ANCIEN dossier pour le nouveau (même
            // chemin relatif, même taille, même mtime = hash réutilisé à tort).
            if previous
                .as_ref()
                .is_some_and(|s| s.assignment.local_path != assignment.local_path)
            {
                index_cache::IndexCache::remove(share_id);
                self.applier.invalidate_cache(share_id);
            }
            // La marque de propreté ne survit qu'à une assignation identique,
            // exclusions comprises : le cache de l'agent a été produit sous les
            // anciennes, donc son empreinte décrit un jeu d'entrées que le serveur
            // ne calcule plus pareil. C'est ici, et pas dans le hachage, que se
            // fait cette invalidation (voir `fingerprint.rs`). Le cas identique
            // compte : `notifyConfigChanged` re-pousse la config à chaque attache.
            let same_shape = previous.as_ref().is_some_and(|s| {
                s.assignment.local_path == assignment.local_path
                    && s.assignment.exclusions.len() == assignment.exclusions.len()
                    && s.assignment
                        .exclusions
                        .iter()
                        .zip(assignment.exclusions.iter())
                        .all(|(a, b)| a.kind == b.kind && a.pattern == b.pattern)
            });
            let unchanged = previous.filter(|s| {
                s.assignment.local_path == assignment.local_path && (s._watcher.is_some()) == active
            });
            let (watcher, events, clean) = match unchanged {
                Some(prev) => {
                    // Watcher conservé tel quel : son compteur continue de courir,
                    // donc la marque garde son sens.
                    let events = prev.events;
                    let clean = if same_shape {
                        prev.clean
                    } else {
                        Arc::new(Mutex::new(CleanMark::default()))
                    };
                    (prev._watcher, events, clean)
                }
                None if active => {
                    match watcher::start(
                        share_id,
                        PathBuf::from(&assignment.local_path),
                        self.tx.clone(),
                    ) {
                        Ok(w) => {
                            let events = w.events();
                            // Watcher tout neuf : son compteur repart de zéro, et
                            // rien ne dit ce qui a bougé avant lui. `epoch: None`.
                            (
                                Some(w),
                                Some(events),
                                Arc::new(Mutex::new(CleanMark::default())),
                            )
                        }
                        Err(e) => {
                            warn!(share_id, error = %e, "sync: watcher start failed (periodic scans still cover)");
                            (None, None, Arc::new(Mutex::new(CleanMark::default())))
                        }
                    }
                }
                None => (None, None, Arc::new(Mutex::new(CleanMark::default()))),
            };
            next.insert(
                share_id,
                ShareState {
                    assignment,
                    _watcher: watcher,
                    events,
                    clean,
                },
            );
        }
        // Ce qui reste dans self.shares a été détaché : watchers droppés ici,
        // et leur cache de scan n'a plus de raison d'être.
        for share_id in self.shares.keys() {
            index_cache::IndexCache::remove(*share_id);
            self.applier.invalidate_cache(*share_id);
        }
        info!(count = next.len(), "sync: config applied");
        self.shares = next;
    }

    fn assignment(&self, share_id: i64) -> Option<&SyncShareAssignment> {
        self.shares.get(&share_id).map(|s| &s.assignment)
    }

    /// Scan d'un partage ; partage inconnu/en pause → lot d'erreur.
    ///
    /// `mode` vient du serveur. En `auto`, un partage que le watcher sait intact
    /// depuis son dernier scan répond immédiatement par la seule empreinte de ce
    /// qu'il détient ; le serveur la compare à sa baseline, et une réponse rapide
    /// fausse coûte au pire un scan complet de plus. En `full` (filet de sécurité
    /// horaire), le parcours est obligatoire : un événement de watcher raté ne
    /// peut jamais laisser deux appareils divergents indéfiniment.
    ///
    /// `&mut` : le scan réécrit le cache d'index sur disque, donc la copie
    /// mémorisée par l'applier doit être oubliée.
    pub fn start_scan(&mut self, session_id: String, share_id: i64, mode: Option<String>) {
        let full = mode.as_deref() != Some("auto");
        // La réponse rapide ne touche pas au cache d'index : l'applier peut
        // garder le sien, puisque rien ne sera réécrit.
        if !full {
            if let Some(fp) = self.clean_fingerprint(share_id) {
                let _ = self.tx.try_send(SyncEvent::Index {
                    session_id,
                    share_id,
                    entries: Vec::new(),
                    done: true,
                    scanned: false,
                    fingerprint: Some(fp),
                    error: None,
                });
                return;
            }
        }
        self.applier.invalidate_cache(share_id);
        match self.shares.get(&share_id) {
            Some(s) if s.assignment.status == "active" => {
                scanner::spawn_scan(
                    session_id,
                    s.assignment.clone(),
                    self.tx.clone(),
                    s.events.clone(),
                    Arc::clone(&s.clean),
                );
            }
            _ => {
                let _ = self.tx.try_send(SyncEvent::Index {
                    session_id,
                    share_id,
                    entries: Vec::new(),
                    done: true,
                    scanned: true,
                    fingerprint: None,
                    error: Some(match self.refused.get(&share_id) {
                        Some(reason) => format!("Partage refusé par cette machine : {reason}"),
                        None => "Partage inconnu ou en pause sur cet appareil".to_string(),
                    }),
                });
            }
        }
    }

    /// L'empreinte d'un partage encore propre, ou `None` s'il faut re-scanner.
    ///
    /// Propre = le compteur d'événements du watcher n'a pas bougé d'un cran
    /// depuis la fin du dernier scan complet. Sans watcher, jamais propre : rien
    /// ne pourrait plus invalider la marque.
    fn clean_fingerprint(&self, share_id: i64) -> Option<String> {
        let state = self.shares.get(&share_id)?;
        if state.assignment.status != "active" {
            return None;
        }
        let now = state.events.as_ref()?.load(Ordering::Relaxed);
        let mark = state.clean.lock().expect("clean lock");
        (mark.epoch == Some(now)).then(|| mark.fingerprint.clone())
    }

    /// Force un parcours complet au prochain scan de TOUS les partages.
    ///
    /// Appelé à la sortie de veille : rien ne garantit qu'une surveillance
    /// inotify / FSEvents / ReadDirectoryChangesW ait survécu à la suspension de
    /// la machine, et un scan complet de trop ne coûte que du temps.
    pub fn mark_all_dirty(&self) {
        for state in self.shares.values() {
            state.clean.lock().expect("clean lock").epoch = None;
        }
    }

    /// Upload d'un fichier local (thread dédié). `start_offset` reprend un
    /// transfert coupé : le serveur a gardé un partiel et ne redemande que la
    /// suite. Le plafond de débit vient de la config du partage.
    /// `window` caps the unacknowledged data frames (`None`: stream freely).
    pub fn start_push(
        &self,
        op_id: String,
        share_id: i64,
        rel_path: String,
        start_offset: u64,
        window: Option<u32>,
    ) {
        match self.assignment(share_id) {
            Some(a) => {
                let window = window
                    .map(|w| PushWindow::register(&self.push_credits, &op_id, w, PUSH_ACK_TIMEOUT));
                transfer::spawn_push(
                    op_id,
                    PathBuf::from(&a.local_path),
                    rel_path,
                    start_offset,
                    a.rate_up_bps,
                    window,
                    self.tx.clone(),
                )
            }
            None => {
                let _ = self.tx.try_send(SyncEvent::Chunk {
                    op_id,
                    data: Vec::new(),
                    done: true,
                    hash: None,
                    size: None,
                    mtime: None,
                    error: Some(self.unknown_reason(share_id)),
                    seq: window.map(|_| 0),
                });
            }
        }
    }

    /// One credit back for a windowed push. An unknown op (already over) is ignored.
    pub fn push_ack(&self, op_id: &str, seq: u64) {
        let credit = self
            .push_credits
            .lock()
            .expect("push credits lock")
            .get(op_id)
            .cloned();
        if let Some(credit) = credit {
            credit.ack(seq);
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
        mode: Option<u32>,
        resume_from: u64,
    ) -> Vec<SyncEvent> {
        let Some(assignment) = self.assignment(share_id).cloned() else {
            return vec![SyncEvent::OpResult {
                op_id: op_id.to_string(),
                op: "apply",
                ok: false,
                resume_from: None,
                error: Some(self.unknown_reason(share_id)),
            }];
        };
        let root = PathBuf::from(&assignment.local_path);
        match self.applier.apply_chunk(
            op_id,
            share_id,
            &root,
            rel_path,
            seq,
            data,
            done,
            hash,
            size,
            mtime,
            mode,
            resume_from,
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
                    resume_from: None,
                    error: None,
                },
            ],
            ApplyOutcome::Failed { error } => vec![SyncEvent::OpResult {
                op_id: op_id.to_string(),
                op: "apply",
                ok: false,
                resume_from: None,
                error: Some(error),
            }],
        }
    }

    /// Amorce d'un download : dit au serveur combien d'octets de clair on
    /// détient déjà pour ce hash, pour qu'il ne renvoie que la suite.
    pub fn apply_start(&self, op_id: &str, share_id: i64, hash: &str) -> SyncEvent {
        let held = match self.assignment(share_id) {
            Some(a) => transfer::held_bytes_for(&PathBuf::from(&a.local_path), hash),
            None => 0,
        };
        SyncEvent::OpResult {
            op_id: op_id.to_string(),
            op: "applyReady",
            ok: true,
            resume_from: Some(held),
            error: None,
        }
    }

    /// Création d'un dossier vide (ou ajustement de son mode) : aucun transfert.
    pub fn apply_dir(
        &self,
        op_id: &str,
        share_id: i64,
        rel_path: &str,
        kind: &str,
        mode: Option<u32>,
    ) -> SyncEvent {
        let outcome = match self.assignment(share_id) {
            Some(a) => transfer::apply_dir(&PathBuf::from(&a.local_path), rel_path, kind, mode)
                .map_err(|e| e.to_string()),
            None => Err(self.unknown_reason(share_id)),
        };
        SyncEvent::OpResult {
            op_id: op_id.to_string(),
            op: "applyDir",
            ok: outcome.is_ok(),
            resume_from: None,
            error: outcome.err(),
        }
    }

    /// Installation par copie locale d'un contenu déjà présent dans le partage
    /// (renommage/déplacement). Un échec n'est pas grave : le serveur retombe
    /// sur le téléchargement chunké normal.
    #[allow(clippy::too_many_arguments)]
    pub fn apply_local(
        &self,
        op_id: &str,
        share_id: i64,
        rel_path: &str,
        source_rel_path: &str,
        hash: &str,
        size: u64,
        mtime: i64,
        mode: Option<u32>,
    ) -> SyncEvent {
        let outcome = match self.assignment(share_id) {
            Some(a) => transfer::apply_local(
                &PathBuf::from(&a.local_path),
                rel_path,
                source_rel_path,
                hash,
                size,
                mtime,
                mode,
            )
            .map_err(|e| e.to_string()),
            None => Err(self.unknown_reason(share_id)),
        };
        SyncEvent::OpResult {
            op_id: op_id.to_string(),
            op: "applyLocal",
            ok: outcome.is_ok(),
            resume_from: None,
            error: outcome.err(),
        }
    }

    /// Déplacement propagé : renommage sur place, sans corbeille ni transfert.
    #[allow(clippy::too_many_arguments)]
    pub fn move_file(
        &self,
        op_id: &str,
        share_id: i64,
        from_rel_path: &str,
        rel_path: &str,
        hash: &str,
        size: u64,
        mtime: i64,
        mode: Option<u32>,
    ) -> SyncEvent {
        let outcome = match self.assignment(share_id) {
            Some(a) => transfer::move_file(
                &PathBuf::from(&a.local_path),
                from_rel_path,
                rel_path,
                hash,
                size,
                mtime,
                mode,
            )
            .map_err(|e| e.to_string()),
            None => Err(self.unknown_reason(share_id)),
        };
        SyncEvent::OpResult {
            op_id: op_id.to_string(),
            op: "move",
            ok: outcome.is_ok(),
            resume_from: None,
            error: outcome.err(),
        }
    }

    /// Suppression propagée : corbeille locale, puis `sync.opResult`.
    pub fn delete(&self, op_id: &str, share_id: i64, rel_path: &str) -> SyncEvent {
        let outcome = match self.assignment(share_id) {
            Some(a) => transfer::delete_to_trash(&PathBuf::from(&a.local_path), rel_path)
                .map_err(|e| e.to_string()),
            None => Err(self.unknown_reason(share_id)),
        };
        SyncEvent::OpResult {
            op_id: op_id.to_string(),
            op: "delete",
            ok: outcome.is_ok(),
            resume_from: None,
            error: outcome.err(),
        }
    }
}

impl Drop for SyncManager {
    fn drop(&mut self) {
        // Fin de session : les temporaires d'installs en cours sont nettoyés
        // (les watchers, eux, s'arrêtent via leur propre Drop).
        self.applier.abort_all();
        // Pushes waiting for a credit would otherwise sit out the full timeout.
        for credit in self
            .push_credits
            .lock()
            .expect("push credits lock")
            .values()
        {
            credit.close();
        }
    }
}
