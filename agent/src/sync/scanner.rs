//! Scan complet d'un partage : parcours itératif, exclusions, hashing SHA-256
//! incrémental (cache size+mtime), lots d'index streamés vers la boucle.
//! La correction de TOUTE la synchro repose sur ce scan — pas de raccourci :
//! seuls les fichiers réguliers comptent, les symlinks sont ignorés.

use std::path::PathBuf;
use std::time::UNIX_EPOCH;

use anyhow::{Context, Result};
use regex::Regex;
use sha2::{Digest, Sha256};
use tokio::sync::mpsc::Sender;
use tracing::{debug, warn};

use crate::protocol::{SyncExclusion, SyncIndexEntry, SyncShareAssignment};
use crate::sync::index_cache::{CacheEntry, IndexCache};
use crate::sync::paths::{is_reserved_top, rel_path_of};
use crate::sync::transfer::sweep_trash;
use crate::sync::SyncEvent;

/// Taille des lots `sync.index` (miroir de `SYNC_INDEX_BATCH_MAX`).
const BATCH: usize = 500;
/// Garde-fou : au-delà, le scan est abandonné (dossier manifestement hors sujet).
const SCAN_BUDGET: usize = 2_000_000;
/// Cap de compilation regex, comme dans files.rs (motifs bornés côté serveur).
const REGEX_SIZE_LIMIT: usize = 1 << 20;

/// Exclusions compilées — mêmes sémantiques que `src/cloudSync/exclusions.ts`.
pub struct CompiledExclusions {
    paths: Vec<String>,
    names: Vec<String>,
    regexes: Vec<Regex>,
}

impl CompiledExclusions {
    pub fn compile(rows: &[SyncExclusion]) -> Self {
        let mut out = Self {
            paths: Vec::new(),
            names: Vec::new(),
            regexes: Vec::new(),
        };
        for row in rows {
            match row.kind.as_str() {
                "path" => out.paths.push(row.pattern.clone()),
                "name" => out.names.push(row.pattern.clone()),
                "regex" => {
                    match regex::RegexBuilder::new(&row.pattern)
                        .size_limit(REGEX_SIZE_LIMIT)
                        .build()
                    {
                        Ok(re) => out.regexes.push(re),
                        Err(e) => {
                            warn!(pattern = %row.pattern, error = %e, "sync: invalid exclusion regex ignored")
                        }
                    }
                }
                other => warn!(kind = %other, "sync: unknown exclusion kind ignored"),
            }
        }
        out
    }

    pub fn matches(&self, rel_path: &str) -> bool {
        for p in &self.paths {
            if rel_path == p || rel_path.starts_with(&format!("{p}/")) {
                return true;
            }
        }
        if !self.names.is_empty()
            && rel_path
                .split('/')
                .any(|seg| self.names.iter().any(|n| n == seg))
        {
            return true;
        }
        self.regexes.iter().any(|re| re.is_match(rel_path))
    }
}

fn mtime_millis(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
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
pub fn spawn_scan(session_id: String, assignment: SyncShareAssignment, tx: Sender<SyncEvent>) {
    std::thread::spawn(move || {
        let share_id = assignment.share_id;
        match scan(&session_id, &assignment, &tx) {
            Ok(()) => {}
            Err(e) => {
                let _ = tx.blocking_send(SyncEvent::Index {
                    session_id,
                    share_id,
                    entries: Vec::new(),
                    done: true,
                    error: Some(e.to_string()),
                });
            }
        }
    });
}

fn scan(session_id: &str, assignment: &SyncShareAssignment, tx: &Sender<SyncEvent>) -> Result<()> {
    let root = PathBuf::from(&assignment.local_path);
    // Un appareil fraîchement attaché n'a peut-être pas encore le dossier.
    std::fs::create_dir_all(&root).with_context(|| format!("création de {}", root.display()))?;

    // Entretien opportuniste : la corbeille locale > 30 jours est balayée ici.
    sweep_trash(&root, 30);

    let excluded = CompiledExclusions::compile(&assignment.exclusions);
    let cache = IndexCache::load(assignment.share_id);
    let mut fresh = IndexCache::default();

    let mut batch: Vec<SyncIndexEntry> = Vec::with_capacity(BATCH);
    let mut walked = 0usize;
    let mut stack = vec![root.clone()];

    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(e) => {
                debug!(dir = %dir.display(), error = %e, "sync scan: unreadable dir skipped");
                continue;
            }
        };
        for entry in entries.flatten() {
            walked += 1;
            if walked > SCAN_BUDGET {
                anyhow::bail!("scan abandonné : plus de {SCAN_BUDGET} entrées");
            }
            let path = entry.path();
            // symlink_metadata : ne JAMAIS suivre les liens (boucles, évasions).
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
                if is_reserved_top(top) || excluded.matches(&rel) {
                    continue;
                }
                stack.push(path);
                continue;
            }
            if !meta.is_file() || excluded.matches(&rel) {
                continue;
            }

            let size = meta.len();
            let mtime = mtime_millis(&meta);
            let hash = match cache.entries.get(&rel) {
                Some(c) if c.size == size && c.mtime == mtime => c.hash.clone(),
                _ => match hash_file(&path) {
                    Ok(h) => h,
                    Err(e) => {
                        debug!(path = %path.display(), error = %e, "sync scan: unreadable file skipped");
                        continue;
                    }
                },
            };
            fresh.entries.insert(
                rel.clone(),
                CacheEntry {
                    size,
                    mtime,
                    hash: hash.clone(),
                },
            );

            batch.push(SyncIndexEntry {
                rel_path: rel,
                hash,
                size,
                mtime,
            });
            if batch.len() >= BATCH {
                let full = std::mem::replace(&mut batch, Vec::with_capacity(BATCH));
                tx.blocking_send(SyncEvent::Index {
                    session_id: session_id.to_string(),
                    share_id: assignment.share_id,
                    entries: full,
                    done: false,
                    error: None,
                })
                .map_err(|_| anyhow::anyhow!("session terminée"))?;
            }
        }
    }

    fresh.save(assignment.share_id);
    tx.blocking_send(SyncEvent::Index {
        session_id: session_id.to_string(),
        share_id: assignment.share_id,
        entries: batch,
        done: true,
        error: None,
    })
    .map_err(|_| anyhow::anyhow!("session terminée"))?;
    Ok(())
}
