//! Scan complet d'un partage : parcours itératif, exclusions, hashing SHA-256
//! incrémental (cache size+mtime), lots d'index streamés vers la boucle.
//! La correction de TOUTE la synchro repose sur ce scan — pas de raccourci :
//! seuls les fichiers réguliers comptent, les symlinks sont ignorés.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc::Sender;
use tracing::debug;

use crate::exclusions::CompiledExclusions;
use crate::protocol::{SyncIndexEntry, SyncShareAssignment};
use crate::sync::fingerprint::{Fingerprint, FingerprintEntry};
use crate::sync::index_cache::{CacheEntry, IndexCache};
use crate::sync::paths::{is_reserved_top, rel_path_of, rel_path_problem};
use crate::sync::transfer::sweep_trash;
use crate::sync::{CleanMark, SyncEvent};

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

/// SHA-256 (hex) d'un fichier, lu en flux (jamais chargé entier en mémoire).
pub fn hash_file(path: &std::path::Path) -> Result<String> {
    let mut file =
        std::fs::File::open(path).with_context(|| format!("ouverture de {}", path.display()))?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher)
        .with_context(|| format!("lecture de {}", path.display()))?;
    Ok(format!("{:x}", hasher.finalize()))
}

/// Lance le scan sur un thread dédié (I/O + hashing intensifs, hors runtime).
///
/// `clean` est la marque de propreté du partage : le scan la POSE en fin de
/// course, avec l'empreinte de ce qu'il vient de produire et l'époque du
/// compteur d'événements relevée AVANT le parcours. Prendre l'époque avant, et
/// vérifier après qu'elle n'a pas bougé, est ce qui interdit de marquer propre un
/// partage modifié pendant le scan.
pub fn spawn_scan(
    session_id: String,
    assignment: SyncShareAssignment,
    tx: Sender<SyncEvent>,
    events: Option<Arc<AtomicU64>>,
    clean: Arc<Mutex<CleanMark>>,
) {
    std::thread::spawn(move || {
        let share_id = assignment.share_id;
        let epoch = events.as_ref().map(|e| e.load(Ordering::Relaxed));
        match scan(&session_id, &assignment, &tx) {
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
                    error: Some(e.to_string()),
                });
            }
        }
    });
}

/// Envoie le lot dès qu'il atteint `BATCH` : au-delà, la trame dépasserait
/// `SYNC_INDEX_BATCH_MAX` et le serveur la refuserait.
fn flush_if_full(
    batch: &mut Vec<SyncIndexEntry>,
    tx: &Sender<SyncEvent>,
    session_id: &str,
    share_id: i64,
) -> anyhow::Result<()> {
    if batch.len() < BATCH {
        return Ok(());
    }
    let full = std::mem::replace(batch, Vec::with_capacity(BATCH));
    tx.blocking_send(SyncEvent::Index {
        session_id: session_id.to_string(),
        share_id,
        entries: full,
        done: false,
        scanned: true,
        fingerprint: None,
        error: None,
    })
    .map_err(|_| anyhow::anyhow!("session terminée"))
}

