//! Persistent agent configuration (TOML).
//!
//! Stores the server endpoint, this machine's stable identity (fingerprint +
//! signing keypair) and, once enrolled, the device id and long-lived token.
//! The file lives at `$DEVEYE_CONFIG` or `<config-dir>/deveye/agent.toml`.

use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// Nom du fichier de config, quand rien ne l'impose via `DEVEYE_CONFIG`.
pub const CONFIG_FILE: &str = "agent.toml";
/// Les fichiers que l'agent pose à côté de sa config. Nommés ici parce que le
/// retrait (`uninstall`) doit les balayer dans un dossier qui n'est pas
/// forcément le sien (celui de l'utilisateur derrière un `sudo`), où
/// `Config::pid_path()` et consorts ne pointent pas.
pub const SIBLING_FILES: [&str; 3] = ["agent.pid", "agent.log", "agent.state"];
/// Encadrement du nom d'un cache de scan CloudSync : `sync-<shareId>.index.json`.
/// Un partage par fichier, donc un balayage par motif et non par nom.
pub const SYNC_INDEX_PREFIX: &str = "sync-";
pub const SYNC_INDEX_SUFFIX: &str = ".index.json";

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
            .join(CONFIG_FILE)
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

    /// PID file for a backgrounded `run --detach`, alongside the config.
    pub fn pid_path() -> PathBuf {
        Self::sibling(SIBLING_FILES[0])
    }

    /// Log file used when running detached.
    pub fn log_path() -> PathBuf {
        Self::sibling(SIBLING_FILES[1])
    }

    /// Runtime-state file the running agent records (pid + the account it runs as),
    /// so out-of-process commands like `status` report *its* facts. Alongside config.
    pub fn state_path() -> PathBuf {
        Self::sibling(SIBLING_FILES[2])
    }

    /// CloudSync per-share scan cache (relPath → size/mtime/hash), so unchanged
    /// files aren't rehashed on every scan. Alongside config.
    pub fn sync_index_path(share_id: i64) -> PathBuf {
        Self::sibling(&format!("{SYNC_INDEX_PREFIX}{share_id}{SYNC_INDEX_SUFFIX}"))
    }

    fn sibling(name: &str) -> PathBuf {
        Self::path()
            .parent()
            .map(|p| p.join(name))
            .unwrap_or_else(|| PathBuf::from(name))
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

    /// Wipe every local trace of this agent: the config (which holds the device
    /// token), the PID, log and state files, and best-effort the executable.
    ///
    /// Only the config removal is mandatory: on failure the error is returned so
    /// the server aborts the deletion. On Unix a running process can unlink its
    /// own binary (the inode lives until exit); Windows locks a running
    /// executable, so the binary is left in place there.
    pub fn self_destruct() -> Result<()> {
        let config = Self::path();
        if config.exists() {
            std::fs::remove_file(&config)
                .with_context(|| format!("removing config {}", config.display()))?;
        }
        let _ = std::fs::remove_file(Self::pid_path());
        let _ = std::fs::remove_file(Self::log_path());
        let _ = std::fs::remove_file(Self::state_path());
        if let Ok(exe) = std::env::current_exe() {
            let _ = std::fs::remove_file(&exe);
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
