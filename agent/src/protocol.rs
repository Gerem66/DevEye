//! Wire types shared with the DevEye server.
//!
//! These mirror `@gerem66/deveye-types` (`protocol/agent.ts`, `domain/metrics.ts`
//! and the HTTP enrollment contract). Field names use the server's camelCase.

use serde::{Deserialize, Serialize};

/// A point-in-time metric sample. `timestamp` is unix milliseconds.
#[derive(Debug, Clone, Serialize)]
pub struct MetricSnapshot {
    pub timestamp: i64,
    #[serde(rename = "cpuPercent")]
    pub cpu_percent: f64,
    #[serde(rename = "memUsedBytes")]
    pub mem_used_bytes: u64,
    #[serde(rename = "memTotalBytes")]
    pub mem_total_bytes: u64,
    #[serde(rename = "diskUsedBytes")]
    pub disk_used_bytes: u64,
    #[serde(rename = "diskTotalBytes")]
    pub disk_total_bytes: u64,
    #[serde(rename = "netRxBytes")]
    pub net_rx_bytes: u64,
    #[serde(rename = "netTxBytes")]
    pub net_tx_bytes: u64,
    #[serde(rename = "usersCount")]
    pub users_count: u32,
    #[serde(rename = "loadAvg1")]
    pub load_avg_1: Option<f64>,
    #[serde(rename = "cpuTempC")]
    pub cpu_temp_c: Option<f64>,
    #[serde(rename = "uptimeSeconds")]
    pub uptime_seconds: Option<u64>,
    #[serde(rename = "processCount")]
    pub process_count: Option<u32>,
    #[serde(rename = "activeConnections")]
    pub active_connections: Option<u32>,
    #[serde(rename = "gpuPercent")]
    pub gpu_percent: Option<f64>,
    /// Cumulative disk bytes read; only the snapshot (heavy) cycle fills it.
    #[serde(rename = "diskReadBytes")]
    pub disk_read_bytes: Option<u64>,
    #[serde(rename = "diskWriteBytes")]
    pub disk_write_bytes: Option<u64>,
    /// Battery charge (%); None when the machine has no battery.
    #[serde(rename = "batteryPercent")]
    pub battery_percent: Option<f64>,
    /// Whether the battery is charging / on AC; None when unknown.
    #[serde(rename = "batteryCharging")]
    pub battery_charging: Option<bool>,
}

/// Latest-known health/security report (sent on connect, then periodically).
/// Mirrors `deveye-types` `domain/report.ts`. Security fields are nullable:
/// collectors are best-effort and may be unavailable on a given platform.
#[derive(Debug, Clone, Serialize)]
pub struct DeviceReport {
    #[serde(rename = "collectedAt")]
    pub collected_at: i64,
    pub os: OsInfo,
    pub security: Security,
    pub disks: Vec<ReportDisk>,
    /// How the agent itself runs (privilege level + account). Lets the UI explain
    /// why some best-effort probes are limited (e.g. not running as root).
    pub agent: AgentInfo,
    /// Listening sockets (TCP, plus UDP on Linux). Empty = none found; a legacy
    /// report that predates this field deserialises to `null` server-side.
    #[serde(rename = "openPorts")]
    pub open_ports: Vec<OpenPort>,
    /// Established TCP connections (the detail behind the `activeConnections`
    /// metric). Empty = none; a legacy report deserialises to `null` server-side.
    pub connections: Vec<TcpConnection>,
    /// Static hardware inventory (CPU, RAM, GPU, network, bluetooth). Slow-moving;
    /// a legacy report that predates this field deserialises to `null` server-side.
    pub hardware: DeviceHardware,
}

/// One established TCP connection: the local and remote socket. `activeConnections`
/// in the metric stream is just the count of these.
#[derive(Debug, Clone, Serialize)]
pub struct TcpConnection {
    #[serde(rename = "localAddress")]
    pub local_address: String,
    #[serde(rename = "localPort")]
    pub local_port: u16,
    #[serde(rename = "remoteAddress")]
    pub remote_address: String,
    #[serde(rename = "remotePort")]
    pub remote_port: u16,
}

/// Static hardware inventory of the host. Every list is best-effort and may be
/// empty; `bluetooth` is `None` when no adapter was detected.
#[derive(Debug, Clone, Serialize)]
pub struct DeviceHardware {
    pub cpu: CpuInfo,
    #[serde(rename = "memoryTotalBytes")]
    pub memory_total_bytes: u64,
    pub gpus: Vec<String>,
    pub network: Vec<NetInterface>,
    pub bluetooth: Option<String>,
}

