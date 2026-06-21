//! Cross-cycle metric collection via `sysinfo`, plus logged-in user count and a
//! few best-effort host signals (load, uptime, temperature, connections).

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use sysinfo::{Components, Disks, Networks, ProcessesToUpdate, System};

use crate::protocol::{MetricSnapshot, ReportDisk};

/// Holds `sysinfo` state between cycles so CPU/network deltas are meaningful.
pub struct Collector {
    sys: System,
    networks: Networks,
    components: Components,
}

impl Collector {
    pub fn new() -> Self {
        let mut sys = System::new();
        sys.refresh_cpu_all();
        sys.refresh_memory();
        let networks = Networks::new_with_refreshed_list();
        let components = Components::new_with_refreshed_list();
        Self {
            sys,
            networks,
            components,
        }
    }

    /// Light metric sample for the graphs (every ~10 s). In-process reads plus a
    /// few cheap single-shot subprocess probes; **no full process scan**, so
    /// `process_count` and disk I/O are left `None` (filled by `collect_full`).
    pub fn collect_fine(&mut self) -> MetricSnapshot {
        self.sys.refresh_cpu_all();
        self.sys.refresh_memory();
        self.networks.refresh();
        self.components.refresh();

        let cpu_percent = ((self.sys.global_cpu_usage() as f64) * 10.0).round() / 10.0;
        let cpu_percent = cpu_percent.clamp(0.0, 100.0);

        let mem_used = self.sys.used_memory();
        let mem_total = self.sys.total_memory().max(1);

        let disks = read_disks();
        let disk_used: u64 = disks.iter().map(|d| d.used_bytes).sum();
        let disk_total: u64 = disks.iter().map(|d| d.total_bytes).sum();
        let (net_rx, net_tx) = read_network(&self.networks);

        let load_avg_1 = {
            let avg = System::load_average().one;
            if avg.is_finite() && avg >= 0.0 {
                Some((avg * 100.0).round() / 100.0)
            } else {
                None
            }
        };
        let battery = read_battery();

        MetricSnapshot {
            timestamp: now_millis(),
            cpu_percent,
            mem_used_bytes: mem_used,
            mem_total_bytes: mem_total,
            disk_used_bytes: disk_used,
            disk_total_bytes: disk_total.max(1),
            net_rx_bytes: net_rx,
            net_tx_bytes: net_tx,
            users_count: logged_in_users(),
            load_avg_1,
            cpu_temp_c: read_cpu_temp(&self.components),
            uptime_seconds: Some(System::uptime()),
            process_count: None,
            active_connections: active_connections(),
            gpu_percent: read_gpu_percent(),
            disk_read_bytes: None,
            disk_write_bytes: None,
            battery_percent: battery.0,
            battery_charging: battery.1,
        }
    }

    /// Heavy snapshot sample (every ~5 min): `collect_fine` plus the full process
    /// scan, which yields the process count and aggregate disk I/O. The process
    /// list itself is collected separately (see `report::collect_processes`).
    pub fn collect_full(&mut self) -> MetricSnapshot {
        let mut snap = self.collect_fine();
        self.sys.refresh_processes(ProcessesToUpdate::All, true);
        snap.process_count = Some(self.sys.processes().len() as u32);
        let (read, write) = read_disk_io(&self.sys);
        snap.disk_read_bytes = read;
        snap.disk_write_bytes = write;
        snap
    }
}

/// Aggregate cumulative disk bytes read/written across all processes. Best-effort
/// (works on Linux; may report 0 on macOS) — 0 is reported as `None` so the UI
/// hides the graph rather than drawing a flat line.
fn read_disk_io(sys: &System) -> (Option<u64>, Option<u64>) {
    let mut read = 0u64;
    let mut write = 0u64;
    for proc in sys.processes().values() {
        let usage = proc.disk_usage();
        read = read.saturating_add(usage.total_read_bytes);
        write = write.saturating_add(usage.total_written_bytes);
    }
    let r = if read == 0 { None } else { Some(read) };
    let w = if write == 0 { None } else { Some(write) };
    (r, w)
}

/// Best-effort GPU utilization (%). macOS reads the IOAccelerator performance
/// stats (no privileges needed); Linux tries `nvidia-smi`. `None` otherwise.
fn read_gpu_percent() -> Option<f64> {
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("ioreg")
            .args(["-r", "-d", "1", "-c", "IOAccelerator"])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&out.stdout);
        // Look for: "Device Utilization %"=<n>
        let idx = text.find("Device Utilization %")?;
        let rest = &text[idx..];
        let eq = rest.find('=')?;
        let num: String = rest[eq + 1..]
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        let v: f64 = num.parse().ok()?;
        Some(v.clamp(0.0, 100.0))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let out = std::process::Command::new("nvidia-smi")
            .args([
                "--query-gpu=utilization.gpu",
                "--format=csv,noheader,nounits",
            ])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let first = text.lines().next()?.trim();
        let v: f64 = first.parse().ok()?;
        Some(v.clamp(0.0, 100.0))
    }
}

