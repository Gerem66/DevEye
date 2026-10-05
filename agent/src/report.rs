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
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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

/// Hard cap on reported network interfaces: a container host can expose dozens
/// of virtual `veth*`/`br-*` devices, and an over-long list would be rejected
/// wholesale by the report schema's `.max(64)`.
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

/// Network interfaces with their MAC and an inferred class. On macOS the class is
/// resolved from `networksetup -listallhardwareports` (`en0` may be Wi-Fi or
/// Ethernet); elsewhere it's inferred from the interface name.
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
    // Physical before virtual/loopback, then alphabetical, so the cap drops noise.
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
    let scope = crate::service::installed_scope();
    AgentInfo {
        privileged: is_privileged(),
        user: current_user(),
        service_scope: scope.as_wire(),
        autostart: crate::service::autostart_enabled(scope),
        managed: crate::managed(),
        probes: PROBES.to_vec(),
        policy: crate::policy().wire(),
        insecure_transport: crate::insecure_transport(),
    }
}

/// Ce que cette version de l'agent sait relever : décrit le binaire, pas la
/// machine. Le serveur distingue ainsi « la sonde a échoué ici » d'« un agent
/// trop ancien pour l'avoir ». Ajouter une sonde, c'est ajouter son nom ici.
const PROBES: [&str; 8] = [
    "execPath",
    "posture",
    "integrity",
    "auth",
    "docker",
    "composeDeploy",
    "folderArchive",
    "tunnel",
];

/// Effective uid 0 ⇒ root.
///
/// Sur Linux la réponse vient du noyau (`/proc/self/status`), pas d'un binaire
/// externe : `id` n'est pas toujours dans le `PATH` (conteneur, embarqué sans
/// coreutils), et « je n'ai pas pu le savoir » ne doit pas se lire « pas root ».
/// La ligne `Uid:` donne réel, effectif, sauvegardé, fs : c'est l'effectif qui
/// décide. `id -u` reste le repli des autres Unix.
#[cfg(unix)]
pub fn is_privileged() -> bool {
    #[cfg(target_os = "linux")]
    if let Some(euid) = proc_effective_uid() {
        return euid == 0;
    }
    run("id", &["-u"]).map(|s| s.trim() == "0").unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn proc_effective_uid() -> Option<u32> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|l| l.starts_with("Uid:"))?;
    line.split_whitespace().nth(2)?.parse().ok()
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
    /// Chemin de l'exécutable. `None` quand la plateforme ou les droits ne
    /// l'exposent pas — jamais une chaîne vide, qui se lirait comme « la racine ».
    exec_path: Option<String>,
    /// Le binaire a été effacé du disque alors que le processus tourne encore.
    /// `None` là où la plateforme ne permet pas de le savoir.
    deleted: Option<bool>,
    /// Fil du noyau. `None` là où la plateforme ne permet pas de le savoir.
    kernel: Option<bool>,
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
    /// Number of running processes.
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

/// Scan processes once per collection tick, aggregated by program:
/// - `off`  → no process list (totals are still reported);
/// - `top`  → the 20 heaviest programs, scored on CPU% + memory%;
/// - `all`  → every program (capped at `ALL_PROCESS_LIMIT`).
///
/// Same-named processes are summed because modern apps are multi-process (a
/// browser splits work across helpers, so a single PID looks idle while the app
/// is busy); `instances` keeps the multiplicity visible.
///
/// `%cpu` is the kernel's recent (decaying-average) utilisation and can exceed
/// 100% across cores; `%mem` is RSS as a fraction of physical memory.
///
/// `sockets` supplies the per-process connection counts and listening ports,
/// from the same probe that produced the report's port list.
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

    // La clé est (nom, chemin) et non le nom seul : un `nginx` légitime dans
    // /usr/sbin et un `nginx` déposé dans /tmp sont deux programmes, et les
    // fusionner est ce derrière quoi un imposteur se cache.
    let mut agg: HashMap<(String, Option<String>), Aggregate> = HashMap::new();
    for p in raw {
        let owned_sockets = sockets.by_pid.get(&p.pid);
        agg.entry((p.name.clone(), p.exec_path.clone()))
            .or_default()
            .absorb(&p, owned_sockets, io.as_ref());
    }

    // Score on cpu% + mem% (the two signals available on every platform).
    let mut scored: Vec<(f64, ProcessInfo)> = agg
        .into_iter()
        .map(|((name, _), a)| (a.cpu_percent + a.mem_percent, a.finish(name)))
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
    /// Porté par la clé d'agrégation : identique pour toutes les instances du
    /// groupe, donc retenu une fois à la première absorption.
    exec_path: Option<String>,
    deleted: Option<bool>,
    kernel: Option<bool>,
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
        if self.instances == 0 {
            self.exec_path = p.exec_path.clone();
            // Même raison que `exec_path` : la clé d'agrégation porte le chemin,
            // et un fil du noyau n'en a jamais un, donc le groupe est homogène.
            self.kernel = p.kernel;
        }
        // Un seul processus au binaire effacé suffit à marquer le groupe :
        // c'est l'anomalie qu'on cherche.
        if p.deleted == Some(true) {
            self.deleted = Some(true);
        } else if self.deleted.is_none() {
            self.deleted = p.deleted;
        }
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
            exec_path: self.exec_path,
            deleted: self.deleted,
            kernel: self.kernel,
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
fn scan_processes(sys: &mut System) -> Vec<RawProcess> {
    // Linux lit `/proc` directement : aucune dépendance au `ps` du système (un
    // BusyBox, une racine minimale ou un `PATH` réduit rendent une liste vide,
    // en silence).
    #[cfg(target_os = "linux")]
    {
        let procs = scan_processes_proc();
        if !procs.is_empty() {
            return procs;
        }
        tracing::warn!("/proc yielded no process — falling back to ps");
    }

    // macOS uses `%cpu`/`%mem`, `etime` (formatted) and `comm`; Linux uses
    // `pcpu`/`pmem`, `etimes` (plain seconds) and exposes a thread count (`nlwp`).
    //
    // Deux détails propres à BSD, et les deux vident la liste :
    // - `%cpu`/`%mem` et non leurs alias `pcpu`/`pmem` : le `ps` de Darwin refuse
    //   un en-tête personnalisé sur un alias et sort en non-zéro ;
    // - `-ww` : sans lui, BSD tronque chaque ligne à 79 colonnes quand aucun tty
    //   n'est attaché (sous launchd), et la colonne du nom se vide.
    // `comm` (chemin complet) et non `ucomm` (nom court) : le nom s'en déduit,
    // l'inverse est impossible.
    #[cfg(target_os = "macos")]
    let args: [&str; 2] = ["-Awwo", "pid=,%cpu=,%mem=,rss=,etime=,user=,comm="];
    #[cfg(not(target_os = "macos"))]
    let args: [&str; 2] = ["-eo", "pid=,pcpu=,pmem=,rss=,etimes=,nlwp=,user=,comm="];

    // Lecture même sur statut non nul : un `ps` qui se plaint d'une colonne peut
    // répondre utilement sur les autres.
    let procs = match run_unchecked("ps", &args) {
        Some(out) => {
            let procs: Vec<RawProcess> = out.lines().filter_map(parse_ps_line).collect();
            if procs.is_empty() {
                tracing::warn!(
                    lines = out.lines().count(),
                    "`ps` returned output but no line could be parsed — unexpected column layout"
                );
            }
            procs
        }
        None => {
            // Ne pas rendre un vide muet : indiscernable d'une machine au repos.
            tracing::warn!("`ps` unavailable or failed — no process list this tick");
            Vec::new()
        }
    };
    if !procs.is_empty() {
        return procs;
    }

    // Dernier recours : `sysinfo`, sans aucun binaire externe, pour que la liste
    // ne puisse jamais être vide en silence quelle que soit la version de `ps`.
    tracing::warn!("falling back to sysinfo for the process list");
    scan_processes_sysinfo(sys)
}

