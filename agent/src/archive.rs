//! Folder archives for backups: a `.tar.gz` built here and streamed to the
//! server in pieces, each spending one credit the server grants as it
//! consumes them. Memory stays bounded on both sides whatever the folder's
//! size, a slow destination slows the walk down, and the server can stop it at
//! any time.
//!
//! Entries are written here, never by `tar::Builder::append_path`: the crate
//! copies a file until its end, so a file that grows or shrinks while it is
//! read would corrupt everything after it. `ExactReader` delivers exactly the
//! size the header announced.

use std::cell::Cell;
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use flate2::write::GzEncoder;
use flate2::Compression;
use tokio::sync::mpsc::Sender;
use unicode_normalization::UnicodeNormalization;

use crate::exclusions::CompiledExclusions;
use crate::files::{is_virtual_fs, FilesEvent};
use crate::protocol::{ArchiveSample, PathExclusion};

/// Raw bytes per piece: about 700 KB once in base64, well under the frame cap.
const PIECE_BYTES: usize = 512 * 1024;
/// Archives running at once on this machine.
const MAX_ARCHIVES: usize = 2;
/// Without a credit for that long, the server has stopped reading: give up.
const CREDIT_WAIT: Duration = Duration::from_secs(30 * 60);
/// A sign of life at least this often while no piece goes out.
const PROGRESS_EVERY: Duration = Duration::from_secs(10);
/// Skipped or changed entries named in the final frame (mirrors the schema).
const SAMPLES_MAX: usize = 20;
const GIB: u64 = 1024 * 1024 * 1024;

const CANCELLED: &str = "Archive annulée.";
const STARVED: &str = "Le serveur a cessé de lire l'archive.";
const SESSION_CLOSED: &str = "session fermée";

/// What a walk met, reported with the archive's end.
#[derive(Debug, Default, Clone)]
pub struct ArchiveStats {
    pub files: u64,
    pub dirs: u64,
    pub bytes_read: u64,
    pub skipped: u64,
    pub changed: u64,
    pub samples: Vec<ArchiveSample>,
}

impl ArchiveStats {
    fn entries(&self) -> u64 {
        self.files + self.dirs
    }

    fn note(&mut self, path: &Path, reason: &str) {
        if self.samples.len() < SAMPLES_MAX {
            self.samples.push(ArchiveSample {
                path: path.to_string_lossy().chars().take(1024).collect(),
                reason: reason.chars().take(120).collect(),
            });
        }
    }

    fn skip(&mut self, path: &Path, reason: &str) {
        self.skipped += 1;
        self.note(path, reason);
    }
}

/// Ceilings of a walk; none for a backup, whose bound is the server's budget.
pub struct WalkLimits {
    pub max_entries: u64,
    pub max_bytes: u64,
}

pub struct WalkOptions<'a> {
    pub exclusions: &'a CompiledExclusions,
    /// Keep a mount point, not what is mounted on it.
    pub one_file_system: bool,
    pub limits: Option<WalkLimits>,
}

