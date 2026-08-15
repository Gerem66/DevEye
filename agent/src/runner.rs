//! Long-running monitoring loop: maintain a permanent WebSocket to the server,
//! stream metric batches, and reconnect with exponential backoff.
//!
//! Samples collected while disconnected are buffered in a bounded in-memory
//! queue and flushed on reconnect, so transient outages don't lose data.
//!
//! One cadence (pushed by the server via `agent.config`): every tick collects a
//! whole *instant* — graph signals, the process count, disk I/O and the process
//! list — under a single timestamp, in one message. A graph point can therefore
//! never exist without the processes that explain it.
//!
//! The OS/security report is sent on connect and hourly, reusing the socket probe
//! the tick already ran. The first instant is collected immediately on connect so
//! the dashboard isn't blank.

use std::collections::{HashSet, VecDeque};
use std::time::Duration;

use anyhow::{Context, Result};
use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use tokio::time::{interval_at, Instant, MissedTickBehavior};
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, info, warn};

use crate::commands;
use crate::config::Config;
use crate::metrics::Collector;
use crate::protocol::{ClientMessage, DeviceReport, MetricSnapshot, ServerMessage};
use crate::report;
use crate::sockets::{self, SocketMap};

const MAX_BATCH: usize = 100;
/// Serialized ceiling for one batch frame. A snapshot now carries its process
/// list (tens of kilobytes), so `MAX_BATCH` alone would let a reconnect flush
/// build a multi-megabyte frame; whichever limit is hit first ends the batch.
const MAX_BATCH_BYTES: usize = 1_000_000;
/// ~48 hours at the default 60-s cadence; oldest are dropped when full.
const QUEUE_CAPACITY: usize = 2880;
/// How many of the most recent queued snapshots keep their process list. Beyond
/// this the detail is dropped from the *older* ones, so a long outage still
/// replays graphs at full fidelity (`QUEUE_CAPACITY`) while process detail —
/// which is ~30x heavier — stays bounded to a few hours of memory.
const PROCESS_QUEUE_LIMIT: usize = 240;
const MIN_BACKOFF: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(60);
/// Pause after a *clean* close (server restart, network blip) before dialing
/// again. Without it a server that accepts-then-closes puts the agent in a
/// tight connect loop, and each connect used to fire a full snapshot +
/// process sample — flooding the server with one snapshot per second.
const RECONNECT_DELAY: Duration = Duration::from_secs(2);
/// The connect-time instant is skipped when the previous one is fresher than
/// this: reconnect loops must not multiply snapshots. The server can still force
/// one at any time via `agent.collect`.
const MIN_CONNECT_SNAPSHOT_GAP: Duration = Duration::from_secs(60);
/// Retry delay after the server *rejects* us at the handshake (revoked, unknown
/// or not-yet-approved device). Much slower than a normal reconnect: a rejection
/// won't clear on its own, so we back off to roughly hourly to avoid hammering
/// the server (and to stay quiet from the outside).
const REJECTED_RETRY: Duration = Duration::from_secs(60 * 60);
/// How often to send the OS/security report.
const REPORT_INTERVAL: Duration = Duration::from_secs(60 * 60);
/// Default used until the server pushes `agent.config` (≈immediately on
/// connect). Mirrors the server default (`DEFAULT_PROCESS_CAPTURE`).
const DEFAULT_CAPTURE: &str = "all";
/// Cadence du ping émis par l'agent, et délai au-delà duquel il considère le
/// serveur perdu.
///
/// Symétrique du battement de cœur côté serveur : sans lui, l'agent reste bloqué
/// dans `stream.next()` indéfiniment quand le serveur disparaît sans fermer la
/// socket — jusqu'au keepalive TCP du noyau, plus de deux heures. Il ne se
/// reconnectait donc pas, et se croyait supervisé.
const AGENT_PING_INTERVAL: Duration = Duration::from_secs(30);

/// Cadence par défaut du manifeste de persistance, jusqu'à ce que le serveur
/// pousse la sienne. Six heures : empreinter cinq cents fichiers ne se fait pas
/// au rythme d'un relevé CPU, et une porte dérobée installée reste installée.
const DEFAULT_INTEGRITY_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

