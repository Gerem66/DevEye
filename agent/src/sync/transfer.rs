//! CloudSync transfers on the device side.
//!
//! Three operations, all built so that NO intermediate state is ever visible
//! or destructive:
//!  - **push** (upload): chunked read, hashed on the fly; the final frame
//!    announces the observed hash, and the server drops the transfer if the
//!    file moved mid-read. A resumed push (`startOffset > 0`) seeks past what
//!    it already sent and announces no hash: the server verifies the whole
//!    blob at finalize and is the only judge. On an encrypted share the agent
//!    is the only judge instead (see `push_sealed`);
//!  - **apply** (download): one thread per op; chunks written to
//!    `.deveye-tmp/<hash>.part`, hash + size verified on `done`, mtime set,
//!    then an atomic rename (same volume). The partial survives the session
//!    and a refused install (only wrong content destroys it); partials older
//!    than 7 days are swept at scan time;
//!  - **delete**: rename to `.deveye-trash/<timestamp>/<relPath>`, never an
//!    `unlink`, a local belt on top of the server's archived version.
//!
//! Nothing long runs on the WebSocket loop, and every long local step
//! (re-reading a partial, hashing) emits `sync.busy` through a `Keepalive`.

use std::collections::HashMap;
use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use base64::Engine as _;
use filetime::FileTime;
use sha2::{Digest, Sha256};
use tokio::sync::mpsc::{Receiver, Sender};
use tracing::debug;

use crate::ownership::adopt_owner;
use crate::protocol::SyncPushResume;
use crate::sync::e2e::{self, ContentHasher, ShareKeys, TagDigest, Unsealer, BLOCK, NONCE_LEN};
use crate::sync::index_cache::IndexCache;
use crate::sync::paths::confined_join;
use crate::sync::scanner::hash_file;
use crate::sync::{error_text, Keepalive, SyncEvent};

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
    "fichier verrouillé par une autre application, nouvelle tentative au prochain cycle";

/// A target held by another program. Windows reports it as
/// ERROR_SHARING_VIOLATION (32) or ERROR_LOCK_VIOLATION (33), which the std
/// leaves `Uncategorized`; a read-only target or parent is `PermissionDenied`.
fn is_lock_error(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::PermissionDenied
        || (cfg!(windows) && matches!(e.raw_os_error(), Some(32) | Some(33)))
}

