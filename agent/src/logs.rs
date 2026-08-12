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
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use tokio::sync::mpsc::Sender;

use crate::protocol::{LogFilter, LogLine, LogSource};

/// Default / hard cap on the lines returned for one query.
pub const DEFAULT_LIMIT: usize = 200;
pub const MAX_LIMIT: usize = 1000;
/// How many raw lines to scan when a search/severity filter is active (so matches
/// older than the last page can still surface), bounded to keep memory in check.
const MAX_RAW: usize = 10_000;
/// Same, for a container. Lower on purpose: the engine hands the whole block over
/// at once before anything can be shown, and a container's lines are raw
/// application output — far heavier than a journald record.
const MAX_RAW_CONTAINER: usize = 2_000;
/// Per-line message cap, so a pathological line can't bloat a frame.
const MAX_MSG: usize = 8192;

/// Severities, coarsest → highest. Index = rank, used for the `levelMin` floor.
const LEVELS: [&str; 6] = ["debug", "info", "notice", "warning", "error", "critical"];

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

// ───────────────────────────── level helpers ──────────────────────────────
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

/// Coarse severity guess from a line's text, for sources without structured levels
/// (Docker, plain files, the macOS unified log). `None` when nothing stands out.
fn guess_level(msg: &str) -> Option<&'static str> {
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

fn truncate_msg(s: String) -> String {
    if s.len() <= MAX_MSG {
        return s;
    }
    let mut end = MAX_MSG;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    let mut t = s[..end].to_string();
    t.push('…');
    t
}

// ───────────────────────────── command helpers ────────────────────────────
/// Deadline for reading a source. None of these tools is naturally bounded — a
/// container holding several GB of logs, a journal that has never been vacuumed —
/// and their output only becomes visible once the process exits. Without a
/// deadline, one fat source leaves the panel spinning with nothing to show and no
/// reason given; with it, the query comes back as an error one can act on.
const READ_TIMEOUT: Duration = Duration::from_secs(45);
/// Same, for the inventory: detection has to feel immediate, and a wedged engine
/// daemon must cost a listing, not the whole panel.
const DETECT_TIMEOUT: Duration = Duration::from_secs(10);
/// How often the deadline is checked while the child runs.
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// Run a command under a deadline and hand back its `(stdout, stderr)`, killing it
/// if it overruns. `label` is what the error blames (`docker logs`, `journalctl`…).
///
/// Both streams come back because both can be log content: a container engine
/// forwards the container's stderr to ours, and dropping it would lose half of
/// what a service writes. On failure stderr is the diagnostic instead.
///
/// Each pipe is drained by its own thread rather than after the wait: a child
/// filling a pipe nobody reads blocks on it, and the deadline would then be
/// watching a process that can no longer make progress — the very hang this is
/// meant to break.
fn run_bounded<S: AsRef<std::ffi::OsStr>>(
    label: &str,
    program: &str,
    args: &[S],
    timeout: Duration,
) -> Result<(Vec<u8>, Vec<u8>)> {
    use std::io::Read;
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
    let drain = |pipe: &mut dyn Read| {
        let mut buf = Vec::new();
        let _ = pipe.read_to_end(&mut buf);
        buf
    };
    let out_reader = std::thread::spawn(move || drain(&mut out_pipe));
    let err_reader = std::thread::spawn(move || drain(&mut err_pipe));

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child
            .try_wait()
            .with_context(|| format!("attente de {label}"))?
        {
            Some(status) => break status,
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                bail!(
                    "{label} : abandon après {} s — source trop volumineuse, resserrez la fenêtre de temps ou le filtre",
                    timeout.as_secs()
                );
            }
            None => std::thread::sleep(POLL_INTERVAL),
        }
    };

    // Le processus est terminé : les tuyaux sont fermés, les lecteurs rendent
    // la main tout seuls.
    let stdout = out_reader.join().unwrap_or_default();
    let stderr = err_reader.join().unwrap_or_default();
    if !status.success() {
        bail!("{label}: {}", String::from_utf8_lossy(&stderr).trim());
    }
    Ok((stdout, stderr))
}