/// Cadence du relevé d'authentification. Plus serrée que la persistance : une
/// campagne de tentatives se compte en minutes, pas en heures — mais la fenêtre
/// étant glissante, rien n'est perdu entre deux relevés.
const AUTH_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// Attend un ordre d'arrêt du système (SIGTERM) ou du terminal (Ctrl-C).
///
/// SIGTERM est celui que systemd et launchd envoient : sans le traiter, un arrêt
/// propre de la machine tuait l'agent avant qu'il n'ait pu fermer sa socket, et
/// le serveur ne l'apprenait que bien plus tard.
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = match signal(SignalKind::terminate()) {
            Ok(s) => s,
            Err(_) => return std::future::pending().await,
        };
        tokio::select! {
            _ = term.recv() => {}
            _ = tokio::signal::ctrl_c() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

/// Tunables for a run, set from the CLI.
pub struct RunOptions {
    /// Collect and send a single cycle, then exit (handy for testing).
    pub once: bool,
    /// Initial collection interval, until the server sends config.
    pub interval: Duration,
}

pub async fn run(config: Config, opts: RunOptions) -> Result<()> {
    let ws_url = config.ws_url()?;
    let device_id = config
        .device_id
        .clone()
        .context("device id missing; run `deveye-agent link <code>` first")?;

    if opts.once {
        info!(device_id = %device_id, "DevEye agent: single collection (--once)");
        return run_once(&ws_url, &device_id).await;
    }

    let mut collector = Collector::new();
    let mut queue: VecDeque<MetricSnapshot> = VecDeque::with_capacity(QUEUE_CAPACITY);
    let mut backoff = MIN_BACKOFF;
    // When the last connect-time full snapshot + processes were sent, kept across
    // sessions so reconnect loops can't multiply snapshots (see the gap constant).
    let mut last_full_snapshot: Option<Instant> = None;

    info!(device_id = %device_id, metric_interval_secs = opts.interval.as_secs(), "DevEye agent starting");

    loop {
        match stream_session(
            &config,
            &ws_url,
            &device_id,
            opts.interval,
            &mut collector,
            &mut queue,
            &mut last_full_snapshot,
        )
        .await
        {
            Ok(SessionOutcome::Established) => {
                info!(
                    delay_secs = RECONNECT_DELAY.as_secs(),
                    "connection closed by server, reconnecting"
                );
                backoff = MIN_BACKOFF;
                tokio::time::sleep(RECONNECT_DELAY).await;
            }
            Ok(SessionOutcome::Rejected) => {
                warn!(
                    retry_secs = REJECTED_RETRY.as_secs(),
                    "server rejected this agent (revoked, removed or not yet approved); retrying later"
                );
                tokio::time::sleep(REJECTED_RETRY).await;
            }
            Ok(SessionOutcome::Stop) => {
                info!("stop ordered by server; exiting (the service manager relaunches a supervised install)");
                return Ok(());
            }
            Ok(SessionOutcome::Restart) => {
                info!("restart ordered by server; relaunching");
                let exe = std::env::current_exe().context("locating agent executable")?;
                crate::update::restart_and_exit(&exe);
            }
            Err(e) => {
                warn!(error = %e, backoff_secs = backoff.as_secs(), "session error, retrying");
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(MAX_BACKOFF);
            }
        }
    }
}

/// How a connected session ended, so the caller can pick a reconnect delay.
enum SessionOutcome {
    /// We authenticated and ran (normal close / server restart) → reconnect fast.
    Established,
    /// The server closed us at the handshake (auth/authorization refused) before
    /// we ever received config → back off hard (`REJECTED_RETRY`).
    Rejected,
    /// The server ordered `agent.lifecycle stop` → exit the process. A supervised
    /// install comes back through its service manager; standalone stays down.
    Stop,
    /// The server ordered `agent.lifecycle restart` → exit and come back
    /// (manager relaunch when managed, self-respawn otherwise).
    Restart,
}

/// Connect once, push one full instant + the report, then exit.
async fn run_once(ws_url: &str, device_id: &str) -> Result<()> {
    let (ws_stream, _) = tokio_tungstenite::connect_async(ws_url)
        .await
        .context("connecting to agent WebSocket")?;
    let (mut sink, mut stream) = ws_stream.split();

    send_hello(&mut sink).await?;

    let mut collector = Collector::new();
    // Warm-up so the first CPU delta is meaningful.
    tokio::time::sleep(Duration::from_millis(250)).await;
    let (snapshot, sockets) = collect(&mut collector, DEFAULT_CAPTURE, true).await?;
    let msg = serde_json::to_string(&ClientMessage::MetricsBatch {
        device_id: device_id.to_string(),
        snapshots: vec![snapshot],
    })?;
    sink.send(Message::Text(msg))
        .await
        .context("sending metrics batch")?;
    send_report(&mut sink, device_id, &sockets).await?;
    info!("instant + report sent");

    // Give the server a moment to ack before closing.
    let _ = tokio::time::timeout(Duration::from_secs(3), async {
        if let Some(Ok(Message::Text(txt))) = stream.next().await {
            log_server_text(&txt);
        }
    })
    .await;
    sink.send(Message::Close(None)).await.ok();
    Ok(())
}

/// One connected session.
async fn stream_session(
    config: &Config,
    ws_url: &str,
    device_id: &str,
    initial_interval: Duration,
    collector: &mut Collector,
    queue: &mut VecDeque<MetricSnapshot>,
    last_collect: &mut Option<Instant>,
) -> Result<SessionOutcome> {
    let (ws_stream, _) = tokio_tungstenite::connect_async(ws_url)
        .await
        .context("connecting to agent WebSocket")?;
    info!("connected");
    let (mut sink, mut stream) = ws_stream.split();

    send_hello(&mut sink).await?;

    // Collection config — overwritten by the server's `agent.config` (sent on
    // connect, almost immediately) and on any later change.
    let mut interval = initial_interval;
    let mut capture = DEFAULT_CAPTURE.to_string();
    // Sentinelle : éteinte tant que le serveur ne l'a pas demandée. Un agent qui
    // relèverait « par défaut » lirait les journaux d'une machine que personne
    // n'a choisi de surveiller.
    let mut sentinel = false;
    let mut integrity_interval = DEFAULT_INTEGRITY_INTERVAL;
    let mut auth_enabled = true;
    // Fin du dernier relevé d'authentification, en unix ms. La fenêtre suivante
    // repart d'ici : additive, donc aucune tentative n'est comptée deux fois ni
    // perdue. `0` au premier passage — `authlog::collect` se limite alors à la
    // dernière heure plutôt que de rejouer un journal entier.
    let mut auth_cursor: i64 = 0;

    // Briefly wait for the server's pushed config so the very first instant
    // already reflects the saved per-device settings (capture mode + cadence),
    // whether the agent was offline at the time of the change or not.
    let cfg_deadline = Instant::now() + Duration::from_millis(2000);
    loop {
        let remaining = cfg_deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match tokio::time::timeout(remaining, stream.next()).await {
            Ok(Some(Ok(Message::Text(txt)))) => {
                match serde_json::from_str::<ServerMessage>(&txt) {
                    Ok(ServerMessage::Config {
                        metric_interval_ms,
                        process_capture,
                        sentinel_enabled,
                        integrity_interval_ms,
                        auth_events_enabled,
                    }) => {
                        capture = process_capture;
                        interval = Duration::from_millis(metric_interval_ms.max(1000));
                        sentinel = sentinel_enabled.unwrap_or(false);
                        if let Some(ms) = integrity_interval_ms {
                            integrity_interval = Duration::from_millis(ms.max(60_000));
                        }
                        auth_enabled = auth_events_enabled.unwrap_or(true);
                        break;
                    }
                    // The server may greet a pending-deletion device with destroy
                    // straight away, before any config.
                    Ok(ServerMessage::Destroy {}) => {
                        commands::handle_destroy(&mut sink, device_id).await;
                        // Only reached if self-destruct failed → end the session.
                        return Ok(SessionOutcome::Established);
                    }
                    // Ack/error/other: keep waiting until config or the deadline.
                    _ => {}
                }
            }
            Ok(Some(Ok(Message::Ping(payload)))) => {
                sink.send(Message::Pong(payload)).await.ok();
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(e))) => return Err(e).context("WebSocket stream error"),
            // Closed during the handshake, before any config: the server refused
            // us (revoked / unknown / not approved) → caller backs off hard.
            Ok(None) => return Ok(SessionOutcome::Rejected),
            Err(_) => break, // timeout: fall back to defaults
        }
    }

    // On connect: one immediate instant (so a fresh dashboard isn't blank),
    // skipped when the last one is recent — a reconnect loop must not mint an
    // instant per connection. Its socket probe then feeds the report, and the
    // queue flush replays anything buffered while offline.
    let due = last_collect.is_none_or(|t| t.elapsed() >= MIN_CONNECT_SNAPSHOT_GAP);
    let sockets = if due {
        let (snapshot, sockets) = collect(collector, &capture, true).await?;
        push_bounded(queue, snapshot);
        *last_collect = Some(Instant::now());
        sockets
    } else {
        sockets::read_sockets(true)
    };
    // Les métriques partent **avant** le rapport : elles sont ce que l'interface
    // attend, et le rapport peut être lent (voir `spawn_report`).
    flush_queue(&mut sink, device_id, queue).await?;

    // Le rapport voyage par ce canal, construit hors de la boucle.
    let (report_tx, mut report_rx) = tokio::sync::mpsc::channel::<DeviceReport>(4);
    spawn_report(&report_tx, &sockets);

    // Les relevés Sentinelle voyagent par ce canal, comme le rapport : ils
    // empreintent des centaines de fichiers et lisent des journaux, donc ils
    // tournent hors de la boucle, qui reste disponible pour les pings et les
    // métriques.
    let (scan_tx, mut scan_rx) = tokio::sync::mpsc::channel::<ScanResult>(4);
    if sentinel {
        // À la connexion : une machine qu'on vient d'allumer doit rendre son
        // état sans attendre le premier tour d'horloge.
        spawn_scan(&scan_tx, auth_enabled, auth_cursor);
    }

    let mut ticker = new_ticker(interval);
    let mut report_ticker = new_ticker(REPORT_INTERVAL);
    let mut integrity_ticker = new_ticker(integrity_interval);
    let mut auth_ticker = new_ticker(AUTH_INTERVAL);
    let mut ping_ticker = new_ticker(AGENT_PING_INTERVAL);
    // Remis à `true` par chaque `Pong` ; deux tours sans réponse ferment la
    // session, qui se rétablit par la boucle de reconnexion habituelle.
    let mut server_alive = true;
    // The socket map of the latest tick, reused by the next report so a report
    // never re-probes what a tick just enumerated.
    let mut last_sockets = sockets;

    // Package list/upgrade tasks run off the loop (an upgrade can take minutes) and
    // stream their results back through this channel, so the loop stays responsive
    // (pings, metrics) and forwards each event to the server as it arrives.
    let (pkg_tx, mut pkg_rx) = tokio::sync::mpsc::channel::<crate::packages::PkgEvent>(256);
    // Gestionnaires dont une mise à jour tourne, pour ne jamais en lancer deux.
    let mut pkg_running: HashSet<String> = HashSet::new();
    // Log source/query tasks (a query shells out to journalctl/docker and can return
    // many lines) stream their results back through this channel, same as packages.
    let (log_tx, mut log_rx) = tokio::sync::mpsc::channel::<crate::logs::LogEvent>(256);
    // Interactive terminals: PTY reader threads push output/exit events here; the
    // manager owns the live sessions and is dropped (killing shells) when we return.
    let (term_tx, mut term_rx) = tokio::sync::mpsc::channel::<crate::terminal::TermEvent>(1024);
    let mut terminals = crate::terminal::TermManager::new(term_tx);
    // File explorer tasks (list/analyze/search/mutate) stream their results here.
    let (files_tx, mut files_rx) = tokio::sync::mpsc::channel::<crate::files::FilesEvent>(256);
    // CloudSync: scans, uploads and the debounced watchers stream through here;
    // the manager owns assignments + watchers and is dropped with the session.
    let (sync_tx, mut sync_rx) = tokio::sync::mpsc::channel::<crate::sync::SyncEvent>(256);
    let mut sync_mgr = crate::sync::SyncManager::new(sync_tx);

    loop {
        tokio::select! {
            Some(report) = report_rx.recv() => {
                send_built_report(&mut sink, device_id, report).await?;
            }
            Some(result) = scan_rx.recv() => {
                if let Some(integrity) = result.integrity {
                    send_integrity(&mut sink, device_id, integrity).await?;
                }
                if let Some(auth) = result.auth {
                    // Le curseur n'avance qu'une fois la fenêtre **envoyée** :
                    // avancer à la collecte perdrait la fenêtre si la session
                    // tombait entre les deux, et avec elle les tentatives
                    // qu'elle comptait.
                    auth_cursor = auth.to;
                    send_auth(&mut sink, device_id, auth).await?;
                }
            }
            Some(ev) = pkg_rx.recv() => {
                if let crate::packages::PkgEvent::Done { manager, .. } = &ev {
                    pkg_running.remove(manager);
                }
                commands::send_pkg_event(&mut sink, device_id, ev).await;
            }
            Some(ev) = log_rx.recv() => {
                commands::send_log_event(&mut sink, device_id, ev).await;
            }
            Some(ev) = files_rx.recv() => {
                commands::send_files_event(&mut sink, device_id, ev).await;
            }
            Some(ev) = sync_rx.recv() => {
                commands::send_sync_event(&mut sink, device_id, ev).await;
            }
            Some(ev) = term_rx.recv() => {
                // A session that ended is also dropped from the manager (the reader
                // thread is already gone; this frees the slot + writer thread).
                if let crate::terminal::TermEvent::Exit { session_id, .. } = &ev {
                    terminals.close(session_id);
                }
                commands::send_term_event(&mut sink, device_id, ev).await;
            }
            _ = ticker.tick() => {
                let (snapshot, sockets) = collect(collector, &capture, false).await?;
                last_sockets = sockets;
                push_bounded(queue, snapshot);
                *last_collect = Some(Instant::now());
                flush_queue(&mut sink, device_id, queue).await?;
            }
            _ = shutdown_signal() => {
                // Arrêt demandé (systemd, Ctrl-C) : on ferme proprement pour que
                // le serveur enregistre le départ tout de suite. Sans ça l'agent
                // mourait sans trame de fermeture, et l'appareil restait affiché
                // « en ligne » jusqu'à expiration.
                info!("shutdown signal — closing the session");
                let _ = sink.send(Message::Close(None)).await;
                let _ = sink.flush().await;
                return Ok(SessionOutcome::Stop);
            }
            _ = ping_ticker.tick() => {
                if !server_alive {
                    warn!("no pong from the server — reconnecting");
                    return Ok(SessionOutcome::Established);
                }
                server_alive = false;
                if sink.send(Message::Ping(Vec::new())).await.is_err() {
                    return Ok(SessionOutcome::Established);
                }
            }
            _ = integrity_ticker.tick(), if sentinel => {
                spawn_scan(&scan_tx, false, auth_cursor);
            }
            _ = auth_ticker.tick(), if sentinel && auth_enabled => {
                spawn_scan_auth_only(&scan_tx, auth_cursor);
            }
            _ = report_ticker.tick() => {
                // The last tick's socket map already has everything — except on
                // macOS, where owner attribution needs the slower `lsof` that a
                // tick can't afford but an hourly report can.
                if cfg!(target_os = "macos") {
                    last_sockets = tokio::task::spawn_blocking(|| sockets::read_sockets(true)).await?;
                }
                spawn_report(&report_tx, &last_sockets);
            }
            incoming = stream.next() => {
                match incoming {
                    Some(Ok(Message::Text(txt))) => {
                        match serde_json::from_str::<ServerMessage>(&txt) {
                            // "Collect now" (user refresh): one full instant + report.
                            Ok(ServerMessage::Collect {}) => {
                                let (snapshot, sockets) = collect(collector, &capture, true).await?;
                                push_bounded(queue, snapshot);
                                *last_collect = Some(Instant::now());
                                flush_queue(&mut sink, device_id, queue).await?;
                                spawn_report(&report_tx, &sockets);
                                last_sockets = sockets;
                            }
                            Ok(ServerMessage::Config {
                                metric_interval_ms,
                                process_capture,
                                sentinel_enabled,
                                integrity_interval_ms,
                                auth_events_enabled,
                            }) => {
                                capture = process_capture;
                                let new_interval = Duration::from_millis(metric_interval_ms.max(1000));
                                if new_interval != interval {
                                    interval = new_interval;
                                    ticker = new_ticker(interval);
                                }
                                let was_on = sentinel;
                                sentinel = sentinel_enabled.unwrap_or(false);
                                auth_enabled = auth_events_enabled.unwrap_or(true);
                                if let Some(ms) = integrity_interval_ms {
                                    let next = Duration::from_millis(ms.max(60_000));
                                    if next != integrity_interval {
                                        integrity_interval = next;
                                        // Un changement d'intervalle **recrée** le
                                        // ticker : sans cela le nouveau réglage
                                        // n'aurait d'effet qu'au tour suivant, qui
                                        // peut être dans six heures.
                                        integrity_ticker = new_ticker(integrity_interval);
                                    }
                                }
                                // Vient d'être allumée : on relève tout de suite,
                                // sinon la première mesure attendrait six heures et
                                // l'utilisateur croirait la sonde en panne.
                                if sentinel && !was_on {
                                    spawn_scan(&scan_tx, auth_enabled, auth_cursor);
                                }
                                info!(
                                    interval_secs = interval.as_secs(),
                                    capture = %capture,
                                    sentinel,
                                    "applied server config"
                                );
                            }
                            // Relevé Sentinelle à la demande.
                            Ok(ServerMessage::Scan {}) => {
                                if sentinel {
                                    spawn_scan(&scan_tx, auth_enabled, auth_cursor);
                                } else {
                                    warn!("scan requested while Sentinel is off — ignored");
                                }
                            }
                            // Device deleted while we're online: wipe and exit.
                            Ok(ServerMessage::Destroy {}) => {
                                commands::handle_destroy(&mut sink, device_id).await;
                                // Only reached if self-destruct failed → end session.
                                return Ok(SessionOutcome::Established);
                            }
                            // Self-update: verify + swap the binary, then restart.
                            Ok(ServerMessage::Update {
                                target_id,
                                version,
                                sha256,
                                signature,
                            }) => {
                                commands::handle_update(
                                    &mut sink, config, device_id, &target_id, &version, &sha256, &signature,
                                )
                                .await;
                                // Only reached if the update was refused/failed → keep
                                // running on the current binary.
                            }
                            // Stop / clean restart of this process (from the UI).
                            Ok(ServerMessage::Lifecycle { action }) => match action.as_str() {
                                "stop" => {
                                    info!("lifecycle: stop ordered by server");
                                    return Ok(SessionOutcome::Stop);
                                }
                                "restart" => {
                                    info!("lifecycle: restart ordered by server");
                                    return Ok(SessionOutcome::Restart);
                                }
                                other => warn!(action = %other, "unknown lifecycle action ignored"),
                            },
                            // Persistence/privilege change (install autostart, elevate…).
                            Ok(ServerMessage::Service { action }) => {
                                commands::handle_service(&mut sink, device_id, &action).await;
                            }
                            // System power action (shutdown/reboot/suspend/hibernate/lock).
                            Ok(ServerMessage::Power { action }) => {
                                commands::handle_power(&mut sink, device_id, &action).await;
                            }
                            // Enumerate log sources (off-loop; replies via log_rx).
                            Ok(ServerMessage::LogSources {}) => {
                                tokio::spawn(crate::logs::detect_task(log_tx.clone()));
                            }
                            // Run a log query (off-loop; streams via log_rx).
                            Ok(ServerMessage::LogQuery {
                                query_id,
                                source_id,
                                filter,
                                limit,
                            }) => {
                                tokio::spawn(crate::logs::run_query_task(
                                    query_id,
                                    source_id,
                                    filter.unwrap_or_default(),
                                    limit.map(|l| l as usize).unwrap_or(crate::logs::DEFAULT_LIMIT),
                                    log_tx.clone(),
                                ));
                            }
                            // Open an interactive terminal (PTY + shell).
                            Ok(ServerMessage::TermOpen { session_id, cols, rows, user }) => {
                                if let Err(e) = terminals.open(session_id.clone(), cols, rows, user) {
                                    commands::send_term_event(
                                        &mut sink,
                                        device_id,
                                        crate::terminal::TermEvent::Exit {
                                            session_id,
                                            code: None,
                                            error: Some(e.to_string()),
                                        },
                                    )
                                    .await;
                                }
                            }
                            // Keystrokes for a terminal session (base64 → raw bytes).
                            Ok(ServerMessage::TermInput { session_id, data }) => {
                                if let Ok(bytes) =
                                    base64::engine::general_purpose::STANDARD.decode(data.as_bytes())
                                {
                                    terminals.input(&session_id, bytes);
                                }
                            }
                            // Resize a terminal session's PTY.
                            Ok(ServerMessage::TermResize { session_id, cols, rows }) => {
                                terminals.resize(&session_id, cols, rows);
                            }
                            // Close a terminal session (the reader then emits a final exit).
                            Ok(ServerMessage::TermClose { session_id }) => {
                                terminals.close(&session_id);
                            }
                            // File explorer (all off-loop; stream via files_rx).
                            Ok(ServerMessage::FilesList { op_id, path }) => {
                                tokio::spawn(crate::files::list_task(op_id, path, files_tx.clone()));
                            }
                            Ok(ServerMessage::FilesAnalyze { op_id, path }) => {
                                tokio::spawn(crate::files::analyze_task(op_id, path, files_tx.clone()));
                            }
                            Ok(ServerMessage::FilesSearch { op_id, path, filter }) => {
                                tokio::spawn(crate::files::search_task(op_id, path, filter, files_tx.clone()));
                            }
                            Ok(ServerMessage::FilesMutate { op_id, op, path, dest }) => {
                                tokio::spawn(crate::files::mutate_task(op_id, op, path, dest, files_tx.clone()));
                            }
                            // Download streams on its own thread (bounded by the channel).
                            Ok(ServerMessage::FilesDownload { op_id, path }) => {
                                crate::files::spawn_download(op_id, path, files_tx.clone());
                            }
                            // Upload chunks are applied inline (sequentially), so an
                            // offset-based write never races another chunk of the same file.
                            Ok(ServerMessage::FilesUpload { op_id, path, offset, data, done }) => {
                                let bytes = base64::engine::general_purpose::STANDARD
                                    .decode(data.as_bytes())
                                    .unwrap_or_default();
                                let res = tokio::task::spawn_blocking(move || {
                                    crate::files::upload_chunk(&path, offset, &bytes)
                                })
                                .await;
                                let outcome = match res {
                                    Ok(Ok(())) => Ok(()),
                                    Ok(Err(e)) => Err(e.to_string()),
                                    Err(e) => Err(e.to_string()),
                                };
                                // Report only the final chunk's outcome, or any error.
                                if done || outcome.is_err() {
                                    commands::send_files_event(
                                        &mut sink,
                                        device_id,
                                        crate::files::FilesEvent::Op {
                                            op_id,
                                            op: "upload".to_string(),
                                            ok: outcome.is_ok(),
                                            error: outcome.err(),
                                        },
                                    )
                                    .await;
                                }
                            }
                            // CloudSync: full assignment list (watchers started/stopped here).
                            Ok(ServerMessage::SyncConfig { shares }) => {
                                sync_mgr.apply_config(shares);
                            }
                            // CloudSync: scan the share's folder (off-loop; streams via sync_rx).
                            Ok(ServerMessage::SyncScan { session_id, share_id }) => {
                                sync_mgr.start_scan(session_id, share_id);
                            }
                            // CloudSync: upload one file (off-loop; streams via sync_rx).
                            Ok(ServerMessage::SyncPush { op_id, share_id, rel_path, start_offset }) => {
                                sync_mgr.start_push(op_id, share_id, rel_path, start_offset);
                            }
                            // CloudSync: install one download chunk. Applied inline
                            // (sequentially) like FilesUpload, so chunks of one op never race.
                            Ok(ServerMessage::SyncApplyChunk { op_id, share_id, rel_path, seq, data, done, hash, size, mtime, mode, resume_from }) => {
                                let bytes = base64::engine::general_purpose::STANDARD
                                    .decode(data.as_bytes())
                                    .unwrap_or_default();
                                let events = tokio::task::block_in_place(|| {
                                    sync_mgr.apply_chunk(&op_id, share_id, &rel_path, seq, &bytes, done, &hash, size, mtime, mode, resume_from)
                                });
                                for ev in events {
                                    commands::send_sync_event(&mut sink, device_id, ev).await;
                                }
                            }
                            // CloudSync: tell the server where to resume a download.
                            Ok(ServerMessage::SyncApplyStart { op_id, share_id, hash, .. }) => {
                                let ev = tokio::task::block_in_place(|| {
                                    sync_mgr.apply_start(&op_id, share_id, &hash)
                                });
                                commands::send_sync_event(&mut sink, device_id, ev).await;
                            }
                            // CloudSync: create an empty directory (no bytes transferred).
                            Ok(ServerMessage::SyncApplyDir { op_id, share_id, rel_path, kind, mode }) => {
                                let ev = tokio::task::block_in_place(|| {
                                    sync_mgr.apply_dir(&op_id, share_id, &rel_path, &kind, mode)
                                });
                                commands::send_sync_event(&mut sink, device_id, ev).await;
                            }
                            // CloudSync: install content already held elsewhere in the share
                            // (rename/move) by local copy — nothing crosses the network.
                            Ok(ServerMessage::SyncApplyLocal { op_id, share_id, rel_path, source_rel_path, hash, size, mtime, mode }) => {
                                let ev = tokio::task::block_in_place(|| {
                                    sync_mgr.apply_local(&op_id, share_id, &rel_path, &source_rel_path, &hash, size, mtime, mode)
                                });
                                commands::send_sync_event(&mut sink, device_id, ev).await;
                            }
                            // CloudSync: propagate a deletion (local trash, never unlink).
                            Ok(ServerMessage::SyncDelete { op_id, share_id, rel_path }) => {
                                let ev = tokio::task::block_in_place(|| {
                                    sync_mgr.delete(&op_id, share_id, &rel_path)
                                });
                                commands::send_sync_event(&mut sink, device_id, ev).await;
                            }
                            // Enumerate package managers (off-loop; replies via pkg_rx).
                            Ok(ServerMessage::PkgList {}) => {
                                let tx = pkg_tx.clone();
                                tokio::spawn(async move {
                                    let managers = tokio::task::spawn_blocking(crate::packages::detect)
                                        .await
                                        .unwrap_or_default();
                                    let _ = tx.send(crate::packages::PkgEvent::List(managers)).await;
                                });
                            }
                            // Apply a manager's updates (off-loop; streams via pkg_rx).
                            //
                            // Dernière barrière contre les exécutions doublées :
                            // le serveur tient le verrou, mais il le perd s'il
                            // redémarre pendant une mise à jour. Une demande en
                            // double est ignorée plutôt que refusée, et surtout
                            // pas terminée par un `Done` — celui-ci relâcherait
                            // le verrou de la mise à jour qui, elle, tourne.
                            Ok(ServerMessage::PkgUpgrade { manager }) => {
                                if pkg_running.insert(manager.clone()) {
                                    tokio::spawn(crate::packages::run_upgrade(
                                        manager,
                                        pkg_tx.clone(),
                                    ));
                                } else {
                                    warn!(%manager, "upgrade already running — request ignored");
                                }
                            }
                            Ok(ServerMessage::Ack { received }) => debug!(received, "ack"),
                            Ok(ServerMessage::Error { code, message }) => {
                                warn!(%code, %message, "server error")
                            }
                            Err(_) => debug!("ignoring unrecognized server frame"),
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        sink.send(Message::Pong(payload)).await.ok();
                    }
                    Some(Ok(Message::Pong(_))) => {
                        server_alive = true;
                    }
                    Some(Ok(Message::Close(_))) | None => return Ok(SessionOutcome::Established),
                    Some(Ok(_)) => {}
                    Some(Err(e)) => return Err(e).context("WebSocket stream error"),
                }
            }
        }
    }
}

/// A skip-on-miss interval ticker whose first tick fires one full period from
/// now (the connect-time sample/report has already been sent), avoiding the
/// immediate first tick of a plain `interval`.
fn new_ticker(period: Duration) -> tokio::time::Interval {
    let mut t = interval_at(Instant::now() + period, period);
    t.set_missed_tick_behavior(MissedTickBehavior::Skip);
    t
}

async fn send_hello<S>(sink: &mut S) -> Result<()>
where
    S: SinkExt<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    // Build target (e.g. `linux-x86_64`), injected by build.rs; empty on an
    // unrecognised triple, in which case we omit it (self-update then unavailable).
    let target = env!("DEVEYE_TARGET");
    let hello = serde_json::to_string(&ClientMessage::Hello {
        // Injected from the root package.json at build time (see build.rs), so the
        // agent reports the same version as the server/client.
        agent_version: env!("DEVEYE_VERSION").to_string(),
        target: (!target.is_empty()).then(|| target.to_string()),
    })?;
    sink.send(Message::Text(hello))
        .await
        .context("sending hello")?;
    Ok(())
}

