//! Latest-known health/security report + the per-tick process scan.
//!
//! The report carries slow-moving signals (OS info, security posture, hardware);
//! its socket picture is handed in by the caller, since [`crate::sockets`] probes
//! it once per collection tick anyway. Processes are scanned here too and travel
//! with the metric snapshot, under its timestamp.
//!
//! Every OS probe here is best-effort: a `None` result simply means "unknown" in
//! the UI — never a fabricated zero.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use sysinfo::{Networks, System};

use crate::protocol::{
    AgentInfo, CpuInfo, DeviceHardware, DeviceReport, NetInterface, OpenPort, OsInfo, ProcessInfo,
    Security, TcpConnection,
};
use crate::sockets::{ProcSockets, SocketMap};

/// OS + security posture (latest known), plus the socket picture.
///
/// The ports and connections are handed in by the caller, taken from the very
/// same `SocketMap` the collection tick already produced — so a report costs no
/// extra socket enumeration. On macOS the caller supplies a `deep` map (owners
/// resolved via `lsof`), affordable at the report's hourly cadence.
pub fn collect(open_ports: Vec<OpenPort>, connections: Vec<TcpConnection>) -> DeviceReport {
    DeviceReport {
        collected_at: now_millis(),
        os: os_info(),
        security: security(),
        disks: crate::metrics::read_disks(),
        agent: agent_info(),
        open_ports,
        connections,
        hardware: hardware(),
    }
}

/// Static hardware inventory: CPU identity, total RAM, GPU model(s), network
/// interfaces and a best-effort bluetooth descriptor. All slow-moving, so it's
/// gathered once per report cycle alongside the security posture.
fn hardware() -> DeviceHardware {
    let mut sys = System::new();
    sys.refresh_cpu_all();
    sys.refresh_memory();

    let cpus = sys.cpus();
    let first = cpus.first();
    let model = first
        .map(|c| c.brand().trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Inconnu".to_string());
    let vendor = first
        .map(|c| c.vendor_id().trim().to_string())
        .filter(|s| !s.is_empty());
    let frequency_mhz = first.map(|c| c.frequency()).filter(|&f| f > 0);

    let cpu = CpuInfo {
        model,
        vendor,
        physical_cores: sys.physical_core_count().map(|n| n as u32),
        logical_cores: cpus.len() as u32,
        frequency_mhz,
    };

    DeviceHardware {
        cpu,
        memory_total_bytes: sys.total_memory(),
        gpus: read_gpus(),
        network: read_network_interfaces(),
        bluetooth: read_bluetooth(),
    }
}

/// Network interfaces with their MAC and an inferred class. On macOS the class is
/// resolved from `networksetup -listallhardwareports` (reliable: `en0` may be
/// Wi-Fi or Ethernet); elsewhere it's inferred from the interface name.
/// Hard cap on reported network interfaces (mirrors the ports/connections caps): a
/// container host can expose dozens of virtual `veth*`/`br-*` devices, and an
/// over-long list would be rejected wholesale by the report schema's `.max(64)`.
const NET_INTERFACES_LIMIT: usize = 64;

/// Sort key so truncation drops noise (container veths, loopback) before real NICs.
fn iface_rank(kind: &str) -> u8 {
    match kind {
        "ethernet" => 0,
        "wifi" => 1,
        "bluetooth" => 2,
        "other" => 3,
        "virtual" => 4,
        "loopback" => 5,
        _ => 6,
    }
}

fn read_network_interfaces() -> Vec<NetInterface> {
    #[cfg(target_os = "macos")]
    let ports = macos_hardware_ports();

    let networks = Networks::new_with_refreshed_list();
    let mut out: Vec<NetInterface> = networks
        .iter()
        .map(|(name, data)| {
            #[cfg(target_os = "macos")]
            let kind = ports
                .get(name.as_str())
                .copied()
                .unwrap_or_else(|| classify_iface(name));
            #[cfg(not(target_os = "macos"))]
            let kind = classify_iface(name);

            let mac = data.mac_address();
            NetInterface {
                name: name.clone(),
                kind,
                mac: if mac.is_unspecified() {
                    None
                } else {
                    Some(mac.to_string())
                },
                // Lets the ports view attribute a bind address to its interface.
                addresses: data
                    .ip_networks()
                    .iter()
                    .map(|n| n.addr.to_string())
                    .collect(),
            }
        })
        .collect();
    // Meaningful interfaces first (physical before virtual/loopback) then
    // alphabetical, and cap the count so a container host's many veths can't push
    // the list past the report schema's limit and get the whole report rejected.
    out.sort_by(|a, b| {
        iface_rank(a.kind)
            .cmp(&iface_rank(b.kind))
            .then_with(|| a.name.cmp(&b.name))
    });
    out.truncate(NET_INTERFACES_LIMIT);
    out
}

/// Best-effort interface classification from its name. Linux uses predictable
/// names (`wl*` Wi-Fi, `en*`/`eth*` Ethernet); Windows exposes friendly names
/// ("Wi-Fi", "Ethernet", "Bluetooth") matched by the `contains` checks.
fn classify_iface(name: &str) -> &'static str {
    let n = name.to_lowercase();
    if n == "lo" || n.starts_with("lo") || n.contains("loopback") {
        return "loopback";
    }
    if n.contains("wi-fi")
        || n.contains("wifi")
        || n.contains("wlan")
        || n.contains("wireless")
        || n.contains("airport")
        || n.starts_with("wl")
    {
        return "wifi";
    }
    if n.contains("bluetooth") || n.starts_with("bt") {
        return "bluetooth";
    }
    if n.contains("ethernet") || n.starts_with("eth") || n.starts_with("en") {
        return "ethernet";
    }
    if n.starts_with("docker")
        || n.starts_with("veth")
        || n.starts_with("br-")
        || n.starts_with("virbr")
        || n.starts_with("vbox")
        || n.starts_with("vmnet")
        || n.starts_with("tun")
        || n.starts_with("tap")
        || n.starts_with("utun")
        || n.starts_with("awdl")
        || n.starts_with("llw")
        || n.starts_with("vnic")
        || n.contains("virtual")
    {
        return "virtual";
    }
    "other"
}

