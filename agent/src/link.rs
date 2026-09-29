//! Linking this machine to a DevEye workspace: the `link` command, and the
//! enrollment `run` performs by itself when it finds `DEVEYE_LINK_CODE` in its
//! environment (cloud-init, Ansible, a container).

use std::time::Duration;

use anyhow::{bail, Result};
use clap::builder::BoolishValueParser;
use clap::Args;
use tracing::{info, warn};

use crate::config::{self, Config, PolicyKey, DEFAULT_SERVER};
use crate::enroll::{self, EnrollError};
use crate::identity;
use crate::service::{self, ServiceScope};

/// How this machine links. Shared by `link` and by `run`, which enrolls by
/// itself from `DEVEYE_LINK_CODE` when the machine is not linked yet.
#[derive(Args, Debug, Clone, Default)]
pub struct LinkOptions {
    #[arg(
        long,
        env = "DEVEYE_SERVER",
        help = format!("DevEye server base URL [default: the saved one, else {DEFAULT_SERVER}]")
    )]
    pub server: Option<String>,
    /// Device name (defaults to the hostname).
    #[arg(long, env = "DEVEYE_NAME")]
    pub name: Option<String>,
    /// Refuse these kinds of orders on this machine, whatever the server says
    /// (comma-separated). Only ever adds refusals: `deveye-agent policy --allow`
    /// gives them back.
    #[arg(long, env = "DEVEYE_DENY", value_enum, value_delimiter = ',')]
    pub deny: Vec<PolicyKey>,
    /// Monitoring only: refuse every kind of remote control (`--deny all`).
    #[arg(long, env = "DEVEYE_MONITOR_ONLY", value_parser = BoolishValueParser::new())]
    pub monitor_only: bool,
    /// Identify this machine by a random id instead of its machine-id, for
    /// clones of one image, which share it. Acts only when enrolling.
    #[arg(long, env = "DEVEYE_SHUFFLE_ID", value_parser = BoolishValueParser::new())]
    pub shuffle_id: bool,
    /// Accept a plain http:// server that is not this machine. The device
    /// token and everything the server orders (a shell included) then travel
    /// in clear: only for a network you fully trust.
    #[arg(long)]
    pub insecure_plaintext: bool,
}

impl LinkOptions {
    /// The refusals these options add, `--monitor-only` included.
    fn denials(&self) -> Vec<PolicyKey> {
        let mut keys = self.deny.clone();
        if self.monitor_only {
            keys.push(PolicyKey::All);
        }
        keys
    }
}

/// The server a link talks to: the one named, else the one this machine
/// already links to, else the build's default.
fn resolve_server(named: Option<&str>, saved: Option<&str>) -> (String, bool) {
    let pick = |s: Option<&str>| {
        s.map(|s| s.trim().trim_end_matches('/').to_string())
            .filter(|s| !s.is_empty())
    };
    match pick(named).or_else(|| pick(saved)) {
        Some(server) => (server, false),
        None => (DEFAULT_SERVER.to_string(), true),
    }
}

/// The config a link writes: what this machine already had (its identity, its
/// policy, its accepted sync roots), with what the options change. The policy
/// only ever tightens.
pub fn prepare(options: &LinkOptions) -> Result<Config> {
    let existing = if Config::exists() {
        Some(Config::load()?)
    } else {
        None
    };
    let (server, is_default) = resolve_server(
        options.server.as_deref(),
        existing.as_ref().map(|c| c.server.as_str()),
    );
    if is_default {
        println!("Server: {server} (default; --server names another)");
    }
    let mut config = match existing {
        Some(mut c) => {
            c.server = server;
            if let Some(name) = &options.name {
                c.name = name.clone();
            }
            c
        }
        None => Config {
            server,
            name: options.name.clone().unwrap_or_else(identity::hostname),
            fingerprint: identity::machine_fingerprint(),
            device_id: None,
            device_token: None,
            order_key: None,
            allow_plaintext: false,
            sync_roots: Vec::new(),
            tunnel_targets: Vec::new(),
            policy: config::Policy::default(),
        },
    };
    if options.shuffle_id && !identity::is_random(&config.fingerprint) {
        if config.device_id.is_some() {
            println!(
                "This machine now links under a random id: its previous record stays in \
                 DevEye (Appareils), delete it there."
            );
        }
        config.fingerprint = identity::random_fingerprint();
    }
    config.policy.deny(&options.denials());
    config.allow_plaintext = options.insecure_plaintext;
    Ok(config)
}