/// Lance la construction du rapport **sans l'attendre**, et l'achemine par le
/// canal à la boucle, qui l'enverra.
///
/// Les sondes de sécurité sortent du processus, et l'une d'elles peut être très
/// lente : `apt-get -s upgrade` attend le verrou dpkg, ce qui se compte en
/// minutes sur une carte SD. Tant que le rapport était *attendu* avant d'entrer
/// dans la boucle, une telle machine ne remontait rien du tout — pas de
/// métriques, aucune commande traitée — tout en restant affichée « en ligne ».
///
/// Même schéma que les paquets, les journaux et les fichiers : la tâche vit
/// hors de la boucle, qui reste disponible pendant ce temps.
/// Ce qu'un relevé Sentinelle rapporte. Les deux sondes voyagent ensemble parce
/// qu'elles partent souvent ensemble (connexion, ordre `agent.scan`), mais
/// chacune peut manquer : la persistance est sautée par le relevé horaire
/// d'authentification, et l'authentification l'est quand elle est désactivée.
struct ScanResult {
    integrity: Option<crate::integrity::IntegrityReport>,
    auth: Option<crate::authlog::AuthWindow>,
}

/// Lance un relevé complet hors de la boucle.
///
/// `spawn_blocking` et non une tâche async : les deux sondes lisent des fichiers
/// et attendent des commandes externes. Les laisser sur le runtime bloquerait
/// les pings et les métriques pendant plusieurs secondes.
fn spawn_scan(tx: &tokio::sync::mpsc::Sender<ScanResult>, with_auth: bool, auth_from: i64) {
    let tx = tx.clone();
    tokio::task::spawn_blocking(move || {
        let result = ScanResult {
            integrity: Some(crate::integrity::collect()),
            auth: with_auth.then(|| crate::authlog::collect(auth_from)),
        };
        // Canal plein ou fermé = session finie : rien à rattraper.
        let _ = tx.blocking_send(result);
    });
}