/// Writes `root` into `builder`, entries prefixed with the folder's own name so
/// extracting never scatters files into the current directory. Symlinks are
/// stored as symlinks (never followed), kernel filesystems skipped, an entry
/// that cannot be read is counted and skipped. An error is the writer's (the
/// session is gone, the archive was cancelled) or a limit's: fatal.
pub fn write_tree<W: Write>(
    root: &Path,
    opts: &WalkOptions,
    builder: &mut tar::Builder<W>,
    stats: &mut ArchiveStats,
    tick: &mut dyn FnMut(&ArchiveStats) -> io::Result<()>,
) -> Result<()> {
    let base = PathBuf::from(root.file_name().unwrap_or_else(|| "archive".as_ref()));
    let root_meta =
        std::fs::metadata(root).with_context(|| format!("lecture de {}", root.display()))?;
    let root_device = device_of(&root_meta);
    append_dir(builder, &base, &root_meta)?;

    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let mut entries: Vec<_> = match std::fs::read_dir(&dir) {
            Ok(rd) => rd.flatten().collect(),
            Err(e) => {
                stats.skip(&dir, &e.to_string());
                continue;
            }
        };
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            tick(stats)?;
            let path = entry.path();
            // Excluded before anything else: an excluded folder is never walked.
            if opts.exclusions.matches(&rel_of(root, &path)) {
                continue;
            }
            if let Some(limits) = &opts.limits {
                if stats.entries() >= limits.max_entries {
                    bail!(
                        "dossier trop volumineux : plus de {} éléments",
                        limits.max_entries
                    );
                }
            }
            let Ok(file_type) = entry.file_type() else {
                stats.skip(&path, "type illisible");
                continue;
            };
            let name = base.join(path.strip_prefix(root).unwrap_or(&path));
            if file_type.is_dir() {
                if is_virtual_fs(&path) {
                    continue;
                }
                let meta = match std::fs::symlink_metadata(&path) {
                    Ok(m) => m,
                    Err(e) => {
                        stats.skip(&path, &e.to_string());
                        continue;
                    }
                };
                append_dir(builder, &name, &meta)?;
                stats.dirs += 1;
                if opts.one_file_system && device_of(&meta) != root_device {
                    continue;
                }
                stack.push(path);
            } else if file_type.is_file() {
                append_file(builder, &path, &name, stats, opts.limits.as_ref())?;
            } else if file_type.is_symlink() {
                let (meta, target) =
                    match (std::fs::symlink_metadata(&path), std::fs::read_link(&path)) {
                        (Ok(m), Ok(t)) => (m, t),
                        (Err(e), _) | (_, Err(e)) => {
                            stats.skip(&path, &e.to_string());
                            continue;
                        }
                    };
                let mut header = tar::Header::new_gnu();
                header.set_metadata_in_mode(&meta, tar::HeaderMode::Complete);
                header.set_entry_type(tar::EntryType::Symlink);
                header.set_size(0);
                builder.append_link(&mut header, &name, &target)?;
            }
            // Sockets, FIFOs and devices have no content to archive.
        }
    }
    Ok(())
}

fn append_dir<W: Write>(
    builder: &mut tar::Builder<W>,
    name: &Path,
    meta: &std::fs::Metadata,
) -> io::Result<()> {
    let mut header = tar::Header::new_gnu();
    header.set_metadata_in_mode(meta, tar::HeaderMode::Complete);
    header.set_entry_type(tar::EntryType::Directory);
    header.set_size(0);
    builder.append_data(&mut header, name, io::empty())
}

fn append_file<W: Write>(
    builder: &mut tar::Builder<W>,
    path: &Path,
    name: &Path,
    stats: &mut ArchiveStats,
    limits: Option<&WalkLimits>,
) -> Result<()> {
    let file = match open_regular(path) {
        Ok(f) => f,
        Err(e) => {
            stats.skip(path, &e.to_string());
            return Ok(());
        }
    };
    // Checked on the handle: the entry may have been replaced since the listing.
    let meta = match file.metadata() {
        Ok(m) if m.is_file() => m,
        Ok(_) => {
            stats.skip(path, "n'est plus un fichier");
            return Ok(());
        }
        Err(e) => {
            stats.skip(path, &e.to_string());
            return Ok(());
        }
    };
    let size = meta.len();
    if let Some(limits) = limits {
        if stats.bytes_read + size > limits.max_bytes {
            bail!(
                "dossier trop volumineux : plus de {} Go",
                limits.max_bytes / GIB
            );
        }
    }
    let mut header = tar::Header::new_gnu();
    header.set_metadata_in_mode(&meta, tar::HeaderMode::Complete);
    header.set_entry_type(tar::EntryType::Regular);
    header.set_size(size);
    let mut reader = ExactReader::new(file, size);
    builder.append_data(&mut header, name, &mut reader)?;
    stats.files += 1;
    stats.bytes_read += size;
    if reader.changed() {
        stats.changed += 1;
        stats.note(path, "modifié pendant la lecture");
    }
    Ok(())
}

