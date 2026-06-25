//! Handlers for the commands the server pushes over the `/agent` socket
//! (self-destruct, self-update, persistence/privilege changes, package events).
//! Kept separate from the session loop in `runner.rs`: the loop decides *when*,
//! these decide *how*. Every handler is generic over the WebSocket sink.

use std::time::Duration;

use anyhow::{Context, Result};
use futures_util::SinkExt;
use tokio_tungstenite::tungstenite::Message;
use tracing::{info, warn};

use crate::config::Config;
use crate::packages::PkgEvent;
use crate::protocol::ClientMessage;

/// Self-destruct on the server's request. On success the agent wipes its local
/// state, reports it, and **exits the process** (never returns). On failure it
/// reports the error and returns, so the session ends and the server can abort
/// the deletion (it restores the device's previous status).
pub(crate) async fn handle_destroy<S>(sink: &mut S, device_id: &str)
where
    S: SinkExt<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    match Config::self_destruct() {
        Ok(()) => {
            info!("self-destruct requested: local config + binary wiped, exiting");
            let _ = send_destroyed(sink, device_id, true, None).await;
            let _ = sink.flush().await;
            // Let the confirmation reach the server before we drop the socket.
            tokio::time::sleep(Duration::from_millis(300)).await;
            std::process::exit(0);
        }
        Err(e) => {
            warn!(error = %e, "self-destruct failed; aborting deletion");
            let _ = send_destroyed(sink, device_id, false, Some(e.to_string())).await;
            let _ = sink.flush().await;
            // Give the server time to record the failure (restore status) before
            // the caller ends the session and reconnects.
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }
}

async fn send_destroyed<S>(
    sink: &mut S,
    device_id: &str,
    ok: bool,
    error: Option<String>,
) -> Result<()>
where
    S: SinkExt<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    let msg = serde_json::to_string(&ClientMessage::Destroyed {
        device_id: device_id.to_string(),
        ok,
        error,
    })?;
    sink.send(Message::Text(msg))
        .await
        .context("sending destroyed")?;
    Ok(())
}

/// Apply a server-requested self-update. On success the new binary is in place;
/// we report it, close the socket cleanly and **restart** (never returns). On
/// failure the current binary is untouched: we report why and return, so the
/// session continues running the old version.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn handle_update<S>(
    sink: &mut S,
    config: &Config,
    device_id: &str,
    target_id: &str,
    version: &str,
    sha256: &str,
    signature: &str,
) where
    S: SinkExt<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    match crate::update::apply(config, target_id, version, sha256, signature).await {
        Ok(()) => {
            info!(%version, "update installed; restarting");
            let _ = send_updated(sink, device_id, true, Some(version.to_string()), None).await;
            let _ = sink.send(Message::Close(None)).await;
            let _ = sink.flush().await;
            // Let the confirmation + close reach the server (so it audits success
            // and registers our disconnect) before the new process connects.
            tokio::time::sleep(Duration::from_millis(400)).await;
            crate::update::restart_and_exit();
        }
        Err(e) => {
            warn!(error = %e, "self-update refused/failed; keeping current binary");
            let _ = send_updated(sink, device_id, false, None, Some(e.to_string())).await;
            let _ = sink.flush().await;
        }
    }
}

async fn send_updated<S>(
    sink: &mut S,
    device_id: &str,
    ok: bool,
    version: Option<String>,
    error: Option<String>,
) -> Result<()>
where
    S: SinkExt<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    let msg = serde_json::to_string(&ClientMessage::Updated {
        device_id: device_id.to_string(),
        ok,
        version,
        error,
    })?;
    sink.send(Message::Text(msg))
        .await
        .context("sending updated")?;
    Ok(())
}

/// Apply a server-requested persistence/privilege change and report the outcome.
/// On a successful `elevate` the system service now runs, so we drop our own
/// per-user autostart and exit (never returns in that case).
pub(crate) async fn handle_service<S>(sink: &mut S, device_id: &str, action: &str)
where
    S: SinkExt<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    use crate::elevate::Outcome;
    let result: Result<Outcome> = match action {
        "install-user" => crate::service::install(false).map(|()| Outcome::Done),
        "uninstall-user" => crate::service::uninstall().map(|()| Outcome::Done),
        "elevate" => crate::elevate::elevate(),
        "drop" => crate::elevate::drop_privileges(),
        other => Err(anyhow::anyhow!("action de service inconnue : {other}")),
    };

    match result {
        Ok(Outcome::Done) => {
            info!(%action, "service action applied");
            let _ = send_service_result(sink, device_id, action, true, None, None).await;
            let _ = sink.flush().await;
            if action == "elevate" {
                // The system service is installed + running. Drop our own per-user
                // autostart and exit so exactly one agent persists.
                tokio::time::sleep(Duration::from_millis(400)).await;
                let _ = crate::service::uninstall_user();
                std::process::exit(0);
            }
        }
        Ok(Outcome::NeedsManual) => {
            warn!(%action, "no interactive session; guiding the user to run it on the device");
            let _ = send_service_result(sink, device_id, action, false, Some(true), None).await;
            let _ = sink.flush().await;
        }
        Err(e) => {
            warn!(%action, error = %e, "service action failed");
            let _ = send_service_result(sink, device_id, action, false, None, Some(e.to_string()))
                .await;
            let _ = sink.flush().await;
        }
    }
}

async fn send_service_result<S>(
    sink: &mut S,
    device_id: &str,
    action: &str,
    ok: bool,
    needs_manual_command: Option<bool>,
    error: Option<String>,
) -> Result<()>
where
    S: SinkExt<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    let msg = serde_json::to_string(&ClientMessage::ServiceResult {
        device_id: device_id.to_string(),
        action: action.to_string(),
        ok,
        needs_manual_command,
        error,
    })?;
    sink.send(Message::Text(msg))
        .await
        .context("sending service result")?;
    Ok(())
}

/// Forward one package task event to the server, stamping it with the device id.
pub(crate) async fn send_pkg_event<S>(sink: &mut S, device_id: &str, ev: PkgEvent)
where
    S: SinkExt<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    let msg = match ev {
        PkgEvent::List(managers) => ClientMessage::PkgListResult {
            device_id: device_id.to_string(),
            managers,
        },
        PkgEvent::Progress {
            manager,
            percent,
            line,
        } => ClientMessage::PkgProgress {
            device_id: device_id.to_string(),
            manager,
            percent,
            phase: None,
            line,
        },
        PkgEvent::Done {
            manager,
            ok,
            reboot_required,
            error,
        } => ClientMessage::PkgDone {
            device_id: device_id.to_string(),
            manager,
            ok,
            reboot_required: Some(reboot_required),
            error,
        },
    };
    if let Ok(text) = serde_json::to_string(&msg) {
        let _ = sink.send(Message::Text(text)).await;
    }
}