/// Le relevé d'authentification seul, à sa propre cadence.
///
/// Séparé parce que les deux sondes n'ont pas le même prix : lire une fenêtre de
/// journal coûte quelques dizaines de millisecondes, empreinter les surfaces de
/// persistance en coûte cent fois plus. Les faire battre ensemble reviendrait à
/// payer la seconde toutes les heures pour rien.
fn spawn_scan_auth_only(tx: &tokio::sync::mpsc::Sender<ScanResult>, auth_from: i64) {
    let tx = tx.clone();
    tokio::task::spawn_blocking(move || {
        let _ = tx.blocking_send(ScanResult {
            integrity: None,
            auth: Some(crate::authlog::collect(auth_from)),
        });
    });
}

async fn send_integrity<S>(
    sink: &mut S,
    device_id: &str,
    integrity: crate::integrity::IntegrityReport,
) -> Result<()>
where
    S: SinkExt<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    let entries = integrity.entries.len();
    let msg = serde_json::to_string(&ClientMessage::Integrity {
        device_id: device_id.to_string(),
        integrity: Box::new(integrity),
    })?;
    sink.send(Message::Text(msg))
        .await
        .context("sending integrity manifest")?;
    debug!(entries, "integrity manifest sent");
    Ok(())
}

async fn send_auth<S>(sink: &mut S, device_id: &str, auth: crate::authlog::AuthWindow) -> Result<()>
where
    S: SinkExt<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    let (failed, accepted) = (auth.failed, auth.accepted);
    let msg = serde_json::to_string(&ClientMessage::AuthEvents {
        device_id: device_id.to_string(),
        auth: Box::new(auth),
    })?;
    sink.send(Message::Text(msg))
        .await
        .context("sending auth window")?;
    debug!(failed, accepted, "auth window sent");
    Ok(())
}

