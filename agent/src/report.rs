//! Latest-known health/security report + process collection.
//!
//! The report carries slow-moving signals (OS info, security posture); processes
//! are collected here too (`top_processes`) but historised separately. Every
//! security probe shells out to an OS tool and is best-effort: a `None` result
//! simply means "unknown" in the UI.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use sysinfo::System;

use crate::protocol::{DeviceReport, OsInfo, ProcessInfo, Security};

/// OS + security posture (latest known). Processes are collected separately
/// (see `top_processes`) so they can be historised.
pub fn collect() -> DeviceReport {
    DeviceReport {
        collected_at: now_millis(),
        os: os_info(),
        security: security(),
        disks: crate::metrics::read_disks(),
    }
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn os_info() -> OsInfo {
    OsInfo {
        name: System::name().unwrap_or_else(|| "unknown".to_string()),
        version: System::os_version().unwrap_or_default(),
        arch: std::env::consts::ARCH.to_string(),
        cores: std::thread::available_parallelism()
            .map(|n| n.get() as u32)
            .unwrap_or(0),
    }
}

/// Hard caps to keep payloads/storage bounded.
const ALL_PROCESS_LIMIT: usize = 2000;
const TOP_PROCESS_LIMIT: usize = 20;

/// Collect processes per the capture mode, **aggregated by program name**:
/// - `off`  → empty (no sample sent);
/// - `top`  → the 20 heaviest programs, scored on **CPU% + memory%**;
/// - `all`  → every program (capped at `ALL_PROCESS_LIMIT`).
///
/// We aggregate same-named processes (summing CPU% and memory) because modern
/// apps are multi-process — e.g. a browser splits work across many helper
/// processes, so a single PID looks idle while the app is busy. Grouping by name
/// gives the realistic "this app is using X%".
///
/// We shell out to `ps` rather than use `sysinfo`: its per-process CPU reads 0 on
/// macOS (a known limitation), whereas `ps` reports a real value on both
/// platforms. `%cpu` is the kernel's recent (decaying-average) utilisation and
/// can exceed 100% across cores; `%mem` is RSS as a fraction of physical memory.
pub fn collect_processes(capture: &str) -> Vec<ProcessInfo> {
    if capture == "off" {
        return Vec::new();
    }

    // macOS uses `ucomm` (short accounting name); Linux uses `comm`.
    #[cfg(target_os = "macos")]
    let args: [&str; 2] = ["-Ao", "pcpu=,pmem=,rss=,ucomm="];
    #[cfg(not(target_os = "macos"))]
    let args: [&str; 2] = ["-eo", "pcpu=,pmem=,rss=,comm="];

    let out = match run("ps", &args) {
        Some(o) => o,
        None => return Vec::new(),
    };

    // Aggregate by name: (summed cpu%, summed mem%, summed rss bytes).
    let mut agg: HashMap<String, (f64, f64, u64)> = HashMap::new();
    for line in out.lines() {
        if let Some((name, cpu, mem_pct, rss)) = parse_ps_line(line) {
            let e = agg.entry(name).or_insert((0.0, 0.0, 0));
            e.0 += cpu;
            e.1 += mem_pct;
            e.2 = e.2.saturating_add(rss);
        }
    }

    // Score on cpu% + mem% (the two signals `ps` exposes everywhere).
    let mut scored: Vec<(f64, ProcessInfo)> = agg
        .into_iter()
        .map(|(name, (cpu, mem_pct, rss))| {
            (
                cpu + mem_pct,
                ProcessInfo {
                    name,
                    cpu_percent: (cpu * 10.0).round() / 10.0,
                    mem_bytes: rss,
                },
            )
        })
        .collect();

    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(Ordering::Equal));
    scored.truncate(if capture == "top" {
        TOP_PROCESS_LIMIT
    } else {
        ALL_PROCESS_LIMIT
    });
    scored.into_iter().map(|(_, p)| p).collect()
}

