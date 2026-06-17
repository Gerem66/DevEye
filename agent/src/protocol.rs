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
}

/// Messages the server sends back to the agent.
#[derive(Debug, Deserialize)]
#[serde(tag = "command", content = "payload")]
pub enum ServerMessage {
    #[serde(rename = "agent.ack")]
    Ack { received: u32 },
    #[serde(rename = "agent.error")]
    Error { code: String, message: String },
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