/// Énumération par `sysinfo`, sans aucun binaire externe.
///
/// Sert de source unique à Windows et de filet aux Unix. `%cpu` y est la charge
/// mesurée **depuis le rafraîchissement précédent** et non la moyenne sur la vie
/// du processus : `System` vit d'un tick à l'autre, donc l'écart tombe juste
/// pour un collecteur périodique.
fn scan_processes_sysinfo(sys: &mut System) -> Vec<RawProcess> {
    use sysinfo::{ProcessesToUpdate, Users};
    sys.refresh_processes(ProcessesToUpdate::All, true);
    // `Process::user_id()` rend un SID sous Windows, illisible dans une colonne
    // « utilisateur » — on le résout en nom de compte. Énumérer les comptes
    // locaux est bon marché et n'a lieu qu'une fois par balayage.
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
                // Windows tient son chemin d'ici ; sur Unix cette branche n'est
                // qu'un filet de secours, et le chemin y est tout aussi bon.
                exec_path: proc.exe().map(|p| p.to_string_lossy().to_string()),
                // Aucune plateforme n'expose ici l'équivalent du « (deleted) »
                // de Linux : inconnu, jamais « pas supprimé ».
                deleted: None,
                kernel: None,
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

/// Énumère les processus depuis `/proc`, sans passer par `ps`.
///
/// Reproduit les mêmes colonnes, avec les mêmes sémantiques : `%cpu` y est la
/// moyenne sur la vie du processus — temps CPU cumulé rapporté à son âge —, ce
/// que rend aussi `ps -o pcpu`, et non une mesure instantanée.
#[cfg(target_os = "linux")]
fn scan_processes_proc() -> Vec<RawProcess> {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    let uptime = proc_uptime_seconds().unwrap_or(0.0);
    let total_mem_kb = proc_mem_total_kb().unwrap_or(0);
    let users = crate::integrity::passwd_owners();

    let mut out = Vec::new();
    for entry in entries.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue; // `/proc` mêle ses répertoires de pid à ses fichiers.
        };
        // Un processus peut disparaître entre l'énumération et la lecture : ce
        // n'est pas une erreur, on l'ignore simplement.
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
            continue;
        };
        if let Some(p) = parse_proc_stat(pid, &stat, uptime, total_mem_kb, &users) {
            out.push(p);
        }
    }
    out
}

/// Chemin de l'exécutable d'un processus, et « son binaire a-t-il été effacé ? ».
///
/// Une seule syscall par PID (`readlink`), négligeable devant le reste du tick.
///
/// Le noyau suffixe le lien de « (deleted) » quand l'inode a été délié, dans
/// deux situations opposées : l'exécutable a disparu (forme d'un implant
/// résident en mémoire, ce qu'on cherche), ou il a été REMPLACÉ, ce que fait
/// tout gestionnaire de paquets (`rename()` par-dessus). Le discriminant est le
/// chemin : s'il pointe encore sur un fichier, le binaire a été remplacé. Un
/// leurre déposé à l'emplacement échapperait à cette règle ; les autres (chemin
/// suspect, persistance) couvrent ce cas.
///
/// `None` sur échec : processus disparu, ou `/proc/<pid>/exe` d'un autre compte
/// sans les droits. C'est le fonctionnement normal sans privilèges.
#[cfg(target_os = "linux")]
fn proc_exe(pid: u32) -> (Option<String>, Option<bool>) {
    const DELETED: &str = " (deleted)";
    match std::fs::read_link(format!("/proc/{pid}/exe")) {
        Ok(path) => {
            let raw = path.to_string_lossy();
            match raw.strip_suffix(DELETED) {
                Some(clean) => (
                    Some(clean.to_string()),
                    Some(!std::path::Path::new(clean).exists()),
                ),
                None => (Some(raw.to_string()), Some(false)),
            }
        }
        // Un fil du noyau n'a légitimement aucun exécutable : le lien n'existe
        // pas, et ce n'est ni une erreur ni un manque de droits.
        Err(_) => (None, None),
    }
}

/// USER_HZ, l'unité des compteurs de `/proc/<pid>/stat`. Vaut 100 sur toutes les
/// architectures Linux courantes ; le lire demanderait `sysconf`, donc la libc.
#[cfg(target_os = "linux")]
const USER_HZ: f64 = 100.0;

/// `PF_KTHREAD` dans les drapeaux de tâche : le noyau marque lui-même ses fils.
/// C'est le seul discriminant exact. L'absence de `/proc/<pid>/exe` ne l'est
/// pas, elle se confond avec un lien illisible faute de droits, et le nom pas
/// davantage, un programme du disque étant libre de s'appeler `kworker/0:1`.
#[cfg(target_os = "linux")]
const PF_KTHREAD: u64 = 0x0020_0000;

#[cfg(target_os = "linux")]
fn parse_proc_stat(
    pid: u32,
    stat: &str,
    uptime: f64,
    total_mem_kb: u64,
    users: &HashMap<u32, String>,
) -> Option<RawProcess> {
    // `comm` est entre parenthèses et peut contenir espaces ET parenthèses :
    // on coupe sur la **dernière**, seule borne fiable.
    let open = stat.find('(')?;
    let close = stat.rfind(')')?;
    let name = stat.get(open + 1..close)?.to_string();
    if name.is_empty() {
        return None;
    }
    // Après la parenthèse fermante, le premier champ est `state` (le 3ᵉ de la
    // page de manuel) : l'indice i vaut donc le champ i+3.
    let f: Vec<&str> = stat.get(close + 1..)?.split_whitespace().collect();
    let num = |i: usize| -> Option<u64> { f.get(i)?.parse().ok() };
    let flags = num(6)?; // champ 9
    let utime = num(11)?; // champ 14
    let stime = num(12)?; // champ 15
    let threads = num(17).map(|t| t as u32); // champ 20
    let starttime = num(19)?; // champ 22
    let rss_pages = num(21)?; // champ 24

    let age = (uptime - starttime as f64 / USER_HZ).max(0.0);
    let cpu_percent = if age > 0.0 {
        ((utime + stime) as f64 / USER_HZ / age) * 100.0
    } else {
        0.0
    };
    let rss_bytes = rss_pages.saturating_mul(page_size());
    let mem_percent = if total_mem_kb > 0 {
        (rss_bytes as f64 / (total_mem_kb as f64 * 1024.0)) * 100.0
    } else {
        0.0
    };

    let (exec_path, deleted) = proc_exe(pid);
    Some(RawProcess {
        pid,
        name,
        exec_path,
        deleted,
        kernel: Some(flags & PF_KTHREAD != 0),
        cpu_percent,
        mem_percent,
        rss_bytes,
        threads,
        user: proc_uid(pid).and_then(|uid| users.get(&uid).cloned()),
        uptime_seconds: Some(age as u64),
        disk_io: None,
    })
}

