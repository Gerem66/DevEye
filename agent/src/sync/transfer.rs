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
use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use filetime::FileTime;
use sha2::{Digest, Sha256};
use tokio::sync::mpsc::Sender;
use tracing::debug;

use crate::sync::index_cache::IndexCache;
use crate::sync::paths::safe_join;
use crate::sync::scanner::hash_file;
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

/// Backoff des tentatives de rename (Windows refuse de renommer par-dessus un
/// fichier ouvert par une autre application : Word, Excel, un éditeur…).
const RENAME_BACKOFF_MS: [u64; 3] = [100, 300, 900];

/// Message renvoyé quand la cible reste verrouillée : il doit rester lisible
/// pour l'utilisateur, et surtout ne pas ressembler à une corruption.
pub const LOCKED_HINT: &str =
    "fichier verrouillé par une autre application — nouvelle tentative au prochain cycle";

/// `rename` avec réessais sur verrou. Sur Unix un rename ne bute jamais sur un
/// fichier ouvert ; sous Windows si, et l'échec est presque toujours transitoire
/// (sauvegarde d'un document en cours). Sans ces réessais, le fichier restait
/// durablement divergent sur la machine Windows.
fn rename_with_retry(src: &Path, dest: &Path) -> Result<()> {
    let mut last = match std::fs::rename(src, dest) {
        Ok(()) => return Ok(()),
        Err(e) => e,
    };
    for delay in RENAME_BACKOFF_MS {
        if last.kind() != std::io::ErrorKind::PermissionDenied {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(delay));
        match std::fs::rename(src, dest) {
            Ok(()) => return Ok(()),
            Err(e) => last = e,
        }
    }
    if last.kind() == std::io::ErrorKind::PermissionDenied {
        bail!("{LOCKED_HINT}");
    }
    Err(last.into())
}

/// Chemin du partiel d'un download, nommé par le hash attendu.
fn partial_path(root: &Path, hash: &str) -> Result<PathBuf> {
    if hash.len() != 64 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
        bail!("hash de blob invalide");
    }
    let dir = root.join(".deveye-tmp");
    std::fs::create_dir_all(&dir).context("création du dossier temporaire")?;
    Ok(dir.join(format!("{hash}.part")))
}

/// Ce qu'un partiel existant apporte à une reprise : les octets réutilisables
/// et le SHA-256 courant qui va avec.
pub struct HeldPrefix {
    pub bytes: u64,
    pub hasher: Sha256,
}

/// Relit les `want` premiers octets d'un partiel pour reconstituer le SHA-256
/// courant. `want` est le point de reprise DÉCIDÉ PAR LE SERVEUR : l'agent ne
/// choisit pas, il obéit — c'est ce qui garantit que les deux côtés comptent
/// les mêmes octets. Toute anomalie (partiel trop court, illisible) rend un
/// préfixe VIDE : repartir de zéro ne coûte que du temps, alors que bâtir sur
/// des octets douteux livrerait un fichier faux.
pub fn resumable_prefix(tmp_path: &Path, want: u64) -> HeldPrefix {
    let empty = HeldPrefix {
        bytes: 0,
        hasher: Sha256::new(),
    };
    if want == 0 {
        return empty;
    }
    let Ok(mut file) = std::fs::File::open(tmp_path) else {
        return empty;
    };
    if file.metadata().map(|m| m.len()).unwrap_or(0) < want {
        return empty; // Moins d'octets que le serveur ne le croit : on recommence.
    }
    let mut hasher = Sha256::new();
    let mut bytes = 0u64;
    let mut buf = vec![0u8; PUSH_CHUNK];
    while bytes < want {
        let take = ((want - bytes) as usize).min(PUSH_CHUNK);
        match file.read(&mut buf[..take]) {
            Ok(0) => return empty,
            Ok(n) => {
                hasher.update(&buf[..n]);
                bytes += n as u64;
            }
            Err(_) => return empty,
        }
    }
    HeldPrefix { bytes, hasher }
}

/// Combien d'octets valides l'agent détient déjà pour ce hash (réponse à
/// `sync.applyStart`). `0` quand il n'y a rien d'exploitable.
pub fn held_bytes_for(root: &Path, hash: &str) -> u64 {
    let Ok(tmp_path) = partial_path(root, hash) else {
        return 0;
    };
    std::fs::metadata(&tmp_path).map(|m| m.len()).unwrap_or(0)
}

