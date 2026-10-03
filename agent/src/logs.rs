//! On-device log reading: enumerate the host's log sources and answer queries
//! against them (system journal, Docker/Podman containers, plain log files, the
//! macOS unified log, the Windows event log).
//!
//! Everything is **read-only** and **best-effort**: a source is offered only when
//! its backing tool/file is present, and a query that the platform can't satisfy
//! returns a clear error the UI surfaces. Native time/unit/priority filters are
//! pushed into the tool where cheap (journalctl, container logs); free-text/regex and
//! the severity floor are then applied uniformly in `post_filter`, so search
//! behaves the same across every source kind.

use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use tokio::sync::mpsc::Sender;

use crate::protocol::{LogAnchor, LogFilter, LogLine, LogSource};

/// The log files a query may read: exactly the ones `detect_sources` offers. The
/// source id comes from the server, and `file:<anything>` would otherwise turn
/// log reading into reading any file on the machine.
pub const FILE_SOURCES: [&str; 4] = [
    "/var/log/syslog",
    "/var/log/messages",
    "/var/log/auth.log",
    "/var/log/kern.log",
];

/// Default / hard cap on the lines returned for one query.
pub const DEFAULT_LIMIT: usize = 500;
pub const MAX_LIMIT: usize = 1000;
/// Hard cap on how far a query may skip back, so a runaway offset can't turn into
/// an unbounded read (mirrors `DEVICE_LOG_OFFSET_MAX`).
pub const MAX_OFFSET: usize = 20_000;
/// How many raw lines to scan when a search/severity filter is active (so matches
/// older than the last page can still surface), bounded to keep memory in check.
const MAX_RAW: usize = 10_000;
/// Same, for a container. Lower on purpose: the engine hands the whole block over
/// at once before anything can be shown, and a container's lines are raw
/// application output — far heavier than a journald record.
const MAX_RAW_CONTAINER: usize = 2_000;
/// Per-line message cap, so a pathological line can't bloat a frame.
const MAX_MSG: usize = 8192;
/// Caps mirrored from the server's schema (`protocol/agent.ts`): a longer error
/// or source detail gets the whole frame rejected, and the viewer then waits for
/// a reply that never comes.
const MAX_ERROR: usize = 500;
const MAX_LABEL: usize = 256;
/// One `log.lines` frame: this many lines or about this many bytes, whichever
/// cap comes first. The server refuses WebSocket payloads above 12 MiB and one
/// line can weigh `MAX_MSG` bytes, escaped.
const CHUNK_LINES: usize = 500;
const CHUNK_BYTES: usize = 1 << 20;

/// Severities, coarsest → highest. Index = rank, used for the `levelMin` floor.
const LEVELS: [&str; 6] = ["debug", "info", "notice", "warning", "error", "critical"];

/// The slice of a source one query asks for: `limit` lines, skipping `offset` from
/// the `anchor` end. A page shorter than `limit` means the source held nothing more
/// in that direction, which is how the viewer knows it has hit the end.
#[derive(Debug, Clone, Copy)]
pub struct LogWindow {
    pub limit: usize,
    pub offset: usize,
    pub anchor: LogAnchor,
}

/// Events a log task streams back to the session loop (which stamps the device id).
pub enum LogEvent {
    /// Result of `log.sources`.
    Sources(Vec<LogSource>),
    /// One chunk of a `log.query` (the last carries `done: true`).
    Lines {
        query_id: String,
        lines: Vec<LogLine>,
        done: bool,
        error: Option<String>,
    },
}

fn level_rank(level: &str) -> u8 {
    LEVELS.iter().position(|l| *l == level).unwrap_or(1) as u8
}

/// Map a journald PRIORITY (0–7) to our normalised level name.
fn journald_priority_level(p: u8) -> &'static str {
    match p {
        0..=2 => "critical",
        3 => "error",
        4 => "warning",
        5 => "notice",
        6 => "info",
        _ => "debug",
    }
}

/// Map a normalised level to the journald `-p` priority floor (shows that severity
/// and above). e.g. `error` → 3 (shows emerg..err).
fn level_to_journald_priority(level: &str) -> u8 {
    match level {
        "critical" => 2,
        "error" => 3,
        "warning" => 4,
        "notice" => 5,
        "info" => 6,
        _ => 7,
    }
}

/// Map a Windows `LevelDisplayName` to our normalised level.
fn win_level(name: &str) -> Option<&'static str> {
    match name {
        "Critical" => Some("critical"),
        "Error" => Some("error"),
        "Warning" => Some("warning"),
        "Information" => Some("info"),
        "Verbose" => Some("debug"),
        _ => None,
    }
}

/// Severity of a line from a source without native levels (Docker, plain files,
/// the macOS unified log): its own `level` field when it is a JSON record, else a
/// coarse guess from its words. `None` when nothing stands out.
fn guess_level(msg: &str) -> Option<&'static str> {
    if let Some(level) = json_level(msg) {
        return Some(level);
    }
    let m = msg.to_ascii_uppercase();
    if m.contains("CRITICAL") || m.contains("FATAL") || m.contains("EMERG") || m.contains("PANIC") {
        Some("critical")
    } else if m.contains("ERROR") || m.contains("[ERR") || m.contains(" ERR ") {
        Some("error")
    } else if m.contains("WARNING") || m.contains("WARN") {
        Some("warning")
    } else if m.contains("NOTICE") {
        Some("notice")
    } else if m.contains("DEBUG") || m.contains("TRACE") {
        Some("debug")
    } else {
        None
    }
}