/// `rename` avec réessais sur verrou. Sur Unix un rename ne bute jamais sur un
/// fichier ouvert ; sous Windows si, et l'échec est presque toujours transitoire
/// (sauvegarde d'un document en cours).
fn rename_with_retry(src: &Path, dest: &Path) -> Result<()> {
    let mut last = match std::fs::rename(src, dest) {
        Ok(()) => return Ok(()),
        Err(e) => e,
    };
    for delay in RENAME_BACKOFF_MS {
        if !is_lock_error(&last) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(delay));
        match std::fs::rename(src, dest) {
            Ok(()) => return Ok(()),
            Err(e) => last = e,
        }
    }
    if is_lock_error(&last) {
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
/// et le hachage courant qui va avec.
pub struct HeldPrefix {
    pub bytes: u64,
    pub hasher: ContentHasher,
}

/// Re-reads the first `want` bytes of a partial to rebuild the running SHA-256.
/// `want` is the resume point DECIDED BY THE SERVER, so both sides count the
/// same bytes. A partial too short or unreadable yields an empty prefix:
/// starting over only costs time, building on doubtful bytes would deliver a
/// wrong file. `Err` only when the session is gone (keepalive closed): the
/// caller then stops without touching the partial.
pub fn resumable_prefix(
    tmp_path: &Path,
    want: u64,
    keys: Option<&ShareKeys>,
    keepalive: &mut Keepalive,
) -> Result<HeldPrefix> {
    let empty = HeldPrefix {
        bytes: 0,
        hasher: ContentHasher::new(keys),
    };
    if want == 0 {
        return Ok(empty);
    }
    let Ok(mut file) = std::fs::File::open(tmp_path) else {
        return Ok(empty);
    };
    if file.metadata().map(|m| m.len()).unwrap_or(0) < want {
        return Ok(empty); // Fewer bytes than the server believes: start over.
    }
    let mut hasher = ContentHasher::new(keys);
    let mut bytes = 0u64;
    let mut buf = vec![0u8; PUSH_CHUNK];
    while bytes < want {
        let take = ((want - bytes) as usize).min(PUSH_CHUNK);
        match file.read(&mut buf[..take]) {
            Ok(0) => return Ok(empty),
            Ok(n) => {
                hasher.update(&buf[..n]);
                bytes += n as u64;
            }
            Err(_) => return Ok(empty),
        }
        keepalive.tick()?;
    }
    Ok(HeldPrefix { bytes, hasher })
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

/// How long a windowed push waits for a credit before giving up.
pub const PUSH_ACK_TIMEOUT: Duration = Duration::from_secs(120);

/// Credits of the windowed pushes in flight, by op id.
pub type PushCredits = Arc<Mutex<HashMap<String, Arc<PushCredit>>>>;

#[derive(Default)]
struct CreditState {
    /// Highest acknowledged seq + 1: acks may arrive out of order or twice.
    acked: u64,
    /// The session is gone: nobody will ever ack again.
    closed: bool,
}

/// Acknowledgements received for one windowed push.
#[derive(Default)]
pub struct PushCredit {
    state: Mutex<CreditState>,
    cv: Condvar,
}

impl PushCredit {
    pub fn ack(&self, seq: u64) {
        let mut state = self.state.lock().expect("credit lock");
        state.acked = state.acked.max(seq.saturating_add(1));
        self.cv.notify_all();
    }

    pub fn close(&self) {
        self.state.lock().expect("credit lock").closed = true;
        self.cv.notify_all();
    }

    /// Blocks until data frame `seq` fits in the window. The timeout restarts on
    /// every credit received: a slow server is fine, a silent one is not.
    fn wait_for(&self, seq: u64, window: u64, timeout: Duration) -> Result<()> {
        let mut state = self.state.lock().expect("credit lock");
        let mut deadline = Instant::now() + timeout;
        let mut seen = state.acked;
        loop {
            if state.closed {
                bail!("session terminée");
            }
            if seq.saturating_sub(state.acked) < window {
                return Ok(());
            }
            if state.acked > seen {
                seen = state.acked;
                deadline = Instant::now() + timeout;
            }
            let now = Instant::now();
            if now >= deadline {
                bail!(
                    "serveur silencieux : accusé de réception attendu depuis {} s",
                    timeout.as_secs()
                );
            }
            state = self
                .cv
                .wait_timeout(state, deadline - now)
                .expect("credit lock")
                .0;
        }
    }
}

/// The acknowledgement window of one push. Dropping it unregisters the op so
/// its credit slot never outlives the push.
pub struct PushWindow {
    size: u64,
    timeout: Duration,
    credit: Arc<PushCredit>,
    op_id: String,
    registry: PushCredits,
}

impl PushWindow {
    pub fn register(registry: &PushCredits, op_id: &str, size: u32, timeout: Duration) -> Self {
        let credit = Arc::new(PushCredit::default());
        registry
            .lock()
            .expect("push credits lock")
            .insert(op_id.to_string(), credit.clone());
        Self {
            size: u64::from(size.max(1)),
            timeout,
            credit,
            op_id: op_id.to_string(),
            registry: registry.clone(),
        }
    }
}

impl Drop for PushWindow {
    fn drop(&mut self) {
        let mut registry = self.registry.lock().expect("push credits lock");
        // A push re-issued under the same op id owns the slot now: leave it be.
        if registry
            .get(&self.op_id)
            .is_some_and(|c| Arc::ptr_eq(c, &self.credit))
        {
            registry.remove(&self.op_id);
        }
    }
}

/// What an encrypted push needs on top of a plain one.
pub struct SealedPush {
    pub keys: Arc<ShareKeys>,
    /// The hash the scan announced, which every block is bound to.
    pub hash: Option<String>,
    pub resume: Option<SyncPushResume>,
}

/// The server's partial of an encrypted push does not encrypt the file as it
/// is now: building on it would store a blob that opens to another content.
#[derive(Debug)]
pub struct StalePartial;

impl std::fmt::Display for StalePartial {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("fichier modifié depuis le début du transfert : il repartira de zéro")
    }
}

impl std::error::Error for StalePartial {}

/// Lit un fichier local en chunks sur un thread dédié et les streame.
#[allow(clippy::too_many_arguments)]
pub fn spawn_push(
    op_id: String,
    root: PathBuf,
    rel_path: String,
    start_offset: u64,
    rate_up_bps: Option<u64>,
    window: Option<PushWindow>,
    sealed: Option<SealedPush>,
    tx: Sender<SyncEvent>,
) {
    std::thread::spawn(move || {
        let _busy = crate::live_status::begin(crate::live_status::Task::SyncTransfer);
        let mut next_seq = 0u64;
        let outcome = match &sealed {
            Some(sealed) => push_sealed(
                &op_id,
                &root,
                &rel_path,
                start_offset,
                sealed,
                rate_up_bps,
                window.as_ref(),
                &mut next_seq,
                &tx,
            ),
            None => push(
                &op_id,
                &root,
                &rel_path,
                start_offset,
                rate_up_bps,
                window.as_ref(),
                &mut next_seq,
                &tx,
            ),
        };
        if let Err(e) = outcome {
            let stale = e.downcast_ref::<StalePartial>().is_some();
            let _ = tx.blocking_send(SyncEvent::Chunk {
                op_id,
                data: Vec::new(),
                done: true,
                hash: None,
                size: None,
                mtime: None,
                error: Some(error_text(&e)),
                seq: window.as_ref().map(|_| next_seq),
                stale_partial: stale,
            });
        }
    });
}

/// Reads until `buf` is full, short only at the end of the file.
fn read_full(file: &mut std::fs::File, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        match file.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(filled)
}

/// One data frame of a push, within the window and the rate cap.
fn send_push_frame(
    op_id: &str,
    data: Vec<u8>,
    window: Option<&PushWindow>,
    throttle: &mut Option<UploadThrottle>,
    next_seq: &mut u64,
    tx: &Sender<SyncEvent>,
) -> Result<()> {
    if let Some(w) = window {
        w.credit.wait_for(*next_seq, w.size, w.timeout)?;
    }
    if let Some(t) = throttle.as_mut() {
        t.take(data.len() as u64);
    }
    tx.blocking_send(SyncEvent::Chunk {
        op_id: op_id.to_string(),
        data,
        done: false,
        hash: None,
        size: None,
        mtime: None,
        error: None,
        seq: window.map(|_| *next_seq),
        stale_partial: false,
    })
    .map_err(|_| anyhow::anyhow!("session terminée"))?;
    *next_seq += 1;
    Ok(())
}

/// An encrypted push. The whole file is read even on a resume: its keyed name
/// covers all of it, and the server cannot check it. The blocks the server
/// kept are re-sealed under their own nonces and their tags compared, so a
/// file changed since the first attempt never ends up spliced; the rest goes
/// out under fresh random nonces, which a retry therefore never reuses.
#[allow(clippy::too_many_arguments)]
fn push_sealed(
    op_id: &str,
    root: &Path,
    rel_path: &str,
    start_offset: u64,
    sealed: &SealedPush,
    rate_up_bps: Option<u64>,
    window: Option<&PushWindow>,
    next_seq: &mut u64,
    tx: &Sender<SyncEvent>,
) -> Result<()> {
    let Some(expected) = sealed.hash.as_deref() else {
        bail!("hash attendu absent : serveur trop ancien pour un partage chiffré");
    };
    let keys = &sealed.keys;
    let name = e2e::name_bytes(expected)?;
    let path = confined_join(root, rel_path)?;
    let mut file =
        std::fs::File::open(&path).with_context(|| format!("ouverture de {rel_path}"))?;
    let mtime = mtime_millis(&file.metadata().context("métadonnées illisibles")?);

    if !start_offset.is_multiple_of(BLOCK as u64) {
        bail!("reprise hors d'une frontière de bloc ({start_offset})");
    }
    let kept = (start_offset / BLOCK as u64) as usize;
    let b64 = &base64::engine::general_purpose::STANDARD;
    let (header, blob_id, nonces, tags) = if kept == 0 {
        let header = e2e::new_header();
        (
            Some(header),
            e2e::parse_header(&header)?,
            Vec::new(),
            String::new(),
        )
    } else {
        let Some(resume) = &sealed.resume else {
            bail!("reprise demandée sans l'état du partiel");
        };
        let header = b64
            .decode(resume.header.as_bytes())
            .map_err(|_| anyhow::anyhow!("en-tête de reprise illisible"))?;
        let nonces = b64
            .decode(resume.nonces.as_bytes())
            .map_err(|_| anyhow::anyhow!("nonces de reprise illisibles"))?;
        if nonces.len() != kept * NONCE_LEN {
            bail!(
                "reprise incohérente ({kept} blocs, {} octets de nonces)",
                nonces.len()
            );
        }
        (
            None,
            e2e::parse_header(&header)?,
            nonces,
            resume.tags.clone(),
        )
    };

    let mut hasher = ContentHasher::new(Some(keys));
    let mut keepalive = Keepalive::new(tx.clone(), op_id);
    let mut buf = vec![0u8; BLOCK];
    if kept > 0 {
        let mut digest = TagDigest::new();
        for (index, nonce) in nonces.chunks(NONCE_LEN).enumerate() {
            if read_full(&mut file, &mut buf).with_context(|| format!("lecture de {rel_path}"))?
                < BLOCK
            {
                return Err(StalePartial.into());
            }
            hasher.update(&buf);
            let nonce: [u8; NONCE_LEN] = nonce.try_into().expect("chunks of NONCE_LEN");
            digest.add(&keys.seal_block(&blob_id, &name, index as u64, false, nonce, &buf));
            keepalive.tick()?;
        }
        if digest.finish() != tags {
            return Err(StalePartial.into());
        }
    }

    let mut throttle = rate_up_bps.filter(|b| *b > 0).map(UploadThrottle::new);
    let mut out: Vec<u8> = header.map(|h| h.to_vec()).unwrap_or_default();
    let mut index = kept as u64;
    let mut size = start_offset;
    loop {
        let n = read_full(&mut file, &mut buf).with_context(|| format!("lecture de {rel_path}"))?;
        // Every block but the last carries a full BLOCK: a file that ends on a
        // boundary still gets an empty last block.
        let last = n < BLOCK;
        hasher.update(&buf[..n]);
        size += n as u64;
        out.extend(keys.seal_block(&blob_id, &name, index, last, e2e::random_nonce(), &buf[..n]));
        index += 1;
        while out.len() >= PUSH_CHUNK {
            let rest = out.split_off(PUSH_CHUNK);
            send_push_frame(
                op_id,
                std::mem::replace(&mut out, rest),
                window,
                &mut throttle,
                next_seq,
                tx,
            )?;
        }
        if last {
            break;
        }
    }
    if !out.is_empty() {
        send_push_frame(op_id, out, window, &mut throttle, next_seq, tx)?;
    }
    tx.blocking_send(SyncEvent::Chunk {
        op_id: op_id.to_string(),
        data: Vec::new(),
        done: true,
        hash: Some(hasher.finish()),
        size: Some(size),
        mtime: Some(mtime),
        error: None,
        seq: window.map(|_| *next_seq),
        stale_partial: false,
    })
    .map_err(|_| anyhow::anyhow!("session terminée"))?;
    Ok(())
}

/// `next_seq` is the rank of the next frame, left at the failed one on error.
#[allow(clippy::too_many_arguments)]
fn push(
    op_id: &str,
    root: &Path,
    rel_path: &str,
    start_offset: u64,
    rate_up_bps: Option<u64>,
    window: Option<&PushWindow>,
    next_seq: &mut u64,
    tx: &Sender<SyncEvent>,
) -> Result<()> {
    let path = confined_join(root, rel_path)?;
    let mut file =
        std::fs::File::open(&path).with_context(|| format!("ouverture de {rel_path}"))?;
    let meta = file.metadata().context("métadonnées illisibles")?;
    let mtime = mtime_millis(&meta);

    let len = meta.len();
    if start_offset > len {
        bail!("fichier raccourci depuis le scan ({len} octets, reprise demandée à {start_offset})");
    }
    if start_offset > 0 {
        file.seek(std::io::SeekFrom::Start(start_offset))
            .with_context(|| format!("positionnement dans {rel_path}"))?;
    }
    // A resumed push hashes nothing: it has not read what the server already
    // holds, and the server verifies the whole blob at finalize anyway.
    let mut hasher = (start_offset == 0).then(Sha256::new);
    let mut sent: u64 = 0;

    let mut throttle = rate_up_bps.filter(|b| *b > 0).map(UploadThrottle::new);
    let mut buf = vec![0u8; PUSH_CHUNK];
    loop {
        let n = file
            .read(&mut buf)
            .with_context(|| format!("lecture de {rel_path}"))?;
        if n == 0 {
            break;
        }
        if let Some(h) = hasher.as_mut() {
            h.update(&buf[..n]);
        }
        sent += n as u64;
        if let Some(w) = window {
            w.credit.wait_for(*next_seq, w.size, w.timeout)?;
        }
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
            seq: window.map(|_| *next_seq),
            stale_partial: false,
        })
        .map_err(|_| anyhow::anyhow!("session terminée"))?;
        *next_seq += 1;
    }
    // The terminal frame is sent without waiting for credit.
    tx.blocking_send(SyncEvent::Chunk {
        op_id: op_id.to_string(),
        data: Vec::new(),
        done: true,
        hash: hasher.map(|h| format!("{:x}", h.finalize())),
        size: Some(start_offset + sent),
        mtime: Some(mtime),
        error: None,
        seq: window.map(|_| *next_seq),
        stale_partial: false,
    })
    .map_err(|_| anyhow::anyhow!("session terminée"))?;
    Ok(())
}

