//! Latest-known health/security report collection.
//!
//! Unlike the per-cycle metric snapshot, the report carries slow-moving and
//! heavier signals (OS info, security posture, top processes). It is sent on
//! connect and then periodically. Every security probe shells out to an OS tool
//! and is best-effort: a `None` result simply means "unknown" in the UI.

use std::cmp::Ordering;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use sysinfo::System;

use crate::protocol::{DeviceReport, OsInfo, ProcessInfo, Security};

pub fn collect() -> DeviceReport {
    DeviceReport {
        collected_at: now_millis(),
        os: os_info(),
        security: security(),
        top_processes: top_processes(5),
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
    }
}

/// The N heaviest processes by CPU.
///
/// We shell out to `ps` rather than use `sysinfo` here: its per-process CPU
/// reads 0 on macOS (a known limitation), whereas `ps` reports a real value on
/// both platforms. `%cpu` is the kernel's decaying-average utilisation.
fn top_processes(n: usize) -> Vec<ProcessInfo> {
    // macOS uses `ucomm` (short accounting name); Linux uses `comm`.
    #[cfg(target_os = "macos")]
    let args: [&str; 2] = ["-Ao", "pcpu=,rss=,ucomm="];
    #[cfg(not(target_os = "macos"))]
    let args: [&str; 2] = ["-eo", "pcpu=,rss=,comm="];

    let out = match run("ps", &args) {
        Some(o) => o,
        None => return Vec::new(),
    };

    let mut procs: Vec<ProcessInfo> = out.lines().filter_map(parse_ps_line).collect();
    procs.sort_by(|a, b| b.cpu_percent.partial_cmp(&a.cpu_percent).unwrap_or(Ordering::Equal));
    procs.truncate(n);
    procs
}

/// Parse a `ps` line: `<%cpu> <rss_kb> <command…>`.
fn parse_ps_line(line: &str) -> Option<ProcessInfo> {
    let mut parts = line.split_whitespace();
    let cpu: f64 = parts.next()?.parse().ok()?;
    let rss_kb: u64 = parts.next()?.parse().ok()?;
    let name = parts.collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        return None;
    }
    Some(ProcessInfo {
        name,
        cpu_percent: (cpu * 10.0).round() / 10.0,
        mem_bytes: rss_kb * 1024,
    })
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
