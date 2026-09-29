//! DevEye Agent: lightweight cross-platform monitoring daemon (Linux, macOS,
//! Windows). The subcommands are documented on `Command`.

mod archive;
mod authlog;
mod commands;
mod config;
mod docker;
mod elevate;
mod enroll;
mod exclusions;
mod files;
mod identity;
mod integrity;
mod link;
mod logs;
mod metrics;
mod orders;
mod ownership;
mod packages;
mod policy_cmd;
mod power;
mod protocol;
mod report;
mod runner;
mod service;
mod sockets;
mod state;
mod sync;
mod terminal;
mod tunnel;
mod uninstall;
mod update;

use std::fs;
use std::sync::OnceLock;

/// Whether this process is supervised by a service manager (systemd/launchd/task),
/// set once at startup from `run --managed`. A supervised agent exits on
/// self-update and lets the manager relaunch it (`update::restart_and_exit`),
/// and must hand off before its own service is removed when autostart is disabled.
static MANAGED: OnceLock<bool> = OnceLock::new();

pub fn managed() -> bool {
    *MANAGED.get().unwrap_or(&false)
}

/// The local policy and the transport, as loaded at start: what the device
/// report says of this agent (`report::agent_info`).
static POLICY: OnceLock<config::Policy> = OnceLock::new();
static INSECURE_TRANSPORT: OnceLock<bool> = OnceLock::new();

pub fn policy() -> config::Policy {
    POLICY.get().cloned().unwrap_or_default()
}

pub fn insecure_transport() -> bool {
    *INSECURE_TRANSPORT.get().unwrap_or(&false)
}
use std::process::{Command as PCommand, Stdio};

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use tracing_subscriber::EnvFilter;

use crate::config::{Config, PolicyKey};
use crate::link::LinkOptions;
use crate::runner::RunOptions;

#[derive(Parser)]
#[command(name = "deveye-agent", version = env!("DEVEYE_VERSION"), about = "DevEye monitoring agent")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Enroll this machine using a link code from the DevEye UI.
    Link {
        /// The link code (e.g. ABCD-EFGH).
        #[arg(env = "DEVEYE_LINK_CODE", hide_env_values = true)]
        code: String,
        #[command(flatten)]
        options: LinkOptions,
        /// Then install the autostart service and start it: a system service
        /// when run as root, a per-user one otherwise.
        #[arg(long)]
        autostart: bool,
    },
    /// Run the monitoring loop. Foreground by default.
    Run {
        /// Collect and send a single cycle, then exit (quick test).
        #[arg(long)]
        once: bool,
        /// Initial seconds between metric samples (bootstrap only; the real
        /// cadence is set per-device from the DevEye UI and pushed on connect).
        #[arg(long, default_value_t = 30)]
        interval: u64,
        /// Run in the background and write a PID file.
        #[arg(long)]
        detach: bool,
        /// Internal: set by the installed service so a self-update exits cleanly
        /// (the manager restarts us) instead of re-spawning a detached child.
        #[arg(long)]
        managed: bool,
        /// Use this config file instead of the default location. Baked into the
        /// service definition so a system service finds the enrolled config.
        #[arg(long)]
        config: Option<String>,
        /// Not linked yet, the agent enrolls with `DEVEYE_LINK_CODE` and these.
        /// Once linked, only the refusals act: they are added at start.
        #[command(flatten, next_help_heading = "Linking (with DEVEYE_LINK_CODE)")]
        link: LinkOptions,
    },
    /// Show or change what the server may order on this machine.
    Policy {
        /// Allow these kinds of orders again (comma-separated, or `all`).
        #[arg(long, value_enum, value_delimiter = ',')]
        allow: Vec<PolicyKey>,
        /// Refuse these kinds of orders (comma-separated, or `all`).
        #[arg(long, value_enum, value_delimiter = ',')]
        deny: Vec<PolicyKey>,
        /// Refuse every kind of remote control (`--deny all`).
        #[arg(long)]
        monitor_only: bool,
        /// Use this config file instead of the default location.
        #[arg(long)]
        config: Option<String>,
    },
    /// Stop a backgrounded agent (started with `run --detach`).
    Stop,
    /// Print local enrollment and running status.
    Status,
    /// Manage the autostart service (persistence across reboots).
    Service {
        #[command(subcommand)]
        action: ServiceCmd,
    },
    /// List detected package managers + their pending updates (diagnostic).
    Packages,
    /// Forget the local enrollment (deletes the config + token).
    Unlink,
    /// Remove the agent entirely: autostart, config, token, caches, binary.
    ///
    /// `unlink` oublie l'enrôlement et laisse tout le reste en place ; celle-ci
    /// retire la machine de l'équation : démarrage automatique, linger, agent en
    /// marche, config, jeton, journal, caches, et le binaire lui-même.
    ///
    /// Elle ne touche pas au serveur : l'appareil et son historique restent à
    /// supprimer dans DevEye → Appareils.
    Uninstall {
        /// Ne pas demander confirmation.
        #[arg(long, short = 'y')]
        yes: bool,
        /// Effacer aussi la corbeille locale des partages CloudSync
        /// (`.deveye-trash`), qui contient vos fichiers supprimés.
        #[arg(long)]
        purge_shares: bool,
    },
}

