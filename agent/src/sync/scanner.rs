//! Scan d'un partage : parcours itératif, exclusions, hashing SHA-256
//! incrémental (cache size+mtime), lots d'index envoyés à la boucle. Complet,
//! il décrit tout le dossier ; partiel (`delta_scan`), il ne relit que les
//! dossiers où le watcher a vu bouger quelque chose et n'envoie que la
//! différence, avec l'empreinte de l'ensemble pour que le serveur la recoupe.
//! Seuls les fichiers réguliers sont indexés, et tout ce qui ne peut pas
//! l'être (illisible, nom non portable, lien, fichier spécial, nom non UTF-8)
//! est déclaré écarté, jamais tu : le serveur n'en déduit pas une suppression.

use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

use anyhow::{bail, Context, Result};
use tokio::sync::mpsc::Sender;
use tracing::debug;

use crate::exclusions::CompiledExclusions;
use crate::protocol::{SyncIndexEntry, SyncShareAssignment, SyncSkipReason};
use crate::sync::e2e::{ContentHasher, ShareKeys};
use crate::sync::fingerprint::{Fingerprint, FingerprintEntry};
use crate::sync::index_cache::{CacheEntry, IndexCache};
use crate::sync::paths::{
    is_reserved_top, rel_path_lossy, rel_path_of, rel_path_problem, REL_PATH_MAX_BYTES,
};
use crate::sync::transfer::{sweep_partials, sweep_trash, PARTIAL_KEEP_DAYS};
use crate::sync::watcher::Touched;
use crate::sync::{CleanMark, Keepalive, SyncEvent};

/// Taille des lots `sync.index` (miroir de `SYNC_INDEX_BATCH_MAX`).
const BATCH: usize = 500;
/// Garde-fou : au-delà, le scan est abandonné (dossier manifestement hors sujet).
const SCAN_BUDGET: usize = 2_000_000;
/// En deçà de cet âge, un fichier est TOUJOURS re-hashé, cache ou pas.
///
/// Le cache s'appuie sur (taille, mtime). Or la granularité du mtime n'est pas
/// la milliseconde partout : 1 s sur HFS+, 2 s sur FAT/exFAT. Deux écritures de
/// même taille dans la même seconde y sont donc rigoureusement indiscernables,
/// et sans ce garde-fou la seconde ne serait JAMAIS synchronisée — le cache se
/// croirait à jour indéfiniment.
const RECENT_MS: i64 = 3_000;
/// SHA-256 du contenu vide : le hash conventionnel porté par une entrée `dir`.
/// Miroir de `SYNC_DIR_HASH` (DevEye-Types/src/domain/cloudSync.ts).
const SYNC_DIR_HASH: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

