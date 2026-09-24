//! Persistent agent configuration (TOML).
//!
//! Stores the server endpoint, this machine's stable fingerprint, what the
//! machine's operator allows the server to order (`[policy]`), and, once
//! enrolled, the device id, the device token and the server's order-signing key.
//! The file lives at `$DEVEYE_CONFIG` or `<config-dir>/deveye/agent.toml`, and is
//! read once at start: edit it, then restart the agent.

use std::net::IpAddr;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::handshake::client::Request;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;
use tokio_tungstenite::tungstenite::http::HeaderValue;

use crate::protocol::AgentPolicy;

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
    /// Server-assigned device id (set after enrollment).
    #[serde(default)]
    pub device_id: Option<String>,
    /// Device token (set after enrollment, replaced when the server rotates it).
    #[serde(default)]
    pub device_token: Option<String>,
    /// Base64 Ed25519 public key of the server's order-signing key, pinned at
    /// enrollment. Without it, every order that must be signed is refused.
    #[serde(default)]
    pub order_key: Option<String>,
    /// Plain http to a remote server, accepted knowingly (`link --insecure-plaintext`).
    /// Kept in the config so a service or a detached run inherits the choice.
    #[serde(default)]
    pub allow_plaintext: bool,
    /// CloudSync roots this machine accepts. Empty: any directory that is not a
    /// system one. A share whose root is elsewhere is refused.
    #[serde(default)]
    pub sync_roots: Vec<String>,
    /// What the server may order here. Kept last: TOML wants tables after values.
    #[serde(default)]
    pub policy: Policy,
}

/// What this machine's operator allows the server to order. No frame maps to
/// it: it is the one thing on the device the server does not decide. Everything
/// defaults to allowed; set a key to `false` to get monitoring without that
/// kind of remote control.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Policy {
    /// `term.open`: an interactive shell.
    pub allow_terminal: bool,
    /// `files.mutate`, `files.upload`: delete, rename, create, write.
    pub allow_files_write: bool,
    /// `agent.power`: shut down, reboot, suspend, lock.
    pub allow_power: bool,
    /// `pkg.upgrade`: system package upgrades.
    pub allow_pkg_upgrade: bool,
    /// `agent.service` `elevate`: asking the desktop to make the agent a root service.
    pub allow_service_elevate: bool,
    /// `agent.destroy`: wiping the agent's config and binary on device deletion.
    pub allow_destroy: bool,
    /// `docker.action` `composeDeploy`: pulling a compose service's image and
    /// recreating it, what a deployment from the server does.
    pub allow_docker_deploy: bool,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            allow_terminal: true,
            allow_files_write: true,
            allow_power: true,
            allow_pkg_upgrade: true,
            allow_service_elevate: true,
            allow_destroy: true,
            allow_docker_deploy: true,
        }
    }
}

impl Policy {
    /// The policy as the device report carries it, so the server UI can grey out
    /// what this machine will refuse.
    pub fn wire(&self) -> AgentPolicy {
        AgentPolicy {
            terminal: self.allow_terminal,
            files_write: self.allow_files_write,
            power: self.allow_power,
            pkg_upgrade: self.allow_pkg_upgrade,
            service_elevate: self.allow_service_elevate,
            destroy: self.allow_destroy,
            docker_deploy: self.allow_docker_deploy,
        }
    }

    /// Why this order is refused here, or `None` when the policy allows it.
    /// `action` is the `action` field of the order, for the switches that cover
    /// one action of a command (`agent.service` `elevate`, `docker.action`
    /// `composeDeploy`).
    pub fn refusal(&self, command: &str, action: Option<&str>) -> Option<String> {
        let key = match command {
            "term.open" if !self.allow_terminal => "allow_terminal",
            "files.mutate" | "files.upload" if !self.allow_files_write => "allow_files_write",
            "agent.power" if !self.allow_power => "allow_power",
            "pkg.upgrade" if !self.allow_pkg_upgrade => "allow_pkg_upgrade",
            "agent.service" if action == Some("elevate") && !self.allow_service_elevate => {
                "allow_service_elevate"
            }
            "agent.destroy" if !self.allow_destroy => "allow_destroy",
            "docker.action" if action == Some("composeDeploy") && !self.allow_docker_deploy => {
                "allow_docker_deploy"
            }
            _ => return None,
        };
        Some(format!(
            "refused by local policy ({key} = false in agent.toml)"
        ))
    }
}

