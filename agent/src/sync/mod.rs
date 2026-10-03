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
use std::time::{Duration, Instant};

use anyhow::{bail, Result};
use tokio::sync::mpsc::error::TrySendError;
use tokio::sync::mpsc::Sender;
use tracing::{debug, info, warn};

use crate::protocol::{SyncIndexEntry, SyncShareAssignment};
pub use transfer::ApplyFrame;
use transfer::{PushCredits, PushWindow, SharedCaches, PUSH_ACK_TIMEOUT};
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
    /// | `delete` | `move` | `push`).
    OpResult {
        op_id: String,
        op: &'static str,
        ok: bool,
        /// `applyReady` seulement : octets de clair déjà détenus.
        resume_from: Option<u64>,
        error: Option<String>,
    },
    /// Still working on `op_id` locally (a scan uses its session id).
    Busy { op_id: String },
}

/// The whole cause chain of an error, outermost first, for a message the server
/// shows as is: anyhow's `{}` keeps only the outer context, and "installation"
/// alone says nothing of the locked file or the full disk behind it.
pub fn error_text(e: &anyhow::Error) -> String {
    e.chain()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(" : ")
}

/// Period of the `sync.busy` frames during long local work.
pub const BUSY_EVERY: Duration = Duration::from_secs(15);

/// Keeps the server waiting during long local work (re-reading a partial,
/// hashing a large file): it drops an op silent for 60 s.
pub struct Keepalive {
    tx: Sender<SyncEvent>,
    op_id: String,
    period: Duration,
    last: Instant,
}

impl Keepalive {
    pub fn new(tx: Sender<SyncEvent>, op_id: &str) -> Self {
        Self::with_period(tx, op_id, BUSY_EVERY)
    }

    pub fn with_period(tx: Sender<SyncEvent>, op_id: &str, period: Duration) -> Self {
        Self {
            tx,
            op_id: op_id.to_string(),
            period,
            last: Instant::now(),
        }
    }