/// One `sync.applyChunk` frame as received; the worker decodes `data`.
pub struct ApplyFrame {
    pub op_id: String,
    pub rel_path: String,
    pub seq: u64,
    /// Base64 as received: decoded by the worker, off the loop.
    pub data: String,
    pub done: bool,
    pub expected_hash: String,
    pub expected_size: u64,
    pub mtime: i64,
    pub mode: Option<u32>,
    pub resume_from: u64,
}

/// Frames queued for one download worker. The server keeps at most its window
/// (4) in flight: more than this is a protocol violation, not backpressure.
pub const APPLY_QUEUE: usize = 16;
/// Downloads in progress at once, across shares.
pub const MAX_APPLY_OPS: usize = 32;
/// Partials untouched for this long are abandoned transfers (mirror of the
/// server's `PARTIAL_MAX_AGE_MS`).
pub const PARTIAL_KEEP_DAYS: u64 = 7;

/// Index caches shared between the loop (invalidation) and the download
/// workers (freshness guard at install), loaded once per session and share.
pub type SharedCaches = Arc<Mutex<HashMap<i64, Arc<IndexCache>>>>;

pub fn cache_for(caches: &SharedCaches, share_id: i64) -> Arc<IndexCache> {
    if let Some(cache) = caches.lock().expect("caches lock").get(&share_id) {
        return Arc::clone(cache);
    }
    // Loaded outside the lock: a disk read under it would stall every worker.
    let loaded = Arc::new(IndexCache::load(share_id));
    Arc::clone(
        caches
            .lock()
            .expect("caches lock")
            .entry(share_id)
            .or_insert(loaded),
    )
}

/// Forgets a share's cache: called when a scan is about to rewrite the file.
pub fn invalidate_cache(caches: &SharedCaches, share_id: i64) {
    caches.lock().expect("caches lock").remove(&share_id);
}

/// A download being installed (sequential chunks, verified at the end).
struct ApplyState {
    /// Open until the final frame is verified: Windows refuses to rename an
    /// open file.
    file: Option<std::fs::File>,
    tmp_path: PathBuf,
    hasher: ContentHasher,
    written: u64,
    next_seq: u64,
    /// Encrypted share: the frames carry the sealed blob, opened here.
    unsealer: Option<Unsealer>,
}

/// Why a download failed, and what it means for the partial.
enum ApplyFailure {
    /// Hash or size mismatch: the partial is worthless.
    Corrupt(String),
    /// Anything else (write error, locked target, stale local file): the bytes
    /// written so far are a valid prefix, kept for a later resume.
    Retryable(String),
}

impl ApplyFailure {
    fn message(&self) -> &str {
        match self {
            Self::Corrupt(m) | Self::Retryable(m) => m,
        }
    }

    fn retry(e: anyhow::Error) -> Self {
        Self::Retryable(error_text(&e))
    }

    fn corrupt(e: anyhow::Error) -> Self {
        Self::Corrupt(error_text(&e))
    }
}

/// Installs one download on its own thread: frames arrive through `frames` in
/// order, acks and the outcome leave through `tx`. The worker ends with the
/// final frame, on a failure, or when the loop drops its sender (end of
/// session). The partial stays in every case but wrong content.
pub fn spawn_apply(
    op_id: String,
    share_id: i64,
    root: PathBuf,
    caches: SharedCaches,
    keys: Option<Arc<ShareKeys>>,
    mut frames: Receiver<ApplyFrame>,
    tx: Sender<SyncEvent>,
) {
    std::thread::spawn(move || {
        let _busy = crate::live_status::begin(crate::live_status::Task::SyncTransfer);
        let mut keepalive = Keepalive::new(tx.clone(), &op_id);
        let mut state: Option<ApplyState> = None;
        while let Some(frame) = frames.blocking_recv() {
            let seq = frame.seq;
            let target = ApplyTarget {
                share_id,
                root: &root,
                caches: &caches,
                keys: keys.as_ref(),
            };
            match apply_frame(&mut state, &target, frame, &mut keepalive) {
                Ok(false) => {
                    let ack = SyncEvent::Ack {
                        op_id: op_id.clone(),
                        seq,
                    };
                    if tx.blocking_send(ack).is_err() {
                        return;
                    }
                }
                Ok(true) => {
                    let _ = tx.blocking_send(SyncEvent::Ack {
                        op_id: op_id.clone(),
                        seq,
                    });
                    let _ = tx.blocking_send(apply_result(&op_id, None));
                    return;
                }
                Err(failure) => {
                    let error = Some(failure.message().to_string());
                    let _ = tx.blocking_send(apply_result(&op_id, error));
                    return;
                }
            }
        }
    });
}

fn apply_result(op_id: &str, error: Option<String>) -> SyncEvent {
    SyncEvent::OpResult {
        op_id: op_id.to_string(),
        op: "apply",
        ok: error.is_none(),
        resume_from: None,
        error,
    }
}

/// Where a download lands, and how its share names and seals content.
struct ApplyTarget<'a> {
    share_id: i64,
    root: &'a Path,
    caches: &'a SharedCaches,
    keys: Option<&'a Arc<ShareKeys>>,
}

/// One frame; on a failure the partial is settled here, so the caller only
/// reports. `Ok(true)` = final frame installed, `Ok(false)` = chunk written.
fn apply_frame(
    state: &mut Option<ApplyState>,
    target: &ApplyTarget,
    frame: ApplyFrame,
    keepalive: &mut Keepalive,
) -> Result<bool, ApplyFailure> {
    let outcome = apply_inner(state, target, &frame, keepalive);
    if let Err(failure) = &outcome {
        if let Some(st) = state.take() {
            drop(st.file);
            settle_partial(&st.tmp_path, st.written, failure);
        }
    }
    outcome
}

fn apply_inner(
    state: &mut Option<ApplyState>,
    target: &ApplyTarget,
    frame: &ApplyFrame,
    keepalive: &mut Keepalive,
) -> Result<bool, ApplyFailure> {
    if state.is_none() {
        if frame.seq != 0 {
            return Err(ApplyFailure::Retryable(format!(
                "premier chunk inattendu (seq {})",
                frame.seq
            )));
        }
        *state = Some(open_partial(target.root, frame, target.keys, keepalive)?);
    }
    let st = state.as_mut().expect("opened above");
    if frame.seq != st.next_seq {
        return Err(ApplyFailure::Retryable(format!(
            "chunk hors séquence ({}, attendu {})",
            frame.seq, st.next_seq
        )));
    }
    st.next_seq += 1;
    let file = st
        .file
        .as_mut()
        .ok_or_else(|| ApplyFailure::Retryable("partiel déjà fermé".to_string()))?;

    let data = base64::engine::general_purpose::STANDARD
        .decode(frame.data.as_bytes())
        .map_err(|_| ApplyFailure::Retryable("chunk illisible (base64)".to_string()))?;
    let mut plain = match st.unsealer.as_mut() {
        Some(unsealer) => unsealer.push(&data).map_err(ApplyFailure::corrupt)?,
        None => data,
    };
    if frame.done {
        if let Some(unsealer) = st.unsealer.take() {
            plain.extend(unsealer.finish().map_err(ApplyFailure::corrupt)?);
        }
    }
    if !plain.is_empty() {
        file.write_all(&plain)
            .context("écriture du chunk")
            .map_err(ApplyFailure::retry)?;
        st.hasher.update(&plain);
        st.written += plain.len() as u64;
    }
    if !frame.done {
        return Ok(false);
    }

    // Final frame: verify everything BEFORE touching the target.
    file.sync_all()
        .context("fsync du temporaire")
        .map_err(ApplyFailure::retry)?;
    let actual = st.hasher.clone().finish();
    if actual != frame.expected_hash || st.written != frame.expected_size {
        return Err(ApplyFailure::Corrupt(
            "contenu reçu invalide (hash ou taille inattendus)".to_string(),
        ));
    }
    // Closed before the rename: Windows refuses to rename an open file.
    st.file = None;
    install(
        target.root,
        target.share_id,
        target.caches,
        &st.tmp_path,
        frame,
    )?;
    *state = None;
    Ok(true)
}