/// Taille de page, en octets. 4 Kio partout sauf sur certains noyaux ARM64
/// configurés en 16 ou 64 Kio — d'où la lecture du vrai chiffre quand `getconf`
/// répond, plutôt qu'une constante qui fausserait la mémoire d'un facteur 16.
#[cfg(target_os = "linux")]
fn page_size() -> u64 {
    use std::sync::OnceLock;
    static SIZE: OnceLock<u64> = OnceLock::new();
    *SIZE.get_or_init(|| {
        run("getconf", &["PAGESIZE"])
            .and_then(|s| s.trim().parse::<u64>().ok())
            .filter(|v| v.is_power_of_two())
            .unwrap_or(4096)
    })
}

#[cfg(target_os = "linux")]
fn proc_uptime_seconds() -> Option<f64> {
    std::fs::read_to_string("/proc/uptime")
        .ok()?
        .split_whitespace()
        .next()?
        .parse()
        .ok()
}

#[cfg(target_os = "linux")]
fn proc_mem_total_kb() -> Option<u64> {
    let meminfo = std::fs::read_to_string("/proc/meminfo").ok()?;
    meminfo
        .lines()
        .find(|l| l.starts_with("MemTotal:"))?
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()
}

/// L'uid **effectif** du processus (2ᵉ entier de la ligne `Uid:`).
#[cfg(target_os = "linux")]
fn proc_uid(pid: u32) -> Option<u32> {
    let status = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    status
        .lines()
        .find(|l| l.starts_with("Uid:"))?
        .split_whitespace()
        .nth(2)?
        .parse()
        .ok()
}

/// Windows scan via `sysinfo`. The `System` lives across ticks, so the CPU delta
/// is measured against the previous collection.
#[cfg(target_os = "windows")]
fn scan_processes(sys: &mut System) -> Vec<RawProcess> {
    scan_processes_sysinfo(sys)
}

/// Disposition des colonnes demandées à `ps`, qui diffère d'un Unix à l'autre.
/// Portée par une valeur et non par un `cfg` dans le parseur, pour que les deux
/// variantes soient testables sur toute plateforme.
#[cfg(not(target_os = "windows"))]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum PsLayout {
    /// `pid pcpu pmem rss etimes nlwp user comm` : `etimes` en secondes brutes.
    Linux,
    /// `pid %cpu %mem rss etime user comm` : `etime` formaté, pas de fils.
    Bsd,
}

#[cfg(not(target_os = "windows"))]
const PS_LAYOUT: PsLayout = if cfg!(target_os = "macos") {
    PsLayout::Bsd
} else {
    PsLayout::Linux
};

/// Parse one `ps` line into a [`RawProcess`]. The command name is last so it may
/// contain spaces; every preceding column is a fixed-position number or word.
#[cfg(not(target_os = "windows"))]
fn parse_ps_line(line: &str) -> Option<RawProcess> {
    parse_ps_line_with(line, PS_LAYOUT)
}

#[cfg(not(target_os = "windows"))]
fn parse_ps_line_with(line: &str, layout: PsLayout) -> Option<RawProcess> {
    let mut parts = line.split_whitespace();
    let pid: u32 = parts.next()?.parse().ok()?;
    let cpu_percent: f64 = parts.next()?.parse().ok()?;
    let mem_percent: f64 = parts.next()?.parse().ok()?;
    let rss_kb: u64 = parts.next()?.parse().ok()?;
    let (uptime_seconds, threads) = match layout {
        PsLayout::Bsd => (parse_etime(parts.next()?), None),
        PsLayout::Linux => (
            parts.next()?.parse::<u64>().ok(),
            parts.next()?.parse::<u32>().ok(),
        ),
    };
    let user = parts.next()?.to_string();
    // Tout ce qui suit l'utilisateur appartient à la dernière colonne : les noms
    // macOS contiennent couramment des espaces.
    let tail = parts.collect::<Vec<_>>().join(" ");
    // Sous BSD `comm` est le chemin complet, dont le nom est le dernier segment.
    // Sous Linux c'est déjà le nom seul, et le chemin vient de `proc_exe`.
    let (name, exec_path) = match layout {
        PsLayout::Bsd => {
            // Un chemin commence par `/`. Sans cela c'est un nom nu (noyau, ou
            // un `ps` qui n'a pas rendu le chemin) : on ne l'invente pas.
            let path = tail.starts_with('/').then(|| tail.clone());
            let name = tail.rsplit('/').next().unwrap_or(&tail).to_string();
            (name, path)
        }
        PsLayout::Linux => (tail, None),
    };
    if name.is_empty() {
        return None;
    }
    Some(RawProcess {
        pid,
        name,
        exec_path,
        // macOS n'expose pas l'équivalent du suffixe « (deleted) » de Linux :
        // inconnu, et non « pas supprimé ».
        deleted: None,
        // `ps` n'expose pas les drapeaux de tâche : le noyau XNU n'a de toute
        // façon pas l'équivalent des kworkers dans sa table de processus.
        kernel: None,
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
#[cfg(not(target_os = "windows"))]
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
    // Les mises à jour ne sont relevées qu'une fois : `apt-get -s upgrade` se
    // compte en dizaines de secondes, et la même sortie porte déjà la part de sécurité.
    let updates = updates();
    Security {
        firewall: firewall_enabled(),
        disk_encryption: disk_encrypted(),
        sip: sip_enabled(),
        pending_updates: updates.as_ref().map(|u| u.total),
        pending_security_updates: updates.as_ref().and_then(|u| u.security),
        // Daté seulement si le relevé a abouti : sans cela l'interface montrerait
        // « contrôlé à l'instant » sur une machine où la sonde vient d'échouer.
        updates_checked_at: updates.as_ref().map(|_| now_millis()),
        ssh_root_login: ssh_setting("permitrootlogin"),
        ssh_password_auth: ssh_setting("passwordauthentication"),
        mandatory_access_control: mandatory_access_control(),
        reboot_required: reboot_required(),
    }
}

/// Ce qu'un relevé de mises à jour rend : le total, et la part de sécurité.
pub(crate) struct UpdateCounts {
    total: u32,
    /// `None` quand le gestionnaire ne sait pas distinguer les correctifs de
    /// sécurité : inconnu, et non « aucun », qui se lirait comme une bonne nouvelle.
    security: Option<u32>,
}

/// Traduit la valeur d'une directive booléenne de sshd. `prohibit-password` /
/// `without-password` / `forced-commands-only` interdisent le mot de passe :
/// pour la question posée (« root peut-il se connecter comme n'importe qui ? »),
/// ce sont des non. Toute autre forme rend `None`.
#[cfg(not(target_os = "windows"))]
fn ssh_bool(v: &str) -> Option<bool> {
    match v.trim_matches('"').to_lowercase().as_str() {
        "yes" => Some(true),
        "no" | "prohibit-password" | "without-password" | "forced-commands-only" => Some(false),
        _ => None,
    }
}

/// Le disque, vu par l'analyseur de configuration : lire un fichier, lister un
/// dossier. Injecté pour que l'analyse soit vérifiable sans rien poser sur le disque.
#[cfg(not(target_os = "windows"))]
trait ConfigFs {
    fn read(&self, path: &str) -> Option<String>;
    /// Chemins complets des fichiers d'un dossier, triés : OpenSSH déroule un
    /// glob dans l'ordre lexicographique, et l'ordre décide du vainqueur.
    fn list(&self, dir: &str) -> Vec<String>;
}

#[cfg(not(target_os = "windows"))]
struct DiskFs;

#[cfg(not(target_os = "windows"))]
impl ConfigFs for DiskFs {
    fn read(&self, path: &str) -> Option<String> {
        std::fs::read_to_string(path).ok()
    }

    fn list(&self, dir: &str) -> Vec<String> {
        let mut out: Vec<String> = std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
            .map(|e| e.path().to_string_lossy().into_owned())
            .collect();
        out.sort();
        out
    }
}

/// Ce qu'une passe d'analyse a conclu sur un fichier.
#[cfg(not(target_os = "windows"))]
enum Scan {
    /// La directive a été rencontrée. `None` à l'intérieur = valeur non comprise.
    Value(Option<bool>),
    /// Un bloc `Match` s'ouvre : la section globale est finie, ici et chez
    /// l'appelant (l'état du parseur d'OpenSSH traverse les `Include`).
    Stop,
    /// Fichier épuisé sans rien trouver ; l'appelant poursuit sa lecture.
    End,
    /// Quelque chose n'a pas pu être lu. On ne conclut pas.
    Unknown,
}

/// `*` et `?` seulement : tout ce qu'on rencontre dans un `Include`.
#[cfg(not(target_os = "windows"))]
fn glob_match(pattern: &str, name: &str) -> bool {
    let (p, n): (Vec<char>, Vec<char>) = (pattern.chars().collect(), name.chars().collect());
    // Parcours avec point de reprise sur la dernière `*` : linéaire en pratique,
    // sans récursion.
    let (mut pi, mut ni) = (0usize, 0usize);
    let (mut star, mut resume) = (None, 0usize);
    while ni < n.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == n[ni]) {
            pi += 1;
            ni += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            resume = ni;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            resume += 1;
            ni = resume;
        } else {
            return false;
        }
    }
    p[pi..].iter().all(|c| *c == '*')
}