/// Processor identity (best-effort, from `sysinfo`).
#[derive(Debug, Clone, Serialize)]
pub struct CpuInfo {
    /// Brand string, e.g. "Apple M1 Pro" / "Intel(R) Core(TM) i7-1185G7".
    pub model: String,
    /// Vendor id (`GenuineIntel`, `AuthenticAMD`, …); None when unknown.
    pub vendor: Option<String>,
    /// Physical cores; None when the OS can't report them.
    #[serde(rename = "physicalCores")]
    pub physical_cores: Option<u32>,
    /// Logical cores (threads).
    #[serde(rename = "logicalCores")]
    pub logical_cores: u32,
    /// Nominal/base frequency in MHz; None when unknown.
    #[serde(rename = "frequencyMhz")]
    pub frequency_mhz: Option<u64>,
}

/// One network interface: name + hardware address + an inferred class.
#[derive(Debug, Clone, Serialize)]
pub struct NetInterface {
    pub name: String,
    /// One of: wifi, ethernet, bluetooth, loopback, virtual, other.
    pub kind: &'static str,
    pub mac: Option<String>,
}

/// The agent's own runtime identity, used by the UI to flag privilege-gated gaps.
#[derive(Debug, Clone, Serialize)]
pub struct AgentInfo {
    /// `true` when running as root (Unix euid 0) / elevated (Windows).
    pub privileged: bool,
    /// The OS account the agent runs as (e.g. `root`, `deploy`).
    pub user: String,
    /// Installed persistence scope: `none` | `user` | `system`.
    #[serde(rename = "serviceScope")]
    pub service_scope: &'static str,
    /// `true` when launched under a service manager (so a self-update just exits).
    pub managed: bool,
}

/// One detected package manager + its pending state (mirrors deveye-types
/// `packageManagerSchema`).
#[derive(Debug, Clone, Serialize)]
pub struct PackageManagerInfo {
    pub id: &'static str,
    #[serde(rename = "pendingCount")]
    pub pending_count: Option<u32>,
    #[serde(rename = "needsRoot")]
    pub needs_root: bool,
    #[serde(rename = "rebootRequired")]
    pub reboot_required: bool,
}

/// One listening socket. `address` is the bind address (e.g. `0.0.0.0`, `::`,
/// `127.0.0.1`) so the UI can tell world-exposed ports from loopback-only ones.
#[derive(Debug, Clone, Serialize)]
pub struct OpenPort {
    pub proto: &'static str,
    pub port: u16,
    pub address: String,
}

/// One mounted disk/volume (per-disk breakdown for multi-disk machines).
#[derive(Debug, Clone, Serialize)]
pub struct ReportDisk {
    pub mount: String,
    #[serde(rename = "usedBytes")]
    pub used_bytes: u64,
    #[serde(rename = "totalBytes")]
    pub total_bytes: u64,
}

/// One queryable log source on the host (mirrors deveye-types `deviceLogSourceSchema`).
#[derive(Debug, Clone, Serialize)]
pub struct LogSource {
    /// Opaque token the agent resolves back to a reader (`journald`, `docker:<id>`,
    /// `file:<path>`, `oslog`, `eventlog:<channel>`).
    pub id: String,
    /// One of: journald, docker, syslog, oslog, eventlog.
    pub kind: &'static str,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub running: Option<bool>,
}

/// One normalised log line (mirrors deveye-types `deviceLogLineSchema`). `ts` is
/// unix milliseconds; both `ts` and `level` are nullable (sent as `null`).
#[derive(Debug, Clone, Serialize)]
pub struct LogLine {
    pub ts: Option<i64>,
    pub level: Option<&'static str>,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
}

/// Advanced log-query filter as the server sends it (mirrors `deviceLogFilterSchema`).
#[derive(Debug, Default, Clone, Deserialize)]
pub struct LogFilter {
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub regex: Option<bool>,
    #[serde(rename = "levelMin", default)]
    pub level_min: Option<String>,
    #[serde(default)]
    pub unit: Option<String>,
    /// Window start, unix epoch seconds.
    #[serde(default)]
    pub since: Option<i64>,
    /// Window end, unix epoch seconds.
    #[serde(default)]
    pub until: Option<i64>,
}

