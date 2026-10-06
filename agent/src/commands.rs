//! Handlers for the commands the server pushes over the `/agent` socket
//! (self-destruct, self-update, persistence/privilege changes, package events).
//! Kept separate from the session loop in `runner.rs`: the loop decides *when*,
//! these decide *how*. Every handler is generic over the WebSocket sink.

use std::time::Duration;

use anyhow::{Context, Result};
use futures_util::SinkExt;
use tokio_tungstenite::tungstenite::Message;
use tracing::{info, warn};

use base64::Engine as _;

use crate::config::Config;
use crate::docker::DockerEvent;
use crate::files::FilesEvent;
use crate::logs::LogEvent;
use crate::packages::PkgEvent;
use crate::protocol::ClientMessage;
use crate::sync::SyncEvent;
use crate::terminal::TermEvent;
use crate::tunnel::TunnelEvent;

/// Self-destruct on the server's request. On success the agent wipes its local
/// state and its autostart, reports it, and **exits the process** (never
/// returns). On failure it reports the error and returns, so the session ends
/// and the server can abort the deletion (it restores the device's previous
/// status).
pub(crate) async fn handle_destroy<S>(sink: &mut S, device_id: &str)
where
    S: SinkExt<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    use crate::service;
    match Config::self_destruct() {
        Ok(()) => {
            // Left in place, the service would relaunch the erased binary
            // forever. Its definition goes now, its stop comes last: stopping
            // it ends this process when it supervises us.
            let scope = service::installed_scope();
            if let Err(e) = service::remove_definition(scope) {
                warn!(error = %e, "self-destruct: autostart service left in place");
            }
            crate::tray::stop_all();
            crate::tray::autostart::remove_all();
            crate::live_status::remove_all();
            info!("self-destruct requested: local state, binary and autostart wiped, exiting");
            let _ = send_destroyed(sink, device_id, true, None).await;
            let _ = sink.flush().await;
            // Let the confirmation reach the server before we drop the socket.
            tokio::time::sleep(Duration::from_millis(300)).await;
            service::end_supervision(scope);
            // The stop request may run in the background (launchd): let it leave.
            tokio::time::sleep(Duration::from_millis(500)).await;
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
    let _busy = crate::live_status::begin(crate::live_status::Task::Update);
    match crate::update::apply(config, target_id, version, sha256, signature).await {
        Ok(exe) => {
            info!(%version, "update installed; restarting");
            let _ = send_updated(sink, device_id, true, Some(version.to_string()), None).await;
            let _ = sink.send(Message::Close(None)).await;
            let _ = sink.flush().await;
            // Let the confirmation + close reach the server (so it audits success
            // and registers our disconnect) before the new process connects.
            tokio::time::sleep(Duration::from_millis(400)).await;
            crate::update::restart_and_exit(&exe);
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
        "autostart-on" => set_autostart(true),
        "autostart-off" => set_autostart(false),
        "elevate" => crate::elevate::elevate(),
        "drop" => crate::elevate::drop_privileges(),
        other => Err(anyhow::anyhow!("action de service inconnue : {other}")),
    };

    match result {
        Ok(Outcome::Done) => {
            info!(%action, "service action applied");
            let _ = send_service_result(sink, device_id, action, true, None, None).await;
            if action == "elevate" {
                // The system service is installed + running. Drop our own per-user
                // autostart and exit so exactly one agent persists (the new process
                // re-reports its scope on connect).
                let _ = sink.flush().await;
                tokio::time::sleep(Duration::from_millis(400)).await;
                let _ = crate::service::uninstall_user();
                // Le service système s'est heurté à notre verrou et attend sa
                // relance : on le libère avant de partir, le gestionnaire
                // réessaie dans les secondes qui suivent.
                crate::state::clear();
                let _ = std::fs::remove_file(crate::config::Config::pid_path());
                std::process::exit(0);
            }
            if action == "autostart-on" && !crate::managed() {
                // Lancés à la main, le service armé ne nous supervise pas : on
                // lui passe la main.
                let _ = sink.flush().await;
                return handoff_to_service(sink, device_id).await;
            }
            // Ni le désarmement ni `drop` ne nous relancent : on pousse un
            // rapport frais tout de suite, sans quoi l'état confirmé par
            // l'interface n'arriverait qu'au rapport horaire suivant.
            send_fresh_report(sink, device_id).await;
            let _ = sink.flush().await;
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

/// Arme ou désarme le service installé, sans toucher aux privilèges. Sans
/// service, l'armement en installe un à notre mesure : système si l'agent est
/// root, utilisateur sinon. Un service système demande root : sans lui, la
/// commande à lancer sur la machine.
fn set_autostart(on: bool) -> Result<crate::elevate::Outcome> {
    use crate::elevate::Outcome;
    use crate::service::{self, ServiceScope};
    let privileged = crate::report::is_privileged();
    match service::installed_scope() {
        ServiceScope::None if on => service::install(privileged, None, true)?,
        ServiceScope::None => {}
        ServiceScope::System if !privileged => return Ok(Outcome::NeedsManual),
        scope => service::set_autostart(scope == ServiceScope::System, on)?,
    }
    Ok(Outcome::Done)
}

/// Céder la place au service qu'on vient d'armer.
///
/// L'agent en marche tient le verrou d'instance unique : démarrer le service
/// pendant ce temps ne produirait qu'un second agent aussitôt refusé. On libère
/// le verrou, on lance le service, on lui laisse le temps d'ouvrir sa session,
/// puis on s'efface.
///
/// Si le démarrage échoue, on reste en vie : l'autostart prendra au prochain
/// amorçage, et la machine ne doit pas disparaître entre-temps. Un second
/// résultat porte la raison.
async fn handoff_to_service<S>(sink: &mut S, device_id: &str)
where
    S: SinkExt<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    use crate::service::{self, ServiceScope};
    crate::state::clear();
    let _ = std::fs::remove_file(crate::config::Config::pid_path());
    match service::start(service::installed_scope() == ServiceScope::System) {
        Ok(()) => {
            info!("autostart armed; handing over to the supervised agent");
            let _ = sink.flush().await;
            tokio::time::sleep(Duration::from_millis(500)).await;
            std::process::exit(0);
        }
        Err(e) => {
            warn!(error = %e, "the installed service refused to start; staying alive");
            // On reprend le verrou : nous sommes toujours l'agent en place.
            crate::state::write_running();
            let _ = send_service_result(
                sink,
                device_id,
                "autostart-on",
                false,
                None,
                Some(format!("service armé mais non démarré : {e}")),
            )
            .await;
            send_fresh_report(sink, device_id).await;
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

/// Collect and push a fresh OS/security report so the server (and UI) pick up a
/// just-changed service scope without waiting for the periodic report.
async fn send_fresh_report<S>(sink: &mut S, device_id: &str)
where
    S: SinkExt<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    // Security probes shell out: run off the runtime. A one-off out-of-band
    // report, so it probes sockets itself rather than reusing a tick's map.
    let Ok(report) = tokio::task::spawn_blocking(|| {
        let sockets = crate::sockets::read_sockets(true);
        crate::report::collect(sockets.listening, sockets.established)
    })
    .await
    else {
        return;
    };
    if let Ok(msg) = serde_json::to_string(&ClientMessage::Report {
        device_id: device_id.to_string(),
        report: Box::new(report),
    }) {
        let _ = sink.send(Message::Text(msg)).await;
    }
}

/// Apply a server-requested system power action and report the outcome. For
/// shutdown/reboot the host goes down right after, so we flush the result and give
/// it a brief moment to reach the server before the machine (and this process)
/// disappear. Suspend/hibernate/lock leave the agent running.
pub(crate) async fn handle_power<S>(sink: &mut S, device_id: &str, action: &str)
where
    S: SinkExt<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    let act = action.to_string();
    let outcome = tokio::task::spawn_blocking(move || crate::power::execute(&act)).await;
    let (ok, error) = match outcome {
        Ok(Ok(())) => (true, None),
        Ok(Err(e)) => (false, Some(e.to_string())),
        Err(e) => (false, Some(e.to_string())),
    };
    if ok {
        info!(%action, "power action applied");
    } else {
        warn!(%action, error = ?error, "power action failed");
    }
    let _ = send_power_result(sink, device_id, action, ok, error).await;
    if ok && matches!(action, "shutdown" | "reboot") {
        // Adieu explicite : la socket d'une machine éteinte n'est jamais
        // refermée par le réseau, et sans trame de fermeture le serveur ne
        // l'apprend que par expiration.
        let _ = sink.send(Message::Close(None)).await;
    }
    let _ = sink.flush().await;
    if ok && matches!(action, "shutdown" | "reboot") {
        // Laisser le résultat et la fermeture atteindre le serveur avant que
        // l'hôte (et donc ce processus) ne disparaisse.
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

async fn send_power_result<S>(
    sink: &mut S,
    device_id: &str,
    action: &str,
    ok: bool,
    error: Option<String>,
) -> Result<()>
where
    S: SinkExt<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    let msg = serde_json::to_string(&ClientMessage::PowerResult {
        device_id: device_id.to_string(),
        action: action.to_string(),
        ok,
        error,
    })?;
    sink.send(Message::Text(msg))
        .await
        .context("sending power result")?;
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
        PkgEvent::Count { manager, pending } => ClientMessage::PkgCount {
            device_id: device_id.to_string(),
            manager: manager.to_string(),
            pending_count: pending,
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

/// Forward one docker event to the server, stamping it with the device id.
pub(crate) async fn send_docker_event<S>(sink: &mut S, device_id: &str, ev: DockerEvent)
where
    S: SinkExt<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    let msg = match ev {
        DockerEvent::Inventory(inventory) => ClientMessage::DockerInventoryResult {
            device_id: device_id.to_string(),
            inventory,
        },
        DockerEvent::Stats(stats) => ClientMessage::DockerStatsResult {
            device_id: device_id.to_string(),
            stats,
        },
        DockerEvent::Progress { op_id, line } => ClientMessage::DockerProgress {
            device_id: device_id.to_string(),
            op_id,
            line,
        },
        DockerEvent::Done {
            op_id,
            action,
            ok,
            error,
        } => ClientMessage::DockerDone {
            device_id: device_id.to_string(),
            op_id,
            action,
            ok,
            error,
        },
    };
    if let Ok(text) = serde_json::to_string(&msg) {
        let _ = sink.send(Message::Text(text)).await;
    }
}

/// Forward one terminal event to the server (PTY output is base64-encoded so any
/// raw bytes survive the JSON wire), stamping it with the device id.
pub(crate) async fn send_term_event<S>(sink: &mut S, device_id: &str, ev: TermEvent)
where
    S: SinkExt<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    let msg = match ev {
        TermEvent::Output { session_id, data } => ClientMessage::TermOutput {
            device_id: device_id.to_string(),
            session_id,
            data: base64::engine::general_purpose::STANDARD.encode(&data),
        },
        TermEvent::Exit {
            session_id,
            code,
            error,
        } => ClientMessage::TermExit {
            device_id: device_id.to_string(),
            session_id,
            code,
            error,
        },
    };
    if let Ok(text) = serde_json::to_string(&msg) {
        let _ = sink.send(Message::Text(text)).await;
    }
}

/// Forward one tunnel event to the server (bytes base64-encoded), stamping it
/// with the device id.
pub(crate) async fn send_tunnel_event<S>(sink: &mut S, device_id: &str, ev: TunnelEvent)
where
    S: SinkExt<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    let device_id = device_id.to_string();
    let msg = match ev {
        TunnelEvent::Opened { tunnel_id } => ClientMessage::TunnelOpened {
            device_id,
            tunnel_id,
        },
        TunnelEvent::Data { tunnel_id, data } => ClientMessage::TunnelData {
            device_id,
            tunnel_id,
            data: base64::engine::general_purpose::STANDARD.encode(&data),
        },
        TunnelEvent::Closed { tunnel_id, error } => ClientMessage::TunnelClosed {
            device_id,
            tunnel_id,
            error,
        },
    };
    if let Ok(text) = serde_json::to_string(&msg) {
        let _ = sink.send(Message::Text(text)).await;
    }
}

/// Forward one file-explorer event to the server, stamping it with the device id.
pub(crate) async fn send_files_event<S>(sink: &mut S, device_id: &str, ev: FilesEvent)
where
    S: SinkExt<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    let msg = match ev {
        FilesEvent::Listing {
            op_id,
            listing,
            error,
        } => ClientMessage::FilesListing {
            device_id: device_id.to_string(),
            op_id,
            listing,
            error,
        },
        FilesEvent::Usage {
            op_id,
            entries,
            error,
        } => ClientMessage::FilesUsage {
            device_id: device_id.to_string(),
            op_id,
            entries,
            error,
        },
        FilesEvent::Matches {
            op_id,
            matches,
            truncated,
            error,
        } => ClientMessage::FilesMatches {
            device_id: device_id.to_string(),
            op_id,
            matches,
            truncated,
            error,
        },
        FilesEvent::Op {
            op_id,
            op,
            ok,
            error,
        } => ClientMessage::FilesOpResult {
            device_id: device_id.to_string(),
            op_id,
            op,
            ok,
            error,
        },
        FilesEvent::Chunk {
            op_id,
            data,
            done,
            error,
        } => ClientMessage::FilesChunk {
            device_id: device_id.to_string(),
            op_id,
            data: base64::engine::general_purpose::STANDARD.encode(&data),
            done,
            error,
        },
        FilesEvent::ArchiveChunk { op_id, seq, data } => ClientMessage::FilesArchiveChunk {
            device_id: device_id.to_string(),
            op_id,
            seq,
            data: base64::engine::general_purpose::STANDARD.encode(&data),
        },
        FilesEvent::ArchiveProgress {
            op_id,
            entries,
            bytes_read,
        } => ClientMessage::FilesArchiveProgress {
            device_id: device_id.to_string(),
            op_id,
            entries,
            bytes_read,
        },
        FilesEvent::ArchiveEnd {
            op_id,
            stats,
            error,
        } => ClientMessage::FilesArchiveEnd {
            device_id: device_id.to_string(),
            op_id,
            ok: error.is_none(),
            error,
            files: stats.files,
            dirs: stats.dirs,
            bytes_read: stats.bytes_read,
            skipped: stats.skipped,
            changed: stats.changed,
            samples: stats.samples,
        },
    };
    if let Ok(text) = serde_json::to_string(&msg) {
        let _ = sink.send(Message::Text(text)).await;
    }
}

/// Forward one log task event to the server, stamping it with the device id.
pub(crate) async fn send_log_event<S>(sink: &mut S, device_id: &str, ev: LogEvent)
where
    S: SinkExt<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    let msg = match ev {
        LogEvent::Sources(sources) => ClientMessage::LogSourcesResult {
            device_id: device_id.to_string(),
            sources,
        },
        LogEvent::Lines {
            query_id,
            lines,
            done,
            error,
        } => ClientMessage::LogLines {
            device_id: device_id.to_string(),
            query_id,
            lines,
            done,
            error,
        },
    };
    if let Ok(text) = serde_json::to_string(&msg) {
        let _ = sink.send(Message::Text(text)).await;
    }
}

/// Forward one CloudSync task event to the server, stamping it with the device id.
pub(crate) async fn send_sync_event<S>(sink: &mut S, device_id: &str, ev: SyncEvent)
where
    S: SinkExt<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    let msg = match ev {
        SyncEvent::Changed { share_id } => ClientMessage::SyncChanged {
            device_id: device_id.to_string(),
            share_id,
        },
        SyncEvent::Index {
            session_id,
            share_id,
            entries,
            done,
            scanned,
            fingerprint,
            encrypted,
            error,
        } => ClientMessage::SyncIndex {
            device_id: device_id.to_string(),
            session_id,
            share_id,
            entries,
            done,
            scanned,
            encrypted,
            fingerprint,
            error,
        },
        SyncEvent::Chunk {
            op_id,
            data,
            done,
            hash,
            size,
            mtime,
            error,
            seq,
            stale_partial,
        } => ClientMessage::SyncChunk {
            device_id: device_id.to_string(),
            op_id,
            data: base64::engine::general_purpose::STANDARD.encode(&data),
            done,
            hash,
            size,
            mtime,
            error,
            seq,
            stale_partial: stale_partial.then_some(true),
        },
        SyncEvent::DeviceKey { public_key } => ClientMessage::SyncDeviceKey {
            device_id: device_id.to_string(),
            public_key,
        },
        SyncEvent::Ack { op_id, seq } => ClientMessage::SyncAck {
            device_id: device_id.to_string(),
            op_id,
            seq,
        },
        SyncEvent::OpResult {
            op_id,
            op,
            ok,
            resume_from,
            error,
        } => ClientMessage::SyncOpResult {
            device_id: device_id.to_string(),
            op_id,
            op: op.to_string(),
            ok,
            resume_from,
            error,
        },
        SyncEvent::Busy { op_id } => ClientMessage::SyncBusy {
            device_id: device_id.to_string(),
            op_id,
        },
        // Internal to the agent, intercepted by the runner before this point.
        SyncEvent::WatcherReady { .. } => return,
    };
    if let Ok(text) = serde_json::to_string(&msg) {
        let _ = sink.send(Message::Text(text)).await;
    }
}

/// Tell the server an order was refused before execution (bad or missing
/// signature, local policy, the agent's own directory), through the reply the
/// server already waits for on that order: the operator sees why, a lock the
/// server took is released, a pending deletion is aborted. `agent.lifecycle` and
/// `sync.config` have no reply frame: their refusal is only logged.
pub(crate) async fn refuse_order<S>(
    sink: &mut S,
    device_id: &str,
    command: &str,
    payload: &serde_json::Value,
    reason: &str,
) where
    S: SinkExt<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    warn!(%command, %reason, "order refused");
    let text = |name: &str| {
        payload
            .get(name)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    let error = Some(reason.to_string());
    match command {
        "tunnel.open" => {
            send_tunnel_event(
                sink,
                device_id,
                TunnelEvent::Closed {
                    tunnel_id: text("tunnelId"),
                    error,
                },
            )
            .await;
        }
        "term.open" => {
            send_term_event(
                sink,
                device_id,
                crate::terminal::TermEvent::Exit {
                    session_id: text("sessionId"),
                    code: None,
                    error,
                },
            )
            .await;
        }
        "files.mutate" | "files.upload" => {
            let op = if command == "files.upload" {
                "upload".to_string()
            } else {
                text("op")
            };
            send_files_event(
                sink,
                device_id,
                crate::files::FilesEvent::Op {
                    op_id: text("opId"),
                    op,
                    ok: false,
                    error,
                },
            )
            .await;
        }
        "files.list" | "files.analyze" | "files.search" | "files.download" | "files.archive" => {
            let op_id = text("opId");
            let event = match command {
                "files.list" => crate::files::FilesEvent::Listing {
                    op_id,
                    listing: None,
                    error,
                },
                "files.analyze" => crate::files::FilesEvent::Usage {
                    op_id,
                    entries: Vec::new(),
                    error,
                },
                "files.search" => crate::files::FilesEvent::Matches {
                    op_id,
                    matches: Vec::new(),
                    truncated: false,
                    error,
                },
                "files.download" => crate::files::FilesEvent::Chunk {
                    op_id,
                    data: Vec::new(),
                    done: true,
                    error,
                },
                _ => crate::files::FilesEvent::ArchiveEnd {
                    op_id,
                    stats: Default::default(),
                    error,
                },
            };
            send_files_event(sink, device_id, event).await;
        }
        "sync.scan" => {
            let share_id = payload.get("shareId").and_then(|v| v.as_i64()).unwrap_or(0);
            send_sync_event(
                sink,
                device_id,
                SyncEvent::Index {
                    session_id: text("sessionId"),
                    share_id,
                    entries: Vec::new(),
                    done: true,
                    scanned: false,
                    fingerprint: None,
                    encrypted: false,
                    error,
                },
            )
            .await;
        }
        "sync.push" => {
            send_sync_event(
                sink,
                device_id,
                SyncEvent::Chunk {
                    op_id: text("opId"),
                    data: Vec::new(),
                    done: true,
                    hash: None,
                    size: None,
                    mtime: None,
                    error,
                    seq: None,
                    stale_partial: false,
                },
            )
            .await;
        }
        "sync.applyChunk" | "sync.applyStart" | "sync.applyDir" | "sync.applyLocal"
        | "sync.move" | "sync.delete" => {
            let op = match command {
                "sync.applyChunk" => "apply",
                "sync.applyStart" => "applyReady",
                "sync.applyDir" => "applyDir",
                "sync.applyLocal" => "applyLocal",
                "sync.move" => "move",
                _ => "delete",
            };
            send_sync_event(
                sink,
                device_id,
                SyncEvent::OpResult {
                    op_id: text("opId"),
                    op,
                    ok: false,
                    resume_from: None,
                    error,
                },
            )
            .await;
        }
        "agent.power" => {
            let _ = send_power_result(sink, device_id, &text("action"), false, error).await;
        }
        "pkg.upgrade" => {
            send_pkg_event(
                sink,
                device_id,
                PkgEvent::Done {
                    manager: text("manager"),
                    ok: false,
                    reboot_required: false,
                    error,
                },
            )
            .await;
        }
        "agent.service" => {
            let _ = send_service_result(sink, device_id, &text("action"), false, None, error).await;
        }
        "agent.destroy" => {
            let _ = send_destroyed(sink, device_id, false, error).await;
        }
        // Sans ce `done`, le verrou du serveur sur les actions longues de la
        // machine ne se libérerait jamais.
        "docker.action" => {
            send_docker_event(
                sink,
                device_id,
                DockerEvent::Done {
                    op_id: text("opId"),
                    action: text("action"),
                    ok: false,
                    error,
                },
            )
            .await;
        }
        _ => {}
    }
    let _ = sink.flush().await;
}