/// Les fichiers désignés par un motif d'`Include`, dans l'ordre où sshd les lit.
///
/// Un motif relatif se résout depuis `/etc/ssh`, comme chez OpenSSH.
#[cfg(not(target_os = "windows"))]
fn include_targets(fs: &dyn ConfigFs, pattern: &str) -> Vec<String> {
    let full = if pattern.starts_with('/') {
        pattern.to_string()
    } else {
        format!("/etc/ssh/{pattern}")
    };
    let Some(cut) = full.rfind('/') else {
        return vec![full];
    };
    let (dir, name) = (&full[..cut], &full[cut + 1..]);
    if !name.contains('*') && !name.contains('?') {
        return vec![full.clone()];
    }
    fs.list(dir)
        .into_iter()
        .filter(|path| {
            path.rfind('/')
                .map(|c| glob_match(name, &path[c + 1..]))
                .unwrap_or(false)
        })
        .collect()
}

/// Découpe une ligne de sshd_config en (mot-clé, reste).
///
/// OpenSSH accepte `Key value` **et** `Key=value`, et tolère les espaces autour
/// du `=`. Le mot-clé est insensible à la casse.
#[cfg(not(target_os = "windows"))]
fn ssh_directive(line: &str) -> Option<(String, &str)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let end = line
        .find(|c: char| c.is_whitespace() || c == '=')
        .unwrap_or(line.len());
    let rest = line[end..].trim_start_matches([' ', '\t', '=']);
    Some((line[..end].to_lowercase(), rest))
}

/// Première valeur obtenue pour `key` dans la section globale, en partant de
/// `path`. Reproduit trois règles d'OpenSSH qu'un `grep` du fichier principal
/// ignore :
///
/// - le premier obtenu gagne, pas le dernier écrit ;
/// - `Include` est déroulé à sa place : Fedora et Debian le posent en tête de
///   `sshd_config`, donc un `PermitRootLogin yes` resté plus bas est battu par
///   le `no` d'un `sshd_config.d/` ;
/// - `Match` clôt la section globale : un `PermitRootLogin yes` sous
///   `Match Address 10.0.0.0/8` ne décrit pas le cas général.
#[cfg(not(target_os = "windows"))]
fn ssh_config_scan(fs: &dyn ConfigFs, path: &str, key: &str, depth: u8) -> Scan {
    // Garde-fou : `Include` peut boucler. OpenSSH s'arrête aussi, on ne conclut
    // rien de ce qu'on n'a pas fini de lire.
    if depth > 8 {
        return Scan::Unknown;
    }
    let Some(text) = fs.read(path) else {
        return Scan::Unknown;
    };
    for line in text.lines() {
        let Some((word, rest)) = ssh_directive(line) else {
            continue;
        };
        if word == "match" {
            return Scan::Stop;
        }
        if word == "include" {
            for pattern in rest.split_whitespace() {
                for target in include_targets(fs, pattern) {
                    match ssh_config_scan(fs, &target, key, depth + 1) {
                        // Un fichier du glob qui ne s'ouvre pas : on renonce
                        // plutôt que de conclure sur ce qu'on n'a pas lu.
                        Scan::End => continue,
                        other => return other,
                    }
                }
            }
            continue;
        }
        if word == key {
            return Scan::Value(rest.split_whitespace().next().and_then(ssh_bool));
        }
    }
    Scan::End
}

/// Chemins où chercher `sshd`, avant de s'en remettre au `PATH` : le binaire vit
/// dans un `sbin`, et le `PATH` d'un service n'en contient pas toujours un.
#[cfg(not(target_os = "windows"))]
const SSHD_PATHS: [&str; 4] = [
    "/usr/sbin/sshd",
    "/usr/local/sbin/sshd",
    "/sbin/sshd",
    "sshd",
];

/// Réglage effectif du serveur SSH, ou `None` si on ne peut pas l'affirmer.
///
/// - privilégié : `sshd -T` rend la configuration effective, `Include` résolus
///   et blocs `Match` appliqués. La seule source qui fasse foi ;
/// - non privilégié : on déroule `/etc/ssh/sshd_config` nous-mêmes (voir
///   `ssh_config_scan`) et on ne répond que si la directive s'y trouve. Conclure
///   sur la valeur par défaut d'OpenSSH produirait des constats faux sur toute
///   configuration éclatée.
///
/// `None` est donc une réponse fréquente et voulue : mieux vaut « pas mesuré »
/// qu'un « SSH accepte root » inventé.
#[cfg(not(target_os = "windows"))]
fn ssh_setting(key: &str) -> Option<bool> {
    if is_privileged() {
        for exe in SSHD_PATHS {
            let Some(out) = run(exe, &["-T"]) else {
                continue;
            };
            for line in out.lines() {
                let mut it = line.split_whitespace();
                if it.next().map(str::to_lowercase).as_deref() == Some(key) {
                    return it.next().and_then(ssh_bool);
                }
            }
            // `sshd -T` a répondu sans la clé : on ne tranche pas.
            return None;
        }
    }

    match ssh_config_scan(&DiskFs, "/etc/ssh/sshd_config", key, 0) {
        Scan::Value(v) => v,
        _ => None,
    }
}

#[cfg(target_os = "windows")]
fn ssh_setting(_key: &str) -> Option<bool> {
    None
}

/// Délai au-delà duquel une sonde est abandonnée et son processus tué.
///
/// Aucune sonde ne doit pouvoir attendre sans fin : une seule commande bloquée
/// (`apt-get -s upgrade` sur le verrou dpkg) figerait la session entière. Cinq
/// secondes couvrent toute sonde saine ; celles qu'on sait lentes demandent
/// explicitement plus (voir `run_timeout`).
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// Échéance de la sonde de mises à jour, la seule qu'on sache légitimement lente.
#[cfg(target_os = "linux")]
const APT_TIMEOUT: Duration = Duration::from_secs(20);

