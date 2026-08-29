//! On-device file explorer: list directories, analyse recursive disk usage
//! (ncdu-style), search (name/extension/content + date & size windows), and clean
//! up (delete / mkdir / rename).
//!
//! Read operations are **bounded** (walk + content-read budgets) so a query on a
//! huge tree stays responsive and memory-safe; results say when they were capped.
//! Everything runs with the agent's own privileges — there is no path sandbox (the
//! agent can already do anything via the terminal); access is gated server-side.

use std::cmp::Ordering;
use std::path::Path;

use anyhow::{bail, Context, Result};
use tokio::sync::mpsc::Sender;

use crate::protocol::{FileEntry, FileListing, FileMatch, FileSearchFilter, FileUsageEntry};

/// Hard cap on returned search hits (mirrors @deveye/types `FILE_SEARCH_MAX`).
const FILE_SEARCH_MAX: usize = 2000;
/// Entries the usage analysis may walk before stopping (marks results partial).
const ANALYZE_BUDGET: u64 = 2_000_000;
/// Entries a search may walk before stopping (marks the result truncated).
const SEARCH_WALK_BUDGET: u64 = 300_000;
/// Largest file scanned for a content search.
const CONTENT_MAX_BYTES: u64 = 4_000_000;

/// Results a file task streams back to the session loop (which stamps the device id).
pub enum FilesEvent {
    Listing {
        op_id: String,
        listing: Option<FileListing>,
        error: Option<String>,
    },
    Usage {
        op_id: String,
        entries: Vec<FileUsageEntry>,
        error: Option<String>,
    },
    Matches {
        op_id: String,
        matches: Vec<FileMatch>,
        truncated: bool,
        error: Option<String>,
    },
    Op {
        op_id: String,
        op: String,
        ok: bool,
        error: Option<String>,
    },
    /// One chunk of a downloaded file (the last carries `done`).
    Chunk {
        op_id: String,
        data: Vec<u8>,
        done: bool,
        error: Option<String>,
    },
}

/// Bytes per download chunk (base64 keeps each frame well under the wire cap).
const DOWNLOAD_CHUNK: usize = 256 * 1024;
/// Entries a folder archive may walk before giving up (mirrors the analysis budget:
/// a mistaken « télécharger / » must fail fast rather than crawl the whole disk).
const ARCHIVE_MAX_ENTRIES: u64 = 200_000;
/// Ceiling on the **uncompressed** file bytes a folder archive may carry. The
/// browser rebuilds the whole stream in memory before saving it, so this is really
/// the client's limit, not the device's.
const ARCHIVE_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;

fn kind_of(ft: &std::fs::FileType) -> &'static str {
    if ft.is_symlink() {
        "symlink"
    } else if ft.is_dir() {
        "dir"
    } else if ft.is_file() {
        "file"
    } else {
        "other"
    }
}

fn mtime_ms(meta: &std::fs::Metadata) -> Option<i64> {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
}

#[cfg(unix)]
fn mode_of(meta: &std::fs::Metadata) -> Option<u32> {
    use std::os::unix::fs::PermissionsExt;
    Some(meta.permissions().mode())
}
#[cfg(not(unix))]
fn mode_of(_meta: &std::fs::Metadata) -> Option<u32> {
    None
}

/// Path as it should leave the device: absolute, and on Windows in its plain
/// form rather than the *verbatim* one `canonicalize` returns.
fn display_path(p: &Path) -> String {
    let s = p.to_string_lossy().into_owned();
    // `cfg!` (not `#[cfg]`) so the Windows branch is still compiled — and unit
    // tested — on the Linux/macOS builds.
    if cfg!(windows) {
        strip_verbatim(s)
    } else {
        s
    }
}