#[derive(Subcommand)]
enum ServiceCmd {
    /// Install the autostart service. Per-user by default; `--system` needs root.
    Install {
        /// Install a system-wide service (boot, root) instead of a per-user one.
        #[arg(long)]
        system: bool,
        /// Explicit per-user install (the default; accepted for clarity).
        #[arg(long, conflicts_with = "system")]
        user: bool,
        /// Config file to bake into the service definition. Le chemin de la
        /// machine **enrôlée** : `sudo` et `pkexec` remplacent `$HOME` par celui
        /// de root, si bien qu'une installation système qui le devine grave un
        /// fichier qui n'existe pas. L'agent qui demande l'élévation le connaît,
        /// lui, et le passe ici.
        #[arg(long)]
        config: Option<String>,
    },
    /// Remove the autostart service (user and/or system).
    Uninstall,
    /// Print the installed service scope.
    Status,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    match Cli::parse().command {
        Command::Link {
            code,
            options,
            autostart,
        } => link::link(&code, &options, autostart).await,
        Command::Run {
            once,
            interval,
            detach,
            managed,
            config,
            link,
        } => run(once, interval, detach, managed, config, link).await,
        Command::Policy {
            allow,
            mut deny,
            monitor_only,
            config,
        } => {
            if let Some(path) = config {
                std::env::set_var("DEVEYE_CONFIG", path);
            }
            if monitor_only {
                deny.push(PolicyKey::All);
            }
            policy_cmd::run(policy_cmd::Change { allow, deny })
        }
        Command::Stop => stop(),
        Command::Status => {
            status();
            Ok(())
        }
        Command::Service { action } => service_cmd(action),
        Command::Packages => {
            for m in packages::detect() {
                let n = m
                    .pending_count
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "?".into());
                println!(
                    "{:<16} {} MAJ{}",
                    m.id,
                    n,
                    if m.needs_root { " (root)" } else { "" }
                );
            }
            Ok(())
        }
        Command::Unlink => unlink(),
        Command::Uninstall { yes, purge_shares } => {
            uninstall::run(uninstall::Options { yes, purge_shares })
        }
    }
}

fn service_cmd(action: ServiceCmd) -> Result<()> {
    match action {
        ServiceCmd::Install {
            system,
            user: _,
            config,
        } => {
            service::install(system, config.as_deref())?;
            // En ligne de commande, « installer » veut dire « et démarre-le » :
            // c'est le point d'entrée autonome. Le démarrage reste une étape
            // distincte pour le passage de relais interne (voir `service::install`).
            let started = service::start(system);
            let scope = if system { "système" } else { "utilisateur" };
            match started {
                Ok(()) => println!("✓ Service ({scope}) installé et démarré."),
                Err(e) => println!(
                    "✓ Service ({scope}) installé — démarrage différé : {e}\n  \
                     Il sera lancé au prochain démarrage de la machine."
                ),
            }
            Ok(())
        }
        ServiceCmd::Uninstall => {
            service::uninstall()?;
            println!("✓ Service désinstallé.");
            Ok(())
        }
        ServiceCmd::Status => {
            println!("Service: {}", service::installed_scope().as_wire());
            Ok(())
        }
    }
}

