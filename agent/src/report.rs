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

use sysinfo::{Networks, System};

use crate::protocol::{
    AgentInfo, CpuInfo, DeviceHardware, DeviceReport, NetInterface, OpenPort, OsInfo, ProcessInfo,
    Security, TcpConnection,
};

/// OS + security posture (latest known). Processes are collected separately
/// (see `top_processes`) so they can be historised.
pub fn collect() -> DeviceReport {
    DeviceReport {
        collected_at: now_millis(),
        os: os_info(),
        security: security(),
        disks: crate::metrics::read_disks(),
        agent: agent_info(),
        open_ports: read_open_ports(),
        connections: read_connections(),
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
fn is_privileged() -> bool {
    // Effective uid 0 ⇒ root. Shelling out keeps us libc-free (matches the rest).
    run("id", &["-u"]).map(|s| s.trim() == "0").unwrap_or(false)
}

#[cfg(windows)]
fn is_privileged() -> bool {
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
/// On Unix we shell out to `ps` rather than use `sysinfo`: its per-process CPU
/// reads 0 on macOS (a known limitation), whereas `ps` reports a real value on
/// both Unixes. `%cpu` is the kernel's recent (decaying-average) utilisation and
/// can exceed 100% across cores; `%mem` is RSS as a fraction of physical memory.
/// Windows has no `ps`, so there we use `sysinfo` (whose per-process CPU *is*
/// accurate on Windows) — see `aggregate_processes`.
pub fn collect_processes(capture: &str) -> Vec<ProcessInfo> {
    if capture == "off" {
        return Vec::new();
    }

    // Per-program aggregate: (summed cpu%, summed mem%, summed rss bytes).
    let agg = aggregate_processes();

    // Score on cpu% + mem% (the two signals available everywhere).
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

/// Aggregate processes by program name into `(summed cpu%, summed mem%, summed
/// rss bytes)`. Unix parses `ps`; Windows reads `sysinfo`.
#[cfg(not(target_os = "windows"))]
fn aggregate_processes() -> HashMap<String, (f64, f64, u64)> {
    // macOS uses `ucomm` (short accounting name); Linux uses `comm`.
    #[cfg(target_os = "macos")]
    let args: [&str; 2] = ["-Ao", "pcpu=,pmem=,rss=,ucomm="];
    #[cfg(not(target_os = "macos"))]
    let args: [&str; 2] = ["-eo", "pcpu=,pmem=,rss=,comm="];

    let mut agg: HashMap<String, (f64, f64, u64)> = HashMap::new();
    let out = match run("ps", &args) {
        Some(o) => o,
        None => return agg,
    };
    for line in out.lines() {
        if let Some((name, cpu, mem_pct, rss)) = parse_ps_line(line) {
            let e = agg.entry(name).or_insert((0.0, 0.0, 0));
            e.0 += cpu;
            e.1 += mem_pct;
            e.2 = e.2.saturating_add(rss);
        }
    }
    agg
}

/// Windows aggregate via `sysinfo`. Two refreshes spaced apart yield a real
/// per-process CPU delta; memory is the working set, expressed as a % of total.
#[cfg(target_os = "windows")]
fn aggregate_processes() -> HashMap<String, (f64, f64, u64)> {
    use sysinfo::ProcessesToUpdate;
    let mut sys = System::new();
    sys.refresh_memory(); // `new()` leaves totals at 0 until refreshed
    sys.refresh_processes(ProcessesToUpdate::All, true);
    std::thread::sleep(std::time::Duration::from_millis(300));
    sys.refresh_processes(ProcessesToUpdate::All, true);
    let total_mem = sys.total_memory().max(1) as f64;
    let mut agg: HashMap<String, (f64, f64, u64)> = HashMap::new();
    for proc in sys.processes().values() {
        let name = proc.name().to_string_lossy().to_string();
        if name.is_empty() {
            continue;
        }
        let cpu = proc.cpu_usage() as f64;
        let rss = proc.memory();
        let mem_pct = (rss as f64 / total_mem) * 100.0;
        let e = agg.entry(name).or_insert((0.0, 0.0, 0));
        e.0 += cpu;
        e.1 += mem_pct;
        e.2 = e.2.saturating_add(rss);
    }
    agg
}

/// Parse a `ps` line `<%cpu> <%mem> <rss_kb> <command…>` into
/// `(name, cpu%, mem%, rss_bytes)`.
#[cfg(not(target_os = "windows"))]
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

/// Hard cap on reported listening ports.
const OPEN_PORTS_LIMIT: usize = 500;

/// Listening sockets, best-effort. Linux parses `ss` (TCP + UDP); macOS & Windows
/// parse `netstat` (TCP listeners + Windows UDP). Listing *which* ports listen
/// needs no privileges — only the owning process would. Deduped, sorted, capped.
fn read_open_ports() -> Vec<OpenPort> {
    let mut ports = collect_open_ports();
    ports.sort_by(|a, b| {
        a.port
            .cmp(&b.port)
            .then(a.proto.cmp(b.proto))
            .then_with(|| a.address.cmp(&b.address))
    });
    ports.dedup_by(|a, b| a.port == b.port && a.proto == b.proto && a.address == b.address);
    ports.truncate(OPEN_PORTS_LIMIT);
    ports
}

/// Normalise a bind host: drop IPv6 brackets and any `%zone` suffix.
#[allow(dead_code)]
fn clean_addr(host: &str) -> String {
    let h = host.trim_start_matches('[').trim_end_matches(']');
    match h.split_once('%') {
        Some((a, _)) => a.to_string(),
        None => h.to_string(),
    }
}

/// Split `host:port` from the right (handles `0.0.0.0:22`, `[::]:22`).
#[allow(dead_code)]
fn split_host_port(s: &str) -> Option<(String, u16)> {
    let (host, port) = s.rsplit_once(':')?;
    Some((clean_addr(host), port.parse().ok()?))
}

/// Split `host.port` from the right — BSD `netstat` uses `.` before the port
/// (`*.22`, `127.0.0.1.631`, `::1.631`).
#[allow(dead_code)]
fn split_host_dot_port(s: &str) -> Option<(String, u16)> {
    let (host, port) = s.rsplit_once('.')?;
    Some((clean_addr(host), port.parse().ok()?))
}

#[cfg(target_os = "linux")]
fn collect_open_ports() -> Vec<OpenPort> {
    // -t TCP, -u UDP, -l listening, -n numeric, -H no header.
    let out = match run("ss", &["-tulnH"]) {
        Some(o) => o,
        None => return Vec::new(),
    };
    let mut v = Vec::new();
    for line in out.lines() {
        // Netid State Recv-Q Send-Q Local:Port Peer:Port …
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 5 {
            continue;
        }
        let proto = match cols[0] {
            "tcp" => "tcp",
            "udp" => "udp",
            _ => continue,
        };
        if let Some((address, port)) = split_host_port(cols[4]) {
            v.push(OpenPort {
                proto,
                port,
                address,
            });
        }
    }
    v
}

#[cfg(target_os = "macos")]
fn collect_open_ports() -> Vec<OpenPort> {
    let out = match run("netstat", &["-an", "-p", "tcp"]) {
        Some(o) => o,
        None => return Vec::new(),
    };
    let mut v = Vec::new();
    for line in out.lines() {
        if !line.contains("LISTEN") {
            continue;
        }
        let cols: Vec<&str> = line.split_whitespace().collect();
        // Proto Recv-Q Send-Q Local-Address Foreign-Address (state) …
        if cols.len() < 4 || !cols[0].starts_with("tcp") {
            continue;
        }
        if let Some((address, port)) = split_host_dot_port(cols[3]) {
            v.push(OpenPort {
                proto: "tcp",
                port,
                address,
            });
        }
    }
    v
}

#[cfg(target_os = "windows")]
fn collect_open_ports() -> Vec<OpenPort> {
    let out = match run("netstat", &["-an"]) {
        Some(o) => o,
        None => return Vec::new(),
    };
    let mut v = Vec::new();
    for line in out.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 2 {
            continue;
        }
        let proto = match cols[0] {
            "TCP" => "tcp",
            "UDP" => "udp",
            _ => continue,
        };
        // TCP listeners end in a LISTENING state column; UDP rows have no state.
        if proto == "tcp" && cols.last().map(|s| *s != "LISTENING").unwrap_or(true) {
            continue;
        }
        if let Some((address, port)) = split_host_port(cols[1]) {
            v.push(OpenPort {
                proto,
                port,
                address,
            });
        }
    }
    v
}

/// Fallback for any other target: no portable probe.
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn collect_open_ports() -> Vec<OpenPort> {
    Vec::new()
}

/// Hard cap on reported connections (mirrors the listening-ports cap).
const CONNECTIONS_LIMIT: usize = 500;

/// Established TCP connections — the per-connection detail behind the
/// `activeConnections` count. Same best-effort tools as the count (`ss` on Linux,
/// `netstat` on macOS/Windows); each kept entry is one ESTABLISHED socket with
/// its local and remote endpoint. Sorted by remote endpoint, then local port,
/// and capped.
fn read_connections() -> Vec<TcpConnection> {
    let mut conns = collect_connections();
    conns.sort_by(|a, b| {
        a.remote_address
            .cmp(&b.remote_address)
            .then(a.remote_port.cmp(&b.remote_port))
            .then(a.local_port.cmp(&b.local_port))
    });
    conns.truncate(CONNECTIONS_LIMIT);
    conns
}

#[cfg(target_os = "linux")]
fn collect_connections() -> Vec<TcpConnection> {
    // -t TCP, -n numeric, filtered to established (no -l: those are listeners).
    let out = match run("ss", &["-tn", "state", "established"]) {
        Some(o) => o,
        None => return Vec::new(),
    };
    let mut v = Vec::new();
    for line in out.lines() {
        // Recv-Q Send-Q Local:Port Peer:Port [Process]. A header line, if any,
        // fails to parse as host:port and is skipped naturally.
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 4 {
            continue;
        }
        if let (Some((la, lp)), Some((ra, rp))) =
            (split_host_port(cols[2]), split_host_port(cols[3]))
        {
            v.push(TcpConnection {
                local_address: la,
                local_port: lp,
                remote_address: ra,
                remote_port: rp,
            });
        }
    }
    v
}

#[cfg(target_os = "macos")]
fn collect_connections() -> Vec<TcpConnection> {
    let out = match run("netstat", &["-an", "-p", "tcp"]) {
        Some(o) => o,
        None => return Vec::new(),
    };
    let mut v = Vec::new();
    for line in out.lines() {
        if !line.contains("ESTABLISHED") {
            continue;
        }
        // Proto Recv-Q Send-Q Local-Address Foreign-Address (state).
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 5 {
            continue;
        }
        if let (Some((la, lp)), Some((ra, rp))) =
            (split_host_dot_port(cols[3]), split_host_dot_port(cols[4]))
        {
            v.push(TcpConnection {
                local_address: la,
                local_port: lp,
                remote_address: ra,
                remote_port: rp,
            });
        }
    }
    v
}

#[cfg(target_os = "windows")]
fn collect_connections() -> Vec<TcpConnection> {
    let out = match run("netstat", &["-an"]) {
        Some(o) => o,
        None => return Vec::new(),
    };
    let mut v = Vec::new();
    for line in out.lines() {
        if !line.contains("ESTABLISHED") {
            continue;
        }
        // Proto Local-Address Foreign-Address State.
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 4 || cols[0] != "TCP" {
            continue;
        }
        if let (Some((la, lp)), Some((ra, rp))) =
            (split_host_port(cols[1]), split_host_port(cols[2]))
        {
            v.push(TcpConnection {
                local_address: la,
                local_port: lp,
                remote_address: ra,
                remote_port: rp,
            });
        }
    }
    v
}

/// Fallback for any other target: no portable probe.
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn collect_connections() -> Vec<TcpConnection> {
    Vec::new()
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