/// The `level` field of a structured (JSON) log line: pino's numbers (10 trace to
/// 60 fatal) or a name. The words would mislead here: a pino warning whose message
/// says "error" is still a warning, and a fatal line may not say "fatal" at all.
fn json_level(msg: &str) -> Option<&'static str> {
    let line = msg.trim_start();
    if !line.starts_with('{') {
        return None;
    }
    let record: serde_json::Value = serde_json::from_str(line).ok()?;
    match record.get("level")? {
        serde_json::Value::Number(n) => {
            let n = n.as_f64()?;
            Some(if n >= 60.0 {
                "critical"
            } else if n >= 50.0 {
                "error"
            } else if n >= 40.0 {
                "warning"
            } else if n >= 30.0 {
                "info"
            } else {
                "debug"
            })
        }
        serde_json::Value::String(name) => match name.to_ascii_lowercase().as_str() {
            "fatal" | "critical" | "crit" | "emerg" | "alert" | "panic" => Some("critical"),
            "error" | "err" => Some("error"),
            "warn" | "warning" => Some("warning"),
            "notice" => Some("notice"),
            "info" | "information" => Some("info"),
            "debug" | "trace" | "verbose" => Some("debug"),
            _ => None,
        },
        _ => None,
    }
}

/// Cut `s` to at most `max` bytes on a char boundary, marking the cut. Bytes are
/// a safe measure for the server's UTF-16 caps: a char never has fewer bytes
/// than code units.
fn truncate_bytes(mut s: String, max: usize) -> String {
    if s.len() <= max {
        return s;
    }
    let mut end = max.saturating_sub('…'.len_utf8());
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    s.truncate(end);
    s.push('…');
    s
}

fn truncate_msg(s: String) -> String {
    truncate_bytes(s, MAX_MSG)
}

/// Deadline for reading a source. None of these tools is naturally bounded (a
/// container holding several GB of logs, a journal never vacuumed) and their
/// output only becomes visible once the process exits: without a deadline, one
/// fat source leaves the panel spinning with no reason given.
const READ_TIMEOUT: Duration = Duration::from_secs(45);
/// Same, for the inventory: detection has to feel immediate, and a wedged engine
/// daemon must cost a listing, not the whole panel.
pub(crate) const DETECT_TIMEOUT: Duration = Duration::from_secs(10);
/// How often the deadline is checked while the child runs.
const POLL_INTERVAL: Duration = Duration::from_millis(50);
/// How long to wait for the pipe readers once the child is gone. Its pipes close
/// with it, unless a grandchild inherited one: then a truncated read beats a
/// query that never answers.
const READER_GRACE: Duration = Duration::from_secs(2);

/// Run a command under a deadline and hand back its `(stdout, stderr)`, killing it
/// if it overruns. `label` is what the error blames (`docker logs`, `journalctl`…).
///
/// Both streams come back because both can be log content: a container engine
/// forwards the container's stderr to ours. On failure stderr is the diagnostic.
///
/// Each pipe is drained by its own thread rather than after the wait: a child
/// filling a pipe nobody reads blocks on it, the very hang this is meant to break.
fn run_bounded<S: AsRef<std::ffi::OsStr>>(
    label: &str,
    program: &str,
    args: &[S],
    timeout: Duration,
) -> Result<(Vec<u8>, Vec<u8>)> {
    run_bounded_capped(label, program, args, timeout, None, None)
}

/// Drain one pipe, stopping early once `max_lines` newlines have been seen across
/// every pipe sharing `seen`. Both pipes share the counter because a container's
/// output can land entirely on stderr.
fn drain_pipe(
    pipe: &mut dyn std::io::Read,
    max_lines: Option<usize>,
    seen: &AtomicUsize,
) -> Vec<u8> {
    let mut buf = Vec::new();
    let Some(cap) = max_lines else {
        let _ = pipe.read_to_end(&mut buf);
        return buf;
    };
    let mut chunk = [0u8; 64 * 1024];
    loop {
        let n = match pipe.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        let newlines = chunk[..n].iter().filter(|b| **b == b'\n').count();
        buf.extend_from_slice(&chunk[..n]);
        if seen.fetch_add(newlines, Ordering::Relaxed) + newlines >= cap {
            break;
        }
    }
    buf
}