async fn run(
    once: bool,
    interval: u64,
    detach: bool,
    managed: bool,
    config_path: Option<String>,
    link: LinkOptions,
) -> Result<()> {
    // A `--config` points Config at a specific file (services bake an absolute
    // path so a system service finds the enrolled config). Set it before loading.
    if let Some(path) = config_path {
        std::env::set_var("DEVEYE_CONFIG", path);
    }
    // `--managed` (set by the service) or a `DEVEYE_MANAGED` env both mark us as supervised.
    let _ = MANAGED.set(managed || std::env::var_os("DEVEYE_MANAGED").is_some());

    // Sweep any binary a previous self-update left behind (Windows `.old`).
    update::cleanup_after_update();

    // Single-instance guard: duplicate instances share one device token and each
    // streams its own snapshots, so the server sees doubled data with no error
    // anywhere. `--once` stays allowed: a one-shot probe, throttled server-side.
    // Before enrolling: two agents enrolling at once would make two devices.
    if !once {
        if let Some(existing) = state::read_running() {
            anyhow::bail!(
                "un agent tourne déjà pour cet enrôlement (pid {}, utilisateur {}) ; \
                 arrêtez-le d'abord (`deveye-agent stop`, ou le service installé) avant d'en lancer un autre",
                existing.pid,
                existing.user
            );
        }
    }

    link::ensure_linked(&link, crate::managed()).await?;
    let mut config = Config::load().context("loading config (run `link` first)")?;
    link::tighten(&mut config, &link)?;
    let transport = config.check_transport()?;
    let _ = POLICY.set(config.policy.clone());
    let _ = INSECURE_TRANSPORT.set(transport == config::Transport::PlaintextRemote);

    if detach {
        if once {
            anyhow::bail!("--once and --detach are mutually exclusive");
        }
        return spawn_detached(interval);
    }

    // PID file so `stop`/`status` find a foreground agent too, plus the runtime
    // state so `status` reports our facts even from another user's session.
    let _ = config::write_private(
        &Config::pid_path(),
        std::process::id().to_string().as_bytes(),
    );
    state::write_running();

    let opts = RunOptions {
        once,
        interval: std::time::Duration::from_secs(interval.max(1)),
    };
    let result = runner::run(config, opts).await;
    let _ = fs::remove_file(Config::pid_path());
    state::clear();
    result
}

/// Re-exec ourselves as a background `run`, logging to the config dir.
fn spawn_detached(interval: u64) -> Result<()> {
    let exe = std::env::current_exe().context("locating agent executable")?;
    let log_path = Config::log_path();
    let log = config::open_private(&log_path, true)
        .with_context(|| format!("creating {}", log_path.display()))?;
    let log_err = log.try_clone()?;

    let mut cmd = PCommand::new(exe);
    cmd.arg("run").args(["--interval", &interval.to_string()]);
    if let Ok(cfg) = std::env::var("DEVEYE_CONFIG") {
        cmd.env("DEVEYE_CONFIG", cfg);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err));

    let child = cmd.spawn().context("spawning background agent")?;
    config::write_private(&Config::pid_path(), child.id().to_string().as_bytes())
        .context("writing PID file")?;
    println!(
        "✓ Agent started in background (pid {}).\n  Logs: {}\n  Stop: deveye-agent stop",
        child.id(),
        log_path.display()
    );
    Ok(())
}

fn stop() -> Result<()> {
    let pid_path = Config::pid_path();
    let pid = match fs::read_to_string(&pid_path) {
        Ok(s) => s.trim().to_string(),
        Err(_) => {
            println!("No running agent (no PID file).");
            return Ok(());
        }
    };
    if !process_alive(&pid) {
        println!("Agent not running (stale PID file removed).");
        let _ = fs::remove_file(&pid_path);
        state::clear();
        return Ok(());
    }
    kill_process(&pid)?;
    let _ = fs::remove_file(&pid_path);
    state::clear();
    println!("✓ Agent stopped (pid {pid}).");
    Ok(())
}

/// Terminate a backgrounded agent by PID. Unix sends SIGTERM (`kill`); Windows
/// force-kills via `taskkill /F` (the agent installs no graceful-shutdown
/// handler, so it relies on the OS terminating it either way).
#[cfg(unix)]
pub(crate) fn kill_process(pid: &str) -> Result<()> {
    let status = PCommand::new("kill")
        .arg(pid)
        .status()
        .context("sending SIGTERM")?;
    if status.success() {
        Ok(())
    } else {
        anyhow::bail!("failed to stop agent (pid {pid})");
    }
}

#[cfg(windows)]
pub(crate) fn kill_process(pid: &str) -> Result<()> {
    let status = PCommand::new("taskkill")
        .args(["/PID", pid, "/F"])
        .status()
        .context("running taskkill")?;
    if status.success() {
        Ok(())
    } else {
        anyhow::bail!("failed to stop agent (pid {pid})");
    }
}