/// Parse a `ps` line `<%cpu> <%mem> <rss_kb> <command…>` into
/// `(name, cpu%, mem%, rss_bytes)`.
fn parse_ps_line(line: &str) -> Option<(String, f64, f64, u64)> {
    let mut parts = line.split_whitespace();
    let cpu: f64 = parts.next()?.parse().ok()?;
    let mem_pct: f64 = parts.next()?.parse().ok()?;
    let rss_kb: u64 = parts.next()?.parse().ok()?;
    let name = parts.collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        return None;
    }
    Some((name, cpu, mem_pct, rss_kb * 1024))
}

fn security() -> Security {
    Security {
        firewall: firewall_enabled(),
        disk_encryption: disk_encrypted(),
        sip: sip_enabled(),
        pending_updates: pending_updates(),
    }
}

/// Run a command and return its stdout as a lossy string on success.
fn run(cmd: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(cmd).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

// ── macOS collectors ────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn firewall_enabled() -> Option<bool> {
    let out = run(
        "/usr/libexec/ApplicationFirewall/socketfilterfw",
        &["--getglobalstate"],
    )?;
    // "Firewall is enabled. (State = 1)" / "... disabled. (State = 0)"
    let lower = out.to_lowercase();
    if lower.contains("enabled") {
        Some(true)
    } else if lower.contains("disabled") {
        Some(false)
    } else {
        None
    }
}

#[cfg(target_os = "macos")]
fn disk_encrypted() -> Option<bool> {
    let out = run("fdesetup", &["status"])?;
    let lower = out.to_lowercase();
    if lower.contains("filevault is on") {
        Some(true)
    } else if lower.contains("filevault is off") {
        Some(false)
    } else {
        None
    }
}

#[cfg(target_os = "macos")]
fn sip_enabled() -> Option<bool> {
    let out = run("csrutil", &["status"])?;
    let lower = out.to_lowercase();
    if lower.contains("enabled") {
        Some(true)
    } else if lower.contains("disabled") {
        Some(false)
    } else {
        None
    }
}

#[cfg(target_os = "macos")]
fn pending_updates() -> Option<u32> {
    // `softwareupdate -l` can take tens of seconds; skipped on macOS by design.
    None
}

// ── Linux collectors ────────────────────────────────────────────────────────

#[cfg(not(target_os = "macos"))]
fn firewall_enabled() -> Option<bool> {
    if let Some(out) = run("ufw", &["status"]) {
        let lower = out.to_lowercase();
        if lower.contains("status: active") {
            return Some(true);
        }
        if lower.contains("status: inactive") {
            return Some(false);
        }
    }
    if let Some(out) = run("firewall-cmd", &["--state"]) {
        return Some(out.trim() == "running");
    }
    None
}

#[cfg(not(target_os = "macos"))]
fn disk_encrypted() -> Option<bool> {
    // Any LUKS-typed block device counts as encrypted storage.
    let out = run("lsblk", &["-o", "TYPE,FSTYPE", "-n"])?;
    let encrypted = out
        .lines()
        .any(|l| l.contains("crypt") || l.contains("LUKS") || l.contains("crypto_LUKS"));
    Some(encrypted)
}

#[cfg(not(target_os = "macos"))]
fn sip_enabled() -> Option<bool> {
    None
}

#[cfg(not(target_os = "macos"))]
fn pending_updates() -> Option<u32> {
    // Debian/Ubuntu: simulate an upgrade and count "Inst" lines.
    if let Some(out) = run("apt-get", &["-s", "upgrade"]) {
        let n = out.lines().filter(|l| l.starts_with("Inst ")).count();
        return Some(n as u32);
    }
    // Fedora/RHEL: dnf exits non-zero when updates exist, so use a checked call.
    if let Ok(o) = Command::new("dnf").args(["-q", "check-update"]).output() {
        let text = String::from_utf8_lossy(&o.stdout);
        let n = text.lines().filter(|l| !l.trim().is_empty()).count();
        return Some(n as u32);
    }
    None
}