/// How the agent reaches its server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transport {
    Tls,
    /// Plain http to this very machine: nothing leaves it.
    PlaintextLoopback,
    /// Plain http over a network: the token, every file and every keystroke of a
    /// remote shell travel in clear.
    PlaintextRemote,
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
            private_dir(parent)
                .with_context(|| format!("creating config dir {}", parent.display()))?;
        }
        let toml = toml::to_string_pretty(self).context("serializing config")?;
        write_private(&path, toml.as_bytes())
            .with_context(|| format!("writing {}", path.display()))?;
        Ok(())
    }

    /// Is this path the agent's own directory, or inside it? The server may
    /// write files on this machine, never the file that says what it may do.
    pub fn is_own_path(path: &Path) -> bool {
        let Some(dir) = Self::path().parent().map(Path::to_path_buf) else {
            return false;
        };
        let dir = dir.canonicalize().unwrap_or(dir);
        // The target may not exist yet: resolve its deepest existing ancestor.
        let mut probe = path.to_path_buf();
        loop {
            if let Ok(real) = probe.canonicalize() {
                return real.starts_with(&dir);
            }
            if !probe.pop() {
                return path.starts_with(&dir);
            }
        }
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

    /// The WebSocket handshake to the server. The token travels in the
    /// `Authorization` header: a URL ends up in the access log of every proxy on
    /// the way, and this token opens a shell on this machine.
    pub fn ws_request(&self) -> Result<Request> {
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
            bail!("server URL must start with http:// or https://");
        };
        let mut request = format!("{ws_base}/agent")
            .into_client_request()
            .context("building the WebSocket request")?;
        let value = HeaderValue::from_str(&format!("Bearer {token}"))
            .context("device token is not a valid header value")?;
        request.headers_mut().insert(AUTHORIZATION, value);
        Ok(request)
    }

    pub fn transport(&self) -> Result<Transport> {
        let base = self.server.trim_end_matches('/');
        if base.starts_with("https://") {
            return Ok(Transport::Tls);
        }
        let Some(rest) = base.strip_prefix("http://") else {
            bail!("server URL must start with http:// or https://");
        };
        let authority = rest.split('/').next().unwrap_or("");
        Ok(if is_loopback_authority(authority) {
            Transport::PlaintextLoopback
        } else {
            Transport::PlaintextRemote
        })
    }

    /// Refuse plain http to anything but this machine, unless the operator opted
    /// in (`link --insecure-plaintext`, kept as `allow_plaintext`, or
    /// `DEVEYE_ALLOW_PLAINTEXT=1`).
    pub fn check_transport(&self) -> Result<Transport> {
        let transport = self.transport()?;
        if transport == Transport::PlaintextRemote && !plaintext_allowed(self.allow_plaintext) {
            bail!(
                "refusing plaintext http:// to a non-loopback host ({}): the device token and \
                 everything the server orders would travel in clear. Use https://, or opt in by \
                 re-linking with --insecure-plaintext (or DEVEYE_ALLOW_PLAINTEXT=1)",
                self.server
            );
        }
        Ok(transport)
    }
}

pub fn plaintext_allowed(flag: bool) -> bool {
    flag || std::env::var("DEVEYE_ALLOW_PLAINTEXT").as_deref() == Ok("1")
}

/// `host[:port]` of a URL: is the host this machine?
fn is_loopback_authority(authority: &str) -> bool {
    let host = if let Some(rest) = authority.strip_prefix('[') {
        rest.split(']').next().unwrap_or("")
    } else {
        authority.rsplit_once(':').map_or(authority, |(h, _)| h)
    };
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

/// Create (or truncate) a file only its owner can read: the config holds the
/// device token, the log may hold server frames, the sync index lists every file
/// of a share. No-op on the mode outside Unix.
pub fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut file = open_private(path, true)?;
    file.write_all(bytes)
}