/// `deveye-agent link`.
pub async fn link(code: &str, options: &LinkOptions, autostart: bool) -> Result<()> {
    let mut config = prepare(options)?;
    // Before the link code leaves this machine: enrollment is the exchange that
    // mints the token.
    config.check_transport()?;
    let system = crate::report::is_privileged();
    // A use of the code must not go to a machine that cannot keep the agent running.
    if autostart {
        service::preflight(system)?;
    }

    let status = enroll::enroll(&mut config, code).await?;
    let id = config.device_id.as_deref().unwrap_or("?");
    info!(device_id = id, %status, "Device enrolled");
    if status == "active" {
        println!("✓ Enrolled as \"{}\" (id {}) and active.", config.name, id);
    } else {
        println!(
            "✓ Re-linked as \"{}\" (id {}): this machine was already known to the workspace.\n  Approve it in DevEye (Appareils, Agent popup); the agent waits until then.",
            config.name, id
        );
    }
    println!("  Local policy: {}", describe(&config.policy));

    if autostart {
        return start_service(system);
    }
    println!(
        "  Start the agent:\n    deveye-agent run            # foreground\n    deveye-agent run --detach   # background\n  If it is already running, restart it: it still holds the old token."
    );
    Ok(())
}

/// What `[policy]` refuses, in one line.
pub fn describe(policy: &config::Policy) -> String {
    let refused = policy.refused();
    if refused.is_empty() {
        return "everything allowed (`deveye-agent policy` to refuse some)".to_string();
    }
    let names: Vec<&str> = refused.iter().map(|k| k.label()).collect();
    format!("refuses {}", names.join(", "))
}

/// `link --autostart`: the service, installed for the config just written,
/// replaces whatever agent still runs on the old token.
fn start_service(system: bool) -> Result<()> {
    let path = Config::path().to_string_lossy().into_owned();
    if let Err(e) = service::install(system, Some(&path)) {
        // Linux per-user: the unit is in place, only the start at boot, before
        // any login, is missing (linger).
        if service::installed_scope() == ServiceScope::None {
            return Err(e);
        }
        println!("  ! {e:#}");
    }
    if let Some(running) = crate::state::read_running() {
        crate::kill_process(&running.pid.to_string())?;
    }
    service::start(system)?;
    let scope = if system { "system" } else { "per-user" };
    println!("✓ Autostart ({scope}) installed and started.");
    crate::tray::start_after_link(system);
    Ok(())
}

/// Linked already: holds a token, even one the server has since revoked. Only
/// a new `link` brings a revoked device back, never the environment.
fn is_linked() -> bool {
    Config::load().is_ok_and(|c| c.device_token.is_some())
}

/// `run` on a machine not linked yet: enroll from `DEVEYE_LINK_CODE`. Under a
/// service manager, a failure never ends the process (it would be relaunched
/// at once, and hammer the server): it waits, as long as the failure says.
pub async fn ensure_linked(options: &LinkOptions, managed: bool) -> Result<()> {
    // A config that does not parse says why, rather than "not linked".
    if Config::exists() && Config::load()?.device_token.is_some() {
        return Ok(());
    }
    let Some(code) = std::env::var("DEVEYE_LINK_CODE")
        .ok()
        .filter(|c| !c.trim().is_empty())
    else {
        bail!("not linked: run `deveye-agent link <code>`, or set DEVEYE_LINK_CODE");
    };

    let mut config = prepare(options)?;
    config.check_transport()?;
    let mut transient_failures = 0u32;
    loop {
        let error = match enroll::enroll(&mut config, &code).await {
            Ok(status) => {
                info!(%status, device_id = config.device_id.as_deref().unwrap_or("?"), "enrolled from DEVEYE_LINK_CODE");
                return Ok(());
            }
            Err(e) if !managed => return Err(e.into()),
            Err(e) => e,
        };
        warn!(error = %error, "enrollment from DEVEYE_LINK_CODE failed");
        match retry_delay(&error, transient_failures) {
            Some(delay) => {
                if matches!(error, EnrollError::Transient(_)) {
                    transient_failures += 1;
                }
                tokio::time::sleep(delay).await;
            }
            // The code will never pass: only a `link` made by hand can help.
            None => loop {
                tokio::time::sleep(Duration::from_secs(30)).await;
                if is_linked() {
                    return Ok(());
                }
            },
        }
    }
}