/// Opens the op's partial, resumed at the point the SERVER decided
/// (`resume_from`): obeying it rather than our own size keeps both sides
/// counting the same bytes, and the partial is trimmed accordingly.
fn open_partial(
    root: &Path,
    frame: &ApplyFrame,
    keys: Option<&Arc<ShareKeys>>,
    keepalive: &mut Keepalive,
) -> Result<ApplyState, ApplyFailure> {
    // Named by HASH, not by `opId`: that is what lets the next cycle find it.
    let tmp_path = partial_path(root, &frame.expected_hash).map_err(ApplyFailure::retry)?;
    let held = resumable_prefix(&tmp_path, frame.resume_from, keys.map(|k| &**k), keepalive)
        .map_err(ApplyFailure::retry)?;
    // A sealed stream starts at the block of `resume_from`, which the server
    // aligned on a block: a prefix held short of it cannot be completed.
    let unsealer = match keys {
        Some(keys) => {
            if !frame.resume_from.is_multiple_of(BLOCK as u64) || held.bytes != frame.resume_from {
                return Err(ApplyFailure::Corrupt(
                    "partiel local inutilisable : le téléchargement repart de zéro".to_string(),
                ));
            }
            let name = e2e::name_bytes(&frame.expected_hash).map_err(ApplyFailure::retry)?;
            Some(Unsealer::new(
                Arc::clone(keys),
                name,
                frame.resume_from / BLOCK as u64,
            ))
        }
        None => None,
    };
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(held.bytes == 0)
        .open(&tmp_path)
        .context("ouverture du fichier temporaire")
        .map_err(ApplyFailure::retry)?;
    if held.bytes > 0 {
        file.set_len(held.bytes)
            .context("troncature du temporaire au point de reprise")
            .map_err(ApplyFailure::retry)?;
        file.seek(std::io::SeekFrom::Start(held.bytes))
            .context("positionnement pour la reprise")
            .map_err(ApplyFailure::retry)?;
    }
    Ok(ApplyState {
        file: Some(file),
        tmp_path,
        hasher: held.hasher,
        written: held.bytes,
        next_seq: 0,
        unsealer,
    })
}

/// The verified partial becomes the target: freshness guard, parents, mtime,
/// mode, owner, then the atomic rename.
fn install(
    root: &Path,
    share_id: i64,
    caches: &SharedCaches,
    tmp_path: &Path,
    frame: &ApplyFrame,
) -> Result<(), ApplyFailure> {
    let dest = confined_join(root, &frame.rel_path).map_err(ApplyFailure::retry)?;

    // Overwrite guard: a target that changed since the scan behind this
    // download holds an unsynced local edit. Refuse the install; the next scan
    // turns the divergence into a conflict, the loser archived server side.
    if let Ok(meta) = std::fs::symlink_metadata(&dest) {
        if meta.is_file() && !unchanged_since_scan(caches, share_id, &frame.rel_path, &meta) {
            return Err(ApplyFailure::Retryable(
                "le fichier local a changé depuis le scan : installation reportée (conflit au prochain cycle)"
                    .to_string(),
            ));
        }
    }

    create_parents_owned(root, &dest).map_err(ApplyFailure::retry)?;
    let ft = FileTime::from_unix_time(
        frame.mtime / 1000,
        ((frame.mtime % 1000) * 1_000_000) as u32,
    );
    let _ = filetime::set_file_mtime(tmp_path, ft);
    // The mode goes on the TEMPORARY file: the target never exists in an
    // intermediate state with the wrong permissions.
    apply_mode(tmp_path, frame.mode);
    adopt_owner(root, tmp_path);
    rename_with_retry(tmp_path, &dest)
        .context("installation")
        .map_err(ApplyFailure::retry)?;
    debug!(rel_path = %frame.rel_path, "sync: fichier installé");
    Ok(())
}

/// Does this local path still match what the last scan saw (size, mtime)? A
/// path the cache does not know counts as changed: when in doubt, keep it.
fn unchanged_since_scan(
    caches: &SharedCaches,
    share_id: i64,
    rel_path: &str,
    meta: &std::fs::Metadata,
) -> bool {
    cache_for(caches, share_id)
        .entries
        .get(rel_path)
        .is_some_and(|c| c.size == meta.len() && c.mtime == mtime_millis(meta))
}

/// After a failure: a worthless partial goes; a valid prefix is trimmed to
/// what was fully written (an interrupted `write_all` may leave a tail that
/// `held_bytes_for` would otherwise count).
fn settle_partial(tmp_path: &Path, written: u64, failure: &ApplyFailure) {
    match failure {
        ApplyFailure::Corrupt(_) => {
            let _ = std::fs::remove_file(tmp_path);
        }
        ApplyFailure::Retryable(_) => {
            if let Ok(file) = std::fs::OpenOptions::new().write(true).open(tmp_path) {
                let _ = file.set_len(written);
            }
        }
    }
}

/// Runs a local op (copy, move) on its own thread: its source is hashed first,
/// which can be long. The outcome goes back through `tx`.
pub fn spawn_local_op(
    op_id: String,
    op: &'static str,
    tx: Sender<SyncEvent>,
    work: impl FnOnce(&mut Keepalive) -> Result<()> + Send + 'static,
) {
    std::thread::spawn(move || {
        let _busy = crate::live_status::begin(crate::live_status::Task::SyncTransfer);
        let mut keepalive = Keepalive::new(tx.clone(), &op_id);
        let outcome = work(&mut keepalive).map_err(|e| error_text(&e));
        let _ = tx.blocking_send(SyncEvent::OpResult {
            op_id,
            op,
            ok: outcome.is_ok(),
            resume_from: None,
            error: outcome.err(),
        });
    });
}

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

/// Crée les dossiers parents d'une cible ET les rend au propriétaire du
/// partage. `create_dir_all` peut en créer plusieurs d'un coup : les laisser à
/// root donnerait une arborescence que l'utilisateur ne peut pas modifier,
/// alors même que les fichiers dedans lui appartiennent.
fn create_parents_owned(root: &Path, dest: &Path) -> Result<()> {
    let Some(parent) = dest.parent() else {
        return Ok(());
    };
    if parent.exists() {
        return Ok(());
    }
    // Les ancêtres manquants, du plus proche de la racine au plus profond, pour
    // que chacun soit adopté après sa création.
    let mut missing: Vec<&Path> = Vec::new();
    let mut cursor = Some(parent);
    while let Some(dir) = cursor {
        if dir == root || !dir.starts_with(root) || dir.exists() {
            break;
        }
        missing.push(dir);
        cursor = dir.parent();
    }
    std::fs::create_dir_all(parent).context("création des dossiers parents")?;
    for dir in missing.into_iter().rev() {
        adopt_owner(root, dir);
    }
    Ok(())
}

/// Pose les métadonnées d'un chemin sans transférer un seul octet. Deux usages :
///  - une entrée `dir` de l'index (dossier VIDE) : le dossier est créé ;
///  - un `chmod` seul sur un chemin déjà en place, fichier OU dossier.
///
/// Si le chemin existe, on ne touche QUE le mode, quelle que soit sa nature ;
/// un fichier absent arrive toujours par `applyChunk` ou `applyLocal`.
pub fn apply_dir(root: &Path, rel_path: &str, kind: &str, mode: Option<u32>) -> Result<()> {
    let dest = confined_join(root, rel_path)?;
    if std::fs::symlink_metadata(&dest).is_err() {
        // Un `chmod` sur un FICHIER momentanément absent ne doit pas faire
        // naître un dossier à sa place : le planner écarterait ensuite ce chemin
        // pour toujours en « conflit de nature ».
        if kind != "dir" {
            return Ok(());
        }
        std::fs::create_dir_all(&dest).context("création du dossier")?;
    }
    apply_mode(&dest, mode);
    adopt_owner(root, &dest);
    Ok(())
}

