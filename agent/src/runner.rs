//! Long-running monitoring loop: maintain a permanent WebSocket to the server,
//! stream metric batches, and reconnect with exponential backoff.
//!
//! Samples collected while disconnected are buffered in a bounded in-memory
//! queue and flushed on reconnect, so transient outages don't lose data.
//!
//! Two cadences (both pushed by the server via `agent.config`):
//! - **metrics** (light, ~10 s): cheap graph signals, no full process scan;
//! - **snapshots** (heavy, ~5 min): full metric sample (process count + disk I/O)
//!   plus the process list (`all`/`top`/`off`).
//!
//! The OS/security report is sent on connect and hourly. The first snapshot is
//! sent immediately on connect so the dashboard isn't blank.

use std::collections::VecDeque;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use tokio::time::{interval_at, Instant, MissedTickBehavior};
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, info, warn};

use crate::commands;
use crate::config::Config;
use crate::metrics::Collector;
use crate::protocol::{ClientMessage, DeviceReport, MetricSnapshot, ProcessSample, ServerMessage};
use crate::report;

const MAX_BATCH: usize = 100;
/// ~8 hours of 10-s samples; oldest are dropped when full.
const QUEUE_CAPACITY: usize = 2880;
const MIN_BACKOFF: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(60);
/// Retry delay after the server *rejects* us at the handshake (revoked, unknown
/// or not-yet-approved device). Much slower than a normal reconnect: a rejection
/// won't clear on its own, so we back off to roughly hourly to avoid hammering
/// the server (and to stay quiet from the outside).
const REJECTED_RETRY: Duration = Duration::from_secs(60 * 60);
/// How often to send the OS/security report.
const REPORT_INTERVAL: Duration = Duration::from_secs(60 * 60);
/// Defaults used until the server pushes `agent.config` (≈immediately on connect).
const DEFAULT_SNAPSHOT_INTERVAL: Duration = Duration::from_secs(300);
const DEFAULT_CAPTURE: &str = "all";

/// Tunables for a run, set from the CLI.
pub struct RunOptions {
    /// Collect and send a single cycle, then exit (handy for testing).
    pub once: bool,
    /// Initial metric (graph) sampling interval, until the server sends config.
    pub interval: Duration,
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
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

    info!(device_id = %device_id, metric_interval_secs = opts.interval.as_secs(), "DevEye agent starting");