/// One directory entry (mirrors deveye-types `fileEntrySchema`). `size` is the
/// entry's own size; recursive sizes come from the separate usage analysis.
#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    pub name: String,
    /// One of: file, dir, symlink, other.
    pub kind: &'static str,
    pub size: u64,
    /// Last-modified, unix milliseconds (null when unavailable).
    pub mtime: Option<i64>,
    /// Unix permission bits for display; null on platforms without them.
    pub mode: Option<u32>,
    #[serde(rename = "symlinkTarget", skip_serializing_if = "Option::is_none")]
    pub symlink_target: Option<String>,
}

/// A directory listing (mirrors `fileListingSchema`).
#[derive(Debug, Clone, Serialize)]
pub struct FileListing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<FileEntry>,
}

/// One child's recursive size (mirrors `fileUsageEntrySchema`).
#[derive(Debug, Clone, Serialize)]
pub struct FileUsageEntry {
    pub name: String,
    pub kind: &'static str,
    #[serde(rename = "totalSize")]
    pub total_size: u64,
    pub partial: bool,
}

/// One search hit (mirrors `fileMatchSchema`).
#[derive(Debug, Clone, Serialize)]
pub struct FileMatch {
    pub path: String,
    pub name: String,
    pub kind: &'static str,
    pub size: u64,
    pub mtime: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
}

/// Advanced file-search filter as the server sends it (mirrors `fileSearchFilterSchema`).
#[derive(Debug, Default, Clone, Deserialize)]
pub struct FileSearchFilter {
    #[serde(default)]
    pub query: Option<String>,
    /// `name` (default) | `extension` | `content`.
    #[serde(default)]
    pub field: Option<String>,
    #[serde(default)]
    pub regex: Option<bool>,
    /// mtime window, unix epoch seconds.
    #[serde(default)]
    pub since: Option<i64>,
    #[serde(default)]
    pub until: Option<i64>,
    #[serde(rename = "minSize", default)]
    pub min_size: Option<u64>,
    #[serde(rename = "maxSize", default)]
    pub max_size: Option<u64>,
}