/// Étale l'envoi pour respecter un plafond en octets/s. Le seau se remplit à
/// `bps` et déborde à une seconde de crédit : une pause laisse donc passer au
/// plus une seconde de rafale, jamais l'accumulation d'une heure d'inactivité.
struct UploadThrottle {
    bps: u64,
    tokens: f64,
    last: std::time::Instant,
}

impl UploadThrottle {
    fn new(bps: u64) -> Self {
        Self {
            bps,
            tokens: bps as f64,
            last: std::time::Instant::now(),
        }
    }

    fn take(&mut self, bytes: u64) {
        loop {
            let now = std::time::Instant::now();
            self.tokens = (self.tokens
                + now.duration_since(self.last).as_secs_f64() * self.bps as f64)
                .min(self.bps as f64);
            self.last = now;
            if self.tokens >= bytes as f64 || self.tokens >= self.bps as f64 {
                self.tokens -= bytes as f64;
                return;
            }
            let missing = (bytes.min(self.bps) as f64) - self.tokens;
            let wait = (missing / self.bps as f64).max(0.005);
            std::thread::sleep(std::time::Duration::from_secs_f64(wait));
        }
    }
}

// ─── Push (upload vers le serveur) ──────────────────────────────────────────

/// Lit un fichier local en chunks sur un thread dédié et les streame.
pub fn spawn_push(
    op_id: String,
    root: PathBuf,
    rel_path: String,
    start_offset: u64,
    rate_up_bps: Option<u64>,
    tx: Sender<SyncEvent>,
) {
    std::thread::spawn(move || {
        if let Err(e) = push(&op_id, &root, &rel_path, start_offset, rate_up_bps, &tx) {
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

fn push(
    op_id: &str,
    root: &Path,
    rel_path: &str,
    start_offset: u64,
    rate_up_bps: Option<u64>,
    tx: &Sender<SyncEvent>,
) -> Result<()> {
    let path = safe_join(root, rel_path)?;
    let mut file =
        std::fs::File::open(&path).with_context(|| format!("ouverture de {rel_path}"))?;
    let meta = file.metadata().context("métadonnées illisibles")?;
    let mtime = mtime_millis(&meta);

    let mut hasher = Sha256::new();
    let mut size: u64 = 0;
    // Reprise : le serveur détient déjà `start_offset` octets vérifiables. On
    // les relit quand même EN LOCAL pour reconstituer le hash — c'est de l'I/O
    // disque, pas du réseau, et ça garde la vérification finale exacte.
    if start_offset > 0 && start_offset <= meta.len() {
        let mut buf = vec![0u8; PUSH_CHUNK];
        while size < start_offset {
            let want = ((start_offset - size) as usize).min(PUSH_CHUNK);
            let n = file
                .read(&mut buf[..want])
                .with_context(|| format!("relecture de {rel_path}"))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            size += n as u64;
        }
    }

    let mut throttle = rate_up_bps.filter(|b| *b > 0).map(UploadThrottle::new);
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
        if let Some(t) = throttle.as_mut() {
            t.take(n as u64);
        }
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
    /// Permissions à poser sur le fichier installé (`None` = ne pas toucher).
    mode: Option<u32>,
}

/// Installe les downloads chunk par chunk. Les frames d'une même op arrivent
/// séquentiellement (traitées inline par la boucle) — pas de course possible.
#[derive(Default)]
pub struct Applier {
    ops: HashMap<String, ApplyState>,
    /// Cache de scan par partage, mémorisé le temps d'une session de synchro.
    /// Le relire à chaque fichier installé revenait à parser tout le JSON une
    /// fois par fichier — rédhibitoire sur un gros partage. Invalidé au début
    /// de chaque scan (`SyncManager::start_scan`), qui est justement ce qui
    /// réécrit le fichier.
    caches: HashMap<i64, IndexCache>,
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
        mode: Option<u32>,
        resume_from: u64,
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
            mode,
            resume_from,
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
        mode: Option<u32>,
        resume_from: u64,
    ) -> Result<bool> {
        if !self.ops.contains_key(op_id) {
            if seq != 0 {
                bail!("premier chunk inattendu (seq {seq})");
            }
            // Temporaire nommé par HASH et non par `opId` : c'est ce qui permet
            // de le retrouver au cycle suivant et de reprendre. `sync.applyStart`
            // a déjà annoncé au serveur combien d'octets valides s'y trouvent, et
            // ce qui suit se contente d'y ajouter la suite.
            let tmp_path = partial_path(root, expected_hash)?;
            // `resume_from` vient du SERVEUR, qui l'a décidé à partir de ce que
            // l'agent avait annoncé. On s'y conforme au lieu de relire notre
            // propre taille : si les deux ne sont pas d'accord (le serveur a pu
            // décider de repartir de zéro), c'est le serveur qui a raison — il
            // sait ce qu'il envoie. Le temporaire est tronqué en conséquence.
            let held = resumable_prefix(&tmp_path, resume_from);
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(held.bytes == 0)
                .open(&tmp_path)
                .context("ouverture du fichier temporaire")?;
            if held.bytes > 0 {
                file.set_len(held.bytes)
                    .context("troncature du temporaire au point de reprise")?;
                file.seek(std::io::SeekFrom::Start(held.bytes))
                    .context("positionnement pour la reprise")?;
            }
            self.ops.insert(
                op_id.to_string(),
                ApplyState {
                    file,
                    tmp_path,
                    root: root.to_path_buf(),
                    share_id,
                    rel_path: rel_path.to_string(),
                    hasher: held.hasher,
                    written: held.bytes,
                    next_seq: 0,
                    mode,
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
                let fresh = self
                    .cache_for(state.share_id)
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
        // Le mode est posé sur le TEMPORAIRE : la cible n'existe jamais dans un
        // état intermédiaire avec les mauvaises permissions.
        apply_mode(&state.tmp_path, state.mode);
        rename_with_retry(&state.tmp_path, &dest).context("installation (rename atomique)")?;
        debug!(rel_path = %state.rel_path, "sync: fichier installé");
        Ok(true)
    }

    /// Le cache de scan d'un partage, chargé au plus une fois par session.
    fn cache_for(&mut self, share_id: i64) -> &IndexCache {
        self.caches
            .entry(share_id)
            .or_insert_with(|| IndexCache::load(share_id))
    }

    /// Oublie le cache mémorisé d'un partage : appelé au début de chaque scan,
    /// qui va justement réécrire le fichier sur disque.
    pub fn invalidate_cache(&mut self, share_id: i64) {
        self.caches.remove(&share_id);
    }

    /// Nettoie les installations en cours (fin de session : temporaire supprimé).
    pub fn abort_all(&mut self) {
        for (_, state) in self.ops.drain() {
            let _ = std::fs::remove_file(&state.tmp_path);
        }
        self.caches.clear();
    }
}

// ─── Dossiers vides & copies locales ─────────────────────────────────────────

/// Applique les permissions Unix. Sans effet sous Windows, qui n'en a pas.
#[cfg(unix)]
fn apply_mode(path: &Path, mode: Option<u32>) {
    use std::os::unix::fs::PermissionsExt;
    if let Some(bits) = mode {
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(bits & 0o777));
    }
}

#[cfg(not(unix))]
fn apply_mode(_path: &Path, _mode: Option<u32>) {}

/// Pose les métadonnées d'un chemin sans transférer un seul octet. Deux usages,
/// volontairement réunis parce qu'ils font exactement le même travail :
///  - une entrée `dir` de l'index (dossier VIDE) : le dossier est créé ;
///  - un `chmod` seul sur un chemin déjà en place, fichier OU dossier.
///
/// D'où l'ordre : si le chemin existe, on ne touche QUE le mode, quelle que soit
/// sa nature. Ce n'est que s'il manque qu'on le crée comme dossier — un fichier
/// absent, lui, arrive toujours par `applyChunk` ou `applyLocal`.
pub fn apply_dir(root: &Path, rel_path: &str, kind: &str, mode: Option<u32>) -> Result<()> {
    let dest = safe_join(root, rel_path)?;
    if std::fs::symlink_metadata(&dest).is_err() {
        // Un `chmod` sur un FICHIER momentanément absent ne doit surtout pas
        // faire naître un dossier à sa place : le planner écarterait ensuite ce
        // chemin pour toujours en « conflit de nature ». On ne fait rien, et le
        // prochain cycle téléchargera le fichier normalement.
        if kind != "dir" {
            return Ok(());
        }
        std::fs::create_dir_all(&dest).context("création du dossier")?;
    }
    apply_mode(&dest, mode);
    Ok(())
}

/// Installe un contenu déjà présent ailleurs dans le partage, par copie locale.
/// Le hash de la source est VÉRIFIÉ d'abord : sans ça, une source périmée
/// écrirait un contenu faux sous un chemin dont le serveur croit tout savoir.
/// L'install passe par le même temporaire + rename atomique qu'un download.
pub fn apply_local(
    root: &Path,
    rel_path: &str,
    source_rel_path: &str,
    hash: &str,
    size: u64,
    mtime: i64,
    mode: Option<u32>,
) -> Result<()> {
    let src = safe_join(root, source_rel_path)?;
    let meta = std::fs::symlink_metadata(&src).context("source introuvable")?;
    if !meta.is_file() {
        bail!("la source n'est pas un fichier régulier");
    }
    if meta.len() != size {
        bail!("taille de la source inattendue");
    }
    if hash_file(&src)? != hash {
        bail!("contenu de la source inattendu");
    }

    let dest = safe_join(root, rel_path)?;
    let tmp_dir = root.join(".deveye-tmp");
    std::fs::create_dir_all(&tmp_dir).context("création du dossier temporaire")?;
    let tmp_path = tmp_dir.join(format!("copy-{}.part", uuid_like(rel_path, mtime)));
    // Copier PUIS renommer : jamais de cible à moitié écrite.
    std::fs::copy(&src, &tmp_path).context("copie locale")?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).context("création des dossiers parents")?;
    }
    let ft = FileTime::from_unix_time(mtime / 1000, ((mtime % 1000) * 1_000_000) as u32);
    let _ = filetime::set_file_mtime(&tmp_path, ft);
    apply_mode(&tmp_path, mode);
    if let Err(e) = rename_with_retry(&tmp_path, &dest) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(e).context("installation (rename atomique)");
    }
    debug!(rel_path, source_rel_path, "sync: copie locale installée");
    Ok(())
}

/// Nom de temporaire stable et sans collision, sans tirer une dépendance UUID
/// de plus : le chemin cible et l'horodatage suffisent à l'unicité par op.
fn uuid_like(rel_path: &str, mtime: i64) -> String {
    let mut hasher = Sha256::new();
    hasher.update(rel_path.as_bytes());
    hasher.update(mtime.to_le_bytes());
    format!("{:x}", hasher.finalize())[..32].to_string()
}

/// Renomme un fichier sur place : un déplacement, pas une copie suivie d'une
/// suppression.
///
/// Le hash de la source est VÉRIFIÉ d'abord — sans quoi un fichier modifié
/// entre le scan et l'ordre serait déplacé sous un nom que le serveur croit
/// porter un autre contenu. En cas de doute on refuse, et le serveur retombe
/// sur le chemin ordinaire (téléchargement puis corbeille), qui reste sûr.
#[allow(clippy::too_many_arguments)]
pub fn move_file(
    root: &Path,
    from_rel_path: &str,
    rel_path: &str,
    hash: &str,
    size: u64,
    mtime: i64,
    mode: Option<u32>,
) -> Result<()> {
    let src = safe_join(root, from_rel_path)?;
    let meta = std::fs::symlink_metadata(&src).context("source introuvable")?;
    if !meta.is_file() {
        bail!("la source n'est pas un fichier régulier");
    }
    if meta.len() != size {
        bail!("taille de la source inattendue");
    }
    if hash_file(&src)? != hash {
        bail!("contenu de la source inattendu");
    }

    let dest = safe_join(root, rel_path)?;
    if std::fs::symlink_metadata(&dest).is_ok() {
        bail!("la cible existe déjà");
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).context("création des dossiers parents")?;
    }
    rename_with_retry(&src, &dest).context("déplacement")?;

    let ft = FileTime::from_unix_time(mtime / 1000, ((mtime % 1000) * 1_000_000) as u32);
    let _ = filetime::set_file_mtime(&dest, ft);
    apply_mode(&dest, mode);
    // Le dossier d'origine peut être devenu vide : sans ça, déplacer une
    // arborescence laisserait sa coquille derrière elle.
    prune_empty_parents(root, &src);
    debug!(from_rel_path, rel_path, "sync: fichier déplacé");
    Ok(())
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
    rename_with_retry(&src, &dest).context("mise à la corbeille")?;
    prune_empty_parents(root, &src);
    Ok(())
}

/// Retire les dossiers devenus vides en remontant vers la racine du partage.
/// Sans ça, supprimer le dernier fichier d'une arborescence laissait la coquille
/// de dossiers chez tous les pairs alors qu'elle a disparu à la source : les
/// dossiers n'auraient plus été identiques. `remove_dir` échoue (et arrête la
/// remontée) dès qu'un dossier n'est pas vide, ce qui est exactement la garde
/// voulue. La racine elle-même n'est jamais touchée.
fn prune_empty_parents(root: &Path, from: &Path) {
    let mut current = from.parent();
    while let Some(dir) = current {
        if dir == root || !dir.starts_with(root) {
            return;
        }
        if std::fs::remove_dir(dir).is_err() {
            return; // Pas vide (ou verrouillé) : on s'arrête là.
        }
        current = dir.parent();
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn throttle_lets_the_first_burst_through_then_slows_down() {
        let mut throttle = UploadThrottle::new(100_000);
        let started = std::time::Instant::now();
        throttle.take(100_000);
        assert!(
            started.elapsed().as_millis() < 50,
            "le crédit initial doit passer sans attendre"
        );

        let started = std::time::Instant::now();
        throttle.take(50_000);
        assert!(
            started.elapsed().as_millis() >= 200,
            "le débit doit être effectivement bridé"
        );
    }

    #[test]
    fn throttle_never_deadlocks_on_a_chunk_bigger_than_the_rate() {
        // Sinon un chunk de 256 Ko sous une limite de 50 Ko/s n'aurait JAMAIS
        // assez de crédit et bloquerait l'agent pour toujours.
        let mut throttle = UploadThrottle::new(50_000);
        throttle.take(50_000);
        let started = std::time::Instant::now();
        throttle.take(PUSH_CHUNK as u64);
        assert!(
            started.elapsed().as_secs() < 3,
            "un gros bloc doit finir par passer"
        );
    }

    #[test]
    fn partial_path_refuses_anything_that_is_not_a_hash() {
        let root = Path::new("/tmp/deveye-test-root");
        for bad in ["../evil", "not-a-hash", "", &"z".repeat(64)] {
            assert!(partial_path(root, bad).is_err(), "should reject {bad:?}");
        }
    }

    #[test]
    fn resumable_prefix_is_empty_when_there_is_no_partial() {
        assert_eq!(
            resumable_prefix(Path::new("/tmp/deveye-nope.part"), 10).bytes,
            0
        );
    }

    #[test]
    fn resumable_prefix_obeys_the_server_offset() {
        let dir = std::env::temp_dir().join(format!("deveye-resume-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("x.part");
        std::fs::write(&path, b"bonjour tout le monde").unwrap();

        // Le serveur décide de reprendre à 7 : on ne relit QUE ces 7 octets,
        // même si le temporaire en contient davantage. Les deux côtés comptent
        // ainsi rigoureusement les mêmes octets.
        let held = resumable_prefix(&path, 7);
        assert_eq!(held.bytes, 7);
        let expected = format!("{:x}", Sha256::digest(b"bonjour"));
        assert_eq!(format!("{:x}", held.hasher.finalize()), expected);

        // Serveur qui croit l'agent plus avancé qu'il ne l'est : on repart de
        // zéro plutôt que de bâtir sur des octets absents.
        assert_eq!(resumable_prefix(&path, 999).bytes, 0);
        assert_eq!(resumable_prefix(&path, 0).bytes, 0);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn apply_dir_never_creates_a_directory_for_a_missing_file() {
        // Un `chmod` sur un fichier momentanément absent ne doit PAS faire naître
        // un dossier : le planner écarterait ensuite ce chemin pour toujours en
        // « conflit de nature ».
        let root = std::env::temp_dir().join(format!("deveye-applydir-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();

        apply_dir(&root, "absent.txt", "file", Some(0o644)).unwrap();
        assert!(
            !root.join("absent.txt").exists(),
            "aucun chemin ne doit être créé"
        );

        apply_dir(&root, "vide", "dir", None).unwrap();
        assert!(
            root.join("vide").is_dir(),
            "un dossier vide, lui, doit être créé"
        );

        std::fs::remove_dir_all(&root).ok();
    }
}