fn status() {
    if !Config::exists() {
        println!("Not enrolled. Run: deveye-agent link <code>");
        return;
    }
    let c = match Config::load() {
        Ok(c) => c,
        Err(e) => {
            println!("Failed to read config: {e}");
            return;
        }
    };

    let scope = service::installed_scope().as_wire();
    let autostart = if scope == "none" {
        "no".to_string()
    } else {
        format!("yes ({scope})")
    };

    // Prefer the running agent's own recorded facts (the account it runs as, its
    // pid) over re-deriving them from this `status` process — they differ when the
    // agent runs elevated (root system service) and you ask from a user terminal.
    let running = state::read_running();
    let user = running
        .as_ref()
        .map(|s| s.user.clone())
        .unwrap_or_else(report::current_user);
    let running_text = match &running {
        Some(s) => format!("yes (pid {})", s.pid),
        // Fall back to the bare pid file (detach-handshake window).
        None => running_state(),
    };

    status_section("Device");
    status_row("Name", &c.name);
    status_row("Platform", identity::current_platform());
    status_row("Fingerprint", &c.fingerprint);
    status_row(
        "Device id",
        c.device_id.as_deref().unwrap_or("(not enrolled)"),
    );

    println!();
    status_section("Agent");
    status_row("Version", env!("DEVEYE_VERSION"));
    status_row("User", &user);
    status_row("Server", &c.server);
    status_row(
        "Enrolled",
        if c.device_token.is_some() {
            "yes"
        } else {
            "no"
        },
    );

    status_row(
        "Transport",
        match c.transport() {
            Ok(config::Transport::Tls) => "https",
            Ok(config::Transport::PlaintextLoopback) => "http (this machine only)",
            Ok(config::Transport::PlaintextRemote) => "http, UNENCRYPTED over the network",
            Err(_) => "invalid server URL",
        },
    );
    status_row(
        "Order key",
        if c.order_key.is_some() {
            "pinned"
        } else {
            "missing: signed orders are refused, re-link this machine"
        },
    );

    println!();
    status_section("Status");
    status_row("Running", &running_text);
    status_row("Autostart", &autostart);

    // Only what this machine refuses: an all-default policy says nothing.
    let refused: Vec<&str> = c.policy.refused().iter().map(|k| k.label()).collect();
    if !refused.is_empty() {
        println!();
        status_section("Local policy");
        status_row("Refused", &refused.join(", "));
    }
}

/// A `status` section header.
fn status_section(title: &str) {
    println!("=== {title} ===");
}

/// One left-aligned `label: value` row under a `status` section.
fn status_row(label: &str, value: &str) {
    println!("{:<13}{}", format!("{label}:"), value);
}

fn running_state() -> String {
    match fs::read_to_string(Config::pid_path()) {
        Ok(s) => {
            let pid = s.trim();
            if process_alive(pid) {
                format!("yes (pid {pid})")
            } else {
                "no".to_string()
            }
        }
        Err(_) => "no".to_string(),
    }
}

/// Whether a PID (as written in the pid file) is currently a live process.
/// Cross-user safe — see [`state::process_alive`].
fn process_alive(pid: &str) -> bool {
    pid.trim()
        .parse::<u32>()
        .map(state::process_alive)
        .unwrap_or(false)
}

fn unlink() -> Result<()> {
    if running_state().starts_with("yes") {
        let _ = stop();
    }
    let path = Config::path();
    if path.exists() {
        fs::remove_file(&path).with_context(|| format!("removing {}", path.display()))?;
        let _ = fs::remove_file(Config::pid_path());
        state::clear();
        println!("✓ Local enrollment removed. Delete the device in DevEye → Appareils too.");
    } else {
        println!("Nothing to remove (not enrolled).");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_link_code_can_come_from_the_environment() {
        std::env::set_var("DEVEYE_LINK_CODE", "ABCD-EFGH");
        let cli = Cli::try_parse_from(["deveye-agent", "link", "--autostart"]);
        std::env::remove_var("DEVEYE_LINK_CODE");
        match cli.unwrap().command {
            Command::Link {
                code, autostart, ..
            } => assert!(code == "ABCD-EFGH" && autostart),
            _ => panic!("not a link"),
        }
    }
}
