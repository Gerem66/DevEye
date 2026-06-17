//! Persistent agent configuration (TOML).
//!
//! Stores the server endpoint, this machine's stable identity (fingerprint +
//! signing keypair) and, once enrolled, the device id and long-lived token.
//! The file lives at `$DEVEYE_CONFIG` or `<config-dir>/deveye/agent.toml`.

use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// HTTP base URL of the DevEye server, e.g. `https://deveye.example.com`.
    pub server: String,
    /// Human-friendly device name (defaults to the hostname).
    pub name: String,
    /// Stable machine fingerprint (machine-id based).
    pub fingerprint: String,
    /// Base64 Ed25519 secret seed (32 bytes) for future command signing.
    pub secret_key: String,
    /// Base64 Ed25519 public key, registered with the server at enrollment.
    pub public_key: String,
    /// Server-assigned device id (set after enrollment).
    #[serde(default)]
    pub device_id: Option<String>,
    /// Long-lived device token (set after enrollment).
    #[serde(default)]
    pub device_token: Option<String>,
}

impl Config {
    pub fn path() -> PathBuf {
        if let Ok(p) = std::env::var("DEVEYE_CONFIG") {
            return PathBuf::from(p);
        }
        dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("deveye")
            .join("agent.toml")
    }

    pub fn load() -> Result<Self> {
        let path = Self::path();
        let raw = std::fs::read_to_string(&path)
            .with_context(|| format!("reading config at {}", path.display()))?;
        let cfg: Config = toml::from_str(&raw).context("parsing agent.toml")?;
        Ok(cfg)
    }

    pub fn exists() -> bool {
        Self::path().exists()
    }

    pub fn save(&self) -> Result<()> {
        let path = Self::path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating config dir {}", parent.display()))?;
        }
        let toml = toml::to_string_pretty(self).context("serializing config")?;
        std::fs::write(&path, toml).with_context(|| format!("writing {}", path.display()))?;
        // Tighten permissions: the file holds a device token.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }

    pub fn ws_url(&self) -> Result<String> {
        let token = self
            .device_token
            .as_ref()
            .context("device token missing; run `deveye-agent link <code>` first")?;
        let base = self.server.trim_end_matches('/');
        let ws_base = if let Some(rest) = base.strip_prefix("https://") {
            format!("wss://{rest}")
        } else if let Some(rest) = base.strip_prefix("http://") {
            format!("ws://{rest}")
        } else {
            anyhow::bail!("server URL must start with http:// or https://");
        };
        Ok(format!("{ws_base}/agent?token={token}"))
    }
}