/// `run_bounded`, plus an optional line cap: reading a source from its beginning
/// has no `--tail` to bound it, so the cap is what keeps a multi-GB journal from
/// being swallowed whole. Reaching it kills the child, which is a success here, not
/// the failure a non-zero status usually means. A raised `cancel` flag kills it
/// too, as a failure: the query it served has been replaced by a newer one.
pub(crate) fn run_bounded_capped<S: AsRef<std::ffi::OsStr>>(
    label: &str,
    program: &str,
    args: &[S],
    timeout: Duration,
    max_lines: Option<usize>,
    cancel: Option<&AtomicBool>,
) -> Result<(Vec<u8>, Vec<u8>)> {
    use std::process::Stdio;

    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("lancement de {label}"))?;

    let mut out_pipe = child.stdout.take().expect("stdout demandé au spawn");
    let mut err_pipe = child.stderr.take().expect("stderr demandé au spawn");
    let seen = Arc::new(AtomicUsize::new(0));
    let seen_out = Arc::clone(&seen);
    let seen_err = Arc::clone(&seen);
    let (out_tx, out_rx) = std::sync::mpsc::channel();
    let (err_tx, err_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = out_tx.send(drain_pipe(&mut out_pipe, max_lines, &seen_out));
    });
    std::thread::spawn(move || {
        let _ = err_tx.send(drain_pipe(&mut err_pipe, max_lines, &seen_err));
    });

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child
            .try_wait()
            .with_context(|| format!("attente de {label}"))?
        {
            Some(status) => break status,
            None if max_lines.is_some_and(|cap| seen.load(Ordering::Relaxed) >= cap) => {
                let _ = child.kill();
                break child
                    .wait()
                    .with_context(|| format!("attente de {label}"))?;
            }
            None if cancel.is_some_and(|flag| flag.load(Ordering::Relaxed)) => {
                let _ = child.kill();
                let _ = child.wait();
                bail!("{label} : interrogation remplacée par une plus récente");
            }
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                bail!(
                    "{label} : abandon après {} s, source trop volumineuse, resserrez la fenêtre de temps ou le filtre",
                    timeout.as_secs()
                );
            }
            None => std::thread::sleep(POLL_INTERVAL),
        }
    };

    // The process is gone, so its pipes are closed and the readers return by
    // themselves; `READER_GRACE` covers a grandchild still holding one.
    let stdout = out_rx.recv_timeout(READER_GRACE).unwrap_or_default();
    let stderr = err_rx.recv_timeout(READER_GRACE).unwrap_or_default();
    // Hitting the cap closes the pipe under the tool: the SIGPIPE (or the kill)
    // that follows is the normal end of the read, not a failure to report.
    let capped = max_lines.is_some_and(|cap| seen.load(Ordering::Relaxed) >= cap);
    if !capped && !status.success() {
        // Bounded here already: with the label, the message must fit `MAX_ERROR`.
        let diagnostic = truncate_bytes(String::from_utf8_lossy(&stderr).trim().to_string(), 400);
        bail!("{label}: {diagnostic}");
    }
    Ok((stdout, stderr))
}

/// Run a command and return its stdout when it succeeds, else `None` (missing
/// binary, non-zero exit, or a daemon that didn't answer in time). Used for
/// best-effort detection.
pub(crate) fn run_capture(program: &str, args: &[&str]) -> Option<String> {
    let (stdout, _) = run_bounded(program, program, args, DETECT_TIMEOUT).ok()?;
    Some(String::from_utf8_lossy(&stdout).into_owned())
}