fn scan(
    session_id: &str,
    assignment: &SyncShareAssignment,
    tx: &Sender<SyncEvent>,
) -> Result<String> {
    let root = PathBuf::from(&assignment.local_path);
    // Un appareil fraîchement attaché n'a peut-être pas encore le dossier.
    std::fs::create_dir_all(&root).with_context(|| format!("création de {}", root.display()))?;

    // Entretien opportuniste : la corbeille locale est balayée ici, selon la
    // rétention réglée sur le partage (30 jours par défaut).
    sweep_trash(&root, assignment.trash_keep_days);

    let excluded = CompiledExclusions::compile(&assignment.exclusions);
    let cache = IndexCache::load(assignment.share_id);
    let mut fresh = IndexCache {
        root: root.to_string_lossy().into_owned(),
        ..IndexCache::default()
    };

    let mut batch: Vec<SyncIndexEntry> = Vec::with_capacity(BATCH);
    let mut walked = 0usize;
    let mut stack = vec![root.clone()];
    let now_ms = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(e) => {
                debug!(dir = %dir.display(), error = %e, "sync scan: unreadable dir skipped");
                continue;
            }
        };
        // Un dossier n'est indexé que s'il est VIDE une fois les exclusions
        // appliquées : un dossier peuplé est implicite (ses fichiers le
        // recréent partout). On compte donc ce qui survit au filtrage.
        let mut kept = 0usize;
        for entry in entries.flatten() {
            walked += 1;
            if walked > SCAN_BUDGET {
                anyhow::bail!("scan abandonné : plus de {SCAN_BUDGET} entrées");
            }
            let path = entry.path();
            // `DirEntry::metadata` ne suit pas les liens : jamais (boucles, évasions).
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.is_symlink() {
                continue;
            }
            let Some(rel) = rel_path_of(&root, &path) else {
                continue;
            };
            if meta.is_dir() {
                let top = rel.split('/').next().unwrap_or("");
                if is_reserved_top(top)
                    || excluded.matches(&rel)
                    || rel_path_problem(&rel).is_some()
                {
                    continue;
                }
                kept += 1;
                stack.push(path);
                continue;
            }
            if !meta.is_file() || excluded.matches(&rel) {
                continue;
            }
            // Filtrage à la source : un nom que Windows ne sait pas écrire
            // n'entre jamais dans le partage. Le serveur revalide (défense en
            // profondeur) et c'est LUI qui journalise pour l'utilisateur.
            if let Some(problem) = rel_path_problem(&rel) {
                debug!(rel_path = %rel, %problem, "sync scan: unportable name skipped");
                continue;
            }

            let size = meta.len();
            let mtime = mtime_millis(&meta);
            let hash = match cache.entries.get(&rel) {
                // `now_ms - mtime` : un mtime dans le futur (dérive d'horloge)
                // donne un écart négatif, donc un re-hash. C'est le bon sens.
                Some(c) if c.size == size && c.mtime == mtime && now_ms - mtime > RECENT_MS => {
                    c.hash.clone()
                }
                _ => match hash_file(&path) {
                    Ok(h) => h,
                    Err(e) => {
                        debug!(path = %path.display(), error = %e, "sync scan: unreadable file skipped");
                        continue;
                    }
                },
            };
            kept += 1;
            let mode = unix_mode(&meta);
            fresh.entries.insert(
                rel.clone(),
                CacheEntry {
                    size,
                    mtime,
                    hash: hash.clone(),
                    kind: "file".to_string(),
                    mode,
                },
            );

            batch.push(SyncIndexEntry {
                rel_path: rel,
                kind: "file".to_string(),
                hash,
                size,
                mtime,
                mode,
            });
            flush_if_full(&mut batch, tx, session_id, assignment.share_id)?;
        }

        // Rien n'a survécu au filtrage : ce dossier est vide, il mérite sa
        // propre entrée d'index pour exister aussi chez les autres appareils.
        // La racine du partage, elle, n'est pas une entrée (elle existe toujours).
        if kept == 0 {
            if let Some(rel) = rel_path_of(&root, &dir) {
                if rel_path_problem(&rel).is_none() {
                    let meta = std::fs::symlink_metadata(&dir).ok();
                    let mtime = meta.as_ref().map(mtime_millis).unwrap_or(0);
                    let mode = meta.as_ref().and_then(unix_mode);
                    // Les dossiers vides entrent dans le cache comme les
                    // fichiers : l'empreinte se calcule à partir de `fresh`, et
                    // un dossier vidé de son dernier fichier doit la déplacer.
                    fresh.entries.insert(
                        rel.clone(),
                        CacheEntry {
                            size: 0,
                            mtime,
                            hash: SYNC_DIR_HASH.to_string(),
                            kind: "dir".to_string(),
                            mode,
                        },
                    );
                    batch.push(SyncIndexEntry {
                        rel_path: rel,
                        kind: "dir".to_string(),
                        hash: SYNC_DIR_HASH.to_string(),
                        size: 0,
                        mtime,
                        mode,
                    });
                    // Vidange comme pour un fichier : une arborescence de nombreux
                    // dossiers vides dépasserait sinon `SYNC_INDEX_BATCH_MAX`.
                    flush_if_full(&mut batch, tx, session_id, assignment.share_id)?;
                }
            }
        }
    }

    // L'empreinte se calcule sur `fresh`, c'est-à-dire sur EXACTEMENT ce que ce
    // scan vient d'émettre. La calculer ailleurs (sur le cache chargé, sur le
    // disque relu) la ferait décrire autre chose que ce que le serveur a reçu.
    let fingerprint = fingerprint_of(&fresh);
    fresh.save(assignment.share_id);
    tx.blocking_send(SyncEvent::Index {
        session_id: session_id.to_string(),
        share_id: assignment.share_id,
        entries: batch,
        done: true,
        scanned: true,
        fingerprint: Some(fingerprint.clone()),
        error: None,
    })
    .map_err(|_| anyhow::anyhow!("session terminée"))?;
    Ok(fingerprint)
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