/// GPU model name(s), best-effort per OS. Empty when none could be read.
fn read_gpus() -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        let out = match run("system_profiler", &["SPDisplaysDataType"]) {
            Some(o) => o,
            None => return Vec::new(),
        };
        out.lines()
            .filter_map(|l| l.trim().strip_prefix("Chipset Model:"))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    }
    #[cfg(target_os = "linux")]
    {
        let out = match run("lspci", &[]) {
            Some(o) => o,
            None => return Vec::new(),
        };
        let mut gpus: Vec<String> = Vec::new();
        for line in out.lines() {
            let is_gpu = line.contains("VGA compatible controller")
                || line.contains("3D controller")
                || line.contains("Display controller");
            if !is_gpu {
                continue;
            }
            // "01:00.0 VGA compatible controller: NVIDIA Corporation GA104 [...]".
            if let Some((_, desc)) = line.split_once(": ") {
                let name = desc.trim().to_string();
                if !name.is_empty() && !gpus.contains(&name) {
                    gpus.push(name);
                }
            }
        }
        gpus
    }
    #[cfg(target_os = "windows")]
    {
        let out = match run(
            "powershell",
            &[
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name",
            ],
        ) {
            Some(o) => o,
            None => return Vec::new(),
        };
        out.lines()
            .map(|l| l.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        Vec::new()
    }
}