/// Sortie d'une sonde : ce qu'elle a écrit, et si elle a réussi.
pub(crate) struct ProbeOutput {
    pub stdout: String,
    pub success: bool,
}

/// Lance une commande sous échéance et rend sa sortie.
///
/// La sortie est drainée par un fil dédié plutôt que lue après coup : un tuyau
/// plein bloque le fils. Passé l'échéance, le fils est tué, sans quoi il
/// vivrait et tiendrait ses verrous.
pub(crate) fn run_timeout(cmd: &str, args: &[&str], timeout: Duration) -> Option<ProbeOutput> {
    use std::io::Read;
    use std::process::Stdio;
    use std::sync::mpsc;

    let mut child = Command::new(cmd)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let mut stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        let _ = tx.send(buf);
    });

    match rx.recv_timeout(timeout) {
        Ok(buf) => {
            // Le tuyau s'est fermé : le fils a fini, `wait` rend aussitôt.
            let success = child.wait().map(|s| s.success()).unwrap_or(false);
            Some(ProbeOutput {
                stdout: String::from_utf8_lossy(&buf).to_string(),
                success,
            })
        }
        Err(_) => {
            tracing::warn!(
                command = cmd,
                timeout_s = timeout.as_secs(),
                "probe timed out — killed"
            );
            let _ = child.kill();
            let _ = child.wait();
            None
        }
    }
}

/// Run a command and return its stdout as a lossy string on success.
pub fn run(cmd: &str, args: &[&str]) -> Option<String> {
    let out = run_timeout(cmd, args, PROBE_TIMEOUT)?;
    if !out.success {
        return None;
    }
    Some(out.stdout)
}

/// Like `run`, but returns stdout even on a non-zero exit. Some tools print the
/// answer we want yet exit non-zero (`systemctl is-active` exits 3 when a unit is
/// inactive but still prints "inactive"; BSD `ps` on a keyword alias). `None`
/// only when the binary is absent. Hors Windows, où aucune sonde ne l'appelle.
#[cfg(not(target_os = "windows"))]
fn run_unchecked(cmd: &str, args: &[&str]) -> Option<String> {
    run_timeout(cmd, args, PROBE_TIMEOUT).map(|o| o.stdout)
}

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
fn updates() -> Option<UpdateCounts> {
    // `softwareupdate -l` can take tens of seconds; skipped on macOS by design.
    None
}

/// macOS n'expose pas de contrôle d'accès obligatoire comparable : SIP et le
/// bac à sable applicatif tiennent ce rôle, et ont leur propre contrôle.
#[cfg(target_os = "macos")]
fn mandatory_access_control() -> Option<&'static str> {
    None
}

#[cfg(target_os = "macos")]
fn reboot_required() -> Option<bool> {
    None
}

#[cfg(target_os = "linux")]
fn firewall_enabled() -> Option<bool> {
    // `ufw status` and the nft ruleset both need root; unprivileged they return
    // None and we fall through to the systemd probe, readable by any user.
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
    // conclusive (an absent unit also reports inactive), so "disabled" is never
    // inferred from this.
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
fn updates() -> Option<UpdateCounts> {
    // Debian/Ubuntu: simulate an upgrade and count "Inst" lines. La sonde la
    // plus lente de toutes (verrou dpkg dès qu'`apt-daily` tourne), d'où une
    // échéance propre : « inconnu » s'affiche, une attente sans fin non.
    if let Some(out) = run_timeout("apt-get", &["-s", "upgrade"], APT_TIMEOUT) {
        if !out.success {
            return None;
        }
        let inst: Vec<&str> = out
            .stdout
            .lines()
            .filter(|l| l.starts_with("Inst "))
            .collect();
        // La même sortie porte le dépôt d'origine entre parenthèses : un
        // correctif de sécurité vient d'une suite `*-security`.
        let security = inst
            .iter()
            .filter(|l| {
                let lower = l.to_lowercase();
                lower.contains("-security") || lower.contains("securite")
            })
            .count();
        return Some(UpdateCounts {
            total: inst.len() as u32,
            security: Some(security as u32),
        });
    }
    // Fedora/RHEL: dnf exits non-zero when updates exist, so use a checked call.
    if let Ok(o) = Command::new("dnf").args(["-q", "check-update"]).output() {
        let text = String::from_utf8_lossy(&o.stdout);
        let total = text.lines().filter(|l| !l.trim().is_empty()).count() as u32;
        // `updateinfo` est le seul à savoir ce qui relève de la sécurité chez
        // dnf. Absent (dépôts sans métadonnées d'avis) ⇒ `None`, et non zéro.
        let security = run("dnf", &["-q", "updateinfo", "list", "security"]).map(|out| {
            out.lines()
                .filter(|l| !l.trim().is_empty() && !l.starts_with('\u{20}'))
                .count() as u32
        });
        return Some(UpdateCounts { total, security });
    }
    None
}

/// SELinux ou AppArmor, celui qui est actif.
#[cfg(target_os = "linux")]
fn mandatory_access_control() -> Option<&'static str> {
    if let Some(out) = run("getenforce", &[]) {
        return match out.trim().to_lowercase().as_str() {
            "enforcing" => Some("selinux-enforcing"),
            // Permissif journalise sans bloquer : ni « aucun », ni une protection.
            "permissive" => Some("selinux-permissive"),
            "disabled" => Some("none"),
            _ => None,
        };
    }
    // `aa-status --enabled` sort en 0 quand AppArmor est actif, en 1 sinon.
    if let Some(out) = run_timeout("aa-status", &["--enabled"], PROBE_TIMEOUT) {
        return Some(if out.success { "apparmor" } else { "none" });
    }
    // Sans aucun des deux outils, on ne conclut pas : SELinux peut être compilé
    // sans `getenforce` installé.
    if std::path::Path::new("/sys/kernel/security/apparmor").exists() {
        return Some("apparmor");
    }
    None
}

/// Des correctifs déjà installés attendent-ils un redémarrage ? Un noyau corrigé
/// mais non redémarré n'est pas un noyau corrigé.
#[cfg(target_os = "linux")]
fn reboot_required() -> Option<bool> {
    // Debian/Ubuntu : le fichier est posé par les paquets eux-mêmes. Sa présence
    // fait foi ; son absence aussi, sur ces distributions.
    if std::path::Path::new("/var/run/reboot-required").exists() {
        return Some(true);
    }
    if std::path::Path::new("/etc/debian_version").exists() {
        return Some(false);
    }
    // Fedora/RHEL : `needs-restarting -r` sort en 1 quand un redémarrage est
    // requis, en 0 sinon.
    if let Some(out) = run_timeout("needs-restarting", &["-r"], PROBE_TIMEOUT) {
        return Some(!out.success);
    }
    None
}

// Ni Linux, ni macOS, ni Windows : tout rend `None`, « pas mesuré », que
// l'interface distingue d'un « tout va bien ».

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn updates() -> Option<UpdateCounts> {
    None
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn mandatory_access_control() -> Option<&'static str> {
    None
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn reboot_required() -> Option<bool> {
    None
}

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
fn updates() -> Option<UpdateCounts> {
    // Querying Windows Update needs WUA/PowerShell and is slow; skipped by design.
    None
}

#[cfg(target_os = "windows")]
fn mandatory_access_control() -> Option<&'static str> {
    None
}