    /// Once per block read. `Err` means the session is gone: stop the work and
    /// touch nothing. A full channel proves the loop is alive; the frame is
    /// retried on the next block.
    pub fn tick(&mut self) -> Result<()> {
        if self.last.elapsed() < self.period {
            return Ok(());
        }
        match self.tx.try_send(SyncEvent::Busy {
            op_id: self.op_id.clone(),
        }) {
            Ok(()) => {
                self.last = Instant::now();
                Ok(())
            }
            Err(TrySendError::Full(_)) => Ok(()),
            Err(TrySendError::Closed(_)) => bail!("session terminée"),
        }
    }
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
/// arrête les watchers et les travailleurs de téléchargement (leurs partiels
/// restent, pour la reprise) ; le serveur re-pousse `sync.config` à la
/// reconnexion.
pub struct SyncManager {
    tx: Sender<SyncEvent>,
    shares: HashMap<i64, ShareState>,
    /// One worker per download in progress, by op id; dropping the sender ends it.
    applies: HashMap<String, Sender<ApplyFrame>>,
    /// Index caches shared with the workers (freshness guard at install).
    caches: SharedCaches,
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
            applies: HashMap::new(),
            caches: SharedCaches::default(),
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
                transfer::invalidate_cache(&self.caches, share_id);
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
                    let root = PathBuf::from(&assignment.local_path);
                    // A root gone missing under a share already scanned is never
                    // recreated empty: no watcher, and the scan will say why.
                    let started =
                        scanner::ensure_root(&root, &index_cache::IndexCache::load(share_id))
                            .and_then(|()| watcher::start(share_id, root, self.tx.clone()));
                    match started {
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
            transfer::invalidate_cache(&self.caches, *share_id);
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
    /// mémorisée pour les installations doit être oubliée.
    pub fn start_scan(&mut self, session_id: String, share_id: i64, mode: Option<String>) {
        let full = mode.as_deref() != Some("auto");
        // La réponse rapide ne touche pas au cache d'index : les installations
        // peuvent garder le leur, puisque rien ne sera réécrit.
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
        transfer::invalidate_cache(&self.caches, share_id);
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

    /// Routes one download frame to its op's worker thread; acks and the
    /// outcome come back through the channel. `Some` is an immediate refusal.
    pub fn apply_chunk(&mut self, frame: ApplyFrame, share_id: i64) -> Option<SyncEvent> {
        if !self.applies.contains_key(&frame.op_id) {
            // A late frame of an op this side already failed, or from before a
            // reconnection: no worker will ever want it.
            if frame.seq != 0 {
                return Some(apply_refused(
                    &frame.op_id,
                    format!("premier chunk inattendu (seq {})", frame.seq),
                ));
            }
            let Some(root) = self.root_of(share_id) else {
                return Some(apply_refused(&frame.op_id, self.unknown_reason(share_id)));
            };
            self.applies.retain(|_, worker| !worker.is_closed());
            if self.applies.len() >= transfer::MAX_APPLY_OPS {
                return Some(apply_refused(
                    &frame.op_id,
                    "trop de téléchargements en cours".to_string(),
                ));
            }
            let (worker, frames) = tokio::sync::mpsc::channel(transfer::APPLY_QUEUE);
            transfer::spawn_apply(
                frame.op_id.clone(),
                share_id,
                root,
                Arc::clone(&self.caches),
                frames,
                self.tx.clone(),
            );
            self.applies.insert(frame.op_id.clone(), worker);
        }
        let op_id = frame.op_id.clone();
        let done = frame.done;
        let worker = self.applies.get(&op_id).expect("inserted above");
        match worker.try_send(frame) {
            Ok(()) => {
                if done {
                    self.applies.remove(&op_id);
                }
                None
            }
            // The worker already reported its failure and left.
            Err(TrySendError::Closed(_)) => {
                self.applies.remove(&op_id);
                debug!(op_id, "sync: frame for a finished download dropped");
                None
            }
            // The server never has more than its window in flight: a full
            // queue is a protocol violation, not backpressure.
            Err(TrySendError::Full(_)) => {
                self.applies.remove(&op_id);
                Some(apply_refused(
                    &op_id,
                    "chunks reçus plus vite que leur file ne les accepte".to_string(),
                ))
            }
        }
    }

    fn root_of(&self, share_id: i64) -> Option<PathBuf> {
        self.assignment(share_id)
            .map(|a| PathBuf::from(&a.local_path))
    }

    /// The outcome of an op refused for a share this machine does not serve.
    fn refuse(&self, op_id: &str, op: &'static str, share_id: i64) {
        let _ = self.tx.try_send(SyncEvent::OpResult {
            op_id: op_id.to_string(),
            op,
            ok: false,
            resume_from: None,
            error: Some(self.unknown_reason(share_id)),
        });
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
                .map_err(|e| error_text(&e)),
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
    /// (renommage/déplacement), sur son propre thread : la source est hachée
    /// d'abord, ce qui peut être long. L'issue revient par le canal. Un échec
    /// n'est pas grave : le serveur retombe sur le téléchargement chunké normal.
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
    ) {
        let Some(root) = self.root_of(share_id) else {
            self.refuse(op_id, "applyLocal", share_id);
            return;
        };
        let caches = Arc::clone(&self.caches);
        let (rel_path, source_rel_path, hash) = (
            rel_path.to_string(),
            source_rel_path.to_string(),
            hash.to_string(),
        );
        transfer::spawn_local_op(
            op_id.to_string(),
            "applyLocal",
            self.tx.clone(),
            move |keepalive| {
                transfer::apply_local(
                    &root,
                    share_id,
                    &caches,
                    &rel_path,
                    &source_rel_path,
                    &hash,
                    size,
                    mtime,
                    mode,
                    keepalive,
                )
            },
        );
    }

    /// Déplacement propagé : renommage sur place, sans corbeille ni transfert,
    /// sur son propre thread (la source est hachée d'abord).
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
    ) {
        let Some(root) = self.root_of(share_id) else {
            self.refuse(op_id, "move", share_id);
            return;
        };
        let (from_rel_path, rel_path, hash) = (
            from_rel_path.to_string(),
            rel_path.to_string(),
            hash.to_string(),
        );
        transfer::spawn_local_op(
            op_id.to_string(),
            "move",
            self.tx.clone(),
            move |keepalive| {
                transfer::move_file(
                    &root,
                    &from_rel_path,
                    &rel_path,
                    &hash,
                    size,
                    mtime,
                    mode,
                    keepalive,
                )
            },
        );
    }

    /// Suppression propagée : corbeille locale, puis `sync.opResult`.
    pub fn delete(&self, op_id: &str, share_id: i64, rel_path: &str) {
        let Some(root) = self.root_of(share_id) else {
            self.refuse(op_id, "delete", share_id);
            return;
        };
        let (caches, rel_path) = (Arc::clone(&self.caches), rel_path.to_string());
        // Its own thread: the rename may wait on a locked target.
        transfer::spawn_local_op(op_id.to_string(), "delete", self.tx.clone(), move |_| {
            transfer::delete_to_trash(&root, share_id, &caches, &rel_path)
        });
    }
}

/// The `apply` outcome of a frame refused before any worker took it.
fn apply_refused(op_id: &str, error: String) -> SyncEvent {
    SyncEvent::OpResult {
        op_id: op_id.to_string(),
        op: "apply",
        ok: false,
        resume_from: None,
        error: Some(error),
    }
}

impl Drop for SyncManager {
    fn drop(&mut self) {
        // End of session: dropping the senders ends the download workers once
        // their queued frames are written; partials stay for a later resume
        // (the watchers stop through their own Drop).
        self.applies.clear();
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

#[cfg(test)]
mod tests {
    use super::*;

    fn manager() -> (SyncManager, tokio::sync::mpsc::Receiver<SyncEvent>) {
        let (tx, rx) = tokio::sync::mpsc::channel(8);
        (SyncManager::new(tx, Vec::new()), rx)
    }

    fn frame(seq: u64) -> ApplyFrame {
        ApplyFrame {
            op_id: "op".into(),
            rel_path: "a".into(),
            seq,
            data: String::new(),
            done: false,
            expected_hash: "0".repeat(64),
            expected_size: 1,
            mtime: 0,
            mode: None,
            resume_from: 0,
        }
    }

    fn refusal(ev: Option<SyncEvent>) -> String {
        match ev {
            Some(SyncEvent::OpResult {
                ok: false,
                error: Some(error),
                ..
            }) => error,
            _ => panic!("expected an immediate refusal"),
        }
    }

    #[test]
    fn a_first_frame_out_of_order_is_refused_without_a_worker() {
        let (mut mgr, _rx) = manager();
        assert!(refusal(mgr.apply_chunk(frame(3), 1)).contains("inattendu"));
        assert!(mgr.applies.is_empty());
    }

    #[test]
    fn a_frame_for_an_unknown_share_is_refused_without_a_worker() {
        let (mut mgr, _rx) = manager();
        assert!(refusal(mgr.apply_chunk(frame(0), 1)).contains("inconnu"));
        assert!(mgr.applies.is_empty());
    }
}