/// `O_NONBLOCK`: a FIFO swapped in since the listing must not hang the walk.
#[cfg(unix)]
fn open_regular(path: &Path) -> io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(path)
}
#[cfg(not(unix))]
fn open_regular(path: &Path) -> io::Result<std::fs::File> {
    std::fs::File::open(path)
}

#[cfg(unix)]
fn device_of(meta: &std::fs::Metadata) -> Option<u64> {
    use std::os::unix::fs::MetadataExt;
    Some(meta.dev())
}
#[cfg(not(unix))]
fn device_of(_meta: &std::fs::Metadata) -> Option<u64> {
    None
}

/// The path the exclusions read: relative, `/`-separated, NFC like the server.
fn rel_of(root: &Path, path: &Path) -> String {
    let rel = path.strip_prefix(root).unwrap_or(path);
    let joined = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/");
    joined.nfc().collect()
}

/// Exactly `size` bytes whatever the file does meanwhile: cut if it grew,
/// padded with zeros if it shrank or a read failed halfway.
struct ExactReader<R> {
    inner: R,
    remaining: u64,
    short: bool,
}

impl<R: Read> ExactReader<R> {
    fn new(inner: R, size: u64) -> Self {
        Self {
            inner,
            remaining: size,
            short: false,
        }
    }

    /// Did the file change size while it was read?
    fn changed(&mut self) -> bool {
        if self.short {
            return true;
        }
        let mut probe = [0u8; 1];
        matches!(self.inner.read(&mut probe), Ok(n) if n > 0)
    }
}

impl<R: Read> Read for ExactReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.remaining == 0 || buf.is_empty() {
            return Ok(0);
        }
        let want = buf
            .len()
            .min(usize::try_from(self.remaining).unwrap_or(usize::MAX));
        while !self.short {
            match self.inner.read(&mut buf[..want]) {
                Ok(0) => self.short = true,
                Ok(n) => {
                    self.remaining -= n as u64;
                    return Ok(n);
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(_) => self.short = true,
            }
        }
        buf[..want].fill(0);
        self.remaining -= want as u64;
        Ok(want)
    }
}

struct Credits {
    available: u32,
    cancelled: bool,
}

/// The server's hold on one archive: the credits it granted, and its stop.
pub struct ArchiveCtl {
    state: Mutex<Credits>,
    wake: Condvar,
}

impl ArchiveCtl {
    fn new(window: u32) -> Self {
        Self {
            state: Mutex::new(Credits {
                available: window,
                cancelled: false,
            }),
            wake: Condvar::new(),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Credits> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn grant(&self, credits: u32) {
        let mut state = self.lock();
        state.available = state.available.saturating_add(credits);
        self.wake.notify_all();
    }

    fn cancel(&self) {
        self.lock().cancelled = true;
        self.wake.notify_all();
    }

    fn cancelled(&self) -> bool {
        self.lock().cancelled
    }

    /// Takes one credit, waiting for the server to grant it.
    fn acquire(&self, wait: Duration) -> io::Result<()> {
        let deadline = Instant::now() + wait;
        let mut state = self.lock();
        loop {
            if state.cancelled {
                return Err(io::Error::other(CANCELLED));
            }
            if state.available > 0 {
                state.available -= 1;
                return Ok(());
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(io::Error::other(STARVED));
            }
            state = self
                .wake
                .wait_timeout(state, deadline - now)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
    }
}

/// Cuts the compressed stream into pieces, each sent under one credit.
struct ArchiveSink {
    op_id: String,
    tx: Sender<FilesEvent>,
    ctl: Arc<ArchiveCtl>,
    buf: Vec<u8>,
    seq: u64,
    last_frame: Rc<Cell<Instant>>,
}

impl ArchiveSink {
    fn emit(&mut self, data: Vec<u8>) -> io::Result<()> {
        self.ctl.acquire(CREDIT_WAIT)?;
        self.tx
            .blocking_send(FilesEvent::ArchiveChunk {
                op_id: self.op_id.clone(),
                seq: self.seq,
                data,
            })
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, SESSION_CLOSED))?;
        self.seq += 1;
        self.last_frame.set(Instant::now());
        Ok(())
    }

    /// The last piece, however short, once the archive is complete.
    fn finish(&mut self) -> io::Result<()> {
        if self.buf.is_empty() {
            return Ok(());
        }
        let tail = std::mem::take(&mut self.buf);
        self.emit(tail)
    }
}

impl Write for ArchiveSink {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        self.buf.extend_from_slice(data);
        while self.buf.len() >= PIECE_BYTES {
            let rest = self.buf.split_off(PIECE_BYTES);
            let piece = std::mem::replace(&mut self.buf, rest);
            self.emit(piece)?;
        }
        Ok(data.len())
    }