    loop {
        match stream_session(
            &config,
            &ws_url,
            &device_id,
            opts.interval,
            &mut collector,
            &mut queue,
        )
        .await
        {
            Ok(SessionOutcome::Established) => {
                info!("connection closed by server, reconnecting");
                backoff = MIN_BACKOFF;
            }
            Ok(SessionOutcome::Rejected) => {
                warn!(
                    retry_secs = REJECTED_RETRY.as_secs(),
                    "server rejected this agent (revoked, removed or not yet approved); retrying later"
                );
                tokio::time::sleep(REJECTED_RETRY).await;
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
}

/// Connect once, push a report + one full snapshot + processes, then exit.
async fn run_once(ws_url: &str, device_id: &str) -> Result<()> {
    let (ws_stream, _) = tokio_tungstenite::connect_async(ws_url)
        .await
        .context("connecting to agent WebSocket")?;
    let (mut sink, mut stream) = ws_stream.split();

    send_hello(&mut sink).await?;
    send_report(&mut sink, device_id).await?;

    let mut collector = Collector::new();
    // Warm-up so the first CPU delta is meaningful.
    tokio::time::sleep(Duration::from_millis(250)).await;
    let snapshot = collector.collect_full();
    let msg = serde_json::to_string(&ClientMessage::MetricsBatch {
        device_id: device_id.to_string(),
        snapshots: vec![snapshot],
    })?;
    sink.send(Message::Text(msg))
        .await
        .context("sending metrics batch")?;
    send_processes(&mut sink, device_id, DEFAULT_CAPTURE).await?;
    info!("snapshot + processes + report sent");

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
    initial_metric_interval: Duration,
    collector: &mut Collector,
    queue: &mut VecDeque<MetricSnapshot>,
) -> Result<SessionOutcome> {
    let (ws_stream, _) = tokio_tungstenite::connect_async(ws_url)
        .await
        .context("connecting to agent WebSocket")?;
    info!("connected");
    let (mut sink, mut stream) = ws_stream.split();

    send_hello(&mut sink).await?;

    // Collection config — overwritten by the server's `agent.config` (sent on
    // connect, almost immediately) and on any later change.
    let mut metric_interval = initial_metric_interval;
    let mut snapshot_interval = DEFAULT_SNAPSHOT_INTERVAL;
    let mut capture = DEFAULT_CAPTURE.to_string();

    // Briefly wait for the server's pushed config so the very first snapshot
    // already reflects the saved per-device settings (capture mode + cadences),
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
                        snapshot_interval_ms,
                        process_capture,
                    }) => {
                        capture = process_capture;
                        metric_interval = Duration::from_millis(metric_interval_ms.max(1000));
                        snapshot_interval = Duration::from_millis(snapshot_interval_ms.max(1000));
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

    // On connect: slow-moving report + an immediate full snapshot + processes.
    send_report(&mut sink, device_id).await?;
    push_bounded(queue, collector.collect_full());
    flush_queue(&mut sink, device_id, queue).await?;
    send_processes(&mut sink, device_id, &capture).await?;

    let mut metric_ticker = new_ticker(metric_interval);
    let mut snapshot_ticker = new_ticker(snapshot_interval);
    let mut report_ticker = new_ticker(REPORT_INTERVAL);

    // Package list/upgrade tasks run off the loop (an upgrade can take minutes) and
    // stream their results back through this channel, so the loop stays responsive
    // (pings, metrics) and forwards each event to the server as it arrives.
    let (pkg_tx, mut pkg_rx) = tokio::sync::mpsc::channel::<crate::packages::PkgEvent>(256);
    // Log source/query tasks (a query shells out to journalctl/docker and can return
    // many lines) stream their results back through this channel, same as packages.
    let (log_tx, mut log_rx) = tokio::sync::mpsc::channel::<crate::logs::LogEvent>(256);
    // Interactive terminals: PTY reader threads push output/exit events here; the
    // manager owns the live sessions and is dropped (killing shells) when we return.
    let (term_tx, mut term_rx) = tokio::sync::mpsc::channel::<crate::terminal::TermEvent>(1024);
    let mut terminals = crate::terminal::TermManager::new(term_tx);
    // File explorer tasks (list/analyze/search/mutate) stream their results here.
    let (files_tx, mut files_rx) = tokio::sync::mpsc::channel::<crate::files::FilesEvent>(256);

    loop {
        tokio::select! {
            Some(ev) = pkg_rx.recv() => {
                commands::send_pkg_event(&mut sink, device_id, ev).await;
            }
            Some(ev) = log_rx.recv() => {
                commands::send_log_event(&mut sink, device_id, ev).await;
            }
            Some(ev) = files_rx.recv() => {
                commands::send_files_event(&mut sink, device_id, ev).await;
            }
            Some(ev) = term_rx.recv() => {
                // A session that ended is also dropped from the manager (the reader
                // thread is already gone; this frees the slot + writer thread).
                if let crate::terminal::TermEvent::Exit { session_id, .. } = &ev {
                    terminals.close(session_id);
                }
                commands::send_term_event(&mut sink, device_id, ev).await;
            }
            _ = metric_ticker.tick() => {
                push_bounded(queue, collector.collect_fine());
                flush_queue(&mut sink, device_id, queue).await?;
            }
            _ = snapshot_ticker.tick() => {
                push_bounded(queue, collector.collect_full());
                flush_queue(&mut sink, device_id, queue).await?;
                send_processes(&mut sink, device_id, &capture).await?;
            }
            _ = report_ticker.tick() => {
                send_report(&mut sink, device_id).await?;
            }
            incoming = stream.next() => {
                match incoming {
                    Some(Ok(Message::Text(txt))) => {
                        match serde_json::from_str::<ServerMessage>(&txt) {
                            // "Collect now" (user refresh): full snapshot + processes + report.
                            Ok(ServerMessage::Collect {}) => {
                                push_bounded(queue, collector.collect_full());
                                flush_queue(&mut sink, device_id, queue).await?;
                                send_processes(&mut sink, device_id, &capture).await?;
                                send_report(&mut sink, device_id).await?;
                            }
                            Ok(ServerMessage::Config {
                                metric_interval_ms,
                                snapshot_interval_ms,
                                process_capture,
                            }) => {
                                capture = process_capture;
                                let new_metric = Duration::from_millis(metric_interval_ms.max(1000));
                                if new_metric != metric_interval {
                                    metric_interval = new_metric;
                                    metric_ticker = new_ticker(metric_interval);
                                }
                                let new_snapshot = Duration::from_millis(snapshot_interval_ms.max(1000));
                                if new_snapshot != snapshot_interval {
                                    snapshot_interval = new_snapshot;
                                    snapshot_ticker = new_ticker(snapshot_interval);
                                }
                                info!(
                                    metric_secs = metric_interval.as_secs(),
                                    snapshot_secs = snapshot_interval.as_secs(),
                                    capture = %capture,
                                    "applied server config"
                                );
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
                            Ok(ServerMessage::PkgUpgrade { manager }) => {
                                tokio::spawn(crate::packages::run_upgrade(manager, pkg_tx.clone()));
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

async fn send_report<S>(sink: &mut S, device_id: &str) -> Result<()>
where
    S: SinkExt<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    // Security probes shell out — run off the runtime.
    let report: DeviceReport = tokio::task::spawn_blocking(report::collect)
        .await
        .context("collecting device report")?;
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

/// Collect and send the process list per the capture mode. `off` sends nothing.
async fn send_processes<S>(sink: &mut S, device_id: &str, capture: &str) -> Result<()>
where
    S: SinkExt<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    let kind = match capture {
        "top" => "top",
        "all" => "all",
        _ => return Ok(()), // "off" (or unknown): no process sample.
    };
    let cap = capture.to_string();
    let processes = tokio::task::spawn_blocking(move || report::collect_processes(&cap))
        .await
        .context("collecting processes")?;
    let sample = ProcessSample {
        ts: now_millis(),
        kind,
        processes,
    };
    let msg = serde_json::to_string(&ClientMessage::Processes {
        device_id: device_id.to_string(),
        sample,
    })?;
    sink.send(Message::Text(msg))
        .await
        .context("sending processes")?;
    debug!(kind, "processes sent");
    Ok(())
}

fn push_bounded(queue: &mut VecDeque<MetricSnapshot>, snapshot: MetricSnapshot) {
    if queue.len() >= QUEUE_CAPACITY {
        queue.pop_front();
    }
    queue.push_back(snapshot);
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
        let take = queue.len().min(MAX_BATCH);
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
