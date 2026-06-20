//! Cross-cycle metric collection via `sysinfo`, plus logged-in user count and a
//! few best-effort host signals (load, uptime, temperature, connections).

use std::time::{SystemTime, UNIX_EPOCH};

use sysinfo::{Components, Disks, Networks, ProcessesToUpdate, System};

use crate::protocol::MetricSnapshot;

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

    pub fn collect(&mut self) -> MetricSnapshot {
        self.sys.refresh_cpu_all();
        self.sys.refresh_memory();
        self.sys.refresh_processes(ProcessesToUpdate::All, true);
        self.networks.refresh();
        self.components.refresh();

        let cpu_percent = ((self.sys.global_cpu_usage() as f64) * 10.0).round() / 10.0;
        let cpu_percent = cpu_percent.clamp(0.0, 100.0);

        let mem_used = self.sys.used_memory();
        let mem_total = self.sys.total_memory().max(1);

        let (disk_used, disk_total) = read_disk();
        let (net_rx, net_tx) = read_network(&self.networks);

        let load_avg_1 = {
            let avg = System::load_average().one;
            if avg.is_finite() && avg >= 0.0 {
                Some((avg * 100.0).round() / 100.0)
            } else {
                None
            }
        };

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
            process_count: Some(self.sys.processes().len() as u32),
            active_connections: active_connections(),
        }
    }
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Aggregate used/total bytes across all mounted disks.
fn read_disk() -> (u64, u64) {
    let disks = Disks::new_with_refreshed_list();
    let mut total = 0u64;
    let mut used = 0u64;
    for disk in disks.iter() {
        let d_total = disk.total_space();
        total += d_total;
        used += d_total.saturating_sub(disk.available_space());
    }
    (used, total)
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