/// A point-in-time process list. `kind` is "top" (heaviest ~20) or "all".
#[derive(Debug, Clone, Serialize)]
pub struct ProcessSample {
    pub ts: i64,
    pub kind: &'static str,
    pub processes: Vec<ProcessInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OsInfo {
    pub name: String,
    pub version: String,
    pub arch: String,
    pub cores: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct Security {
    pub firewall: Option<bool>,
    #[serde(rename = "diskEncryption")]
    pub disk_encryption: Option<bool>,
    pub sip: Option<bool>,
    #[serde(rename = "pendingUpdates")]
    pub pending_updates: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProcessInfo {
    pub name: String,
    #[serde(rename = "cpuPercent")]
    pub cpu_percent: f64,
    #[serde(rename = "memBytes")]
    pub mem_bytes: u64,
}

/// Messages the agent sends to the server over the `/agent` WebSocket.
#[derive(Debug, Serialize)]
#[serde(tag = "command", content = "payload")]
pub enum ClientMessage {
    #[serde(rename = "agent.hello")]
    Hello {
        #[serde(rename = "agentVersion")]
        agent_version: String,
        /// Build target id (e.g. `linux-x86_64`); omitted when unknown. Lets the
        /// server resolve which binary to push for a self-update.
        #[serde(skip_serializing_if = "Option::is_none")]
        target: Option<String>,
    },
    #[serde(rename = "metrics.batch")]
    MetricsBatch {
        #[serde(rename = "deviceId")]
        device_id: String,
        snapshots: Vec<MetricSnapshot>,
    },
    #[serde(rename = "agent.report")]
    Report {
        #[serde(rename = "deviceId")]
        device_id: String,
        // Boxed: the report is by far the largest variant; boxing keeps the enum
        // small (clippy::large_enum_variant) without changing the wire shape.
        report: Box<DeviceReport>,
    },
    #[serde(rename = "agent.processes")]
    Processes {
        #[serde(rename = "deviceId")]
        device_id: String,
        sample: ProcessSample,
    },
    /// Outcome of an `agent.destroy`: whether the agent wiped itself successfully.
    #[serde(rename = "agent.destroyed")]
    Destroyed {
        #[serde(rename = "deviceId")]
        device_id: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// Outcome of an `agent.update`: whether the new binary verified and swapped in.
    #[serde(rename = "agent.updated")]
    Updated {
        #[serde(rename = "deviceId")]
        device_id: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        version: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// Outcome of an `agent.service` persistence/privilege change.
    #[serde(rename = "agent.serviceResult")]
    ServiceResult {
        #[serde(rename = "deviceId")]
        device_id: String,
        action: String,
        ok: bool,
        #[serde(rename = "needsManualCommand", skip_serializing_if = "Option::is_none")]
        needs_manual_command: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// Outcome of an `agent.power` system power action (shutdown/reboot/suspend…).
    #[serde(rename = "agent.powerResult")]
    PowerResult {
        #[serde(rename = "deviceId")]
        device_id: String,
        action: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// Reply to `log.sources`: the log sources discovered on the host.
    #[serde(rename = "log.sourcesResult")]
    LogSourcesResult {
        #[serde(rename = "deviceId")]
        device_id: String,
        sources: Vec<LogSource>,
    },
    /// Reply to `log.query`: one chunk of matched log lines (last one `done: true`).
    #[serde(rename = "log.lines")]
    LogLines {
        #[serde(rename = "deviceId")]
        device_id: String,
        #[serde(rename = "queryId")]
        query_id: String,
        lines: Vec<LogLine>,
        done: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// A chunk of PTY output for a terminal session (`data` is base64 of raw bytes).
    #[serde(rename = "term.output")]
    TermOutput {
        #[serde(rename = "deviceId")]
        device_id: String,
        #[serde(rename = "sessionId")]
        session_id: String,
        data: String,
    },
    /// A terminal session ended (shell exited, killed, or open failed).
    #[serde(rename = "term.exit")]
    TermExit {
        #[serde(rename = "deviceId")]
        device_id: String,
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<i32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// A directory listing (reply to `files.list`).
    #[serde(rename = "files.listing")]
    FilesListing {
        #[serde(rename = "deviceId")]
        device_id: String,
        #[serde(rename = "opId")]
        op_id: String,
        listing: Option<FileListing>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// Recursive usage of a directory's children (reply to `files.analyze`).
    #[serde(rename = "files.usage")]
    FilesUsage {
        #[serde(rename = "deviceId")]
        device_id: String,
        #[serde(rename = "opId")]
        op_id: String,
        entries: Vec<FileUsageEntry>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// Search hits (reply to `files.search`).
    #[serde(rename = "files.matches")]
    FilesMatches {
        #[serde(rename = "deviceId")]
        device_id: String,
        #[serde(rename = "opId")]
        op_id: String,
        matches: Vec<FileMatch>,
        truncated: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// Outcome of a `files.mutate` (delete/mkdir/rename).
    #[serde(rename = "files.opResult")]
    FilesOpResult {
        #[serde(rename = "deviceId")]
        device_id: String,
        #[serde(rename = "opId")]
        op_id: String,
        op: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// Reply to `pkg.list`: the package managers present + their pending counts.
    #[serde(rename = "pkg.listResult")]
    PkgListResult {
        #[serde(rename = "deviceId")]
        device_id: String,
        managers: Vec<PackageManagerInfo>,
    },
    /// One live output line of an in-progress `pkg.upgrade`.
    #[serde(rename = "pkg.progress")]
    PkgProgress {
        #[serde(rename = "deviceId")]
        device_id: String,
        manager: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        percent: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        phase: Option<String>,
        line: String,
    },
    /// Final outcome of a `pkg.upgrade`.
    #[serde(rename = "pkg.done")]
    PkgDone {
        #[serde(rename = "deviceId")]
        device_id: String,
        manager: String,
        ok: bool,
        #[serde(rename = "rebootRequired", skip_serializing_if = "Option::is_none")]
        reboot_required: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
}

/// Messages the server sends back to the agent.
#[derive(Debug, Deserialize)]
#[serde(tag = "command", content = "payload")]
pub enum ServerMessage {
    #[serde(rename = "agent.ack")]
    Ack { received: u32 },
    #[serde(rename = "agent.error")]
    Error { code: String, message: String },
    /// Push a fresh sample + report immediately (user clicked "refresh").
    #[serde(rename = "agent.collect")]
    Collect {},
    /// Self-destruct: wipe local config + binary and exit (device being deleted).
    #[serde(rename = "agent.destroy")]
    Destroy {},
    /// Self-update: download, verify (sha256 + ed25519 signature) and swap in a
    /// newer binary for `target_id`, then restart.
    #[serde(rename = "agent.update")]
    Update {
        #[serde(rename = "targetId")]
        target_id: String,
        version: String,
        sha256: String,
        signature: String,
    },
    /// Persistence/privilege change: `action` is one of `install-user` |
    /// `uninstall-user` | `elevate` | `drop`.
    #[serde(rename = "agent.service")]
    Service { action: String },
    /// System power action: `action` is one of `shutdown` | `reboot` | `suspend` |
    /// `hibernate` | `lock`. The agent applies it best-effort and replies
    /// `agent.powerResult`.
    #[serde(rename = "agent.power")]
    Power { action: String },
    /// Enumerate the host's log sources (replies `log.sourcesResult`).
    #[serde(rename = "log.sources")]
    LogSources {},
    /// Run one log query; streams `log.lines` back, the last with `done: true`.
    #[serde(rename = "log.query")]
    LogQuery {
        #[serde(rename = "queryId")]
        query_id: String,
        #[serde(rename = "sourceId")]
        source_id: String,
        #[serde(default)]
        filter: Option<LogFilter>,
        #[serde(default)]
        limit: Option<u32>,
    },
    /// Open an interactive PTY session running the agent user's shell.
    #[serde(rename = "term.open")]
    TermOpen {
        #[serde(rename = "sessionId")]
        session_id: String,
        cols: u16,
        rows: u16,
    },
    /// Write input bytes (base64) to a session's PTY.
    #[serde(rename = "term.input")]
    TermInput {
        #[serde(rename = "sessionId")]
        session_id: String,
        data: String,
    },
    /// Resize a session's PTY.
    #[serde(rename = "term.resize")]
    TermResize {
        #[serde(rename = "sessionId")]
        session_id: String,
        cols: u16,
        rows: u16,
    },
    /// Close a session (kill the shell, free the PTY).
    #[serde(rename = "term.close")]
    TermClose {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    /// List a directory (replies `files.listing`).
    #[serde(rename = "files.list")]
    FilesList {
        #[serde(rename = "opId")]
        op_id: String,
        path: String,
    },
    /// Analyse a directory's recursive usage (replies `files.usage`).
    #[serde(rename = "files.analyze")]
    FilesAnalyze {
        #[serde(rename = "opId")]
        op_id: String,
        path: String,
    },
    /// Recursively search a directory (replies `files.matches`).
    #[serde(rename = "files.search")]
    FilesSearch {
        #[serde(rename = "opId")]
        op_id: String,
        path: String,
        filter: FileSearchFilter,
    },
    /// Mutate the filesystem: delete / mkdir / rename (replies `files.opResult`).
    #[serde(rename = "files.mutate")]
    FilesMutate {
        #[serde(rename = "opId")]
        op_id: String,
        op: String,
        path: String,
        #[serde(default)]
        dest: Option<String>,
    },
    /// Enumerate package managers + pending updates (replies `pkg.listResult`).
    #[serde(rename = "pkg.list")]
    PkgList {},
    /// Apply all updates of one manager, streaming `pkg.progress` then `pkg.done`.
    #[serde(rename = "pkg.upgrade")]
    PkgUpgrade { manager: String },
    /// Per-device collection config (cadences + capture mode), pushed by the
    /// server on connect and whenever the user changes it in the UI.
    #[serde(rename = "agent.config")]
    Config {
        #[serde(rename = "metricIntervalMs")]
        metric_interval_ms: u64,
        #[serde(rename = "snapshotIntervalMs")]
        snapshot_interval_ms: u64,
        #[serde(rename = "processCapture")]
        process_capture: String,
    },
}

/// Standard server result envelope: `{ ok, data? , error? }`.
#[derive(Debug, Deserialize)]
pub struct ApiResult<T> {
    pub ok: bool,
    #[serde(default)]
    pub data: Option<T>,
    #[serde(default)]
    pub error: Option<ApiError>,
}

#[derive(Debug, Default, Deserialize)]
pub struct ApiError {
    pub code: String,
    pub message: String,
}

/// POST /api/agent/enroll request body.
#[derive(Debug, Serialize)]
pub struct EnrollRequest {
    pub code: String,
    pub name: String,
    pub fingerprint: String,
    pub platform: String,
    #[serde(rename = "publicKey")]
    pub public_key: String,
}

/// POST /api/agent/enroll response payload.
#[derive(Debug, Default, Deserialize)]
pub struct EnrollData {
    #[serde(rename = "deviceId")]
    pub device_id: String,
    #[serde(rename = "deviceToken")]
    pub device_token: String,
    /// The enrolled device, so the agent can report the real status (a code with
    /// auto-approval lands the device directly as `active`, not `pending`).
    #[serde(default)]
    pub device: Option<EnrolledDevice>,
}

#[derive(Debug, Default, Deserialize)]
pub struct EnrolledDevice {
    #[serde(default)]
    pub status: String,
}