fn spawn_report(tx: &tokio::sync::mpsc::Sender<DeviceReport>, sockets: &SocketMap) {
    let listening = sockets.listening.clone();
    let established = sockets.established.clone();
    let tx = tx.clone();
    tokio::task::spawn_blocking(move || {
        let report = report::collect(listening, established);
        // `blocking_send` et non `send` : on est hors du runtime. Un canal plein
        // ou fermé signifie une session finie — rien à rattraper.
        let _ = tx.blocking_send(report);
    });
}

async fn send_report<S>(sink: &mut S, device_id: &str, sockets: &SocketMap) -> Result<()>
where
    S: SinkExt<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    // Security probes shell out — run off the runtime. The socket picture is
    // handed in (a tick already probed it), so no socket tool runs here.
    let listening = sockets.listening.clone();
    let established = sockets.established.clone();
    let report: DeviceReport =
        tokio::task::spawn_blocking(move || report::collect(listening, established))
            .await
            .context("collecting device report")?;
    send_built_report(sink, device_id, report).await
}

/// Envoie un rapport déjà construit.
async fn send_built_report<S>(sink: &mut S, device_id: &str, report: DeviceReport) -> Result<()>
where
    S: SinkExt<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    let msg = serde_json::to_string(&ClientMessage::Report {
        device_id: device_id.to_string(),
        report: Box::new(report),
    })?;
    sink.send(Message::Text(msg))
        .await
        .context("sending report")?;
    debug!("report sent");
    Ok(())
}