    /// Pieces are cut by size, not by flush: an early flush would send a
    /// short one for nothing.
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// What one archive covers.
pub struct ArchiveRequest {
    pub path: String,
    pub exclusions: Vec<PathExclusion>,
    pub one_file_system: bool,
}

fn build(
    op_id: &str,
    request: &ArchiveRequest,
    ctl: &Arc<ArchiveCtl>,
    tx: &Sender<FilesEvent>,
    stats: &mut ArchiveStats,
) -> Result<()> {
    let exclusions = CompiledExclusions::compile_strict(&request.exclusions)?;
    let root = std::fs::canonicalize(&request.path)
        .with_context(|| format!("résolution de {}", request.path))?;
    if !root.is_dir() {
        bail!("{} n'est pas un dossier", root.display());
    }

    let progress = |stats: &ArchiveStats| {
        tx.blocking_send(FilesEvent::ArchiveProgress {
            op_id: op_id.to_string(),
            entries: stats.entries(),
            bytes_read: stats.bytes_read,
        })
        .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, SESSION_CLOSED))
    };
    // At once: the server learns that the order was understood and started.
    progress(stats)?;

    let last_frame = Rc::new(Cell::new(Instant::now()));
    let sink = ArchiveSink {
        op_id: op_id.to_string(),
        tx: tx.clone(),
        ctl: ctl.clone(),
        buf: Vec::with_capacity(PIECE_BYTES),
        seq: 0,
        last_frame: last_frame.clone(),
    };
    // `fast`: the archive is built live on a machine at work, the extra ratio
    // is not worth the CPU it would cost there.
    let mut builder = tar::Builder::new(GzEncoder::new(sink, Compression::fast()));
    builder.follow_symlinks(false);
    let opts = WalkOptions {
        exclusions: &exclusions,
        one_file_system: request.one_file_system,
        limits: None,
    };
    let mut tick = |stats: &ArchiveStats| -> io::Result<()> {
        if ctl.cancelled() {
            return Err(io::Error::other(CANCELLED));
        }
        if last_frame.get().elapsed() >= PROGRESS_EVERY {
            progress(stats)?;
            last_frame.set(Instant::now());
        }
        Ok(())
    };
    write_tree(&root, &opts, &mut builder, stats, &mut tick)?;
    // `into_inner` writes the tar trailer, `finish` the gzip one.
    let mut sink = builder.into_inner()?.finish()?;
    sink.finish()?;
    Ok(())
}