/// Battery charge (%) and whether it's charging / on AC. `(None, None)` on
/// machines without a battery (desktops). Best-effort.
fn read_battery() -> (Option<f64>, Option<bool>) {
    #[cfg(target_os = "macos")]
    {
        // `pmset -g batt` → "... 87%; discharging; ..." / "Now drawing from 'AC Power'".
        let out = match std::process::Command::new("pmset")
            .args(["-g", "batt"])
            .output()
        {
            Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
            _ => return (None, None),
        };
        if !out.contains('%') {
            return (None, None); // no battery line
        }
        let percent = out
            .split('%')
            .next()
            .and_then(|head| {
                head.rsplit(|c: char| !c.is_ascii_digit())
                    .find(|s| !s.is_empty())
            })
            .and_then(|s| s.parse::<f64>().ok())
            .map(|v| v.clamp(0.0, 100.0));
        let lower = out.to_lowercase();
        let charging = if lower.contains("discharging") {
            Some(false)
        } else if lower.contains("ac power")
            || lower.contains("charging")
            || lower.contains("charged")
        {
            Some(true)
        } else {
            None
        };
        (percent, charging)
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Linux: read the first /sys/class/power_supply/BAT* entry.
        let base = std::path::Path::new("/sys/class/power_supply");
        let entries = match std::fs::read_dir(base) {
            Ok(e) => e,
            Err(_) => return (None, None),
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            if !name.to_string_lossy().starts_with("BAT") {
                continue;
            }
            let dir = entry.path();
            let percent = std::fs::read_to_string(dir.join("capacity"))
                .ok()
                .and_then(|s| s.trim().parse::<f64>().ok())
                .map(|v| v.clamp(0.0, 100.0));
            let charging = std::fs::read_to_string(dir.join("status")).ok().map(|s| {
                let st = s.trim().to_lowercase();
                st == "charging" || st == "full"
            });
            return (percent, charging);
        }
        (None, None)
    }
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Distinct mounted disks with used/total bytes.
///
/// APFS (and LVM/btrfs subvolumes) expose several volumes that share one
/// container and therefore report identical total **and** available space, which
/// would double-count when summed. We dedupe by `(total, available)` so each
/// physical container appears once, and keep the most representative mount point
/// (`/` first, then the shortest path). Pseudo filesystems are skipped.
pub fn read_disks() -> Vec<ReportDisk> {
    let disks = Disks::new_with_refreshed_list();
    let mut seen: HashMap<(u64, u64), ReportDisk> = HashMap::new();
    for disk in disks.iter() {
        let total = disk.total_space();
        if total == 0 {
            continue;
        }
        let fs = disk.file_system().to_string_lossy().to_lowercase();
        if matches!(
            fs.as_str(),
            "tmpfs" | "devtmpfs" | "overlay" | "squashfs" | "proc" | "sysfs" | "devfs"
        ) {
            continue;
        }
        let available = disk.available_space();
        let mount = disk.mount_point().to_string_lossy().to_string();
        let entry = ReportDisk {
            mount: mount.clone(),
            used_bytes: total.saturating_sub(available),
            total_bytes: total,
        };
        seen.entry((total, available))
            .and_modify(|e| {
                if better_mount(&mount, &e.mount) {
                    e.mount = mount.clone();
                }
            })
            .or_insert(entry);
    }
    let mut out: Vec<ReportDisk> = seen.into_values().collect();
    out.sort_by_key(|d| std::cmp::Reverse(d.total_bytes));
    out
}

/// Prefer `/`, then the shortest mount path, as the label for a deduped disk.
fn better_mount(candidate: &str, current: &str) -> bool {
    if candidate == "/" {
        return true;
    }
    if current == "/" {
        return false;
    }
    candidate.len() < current.len()
}

/// Aggregate received/transmitted bytes across all interfaces.
fn read_network(networks: &Networks) -> (u64, u64) {
    let mut rx = 0u64;
    let mut tx = 0u64;
    for (_name, data) in networks.iter() {
        rx += data.total_received();
        tx += data.total_transmitted();
    }
    (rx, tx)
}

/// Highest readable component temperature in °C. Returns `None` when no sensor
/// is exposed — notably on Apple Silicon, where SMC access is privileged.
fn read_cpu_temp(components: &Components) -> Option<f64> {
    let mut max: Option<f64> = None;
    for comp in components.iter() {
        let t = comp.temperature() as f64;
        if t.is_finite() && t > 0.0 {
            max = Some(max.map_or(t, |m| m.max(t)));
        }
    }
    max.map(|t| (t * 10.0).round() / 10.0)
}

/// Count distinct logged-in OS users via `who`. Returns 0 if unavailable.
fn logged_in_users() -> u32 {
    use std::collections::HashSet;
    let output = match std::process::Command::new("who").output() {
        Ok(o) if o.status.success() => o.stdout,
        _ => return 0,
    };
    let text = String::from_utf8_lossy(&output);
    let users: HashSet<&str> = text
        .lines()
        .filter_map(|line| line.split_whitespace().next())
        .collect();
    users.len() as u32
}

/// Count established TCP connections, best-effort via `ss` (Linux) or `netstat`
/// (macOS). Returns `None` when neither tool is usable.
fn active_connections() -> Option<u32> {
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("netstat")
            .args(["-an", "-p", "tcp"])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let n = text.lines().filter(|l| l.contains("ESTABLISHED")).count();
        Some(n as u32)
    }
    #[cfg(not(target_os = "macos"))]
    {
        if let Ok(out) = std::process::Command::new("ss")
            .args(["-tn", "state", "established"])
            .output()
        {
            if out.status.success() {
                let text = String::from_utf8_lossy(&out.stdout);
                // First line is the header.
                let n = text
                    .lines()
                    .skip(1)
                    .filter(|l| !l.trim().is_empty())
                    .count();
                return Some(n as u32);
            }
        }
        None
    }
}