/// Best-effort bluetooth adapter descriptor. `None` when no adapter is detected
/// or the probe tool is unavailable.
fn read_bluetooth() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let out = run("system_profiler", &["SPBluetoothDataType"])?;
        if !out.to_lowercase().contains("bluetooth") {
            return None;
        }
        // Prefer the controller chipset when present; else just flag presence.
        for line in out.lines() {
            if let Some(v) = line.trim().strip_prefix("Chipset:") {
                let v = v.trim();
                if !v.is_empty() {
                    return Some(v.to_string());
                }
            }
        }
        Some("Intégré".to_string())
    }
    #[cfg(target_os = "linux")]
    {
        // `bluetoothctl list` → "Controller AA:BB:CC:DD:EE:FF name [default]".
        if let Some(out) = run("bluetoothctl", &["list"]) {
            for line in out.lines() {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.first() == Some(&"Controller") && parts.len() >= 3 {
                    let name = parts[2..]
                        .iter()
                        .take_while(|p| !p.starts_with('['))
                        .copied()
                        .collect::<Vec<_>>()
                        .join(" ");
                    if !name.is_empty() {
                        return Some(name);
                    }
                }
            }
        }
        // Fallback: a present rfkill bluetooth line means an adapter exists.
        if let Some(out) = run("rfkill", &["list", "bluetooth"]) {
            if out.to_lowercase().contains("bluetooth") {
                return Some("Présent".to_string());
            }
        }
        None
    }
    #[cfg(target_os = "windows")]
    {
        let out = run(
            "powershell",
            &[
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Get-PnpDevice -Class Bluetooth -Status OK | Select-Object -First 1 -ExpandProperty FriendlyName",
            ],
        )?;
        let name = out.trim();
        if name.is_empty() {
            None
        } else {
            Some(name.to_string())
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        None
    }
}

/// Map macOS interface device names → class via `networksetup
/// -listallhardwareports`, whose blocks read:
///   Hardware Port: Wi-Fi
///   Device: en0
///   Ethernet Address: a4:…
#[cfg(target_os = "macos")]
fn macos_hardware_ports() -> HashMap<String, &'static str> {
    let mut map = HashMap::new();
    let out = match run("networksetup", &["-listallhardwareports"]) {
        Some(o) => o,
        None => return map,
    };
    let mut current: Option<&'static str> = None;
    for line in out.lines() {
        let t = line.trim();
        if let Some(port) = t.strip_prefix("Hardware Port:") {
            let p = port.trim().to_lowercase();
            current = Some(if p.contains("wi-fi") || p.contains("airport") {
                "wifi"
            } else if p.contains("bluetooth") {
                "bluetooth"
            } else if p.contains("ethernet") || p.contains("lan") || p.contains("thunderbolt") {
                "ethernet"
            } else {
                "other"
            });
        } else if let Some(dev) = t.strip_prefix("Device:") {
            if let Some(kind) = current.take() {
                map.insert(dev.trim().to_string(), kind);
            }
        }
    }
    map
}

/// The agent's runtime identity: privilege level + the account it runs as. Used
/// by the UI to explain why some best-effort probes are limited without root.
fn agent_info() -> AgentInfo {
    AgentInfo {
        privileged: is_privileged(),
        user: current_user(),
        service_scope: crate::service::installed_scope().as_wire(),
        managed: crate::managed(),
    }
}

#[cfg(unix)]
pub fn is_privileged() -> bool {
    // Effective uid 0 ⇒ root. Shelling out keeps us libc-free (matches the rest).
    run("id", &["-u"]).map(|s| s.trim() == "0").unwrap_or(false)
}