fn mtime_millis(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Les bits de permission Unix, ou `None` sous Windows (qui n'en a pas).
/// Le serveur traite ce `None` comme « je ne sais pas » et CONSERVE le mode
/// déjà connu : sans ça, un aller-retour par une machine Windows effacerait le
/// bit exécutable d'un script pour toute la flotte.
#[cfg(unix)]
fn unix_mode(meta: &std::fs::Metadata) -> Option<u32> {
    use std::os::unix::fs::PermissionsExt;
    Some(meta.permissions().mode() & 0o777)
}

#[cfg(not(unix))]
fn unix_mode(_meta: &std::fs::Metadata) -> Option<u32> {
    None
}

/// Bytes per read while hashing.
const HASH_CHUNK: usize = 256 * 1024;

/// Streamed content name (hex) of a file, never loaded whole in memory: its
/// SHA-256, or its HMAC under the keys of an encrypted share. `keepalive`
/// ticks once per block, so a large file does not look like silence.
pub fn hash_file(
    path: &std::path::Path,
    keys: Option<&ShareKeys>,
    mut keepalive: Option<&mut Keepalive>,
) -> Result<String> {
    let mut file =
        std::fs::File::open(path).with_context(|| format!("ouverture de {}", path.display()))?;
    let mut hasher = ContentHasher::new(keys);
    let mut buf = vec![0u8; HASH_CHUNK];
    loop {
        let n = file
            .read(&mut buf)
            .with_context(|| format!("lecture de {}", path.display()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        if let Some(k) = keepalive.as_deref_mut() {
            k.tick()?;
        }
    }
    Ok(hasher.finish())
}

/// Ce que `SyncManager::start_scan` demande au scan.
pub struct ScanRequest {
    /// `false` : le serveur accepte un scan partiel (mode `delta`).
    pub full: bool,
    /// L'empreinte que le serveur tient pour cet appareil : un parcours complet
    /// qui la retrouve n'envoie aucune entrée.
    pub expected: Option<String>,
    /// Ce que le watcher a vu bouger, `None` sans watcher prêt.
    pub touched: Option<Arc<Mutex<Touched>>>,
}

/// Au-delà, les dossiers à relister coûteraient plus que tout parcourir.
const DELTA_MAX_PATHS: usize = 2_000;

/// Lance le scan sur un thread dédié (I/O + hashing intensifs, hors runtime).
///
/// `clean` est la marque de propreté du partage : le scan la POSE en fin de
/// course, avec l'empreinte de ce qu'il vient de produire et l'époque du
/// compteur d'événements relevée AVANT le parcours. Prendre l'époque avant, et
/// vérifier après qu'elle n'a pas bougé, est ce qui interdit de marquer propre un
/// partage modifié pendant le scan. La liste des chemins touchés suit la même
/// règle : prise entière avant le parcours, ce qui bouge pendant reste noté.
pub fn spawn_scan(
    session_id: String,
    assignment: SyncShareAssignment,
    keys: Option<Arc<ShareKeys>>,
    tx: Sender<SyncEvent>,
    events: Option<Arc<AtomicU64>>,
    clean: Arc<Mutex<CleanMark>>,
    request: ScanRequest,
) {
    std::thread::spawn(move || {
        let _busy = crate::live_status::begin(crate::live_status::Task::SyncScan);
        let share_id = assignment.share_id;
        let epoch = events.as_ref().map(|e| e.load(Ordering::Relaxed));
        let snapshot = request
            .touched
            .as_ref()
            .map(|t| std::mem::take(&mut *t.lock().expect("touched lock")));
        let partial = snapshot.as_ref().filter(|t| !request.full && t.complete);
        let result = match partial {
            Some(touched) => delta_scan(&session_id, &assignment, keys.as_deref(), touched, &tx),
            None => scan(
                &session_id,
                &assignment,
                keys.as_deref(),
                request.expected.as_deref(),
                &tx,
            ),
        };
        if let Some(t) = &request.touched {
            // Réussi, le cache décrit le disque au relevé près : la liste vaut
            // pour le prochain scan partiel. Échoué, elle ne vaut rien.
            t.lock().expect("touched lock").complete = result.is_ok();
        }
        match result {
            Ok(fingerprint) => {
                // Propre seulement si RIEN n'a bougé pendant le parcours, et
                // jamais sans watcher (`events` à `None`) : rien ne pourrait
                // plus invalider la marque.
                if let (Some(events), Some(epoch)) = (events, epoch) {
                    if events.load(Ordering::Relaxed) == epoch {
                        *clean.lock().expect("clean lock") = CleanMark {
                            epoch: Some(epoch),
                            fingerprint,
                        };
                    }
                }
            }
            Err(e) => {
                let _ = tx.blocking_send(SyncEvent::Index {
                    session_id,
                    share_id,
                    entries: Vec::new(),
                    done: true,
                    scanned: true,
                    fingerprint: None,
                    encrypted: keys.is_some(),
                    delta: false,
                    error: Some(crate::sync::error_text(&e)),
                });
            }
        }
    });
}

/// Where a scan's batches go.
struct Out<'a> {
    tx: &'a Sender<SyncEvent>,
    session_id: &'a str,
    share_id: i64,
    encrypted: bool,
}

impl Out<'_> {
    fn send(
        &self,
        entries: Vec<SyncIndexEntry>,
        done: bool,
        scanned: bool,
        delta: bool,
        fingerprint: Option<String>,
    ) -> Result<()> {
        self.tx
            .blocking_send(SyncEvent::Index {
                session_id: self.session_id.to_string(),
                share_id: self.share_id,
                entries,
                done,
                scanned,
                fingerprint,
                encrypted: self.encrypted,
                delta,
                error: None,
            })
            .map_err(|_| anyhow::anyhow!("session terminée"))
    }

    /// Sends `lines` in batches of at most `BATCH` (past that, a frame would
    /// exceed `SYNC_INDEX_BATCH_MAX` and the server would refuse it), the last
    /// one carrying `done` and the fingerprint. `scanned`: the whole disk was
    /// walked; `delta`: the lines are a difference, not the index.
    fn send_all(
        &self,
        lines: impl IntoIterator<Item = SyncIndexEntry>,
        scanned: bool,
        delta: bool,
        fingerprint: String,
    ) -> Result<()> {
        let mut batch = Vec::with_capacity(BATCH);
        for line in lines {
            batch.push(line);
            if batch.len() == BATCH {
                let full = std::mem::replace(&mut batch, Vec::with_capacity(BATCH));
                self.send(full, false, scanned, delta, None)?;
            }
        }
        self.send(batch, true, scanned, delta, Some(fingerprint))
    }
}

fn entry_line(rel_path: &str, e: &CacheEntry) -> SyncIndexEntry {
    SyncIndexEntry {
        rel_path: rel_path.to_string(),
        kind: e.kind.clone(),
        hash: e.hash.clone(),
        size: e.size,
        mtime: e.mtime,
        mode: e.mode,
        reason: None,
    }
}

/// Opens a share for a walk: its cache (emptied when hashed under another
/// naming key), and its root, which must be there.
fn open(
    assignment: &SyncShareAssignment,
    keys: Option<&ShareKeys>,
) -> Result<(PathBuf, IndexCache)> {
    let root = PathBuf::from(&assignment.local_path);
    let mut cache = IndexCache::load(assignment.share_id);
    ensure_root(&root, &cache)?;
    // Hashes computed under another naming key name nothing this share holds.
    let scheme = keys.map(ShareKeys::scheme).unwrap_or_default();
    if cache.scheme != scheme {
        cache.entries.clear();
    }
    cache.scheme = scheme;
    Ok((root, cache))
}

fn scan(
    session_id: &str,
    assignment: &SyncShareAssignment,
    keys: Option<&ShareKeys>,
    expected: Option<&str>,
    tx: &Sender<SyncEvent>,
) -> Result<String> {
    let (root, cache) = open(assignment, keys)?;

    // Entretien opportuniste : la corbeille locale est balayée ici, selon la
    // rétention réglée sur le partage (30 jours par défaut), et avec elle les
    // partiels de téléchargement que plus personne ne reprend.
    sweep_trash(&root, assignment.trash_keep_days);
    sweep_partials(&root, PARTIAL_KEEP_DAYS);

    let (fingerprint, fresh) = walk(session_id, assignment, keys, &root, &cache, expected, tx)?;
    fresh.save(assignment.share_id);
    Ok(fingerprint)
}

/// A root that vanished under a share already scanned is a detached volume or
/// a moved folder: recreating it empty would read as "everything deleted". The
/// first scan (empty cache) creates it, owned like its parent.
pub fn ensure_root(root: &Path, cache: &IndexCache) -> Result<()> {
    if root.is_dir() {
        return Ok(());
    }
    if !cache.entries.is_empty() {
        bail!("dossier du partage introuvable : volume débranché ou dossier déplacé ?");
    }
    crate::ownership::create_dir_all_owned(root)
        .with_context(|| format!("création de {}", root.display()))
}

/// A skipped path is only a name on the wire: longer than the protocol allows, it is cut.
fn truncate_rel_path(mut rel: String) -> String {
    if rel.len() > REL_PATH_MAX_BYTES {
        let mut cut = REL_PATH_MAX_BYTES;
        while !rel.is_char_boundary(cut) {
            cut -= 1;
        }
        rel.truncate(cut);
    }
    rel
}

/// Declares a path the scan could not index: the server treats it, and
/// anything under it, as unknown, never as deleted.
fn skip(lines: &mut Vec<SyncIndexEntry>, rel: String, reason: SyncSkipReason) {
    debug!(rel_path = %rel, ?reason, "sync scan: path skipped");
    lines.push(SyncIndexEntry::skipped(truncate_rel_path(rel), reason));
}

/// The walk itself. Everything the share holds goes out, indexed or skipped,
/// and the fresh cache describes exactly what was emitted. With `expected`
/// equal to the fingerprint found, nothing but the skipped paths goes out:
/// the server holds the rest.
fn walk(
    session_id: &str,
    assignment: &SyncShareAssignment,
    keys: Option<&ShareKeys>,
    root: &Path,
    cache: &IndexCache,
    expected: Option<&str>,
    tx: &Sender<SyncEvent>,
) -> Result<(String, IndexCache)> {
    let out = Out {
        tx,
        session_id,
        share_id: assignment.share_id,
        encrypted: keys.is_some(),
    };
    let mut keepalive = Keepalive::new(tx.clone(), session_id);
    let excluded = CompiledExclusions::compile(&assignment.exclusions);
    let mut fresh = IndexCache {
        root: root.to_string_lossy().into_owned(),
        scheme: cache.scheme.clone(),
        ..IndexCache::default()
    };
    let mut lines = Vec::new();
    let mut walker = Walker::new(root, cache, keys, &excluded, &mut keepalive, &|_| true);
    walker.walk(root.to_path_buf(), &mut fresh, &mut lines)?;

    // L'empreinte se calcule sur `fresh`, c'est-à-dire sur EXACTEMENT ce que ce
    // scan décrit au serveur. La calculer ailleurs (sur le cache chargé, sur le
    // disque relu) la ferait décrire autre chose que ce qu'il a reçu.
    let fingerprint = fingerprint_of(&fresh);
    if expected == Some(fingerprint.as_str()) {
        out.send_all(lines, true, true, fingerprint.clone())?;
    } else {
        let entries = fresh.entries.iter().map(|(rel, e)| entry_line(rel, e));
        out.send_all(entries.chain(lines), true, false, fingerprint.clone())?;
    }
    Ok((fingerprint, fresh))
}

/// Le dossier parent d'un chemin relatif, `""` pour la racine du partage.
fn parent_rel(rel: &str) -> &str {
    rel.rsplit_once('/').map(|(parent, _)| parent).unwrap_or("")
}

/// Les dossiers qui mènent à `rel` (`a/b/c` → `a`, `a/b`), sans `rel` ni la racine.
fn ancestors(rel: &str) -> impl Iterator<Item = &str> {
    rel.match_indices('/').map(move |(at, _)| &rel[..at])
}

/// Un parcours partiel : seuls les dossiers où le watcher a vu bouger quelque
/// chose sont relus, le reste du cache est tenu pour vrai. Ce qui en sort est
/// la différence avec le cache (entrées changées, chemins `gone`) et
/// l'empreinte de l'index entier, que le serveur recoupe avant d'y croire.
///
/// Relire un dossier entier, et non le seul chemin touché, est ce qui tient
/// la règle des dossiers vides (un fichier de plus ou de moins change le
/// statut du parent) et rattrape un sous-dossier apparu sans événement : un
/// sous-dossier que le cache ne connaît pas est parcouru, un sous-dossier
/// connu garde ses entrées tant qu'un chemin touché ne le désigne pas.
fn delta_scan(
    session_id: &str,
    assignment: &SyncShareAssignment,
    keys: Option<&ShareKeys>,
    touched: &Touched,
    tx: &Sender<SyncEvent>,
) -> Result<String> {
    let (root, cache) = open(assignment, keys)?;
    if cache.entries.is_empty() || touched.paths.len() > DELTA_MAX_PATHS {
        return scan(session_id, assignment, keys, None, tx);
    }
    let (fingerprint, fresh) =
        delta_walk(session_id, assignment, keys, &root, &cache, touched, tx)?;
    fresh.save(assignment.share_id);
    Ok(fingerprint)
}

/// The partial walk itself: `cache` is the last walk's, the fresh cache is
/// what the share holds now.
fn delta_walk(
    session_id: &str,
    assignment: &SyncShareAssignment,
    keys: Option<&ShareKeys>,
    root: &Path,
    cache: &IndexCache,
    touched: &Touched,
    tx: &Sender<SyncEvent>,
) -> Result<(String, IndexCache)> {
    let out = Out {
        tx,
        session_id,
        share_id: assignment.share_id,
        encrypted: keys.is_some(),
    };
    let mut keepalive = Keepalive::new(tx.clone(), session_id);
    let excluded = CompiledExclusions::compile(&assignment.exclusions);

    // Les dossiers qui ont des entrées en cache : on n'y redescend pas depuis
    // un parent relu, leurs propres changements arrivent par leurs chemins.
    let mut known: HashSet<&str> = HashSet::new();
    for rel in cache.entries.keys() {
        known.extend(ancestors(rel));
    }
    let descend = |rel: &str| !known.contains(rel);

    let mut sub = IndexCache {
        root: root.to_string_lossy().into_owned(),
        scheme: cache.scheme.clone(),
        ..IndexCache::default()
    };
    let mut lines = Vec::new();
    let mut walker = Walker::new(root, cache, keys, &excluded, &mut keepalive, &descend);
    // Les sous-dossiers connus qu'un dossier relu ne contient plus : leur
    // arbre entier a disparu, même sans événement sur chacun de ses fichiers.
    let mut vanished: HashSet<String> = HashSet::new();
    let mut queue: Vec<String> = touched
        .paths
        .iter()
        .map(|rel| parent_rel(rel).to_string())
        .collect();
    while let Some(rel) = queue.pop() {
        if walker.listed.contains(&rel) {
            continue;
        }
        let dir = if rel.is_empty() {
            root.to_path_buf()
        } else {
            root.join(&rel)
        };
        let is_dir = std::fs::symlink_metadata(&dir).is_ok_and(|m| m.is_dir());
        if is_dir {
            walker.walk(dir, &mut sub, &mut lines)?;
        } else if rel.is_empty() {
            bail!("dossier du partage introuvable : volume débranché ou dossier déplacé ?");
        } else {
            // Le dossier n'est plus là : son parent est relu à sa place, pour
            // que son absence (et un parent devenu vide) entre dans le cache.
            vanished.insert(rel.clone());
            queue.push(parent_rel(&rel).to_string());
        }
    }
    for dir in &known {
        if walker.listed.contains(parent_rel(dir)) && !walker.seen_dirs.contains(*dir) {
            vanished.insert((*dir).to_string());
        }
    }

    let mut fresh = cache.clone();
    let listed = &walker.listed;
    let mut removed = Vec::new();
    fresh.entries.retain(|rel, _| {
        let stale = listed.contains(parent_rel(rel))
            || listed.contains(rel.as_str())
            || vanished.contains(rel.as_str())
            || ancestors(rel).any(|dir| vanished.contains(dir));
        if stale {
            removed.push(rel.clone());
        }
        !stale
    });
    for (rel, e) in sub.entries {
        if !cache.entries.get(&rel).is_some_and(|c| c.same(&e)) {
            lines.push(entry_line(&rel, &e));
        }
        fresh.entries.insert(rel, e);
    }
    for rel in removed {
        if !fresh.entries.contains_key(&rel) {
            lines.push(SyncIndexEntry::gone(rel));
        }
    }
    let fingerprint = fingerprint_of(&fresh);
    // `scanned: false` : le disque n'a pas été lu en entier, le serveur ne
    // tient pas les chemins écartés pour complets.
    out.send_all(lines, false, true, fingerprint.clone())?;
    Ok((fingerprint, fresh))
}

/// Lists directories, one subtree at a time, filling a cache with what it
/// indexes and a list of lines with what it skips. Hashes are reused from
/// `cache` when size and mtime match.
struct Walker<'a> {
    root: &'a Path,
    cache: &'a IndexCache,
    keys: Option<&'a ShareKeys>,
    excluded: &'a CompiledExclusions,
    keepalive: &'a mut Keepalive,
    /// Whether to list a subdirectory met on the way (relative path).
    descend: &'a dyn Fn(&str) -> bool,
    now_ms: i64,
    walked: usize,
    /// Every directory listed, as relative paths (`""` for the root).
    listed: HashSet<String>,
    /// Every directory met in a listing, descended into or not.
    seen_dirs: HashSet<String>,
}

impl<'a> Walker<'a> {
    fn new(
        root: &'a Path,
        cache: &'a IndexCache,
        keys: Option<&'a ShareKeys>,
        excluded: &'a CompiledExclusions,
        keepalive: &'a mut Keepalive,
        descend: &'a dyn Fn(&str) -> bool,
    ) -> Self {
        let now_ms = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        Self {
            root,
            cache,
            keys,
            excluded,
            keepalive,
            descend,
            now_ms,
            walked: 0,
            listed: HashSet::new(),
            seen_dirs: HashSet::new(),
        }
    }

    /// Walks `start` (the root or a directory under it) and what `descend`
    /// allows beneath it.
    fn walk(
        &mut self,
        start: PathBuf,
        fresh: &mut IndexCache,
        lines: &mut Vec<SyncIndexEntry>,
    ) -> Result<()> {
        let root = self.root;
        let mut stack = vec![start];
        while let Some(dir) = stack.pop() {
            // Un parcours long sans rien envoyer doit rester audible du serveur.
            self.keepalive.tick()?;
            let rel_dir = rel_path_of(root, &dir).unwrap_or_default();
            self.listed.insert(rel_dir.clone());
            let entries = match std::fs::read_dir(&dir) {
                Ok(e) => e,
                Err(e) => {
                    if dir.as_path() == root {
                        bail!("dossier du partage illisible : {e}");
                    }
                    // Its whole subtree is unknown: declared, never read as deleted.
                    if let Some(rel) = rel_path_lossy(root, &dir) {
                        skip(lines, rel, SyncSkipReason::Unreadable);
                    }
                    continue;
                }
            };
            // Un dossier n'est indexé que s'il est VIDE une fois les exclusions
            // appliquées : un dossier peuplé est implicite (ses fichiers le
            // recréent partout). On compte donc ce qui survit au filtrage, chemins
            // écartés compris : un dossier qui n'en contient que ça n'est pas vide.
            let mut kept = 0usize;
            let mut unlisted = false;
            for entry in entries {
                let entry = match entry {
                    Ok(e) => e,
                    Err(_) => {
                        unlisted = true;
                        continue;
                    }
                };
                self.walked += 1;
                if self.walked > SCAN_BUDGET {
                    bail!("scan abandonné : plus de {SCAN_BUDGET} entrées");
                }
                let path = entry.path();
                let Some(rel) = rel_path_of(root, &path) else {
                    // Not valid UTF-8: named lossily, never indexed.
                    if let Some(lossy) = rel_path_lossy(root, &path) {
                        skip(lines, lossy, SyncSkipReason::NonUtf8);
                        kept += 1;
                    }
                    continue;
                };
                // `DirEntry::metadata` ne suit pas les liens : jamais (boucles, évasions).
                let meta = match entry.metadata() {
                    Ok(m) => m,
                    Err(_) => {
                        skip(lines, rel, SyncSkipReason::Unreadable);
                        kept += 1;
                        continue;
                    }
                };
                if meta.is_symlink() {
                    skip(lines, rel, SyncSkipReason::Symlink);
                    kept += 1;
                    continue;
                }
                if meta.is_dir() {
                    let top = rel.split('/').next().unwrap_or("");
                    if is_reserved_top(top) || self.excluded.matches(&rel) {
                        continue; // Excluded on purpose: silent.
                    }
                    if rel_path_problem(&rel).is_some() {
                        // Nothing under it is walked: the whole subtree stays unknown.
                        skip(lines, rel, SyncSkipReason::Unportable);
                        kept += 1;
                        continue;
                    }
                    kept += 1;
                    if (self.descend)(&rel) {
                        stack.push(path);
                    }
                    self.seen_dirs.insert(rel);
                    continue;
                }
                if self.excluded.matches(&rel) {
                    continue;
                }
                if !meta.is_file() {
                    skip(lines, rel, SyncSkipReason::Special);
                    kept += 1;
                    continue;
                }
                // Filtrage à la source : un nom que Windows ne sait pas écrire
                // n'entre jamais dans le partage ; le serveur revalide (défense en
                // profondeur) et journalise ce qu'on lui déclare.
                if rel_path_problem(&rel).is_some() {
                    skip(lines, rel, SyncSkipReason::Unportable);
                    kept += 1;
                    continue;
                }

                let size = meta.len();
                let mtime = mtime_millis(&meta);
                // `now_ms - mtime` : un mtime dans le futur (dérive d'horloge)
                // donne un écart négatif, donc un re-hash. C'est le bon sens.
                let recent = self.now_ms - mtime <= RECENT_MS;
                let hash = match self.cache.entries.get(&rel) {
                    Some(c) if c.size == size && c.mtime == mtime && !recent && !c.rehash => {
                        c.hash.clone()
                    }
                    _ => match hash_file(&path, self.keys, Some(self.keepalive)) {
                        Ok(h) => h,
                        Err(e) => {
                            debug!(path = %path.display(), error = %e, "sync scan: unreadable file");
                            skip(lines, rel, SyncSkipReason::Unreadable);
                            kept += 1;
                            continue;
                        }
                    },
                };
                kept += 1;
                let fresh_entry = CacheEntry {
                    size,
                    mtime,
                    hash,
                    kind: "file".to_string(),
                    mode: unix_mode(&meta),
                    rehash: recent,
                };
                // Deux fichiers distincts qui se normalisent pareil (« café » en
                // NFC et en NFD) : les deux partent, le serveur les écarte tous
                // deux, comme il le ferait de deux lignes de même chemin.
                if let Some(previous) = fresh.entries.insert(rel.clone(), fresh_entry) {
                    lines.push(entry_line(&rel, &previous));
                }
            }
            if unlisted {
                // Entries we could not even list: the directory as a whole is unknown.
                if dir.as_path() == root {
                    bail!("dossier du partage partiellement illisible");
                }
                if let Some(rel) = rel_path_lossy(root, &dir) {
                    skip(lines, rel, SyncSkipReason::Unreadable);
                }
                continue;
            }

            // Rien n'a survécu au filtrage : ce dossier est vide, il mérite sa
            // propre entrée d'index pour exister aussi chez les autres appareils.
            // La racine du partage, elle, n'est pas une entrée (elle existe toujours).
            if kept == 0 && !rel_dir.is_empty() && rel_path_problem(&rel_dir).is_none() {
                let meta = std::fs::symlink_metadata(&dir).ok();
                let mtime = meta.as_ref().map(mtime_millis).unwrap_or(0);
                let mode = meta.as_ref().and_then(unix_mode);
                // Les dossiers vides entrent dans le cache comme les fichiers :
                // l'empreinte se calcule à partir du cache, et un dossier vidé
                // de son dernier fichier doit la déplacer.
                fresh.entries.insert(
                    rel_dir,
                    CacheEntry {
                        size: 0,
                        mtime,
                        hash: SYNC_DIR_HASH.to_string(),
                        kind: "dir".to_string(),
                        mode,
                        rehash: false,
                    },
                );
            }
        }
        Ok(())
    }
}

/// Empreinte d'un cache d'index, dans la forme partagée avec le serveur.
pub fn fingerprint_of(cache: &IndexCache) -> String {
    let mut fp = Fingerprint::default();
    for (rel_path, e) in &cache.entries {
        fp.push(&FingerprintEntry {
            rel_path,
            kind: &e.kind,
            hash: &e.hash,
            size: e.size,
            mode: e.mode,
        });
    }
    fp.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::time::Duration;

    const SHARE: i64 = 987_654;

    fn assignment(root: &Path) -> SyncShareAssignment {
        SyncShareAssignment {
            share_id: SHARE,
            local_path: root.to_string_lossy().into_owned(),
            status: "active".to_string(),
            exclusions: Vec::new(),
            rate_up_bps: None,
            trash_keep_days: 30,
            encryption: None,
        }
    }

    /// Walks `root` against `cache`: the entries sent, the fingerprint, the fresh cache.
    fn run_walk(root: &Path, cache: &IndexCache) -> (Vec<SyncIndexEntry>, String, IndexCache) {
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        let (fingerprint, fresh) =
            walk("scan-1", &assignment(root), None, root, cache, None, &tx).expect("walk");
        drop(tx);
        let mut entries = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            if let SyncEvent::Index { entries: batch, .. } = ev {
                entries.extend(batch);
            }
        }
        (entries, fingerprint, fresh)
    }

    #[cfg(unix)]
    fn skipped<'a>(entries: &'a [SyncIndexEntry], rel: &str) -> &'a SyncIndexEntry {
        entries
            .iter()
            .find(|e| e.rel_path == rel && e.kind == "skipped")
            .unwrap_or_else(|| panic!("{rel} should be declared skipped"))
    }

    #[cfg(unix)]
    fn is_root() -> bool {
        // SAFETY: `geteuid` has no preconditions and cannot fail.
        unsafe { libc::geteuid() == 0 }
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_dir_is_declared_and_its_subtree_unknown() {
        use std::os::unix::fs::PermissionsExt;
        if is_root() {
            return; // Root reads everything: nothing to observe.
        }
        let dir = tempfile::tempdir().unwrap();
        let locked = dir.path().join("locked");
        std::fs::create_dir(&locked).unwrap();
        std::fs::write(locked.join("x.txt"), b"x").unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        let (entries, _, fresh) = run_walk(dir.path(), &IndexCache::default());
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();

        assert_eq!(
            skipped(&entries, "locked").reason,
            Some(SyncSkipReason::Unreadable)
        );
        assert!(entries.iter().all(|e| !e.rel_path.starts_with("locked/")));
        assert!(!entries
            .iter()
            .any(|e| e.rel_path == "locked" && e.kind == "dir"));
        assert!(fresh.entries.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_file_is_declared() {
        use std::os::unix::fs::PermissionsExt;
        if is_root() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let secret = dir.path().join("secret.txt");
        std::fs::write(&secret, b"x").unwrap();
        std::fs::set_permissions(&secret, std::fs::Permissions::from_mode(0o000)).unwrap();
        let (entries, _, _) = run_walk(dir.path(), &IndexCache::default());
        assert_eq!(
            skipped(&entries, "secret.txt").reason,
            Some(SyncSkipReason::Unreadable)
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_is_declared_and_counts_as_kept() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("d")).unwrap();
        std::os::unix::fs::symlink("nowhere", dir.path().join("d").join("link")).unwrap();
        let (entries, _, _) = run_walk(dir.path(), &IndexCache::default());
        assert_eq!(
            skipped(&entries, "d/link").reason,
            Some(SyncSkipReason::Symlink)
        );
        assert!(
            !entries.iter().any(|e| e.rel_path == "d" && e.kind == "dir"),
            "a dir holding only skipped paths is not empty"
        );
    }

    #[cfg(unix)]
    #[test]
    fn an_unportable_name_is_declared_for_files_and_dirs() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a:b.txt"), b"x").unwrap();
        let fin = dir.path().join("fin.");
        std::fs::create_dir(&fin).unwrap();
        std::fs::write(fin.join("y.txt"), b"y").unwrap();
        let (entries, fingerprint, fresh) = run_walk(dir.path(), &IndexCache::default());
        assert_eq!(
            skipped(&entries, "a:b.txt").reason,
            Some(SyncSkipReason::Unportable)
        );
        assert_eq!(
            skipped(&entries, "fin.").reason,
            Some(SyncSkipReason::Unportable)
        );
        assert!(entries.iter().all(|e| e.rel_path != "fin./y.txt"));
        // Skipped paths enter neither the cache nor the fingerprint.
        assert!(fresh.entries.is_empty());
        assert!(fingerprint.starts_with("0.0."), "{fingerprint}");
    }

    #[test]
    fn a_missing_root_with_a_populated_cache_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("gone");
        let mut populated = IndexCache::default();
        populated.entries.insert(
            "a.txt".to_string(),
            CacheEntry {
                size: 1,
                mtime: 0,
                hash: "h".to_string(),
                kind: "file".to_string(),
                mode: None,
                rehash: false,
            },
        );
        let err = ensure_root(&missing, &populated).unwrap_err();
        assert!(err.to_string().contains("introuvable"));
        assert!(!missing.exists(), "never recreated empty");

        ensure_root(&missing, &IndexCache::default()).unwrap();
        assert!(missing.is_dir(), "a first scan creates it");
    }

    #[test]
    fn a_recent_file_is_cached_for_a_rehash() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("fresh.txt"), b"now").unwrap();
        let (entries, fingerprint, fresh) = run_walk(dir.path(), &IndexCache::default());
        assert!(entries
            .iter()
            .any(|e| e.rel_path == "fresh.txt" && e.kind == "file"));
        assert!(fingerprint.starts_with("1."), "{fingerprint}");
        assert!(fresh.entries["fresh.txt"].rehash, "rehashed next time");
    }

    /// Every line a scan sent, whether it was flagged as a delta, and whether the whole disk was walked.
    fn drain(rx: &mut tokio::sync::mpsc::Receiver<SyncEvent>) -> (Vec<SyncIndexEntry>, bool, bool) {
        let mut entries = Vec::new();
        let mut delta = false;
        let mut scanned = true;
        while let Ok(ev) = rx.try_recv() {
            if let SyncEvent::Index {
                entries: batch,
                delta: d,
                scanned: s,
                ..
            } = ev
            {
                entries.extend(batch);
                delta |= d;
                scanned &= s;
            }
        }
        (entries, delta, scanned)
    }

    fn run_delta(
        root: &Path,
        cache: &IndexCache,
        touched: &[&str],
    ) -> (Vec<SyncIndexEntry>, String, IndexCache) {
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        let touched = Touched {
            paths: touched.iter().map(|p| p.to_string()).collect(),
            complete: true,
        };
        let (fingerprint, fresh) = delta_walk(
            "scan-2",
            &assignment(root),
            None,
            root,
            cache,
            &touched,
            &tx,
        )
        .expect("delta");
        drop(tx);
        let (entries, delta, scanned) = drain(&mut rx);
        assert!(delta, "a delta walk flags its reply");
        assert!(!scanned, "a delta walk never claims the whole disk");
        (entries, fingerprint, fresh)
    }

    fn names(entries: &[SyncIndexEntry], kind: &str) -> Vec<String> {
        let mut out: Vec<String> = entries
            .iter()
            .filter(|e| e.kind == kind)
            .map(|e| e.rel_path.clone())
            .collect();
        out.sort();
        out
    }

    #[test]
    fn a_delta_relists_only_the_touched_folders() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("a/b")).unwrap();
        std::fs::create_dir_all(root.join("d")).unwrap();
        std::fs::write(root.join("a/x.txt"), b"x").unwrap();
        std::fs::write(root.join("a/b/y.txt"), b"y").unwrap();
        std::fs::write(root.join("c.txt"), b"c").unwrap();
        std::fs::write(root.join("d/z.txt"), b"z").unwrap();
        let (_, _, cache) = run_walk(root, &IndexCache::default());

        std::fs::write(root.join("c.txt"), b"changed").unwrap();
        std::fs::write(root.join("a/n.txt"), b"new").unwrap();
        std::fs::remove_dir_all(root.join("a/b")).unwrap();
        std::fs::create_dir(root.join("e")).unwrap();
        let (lines, fingerprint, fresh) =
            run_delta(root, &cache, &["c.txt", "a/n.txt", "a/b", "e"]);

        assert_eq!(names(&lines, "file"), vec!["a/n.txt", "c.txt"]);
        assert_eq!(names(&lines, "dir"), vec!["e"]);
        assert_eq!(names(&lines, "gone"), vec!["a/b/y.txt"]);
        let (_, full_fingerprint, full) = run_walk(root, &IndexCache::default());
        assert_eq!(
            fingerprint, full_fingerprint,
            "the delta describes the whole folder"
        );
        let mut keys: Vec<&String> = fresh.entries.keys().collect();
        let mut full_keys: Vec<&String> = full.entries.keys().collect();
        keys.sort();
        full_keys.sort();
        assert_eq!(keys, full_keys);
    }

    #[test]
    fn a_delta_without_touched_paths_sends_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("a")).unwrap();
        std::fs::write(root.join("a/x.txt"), b"x").unwrap();
        let (_, full_fingerprint, cache) = run_walk(root, &IndexCache::default());
        let (lines, fingerprint, _) = run_delta(root, &cache, &[]);
        assert!(lines.is_empty());
        assert_eq!(fingerprint, full_fingerprint);
    }

    #[test]
    fn a_full_walk_that_finds_the_expected_fingerprint_sends_only_skips() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join("x.txt"), b"x").unwrap();
        let (_, fingerprint, cache) = run_walk(root, &IndexCache::default());
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        let (again, _) = walk(
            "scan-3",
            &assignment(root),
            None,
            root,
            &cache,
            Some(fingerprint.as_str()),
            &tx,
        )
        .expect("walk");
        drop(tx);
        let (entries, delta, scanned) = drain(&mut rx);
        assert_eq!(again, fingerprint);
        assert!(entries.is_empty());
        assert!(delta, "the server keeps its baseline as the device index");
        assert!(scanned, "the whole disk was still walked");
    }

    #[test]
    fn a_skipped_path_is_cut_to_the_wire_limit() {
        let long = "é".repeat(REL_PATH_MAX_BYTES);
        let cut = truncate_rel_path(long);
        assert!(cut.len() <= REL_PATH_MAX_BYTES);
        assert!(cut.chars().all(|c| c == 'é'));
    }

    #[test]
    fn hash_file_ticks_its_keepalive() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.bin");
        let bytes: Vec<u8> = (0..3 * HASH_CHUNK).map(|i| i as u8).collect();
        std::fs::write(&path, &bytes).unwrap();
        let expected = format!("{:x}", Sha256::digest(&bytes));

        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        let mut keepalive = Keepalive::with_period(tx, "scan-1", Duration::ZERO);
        assert_eq!(
            hash_file(&path, None, Some(&mut keepalive)).unwrap(),
            expected
        );
        match rx.try_recv() {
            Ok(SyncEvent::Busy { op_id }) => assert_eq!(op_id, "scan-1"),
            _ => panic!("expected a busy frame"),
        }
        assert_eq!(hash_file(&path, None, None).unwrap(), expected);
    }
}