fn run(op_id: String, request: ArchiveRequest, ctl: Arc<ArchiveCtl>, tx: Sender<FilesEvent>) {
    let mut stats = ArchiveStats::default();
    let error = build(&op_id, &request, &ctl, &tx, &mut stats)
        .err()
        .map(|e| format!("{e:#}").chars().take(500).collect::<String>());
    let _ = tx.blocking_send(FilesEvent::ArchiveEnd {
        op_id,
        stats,
        error,
    });
}

/// The session's archives: started, credited and cancelled by the server,
/// all cancelled when the session ends (the manager is dropped with it).
pub struct ArchiveManager {
    live: HashMap<String, Arc<ArchiveCtl>>,
    tx: Sender<FilesEvent>,
}

impl ArchiveManager {
    pub fn new(tx: Sender<FilesEvent>) -> Self {
        Self {
            live: HashMap::new(),
            tx,
        }
    }

    pub fn start(&mut self, op_id: String, request: ArchiveRequest, window: u32) {
        if self.live.contains_key(&op_id) {
            return;
        }
        if self.live.len() >= MAX_ARCHIVES {
            let tx = self.tx.clone();
            tokio::spawn(async move {
                let _ = tx
                    .send(FilesEvent::ArchiveEnd {
                        op_id,
                        stats: ArchiveStats::default(),
                        error: Some(format!(
                            "{MAX_ARCHIVES} archives sont déjà en cours sur cette machine."
                        )),
                    })
                    .await;
            });
            return;
        }
        let ctl = Arc::new(ArchiveCtl::new(window));
        self.live.insert(op_id.clone(), ctl.clone());
        let tx = self.tx.clone();
        std::thread::spawn(move || run(op_id, request, ctl, tx));
    }

    pub fn credit(&self, op_id: &str, credits: u32) {
        if let Some(ctl) = self.live.get(op_id) {
            ctl.grant(credits);
        }
    }

    pub fn cancel(&self, op_id: &str) {
        if let Some(ctl) = self.live.get(op_id) {
            ctl.cancel();
        }
    }

    /// The archive has sent its end.
    pub fn forget(&mut self, op_id: &str) {
        self.live.remove(op_id);
    }
}

impl Drop for ArchiveManager {
    fn drop(&mut self) {
        for ctl in self.live.values() {
            ctl.cancel();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn rule(kind: &str, pattern: &str) -> PathExclusion {
        PathExclusion {
            kind: kind.to_string(),
            pattern: pattern.to_string(),
        }
    }

    /// The archive of `root` as the tar reader sees it: (path, kind, content).
    fn walk(
        root: &Path,
        exclusions: &[PathExclusion],
    ) -> (Vec<(String, char, Vec<u8>)>, ArchiveStats) {
        let exclusions = CompiledExclusions::compile_strict(exclusions).unwrap();
        let opts = WalkOptions {
            exclusions: &exclusions,
            one_file_system: true,
            limits: None,
        };
        let mut builder = tar::Builder::new(GzEncoder::new(Vec::new(), Compression::fast()));
        builder.follow_symlinks(false);
        let mut stats = ArchiveStats::default();
        write_tree(root, &opts, &mut builder, &mut stats, &mut |_| Ok(())).unwrap();
        let gz = builder.into_inner().unwrap().finish().unwrap();
        let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(Cursor::new(gz)));
        let mut out = Vec::new();
        for entry in archive.entries().unwrap() {
            let mut entry = entry.unwrap();
            let kind = match entry.header().entry_type() {
                tar::EntryType::Directory => 'd',
                tar::EntryType::Symlink => 'l',
                _ => 'f',
            };
            let path = entry
                .path()
                .unwrap()
                .to_string_lossy()
                .trim_end_matches('/')
                .to_string();
            let mut content = Vec::new();
            entry.read_to_end(&mut content).unwrap();
            out.push((path, kind, content));
        }
        (out, stats)
    }

    #[test]
    fn archives_the_tree_under_its_own_name_and_skips_exclusions() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("site");
        std::fs::create_dir_all(root.join("src/node_modules/lib")).unwrap();
        std::fs::write(root.join("index.html"), b"<h1>ok</h1>").unwrap();
        std::fs::write(root.join("src/app.js"), b"console.log(1)").unwrap();
        std::fs::write(root.join("src/node_modules/lib/x.js"), b"x").unwrap();
        std::fs::write(root.join("debug.log"), b"bruit").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("index.html", root.join("accueil.html")).unwrap();

        let (entries, stats) = walk(
            &root,
            &[rule("name", "node_modules"), rule("regex", r"\.log$")],
        );
        let paths: Vec<&str> = entries.iter().map(|(p, _, _)| p.as_str()).collect();

        assert!(paths.iter().all(|p| p.starts_with("site")));
        assert!(paths.contains(&"site/index.html"));
        assert!(paths.contains(&"site/src/app.js"));
        assert!(!paths.iter().any(|p| p.contains("node_modules")));
        assert!(!paths.iter().any(|p| p.ends_with(".log")));
        let app = entries
            .iter()
            .find(|(p, _, _)| p == "site/src/app.js")
            .unwrap();
        assert_eq!(app.2, b"console.log(1)");
        #[cfg(unix)]
        assert!(entries
            .iter()
            .any(|(p, k, _)| p == "site/accueil.html" && *k == 'l'));
        assert_eq!(stats.files, 2);
        assert_eq!(stats.skipped, 0);
    }

