//! DevEye Agent — lightweight Linux monitoring daemon.
//!
//! Subcommands:
//!   - `link <code>`  Enroll this machine with a one-time code from the web UI.
//!   - `run`          Stream metrics to the server (used by the systemd service).
//!   - `status`       Print the local enrollment state.

mod config;
mod enroll;
mod identity;
mod metrics;
mod protocol;
mod runner;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use tracing::info;
use tracing_subscriber::EnvFilter;

use crate::config::Config;

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
    /// Run the monitoring loop (foreground; used by the systemd unit).
    Run,
    /// Print local enrollment status.
    Status,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with_target(false)
        .init();

    match Cli::parse().command {
        Command::Link { code, server, name } => link(code, server, name).await,
        Command::Run => {
            let config = Config::load().context("loading config (run `link` first)")?;
            runner::run(config).await
        }
        Command::Status => {
            status();
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

    enroll::enroll(&mut config, &code).await?;
    info!(
        device_id = config.device_id.as_deref().unwrap_or("?"),
        "Device enrolled. It is now pending confirmation in the DevEye UI."
    );
    println!(
        "✓ Enrolled as \"{}\" (id {}).\n  Confirm it in DevEye → Clients, then start the service:\n    systemctl --user enable --now deveye-agent   # or the system unit",
        config.name,
        config.device_id.as_deref().unwrap_or("?")
    );
    Ok(())
}

fn status() {
    if !Config::exists() {
        println!("Not enrolled. Run: deveye-agent link <code> --server <url>");
        return;
    }
    match Config::load() {
        Ok(c) => {
            println!("Server:      {}", c.server);
            println!("Name:        {}", c.name);
            println!("Fingerprint: {}", c.fingerprint);
            println!(
                "Device id:   {}",
                c.device_id.as_deref().unwrap_or("(not enrolled)")
            );
            println!(
                "Enrolled:    {}",
                if c.device_token.is_some() { "yes" } else { "no" }
            );
        }
        Err(e) => println!("Failed to read config: {e}"),
    }
}
