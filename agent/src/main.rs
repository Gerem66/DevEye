//! DevEye Agent — lightweight cross-platform monitoring daemon (Linux & macOS).
//!
//! Subcommands:
//!   - `link <code>`  Enroll this machine with a one-time code from the web UI.
//!   - `run`          Stream metrics to the server (foreground, or `--detach`).
//!   - `stop`         Stop a backgrounded agent.
//!   - `status`       Print the local enrollment + running state.
//!   - `unlink`       Forget the local enrollment (config + token).

mod config;
mod enroll;
mod identity;
mod metrics;
mod protocol;
mod report;
mod runner;

use std::fs;
use std::process::{Command as PCommand, Stdio};

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use tracing::info;
use tracing_subscriber::EnvFilter;

use crate::config::Config;
use crate::runner::RunOptions;

#[derive(Parser)]
#[command(name = "deveye-agent", version, about = "DevEye monitoring agent")]
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
        #[arg(long, default_value_t = 300)]
        interval: u64,
        /// Run in the background and write a PID file.
        #[arg(long)]
        detach: bool,
    },
    /// Stop a backgrounded agent (started with `run --detach`).
    Stop,
    /// Print local enrollment and running status.
    Status,
    /// Forget the local enrollment (deletes the config + token).
    Unlink,
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
        } => run(once, interval, detach).await,
        Command::Stop => stop(),
        Command::Status => {
            status();
            Ok(())
        }
        Command::Unlink => unlink(),
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

async fn run(once: bool, interval: u64, detach: bool) -> Result<()> {
    let config = Config::load().context("loading config (run `link` first)")?;

    if detach {
        if once {
            anyhow::bail!("--once and --detach are mutually exclusive");
        }
        return spawn_detached(interval);
    }

    // Record our PID so `stop`/`status` can find a foreground agent too.
    let _ = fs::write(Config::pid_path(), std::process::id().to_string());

    let opts = RunOptions {
        once,
        interval: std::time::Duration::from_secs(interval.max(1)),
    };
    let result = runner::run(config, opts).await;
    let _ = fs::remove_file(Config::pid_path());
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
        return Ok(());
    }
    let status = PCommand::new("kill")
        .arg(&pid)
        .status()
        .context("sending SIGTERM")?;
    if status.success() {
        let _ = fs::remove_file(&pid_path);
        println!("✓ Agent stopped (pid {pid}).");
    } else {
        anyhow::bail!("failed to stop agent (pid {pid})");
    }
    Ok(())
}

fn status() {
    if !Config::exists() {
        println!("Not enrolled. Run: deveye-agent link <code> --server <url>");
        return;
    }
    match Config::load() {
        Ok(c) => {
            println!("Platform:    {}", identity::current_platform());
            println!("Server:      {}", c.server);
            println!("Name:        {}", c.name);
            println!("Fingerprint: {}", c.fingerprint);
            println!(
                "Device id:   {}",
                c.device_id.as_deref().unwrap_or("(not enrolled)")
            );
            println!(
                "Enrolled:    {}",
                if c.device_token.is_some() {
                    "yes"
                } else {
                    "no"
                }
            );
            println!("Running:     {}", running_state());
        }
        Err(e) => println!("Failed to read config: {e}"),
    }
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

/// `kill -0 <pid>` succeeds iff the process exists and is signalable.
fn process_alive(pid: &str) -> bool {
    PCommand::new("kill")
        .args(["-0", pid])
        .status()
        .map(|s| s.success())
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
        println!("✓ Local enrollment removed. Delete the device in DevEye → Appareils too.");
    } else {
        println!("Nothing to remove (not enrolled).");
    }
    Ok(())
}
