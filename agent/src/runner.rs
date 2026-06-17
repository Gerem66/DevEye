//! Long-running monitoring loop: maintain a permanent WebSocket to the server,
//! stream metric batches every cycle, and reconnect with exponential backoff.
//!
//! Samples collected while disconnected are buffered in a bounded in-memory
//! queue and flushed on reconnect, so transient outages don't lose data.

use std::collections::VecDeque;
use std::time::Duration;

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use tokio::time::{interval, MissedTickBehavior};
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, info, warn};

use crate::config::Config;
use crate::metrics::Collector;
use crate::protocol::{ClientMessage, MetricSnapshot, ServerMessage};

const SAMPLE_INTERVAL: Duration = Duration::from_secs(30);
const MAX_BATCH: usize = 100;
/// ~24h of 30s samples; oldest are dropped when full.
const QUEUE_CAPACITY: usize = 2880;
const MIN_BACKOFF: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(60);

pub async fn run(config: Config) -> Result<()> {
    let ws_url = config.ws_url()?;
    let device_id = config
        .device_id
        .clone()
        .context("device id missing; run `deveye-agent link <code>` first")?;

    let mut collector = Collector::new();
    let mut queue: VecDeque<MetricSnapshot> = VecDeque::with_capacity(QUEUE_CAPACITY);
    let mut backoff = MIN_BACKOFF;

    info!(device_id = %device_id, "DevEye agent starting");

    loop {
        match stream_session(&ws_url, &device_id, &mut collector, &mut queue).await {
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

/// One connected session: send hello, then sample + flush until the socket dies.
async fn stream_session(
    ws_url: &str,
    device_id: &str,
    collector: &mut Collector,
    queue: &mut VecDeque<MetricSnapshot>,
) -> Result<()> {
    let (ws_stream, _) = tokio_tungstenite::connect_async(ws_url)
        .await
        .context("connecting to agent WebSocket")?;
    info!("connected");
    let (mut sink, mut stream) = ws_stream.split();

    let hello = serde_json::to_string(&ClientMessage::Hello {
        agent_version: env!("CARGO_PKG_VERSION").to_string(),
    })?;
    sink.send(Message::Text(hello)).await.context("sending hello")?;

    let mut ticker = interval(SAMPLE_INTERVAL);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            _ = ticker.tick() => {
                push_bounded(queue, collector.collect());
                flush_queue(&mut sink, device_id, queue).await?;
            }
            incoming = stream.next() => {
                match incoming {
                    Some(Ok(Message::Text(txt))) => handle_server_text(&txt),
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

fn push_bounded(queue: &mut VecDeque<MetricSnapshot>, snapshot: MetricSnapshot) {
    if queue.len() >= QUEUE_CAPACITY {
        queue.pop_front();
    }
    queue.push_back(snapshot);
}

/// Send queued snapshots in batches; only drop those the server accepted.
async fn flush_queue<S>(sink: &mut S, device_id: &str, queue: &mut VecDeque<MetricSnapshot>) -> Result<()>
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
        sink.send(Message::Text(msg)).await.context("sending metrics batch")?;
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
        Err(_) => debug!("ignoring unrecognized server frame"),
    }
}
