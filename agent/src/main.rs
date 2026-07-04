//! DevEye Agent — lightweight cross-platform monitoring daemon (Linux, macOS &
//! Windows).
//!
//! Subcommands:
//!   - `link <code>`  Enroll this machine with a one-time code from the web UI.
//!   - `run`          Stream metrics to the server (foreground, or `--detach`).
//!   - `stop`         Stop a backgrounded agent.
//!   - `status`       Print the local enrollment + running state.
//!   - `unlink`       Forget the local enrollment (config + token).

mod commands;
mod config;
mod elevate;
mod enroll;
mod files;
mod identity;
mod logs;
mod metrics;
mod packages;
mod power;
mod protocol;
mod report;
mod runner;
mod service;
mod state;
mod sync;
mod terminal;
mod update;

use std::fs;
use std::sync::OnceLock;

/// Whether this process is supervised by a service manager (systemd/launchd/task),
/// set once at startup from `run --managed`. Drives the self-update restart (a
/// supervised agent just exits and lets the manager relaunch it; otherwise it
/// respawns itself — see `update::restart_and_exit`), is reported to the server,
/// and is used when disabling autostart (we must hand off before the supervising
/// service is removed, or it would kill us).
static MANAGED: OnceLock<bool> = OnceLock::new();

pub fn managed() -> bool {
    *MANAGED.get().unwrap_or(&false)
}
use std::process::{Command as PCommand, Stdio};

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use tracing::info;
use tracing_subscriber::EnvFilter;

use crate::config::Config;
use crate::runner::RunOptions;

#[derive(Parser)]
#[command(name = "deveye-agent", version = env!("DEVEYE_VERSION"), about = "DevEye monitoring agent")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Enroll this machine using a one-time link code from the DevEye UI.
    Link {
        /// The link code (e.g. ABCD-EFGH).
        code: String,
        /// DevEye server base URL.
        #[arg(long, default_value = "http://localhost:3000")]
        server: String,
        /// Override the device name (defaults to the hostname).
        #[arg(long)]
        name: Option<String>,
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
        Command::Link { code, server, name } => link(code, server, name).await,
        Command::Run {
            once,
            interval,
            detach,
            managed,
            config,
        } => run(once, interval, detach, managed, config).await,
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
    }
}

fn service_cmd(action: ServiceCmd) -> Result<()> {
    match action {
        ServiceCmd::Install { system, user: _ } => {
            service::install(system)?;
            let scope = if system { "système" } else { "utilisateur" };
            println!("✓ Service ({scope}) installé — l'agent démarrera automatiquement.");
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

async fn link(code: String, server: String, name: Option<String>) -> Result<()> {
    // Preserve an existing identity (keypair/fingerprint) across re-links.
    let mut config = if Config::exists() {
        let mut c = Config::load()?;
        c.server = server;
        if let Some(n) = name {
            c.name = n;
        }
        c
    } else {
        let keypair = identity::generate_keypair();
        Config {
            server,
            name: name.unwrap_or_else(identity::hostname),
            fingerprint: identity::machine_fingerprint(),
            secret_key: keypair.secret_b64,
            public_key: keypair.public_b64,
            device_id: None,
            device_token: None,
        }
    };

    let status = enroll::enroll(&mut config, &code).await?;
    let approved = status == "active";
    let id = config.device_id.as_deref().unwrap_or("?");
    info!(device_id = id, %status, "Device enrolled");
    if approved {
        println!(
            "✓ Enrolled as \"{}\" (id {}) — automatically approved.\n  Start the agent:\n    deveye-agent run            # foreground\n    deveye-agent run --detach   # background",
            config.name, id
        );
    } else {
        println!(
            "✓ Enrolled as \"{}\" (id {}).\n  Approve it in DevEye → Appareils, then start the agent:\n    deveye-agent run            # foreground\n    deveye-agent run --detach   # background",
            config.name, id
        );
    }
    Ok(())
}

async fn run(
    once: bool,
    interval: u64,
    detach: bool,
    managed: bool,
    config_path: Option<String>,
) -> Result<()> {
    // A `--config` points Config at a specific file (services bake an absolute
    // path so a system service finds the enrolled config). Set it before loading.
    if let Some(path) = config_path {
        std::env::set_var("DEVEYE_CONFIG", path);
    }
    // `--managed` (set by the service) or a `DEVEYE_MANAGED` env both mark us as
    // supervised — either way a self-update exits and lets the manager relaunch us.
    let _ = MANAGED.set(managed || std::env::var_os("DEVEYE_MANAGED").is_some());

    // Sweep any binary a previous self-update left behind (Windows `.old`).
    update::cleanup_after_update();

    let config = Config::load().context("loading config (run `link` first)")?;

    if detach {
        if once {
            anyhow::bail!("--once and --detach are mutually exclusive");
        }
        return spawn_detached(interval);
    }

    // Record our PID so `stop`/`status` can find a foreground agent too, plus the
    // richer runtime state (the account we run as) so `status` reports *our* facts
    // even when asked from another user's session.
    let _ = fs::write(Config::pid_path(), std::process::id().to_string());
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
    let log =
        fs::File::create(&log_path).with_context(|| format!("creating {}", log_path.display()))?;
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
    fs::write(Config::pid_path(), child.id().to_string()).context("writing PID file")?;
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
fn kill_process(pid: &str) -> Result<()> {
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
fn kill_process(pid: &str) -> Result<()> {
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
        println!("Not enrolled. Run: deveye-agent link <code> --server <url>");
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
        // Fall back to the bare pid file (detach-handshake window, or an older agent
        // that predates the state file).
        None => running_state(),
    };

    // Grouped so each block answers one question: which machine this is, how this
    // local agent install is wired, and whether it's operating right now.
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

    println!();
    status_section("Status");
    status_row("Running", &running_text);
    status_row("Autostart", &autostart);
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