/// `\\?\C:\dir` → `C:\dir`, `\\?\UNC\srv\share` → `\\srv\share`.
///
/// Windows' `canonicalize` always answers with a verbatim path. The prefix is an
/// API detail that leaks to the UI: the client splits paths on the separator for
/// its breadcrumbs, so `\\?\` becomes a phantom `?` directory. std re-adds the
/// prefix when it needs it, so the plain form still opens long paths. Device
/// paths (`\\?\Volume{…}`) have no plain form and are left untouched.
fn strip_verbatim(s: String) -> String {
    let Some(rest) = s.strip_prefix(r"\\?\") else {
        return s;
    };
    if let Some(unc) = rest.strip_prefix(r"UNC\") {
        return format!(r"\\{unc}");
    }
    let mut c = rest.chars();
    let is_drive = matches!((c.next(), c.next()), (Some(l), Some(':')) if l.is_ascii_alphabetic());
    if is_drive {
        rest.to_owned()
    } else {
        s
    }
}

/// Directories first, then case-insensitive name.
fn dir_first(a: &FileEntry, b: &FileEntry) -> Ordering {
    let ad = a.kind == "dir";
    let bd = b.kind == "dir";
    bd.cmp(&ad)
        .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
}

/// List a directory (resolved to an absolute, symlink-free path).
pub fn list(path: &str) -> Result<FileListing> {
    let canon = std::fs::canonicalize(path).with_context(|| format!("résolution de {path}"))?;
    let mut entries = Vec::new();
    for entry in
        std::fs::read_dir(&canon).with_context(|| format!("lecture de {}", canon.display()))?
    {
        let Ok(entry) = entry else { continue };
        let Ok(ft) = entry.file_type() else { continue };
        let meta = entry.metadata().ok();
        let symlink_target = ft
            .is_symlink()
            .then(|| std::fs::read_link(entry.path()).ok())
            .flatten()
            .map(|t| t.to_string_lossy().into_owned());
        entries.push(FileEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            kind: kind_of(&ft),
            size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
            mtime: meta.as_ref().and_then(mtime_ms),
            mode: meta.as_ref().and_then(mode_of),
            symlink_target,
        });
    }
    entries.sort_by(dir_first);
    Ok(FileListing {
        path: display_path(&canon),
        parent: canon.parent().map(display_path),
        entries,
    })
}

/// Virtual (kernel) filesystems whose apparent sizes are meaningless, and
/// sometimes absurd (`/proc/kcore` reports ~128 TiB): never walk them.
#[cfg(target_os = "linux")]
fn is_virtual_fs(path: &Path) -> bool {
    matches!(path.to_str(), Some("/proc" | "/sys" | "/dev" | "/run"))
}
#[cfg(not(target_os = "linux"))]
fn is_virtual_fs(_path: &Path) -> bool {
    false
}

/// Recursive size of each immediate child of `path`, biggest first (the ncdu view).
///
/// One shared walk budget across all children, large enough that only
/// pathological trees hit it: it keeps most results complete, which the client
/// only caches when they are (a per-child split returns far more `partial`).
pub fn analyze(path: &str) -> Result<Vec<FileUsageEntry>> {
    let canon = std::fs::canonicalize(path).with_context(|| format!("résolution de {path}"))?;
    let mut budget = ANALYZE_BUDGET;
    let mut out = Vec::new();
    for entry in
        std::fs::read_dir(&canon).with_context(|| format!("lecture de {}", canon.display()))?
    {
        let Ok(entry) = entry else { continue };
        let Ok(ft) = entry.file_type() else { continue };
        let path = entry.path();
        let (total_size, partial) = if ft.is_dir() && !ft.is_symlink() {
            if is_virtual_fs(&path) {
                (0, false)
            } else {
                dir_size(&path, &mut budget)
            }
        } else {
            (entry.metadata().map(|m| m.len()).unwrap_or(0), false)
        };
        out.push(FileUsageEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            kind: kind_of(&ft),
            total_size,
            partial,
        });
    }
    out.sort_by_key(|e| std::cmp::Reverse(e.total_size));
    Ok(out)
}