/// Collect one instant off the runtime: the scan shells out to `ps`/`ss` and
/// reads `/proc`, so it must not block the async loop. `deep` asks for socket
/// owner attribution even where that costs a slower tool (macOS).
async fn collect(
    collector: &mut Collector,
    capture: &str,
    deep: bool,
) -> Result<(MetricSnapshot, SocketMap)> {
    let sockets = tokio::task::spawn_blocking(move || sockets::read_sockets(deep))
        .await
        .context("probing sockets")?;
    Ok(collector.collect(capture, sockets))
}

/// Queue a snapshot, dropping the oldest when full, and trim process detail off
/// snapshots older than `PROCESS_QUEUE_LIMIT` — see the constant for why.
fn push_bounded(queue: &mut VecDeque<MetricSnapshot>, snapshot: MetricSnapshot) {
    if queue.len() >= QUEUE_CAPACITY {
        queue.pop_front();
    }
    queue.push_back(snapshot);
    if queue.len() > PROCESS_QUEUE_LIMIT {
        let cutoff = queue.len() - PROCESS_QUEUE_LIMIT;
        for snap in queue.iter_mut().take(cutoff) {
            if snap.processes.is_none() {
                break; // older entries were already trimmed
            }
            snap.processes = None;
            snap.process_kind = None;
        }
    }
}

