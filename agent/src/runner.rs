//! Long-running monitoring loop: maintain a permanent WebSocket to the server,
//! stream metric batches every cycle, and reconnect with exponential backoff.
//!
//! Samples collected while disconnected are buffered in a bounded in-memory
//! queue and flushed on reconnect, so transient outages don't lose data.
//!
//! The first sample (and a health/security report) are sent immediately on
//! connect, so the dashboard shows data without waiting a full interval.

use std::collections::VecDeque;
use std::time::Duration;

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use tokio::time::{interval, MissedTickBehavior};
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, info, warn};

use crate::config::Config;
use crate::metrics::Collector;
use crate::protocol::{ClientMessage, DeviceReport, MetricSnapshot, ServerMessage};
use crate::report;

const MAX_BATCH: usize = 100;
/// ~24h of 30s samples; oldest are dropped when full.
const QUEUE_CAPACITY: usize = 2880;
const MIN_BACKOFF: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(60);
/// How often to refresh the heavier health/security report.
const REPORT_INTERVAL: Duration = Duration::from_secs(120);

/// Tunables for a run, set from the CLI.
pub struct RunOptions {
    /// Collect and send a single cycle, then exit (handy for testing).
    pub once: bool,
    /// Time between metric samples.
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

    info!(device_id = %device_id, interval_secs = opts.interval.as_secs(), "DevEye agent starting");

    loop {
        match stream_session(
            &ws_url,
            &device_id,
            opts.interval,
            &mut collector,
            &mut queue,
        )
        .await
        {
            Ok(()) => {
                info!("connection closed by server, reconnecting");
                backoff = MIN_BACKOFF;
            }
            Err(e) => {
                warn!(error = %e, backoff_secs = backoff.as_secs(), "session error, retrying");
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(MAX_BACKOFF);
            }
        }
    }
}

/// Connect once, push one report + one snapshot, wait briefly for ack, exit.
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
    let snapshot = collector.collect();
    let msg = serde_json::to_string(&ClientMessage::MetricsBatch {
        device_id: device_id.to_string(),
        snapshots: vec![snapshot],
    })?;
    sink.send(Message::Text(msg))
        .await
        .context("sending metrics batch")?;
    info!("snapshot + report sent");

    // Give the server a moment to ack before closing.
    let _ = tokio::time::timeout(Duration::from_secs(3), async {
        if let Some(Ok(Message::Text(txt))) = stream.next().await {
            handle_server_text(&txt);
        }
    })
    .await;
    sink.send(Message::Close(None)).await.ok();
    Ok(())
}

/// One connected session: send hello + report, an immediate first sample, then
/// sample + flush on a ticker (and refresh the report periodically).
async fn stream_session(
    ws_url: &str,
    device_id: &str,
    sample_interval: Duration,
    collector: &mut Collector,
    queue: &mut VecDeque<MetricSnapshot>,
) -> Result<()> {
    let (ws_stream, _) = tokio_tungstenite::connect_async(ws_url)
        .await
        .context("connecting to agent WebSocket")?;
    info!("connected");
    let (mut sink, mut stream) = ws_stream.split();

    send_hello(&mut sink).await?;
    send_report(&mut sink, device_id).await?;

    // Immediate first sample (don't wait a full interval).
    push_bounded(queue, collector.collect());
    flush_queue(&mut sink, device_id, queue).await?;

    let mut ticker = interval(sample_interval);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut report_ticker = interval(REPORT_INTERVAL);
    report_ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    report_ticker.tick().await; // consume the immediate first tick (already sent)

    loop {
        tokio::select! {
            _ = ticker.tick() => {
                push_bounded(queue, collector.collect());
                flush_queue(&mut sink, device_id, queue).await?;
            }
            _ = report_ticker.tick() => {
                send_report(&mut sink, device_id).await?;
            }
            incoming = stream.next() => {
                match incoming {
                    Some(Ok(Message::Text(txt))) => {
                        // On a "collect now" request, push a fresh sample + report
                        // immediately so the dashboard reflects the live state.
                        if matches!(serde_json::from_str::<ServerMessage>(&txt), Ok(ServerMessage::Collect {})) {
                            push_bounded(queue, collector.collect());
                            flush_queue(&mut sink, device_id, queue).await?;
                            send_report(&mut sink, device_id).await?;
                        } else {
                            handle_server_text(&txt);
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        sink.send(Message::Pong(payload)).await.ok();
                    }
                    Some(Ok(Message::Close(_))) | None => return Ok(()),
                    Some(Ok(_)) => {}
                    Some(Err(e)) => return Err(e).context("WebSocket stream error"),
                }
            }
        }
    }
}

async fn send_hello<S>(sink: &mut S) -> Result<()>
where
    S: SinkExt<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    let hello = serde_json::to_string(&ClientMessage::Hello {
        agent_version: env!("CARGO_PKG_VERSION").to_string(),
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
    // Report collection sleeps briefly and scans processes — run off the runtime.
    let report: DeviceReport = tokio::task::spawn_blocking(report::collect)
        .await
        .context("collecting device report")?;
    let msg = serde_json::to_string(&ClientMessage::Report {
        device_id: device_id.to_string(),
        report,
    })?;
    sink.send(Message::Text(msg))
        .await
        .context("sending report")?;
    debug!("report sent");
    Ok(())
}

fn push_bounded(queue: &mut VecDeque<MetricSnapshot>, snapshot: MetricSnapshot) {
    if queue.len() >= QUEUE_CAPACITY {
        queue.pop_front();
    }
    queue.push_back(snapshot);
}

/// Send queued snapshots in batches; only drop those the server accepted.
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

fn handle_server_text(txt: &str) {
    match serde_json::from_str::<ServerMessage>(txt) {
        Ok(ServerMessage::Ack { received }) => debug!(received, "ack"),
        Ok(ServerMessage::Error { code, message }) => warn!(%code, %message, "server error"),
        // Collect is handled inline in the session loop before reaching here.
        Ok(ServerMessage::Collect {}) => {}
        Err(_) => debug!("ignoring unrecognized server frame"),
    }
}
