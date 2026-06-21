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
        report: DeviceReport,
    },
    #[serde(rename = "agent.processes")]
    Processes {
        #[serde(rename = "deviceId")]
        device_id: String,
        sample: ProcessSample,
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
}