/// Send queued snapshots in batches, dropping each batch once it has been handed
/// to the socket. (A send error propagates and leaves the rest queued for the next
/// connection; the bounded queue caps how much a long outage can accumulate.)
async fn flush_queue<S>(
    sink: &mut S,
    device_id: &str,
    queue: &mut VecDeque<MetricSnapshot>,
) -> Result<()>
where
    S: SinkExt<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    while !queue.is_empty() {
        // Grow the batch until it hits the count *or* the byte ceiling: with
        // process lists attached, 100 snapshots can be several megabytes.
        let mut take = 0;
        let mut bytes = 0;
        for snap in queue.iter().take(MAX_BATCH) {
            bytes += serde_json::to_string(snap).map(|s| s.len()).unwrap_or(0);
            take += 1;
            if bytes >= MAX_BATCH_BYTES {
                break;
            }
        }
        let snapshots: Vec<MetricSnapshot> = queue.iter().take(take).cloned().collect();
        let msg = serde_json::to_string(&ClientMessage::MetricsBatch {
            device_id: device_id.to_string(),
            snapshots,
        })?;
        sink.send(Message::Text(msg))
            .await
            .context("sending metrics batch")?;
        for _ in 0..take {
            queue.pop_front();
        }
        debug!(sent = take, "metrics batch sent");
    }
    Ok(())
}

fn log_server_text(txt: &str) {
    match serde_json::from_str::<ServerMessage>(txt) {
        Ok(ServerMessage::Ack { received }) => debug!(received, "ack"),
        Ok(ServerMessage::Error { code, message }) => warn!(%code, %message, "server error"),
        Ok(_) => {}
        Err(_) => debug!("ignoring unrecognized server frame"),
    }
}