/// Sum file sizes under `root` (iterative DFS, no symlink following, kernel
/// filesystems skipped), stopping when the budget runs out — then the result is
/// flagged partial.
fn dir_size(root: &Path, budget: &mut u64) -> (u64, bool) {
    let mut total = 0u64;
    let mut partial = false;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in rd {
            if *budget == 0 {
                partial = true;
                break;
            }
            *budget -= 1;
            let Ok(entry) = entry else { continue };
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                let path = entry.path();
                if !is_virtual_fs(&path) {
                    stack.push(path);
                }
            } else if let Ok(m) = entry.metadata() {
                total += m.len();
            }
        }
        if partial {
            break;
        }
    }
    (total, partial)
}

enum Matcher {
    Re(regex::Regex),
    Sub(String),
}
impl Matcher {
    fn is_match(&self, s: &str) -> bool {
        match self {
            Matcher::Re(r) => r.is_match(s),
            Matcher::Sub(q) => s.to_lowercase().contains(q),
        }
    }
}

fn build_matcher(filter: &FileSearchFilter) -> Result<Option<Matcher>> {
    let Some(q) = filter.query.as_deref().filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    if filter.regex.unwrap_or(false) {
        let re = regex::RegexBuilder::new(q)
            .case_insensitive(true)
            .size_limit(1 << 20)
            .build()
            .map_err(|e| anyhow::anyhow!("expression régulière invalide : {e}"))?;
        Ok(Some(Matcher::Re(re)))
    } else {
        Ok(Some(Matcher::Sub(q.to_lowercase())))
    }
}

fn truncate_preview(s: &str) -> String {
    let s = s.trim();
    if s.len() <= 500 {
        return s.to_string();
    }
    let mut end = 500;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

/// First line of `path` matching `m` (skips files that are too big or binary).
fn content_match(path: &Path, m: &Matcher) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() > CONTENT_MAX_BYTES {
        return None;
    }
    let data = std::fs::read(path).ok()?;
    if data.iter().take(8192).any(|&b| b == 0) {
        return None; // looks binary
    }
    String::from_utf8_lossy(&data)
        .lines()
        .find(|line| m.is_match(line))
        .map(truncate_preview)
}

/// Recursively search `path`. Returns the hits and whether the result was capped.
pub fn search(path: &str, filter: &FileSearchFilter) -> Result<(Vec<FileMatch>, bool)> {
    let canon = std::fs::canonicalize(path).with_context(|| format!("résolution de {path}"))?;
    let matcher = build_matcher(filter)?;
    let field = filter.field.as_deref().unwrap_or("name");
    let ext_query = filter
        .query
        .as_deref()
        .map(|q| q.trim().trim_start_matches('.').to_lowercase());

    let mut matches = Vec::new();
    let mut truncated = false;
    let mut budget = SEARCH_WALK_BUDGET;
    let mut stack = vec![canon];

    'walk: while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in rd {
            if budget == 0 {
                truncated = true;
                break 'walk;
            }
            budget -= 1;
            let Ok(entry) = entry else { continue };
            let Ok(ft) = entry.file_type() else { continue };
            let path = entry.path();
            if ft.is_dir() && !ft.is_symlink() {
                stack.push(path.clone());
            }

            let meta = entry.metadata().ok();
            let mtime = meta.as_ref().and_then(mtime_ms);
            let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);

            // Date / size windows.
            if let Some(since) = filter.since {
                if mtime.is_none_or(|t| t < since * 1000) {
                    continue;
                }
            }
            if let Some(until) = filter.until {
                if mtime.is_none_or(|t| t > until * 1000) {
                    continue;
                }
            }
            if filter.min_size.is_some_and(|mn| size < mn)
                || filter.max_size.is_some_and(|mx| size > mx)
            {
                continue;
            }

            let name = entry.file_name().to_string_lossy().into_owned();
            let preview: Option<Option<String>> = match field {
                "extension" => {
                    let ext = path
                        .extension()
                        .map(|e| e.to_string_lossy().to_lowercase())
                        .unwrap_or_default();
                    match ext_query.as_deref() {
                        Some(q) if q.is_empty() || ext == q => Some(None),
                        None => Some(None),
                        _ => None,
                    }
                }
                "content" => {
                    if ft.is_file() {
                        matcher
                            .as_ref()
                            .and_then(|m| content_match(&path, m))
                            .map(Some)
                    } else {
                        None
                    }
                }
                // name (default)
                _ => matcher
                    .as_ref()
                    .map(|m| m.is_match(&name))
                    .unwrap_or(true)
                    .then_some(None),
            };

            if let Some(preview) = preview {
                matches.push(FileMatch {
                    path: display_path(&path),
                    name,
                    kind: kind_of(&ft),
                    size,
                    mtime,
                    preview,
                });
                if matches.len() >= FILE_SEARCH_MAX {
                    truncated = true;
                    break 'walk;
                }
            }
        }
    }
    Ok((matches, truncated))
}

