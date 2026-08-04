//! Cross-cycle metric collection via `sysinfo`, plus logged-in user count and a
//! few best-effort host signals (load, uptime, temperature, GPU, battery).
//!
//! One [`Collector::collect`] call produces one *instant*: the graph signals and
//! the process list together, under a single timestamp. Holding `sysinfo` state
//! across calls is what makes CPU and network deltas meaningful.

use std::collections::HashMap;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use sysinfo::{Components, Disks, Networks, System};

use crate::protocol::{MetricSnapshot, ReportDisk};
use crate::report;
use crate::sockets::SocketMap;

/// Slow-moving signals (disk capacity, battery, logged-in users) refreshed at
/// most every [`SLOW_TTL`]. They barely change between 10-s metric ticks yet are
/// comparatively expensive to read — a full mount scan plus `pmset`/`who`
/// subprocess spawns — so sampling them every cycle wasted CPU and wakeups on the
/// monitored device (and, on laptops, battery). Cached here and reused in between.
#[derive(Clone, Copy)]
struct SlowSignals {
    disk_used: u64,
    disk_total: u64,
    users: u32,
    battery: (Option<f64>, Option<bool>),
}

const SLOW_TTL: Duration = Duration::from_secs(60);

/// Holds `sysinfo` state between cycles so CPU/network deltas are meaningful.
pub struct Collector {
    sys: System,
    networks: Networks,
    components: Components,
    /// Cached slow signals and when they were last collected (see [`SlowSignals`]).
    slow: Option<(SlowSignals, Instant)>,
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
            slow: None,
        }
    }

    /// Disk/battery/user signals, recomputed only when the cache is empty or
    /// older than [`SLOW_TTL`]; otherwise the last values are reused. Returns an
    /// owned copy so the `&mut self` borrow is released before the caller reads
    /// the (immutably borrowed) `sysinfo` state.
    fn slow_signals(&mut self) -> SlowSignals {
        if let Some((s, at)) = self.slow {
            if at.elapsed() < SLOW_TTL {
                return s;
            }
        }
        let disks = read_disks();
        let s = SlowSignals {
            disk_used: disks.iter().map(|d| d.used_bytes).sum(),
            disk_total: disks.iter().map(|d| d.total_bytes).sum::<u64>().max(1),
            users: logged_in_users(),
            battery: read_battery(),
        };
        self.slow = Some((s, Instant::now()));
        s
    }

    /// Collect one **instant**: every graph signal plus the process list that
    /// explains it, under a single timestamp.
    ///
    /// There is deliberately no light/heavy split any more. The socket probe and
    /// the process scan feed each other (per-process connections come from the
    /// sockets; the socket owners' names come from the scan) and between them
    /// they also yield `process_count`, aggregate disk I/O and the established
    /// connection count — figures that used to cost a *second* full process
    /// enumeration. The result measured cheaper than the old heavy cycle.
    ///
    /// The socket map is supplied by the caller (which probes it off the async
    /// runtime) and handed back, so the periodic report can reuse it instead of
    /// re-enumerating every socket.
    pub fn collect(
        &mut self,
        capture: &str,
        mut sockets: SocketMap,
    ) -> (MetricSnapshot, SocketMap) {
        self.sys.refresh_cpu_all();
        self.sys.refresh_memory();
        self.networks.refresh();
        self.components.refresh();

        let scan = report::collect_processes(capture, &sockets, &mut self.sys);
        sockets.resolve_names(&scan.pid_names);

        // Disk/battery/user signals: cached for SLOW_TTL (cheap on most ticks).
        let slow = self.slow_signals();

        let cpu_percent = ((self.sys.global_cpu_usage() as f64) * 10.0).round() / 10.0;
        let cpu_percent = cpu_percent.clamp(0.0, 100.0);

        let mem_used = self.sys.used_memory();
        let mem_total = self.sys.total_memory().max(1);

        let (net_rx, net_tx) = read_network(&self.networks);

        let load_avg_1 = {
            let avg = System::load_average().one;
            if avg.is_finite() && avg >= 0.0 {
                Some((avg * 100.0).round() / 100.0)
            } else {
                None
            }
        };

        let snapshot = MetricSnapshot {
            timestamp: now_millis(),
            cpu_percent,
            mem_used_bytes: mem_used,
            mem_total_bytes: mem_total,
            disk_used_bytes: slow.disk_used,
            disk_total_bytes: slow.disk_total,
            net_rx_bytes: net_rx,
            net_tx_bytes: net_tx,
            users_count: slow.users,
            load_avg_1,
            cpu_temp_c: read_cpu_temp(&self.components),
            uptime_seconds: Some(System::uptime()),
            process_count: scan.totals.count,
            active_connections: sockets.established_count,
            gpu_percent: read_gpu_percent(),
            disk_read_bytes: scan.totals.disk_read,
            disk_write_bytes: scan.totals.disk_write,
            battery_percent: slow.battery.0,
            battery_charging: slow.battery.1,
            processes: (capture != "off").then_some(scan.processes),
            process_kind: match capture {
                "top" => Some("top"),
                "all" => Some("all"),
                _ => None,
            },
        };
        (snapshot, sockets)
    }
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
    for data in networks.values() {
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

/// Count distinct logged-in OS users: `who` on Unix, `query user` on Windows.
/// Returns 0 if the tool is unavailable.
fn logged_in_users() -> u32 {
    use std::collections::HashSet;
    #[cfg(target_os = "windows")]
    {
        // `query user` lists interactive sessions; the first column is the user
        // (prefixed with `>` for the current one). The first line is the header.
        let output = match std::process::Command::new("query").args(["user"]).output() {
            Ok(o) if o.status.success() => o.stdout,
            _ => return 0,
        };
        let text = String::from_utf8_lossy(&output);
        let users: HashSet<String> = text
            .lines()
            .skip(1)
            .filter_map(|line| line.split_whitespace().next())
            .map(|u| u.trim_start_matches('>').to_lowercase())
            .filter(|u| !u.is_empty())
            .collect();
        users.len() as u32
    }
    #[cfg(not(target_os = "windows"))]
    {
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
}
