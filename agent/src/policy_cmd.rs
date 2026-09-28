//! `deveye-agent policy`: read and change, on this machine, what the server may
//! order here. The server never changes `[policy]`; this command is the way the
//! machine's operator does, short of editing `agent.toml`.

use anyhow::{Context, Result};
use clap::ValueEnum;

use crate::config::{Config, PolicyKey};
use crate::service::{self, ServiceScope};

pub struct Change {
    pub allow: Vec<PolicyKey>,
    pub deny: Vec<PolicyKey>,
}

impl Change {
    fn is_empty(&self) -> bool {
        self.allow.is_empty() && self.deny.is_empty()
    }
}

/// Show the policy, or apply `change` to it: allowed first, so a key named on
/// both sides ends up refused.
pub fn run(change: Change) -> Result<()> {
    let mut config = Config::load().context("loading config (run `link` first)")?;
    if change.is_empty() {
        print(&config);
        return Ok(());
    }
    let mut changed = config.policy.allow(&change.allow);
    changed |= config.policy.deny(&change.deny);
    if changed {
        config.save()?;
    }
    print(&config);
    println!();
    if changed {
        apply();
    } else {
        println!("Nothing changed.");
    }
    Ok(())
}

fn print(config: &Config) {
    println!("Local policy ({})", Config::path().display());
    for key in PolicyKey::SWITCHES {
        let name = key
            .to_possible_value()
            .map(|v| v.get_name().to_string())
            .unwrap_or_default();
        let state = if config.policy.allows(key) {
            "allowed"
        } else {
            "refused"
        };
        println!("  {name:<16}{state:<9}{}", key.label());
    }
}

/// The running agent read its policy at start: restart it. Only an agent that
/// runs on this config, whose state file sits next to it: a service installed
/// for another config is not this one's business.
fn apply() {
    let Some(running) = crate::state::read_running() else {
        println!("✓ Saved: the agent applies it when it starts.");
        return;
    };
    match service::installed_scope() {
        ServiceScope::None => match crate::kill_process(&running.pid.to_string()) {
            Ok(()) => println!(
                "✓ Stopped the running agent (pid {}): start it again \
                 (`deveye-agent run --detach`) to apply the new policy.",
                running.pid
            ),
            Err(e) => println!(
                "Saved, but the running agent (pid {}, user {}) could not be stopped ({e:#}): \
                 restart it to apply the new policy.",
                running.pid, running.user
            ),
        },
        scope => {
            let system = scope == ServiceScope::System;
            match service::restart(system) {
                Ok(()) => println!("✓ Agent restarted: the new policy applies."),
                Err(e) => println!(
                    "Saved, but the agent could not be restarted ({e:#}): restart its service{} \
                     to apply the new policy.",
                    if system { " as root" } else { "" }
                ),
            }
        }
    }
}