/// Apply a filesystem mutation. `delete` removes files and directories (recursive);
/// `mkdir` creates the directory (and parents); `rename` moves `path` to `dest`.
pub fn mutate(op: &str, path: &str, dest: Option<&str>) -> Result<()> {
    match op {
        "delete" => {
            let meta =
                std::fs::symlink_metadata(path).with_context(|| format!("accès à {path}"))?;
            if meta.is_dir() {
                std::fs::remove_dir_all(path).with_context(|| format!("suppression de {path}"))
            } else {
                std::fs::remove_file(path).with_context(|| format!("suppression de {path}"))
            }
        }
        "mkdir" => std::fs::create_dir_all(path).with_context(|| format!("création de {path}")),
        "rename" => {
            let dest = dest.context("destination requise pour le renommage")?;
            std::fs::rename(path, dest).with_context(|| format!("renommage de {path}"))
        }
        other => bail!("opération de fichier inconnue : {other}"),
    }
}

/// Write one chunk of an uploaded file at `offset`. Offset 0 creates/truncates the
/// file; later offsets seek and overwrite — so chunks must arrive in order (the
/// session loop processes them sequentially).
pub fn upload_chunk(path: &str, offset: u64, data: &[u8]) -> Result<()> {
    use std::io::{Seek, SeekFrom, Write};
    let mut file = if offset == 0 {
        std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(path)
            .with_context(|| format!("création de {path}"))?
    } else {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .open(path)
            .with_context(|| format!("écriture de {path}"))?;
        f.seek(SeekFrom::Start(offset)).context("positionnement")?;
        f
    };
    file.write_all(data)
        .with_context(|| format!("écriture de {path}"))?;
    Ok(())
}

/// `Write` sink that cuts what it is given into `DOWNLOAD_CHUNK` frames and pushes
/// them on the files channel. Used to stream an archive that is never materialised
/// anywhere: back-pressure comes from the bounded channel, which blocks the writer
/// (and with it the whole walk) instead of letting the archive pile up in memory.
struct ChunkSink {
    op_id: String,
    tx: Sender<FilesEvent>,
    buf: Vec<u8>,
}

impl ChunkSink {
    fn emit(&mut self, data: Vec<u8>) -> std::io::Result<()> {
        self.tx
            .blocking_send(FilesEvent::Chunk {
                op_id: self.op_id.clone(),
                data,
                done: false,
                error: None,
            })
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "session fermée"))
    }

    /// Push whatever is left, however short — called once the archive is complete.
    fn emit_tail(&mut self) -> std::io::Result<()> {
        if self.buf.is_empty() {
            return Ok(());
        }
        let tail = std::mem::take(&mut self.buf);
        self.emit(tail)
    }
}