/// Run a command and return its stdout when it succeeds, else `None` (missing
/// binary, non-zero exit, or a daemon that didn't answer in time). Used for
/// best-effort detection.
fn run_capture(program: &str, args: &[&str]) -> Option<String> {
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

// ───────────────────────────── source detection ───────────────────────────
/// Container engines whose logs we can list and read. Both expose the same `ps`
/// and `logs` surface, so one reader serves them; the source id carries which one
/// (`docker:<id>` / `podman:<id>`) because a host can perfectly well run both.
const CONTAINER_RUNTIMES: [&str; 2] = ["docker", "podman"];

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
        for path in [
            "/var/log/syslog",
            "/var/log/messages",
            "/var/log/auth.log",
            "/var/log/kern.log",
        ] {
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

    // Conteneurs — quel que soit l'OS, pour chaque moteur qui répond. Un `ps` qui
    // échoue (binaire absent, démon arrêté, socket interdite à l'utilisateur du
    // service) ne donne simplement aucune source : l'interface le dit à sa façon.
    for bin in CONTAINER_RUNTIMES {
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
                label: parts[1].to_string(),
                detail: parts.get(2).map(|image| format!("{bin} · {image}")),
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

// ───────────────────────────────── querying ───────────────────────────────
/// Run one log query: read raw lines from the source, then apply the uniform
/// post-filter (text/regex, severity floor, time window) and tail to `limit`.
pub fn run_query(source_id: &str, filter: &LogFilter, limit: usize) -> Result<Vec<LogLine>> {
    let limit = limit.clamp(1, MAX_LIMIT);
    let searching =
        filter.search.as_deref().is_some_and(|s| !s.is_empty()) || filter.level_min.is_some();

    let container = source_id
        .split_once(':')
        .filter(|(bin, _)| CONTAINER_RUNTIMES.contains(bin));

    // Le plafond de balayage dépend de la source : une ligne de conteneur coûte
    // bien plus cher qu'une ligne de journal — c'est la sortie applicative brute,
    // jusqu'à `MAX_MSG` chacune, et le moteur la rend d'un bloc avant que quoi que
    // ce soit ne s'affiche. Chercher y remonte donc moins loin dans le passé, ce
    // qui est le prix d'une recherche qui revient.
    let max_raw = if container.is_some() {
        MAX_RAW_CONTAINER
    } else {
        MAX_RAW
    };
    let raw_cap = if searching { max_raw.max(limit) } else { limit };

    let raw = if source_id == "journald" {
        read_journald(filter, raw_cap)?
    } else if let Some((bin, id)) = container {
        read_container(bin, id, filter, raw_cap)?
    } else if let Some(path) = source_id.strip_prefix("file:") {
        read_file(path, raw_cap)?
    } else if source_id == "oslog" {
        read_oslog(raw_cap)?
    } else if let Some(channel) = source_id.strip_prefix("eventlog:") {
        read_eventlog(channel, raw_cap)?
    } else {
        bail!("source de logs inconnue : {source_id}");
    };

    post_filter(raw, filter, limit)
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

/// Apply the severity floor, time window and text/regex match uniformly, then tail
/// to `limit` (keep the newest matching lines).
fn post_filter(mut lines: Vec<LogLine>, filter: &LogFilter, limit: usize) -> Result<Vec<LogLine>> {
    let min_rank = filter.level_min.as_deref().map(level_rank);
    let since_ms = filter.since.map(|s| s * 1000);
    let until_ms = filter.until.map(|u| u * 1000);
    let matcher = build_matcher(filter)?;

    lines.retain(|l| {
        // Severity floor: a level is required and must meet the floor.
        if let Some(min) = min_rank {
            match l.level {
                Some(lv) if level_rank(lv) >= min => {}
                _ => return false,
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

    if lines.len() > limit {
        let start = lines.len() - limit;
        lines.drain(0..start);
    }
    Ok(lines)
}

// ───────────────────────────────── readers ────────────────────────────────
fn read_journald(filter: &LogFilter, raw_cap: usize) -> Result<Vec<LogLine>> {
    let mut args: Vec<String> = vec![
        "-o".into(),
        "json".into(),
        "--no-pager".into(),
        "-n".into(),
        raw_cap.to_string(),
    ];
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

    let (stdout, _) = run_bounded("journalctl", "journalctl", &args, READ_TIMEOUT)?;
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
fn jv_message(v: Option<&serde_json::Value>) -> String {
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
fn read_container(bin: &str, id: &str, filter: &LogFilter, raw_cap: usize) -> Result<Vec<LogLine>> {
    let mut args: Vec<String> = vec![
        "logs".into(),
        "--timestamps".into(),
        "--tail".into(),
        raw_cap.to_string(),
    ];
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
    let (stdout, stderr) = run_bounded(&format!("{bin} logs"), bin, &args, READ_TIMEOUT)?;
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

fn read_file(path: &str, raw_cap: usize) -> Result<Vec<LogLine>> {
    use std::collections::VecDeque;
    use std::io::BufRead;

    let file = std::fs::File::open(path).with_context(|| format!("ouverture de {path}"))?;
    let reader = std::io::BufReader::new(file);
    // Ring buffer of the last `raw_cap` lines, so a multi-GB file stays bounded.
    let mut ring: VecDeque<String> = VecDeque::with_capacity(raw_cap.min(4096));
    for line in reader.lines() {
        let line = line.unwrap_or_default();
        if ring.len() >= raw_cap {
            ring.pop_front();
        }
        ring.push_back(line);
    }
    Ok(ring
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

fn read_oslog(raw_cap: usize) -> Result<Vec<LogLine>> {
    // `log show` is time-based, not line-bounded; default to the last hour and cap
    // the lines afterwards (precise time windows are applied in post_filter only
    // when the source carries timestamps — best-effort on macOS).
    let (stdout, _) = run_bounded(
        "log show",
        "log",
        &["show", "--style", "syslog", "--no-pager", "--last", "1h"],
        READ_TIMEOUT,
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
        let start = lines.len() - raw_cap;
        lines.drain(0..start);
    }
    Ok(lines)
}

fn read_eventlog(channel: &str, raw_cap: usize) -> Result<Vec<LogLine>> {
    let max = raw_cap.min(MAX_RAW);
    let script = format!(
        "Get-WinEvent -LogName '{}' -MaxEvents {} -ErrorAction Stop | \
         Select-Object @{{n='ts';e={{[int64]($_.TimeCreated.ToUniversalTime() - (Get-Date '1970-01-01')).TotalMilliseconds}}}}, \
         @{{n='level';e={{$_.LevelDisplayName}}}}, @{{n='msg';e={{$_.Message}}}} | ConvertTo-Json -Compress",
        channel.replace('\'', "''"),
        max
    );
    let (stdout, _) = run_bounded(
        "Get-WinEvent",
        "powershell",
        &["-NoProfile", "-NonInteractive", "-Command", &script],
        READ_TIMEOUT,
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

// ───────────────────────────── timestamp parsing ──────────────────────────
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

// ───────────────────────────────── tasks ──────────────────────────────────
/// Enumerate sources off the runtime and stream the result.
pub async fn detect_task(tx: Sender<LogEvent>) {
    let sources = tokio::task::spawn_blocking(detect_sources)
        .await
        .unwrap_or_default();
    let _ = tx.send(LogEvent::Sources(sources)).await;
}

/// Run a query off the runtime and stream the result in bounded chunks (the last
/// carrying `done`). On failure, one terminal chunk carries the error.
pub async fn run_query_task(
    query_id: String,
    source_id: String,
    filter: LogFilter,
    limit: usize,
    tx: Sender<LogEvent>,
) {
    const CHUNK: usize = 500;
    let res = tokio::task::spawn_blocking(move || run_query(&source_id, &filter, limit)).await;
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
    let total = lines.len();
    let mut sent = 0;
    for chunk in lines.chunks(CHUNK) {
        sent += chunk.len();
        let _ = tx
            .send(LogEvent::Lines {
                query_id: query_id.clone(),
                lines: chunk.to_vec(),
                done: sent >= total,
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
            error: Some(error),
        })
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let out = post_filter(lines.clone(), &filter, 100).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].message, "boom failure");

        let filter = LogFilter {
            search: Some("HELLO".into()),
            ..Default::default()
        };
        let out = post_filter(lines, &filter, 100).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].message, "hello world");
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