#[cfg(windows)]
pub fn is_privileged() -> bool {
    // `net session` only succeeds from an elevated token (else "Access is denied").
    Command::new("net")
        .arg("session")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// The OS account the agent runs as (effective user on Unix). Also surfaced by the
/// `status` command.
pub fn current_user() -> String {
    #[cfg(unix)]
    {
        // `id -un` is the effective user (matches `id -u`); fall back to $USER.
        run("id", &["-un"])
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .or_else(|| std::env::var("USER").ok().filter(|s| !s.is_empty()))
            .unwrap_or_else(|| "unknown".to_string())
    }
    #[cfg(windows)]
    {
        std::env::var("USERNAME")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "unknown".to_string())
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

/// One raw process row, before aggregation by program name.
struct RawProcess {
    pid: u32,
    name: String,
    cpu_percent: f64,
    mem_percent: f64,
    rss_bytes: u64,
    threads: Option<u32>,
    user: Option<String>,
    uptime_seconds: Option<u64>,
    /// Cumulative (read, written) bytes, when the scan itself provides them —
    /// only Windows does. Linux reads `/proc/<pid>/io` separately; macOS has no
    /// unprivileged source at all.
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    disk_io: Option<(u64, u64)>,
}

/// Aggregate figures the same scan yields for free, so the metric snapshot needs
/// no second process enumeration.
pub struct ProcTotals {
    /// Number of running processes (was a separate `sysinfo` full refresh).
    pub count: Option<u32>,
    /// Cumulative bytes read/written across all processes; `None` when the
    /// platform or our privileges don't expose per-process I/O.
    pub disk_read: Option<u64>,
    pub disk_write: Option<u64>,
}

/// Everything one process scan produces.
pub struct ProcessScan {
    pub processes: Vec<ProcessInfo>,
    pub totals: ProcTotals,
    /// pid → program name, used to name socket owners the socket probe couldn't
    /// attribute (see `SocketMap::resolve_names`).
    pub pid_names: HashMap<u32, String>,
}

/// Scan processes once per collection tick, **aggregated by program name**:
/// - `off`  → no process list (totals are still reported);
/// - `top`  → the 20 heaviest programs, scored on **CPU% + memory%**;
/// - `all`  → every program (capped at `ALL_PROCESS_LIMIT`).
///
/// We aggregate same-named processes (summing CPU% and memory) because modern
/// apps are multi-process — e.g. a browser splits work across many helper
/// processes, so a single PID looks idle while the app is busy. Grouping by name
/// gives the realistic "this app is using X%"; `instances` keeps the multiplicity
/// visible.
///
/// On Unix we shell out to `ps` rather than use `sysinfo`: its per-process CPU
/// reads 0 on macOS (a known limitation), whereas `ps` reports a real value on
/// both Unixes. `%cpu` is the kernel's recent (decaying-average) utilisation and
/// can exceed 100% across cores; `%mem` is RSS as a fraction of physical memory.
/// Widening the `ps` format string costs nothing measurable, so pid, thread
/// count, owner and start time come along for free. Windows has no `ps`, so
/// there we use `sysinfo` (whose per-process CPU *is* accurate on Windows).
///
/// `sockets` supplies the per-process connection counts and listening ports —
/// the same probe that produced the report's port list, never a second one.
pub fn collect_processes(capture: &str, sockets: &SocketMap, sys: &mut System) -> ProcessScan {
    let raw = scan_processes(sys);
    let count = if raw.is_empty() {
        None
    } else {
        Some(raw.len() as u32)
    };
    let pid_names: HashMap<u32, String> = raw.iter().map(|p| (p.pid, p.name.clone())).collect();
    let io = per_process_io(&raw);

    if capture == "off" {
        return ProcessScan {
            processes: Vec::new(),
            totals: ProcTotals {
                count,
                disk_read: io.as_ref().map(|i| i.total_read),
                disk_write: io.as_ref().map(|i| i.total_write),
            },
            pid_names,
        };
    }

    let mut agg: HashMap<String, Aggregate> = HashMap::new();
    for p in raw {
        let owned_sockets = sockets.by_pid.get(&p.pid);
        agg.entry(p.name.clone())
            .or_default()
            .absorb(&p, owned_sockets, io.as_ref());
    }

    // Score on cpu% + mem% (the two signals available on every platform).
    let mut scored: Vec<(f64, ProcessInfo)> = agg
        .into_iter()
        .map(|(name, a)| (a.cpu_percent + a.mem_percent, a.finish(name)))
        .collect();

    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(Ordering::Equal));
    scored.truncate(if capture == "top" {
        TOP_PROCESS_LIMIT
    } else {
        ALL_PROCESS_LIMIT
    });

    ProcessScan {
        processes: scored.into_iter().map(|(_, p)| p).collect(),
        totals: ProcTotals {
            count,
            disk_read: io.as_ref().map(|i| i.total_read),
            disk_write: io.as_ref().map(|i| i.total_write),
        },
        pid_names,
    }
}

/// Running sums for one program name.
#[derive(Default)]
struct Aggregate {
    instances: u32,
    cpu_percent: f64,
    mem_percent: f64,
    rss_bytes: u64,
    threads: Option<u32>,
    uptime_seconds: Option<u64>,
    disk_read: Option<u64>,
    disk_write: Option<u64>,
    conn_in: Option<u32>,
    conn_out: Option<u32>,
    listen_ports: Vec<u16>,
    /// Owner counts, so the reported user is the dominant one rather than
    /// whichever PID happened to come last.
    users: HashMap<String, u32>,
}

impl Aggregate {
    fn absorb(&mut self, p: &RawProcess, sock: Option<&ProcSockets>, io: Option<&ProcessIo>) {
        self.instances += 1;
        self.cpu_percent += p.cpu_percent;
        self.mem_percent += p.mem_percent;
        self.rss_bytes = self.rss_bytes.saturating_add(p.rss_bytes);
        if let Some(t) = p.threads {
            self.threads = Some(self.threads.unwrap_or(0).saturating_add(t));
        }
        // The oldest instance best represents "since when has this been running".
        if let Some(u) = p.uptime_seconds {
            self.uptime_seconds = Some(self.uptime_seconds.map_or(u, |cur| cur.max(u)));
        }
        if let Some(user) = &p.user {
            *self.users.entry(user.clone()).or_insert(0) += 1;
        }
        if let Some(io) = io {
            if let Some((r, w)) = io.per_pid.get(&p.pid) {
                self.disk_read = Some(self.disk_read.unwrap_or(0).saturating_add(*r));
                self.disk_write = Some(self.disk_write.unwrap_or(0).saturating_add(*w));
            }
        }
        if let Some(s) = sock {
            self.conn_in = Some(self.conn_in.unwrap_or(0).saturating_add(s.conn_in));
            self.conn_out = Some(self.conn_out.unwrap_or(0).saturating_add(s.conn_out));
            self.listen_ports.extend_from_slice(&s.listen_ports);
        }
    }

    fn finish(mut self, name: String) -> ProcessInfo {
        self.listen_ports.sort_unstable();
        self.listen_ports.dedup();
        let user = self
            .users
            .into_iter()
            .max_by_key(|(_, n)| *n)
            .map(|(u, _)| u);
        ProcessInfo {
            name,
            instances: self.instances,
            cpu_percent: (self.cpu_percent * 10.0).round() / 10.0,
            mem_bytes: self.rss_bytes,
            threads: self.threads,
            user,
            uptime_seconds: self.uptime_seconds,
            disk_read_bytes: self.disk_read,
            disk_write_bytes: self.disk_write,
            conn_in: self.conn_in,
            conn_out: self.conn_out,
            listen_ports: self.listen_ports,
        }
    }
}

/// Per-process disk I/O, plus the machine-wide totals derived from it.
struct ProcessIo {
    per_pid: HashMap<u32, (u64, u64)>,
    total_read: u64,
    total_write: u64,
}

/// Read `/proc/<pid>/io` for every scanned process. Measured at ~2 ms for 700
/// processes, so it is affordable every tick. Reading another user's counters
/// needs privileges: an unprivileged agent silently gets a partial map, and if
/// *nothing* was readable we report `None` rather than a misleading near-zero.
#[cfg(target_os = "linux")]
fn per_process_io(raw: &[RawProcess]) -> Option<ProcessIo> {
    let mut per_pid = HashMap::new();
    let (mut total_read, mut total_write) = (0u64, 0u64);
    for p in raw {
        let Ok(text) = std::fs::read_to_string(format!("/proc/{}/io", p.pid)) else {
            continue;
        };
        let (mut read, mut write) = (None, None);
        for line in text.lines() {
            if let Some(v) = line.strip_prefix("read_bytes: ") {
                read = v.trim().parse::<u64>().ok();
            } else if let Some(v) = line.strip_prefix("write_bytes: ") {
                write = v.trim().parse::<u64>().ok();
            }
        }
        if let (Some(r), Some(w)) = (read, write) {
            total_read = total_read.saturating_add(r);
            total_write = total_write.saturating_add(w);
            per_pid.insert(p.pid, (r, w));
        }
    }
    if per_pid.is_empty() {
        return None;
    }
    Some(ProcessIo {
        per_pid,
        total_read,
        total_write,
    })
}

/// macOS exposes no `/proc`, and `proc_pid_rusage` needs root for other users'
/// processes — so per-process I/O is simply unknown there.
#[cfg(target_os = "macos")]
fn per_process_io(_raw: &[RawProcess]) -> Option<ProcessIo> {
    None
}

/// Windows I/O counters come from the same `sysinfo` refresh as the scan itself,
/// so they are attached there rather than probed again.
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn per_process_io(raw: &[RawProcess]) -> Option<ProcessIo> {
    let mut per_pid = HashMap::new();
    let (mut total_read, mut total_write) = (0u64, 0u64);
    for p in raw {
        if let Some((r, w)) = p.disk_io {
            total_read = total_read.saturating_add(r);
            total_write = total_write.saturating_add(w);
            per_pid.insert(p.pid, (r, w));
        }
    }
    if per_pid.is_empty() {
        return None;
    }
    Some(ProcessIo {
        per_pid,
        total_read,
        total_write,
    })
}

/// Enumerate every process, once. Unix parses `ps`; Windows reads `sysinfo`
/// (hence the `System`, unused here but needed by the Windows arm).
#[cfg(not(target_os = "windows"))]
fn scan_processes(_sys: &mut System) -> Vec<RawProcess> {
    // macOS uses `ucomm` (short accounting name) and `etime` (formatted); Linux
    // uses `comm`, `etimes` (plain seconds) and exposes a thread count (`nlwp`).
    #[cfg(target_os = "macos")]
    let args: [&str; 2] = ["-Ao", "pid=,pcpu=,pmem=,rss=,etime=,user=,ucomm="];
    #[cfg(not(target_os = "macos"))]
    let args: [&str; 2] = ["-eo", "pid=,pcpu=,pmem=,rss=,etimes=,nlwp=,user=,comm="];

    let out = match run("ps", &args) {
        Some(o) => o,
        None => return Vec::new(),
    };
    out.lines().filter_map(parse_ps_line).collect()
}

/// Windows scan via `sysinfo`. The `System` lives across ticks, so the CPU delta
/// is measured against the previous collection — which is exactly what a
/// periodic collector wants, and removes the 300 ms blocking double-refresh the
/// old one-shot scan needed.
#[cfg(target_os = "windows")]
fn scan_processes(sys: &mut System) -> Vec<RawProcess> {
    use sysinfo::{ProcessesToUpdate, Users};
    sys.refresh_processes(ProcessesToUpdate::All, true);
    // `Process::user_id()` yields a SID on Windows, which is unreadable in a
    // "user" column — resolve it to the account name. Enumerating local users is
    // cheap and only done once per scan.
    let users = Users::new_with_refreshed_list();
    let total_mem = sys.total_memory().max(1) as f64;
    sys.processes()
        .iter()
        .filter_map(|(pid, proc)| {
            let name = proc.name().to_string_lossy().to_string();
            if name.is_empty() {
                return None;
            }
            let rss = proc.memory();
            let usage = proc.disk_usage();
            Some(RawProcess {
                pid: pid.as_u32(),
                name,
                cpu_percent: proc.cpu_usage() as f64,
                mem_percent: (rss as f64 / total_mem) * 100.0,
                rss_bytes: rss,
                threads: None,
                user: proc
                    .user_id()
                    .and_then(|uid| users.get_user_by_id(uid))
                    .map(|u| u.name().to_string()),
                uptime_seconds: Some(proc.run_time()),
                disk_io: Some((usage.total_read_bytes, usage.total_written_bytes)),
            })
        })
        .collect()
}

/// Parse one `ps` line into a [`RawProcess`]. The command name is last so it may
/// contain spaces; every preceding column is a fixed-position number or word.
#[cfg(not(target_os = "windows"))]
fn parse_ps_line(line: &str) -> Option<RawProcess> {
    let mut parts = line.split_whitespace();
    let pid: u32 = parts.next()?.parse().ok()?;
    let cpu_percent: f64 = parts.next()?.parse().ok()?;
    let mem_percent: f64 = parts.next()?.parse().ok()?;
    let rss_kb: u64 = parts.next()?.parse().ok()?;
    #[cfg(target_os = "macos")]
    let (uptime_seconds, threads) = (parse_etime(parts.next()?), None);
    #[cfg(not(target_os = "macos"))]
    let (uptime_seconds, threads) = (
        parts.next()?.parse::<u64>().ok(),
        parts.next()?.parse::<u32>().ok(),
    );
    let user = parts.next()?.to_string();
    let name = parts.collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        return None;
    }
    Some(RawProcess {
        pid,
        name,
        cpu_percent,
        mem_percent,
        rss_bytes: rss_kb * 1024,
        threads,
        user: (!user.is_empty()).then_some(user),
        uptime_seconds,
        disk_io: None,
    })
}