/// Windows pose une clé de registre quand un redémarrage est en attente ; un
/// seul des sous-systèmes (Component Based Servicing, Windows Update) suffit.
#[cfg(target_os = "windows")]
fn reboot_required() -> Option<bool> {
    const KEYS: [&str; 2] = [
        r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending",
        r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired",
    ];
    for key in KEYS {
        // `?` porte le cas « `reg` introuvable » : on ne peut alors rien affirmer.
        let out = run_timeout("reg", &["query", key], PROBE_TIMEOUT)?;
        if out.success {
            return Some(true);
        }
    }
    Some(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Analyse des lignes de `ps`, donc hors Windows, sous la même `cfg` que
    /// le code testé.
    #[cfg(not(target_os = "windows"))]
    mod ps {
        use super::*;

        #[test]
        fn parse_ps_line_reads_every_column() {
            // pid pcpu pmem rss etimes nlwp user comm
            let p = parse_ps_line_with(
                "1234 12.5 3.2 524288 86400 14 gerem firefox",
                PsLayout::Linux,
            )
            .unwrap();
            assert_eq!(p.pid, 1234);
            assert_eq!(p.cpu_percent, 12.5);
            assert_eq!(p.mem_percent, 3.2);
            assert_eq!(p.rss_bytes, 524288 * 1024);
            assert_eq!(p.uptime_seconds, Some(86400));
            assert_eq!(p.threads, Some(14));
            assert_eq!(p.user.as_deref(), Some("gerem"));
            assert_eq!(p.name, "firefox");
        }

        #[test]
        fn parse_ps_line_keeps_names_containing_spaces() {
            // `comm` is last, so anything after the user column belongs to the name.
            let p =
                parse_ps_line_with("7 0.0 0.0 0 10 1 root kworker/0:1 -events", PsLayout::Linux)
                    .unwrap();
            assert_eq!(p.name, "kworker/0:1 -events");
            assert_eq!(p.rss_bytes, 0);
        }

        #[test]
        fn parse_ps_line_rejects_malformed_rows() {
            assert!(parse_ps_line_with("", PsLayout::Linux).is_none());
            assert!(parse_ps_line_with("header garbage", PsLayout::Linux).is_none());
            // Every column present but the command name.
            assert!(
                parse_ps_line_with("1234 12.5 3.2 524288 86400 14 gerem", PsLayout::Linux)
                    .is_none()
            );
        }

        #[test]
        fn parse_etime_handles_every_bsd_form() {
            assert_eq!(parse_etime("05:30"), Some(330)); // mm:ss
            assert_eq!(parse_etime("02:05:30"), Some(7530)); // hh:mm:ss
            assert_eq!(parse_etime("3-02:05:30"), Some(266_730)); // dd-hh:mm:ss
            assert_eq!(parse_etime("garbage"), Some(0));
        }

        /// Disposition macOS réelle : sept colonnes, `etime` formaté, pas de `nlwp`.
        #[test]
        fn parse_ps_line_reads_the_bsd_layout() {
            // pid %cpu %mem rss etime user ucomm
            let p = parse_ps_line_with("501 4.2 1.8 131072 02:05:30 gerem Finder", PsLayout::Bsd)
                .unwrap();
            assert_eq!(p.pid, 501);
            assert_eq!(p.cpu_percent, 4.2);
            assert_eq!(p.mem_percent, 1.8);
            assert_eq!(p.rss_bytes, 131072 * 1024);
            assert_eq!(p.uptime_seconds, Some(7530));
            // BSD n'expose pas de compte de fils dans ce format.
            assert_eq!(p.threads, None);
            assert_eq!(p.user.as_deref(), Some("gerem"));
            assert_eq!(p.name, "Finder");
        }

        /// Les noms macOS contiennent couramment des espaces, et `comm` est en
        /// dernier : tout ce qui suit l'utilisateur lui appartient.
        #[test]
        fn parse_ps_line_bsd_keeps_names_containing_spaces() {
            let p = parse_ps_line_with(
                "823 0.1 0.4 65536 3-02:05:30 _windowserver Google Chrome Helper",
                PsLayout::Bsd,
            )
            .unwrap();
            assert_eq!(p.name, "Google Chrome Helper");
            assert_eq!(p.uptime_seconds, Some(266_730));
            assert_eq!(p.user.as_deref(), Some("_windowserver"));
        }

        /// Sous macOS `comm` rend le chemin complet, dont le nom est le dernier
        /// segment.
        #[test]
        fn parse_ps_line_bsd_splits_name_from_exec_path() {
            let p = parse_ps_line_with(
                "823 0.1 0.4 65536 3-02:05:30 _windowserver /Applications/Google Chrome.app/Contents/MacOS/Google Chrome Helper",
                PsLayout::Bsd,
            )
            .unwrap();
            assert_eq!(p.name, "Google Chrome Helper");
            assert_eq!(
                p.exec_path.as_deref(),
                Some("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome Helper")
            );
        }

        /// Un nom nu (sans `/`) n'est pas un chemin : on ne l'invente pas, sous
        /// peine de faire croire à une exécution depuis le répertoire courant.
        #[test]
        fn parse_ps_line_bsd_never_invents_a_path() {
            let p = parse_ps_line_with(
                "823 0.1 0.4 65536 3-02:05:30 _windowserver Google Chrome Helper",
                PsLayout::Bsd,
            )
            .unwrap();
            assert_eq!(p.name, "Google Chrome Helper");
            assert_eq!(p.exec_path, None);
        }

        /// La troncature BSD à 79 colonnes (aucun tty attaché) vide la colonne du
        /// nom : la ligne doit être rejetée, pas produire un processus anonyme.
        #[test]
        fn parse_ps_line_bsd_rejects_a_truncated_row() {
            assert!(
                parse_ps_line_with("823 0.1 0.4 65536 02:05:30 _windowserver", PsLayout::Bsd)
                    .is_none()
            );
        }
    }

    /// `PF_KTHREAD` est lu à un indice compté à la main dans une ligne dont le
    /// `comm` peut contenir espaces et parenthèses : c'est cet indice qu'on
    /// vérifie, sur le noyau vivant, où kthreadd (PID 2) porte le drapeau et
    /// l'appelant ne le porte pas.
    #[cfg(target_os = "linux")]
    #[test]
    fn parse_proc_stat_reads_the_kernel_thread_flag() {
        let users = HashMap::new();
        let read = |pid: u32| -> Option<RawProcess> {
            let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
            parse_proc_stat(pid, &stat, 1000.0, 1_000_000, &users)
        };

        let me = std::process::id();
        assert_eq!(
            read(me).and_then(|p| p.kernel),
            Some(false),
            "le processus de test vient du disque"
        );

        // kthreadd est le père de tous les fils du noyau, et existe partout.
        match read(2) {
            Some(p) => assert_eq!(p.kernel, Some(true), "kthreadd est un fil du noyau"),
            None => eprintln!("/proc/2/stat illisible — vérification sautée"),
        }
    }

    /// Un `comm` qui contient espaces et parenthèses décale tout ce qui suit si
    /// on coupe sur la mauvaise borne, et les drapeaux comme le temps CPU se
    /// liraient alors dans le champ du voisin.
    #[cfg(target_os = "linux")]
    #[test]
    fn parse_proc_stat_survives_a_comm_full_of_parentheses() {
        // Champs 1 et 2, puis state, ppid, pgrp, session, tty, tpgid, flags.
        let flags = 0x0020_0000u64 | 0x4000;
        let mut fields = vec![
            "7".to_string(),
            "((a b) c)".to_string(),
            "S".into(),
            "2".into(),
            "0".into(),
            "0".into(),
            "0".into(),
            "-1".into(),
            flags.to_string(),
        ];
        // Jusqu'au champ 24 (rss), les valeurs intermédiaires n'importent pas.
        while fields.len() < 24 {
            fields.push(match fields.len() + 1 {
                14 => "300".into(), // utime
                15 => "100".into(), // stime
                20 => "3".into(),   // threads
                22 => "0".into(),   // starttime
                24 => "10".into(),  // rss en pages
                _ => "0".into(),
            });
        }
        let stat = fields.join(" ");
        let p = parse_proc_stat(7, &stat, 4.0, 1000, &HashMap::new()).expect("ligne lisible");
        assert_eq!(
            p.name, "(a b) c",
            "le nom se coupe sur la dernière parenthèse"
        );
        assert_eq!(p.kernel, Some(true));
        assert_eq!(p.threads, Some(3), "le champ 20 n'a pas glissé");
        assert_eq!(p.cpu_percent, 100.0, "4 s de CPU sur 4 s de vie");
    }

    /// Attend que l'enfant ait vraiment remplacé son image mémoire. `spawn`
    /// rend la main dès que le noyau réveille le parent du `vfork`, ce qui
    /// arrive avant l'installation du nouveau `mm` : dans cette fenêtre,
    /// `/proc/<pid>/exe` désigne encore le binaire de test.
    #[cfg(target_os = "linux")]
    fn wait_for_exec(pid: u32, expected: &std::path::Path) {
        let want = expected.to_string_lossy().to_string();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if proc_exe(pid).0.as_deref() == Some(want.as_str()) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }

    /// Exécution depuis un répertoire temporaire, puis binaire effacé alors que
    /// le processus tourne. Vérifié pour de vrai : c'est le noyau qui pose le
    /// suffixe « (deleted) », une chaîne fabriquée ne prouverait rien.
    #[cfg(target_os = "linux")]
    #[test]
    fn proc_exe_reports_path_then_deletion() {
        use std::io::Write;

        let dir = std::env::temp_dir().join(format!("deveye-exe-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("kdevtmpfsi");

        // Un shell script ne convient pas : `/proc/<pid>/exe` pointerait vers
        // l'interpréteur. Il faut un vrai exécutable.
        let Ok(src) = std::fs::read("/bin/sleep") else {
            eprintln!("/bin/sleep absent — vérification sautée");
            return;
        };
        {
            let mut f = std::fs::File::create(&bin).unwrap();
            f.write_all(&src).unwrap();
        }
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();

        let mut child = match std::process::Command::new(&bin).arg("30").spawn() {
            Ok(c) => c,
            Err(e) => {
                // /tmp monté en `noexec` : c'est une machine correctement
                // durcie, pas un échec du code.
                eprintln!("exécution depuis /tmp refusée ({e}) — vérification sautée");
                std::fs::remove_dir_all(&dir).ok();
                return;
            }
        };
        let pid = child.id();
        wait_for_exec(pid, &bin);

        let (path, deleted) = proc_exe(pid);
        assert_eq!(
            path.as_deref(),
            Some(bin.to_string_lossy().as_ref()),
            "le chemin d'exécution est celui du répertoire temporaire"
        );
        assert_eq!(deleted, Some(false), "le binaire est encore sur le disque");

        // On efface pendant que le processus tourne : la forme même d'un implant
        // résident en mémoire.
        std::fs::remove_file(&bin).unwrap();
        let (path_after, deleted_after) = proc_exe(pid);
        assert_eq!(
            deleted_after,
            Some(true),
            "un binaire effacé sous un processus vivant est signalé"
        );
        assert_eq!(
            path_after.as_deref(),
            Some(bin.to_string_lossy().as_ref()),
            "le suffixe « (deleted) » est retiré du chemin, jamais laissé dedans"
        );

        child.kill().ok();
        child.wait().ok();
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Un binaire remplacé (ce que fait tout gestionnaire de paquets) ne doit
    /// pas être signalé comme supprimé.
    #[cfg(target_os = "linux")]
    #[test]
    fn proc_exe_does_not_flag_a_replaced_binary() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("deveye-repl-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("prog");
        let Ok(src) = std::fs::read("/bin/sleep") else {
            eprintln!("/bin/sleep absent — vérification sautée");
            return;
        };
        std::fs::File::create(&bin)
            .unwrap()
            .write_all(&src)
            .unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();

        let Ok(mut child) = std::process::Command::new(&bin).arg("30").spawn() else {
            eprintln!("exécution refusée depuis le répertoire temporaire — vérification sautée");
            std::fs::remove_dir_all(&dir).ok();
            return;
        };
        // Avant de renommer par-dessus, sinon l'enfant exécuterait le nouvel
        // inode et la substitution ne serait pas celle qu'on veut vérifier.
        wait_for_exec(child.id(), &bin);

        // Le geste d'un gestionnaire de paquets : écrire à côté puis renommer
        // par-dessus. L'ancien inode est délié, le chemin reste peuplé.
        let staged = dir.join("prog.new");
        std::fs::File::create(&staged)
            .unwrap()
            .write_all(&src)
            .unwrap();
        std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::rename(&staged, &bin).unwrap();

        let (path, deleted) = proc_exe(child.id());
        assert_eq!(
            path.as_deref(),
            Some(bin.to_string_lossy().as_ref()),
            "le chemin reste celui du binaire"
        );
        assert_eq!(
            deleted,
            Some(false),
            "un binaire remplacé n'est pas un binaire disparu"
        );

        child.kill().ok();
        child.wait().ok();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn aggregate_sums_instances_and_keeps_dominant_user() {
        let mut agg = Aggregate::default();
        for (pid, user) in [(1, "root"), (2, "gerem"), (3, "gerem")] {
            agg.absorb(
                &RawProcess {
                    pid,
                    name: "chrome".into(),
                    exec_path: Some("/opt/google/chrome/chrome".into()),
                    deleted: Some(false),
                    kernel: Some(false),
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
                exec_path: Some("/usr/sbin/nginx".into()),
                deleted: Some(false),
                kernel: Some(false),
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

    /// L'analyse de `sshd_config` quand `sshd -T` n'est pas joignable : la sonde
    /// ne doit jamais conclure sur ce qu'elle n'a pas déroulé.
    #[cfg(not(target_os = "windows"))]
    mod sshd_config {
        use super::*;
        use std::collections::BTreeMap;

        /// Un disque de mensonge : des chemins et leur contenu, rien de plus.
        struct FakeFs(BTreeMap<String, String>);

        impl FakeFs {
            fn new(files: &[(&str, &str)]) -> Self {
                Self(
                    files
                        .iter()
                        .map(|(p, c)| ((*p).to_string(), (*c).to_string()))
                        .collect(),
                )
            }
        }

        impl ConfigFs for FakeFs {
            fn read(&self, path: &str) -> Option<String> {
                self.0.get(path).cloned()
            }

            fn list(&self, dir: &str) -> Vec<String> {
                let prefix = format!("{dir}/");
                // La `BTreeMap` est déjà triée : c'est l'ordre lexicographique
                // que déroule OpenSSH, et il décide du vainqueur.
                self.0
                    .keys()
                    .filter(|p| p.starts_with(&prefix) && !p[prefix.len()..].contains('/'))
                    .cloned()
                    .collect()
            }
        }

        fn look(files: &[(&str, &str)]) -> Option<bool> {
            match ssh_config_scan(
                &FakeFs::new(files),
                "/etc/ssh/sshd_config",
                "permitrootlogin",
                0,
            ) {
                Scan::Value(v) => v,
                _ => None,
            }
        }

        #[test]
        fn lit_le_fichier_principal() {
            assert_eq!(
                look(&[("/etc/ssh/sshd_config", "PermitRootLogin yes\n")]),
                Some(true)
            );
        }

        #[test]
        fn prohibit_password_est_un_non() {
            assert_eq!(
                look(&[(
                    "/etc/ssh/sshd_config",
                    "PermitRootLogin prohibit-password\n"
                )]),
                Some(false)
            );
        }

        #[test]
        fn les_commentaires_ne_comptent_pas() {
            assert_eq!(
                look(&[("/etc/ssh/sshd_config", "#PermitRootLogin yes\n")]),
                None
            );
        }

        /// L'`Include` est en tête, donc le drop-in est obtenu en premier et
        /// l'emporte sur le `yes` resté plus bas dans le fichier principal.
        #[test]
        fn le_drop_in_inclus_en_tete_bat_le_fichier_principal() {
            assert_eq!(
                look(&[
                    (
                        "/etc/ssh/sshd_config",
                        "Include /etc/ssh/sshd_config.d/*.conf\nPermitRootLogin yes\n"
                    ),
                    (
                        "/etc/ssh/sshd_config.d/99-hardening.conf",
                        "PermitRootLogin no\n"
                    ),
                ]),
                Some(false)
            );
        }

        /// Symétrique : l'`Include` en queue ne peut plus rien changer.
        #[test]
        fn un_include_en_queue_ne_renverse_rien() {
            assert_eq!(
                look(&[
                    (
                        "/etc/ssh/sshd_config",
                        "PermitRootLogin yes\nInclude /etc/ssh/sshd_config.d/*.conf\n"
                    ),
                    (
                        "/etc/ssh/sshd_config.d/99-hardening.conf",
                        "PermitRootLogin no\n"
                    ),
                ]),
                Some(true)
            );
        }

        #[test]
        fn le_glob_se_deroule_dans_l_ordre_lexicographique() {
            assert_eq!(
                look(&[
                    (
                        "/etc/ssh/sshd_config",
                        "Include /etc/ssh/sshd_config.d/*.conf\n"
                    ),
                    (
                        "/etc/ssh/sshd_config.d/10-cloud.conf",
                        "PermitRootLogin no\n"
                    ),
                    (
                        "/etc/ssh/sshd_config.d/99-late.conf",
                        "PermitRootLogin yes\n"
                    ),
                ]),
                Some(false)
            );
        }

        #[test]
        fn le_glob_ignore_ce_qui_ne_correspond_pas() {
            assert_eq!(
                look(&[
                    (
                        "/etc/ssh/sshd_config",
                        "Include /etc/ssh/sshd_config.d/*.conf\n"
                    ),
                    (
                        "/etc/ssh/sshd_config.d/50-x.conf.bak",
                        "PermitRootLogin yes\n"
                    ),
                ]),
                None
            );
        }

        /// Un `Match` clôt la section globale : ce qui suit est conditionnel et
        /// ne décrit pas le cas général.
        #[test]
        fn ce_qui_suit_un_match_ne_compte_pas() {
            assert_eq!(
                look(&[(
                    "/etc/ssh/sshd_config",
                    "Match Address 10.0.0.0/8\nPermitRootLogin yes\n"
                )]),
                None
            );
        }

        /// L'état du parseur traverse les `Include` : un `Match` ouvert dans un
        /// fichier inclus vaut aussi pour la suite du fichier appelant.
        #[test]
        fn un_match_dans_un_include_clot_aussi_l_appelant() {
            assert_eq!(
                look(&[
                    (
                        "/etc/ssh/sshd_config",
                        "Include /etc/ssh/sshd_config.d/*.conf\nPermitRootLogin yes\n"
                    ),
                    (
                        "/etc/ssh/sshd_config.d/10-match.conf",
                        "Match User deploy\n"
                    ),
                ]),
                None
            );
        }

        #[test]
        fn un_include_illisible_fait_renoncer_plutot_que_conclure() {
            assert_eq!(
                look(&[(
                    "/etc/ssh/sshd_config",
                    "Include /etc/ssh/absent.conf\nPermitRootLogin yes\n"
                )]),
                None
            );
        }

        #[test]
        fn la_forme_avec_egal_est_comprise() {
            assert_eq!(
                look(&[("/etc/ssh/sshd_config", "PermitRootLogin=no\n")]),
                Some(false)
            );
        }

        #[test]
        fn une_valeur_inconnue_ne_se_devine_pas() {
            assert_eq!(
                look(&[("/etc/ssh/sshd_config", "PermitRootLogin maybe\n")]),
                None
            );
        }

        #[test]
        fn glob_match_couvre_etoile_et_point_interrogation() {
            assert!(glob_match("*.conf", "99-x.conf"));
            assert!(glob_match("*", "toto"));
            assert!(glob_match("5?-*.conf", "50-a.conf"));
            assert!(!glob_match("*.conf", "x.conf.bak"));
            assert!(!glob_match("5?-*.conf", "5-a.conf"));
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod proc_scan_tests {
    use super::*;

    /// Le lecteur `/proc` doit voir la même réalité que `ps`, à la course près
    /// (des processus naissent et meurent entre les deux relevés).
    #[test]
    fn proc_scan_agrees_with_ps() {
        let mine = scan_processes_proc();
        assert!(!mine.is_empty(), "/proc n'a rendu aucun processus");

        // `ps` n'est pas garanti présent : sans lui, rien à comparer.
        let Some(ps) = run(
            "ps",
            &["-eo", "pid=,pcpu=,pmem=,rss=,etimes=,nlwp=,user=,comm="],
        ) else {
            return;
        };
        let ps: Vec<RawProcess> = ps.lines().filter_map(parse_ps_line).collect();
        assert!(!ps.is_empty(), "ps n'a rendu aucun processus");

        // Les deux ensembles doivent très largement se recouvrir.
        let ps_pids: std::collections::HashSet<u32> = ps.iter().map(|p| p.pid).collect();
        let common = mine.iter().filter(|p| ps_pids.contains(&p.pid)).count();
        assert!(
            common * 10 >= ps.len() * 8,
            "recouvrement trop faible : {common} communs pour {} vus par ps",
            ps.len()
        );

        // Et sur un processus commun, les colonnes doivent concorder.
        let self_pid = std::process::id();
        if let (Some(a), Some(b)) = (
            mine.iter().find(|p| p.pid == self_pid),
            ps.iter().find(|p| p.pid == self_pid),
        ) {
            assert_eq!(a.name, b.name, "nom divergent");
            assert_eq!(a.user, b.user, "utilisateur divergent");
        }

        // Le RSS se compare sur pid 1, pas sur soi : les autres tests tournent
        // en parallèle dans ce processus et font bouger sa mémoire entre la
        // lecture de `/proc` et celle de `ps`.
        let stable = mine
            .iter()
            .find(|p| p.pid == 1)
            .zip(ps.iter().find(|b| b.pid == 1));
        if let Some((a, b)) = stable {
            let (ra, rb) = (a.rss_bytes as f64, b.rss_bytes as f64);
            assert!(
                (ra - rb).abs() <= rb.max(1.0) * 0.25,
                "RSS divergent sur pid 1 : /proc {ra} vs ps {rb}"
            );
        }
    }
}
