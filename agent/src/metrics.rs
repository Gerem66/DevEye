//! Cross-cycle metric collection via `sysinfo`, plus logged-in user count.

use std::time::{SystemTime, UNIX_EPOCH};

use sysinfo::{Disks, Networks, System};

use crate::protocol::MetricSnapshot;

/// Holds `sysinfo` state between cycles so CPU/network deltas are meaningful.
pub struct Collector {
    sys: System,
    networks: Networks,
}

impl Collector {
    pub fn new() -> Self {
        let mut sys = System::new();
        sys.refresh_cpu_all();
        sys.refresh_memory();
        let networks = Networks::new_with_refreshed_list();
        Self { sys, networks }
    }

    pub fn collect(&mut self) -> MetricSnapshot {
        self.sys.refresh_cpu_all();
        self.sys.refresh_memory();
        self.networks.refresh();

        let cpu_percent = ((self.sys.global_cpu_usage() as f64) * 10.0).round() / 10.0;
        let cpu_percent = cpu_percent.clamp(0.0, 100.0);

        let mem_used = self.sys.used_memory();
        let mem_total = self.sys.total_memory().max(1);

        let (disk_used, disk_total) = read_disk();
        let (net_rx, net_tx) = read_network(&self.networks);

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
