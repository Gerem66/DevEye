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
    /// Static hardware inventory (CPU, RAM, GPU, network, bluetooth). Slow-moving;
    /// a legacy report that predates this field deserialises to `null` server-side.
    pub hardware: DeviceHardware,
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