/// How long to wait before trying the code again; `None`: never again.
fn retry_delay(error: &EnrollError, transient_failures: u32) -> Option<Duration> {
    use crate::runner::jittered;
    let minutes = |m: u64| Duration::from_secs(m * 60);
    match error {
        EnrollError::Invalid(_) | EnrollError::Conflict(_) => None,
        EnrollError::Quota(_) => Some(jittered(minutes(15), minutes(60))),
        EnrollError::RateLimited(Some(delay)) => {
            Some((*delay).clamp(Duration::from_secs(5), minutes(60)))
        }
        EnrollError::RateLimited(None) => Some(jittered(minutes(5), minutes(15))),
        EnrollError::Transient(_) => {
            let ceiling = Duration::from_secs(5 << transient_failures.min(6)).min(minutes(5));
            Some(jittered(Duration::from_secs(5), ceiling))
        }
    }
}

/// What `--deny`, `DEVEYE_DENY` and `--monitor-only` ask of an agent already
/// linked: more refusals, saved before the agent reads its policy. Never fewer.
pub fn tighten(config: &mut Config, options: &LinkOptions) -> Result<()> {
    if let Some(server) = options.server.as_deref() {
        let (named, _) = resolve_server(Some(server), None);
        if named != config.server.trim_end_matches('/') {
            warn!(named = %named, linked = %config.server, "DEVEYE_SERVER ignored: this machine is linked to another server");
        }
    }
    if config.policy.deny(&options.denials()) {
        config.save()?;
        info!(policy = %describe(&config.policy), "local policy tightened");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[derive(Parser)]
    struct Cli {
        #[command(flatten)]
        options: LinkOptions,
    }

    /// The options read the process environment: tests that parse them take turns.
    static ENV: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn the_named_server_wins_then_the_saved_one_then_the_default() {
        assert_eq!(
            resolve_server(Some("https://a.test/"), Some("https://b.test")),
            ("https://a.test".to_string(), false)
        );
        assert_eq!(
            resolve_server(None, Some("https://b.test")),
            ("https://b.test".to_string(), false)
        );
        assert_eq!(
            resolve_server(Some("  "), None),
            (DEFAULT_SERVER.to_string(), true)
        );
    }

    #[test]
    fn denials_parse_as_a_list_and_monitor_only_means_all() {
        let _env = ENV.lock().unwrap();
        let cli = Cli::parse_from(["x", "--deny", "terminal,files-write", "--deny", "power"]);
        assert_eq!(
            cli.options.denials(),
            vec![PolicyKey::Terminal, PolicyKey::FilesWrite, PolicyKey::Power]
        );
        let cli = Cli::parse_from(["x", "--monitor-only"]);
        let mut policy = config::Policy::default();
        policy.deny(&cli.options.denials());
        assert_eq!(policy.refused(), PolicyKey::SWITCHES.to_vec());
        assert!(Cli::try_parse_from(["x", "--deny", "everything"]).is_err());
    }

    #[test]
    fn the_environment_takes_boolish_values() {
        let _env = ENV.lock().unwrap();
        std::env::set_var("DEVEYE_SHUFFLE_ID", "1");
        std::env::set_var("DEVEYE_DENY", "terminal,sync");
        let cli = Cli::try_parse_from(["x"]);
        std::env::remove_var("DEVEYE_SHUFFLE_ID");
        std::env::remove_var("DEVEYE_DENY");
        let options = cli.unwrap().options;
        assert!(options.shuffle_id && !options.monitor_only);
        assert_eq!(options.deny, vec![PolicyKey::Terminal, PolicyKey::Sync]);
    }

    #[test]
    fn a_denial_never_gives_back_what_the_machine_refused() {
        let mut policy = config::Policy::default();
        policy.deny(&[PolicyKey::Power]);
        let options = LinkOptions {
            deny: vec![PolicyKey::Terminal],
            ..Default::default()
        };
        policy.deny(&options.denials());
        assert_eq!(
            policy.refused(),
            vec![PolicyKey::Terminal, PolicyKey::Power]
        );
    }

    #[test]
    fn transient_failures_back_off_and_dead_codes_stop() {
        assert!(retry_delay(&EnrollError::Invalid("x".into()), 0).is_none());
        assert!(retry_delay(&EnrollError::Conflict("x".into()), 0).is_none());
        let late = retry_delay(&EnrollError::Transient(anyhow::anyhow!("x")), 10).unwrap();
        assert!(late <= Duration::from_secs(300));
        let told = retry_delay(&EnrollError::RateLimited(Some(Duration::from_secs(1))), 0);
        assert_eq!(told, Some(Duration::from_secs(5)));
    }
}