#[cfg(target_os = "linux")]
fn command_exists(program: &str, args: &[&str]) -> bool {
    use std::process::Stdio;
    Command::new(program)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn file_label(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

/// Enumerate the host's log sources. Synchronous (shells out); callers run it off
/// the runtime via `spawn_blocking`.
pub fn detect_sources() -> Vec<LogSource> {
    let mut out = Vec::new();

    #[cfg(target_os = "linux")]
    {
        if command_exists("journalctl", &["--version"]) {
            out.push(LogSource {
                id: "journald".to_string(),
                kind: "journald",
                label: "Journal système (systemd)".to_string(),
                detail: None,
                running: None,
            });
        }
        for path in FILE_SOURCES {
            if std::path::Path::new(path).is_file() {
                out.push(LogSource {
                    id: format!("file:{path}"),
                    kind: "syslog",
                    label: file_label(path),
                    detail: Some(path.to_string()),
                    running: None,
                });
            }
        }
    }

    // Conteneurs, quel que soit l'OS. Un `ps` qui échoue (binaire absent, démon
    // arrêté, socket interdite) ne donne simplement aucune source.
    for bin in crate::docker::CONTAINER_RUNTIMES {
        let Some(list) = run_capture(
            bin,
            &[
                "ps",
                "-a",
                "--no-trunc",
                "--format",
                "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.State}}",
            ],
        ) else {
            continue;
        };
        for line in list.lines() {
            let parts: Vec<&str> = line.splitn(4, '\t').collect();
            if parts.len() < 2 || parts[0].is_empty() {
                continue;
            }
            out.push(LogSource {
                id: format!("{bin}:{}", parts[0]),
                kind: "docker",
                label: truncate_bytes(parts[1].to_string(), MAX_LABEL),
                detail: parts
                    .get(2)
                    .map(|image| truncate_bytes(format!("{bin} · {image}"), MAX_LABEL)),
                running: parts.get(3).map(|s| s.eq_ignore_ascii_case("running")),
            });
        }
    }

    #[cfg(target_os = "macos")]
    {
        out.push(LogSource {
            id: "oslog".to_string(),
            kind: "oslog",
            label: "Journal unifié (macOS)".to_string(),
            detail: None,
            running: None,
        });
    }

    #[cfg(target_os = "windows")]
    {
        for ch in ["System", "Application", "Security", "Setup"] {
            out.push(LogSource {
                id: format!("eventlog:{ch}"),
                kind: "eventlog",
                label: format!("Journal {ch}"),
                detail: None,
                running: None,
            });
        }
    }

    out
}

/// Run one log query: read raw lines from the source, then apply the uniform
/// post-filter (text/regex, severity floor, time window) and cut out `window`.
/// `cancel`, once raised, stops the read: a newer query on the same source has
/// taken over.
pub fn run_query(
    source_id: &str,
    filter: &LogFilter,
    window: LogWindow,
    cancel: &AtomicBool,
) -> Result<Vec<LogLine>> {
    let window = LogWindow {
        limit: window.limit.clamp(1, MAX_LIMIT),
        offset: window.offset.min(MAX_OFFSET),
        anchor: window.anchor,
    };
    let searching =
        filter.search.as_deref().is_some_and(|s| !s.is_empty()) || filter.level_min.is_some();

    let container = source_id
        .split_once(':')
        .filter(|(bin, _)| crate::docker::CONTAINER_RUNTIMES.contains(bin));

    // Le plafond de balayage dépend de la source : une ligne de conteneur coûte
    // bien plus cher qu'une ligne de journal (sortie applicative brute, rendue
    // d'un bloc), donc chercher y remonte moins loin dans le passé.
    let max_raw = if container.is_some() {
        MAX_RAW_CONTAINER
    } else {
        MAX_RAW
    };
    // Assez de lignes brutes pour couvrir la page demandée ET tout ce qu'on saute
    // pour l'atteindre. Élargir le balayage d'une page à l'autre ne fait que
    // préfixer des lignes plus anciennes, donc un offset compté depuis une
    // extrémité désigne toujours la même fenêtre.
    let span = window.offset.saturating_add(window.limit);
    let raw_cap = if searching { max_raw.max(span) } else { span };
    let anchor = window.anchor;

    let raw = if source_id == "journald" {
        read_journald(filter, raw_cap, anchor, cancel)?
    } else if let Some((bin, id)) = container {
        read_container(bin, id, filter, raw_cap, anchor, cancel)?
    } else if let Some(path) = source_id
        .strip_prefix("file:")
        .filter(|p| FILE_SOURCES.contains(p))
    {
        read_file(path, raw_cap, anchor, cancel)?
    } else if source_id == "oslog" {
        read_oslog(raw_cap, anchor, cancel)?
    } else if let Some(channel) = source_id.strip_prefix("eventlog:") {
        read_eventlog(channel, raw_cap, cancel)?
    } else {
        bail!("source de logs inconnue : {source_id}");
    };

    post_filter(raw, filter, window)
}

/// Matcher built from the query's `search`/`regex` fields.
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

fn build_matcher(filter: &LogFilter) -> Result<Option<Matcher>> {
    let Some(q) = filter.search.as_deref().filter(|s| !s.is_empty()) else {
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

/// Apply the severity floor, time window and text/regex match uniformly, then cut
/// out the requested window of matching lines.
fn post_filter(
    mut lines: Vec<LogLine>,
    filter: &LogFilter,
    window: LogWindow,
) -> Result<Vec<LogLine>> {
    let min_rank = filter.level_min.as_deref().map(level_rank);
    let since_ms = filter.since.map(|s| s * 1000);
    let until_ms = filter.until.map(|u| u * 1000);
    let matcher = build_matcher(filter)?;

    lines.retain(|l| {
        // A line whose level can't be told (most container output) counts as
        // info: a floor of info or below must not empty a container's log.
        if let Some(min) = min_rank {
            if level_rank(l.level.unwrap_or("info")) < min {
                return false;
            }
        }
        if let (Some(s), Some(ts)) = (since_ms, l.ts) {
            if ts < s {
                return false;
            }
        }
        if let (Some(u), Some(ts)) = (until_ms, l.ts) {
            if ts > u {
                return false;
            }
        }
        if let Some(m) = &matcher {
            let hit = m.is_match(&l.message) || l.unit.as_deref().is_some_and(|u| m.is_match(u));
            if !hit {
                return false;
            }
        }
        true
    });

    let len = lines.len();
    let (start, end) = match window.anchor {
        LogAnchor::Newest => {
            let end = len.saturating_sub(window.offset);
            (end.saturating_sub(window.limit), end)
        }
        LogAnchor::Oldest => {
            let start = window.offset.min(len);
            (start, start.saturating_add(window.limit).min(len))
        }
    };
    lines.truncate(end);
    lines.drain(0..start);
    Ok(lines)
}

fn read_journald(
    filter: &LogFilter,
    raw_cap: usize,
    anchor: LogAnchor,
    cancel: &AtomicBool,
) -> Result<Vec<LogLine>> {
    let mut args: Vec<String> = vec!["-o".into(), "json".into(), "--no-pager".into()];
    // `-n` ne borne que par la queue : pour lire le début, on laisse journalctl
    // dérouler dans l'ordre et c'est le plafond de lignes qui l'arrête.
    let max_lines = match anchor {
        LogAnchor::Newest => {
            args.push("-n".into());
            args.push(raw_cap.to_string());
            None
        }
        LogAnchor::Oldest => Some(raw_cap),
    };
    if let Some(u) = filter.unit.as_deref().filter(|s| !s.is_empty()) {
        args.push("-u".into());
        args.push(u.to_string());
    }
    if let Some(s) = filter.since {
        args.push("--since".into());
        args.push(format!("@{s}"));
    }
    if let Some(u) = filter.until {
        args.push("--until".into());
        args.push(format!("@{u}"));
    }
    if let Some(min) = filter.level_min.as_deref() {
        args.push("-p".into());
        args.push(level_to_journald_priority(min).to_string());
    }

    let (stdout, _) = run_bounded_capped(
        "journalctl",
        "journalctl",
        &args,
        READ_TIMEOUT,
        max_lines,
        Some(cancel),
    )?;
    let text = String::from_utf8_lossy(&stdout);
    let mut lines = Vec::new();
    for raw in text.lines() {
        if raw.is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) {
            lines.push(journald_line(&v));
        }
    }
    Ok(lines)
}

fn jv_str(v: &serde_json::Value) -> Option<&str> {
    v.as_str()
}

/// journald MESSAGE is a string, or an array of byte values when non-UTF8.
pub(crate) fn jv_message(v: Option<&serde_json::Value>) -> String {
    match v {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Array(a)) => {
            let bytes: Vec<u8> = a
                .iter()
                .filter_map(|x| x.as_u64())
                .map(|n| n as u8)
                .collect();
            String::from_utf8_lossy(&bytes).into_owned()
        }
        _ => String::new(),
    }
}

fn journald_line(v: &serde_json::Value) -> LogLine {
    let ts = v
        .get("__REALTIME_TIMESTAMP")
        .and_then(jv_str)
        .and_then(|s| s.parse::<i64>().ok())
        .map(|us| us / 1000);
    let level = v
        .get("PRIORITY")
        .and_then(jv_str)
        .and_then(|s| s.parse::<u8>().ok())
        .map(journald_priority_level);
    let unit = v
        .get("_SYSTEMD_UNIT")
        .and_then(jv_str)
        .or_else(|| v.get("SYSLOG_IDENTIFIER").and_then(jv_str))
        .map(|s| s.to_string());
    LogLine {
        ts,
        level,
        message: truncate_msg(jv_message(v.get("MESSAGE"))),
        unit,
    }
}

/// Read one container's logs through its engine's CLI (`bin` is `docker`/`podman`,
/// both taking the same flags).
fn read_container(
    bin: &str,
    id: &str,
    filter: &LogFilter,
    raw_cap: usize,
    anchor: LogAnchor,
    cancel: &AtomicBool,
) -> Result<Vec<LogLine>> {
    let mut args: Vec<String> = vec!["logs".into(), "--timestamps".into()];
    // Sans `--tail`, l'engin rejoue le conteneur depuis sa première ligne ; le
    // plafond de lignes est alors la seule borne.
    let max_lines = match anchor {
        LogAnchor::Newest => {
            args.push("--tail".into());
            args.push(raw_cap.to_string());
            None
        }
        LogAnchor::Oldest => Some(raw_cap),
    };
    if let Some(s) = filter.since {
        args.push("--since".into());
        args.push(s.to_string());
    }
    if let Some(u) = filter.until {
        args.push("--until".into());
        args.push(u.to_string());
    }
    args.push(id.to_string());

    // The engine sends the container's stdout to our stdout and its stderr to our
    // stderr; both are real log output. Parse the leading RFC3339 timestamp added
    // by --timestamps, then merge the two streams chronologically.
    let (stdout, stderr) = run_bounded_capped(
        &format!("{bin} logs"),
        bin,
        &args,
        READ_TIMEOUT,
        max_lines,
        Some(cancel),
    )?;
    let mut lines = Vec::new();
    for data in [&stdout, &stderr] {
        for raw in String::from_utf8_lossy(data).lines() {
            if raw.is_empty() {
                continue;
            }
            let (ts, msg) = match raw.split_once(' ') {
                Some((tspart, rest)) => (parse_rfc3339_ms(tspart), rest.to_string()),
                None => (None, raw.to_string()),
            };
            lines.push(LogLine {
                ts,
                level: guess_level(&msg),
                message: truncate_msg(msg),
                unit: None,
            });
        }
    }
    lines.sort_by_key(|l| l.ts.unwrap_or(i64::MIN));
    Ok(lines)
}

/// Every 1024 lines of a plain file: the deadline and the cancel flag. The
/// newest lines of a multi-GB file cost a full read, which nothing else bounds.
fn file_budget(path: &str, deadline: Instant, cancel: &AtomicBool, seen: usize) -> Result<()> {
    if !seen.is_multiple_of(1024) {
        return Ok(());
    }
    if cancel.load(Ordering::Relaxed) {
        bail!("lecture de {path} : interrogation remplacée par une plus récente");
    }
    if Instant::now() >= deadline {
        bail!(
            "lecture de {path} : abandon après {} s, fichier trop volumineux",
            READ_TIMEOUT.as_secs()
        );
    }
    Ok(())
}

fn read_file(
    path: &str,
    raw_cap: usize,
    anchor: LogAnchor,
    cancel: &AtomicBool,
) -> Result<Vec<LogLine>> {
    use std::collections::VecDeque;
    use std::io::BufRead;

    let file = std::fs::File::open(path).with_context(|| format!("ouverture de {path}"))?;
    let reader = std::io::BufReader::new(file);
    let deadline = Instant::now() + READ_TIMEOUT;
    let raw: Vec<String> = match anchor {
        // Ring buffer of the last `raw_cap` lines, so a multi-GB file stays bounded.
        LogAnchor::Newest => {
            let mut ring: VecDeque<String> = VecDeque::with_capacity(raw_cap.min(4096));
            for (seen, line) in reader.lines().enumerate() {
                file_budget(path, deadline, cancel, seen)?;
                let line = line.unwrap_or_default();
                if ring.len() >= raw_cap {
                    ring.pop_front();
                }
                ring.push_back(line);
            }
            ring.into()
        }
        LogAnchor::Oldest => {
            let mut head = Vec::with_capacity(raw_cap.min(4096));
            for (seen, line) in reader.lines().take(raw_cap).enumerate() {
                file_budget(path, deadline, cancel, seen)?;
                head.push(line.unwrap_or_default());
            }
            head
        }
    };
    Ok(raw
        .into_iter()
        .filter(|l| !l.is_empty())
        .map(|l| LogLine {
            ts: None,
            level: guess_level(&l),
            message: truncate_msg(l),
            unit: None,
        })
        .collect())
}

/// `LogAnchor::Oldest` reaches the start of the hour `log show` returns, not the
/// start of the unified log: the tool is time-bounded, not line-bounded.
fn read_oslog(raw_cap: usize, anchor: LogAnchor, cancel: &AtomicBool) -> Result<Vec<LogLine>> {
    // `log show` is time-based, not line-bounded; default to the last hour and cap
    // the lines afterwards (precise time windows are applied in post_filter only
    // when the source carries timestamps: best-effort on macOS).
    let (stdout, _) = run_bounded_capped(
        "log show",
        "log",
        &["show", "--style", "syslog", "--no-pager", "--last", "1h"],
        READ_TIMEOUT,
        None,
        Some(cancel),
    )?;
    let text = String::from_utf8_lossy(&stdout);
    let mut lines: Vec<LogLine> = text
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| LogLine {
            ts: None,
            level: guess_level(l),
            message: truncate_msg(l.to_string()),
            unit: None,
        })
        .collect();
    if lines.len() > raw_cap {
        match anchor {
            LogAnchor::Newest => {
                let start = lines.len() - raw_cap;
                lines.drain(0..start);
            }
            LogAnchor::Oldest => lines.truncate(raw_cap),
        }
    }
    Ok(lines)
}

/// Always reads the newest events: `Get-WinEvent` only counts back from the top, so
/// `LogAnchor::Oldest` reaches the start of that window, not the start of the channel.
fn read_eventlog(channel: &str, raw_cap: usize, cancel: &AtomicBool) -> Result<Vec<LogLine>> {
    let max = raw_cap.min(MAX_RAW);
    let script = format!(
        "Get-WinEvent -LogName '{}' -MaxEvents {} -ErrorAction Stop | \
         Select-Object @{{n='ts';e={{[int64]($_.TimeCreated.ToUniversalTime() - (Get-Date '1970-01-01')).TotalMilliseconds}}}}, \
         @{{n='level';e={{$_.LevelDisplayName}}}}, @{{n='msg';e={{$_.Message}}}} | ConvertTo-Json -Compress",
        channel.replace('\'', "''"),
        max
    );
    let (stdout, _) = run_bounded_capped(
        "Get-WinEvent",
        "powershell",
        &["-NoProfile", "-NonInteractive", "-Command", &script],
        READ_TIMEOUT,
        None,
        Some(cancel),
    )?;
    let text = String::from_utf8_lossy(&stdout);
    let parsed: serde_json::Value =
        serde_json::from_str(text.trim()).unwrap_or(serde_json::Value::Null);
    let arr = match parsed {
        serde_json::Value::Array(a) => a,
        v @ serde_json::Value::Object(_) => vec![v], // a single event isn't wrapped in an array
        _ => vec![],
    };
    let mut lines: Vec<LogLine> = arr
        .iter()
        .map(|e| LogLine {
            ts: e.get("ts").and_then(|v| v.as_i64()),
            level: e.get("level").and_then(jv_str).and_then(win_level),
            message: truncate_msg(e.get("msg").and_then(jv_str).unwrap_or("").to_string()),
            unit: None,
        })
        .collect();
    lines.reverse(); // Get-WinEvent is newest-first; present chronologically.
    Ok(lines)
}

/// Days from 1970-01-01 to the given civil date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Parse a docker `--timestamps` RFC3339 UTC prefix (e.g. `2024-01-02T15:04:05.123Z`)
/// to unix milliseconds. `None` on any deviation from that fixed shape.
fn parse_rfc3339_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if s.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' {
        return None;
    }
    let year: i64 = s.get(0..4)?.parse().ok()?;
    let month: i64 = s.get(5..7)?.parse().ok()?;
    let day: i64 = s.get(8..10)?.parse().ok()?;
    let hour: i64 = s.get(11..13)?.parse().ok()?;
    let min: i64 = s.get(14..16)?.parse().ok()?;
    let sec: i64 = s.get(17..19)?.parse().ok()?;
    let days = days_from_civil(year, month, day);
    let mut ms = (days * 86400 + hour * 3600 + min * 60 + sec) * 1000;
    if b.get(19) == Some(&b'.') {
        let mut frac: String = s[20..]
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .take(3)
            .collect();
        while frac.len() < 3 && !frac.is_empty() {
            frac.push('0');
        }
        if let Ok(v) = frac.parse::<i64>() {
            ms += v;
        }
    }
    Some(ms)
}