/// Le chemin d'une source dont le contenu est celui que le serveur croit :
/// un fichier régulier, de la bonne taille et du bon hash. Vérifié AVANT toute
/// écriture, sans quoi un fichier modifié entre le scan et l'ordre serait
/// installé sous un nom qui promet autre chose.
fn verified_source(
    root: &Path,
    rel_path: &str,
    hash: &str,
    size: u64,
    keys: Option<&ShareKeys>,
    keepalive: &mut Keepalive,
) -> Result<PathBuf> {
    let src = confined_join(root, rel_path)?;
    let meta = std::fs::symlink_metadata(&src).context("source introuvable")?;
    if !meta.is_file() {
        bail!("la source n'est pas un fichier régulier");
    }
    if meta.len() != size {
        bail!("taille de la source inattendue");
    }
    if hash_file(&src, keys, Some(keepalive))? != hash {
        bail!("contenu de la source inattendu");
    }
    Ok(src)
}

/// Installe un contenu déjà présent ailleurs dans le partage, par copie locale.
/// Le hash de la source est VÉRIFIÉ d'abord : sans ça, une source périmée
/// écrirait un contenu faux sous un chemin dont le serveur croit tout savoir.
/// L'install passe par le même temporaire + rename atomique qu'un download.
#[allow(clippy::too_many_arguments)]
pub fn apply_local(
    root: &Path,
    share_id: i64,
    caches: &SharedCaches,
    rel_path: &str,
    source_rel_path: &str,
    content: (&str, u64, Option<&ShareKeys>),
    mtime: i64,
    mode: Option<u32>,
    keepalive: &mut Keepalive,
) -> Result<()> {
    let (hash, size, keys) = content;
    let src = verified_source(root, source_rel_path, hash, size, keys, keepalive)?;

    let dest = confined_join(root, rel_path)?;
    // Same overwrite guard as a download: a local edit since the scan is not ours to erase.
    if let Ok(meta) = std::fs::symlink_metadata(&dest) {
        if meta.is_file() && !unchanged_since_scan(caches, share_id, rel_path, &meta) {
            bail!("le fichier local a changé depuis le scan : copie locale reportée");
        }
    }
    let tmp_dir = root.join(".deveye-tmp");
    std::fs::create_dir_all(&tmp_dir).context("création du dossier temporaire")?;
    let tmp_path = tmp_dir.join(format!("copy-{}.part", uuid_like(rel_path, mtime)));
    // Copier PUIS renommer : jamais de cible à moitié écrite.
    std::fs::copy(&src, &tmp_path).context("copie locale")?;
    create_parents_owned(root, &dest)?;
    let ft = FileTime::from_unix_time(mtime / 1000, ((mtime % 1000) * 1_000_000) as u32);
    let _ = filetime::set_file_mtime(&tmp_path, ft);
    apply_mode(&tmp_path, mode);
    adopt_owner(root, &tmp_path);
    if let Err(e) = rename_with_retry(&tmp_path, &dest) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(e).context("installation");
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
/// Le hash de la source est VÉRIFIÉ d'abord, sans quoi un fichier modifié entre
/// le scan et l'ordre serait déplacé sous un nom que le serveur croit porter un
/// autre contenu. En cas de doute on refuse, et le serveur retombe sur le
/// chemin ordinaire (téléchargement puis corbeille).
#[allow(clippy::too_many_arguments)]
pub fn move_file(
    root: &Path,
    from_rel_path: &str,
    rel_path: &str,
    content: (&str, u64, Option<&ShareKeys>),
    mtime: i64,
    mode: Option<u32>,
    keepalive: &mut Keepalive,
) -> Result<()> {
    let (hash, size, keys) = content;
    let src = verified_source(root, from_rel_path, hash, size, keys, keepalive)?;

    let dest = confined_join(root, rel_path)?;
    if std::fs::symlink_metadata(&dest).is_ok() {
        bail!("la cible existe déjà");
    }
    create_parents_owned(root, &dest)?;
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

/// Moves a file to `.deveye-trash/<timestamp>/<relPath>` (never an unlink),
/// cautiously: a file changed since the scan is not ours to trash (the next
/// scan sees the edit), and a directory only goes if it is really empty (the
/// server only asks for one it saw empty; anything inside appeared since).
pub fn delete_to_trash(
    root: &Path,
    share_id: i64,
    caches: &SharedCaches,
    rel_path: &str,
) -> Result<()> {
    let src = confined_join(root, rel_path)?;
    let Ok(meta) = std::fs::symlink_metadata(&src) else {
        return Ok(()); // Already gone locally: the deletion is idempotent.
    };
    if meta.is_dir() {
        std::fs::remove_dir(&src)
            .context("dossier non vide sur l'appareil : suppression reportée")?;
        prune_empty_parents(root, &src);
        return Ok(());
    }
    if !meta.is_file() {
        bail!("la cible n'est pas un fichier régulier : suppression refusée");
    }
    if !unchanged_since_scan(caches, share_id, rel_path, &meta) {
        bail!("le fichier a changé depuis le scan : suppression reportée");
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

/// Retire les dossiers devenus vides en remontant vers la racine du partage,
/// sans quoi supprimer le dernier fichier d'une arborescence laisserait sa
/// coquille chez tous les pairs. `remove_dir` échoue (et arrête la remontée)
/// dès qu'un dossier n'est pas vide. La racine elle-même n'est jamais touchée.
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

/// Drops the `.deveye-tmp/*.part` files untouched for `max_age_days`
/// (best-effort: a partial a worker still writes is fresh, and Windows refuses
/// to unlink an open file).
pub fn sweep_partials(root: &Path, max_age_days: u64) {
    let Ok(entries) = std::fs::read_dir(root.join(".deveye-tmp")) else {
        return;
    };
    let now = SystemTime::now();
    let max_age = Duration::from_secs(max_age_days * 86_400);
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("part") {
            continue;
        }
        let Ok(modified) = entry.metadata().and_then(|m| m.modified()) else {
            continue;
        };
        if now.duration_since(modified).unwrap_or(Duration::ZERO) > max_age {
            let _ = std::fs::remove_file(&path);
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
        let (mut keepalive, _rx) = keepalive(Duration::MAX);
        assert_eq!(
            resumable_prefix(Path::new("/tmp/deveye-nope.part"), 10, None, &mut keepalive)
                .unwrap()
                .bytes,
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
        // même si le temporaire en contient davantage.
        let (mut keepalive, _rx) = keepalive(Duration::MAX);
        let held = resumable_prefix(&path, 7, None, &mut keepalive).unwrap();
        assert_eq!(held.bytes, 7);
        let expected = format!("{:x}", Sha256::digest(b"bonjour"));
        assert_eq!(held.hasher.finish(), expected);

        // Serveur qui croit l'agent plus avancé qu'il ne l'est : on repart de
        // zéro plutôt que de bâtir sur des octets absents.
        assert_eq!(
            resumable_prefix(&path, 999, None, &mut keepalive)
                .unwrap()
                .bytes,
            0
        );
        assert_eq!(
            resumable_prefix(&path, 0, None, &mut keepalive)
                .unwrap()
                .bytes,
            0
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn created_parents_stay_under_the_share_root() {
        // Créer l'arborescence manquante sans jamais remonter au-dessus de la
        // racine du partage (un `chown` toucherait des dossiers étrangers).
        let root = std::env::temp_dir().join(format!("deveye-parents-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();

        let dest = root.join("a").join("b").join("c.txt");
        create_parents_owned(&root, &dest).unwrap();
        assert!(
            root.join("a").join("b").is_dir(),
            "les parents doivent exister"
        );

        // Idempotent : rappelé sur une arborescence déjà là, il ne casse rien.
        create_parents_owned(&root, &dest).unwrap();
        assert!(root.join("a").join("b").is_dir());

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn apply_dir_never_creates_a_directory_for_a_missing_file() {
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

    /// A share root holding `name` with `chunks` full chunks plus a short tail.
    fn share_with_file(name: &str, chunks: usize) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let bytes: Vec<u8> = (0..chunks * PUSH_CHUNK + 10).map(|i| i as u8).collect();
        std::fs::write(dir.path().join(name), bytes).unwrap();
        dir
    }

    struct Frame {
        done: bool,
        seq: Option<u64>,
        error: Option<String>,
        data_len: usize,
        hash: Option<String>,
        size: Option<u64>,
        mtime: Option<i64>,
    }

    fn next_frame(rx: &mut tokio::sync::mpsc::Receiver<SyncEvent>) -> Frame {
        match rx.blocking_recv().expect("frame") {
            SyncEvent::Chunk {
                done,
                seq,
                error,
                data,
                hash,
                size,
                mtime,
                ..
            } => Frame {
                done,
                seq,
                error,
                data_len: data.len(),
                hash,
                size,
                mtime,
            },
            _ => panic!("expected a chunk"),
        }
    }

    fn sha(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    fn wait_unregistered(registry: &PushCredits, op_id: &str) {
        let started = Instant::now();
        while registry.lock().unwrap().contains_key(op_id) {
            assert!(
                started.elapsed() < Duration::from_secs(2),
                "credit slot leaked"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn windowed_push_never_exceeds_its_window_and_completes_on_acks() {
        let dir = share_with_file("f.bin", 5);
        let registry = PushCredits::default();
        let window = PushWindow::register(&registry, "op", 2, Duration::from_secs(10));
        let credit = registry.lock().unwrap().get("op").cloned().unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        spawn_push(
            "op".into(),
            dir.path().to_path_buf(),
            "f.bin".into(),
            0,
            None,
            Some(window),
            None,
            tx,
        );

        let mut sent = 0u64;
        let mut acked = 0u64;
        loop {
            let frame = next_frame(&mut rx);
            assert_eq!(frame.seq, Some(sent), "frames are numbered in order");
            if frame.done {
                assert!(frame.error.is_none(), "{:?}", frame.error);
                break;
            }
            sent += 1;
            assert!(sent - acked <= 2, "more than the window in flight");
            if sent - acked == 2 {
                std::thread::sleep(Duration::from_millis(50));
                // Only the terminal frame may pass a full window.
                if let Ok(SyncEvent::Chunk { done, seq, .. }) = rx.try_recv() {
                    assert!(
                        done && seq == Some(sent),
                        "no data frame past a full window"
                    );
                    break;
                }
                // A duplicate and a stale ack change nothing.
                credit.ack(acked);
                credit.ack(acked);
                if acked > 0 {
                    credit.ack(acked - 1);
                }
                acked += 1;
            }
        }
        assert_eq!(sent, 6, "five full chunks and the tail");
        wait_unregistered(&registry, "op");
    }

    #[test]
    fn free_push_carries_no_seq_and_never_waits() {
        let dir = share_with_file("f.bin", 3);
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        spawn_push(
            "op".into(),
            dir.path().to_path_buf(),
            "f.bin".into(),
            0,
            None,
            None,
            None,
            tx,
        );
        let mut data = 0;
        loop {
            let frame = next_frame(&mut rx);
            assert_eq!(frame.seq, None);
            if frame.done {
                assert!(frame.error.is_none(), "{:?}", frame.error);
                let content = std::fs::read(dir.path().join("f.bin")).unwrap();
                assert_eq!(
                    frame.hash,
                    Some(sha(&content)),
                    "a full push announces its hash"
                );
                break;
            }
            data += 1;
        }
        assert_eq!(data, 4);
    }

    #[test]
    fn resumed_push_seeks_and_sends_no_hash() {
        let dir = share_with_file("f.bin", 3);
        let len = (3 * PUSH_CHUNK + 10) as u64;
        let start = (PUSH_CHUNK + 5) as u64;
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        spawn_push(
            "op".into(),
            dir.path().to_path_buf(),
            "f.bin".into(),
            start,
            None,
            None,
            None,
            tx,
        );
        let mut sent = 0u64;
        loop {
            let frame = next_frame(&mut rx);
            sent += frame.data_len as u64;
            if frame.done {
                assert!(frame.error.is_none(), "{:?}", frame.error);
                assert_eq!(
                    frame.hash, None,
                    "a resumed push leaves the verdict to the server"
                );
                assert_eq!(frame.size, Some(len));
                assert!(frame.mtime.is_some());
                break;
            }
        }
        assert_eq!(sent, len - start, "only the missing tail crosses the wire");
    }

    #[test]
    fn resumed_push_at_full_length_sends_only_the_terminal_frame() {
        let dir = share_with_file("f.bin", 1);
        let len = (PUSH_CHUNK + 10) as u64;
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        spawn_push(
            "op".into(),
            dir.path().to_path_buf(),
            "f.bin".into(),
            len,
            None,
            None,
            None,
            tx,
        );
        let frame = next_frame(&mut rx);
        assert!(frame.done && frame.error.is_none());
        assert_eq!((frame.data_len, frame.size), (0, Some(len)));
    }

    #[test]
    fn push_refuses_an_offset_past_the_end() {
        let dir = share_with_file("f.bin", 1);
        let len = (PUSH_CHUNK + 10) as u64;
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        spawn_push(
            "op".into(),
            dir.path().to_path_buf(),
            "f.bin".into(),
            len + 1,
            None,
            None,
            None,
            tx,
        );
        let frame = next_frame(&mut rx);
        assert!(frame.done);
        assert_eq!(
            frame.data_len, 0,
            "nothing is sent from offset 0 by mistake"
        );
        assert!(frame.error.unwrap().contains("raccourci"));
    }

    fn keepalive(period: Duration) -> (Keepalive, tokio::sync::mpsc::Receiver<SyncEvent>) {
        let (tx, rx) = tokio::sync::mpsc::channel(64);
        (Keepalive::with_period(tx, "op", period), rx)
    }

    #[test]
    fn resumable_prefix_emits_busy_during_a_long_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.part");
        let bytes = vec![7u8; 4 * PUSH_CHUNK];
        std::fs::write(&path, &bytes).unwrap();
        let (mut keepalive, mut rx) = keepalive(Duration::ZERO);
        let held = resumable_prefix(&path, bytes.len() as u64, None, &mut keepalive).unwrap();
        assert_eq!(held.bytes, bytes.len() as u64);
        assert_eq!(held.hasher.finish(), sha(&bytes));
        match rx.try_recv() {
            Ok(SyncEvent::Busy { op_id }) => assert_eq!(op_id, "op"),
            _ => panic!("expected a busy frame"),
        }
    }

    #[test]
    fn resumable_prefix_aborts_untouched_when_the_session_is_gone() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.part");
        let bytes = vec![7u8; 2 * PUSH_CHUNK];
        std::fs::write(&path, &bytes).unwrap();
        let (mut keepalive, rx) = keepalive(Duration::ZERO);
        drop(rx);
        assert!(resumable_prefix(&path, bytes.len() as u64, None, &mut keepalive).is_err());
        assert_eq!(
            std::fs::metadata(&path).unwrap().len(),
            bytes.len() as u64,
            "the partial is left alone"
        );
    }

    /// A worker for `op` on `root`: its frame sender and the event receiver.
    fn worker(
        root: &Path,
        op: &str,
    ) -> (
        tokio::sync::mpsc::Sender<ApplyFrame>,
        tokio::sync::mpsc::Receiver<SyncEvent>,
    ) {
        let (frames_tx, frames_rx) = tokio::sync::mpsc::channel(APPLY_QUEUE);
        let (tx, rx) = tokio::sync::mpsc::channel(64);
        spawn_apply(
            op.into(),
            1,
            root.to_path_buf(),
            SharedCaches::default(),
            None,
            frames_rx,
            tx,
        );
        (frames_tx, rx)
    }

    fn apply_frame_for(
        op: &str,
        seq: u64,
        data: &[u8],
        done: bool,
        hash: &str,
        size: u64,
    ) -> ApplyFrame {
        ApplyFrame {
            op_id: op.into(),
            rel_path: "a.bin".into(),
            seq,
            data: base64::engine::general_purpose::STANDARD.encode(data),
            done,
            expected_hash: hash.into(),
            expected_size: size,
            mtime: 1_700_000_000_000,
            mode: None,
            resume_from: 0,
        }
    }

    fn expect_ack(rx: &mut tokio::sync::mpsc::Receiver<SyncEvent>, expected: u64) {
        match rx.blocking_recv().expect("event") {
            SyncEvent::Ack { seq, .. } => assert_eq!(seq, expected),
            _ => panic!("expected ack {expected}"),
        }
    }

    fn expect_result(rx: &mut tokio::sync::mpsc::Receiver<SyncEvent>) -> (bool, Option<String>) {
        match rx.blocking_recv().expect("event") {
            SyncEvent::OpResult { op, ok, error, .. } => {
                assert_eq!(op, "apply");
                (ok, error)
            }
            _ => panic!("expected an op result"),
        }
    }

    fn partial_of(root: &Path, hash: &str) -> PathBuf {
        root.join(".deveye-tmp").join(format!("{hash}.part"))
    }

    fn sample() -> (Vec<u8>, String) {
        let content: Vec<u8> = (0..300u32).map(|i| i as u8).collect();
        let hash = sha(&content);
        (content, hash)
    }

    #[test]
    fn a_dropped_worker_keeps_its_partial() {
        let dir = tempfile::tempdir().unwrap();
        let (content, hash) = sample();
        let (frames, mut rx) = worker(dir.path(), "op");
        frames
            .blocking_send(apply_frame_for("op", 0, &content[..100], false, &hash, 300))
            .unwrap();
        expect_ack(&mut rx, 0);
        // End of session: the worker leaves, and its channel closes with it.
        drop(frames);
        assert!(rx.blocking_recv().is_none());
        assert_eq!(
            std::fs::metadata(partial_of(dir.path(), &hash))
                .unwrap()
                .len(),
            100
        );
    }

    #[test]
    fn a_corrupt_final_frame_removes_the_partial() {
        let dir = tempfile::tempdir().unwrap();
        let (content, _) = sample();
        let wrong = sha(b"something else");
        let (frames, mut rx) = worker(dir.path(), "op");
        frames
            .blocking_send(apply_frame_for("op", 0, &content, false, &wrong, 300))
            .unwrap();
        expect_ack(&mut rx, 0);
        frames
            .blocking_send(apply_frame_for("op", 1, &[], true, &wrong, 300))
            .unwrap();
        let (ok, error) = expect_result(&mut rx);
        assert!(!ok);
        assert!(error.unwrap().contains("invalide"));
        assert!(!partial_of(dir.path(), &wrong).exists());
        assert!(!dir.path().join("a.bin").exists());
    }

    #[test]
    fn a_stale_local_target_keeps_the_verified_partial() {
        let dir = tempfile::tempdir().unwrap();
        // A target the index cache knows nothing about: an unsynced local edit.
        std::fs::write(dir.path().join("a.bin"), b"local edit").unwrap();
        let (content, hash) = sample();
        let (frames, mut rx) = worker(dir.path(), "op");
        frames
            .blocking_send(apply_frame_for("op", 0, &content, false, &hash, 300))
            .unwrap();
        expect_ack(&mut rx, 0);
        frames
            .blocking_send(apply_frame_for("op", 1, &[], true, &hash, 300))
            .unwrap();
        let (ok, error) = expect_result(&mut rx);
        assert!(!ok);
        assert!(error.unwrap().contains("a changé"));
        assert_eq!(
            std::fs::read(dir.path().join("a.bin")).unwrap(),
            b"local edit"
        );
        assert_eq!(
            std::fs::metadata(partial_of(dir.path(), &hash))
                .unwrap()
                .len(),
            300,
            "the verified content waits for the next cycle"
        );
    }

    #[test]
    fn sweep_partials_only_drops_old_part_files() {
        let dir = tempfile::tempdir().unwrap();
        let tmp = dir.path().join(".deveye-tmp");
        std::fs::create_dir_all(&tmp).unwrap();
        for name in ["old.part", "fresh.part", "old.txt"] {
            std::fs::write(tmp.join(name), b"x").unwrap();
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let eight_days_ago = FileTime::from_unix_time(now - 8 * 86_400, 0);
        for name in ["old.part", "old.txt"] {
            filetime::set_file_mtime(tmp.join(name), eight_days_ago).unwrap();
        }
        sweep_partials(dir.path(), PARTIAL_KEEP_DAYS);
        assert!(!tmp.join("old.part").exists());
        assert!(tmp.join("fresh.part").exists());
        assert!(tmp.join("old.txt").exists(), "only partials are swept");
    }

    #[test]
    fn silent_server_fails_the_push() {
        let dir = share_with_file("f.bin", 3);
        let registry = PushCredits::default();
        let window = PushWindow::register(&registry, "op", 1, Duration::from_millis(100));
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        spawn_push(
            "op".into(),
            dir.path().to_path_buf(),
            "f.bin".into(),
            0,
            None,
            Some(window),
            None,
            tx,
        );
        let first = next_frame(&mut rx);
        assert_eq!((first.done, first.seq), (false, Some(0)));
        let failed = next_frame(&mut rx);
        assert!(failed.done);
        assert_eq!(failed.seq, Some(1), "the error frame is numbered too");
        assert!(
            failed.error.unwrap().contains("serveur silencieux"),
            "the failure says the server went quiet"
        );
        wait_unregistered(&registry, "op");
    }

    #[test]
    fn credit_takes_the_highest_ack_and_wakes_on_close() {
        let credit = PushCredit::default();
        credit.ack(3);
        credit.ack(1);
        assert!(credit.wait_for(5, 2, Duration::ZERO).is_ok());
        assert!(credit.wait_for(6, 2, Duration::ZERO).is_err());

        let credit = Arc::new(PushCredit::default());
        let closer = credit.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            closer.close();
        });
        let started = Instant::now();
        let err = credit.wait_for(1, 1, Duration::from_secs(10)).unwrap_err();
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(err.to_string(), "session terminée");
    }

    const CACHE_SHARE: i64 = 987_654;

    /// Caches for `CACHE_SHARE` holding exactly one entry (none when `entry` is `None`).
    fn caches_with(entry: Option<(&str, u64, i64)>) -> SharedCaches {
        let caches = SharedCaches::default();
        let mut cache = IndexCache::default();
        if let Some((rel, size, mtime)) = entry {
            cache.entries.insert(
                rel.to_string(),
                crate::sync::index_cache::CacheEntry {
                    size,
                    mtime,
                    hash: String::new(),
                    kind: "file".to_string(),
                    mode: None,
                },
            );
        }
        caches.lock().unwrap().insert(CACHE_SHARE, Arc::new(cache));
        caches
    }

    #[test]
    fn delete_to_trash_refuses_a_file_changed_since_the_scan() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("x.txt");
        std::fs::write(&file, b"hello").unwrap();
        let meta = std::fs::metadata(&file).unwrap();

        let stale = caches_with(Some(("x.txt", meta.len() + 1, mtime_millis(&meta))));
        let err = delete_to_trash(dir.path(), CACHE_SHARE, &stale, "x.txt").unwrap_err();
        assert!(error_text(&err).contains("a changé"), "{err}");
        assert!(file.exists());

        let fresh = caches_with(Some(("x.txt", meta.len(), mtime_millis(&meta))));
        delete_to_trash(dir.path(), CACHE_SHARE, &fresh, "x.txt").unwrap();
        assert!(!file.exists());
        let stamp = std::fs::read_dir(dir.path().join(".deveye-trash"))
            .unwrap()
            .flatten()
            .next()
            .expect("a stamp dir");
        assert!(stamp.path().join("x.txt").exists());
    }

    #[test]
    fn delete_to_trash_refuses_a_path_absent_from_the_cache() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("x.txt"), b"hello").unwrap();
        let err =
            delete_to_trash(dir.path(), CACHE_SHARE, &caches_with(None), "x.txt").unwrap_err();
        assert!(error_text(&err).contains("a changé"), "{err}");
        assert!(dir.path().join("x.txt").exists());
    }

    #[test]
    fn delete_to_trash_removes_only_an_empty_dir() {
        let dir = tempfile::tempdir().unwrap();
        let full = dir.path().join("full");
        std::fs::create_dir(&full).unwrap();
        std::fs::write(full.join("f.txt"), b"f").unwrap();
        let caches = caches_with(None);
        let err = delete_to_trash(dir.path(), CACHE_SHARE, &caches, "full").unwrap_err();
        assert!(error_text(&err).contains("non vide"), "{err}");
        assert!(full.join("f.txt").exists());

        std::fs::create_dir(dir.path().join("empty")).unwrap();
        delete_to_trash(dir.path(), CACHE_SHARE, &caches, "empty").unwrap();
        assert!(!dir.path().join("empty").exists());
    }

    #[test]
    fn error_text_joins_the_cause_chain() {
        let err = anyhow::anyhow!("Permission denied").context("installation");
        assert_eq!(error_text(&err), "installation : Permission denied");
    }

    /// Every frame of a push until the terminal one: data bytes, then the end.
    fn collect_push(rx: &mut tokio::sync::mpsc::Receiver<SyncEvent>) -> (Vec<u8>, SyncEvent) {
        let mut data = Vec::new();
        loop {
            match rx.blocking_recv().expect("frame") {
                SyncEvent::Chunk {
                    data: bytes,
                    done: false,
                    ..
                } => data.extend(bytes),
                SyncEvent::Busy { .. } => {}
                end => return (data, end),
            }
        }
    }

    fn sealed_keys() -> Arc<ShareKeys> {
        Arc::new(ShareKeys::from_secret(&[4u8; e2e::SECRET_LEN]))
    }

    fn keyed_name(keys: &ShareKeys, content: &[u8]) -> String {
        let mut h = ContentHasher::new(Some(keys));
        h.update(content);
        h.finish()
    }

    fn push_sealed_file(
        dir: &Path,
        keys: &Arc<ShareKeys>,
        hash: &str,
        start: u64,
        resume: Option<SyncPushResume>,
    ) -> (Vec<u8>, SyncEvent) {
        let (tx, mut rx) = tokio::sync::mpsc::channel(256);
        spawn_push(
            "op".into(),
            dir.to_path_buf(),
            "f.bin".into(),
            start,
            None,
            None,
            Some(SealedPush {
                keys: Arc::clone(keys),
                hash: Some(hash.to_string()),
                resume,
            }),
            tx,
        );
        collect_push(&mut rx)
    }

    /// Nonces and tag digest of the first `blocks` blocks of a sealed blob.
    fn resume_of(sealed: &[u8], blocks: usize) -> SyncPushResume {
        let b64 = &base64::engine::general_purpose::STANDARD;
        let mut nonces = Vec::new();
        let mut digest = TagDigest::new();
        for i in 0..blocks {
            let at = e2e::HEADER_LEN + i * e2e::SEALED_FULL;
            let block = &sealed[at..at + e2e::SEALED_FULL];
            nonces.extend_from_slice(&block[..NONCE_LEN]);
            digest.add(block);
        }
        SyncPushResume {
            header: b64.encode(&sealed[..e2e::HEADER_LEN]),
            nonces: b64.encode(nonces),
            tags: digest.finish(),
        }
    }

    #[test]
    fn a_sealed_push_installs_through_a_sealed_apply() {
        let src = tempfile::tempdir().unwrap();
        let content: Vec<u8> = (0..2 * BLOCK + 77).map(|i| (i % 253) as u8).collect();
        std::fs::write(src.path().join("f.bin"), &content).unwrap();
        let keys = sealed_keys();
        let hash = keyed_name(&keys, &content);

        let (sealed, end) = push_sealed_file(src.path(), &keys, &hash, 0, None);
        let SyncEvent::Chunk {
            hash: announced,
            size,
            error: None,
            ..
        } = end
        else {
            panic!("push failed");
        };
        assert_eq!(announced.as_deref(), Some(hash.as_str()));
        assert_eq!(size, Some(content.len() as u64));
        assert!(
            !sealed.windows(64).any(|w| w == &content[..64]),
            "no plaintext on the wire"
        );

        let dest = tempfile::tempdir().unwrap();
        let (frames_tx, frames_rx) = tokio::sync::mpsc::channel(APPLY_QUEUE);
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        spawn_apply(
            "op".into(),
            1,
            dest.path().to_path_buf(),
            SharedCaches::default(),
            Some(Arc::clone(&keys)),
            frames_rx,
            tx,
        );
        let parts: Vec<&[u8]> = sealed.chunks(PUSH_CHUNK).collect();
        for (seq, part) in parts.iter().enumerate() {
            let frame = ApplyFrame {
                expected_size: content.len() as u64,
                ..apply_frame_for("op", seq as u64, part, false, &hash, 0)
            };
            frames_tx.blocking_send(frame).unwrap();
            expect_ack(&mut rx, seq as u64);
        }
        let last = ApplyFrame {
            expected_size: content.len() as u64,
            ..apply_frame_for("op", parts.len() as u64, &[], true, &hash, 0)
        };
        frames_tx.blocking_send(last).unwrap();
        expect_ack(&mut rx, parts.len() as u64);
        let (ok, error) = expect_result(&mut rx);
        assert!(ok, "{error:?}");
        assert_eq!(std::fs::read(dest.path().join("a.bin")).unwrap(), content);
    }

    #[test]
    fn a_sealed_resume_builds_on_kept_blocks_and_refuses_a_changed_file() {
        let dir = tempfile::tempdir().unwrap();
        let content: Vec<u8> = (0..3 * BLOCK + 5).map(|i| (i % 249) as u8).collect();
        std::fs::write(dir.path().join("f.bin"), &content).unwrap();
        let keys = sealed_keys();
        let hash = keyed_name(&keys, &content);
        let (first, _) = push_sealed_file(dir.path(), &keys, &hash, 0, None);

        // The server kept two blocks: only the rest crosses the wire, and the
        // spliced blob opens to the file.
        let kept = 2 * BLOCK as u64;
        let (tail, end) =
            push_sealed_file(dir.path(), &keys, &hash, kept, Some(resume_of(&first, 2)));
        let SyncEvent::Chunk {
            hash: announced,
            error: None,
            ..
        } = end
        else {
            panic!("resumed push failed");
        };
        assert_eq!(announced.as_deref(), Some(hash.as_str()));
        let mut spliced = first[..e2e::HEADER_LEN + 2 * e2e::SEALED_FULL].to_vec();
        spliced.extend(tail);
        let mut unsealer = Unsealer::new(Arc::clone(&keys), e2e::name_bytes(&hash).unwrap(), 0);
        let mut opened = unsealer.push(&spliced).unwrap();
        opened.extend(unsealer.finish().unwrap());
        assert_eq!(opened, content);

        // The file changed in its kept part since: the partial must go.
        let mut changed = content.clone();
        changed[10] ^= 1;
        std::fs::write(dir.path().join("f.bin"), &changed).unwrap();
        let (sent, end) =
            push_sealed_file(dir.path(), &keys, &hash, kept, Some(resume_of(&first, 2)));
        assert!(sent.is_empty(), "nothing sent over a stale partial");
        let SyncEvent::Chunk {
            error: Some(_),
            stale_partial: true,
            ..
        } = end
        else {
            panic!("expected a stale partial");
        };
    }

    #[test]
    fn a_sealed_resume_of_an_aligned_file_sends_only_its_empty_last_block() {
        let dir = tempfile::tempdir().unwrap();
        let content: Vec<u8> = (0..2 * BLOCK).map(|i| (i % 241) as u8).collect();
        std::fs::write(dir.path().join("f.bin"), &content).unwrap();
        let keys = sealed_keys();
        let hash = keyed_name(&keys, &content);
        let (first, _) = push_sealed_file(dir.path(), &keys, &hash, 0, None);
        let (tail, end) = push_sealed_file(
            dir.path(),
            &keys,
            &hash,
            2 * BLOCK as u64,
            Some(resume_of(&first, 2)),
        );
        assert!(matches!(end, SyncEvent::Chunk { error: None, .. }));
        assert_eq!(tail.len(), NONCE_LEN + e2e::TAG_LEN, "one empty last block");
    }

    #[test]
    fn a_sealed_apply_refuses_a_blob_under_another_name() {
        let src = tempfile::tempdir().unwrap();
        let content = vec![9u8; 1000];
        std::fs::write(src.path().join("f.bin"), &content).unwrap();
        let keys = sealed_keys();
        let hash = keyed_name(&keys, &content);
        let (sealed, _) = push_sealed_file(src.path(), &keys, &hash, 0, None);

        let dest = tempfile::tempdir().unwrap();
        let (frames_tx, frames_rx) = tokio::sync::mpsc::channel(APPLY_QUEUE);
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        spawn_apply(
            "op".into(),
            1,
            dest.path().to_path_buf(),
            SharedCaches::default(),
            Some(keys),
            frames_rx,
            tx,
        );
        let other = "ab".repeat(32);
        let frame = ApplyFrame {
            expected_size: 1000,
            ..apply_frame_for("op", 0, &sealed, true, &other, 0)
        };
        frames_tx.blocking_send(frame).unwrap();
        let (ok, _) = expect_result(&mut rx);
        assert!(!ok);
        assert!(!dest.path().join("a.bin").exists());
        assert!(
            !partial_of(dest.path(), &other).exists(),
            "a forged blob leaves nothing"
        );
    }

    #[cfg(windows)]
    #[test]
    fn is_lock_error_recognizes_a_windows_sharing_violation() {
        assert!(is_lock_error(&std::io::Error::from_raw_os_error(32)));
        assert!(is_lock_error(&std::io::Error::from_raw_os_error(33)));
    }
}