    #[cfg(unix)]
    #[test]
    fn a_fifo_neither_blocks_nor_enters_the_archive() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("d");
        std::fs::create_dir(&root).unwrap();
        let fifo = std::ffi::CString::new(root.join("tube").to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o644) }, 0);
        std::fs::write(root.join("a.txt"), b"a").unwrap();

        let (entries, _) = walk(&root, &[]);
        assert!(entries.iter().all(|(p, _, _)| !p.ends_with("tube")));
        assert!(entries.iter().any(|(p, _, _)| p == "d/a.txt"));
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_file_is_counted_and_skipped() {
        use std::os::unix::fs::PermissionsExt;
        // Root reads everything: nothing to prove there.
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("d");
        std::fs::create_dir(&root).unwrap();
        let secret = root.join("secret");
        std::fs::write(&secret, b"s").unwrap();
        std::fs::set_permissions(&secret, std::fs::Permissions::from_mode(0o000)).unwrap();

        let (entries, stats) = walk(&root, &[]);
        assert!(entries.iter().all(|(p, _, _)| !p.ends_with("secret")));
        assert_eq!(stats.skipped, 1);
        assert_eq!(stats.samples.len(), 1);
    }

    #[test]
    fn exact_reader_pads_a_shrunk_file_and_cuts_a_grown_one() {
        let mut short = ExactReader::new(Cursor::new(b"abc".to_vec()), 5);
        let mut out = Vec::new();
        short.read_to_end(&mut out).unwrap();
        assert_eq!(out, b"abc\0\0");
        assert!(short.changed());

        let mut long = ExactReader::new(Cursor::new(b"abcdef".to_vec()), 4);
        let mut out = Vec::new();
        long.read_to_end(&mut out).unwrap();
        assert_eq!(out, b"abcd");
        assert!(long.changed());

        let mut exact = ExactReader::new(Cursor::new(b"abcd".to_vec()), 4);
        let mut out = Vec::new();
        exact.read_to_end(&mut out).unwrap();
        assert!(!exact.changed());
    }

    #[test]
    fn credits_bound_what_goes_out_and_a_cancel_wakes_the_walk() {
        let ctl = Arc::new(ArchiveCtl::new(2));
        assert!(ctl.acquire(Duration::from_millis(10)).is_ok());
        assert!(ctl.acquire(Duration::from_millis(10)).is_ok());
        // No credit left: waits, then gives up.
        assert!(ctl.acquire(Duration::from_millis(30)).is_err());

        let waiting = {
            let ctl = ctl.clone();
            std::thread::spawn(move || ctl.acquire(Duration::from_secs(10)))
        };
        std::thread::sleep(Duration::from_millis(30));
        ctl.grant(1);
        assert!(waiting.join().unwrap().is_ok());

        let waiting = {
            let ctl = ctl.clone();
            std::thread::spawn(move || ctl.acquire(Duration::from_secs(10)))
        };
        std::thread::sleep(Duration::from_millis(30));
        ctl.cancel();
        let err = waiting.join().unwrap().unwrap_err();
        assert_eq!(err.to_string(), CANCELLED);
    }

    #[test]
    fn a_run_sends_progress_pieces_in_order_then_its_end() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("d");
        std::fs::create_dir(&root).unwrap();
        // Incompressible (xorshift), so the archive spans several pieces.
        let mut state = 0x2545_f491_4f6c_dd1d_u64;
        let noise: Vec<u8> = (0..(PIECE_BYTES * 2 + 1000))
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                state as u8
            })
            .collect();
        std::fs::write(root.join("bruit.bin"), &noise).unwrap();

        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        let request = ArchiveRequest {
            path: root.to_string_lossy().into_owned(),
            exclusions: vec![],
            one_file_system: true,
        };
        let ctl = Arc::new(ArchiveCtl::new(64));
        run("op".to_string(), request, ctl, tx);

        let mut seqs = Vec::new();
        let mut gz = Vec::new();
        let mut saw_progress = false;
        let mut end = None;
        while let Some(ev) = rx.blocking_recv() {
            match ev {
                FilesEvent::ArchiveProgress { .. } => saw_progress = true,
                FilesEvent::ArchiveChunk { seq, data, .. } => {
                    seqs.push(seq);
                    gz.extend(data);
                }
                FilesEvent::ArchiveEnd { stats, error, .. } => end = Some((stats, error)),
                _ => {}
            }
        }
        let (stats, error) = end.unwrap();
        assert_eq!(error, None);
        assert!(saw_progress);
        assert!(seqs.len() >= 3);
        assert_eq!(seqs, (0..seqs.len() as u64).collect::<Vec<_>>());
        assert_eq!(stats.bytes_read, noise.len() as u64);

        let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(Cursor::new(gz)));
        let mut entry = archive
            .entries()
            .unwrap()
            .map(|e| e.unwrap())
            .find(|e| e.path().unwrap().ends_with("bruit.bin"))
            .unwrap();
        let mut back = Vec::new();
        entry.read_to_end(&mut back).unwrap();
        assert_eq!(back, noise);
    }

    #[test]
    fn a_bad_pattern_fails_the_archive_before_anything_goes_out() {
        let dir = tempfile::tempdir().unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        let request = ArchiveRequest {
            path: dir.path().to_string_lossy().into_owned(),
            exclusions: vec![rule("regex", "(?=x)")],
            one_file_system: true,
        };
        run("op".to_string(), request, Arc::new(ArchiveCtl::new(8)), tx);
        match rx.blocking_recv() {
            Some(FilesEvent::ArchiveEnd { error: Some(e), .. }) => assert!(e.contains("invalide")),
            _ => panic!("fin en erreur attendue"),
        }
    }

    #[test]
    fn a_cancelled_archive_ends_with_its_reason() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("d");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("a.txt"), b"a").unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        let ctl = Arc::new(ArchiveCtl::new(8));
        ctl.cancel();
        let request = ArchiveRequest {
            path: root.to_string_lossy().into_owned(),
            exclusions: vec![],
            one_file_system: true,
        };
        run("op".to_string(), request, ctl, tx);
        let mut end = None;
        while let Some(ev) = rx.blocking_recv() {
            if let FilesEvent::ArchiveEnd { error, .. } = ev {
                end = error;
            }
        }
        assert_eq!(end.as_deref(), Some(CANCELLED));
    }
}