/// Parse BSD `ps` elapsed time — `[[dd-]hh:]mm:ss` — into seconds. Linux is
/// spared this by asking for `etimes` (already a plain second count).
#[cfg(target_os = "macos")]
fn parse_etime(s: &str) -> Option<u64> {
    let (days, rest) = match s.split_once('-') {
        Some((d, rest)) => (d.parse::<u64>().ok()?, rest),
        None => (0, s),
    };
    let mut units: Vec<u64> = rest
        .split(':')
        .rev()
        .filter_map(|p| p.parse().ok())
        .collect();
    units.resize(3, 0); // seconds, minutes, hours
    Some(days * 86400 + units[2] * 3600 + units[1] * 60 + units[0])
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
pub fn run(cmd: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(cmd).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Like `run`, but returns stdout even on a non-zero exit. Some tools print the
/// answer we want yet exit non-zero (`systemctl is-active` exits 3 when a unit is
/// inactive but still prints "inactive"). `None` only when the binary is absent.
#[cfg(target_os = "linux")]
fn run_unchecked(cmd: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(cmd).args(args).output().ok()?;
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

#[cfg(target_os = "linux")]
fn firewall_enabled() -> Option<bool> {
    // `ufw status` and reading the nft ruleset both need root; when the agent runs
    // unprivileged they return None and we fall through to the systemd probe below,
    // which any user can read. So firewall state is now detectable without root as
    // long as the firewall is a managed systemd unit.
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
    // Non-root fallback: a running firewall service. Only a positive "active" is
    // conclusive here (an absent unit also reports inactive), so we don't infer
    // "disabled" from this — we keep looking and ultimately return None (unknown).
    for svc in ["firewalld", "ufw", "nftables"] {
        if let Some(out) = run_unchecked("systemctl", &["is-active", svc]) {
            if out.trim() == "active" {
                return Some(true);
            }
        }
    }
    // Root path: a non-empty nftables ruleset with an input hook means filtering.
    if let Some(out) = run("nft", &["list", "ruleset"]) {
        if out.contains("hook input") {
            return Some(true);
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn disk_encrypted() -> Option<bool> {
    // Any LUKS-typed block device counts as encrypted storage.
    let out = run("lsblk", &["-o", "TYPE,FSTYPE", "-n"])?;
    let encrypted = out
        .lines()
        .any(|l| l.contains("crypt") || l.contains("LUKS") || l.contains("crypto_LUKS"));
    Some(encrypted)
}

#[cfg(target_os = "linux")]
fn sip_enabled() -> Option<bool> {
    None
}

#[cfg(target_os = "linux")]
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

// ── Windows collectors ──────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn firewall_enabled() -> Option<bool> {
    // `netsh advfirewall show allprofiles state` prints a `State   ON/OFF` line
    // per profile (Domain/Private/Public). Treat any profile OFF as not fully
    // protected.
    let out = run("netsh", &["advfirewall", "show", "allprofiles", "state"])?;
    let mut saw_state = false;
    let mut any_off = false;
    for line in out.to_lowercase().lines() {
        if line.contains("state") {
            saw_state = true;
            if line.contains("off") {
                any_off = true;
            }
        }
    }
    if saw_state {
        Some(!any_off)
    } else {
        None
    }
}

#[cfg(target_os = "windows")]
fn disk_encrypted() -> Option<bool> {
    // BitLocker: `manage-bde -status` reports "Protection Status: Protection
    // On/Off" per volume. Any volume On counts as encrypted storage.
    let out = run("manage-bde", &["-status"])?;
    let lower = out.to_lowercase();
    if lower.contains("protection on") {
        Some(true)
    } else if lower.contains("protection off") {
        Some(false)
    } else {
        None
    }
}

#[cfg(target_os = "windows")]
fn sip_enabled() -> Option<bool> {
    None
}

#[cfg(target_os = "windows")]
fn pending_updates() -> Option<u32> {
    // Querying Windows Update needs WUA/PowerShell and is slow; skipped by design.
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "linux")]
    #[test]
    fn parse_ps_line_reads_every_column() {
        // pid pcpu pmem rss etimes nlwp user comm
        let p = parse_ps_line("1234 12.5 3.2 524288 86400 14 gerem firefox").unwrap();
        assert_eq!(p.pid, 1234);
        assert_eq!(p.cpu_percent, 12.5);
        assert_eq!(p.mem_percent, 3.2);
        assert_eq!(p.rss_bytes, 524288 * 1024);
        assert_eq!(p.uptime_seconds, Some(86400));
        assert_eq!(p.threads, Some(14));
        assert_eq!(p.user.as_deref(), Some("gerem"));
        assert_eq!(p.name, "firefox");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn parse_ps_line_keeps_names_containing_spaces() {
        // `comm` is last, so anything after the user column belongs to the name.
        let p = parse_ps_line("7 0.0 0.0 0 10 1 root kworker/0:1 -events").unwrap();
        assert_eq!(p.name, "kworker/0:1 -events");
        assert_eq!(p.rss_bytes, 0);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn parse_ps_line_rejects_malformed_rows() {
        assert!(parse_ps_line("").is_none());
        assert!(parse_ps_line("header garbage").is_none());
        // Every column present but the command name.
        assert!(parse_ps_line("1234 12.5 3.2 524288 86400 14 gerem").is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn parse_etime_handles_every_bsd_form() {
        assert_eq!(parse_etime("05:30"), Some(330)); // mm:ss
        assert_eq!(parse_etime("02:05:30"), Some(7530)); // hh:mm:ss
        assert_eq!(parse_etime("3-02:05:30"), Some(266_730)); // dd-hh:mm:ss
        assert_eq!(parse_etime("garbage"), Some(0));
    }

    #[test]
    fn aggregate_sums_instances_and_keeps_dominant_user() {
        let mut agg = Aggregate::default();
        for (pid, user) in [(1, "root"), (2, "gerem"), (3, "gerem")] {
            agg.absorb(
                &RawProcess {
                    pid,
                    name: "chrome".into(),
                    cpu_percent: 10.0,
                    mem_percent: 1.0,
                    rss_bytes: 1000,
                    threads: Some(4),
                    user: Some(user.into()),
                    uptime_seconds: Some(pid as u64 * 100),
                    disk_io: None,
                },
                None,
                None,
            );
        }
        let info = agg.finish("chrome".into());
        assert_eq!(info.instances, 3);
        assert_eq!(info.cpu_percent, 30.0);
        assert_eq!(info.mem_bytes, 3000);
        assert_eq!(info.threads, Some(12));
        assert_eq!(info.user.as_deref(), Some("gerem"));
        // The oldest instance answers "since when has this been running".
        assert_eq!(info.uptime_seconds, Some(300));
        // Nothing was readable, so these stay unknown rather than a false zero.
        assert_eq!(info.disk_read_bytes, None);
        assert_eq!(info.conn_in, None);
    }

    #[test]
    fn aggregate_attaches_socket_counts() {
        let mut agg = Aggregate::default();
        agg.absorb(
            &RawProcess {
                pid: 1,
                name: "nginx".into(),
                cpu_percent: 1.0,
                mem_percent: 0.5,
                rss_bytes: 100,
                threads: None,
                user: None,
                uptime_seconds: None,
                disk_io: None,
            },
            Some(&ProcSockets {
                listen_ports: vec![443, 80],
                conn_in: 12,
                conn_out: 2,
            }),
            None,
        );
        let info = agg.finish("nginx".into());
        assert_eq!(info.conn_in, Some(12));
        assert_eq!(info.conn_out, Some(2));
        assert_eq!(info.listen_ports, vec![80, 443], "sorted and deduped");
    }
}