impl std::io::Write for ChunkSink {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        self.buf.extend_from_slice(data);
        while self.buf.len() >= DOWNLOAD_CHUNK {
            let rest = self.buf.split_off(DOWNLOAD_CHUNK);
            let frame = std::mem::replace(&mut self.buf, rest);
            self.emit(frame)?;
        }
        Ok(data.len())
    }

    /// Frames are cut by size, not by flush: an early flush would emit a short one
    /// for nothing. The tail goes out through {@link ChunkSink::emit_tail}.
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Write `root` into `sink` as a gzipped tar, entries prefixed with the folder's
/// own name so extracting never scatters files into the current directory.
///
/// Same discipline as `dir_size`: symlinks stored as symlinks (never followed),
/// kernel filesystems skipped, and an unreadable entry skipped rather than
/// failing the whole archive (a single root-owned file would otherwise sink it).
fn archive_dir(root: &Path, sink: &mut ChunkSink) -> Result<()> {
    use flate2::write::GzEncoder;
    use flate2::Compression;

    let base = Path::new(root.file_name().unwrap_or_else(|| "archive".as_ref()));
    // `fast` rather than the default: the archive is produced live on a monitored
    // machine, and the extra ratio isn't worth the CPU it costs there.
    let mut builder = tar::Builder::new(GzEncoder::new(sink, Compression::fast()));
    builder.follow_symlinks(false);

    let mut budget = ARCHIVE_MAX_ENTRIES;
    let mut bytes = 0u64;
    let mut skipped = 0u64;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            skipped += 1;
            continue;
        };
        for entry in rd.flatten() {
            if budget == 0 {
                bail!("dossier trop volumineux : plus de {ARCHIVE_MAX_ENTRIES} éléments");
            }
            budget -= 1;
            let Ok(ft) = entry.file_type() else { continue };
            let path = entry.path();
            let Ok(rel) = path.strip_prefix(root) else {
                continue;
            };
            let name = base.join(rel);
            if ft.is_dir() {
                if is_virtual_fs(&path) {
                    continue;
                }
                if builder.append_dir(&name, &path).is_err() {
                    skipped += 1;
                    continue;
                }
                stack.push(path);
            } else if ft.is_file() {
                let Ok(meta) = entry.metadata() else {
                    skipped += 1;
                    continue;
                };
                bytes += meta.len();
                if bytes > ARCHIVE_MAX_BYTES {
                    bail!(
                        "dossier trop volumineux : plus de {} Go",
                        ARCHIVE_MAX_BYTES / (1024 * 1024 * 1024)
                    );
                }
                if builder.append_path_with_name(&path, &name).is_err() {
                    skipped += 1;
                }
            } else if ft.is_symlink() && builder.append_path_with_name(&path, &name).is_err() {
                skipped += 1;
            }
            // Anything else (socket, fifo, device) has no content to archive.
        }
    }

    // `into_inner` writes the tar trailer, `finish` the gzip one; then whatever is
    // left in the sink is short by definition and goes out as the last frame.
    let sink = builder
        .into_inner()
        .context("écriture de l'archive")?
        .finish()
        .context("compression de l'archive")?;
    sink.emit_tail().context("envoi de l'archive")?;
    if skipped > 0 {
        tracing::warn!(
            skipped,
            root = %root.display(),
            "archive de dossier : éléments illisibles ignorés"
        );
    }
    Ok(())
}

