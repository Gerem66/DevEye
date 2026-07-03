//! Transferts CloudSync côté appareil.
//!
//! Trois opérations, toutes construites pour qu'AUCUN état intermédiaire ne
//! soit jamais visible ni destructeur :
//!  - **push** (upload) : lecture en chunks + hash au fil de l'eau ; la frame
//!    finale annonce le hash constaté — si le fichier a bougé pendant la
//!    lecture, le serveur jette le transfert ;
//!  - **apply** (download) : chunks écrits dans `.deveye-tmp/`, hash + taille
//!    vérifiés sur `done`, mtime appliqué, puis rename atomique (même volume) ;
//!  - **delete** : rename vers `.deveye-trash/<horodatage>/<relPath>` — jamais
//!    de `unlink`, ceinture locale en plus de la version archivée serveur.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use filetime::FileTime;
use sha2::{Digest, Sha256};
use tokio::sync::mpsc::Sender;
use tracing::debug;

use crate::sync::index_cache::IndexCache;
use crate::sync::paths::safe_join;
use crate::sync::SyncEvent;

/// Octets par chunk d'upload (le base64 reste sous le cap wire de ~1,4 M).
const PUSH_CHUNK: usize = 256 * 1024;

fn mtime_millis(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ─── Push (upload vers le serveur) ──────────────────────────────────────────

/// Lit un fichier local en chunks sur un thread dédié et les streame.
pub fn spawn_push(op_id: String, root: PathBuf, rel_path: String, tx: Sender<SyncEvent>) {
    std::thread::spawn(move || {
        if let Err(e) = push(&op_id, &root, &rel_path, &tx) {
            let _ = tx.blocking_send(SyncEvent::Chunk {
                op_id,
                data: Vec::new(),
                done: true,
                hash: None,
                size: None,
                mtime: None,
                error: Some(e.to_string()),
            });
        }
    });
}

fn push(op_id: &str, root: &Path, rel_path: &str, tx: &Sender<SyncEvent>) -> Result<()> {
    let path = safe_join(root, rel_path)?;
    let mut file =
        std::fs::File::open(&path).with_context(|| format!("ouverture de {rel_path}"))?;
    let meta = file.metadata().context("métadonnées illisibles")?;
    let mtime = mtime_millis(&meta);

    let mut hasher = Sha256::new();
    let mut size: u64 = 0;
    let mut buf = vec![0u8; PUSH_CHUNK];
    loop {
        let n = file
            .read(&mut buf)
            .with_context(|| format!("lecture de {rel_path}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        size += n as u64;
        tx.blocking_send(SyncEvent::Chunk {
            op_id: op_id.to_string(),
            data: buf[..n].to_vec(),
            done: false,
            hash: None,
            size: None,
            mtime: None,
            error: None,
        })
        .map_err(|_| anyhow::anyhow!("session terminée"))?;
    }
    tx.blocking_send(SyncEvent::Chunk {
        op_id: op_id.to_string(),
        data: Vec::new(),
        done: true,
        hash: Some(format!("{:x}", hasher.finalize())),
        size: Some(size),
        mtime: Some(mtime),
        error: None,
    })
    .map_err(|_| anyhow::anyhow!("session terminée"))?;
    Ok(())
}

// ─── Apply (download depuis le serveur, install atomique) ───────────────────

/// Un download en cours d'installation (chunks séquentiels, vérifiés à la fin).
struct ApplyState {
    file: std::fs::File,
    tmp_path: PathBuf,
    root: PathBuf,
    share_id: i64,
    rel_path: String,
    hasher: Sha256,
    written: u64,
    next_seq: u64,
}

/// Installe les downloads chunk par chunk. Les frames d'une même op arrivent
/// séquentiellement (traitées inline par la boucle) — pas de course possible.
#[derive(Default)]
pub struct Applier {
    ops: HashMap<String, ApplyState>,
}

/// Ce que la boucle doit renvoyer au serveur après un chunk.
pub enum ApplyOutcome {
    /// Chunk écrit : acquitter `seq`.
    Ack { seq: u64 },
    /// Frame finale : installation réussie (ack + opResult ok).
    Installed { seq: u64 },
    /// Échec : l'op est annulée, temporaire nettoyé (opResult !ok).
    Failed { error: String },
}

impl Applier {
    #[allow(clippy::too_many_arguments)]
    pub fn apply_chunk(
        &mut self,
        op_id: &str,
        share_id: i64,
        root: &Path,
        rel_path: &str,
        seq: u64,
        data: &[u8],
        done: bool,
        expected_hash: &str,
        expected_size: u64,
        mtime: i64,
    ) -> ApplyOutcome {
        let result = self.apply_inner(
            op_id,
            share_id,
            root,
            rel_path,
            seq,
            data,
            done,
            expected_hash,
            expected_size,
            mtime,
        );
        match result {
            Ok(false) => ApplyOutcome::Ack { seq },
            Ok(true) => ApplyOutcome::Installed { seq },
            Err(e) => {
                if let Some(state) = self.ops.remove(op_id) {
                    let _ = std::fs::remove_file(&state.tmp_path);
                }
                ApplyOutcome::Failed {
                    error: e.to_string(),
                }
            }
        }
    }

    /// `Ok(true)` = frame finale installée ; `Ok(false)` = chunk intermédiaire écrit.
    #[allow(clippy::too_many_arguments)]
    fn apply_inner(
        &mut self,
        op_id: &str,
        share_id: i64,
        root: &Path,
        rel_path: &str,
        seq: u64,
        data: &[u8],
        done: bool,
        expected_hash: &str,
        expected_size: u64,
        mtime: i64,
    ) -> Result<bool> {
        if !self.ops.contains_key(op_id) {
            if seq != 0 {
                bail!("premier chunk inattendu (seq {seq})");
            }
            let tmp_dir = root.join(".deveye-tmp");
            std::fs::create_dir_all(&tmp_dir).context("création du dossier temporaire")?;
            let tmp_path = tmp_dir.join(format!("{op_id}.part"));
            let file =
                std::fs::File::create(&tmp_path).context("création du fichier temporaire")?;
            self.ops.insert(
                op_id.to_string(),
                ApplyState {
                    file,
                    tmp_path,
                    root: root.to_path_buf(),
                    share_id,
                    rel_path: rel_path.to_string(),
                    hasher: Sha256::new(),
                    written: 0,
                    next_seq: 0,
                },
            );
        }
        let state = self.ops.get_mut(op_id).expect("state inséré ci-dessus");
        if seq != state.next_seq {
            bail!("chunk hors séquence ({seq}, attendu {})", state.next_seq);
        }
        state.next_seq += 1;

        if !data.is_empty() {
            state.file.write_all(data).context("écriture du chunk")?;
            state.hasher.update(data);
            state.written += data.len() as u64;
        }
        if !done {
            return Ok(false);
        }

        // Frame finale : tout vérifier AVANT de toucher au fichier cible.
        let state = self.ops.remove(op_id).expect("state présent");
        state.file.sync_all().context("fsync du temporaire")?;
        drop(state.file);

        let actual = format!("{:x}", state.hasher.finalize());
        if actual != expected_hash || state.written != expected_size {
            let _ = std::fs::remove_file(&state.tmp_path);
            bail!("contenu reçu invalide (hash ou taille inattendus)");
        }

        let dest = safe_join(&state.root, &state.rel_path)?;

        // Garde anti-écrasement : si la cible existe et a changé depuis le scan
        // qui a mené à ce download (taille/mtime ≠ cache d'index), une modif
        // locale non encore synchronisée serait perdue. On refuse l'install : le
        // prochain scan verra cette divergence et la traitera en conflit (le
        // perdant sera archivé côté serveur — l'invariant anti-perte tient).
        // Même critère de fraîcheur que le scanner (size+mtime).
        if let Ok(meta) = std::fs::symlink_metadata(&dest) {
            if meta.is_file() {
                let fresh = IndexCache::load(state.share_id)
                    .entries
                    .get(&state.rel_path)
                    .map(|c| c.size == meta.len() && c.mtime == mtime_millis(&meta))
                    .unwrap_or(false);
                if !fresh {
                    let _ = std::fs::remove_file(&state.tmp_path);
                    bail!("le fichier local a changé depuis le scan — installation reportée (conflit au prochain cycle)");
                }
            }
        }

        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).context("création des dossiers parents")?;
        }
        let ft = FileTime::from_unix_time(mtime / 1000, ((mtime % 1000) * 1_000_000) as u32);
        let _ = filetime::set_file_mtime(&state.tmp_path, ft);
        std::fs::rename(&state.tmp_path, &dest).context("installation (rename atomique)")?;
        debug!(rel_path = %state.rel_path, "sync: fichier installé");
        Ok(true)
    }

    /// Nettoie les installations en cours (fin de session : temporaire supprimé).
    pub fn abort_all(&mut self) {
        for (_, state) in self.ops.drain() {
            let _ = std::fs::remove_file(&state.tmp_path);
        }
    }
}

// ─── Corbeille locale ────────────────────────────────────────────────────────

/// Déplace un fichier vers `.deveye-trash/<horodatage>/<relPath>` (jamais unlink).
pub fn delete_to_trash(root: &Path, rel_path: &str) -> Result<()> {
    let src = safe_join(root, rel_path)?;
    if !src.exists() {
        return Ok(()); // Déjà parti localement : la suppression est idempotente.
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let dest = root
        .join(".deveye-trash")
        .join(stamp.to_string())
        .join(rel_path);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).context("création de la corbeille")?;
    }
    std::fs::rename(&src, &dest).context("mise à la corbeille")?;
    Ok(())
}

/// Purge les entrées de corbeille plus vieilles que `max_age_days` (best-effort).
pub fn sweep_trash(root: &Path, max_age_days: u64) {
    let trash = root.join(".deveye-trash");
    let Ok(entries) = std::fs::read_dir(&trash) else {
        return;
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    for entry in entries.flatten() {
        // Chaque sous-dossier est nommé par son horodatage de mise à la corbeille.
        let name = entry.file_name();
        let Some(stamp) = name.to_str().and_then(|s| s.parse::<u64>().ok()) else {
            continue;
        };
        if now.saturating_sub(stamp) > max_age_days * 86_400 {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}