/// Enumerate sources off the runtime and stream the result.
pub async fn detect_task(tx: Sender<LogEvent>) {
    let sources = tokio::task::spawn_blocking(detect_sources)
        .await
        .unwrap_or_default();
    let _ = tx.send(LogEvent::Sources(sources)).await;
}

/// Split a result into frames of at most `CHUNK_LINES` lines or about
/// `CHUNK_BYTES` bytes: a page of fat container lines must not exceed what the
/// server accepts in one WebSocket message.
fn chunk_lines(lines: Vec<LogLine>) -> Vec<Vec<LogLine>> {
    let mut chunks = Vec::new();
    let mut current: Vec<LogLine> = Vec::new();
    let mut bytes = 0usize;
    for line in lines {
        let cost = line.message.len() + line.unit.as_ref().map_or(0, String::len) + 48;
        if !current.is_empty() && (current.len() >= CHUNK_LINES || bytes + cost > CHUNK_BYTES) {
            chunks.push(std::mem::take(&mut current));
            bytes = 0;
        }
        bytes += cost;
        current.push(line);
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

/// Run a query off the runtime and stream the result in bounded chunks (the last
/// carrying `done`). On failure, one terminal chunk carries the error. A query
/// cancelled midway still ends with its error frame: the viewer has moved on,
/// the server's bookkeeping has not.
pub async fn run_query_task(
    query_id: String,
    source_id: String,
    filter: LogFilter,
    window: LogWindow,
    tx: Sender<LogEvent>,
    cancel: Arc<AtomicBool>,
) {
    let res =
        tokio::task::spawn_blocking(move || run_query(&source_id, &filter, window, &cancel)).await;
    let lines = match res {
        Ok(Ok(lines)) => lines,
        Ok(Err(e)) => return send_error(&tx, query_id, e.to_string()).await,
        Err(e) => return send_error(&tx, query_id, e.to_string()).await,
    };
    if lines.is_empty() {
        let _ = tx
            .send(LogEvent::Lines {
                query_id,
                lines: vec![],
                done: true,
                error: None,
            })
            .await;
        return;
    }
    let chunks = chunk_lines(lines);
    let total = chunks.len();
    for (index, chunk) in chunks.into_iter().enumerate() {
        let _ = tx
            .send(LogEvent::Lines {
                query_id: query_id.clone(),
                lines: chunk,
                done: index + 1 == total,
                error: None,
            })
            .await;
    }
}

async fn send_error(tx: &Sender<LogEvent>, query_id: String, error: String) {
    let _ = tx
        .send(LogEvent::Lines {
            query_id,
            lines: vec![],
            done: true,
            error: Some(truncate_bytes(error, MAX_ERROR)),
        })
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_source_outside_the_offered_ones_is_refused() {
        let filter = LogFilter::default();
        for source in [
            "file:/etc/shadow",
            "file:/var/log/../../etc/passwd",
            "file:/root/.ssh/id_ed25519",
        ] {
            let err = run_query(source, &filter, newest(10, 0), &AtomicBool::new(false))
                .unwrap_err()
                .to_string();
            assert!(err.contains("inconnue"), "{source}: {err}");
        }
    }

    fn newest(limit: usize, offset: usize) -> LogWindow {
        LogWindow {
            limit,
            offset,
            anchor: LogAnchor::Newest,
        }
    }

    fn oldest(limit: usize, offset: usize) -> LogWindow {
        LogWindow {
            limit,
            offset,
            anchor: LogAnchor::Oldest,
        }
    }

    fn line(ts: i64, message: &str) -> LogLine {
        LogLine {
            ts: Some(ts),
            level: Some("info"),
            message: message.into(),
            unit: None,
        }
    }

    #[test]
    fn a_json_line_is_ranked_by_its_own_level() {
        // A pino warning that mentions an error stays a warning.
        let warn = r#"{"level":40,"time":1,"msg":"Request rejected","reason":"Error: quota"}"#;
        assert_eq!(guess_level(warn), Some("warning"));
        assert_eq!(
            guess_level(r#"{"level":60,"msg":"Uncaught exception"}"#),
            Some("critical")
        );
        assert_eq!(
            guess_level(r#"{"level":30,"msg":"request completed"}"#),
            Some("info")
        );
        assert_eq!(
            guess_level(r#"{"level":"warn","message":"slow"}"#),
            Some("warning")
        );
    }

    #[test]
    fn a_line_that_is_not_json_is_still_guessed_from_its_words() {
        assert_eq!(
            guess_level("Error: connect ECONNREFUSED 127.0.0.1:3306"),
            Some("error")
        );
        assert_eq!(guess_level("{not json but an ERROR}"), Some("error"));
        assert_eq!(guess_level(r#"{"msg":"no level here"}"#), None);
    }

    #[test]
    fn level_rank_orders_severities() {
        assert!(level_rank("error") > level_rank("warning"));
        assert!(level_rank("critical") > level_rank("error"));
        assert_eq!(level_rank("debug"), 0);
    }

    #[test]
    fn journald_priority_maps() {
        assert_eq!(journald_priority_level(0), "critical");
        assert_eq!(journald_priority_level(3), "error");
        assert_eq!(journald_priority_level(6), "info");
        assert_eq!(journald_priority_level(7), "debug");
    }

    #[test]
    fn parse_rfc3339_ms_parses_docker_timestamps() {
        // 2021-01-01T00:00:00Z == 1609459200000 ms.
        assert_eq!(
            parse_rfc3339_ms("2021-01-01T00:00:00Z"),
            Some(1_609_459_200_000)
        );
        assert_eq!(
            parse_rfc3339_ms("2021-01-01T00:00:00.250Z"),
            Some(1_609_459_200_250)
        );
        assert_eq!(parse_rfc3339_ms("not-a-timestamp"), None);
    }

    #[test]
    fn post_filter_applies_level_and_search() {
        let lines = vec![
            LogLine {
                ts: Some(1000),
                level: Some("info"),
                message: "hello world".into(),
                unit: None,
            },
            LogLine {
                ts: Some(2000),
                level: Some("error"),
                message: "boom failure".into(),
                unit: None,
            },
        ];
        let filter = LogFilter {
            level_min: Some("warning".into()),
            ..Default::default()
        };
        let out = post_filter(lines.clone(), &filter, newest(100, 0)).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].message, "boom failure");

        let filter = LogFilter {
            search: Some("HELLO".into()),
            ..Default::default()
        };
        let out = post_filter(lines, &filter, newest(100, 0)).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].message, "hello world");
    }

    #[test]
    fn a_line_without_level_counts_as_info_for_the_floor() {
        let unknown = LogLine {
            ts: Some(1000),
            level: None,
            message: "GET /health 200".into(),
            unit: None,
        };
        let at = |floor: &str| {
            let filter = LogFilter {
                level_min: Some(floor.into()),
                ..Default::default()
            };
            post_filter(vec![unknown.clone()], &filter, newest(10, 0))
                .unwrap()
                .len()
        };
        assert_eq!(at("debug"), 1);
        assert_eq!(at("info"), 1);
        assert_eq!(at("warning"), 0);
    }

    /// Le contrat de la pagination : les deux ancres découpent la même liste par
    /// pages contiguës, et une page courte dit qu'il n'y a plus rien au-delà.
    #[test]
    fn post_filter_cuts_the_requested_window() {
        let lines: Vec<LogLine> = (0..10).map(|i| line(i, &format!("l{i}"))).collect();
        let f = LogFilter::default();

        let page0 = post_filter(lines.clone(), &f, newest(4, 0)).unwrap();
        let page1 = post_filter(lines.clone(), &f, newest(4, 4)).unwrap();
        assert_eq!(page0.first().unwrap().message, "l6");
        assert_eq!(page0.last().unwrap().message, "l9");
        assert_eq!(page1.first().unwrap().message, "l2");
        assert_eq!(page1.last().unwrap().message, "l5");

        let head = post_filter(lines.clone(), &f, oldest(4, 0)).unwrap();
        let head1 = post_filter(lines.clone(), &f, oldest(4, 4)).unwrap();
        assert_eq!(head.first().unwrap().message, "l0");
        assert_eq!(head1.first().unwrap().message, "l4");

        // Une page plus courte que `limit` : il n'y a plus rien dans cette direction.
        let tail = post_filter(lines.clone(), &f, newest(4, 8)).unwrap();
        assert_eq!(tail.len(), 2);
        assert_eq!(tail.first().unwrap().message, "l0");
        // Au-delà du journal, rien plutôt qu'un débordement.
        assert!(post_filter(lines.clone(), &f, newest(4, 50))
            .unwrap()
            .is_empty());
        assert!(post_filter(lines, &f, oldest(4, 50)).unwrap().is_empty());
    }

    /// L'arrêt anticipé : un producteur sans fin doit rendre la main au plafond de
    /// lignes, et sans être compté comme un échec malgré le kill.
    #[cfg(unix)]
    #[test]
    fn run_bounded_capped_stops_at_the_line_cap() {
        let (stdout, _) = run_bounded_capped(
            "sh",
            "sh",
            &["-c", "i=0; while :; do echo $i; i=$((i+1)); done"],
            Duration::from_secs(10),
            Some(50),
            None,
        )
        .expect("le plafond n'est pas une erreur");
        let seen = String::from_utf8_lossy(&stdout).lines().count();
        assert!(seen >= 50, "au moins le plafond demandé, vu {seen}");
    }

    #[test]
    fn truncate_bytes_cuts_on_a_char_boundary_within_the_cap() {
        let cut = truncate_bytes("é".repeat(300), MAX_ERROR);
        assert!(cut.len() <= MAX_ERROR, "{} octets", cut.len());
        assert!(cut.ends_with('…'));
        assert_eq!(truncate_bytes("court".into(), 10), "court");
    }

    #[test]
    fn chunking_respects_both_caps() {
        let many: Vec<LogLine> = (0..1200).map(|i| line(i, "x")).collect();
        assert_eq!(
            chunk_lines(many).iter().map(Vec::len).collect::<Vec<_>>(),
            vec![500, 500, 200]
        );
        let fat: Vec<LogLine> = (0..10).map(|i| line(i, &"m".repeat(300 * 1024))).collect();
        let chunks = chunk_lines(fat);
        assert!(chunks.iter().all(|c| c.len() <= 3));
        assert_eq!(chunks.iter().map(Vec::len).sum::<usize>(), 10);
    }

    /// A newer query on the same source raises the flag: the old read stops and
    /// says so, instead of running to its deadline behind the user's back.
    #[cfg(unix)]
    #[test]
    fn a_cancelled_command_is_reported_as_replaced() {
        let cancel = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&cancel);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            flag.store(true, Ordering::Relaxed);
        });
        let started = Instant::now();
        let err = run_bounded_capped(
            "sleep",
            "sleep",
            &["30"],
            Duration::from_secs(30),
            None,
            Some(&cancel),
        )
        .expect_err("l'annulation doit être une erreur");
        assert!(err.to_string().contains("remplacée"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    /// La raison d'être du helper : un outil qui ne rend jamais la main doit
    /// devenir une erreur, pas une attente sans fin.
    #[cfg(unix)]
    #[test]
    fn run_bounded_kills_a_command_that_overruns() {
        let started = Instant::now();
        let err = run_bounded("sleep", "sleep", &["30"], Duration::from_millis(200))
            .expect_err("le dépassement doit être une erreur");
        assert!(err.to_string().contains("abandon"));
        // Sans le kill, ce test durerait trente secondes.
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    /// Les deux flux reviennent : pour un conteneur, stderr est du log, pas un
    /// diagnostic.
    #[cfg(unix)]
    #[test]
    fn run_bounded_returns_both_streams() {
        let (stdout, stderr) = run_bounded(
            "sh",
            "sh",
            &["-c", "echo dessus; echo dedans 1>&2"],
            Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(String::from_utf8_lossy(&stdout).trim(), "dessus");
        assert_eq!(String::from_utf8_lossy(&stderr).trim(), "dedans");
    }
}