/// Stream a path back to the server in chunks on a dedicated OS thread (blocking
/// reads, back-pressured by the bounded channel). A file is streamed as-is; a
/// **directory** is streamed as a `.tar.gz` built on the fly (nothing is written to
/// the device's disk). The final frame carries `done`, or an `error` if the path
/// couldn't be read.
pub fn spawn_download(op_id: String, path: String, tx: Sender<FilesEvent>) {
    std::thread::spawn(move || {
        use std::io::Read;
        let fail = |tx: &Sender<FilesEvent>, e: String| {
            let _ = tx.blocking_send(FilesEvent::Chunk {
                op_id: op_id.clone(),
                data: vec![],
                done: true,
                error: Some(e),
            });
        };
        let meta = match std::fs::metadata(&path) {
            Ok(m) => m,
            Err(e) => return fail(&tx, e.to_string()),
        };
        if meta.is_dir() {
            let mut sink = ChunkSink {
                op_id: op_id.clone(),
                tx: tx.clone(),
                buf: Vec::with_capacity(DOWNLOAD_CHUNK),
            };
            return match archive_dir(Path::new(&path), &mut sink) {
                Ok(()) => {
                    let _ = tx.blocking_send(FilesEvent::Chunk {
                        op_id: op_id.clone(),
                        data: vec![],
                        done: true,
                        error: None,
                    });
                }
                Err(e) => fail(&tx, e.to_string()),
            };
        }
        let mut file = match std::fs::File::open(&path) {
            Ok(f) => f,
            Err(e) => return fail(&tx, e.to_string()),
        };
        let mut buf = vec![0u8; DOWNLOAD_CHUNK];
        loop {
            match file.read(&mut buf) {
                Ok(0) => {
                    let _ = tx.blocking_send(FilesEvent::Chunk {
                        op_id: op_id.clone(),
                        data: vec![],
                        done: true,
                        error: None,
                    });
                    break;
                }
                Ok(n) => {
                    let ev = FilesEvent::Chunk {
                        op_id: op_id.clone(),
                        data: buf[..n].to_vec(),
                        done: false,
                        error: None,
                    };
                    if tx.blocking_send(ev).is_err() {
                        break;
                    }
                }
                Err(e) => return fail(&tx, e.to_string()),
            }
        }
    });
}

pub async fn list_task(op_id: String, path: String, tx: Sender<FilesEvent>) {
    let res = tokio::task::spawn_blocking(move || list(&path)).await;
    let ev = match res {
        Ok(Ok(listing)) => FilesEvent::Listing {
            op_id,
            listing: Some(listing),
            error: None,
        },
        Ok(Err(e)) => FilesEvent::Listing {
            op_id,
            listing: None,
            error: Some(e.to_string()),
        },
        Err(e) => FilesEvent::Listing {
            op_id,
            listing: None,
            error: Some(e.to_string()),
        },
    };
    let _ = tx.send(ev).await;
}

pub async fn analyze_task(op_id: String, path: String, tx: Sender<FilesEvent>) {
    let res = tokio::task::spawn_blocking(move || analyze(&path)).await;
    let ev = match res {
        Ok(Ok(entries)) => FilesEvent::Usage {
            op_id,
            entries,
            error: None,
        },
        Ok(Err(e)) => FilesEvent::Usage {
            op_id,
            entries: vec![],
            error: Some(e.to_string()),
        },
        Err(e) => FilesEvent::Usage {
            op_id,
            entries: vec![],
            error: Some(e.to_string()),
        },
    };
    let _ = tx.send(ev).await;
}

pub async fn search_task(
    op_id: String,
    path: String,
    filter: FileSearchFilter,
    tx: Sender<FilesEvent>,
) {
    let res = tokio::task::spawn_blocking(move || search(&path, &filter)).await;
    let ev = match res {
        Ok(Ok((matches, truncated))) => FilesEvent::Matches {
            op_id,
            matches,
            truncated,
            error: None,
        },
        Ok(Err(e)) => FilesEvent::Matches {
            op_id,
            matches: vec![],
            truncated: false,
            error: Some(e.to_string()),
        },
        Err(e) => FilesEvent::Matches {
            op_id,
            matches: vec![],
            truncated: false,
            error: Some(e.to_string()),
        },
    };
    let _ = tx.send(ev).await;
}