/// Open a file only its owner can read, truncating it or appending to it.
pub fn open_private(path: &Path, truncate: bool) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.create(true).write(true);
    if truncate {
        options.truncate(true);
    } else {
        options.append(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    // A file that predates this mode keeps its old one: tighten it too.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = file.set_permissions(std::fs::Permissions::from_mode(0o600));
    }
    Ok(file)
}

/// Create the agent's directory, readable by its owner alone.
pub fn private_dir(path: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(server: &str) -> Config {
        Config {
            server: server.to_string(),
            name: "test".into(),
            fingerprint: "fp".into(),
            device_id: None,
            device_token: Some("tok".into()),
            order_key: None,
            allow_plaintext: false,
            sync_roots: Vec::new(),
            policy: Policy::default(),
        }
    }

    #[test]
    fn plaintext_is_refused_off_loopback() {
        assert_eq!(
            config("https://deveye.example.com").transport().unwrap(),
            Transport::Tls
        );
        for local in [
            "http://localhost:3000",
            "http://127.0.0.1:3000/",
            "http://[::1]:3000",
        ] {
            assert_eq!(
                config(local).transport().unwrap(),
                Transport::PlaintextLoopback,
                "{local}"
            );
            assert!(config(local).check_transport().is_ok());
        }
        for remote in [
            "http://box.internal",
            "http://192.168.1.10:3000",
            "http://localhost.evil.test",
        ] {
            assert_eq!(
                config(remote).transport().unwrap(),
                Transport::PlaintextRemote,
                "{remote}"
            );
            assert!(config(remote).check_transport().is_err());
            let opted_in = Config {
                allow_plaintext: true,
                ..config(remote)
            };
            assert!(opted_in.check_transport().is_ok());
        }
        assert!(config("ftp://x").transport().is_err());
    }

    #[test]
    fn the_token_travels_in_a_header_never_in_the_url() {
        let request = config("https://deveye.example.com/").ws_request().unwrap();
        assert_eq!(request.uri().to_string(), "wss://deveye.example.com/agent");
        assert_eq!(request.headers().get(AUTHORIZATION).unwrap(), "Bearer tok");
    }

    #[test]
    fn policy_refuses_each_gated_order_and_nothing_else() {
        let cases = [
            ("term.open", None),
            ("files.mutate", None),
            ("files.upload", None),
            ("agent.power", None),
            ("pkg.upgrade", None),
            ("agent.service", Some("elevate")),
            ("agent.destroy", None),
            ("docker.action", Some("composeDeploy")),
        ];
        let open = Policy::default();
        let closed = Policy {
            allow_terminal: false,
            allow_files_write: false,
            allow_power: false,
            allow_pkg_upgrade: false,
            allow_service_elevate: false,
            allow_destroy: false,
            allow_docker_deploy: false,
        };
        for (command, action) in cases {
            assert!(
                open.refusal(command, action).is_none(),
                "{command} allowed by default"
            );
            let why = closed.refusal(command, action).expect(command);
            assert!(why.contains("agent.toml"), "{why}");
        }
        // What the policy does not name stays allowed, even fully closed.
        for command in ["agent.collect", "files.list", "term.input", "agent.update"] {
            assert!(closed.refusal(command, None).is_none(), "{command}");
        }
        assert!(closed
            .refusal("agent.service", Some("install-user"))
            .is_none());
        // Seul le déploiement se ferme : les autres actions Docker restent.
        assert!(closed.refusal("docker.action", Some("restart")).is_none());
    }

    #[test]
    fn a_config_without_policy_allows_everything_and_an_old_one_still_parses() {
        let old = r#"
            server = "https://x"
            name = "n"
            fingerprint = "f"
            secret_key = "legacy"
            public_key = "legacy"
        "#;
        let cfg: Config = toml::from_str(old).unwrap();
        assert!(cfg.policy.allow_terminal && cfg.policy.allow_destroy);
        assert!(cfg.order_key.is_none());

        let restricted: Config = toml::from_str(
            "server = \"https://x\"\nname = \"n\"\nfingerprint = \"f\"\n[policy]\nallow_terminal = false\n",
        )
        .unwrap();
        assert!(!restricted.policy.allow_terminal);
        assert!(
            restricted.policy.allow_power,
            "unnamed keys keep their default"
        );
    }
}
