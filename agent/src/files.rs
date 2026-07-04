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

/// Hard cap on returned search hits (mirrors deveye-types `FILE_SEARCH_MAX`).
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

// ───────────────────────────── metadata helpers ───────────────────────────
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

/// Directories first, then case-insensitive name.
fn dir_first(a: &FileEntry, b: &FileEntry) -> Ordering {
    let ad = a.kind == "dir";
    let bd = b.kind == "dir";
    bd.cmp(&ad)
        .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
}

// ─────────────────────────────────── list ─────────────────────────────────
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
        path: canon.to_string_lossy().into_owned(),
        parent: canon.parent().map(|p| p.to_string_lossy().into_owned()),
        entries,
    })
}

// ───────────────────────────────── analyze ────────────────────────────────

/// Virtual (kernel) filesystems whose apparent sizes are meaningless — and
/// sometimes absurd (`/proc/kcore` reports ~128 TiB): never walk them. Without
/// this, analysing `/` on Linux produced garbage totals.
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
/// A single shared walk budget across all children (kept large enough that only
/// pathological trees ever hit it): the ordering is fine for the intended use,
/// and — crucially — it keeps most results *complete* so the client can cache
/// them. A per-child fair split was tried and backfired: each child got a small
/// slice, far more results came back `partial`, and the client (which won't
/// cache partial results) then recomputed on every navigation.
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
            // Kernel filesystems have meaningless (sometimes absurd) sizes.
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

// ───────────────────────────────── search ─────────────────────────────────
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
                    path: path.to_string_lossy().into_owned(),
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

// ───────────────────────────────── mutate ─────────────────────────────────
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

// ──────────────────────────────── transfer ────────────────────────────────
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

/// Stream a file back to the server in chunks on a dedicated OS thread (blocking
/// reads, back-pressured by the bounded channel). The final frame carries `done`,
/// or an `error` if the file couldn't be opened/read.
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
            return fail(&tx, "C'est un dossier, pas un fichier".to_string());
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

// ───────────────────────────────── tasks ──────────────────────────────────
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
}