pub async fn mutate_task(
    op_id: String,
    op: String,
    path: String,
    dest: Option<String>,
    tx: Sender<FilesEvent>,
) {
    let op2 = op.clone();
    let res = tokio::task::spawn_blocking(move || mutate(&op2, &path, dest.as_deref())).await;
    let (ok, error) = match res {
        Ok(Ok(())) => (true, None),
        Ok(Err(e)) => (false, Some(e.to_string())),
        Err(e) => (false, Some(e.to_string())),
    };
    let _ = tx
        .send(FilesEvent::Op {
            op_id,
            op,
            ok,
            error,
        })
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dir_first_orders_dirs_then_name() {
        let mk = |name: &str, kind: &'static str| FileEntry {
            name: name.to_string(),
            kind,
            size: 0,
            mtime: None,
            mode: None,
            symlink_target: None,
        };
        let mut v = [
            mk("b.txt", "file"),
            mk("Apps", "dir"),
            mk("a.txt", "file"),
            mk("zed", "dir"),
        ];
        v.sort_by(dir_first);
        let order: Vec<&str> = v.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(order, vec!["Apps", "zed", "a.txt", "b.txt"]);
    }

    /// Runs on every platform (the Windows branch is `cfg!`, not `#[cfg]`).
    #[test]
    fn verbatim_prefixes_are_stripped_when_they_have_a_plain_form() {
        let strip = |s: &str| strip_verbatim(s.to_string());
        assert_eq!(strip(r"\\?\C:\Users\gerem"), r"C:\Users\gerem");
        assert_eq!(strip(r"\\?\c:\"), r"c:\");
        assert_eq!(strip(r"\\?\UNC\srv\partage\x"), r"\\srv\partage\x");
        // No plain equivalent, or nothing to strip: left alone.
        assert_eq!(strip(r"\\?\Volume{0c2e}\x"), r"\\?\Volume{0c2e}\x");
        assert_eq!(strip(r"C:\Users\gerem"), r"C:\Users\gerem");
        assert_eq!(strip("/home/gerem"), "/home/gerem");
    }

    #[test]
    fn substring_matcher_is_case_insensitive() {
        let f = FileSearchFilter {
            query: Some("LOG".into()),
            ..Default::default()
        };
        let m = build_matcher(&f).unwrap().unwrap();
        assert!(m.is_match("error.log"));
        assert!(!m.is_match("readme.md"));
    }

    /// Build a small tree, archive it into the channel, reassemble the frames
    /// and read the result back as a real `.tar.gz`.
    #[test]
    fn archive_dir_streams_a_readable_targz() {
        use std::io::Read;

        let root = std::env::temp_dir().join(format!("deveye-archive-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("nested")).unwrap();
        std::fs::write(root.join("top.txt"), b"dessus").unwrap();
        std::fs::write(root.join("nested/deep.txt"), b"dedans").unwrap();

        let (tx, mut rx) = tokio::sync::mpsc::channel(16);
        let walked = root.clone();
        let writer = std::thread::spawn(move || {
            let mut sink = ChunkSink {
                op_id: "op".to_string(),
                tx,
                buf: Vec::new(),
            };
            archive_dir(&walked, &mut sink)
        });

        let mut bytes = Vec::new();
        while let Some(FilesEvent::Chunk { data, error, .. }) = rx.blocking_recv() {
            assert!(error.is_none(), "chunk en erreur : {error:?}");
            bytes.extend_from_slice(&data);
        }
        writer.join().unwrap().unwrap();
        let _ = std::fs::remove_dir_all(&root);

        let mut gz = flate2::read::GzDecoder::new(&bytes[..]);
        let mut tar_bytes = Vec::new();
        gz.read_to_end(&mut tar_bytes).unwrap();

        let base = root.file_name().unwrap().to_string_lossy().into_owned();
        let mut names: Vec<String> = tar::Archive::new(&tar_bytes[..])
            .entries()
            .unwrap()
            .map(|e| e.unwrap().path().unwrap().to_string_lossy().into_owned())
            .collect();
        names.sort();
        // Everything is prefixed by the folder's own name, so extracting it never
        // scatters files into the current directory.
        assert_eq!(
            names,
            vec![
                format!("{base}/nested"),
                format!("{base}/nested/deep.txt"),
                format!("{base}/top.txt"),
            ]
        );
    }
}
