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
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
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
/// Plafond du recul exponentiel : un agent qui n'arrive pas à se connecter est
/// invisible, donc ce plafond est la durée maximale d'aveuglement du tableau
/// de bord.
const MAX_BACKOFF: Duration = Duration::from_secs(30);
/// Pause after a clean close (server restart, network blip) before dialing
/// again, drawn at random in this interval: after a server restart, every agent
/// of the fleet would otherwise come back at the same second, each firing a
/// connect-time snapshot.
const RECONNECT_DELAY_MIN: Duration = Duration::from_secs(1);
const RECONNECT_DELAY_MAX: Duration = Duration::from_secs(4);
/// The connect-time instant is skipped when the previous one is fresher than
/// this: reconnect loops must not multiply snapshots. The server can still force
/// one at any time via `agent.collect`.
const MIN_CONNECT_SNAPSHOT_GAP: Duration = Duration::from_secs(60);
/// Idem pour le rapport et le relevé Sentinelle, dont la cadence nominale est
/// l'heure : quinze minutes suffisent à éteindre une boucle de reconnexion sans
/// qu'un vrai démarrage perde quoi que ce soit (le jalon est alors `None`).
/// Détail dans `features/sentinel/README.md`.
const MIN_CONNECT_WORK_GAP: Duration = Duration::from_secs(15 * 60);
/// Échelle de reprise après un vrai refus du serveur (appareil inconnu, révoqué
/// ou supprimé : seul un nouveau `link` le fait revenir), doublée à chaque refus
/// consécutif et remise à zéro dès qu'une session s'établit : un refus
/// permanent finit à un essai par quart d'heure.
const REJECTED_MIN: Duration = Duration::from_secs(60);
const REJECTED_MAX: Duration = Duration::from_secs(15 * 60);
/// Close code of an authenticated agent whose device waits for approval (a
/// re-link). Mirrors `AGENT_CLOSE_PENDING_APPROVAL` in `@deveye/types`.
const CLOSE_PENDING_APPROVAL: u16 = 4001;
/// Retry delay while the device waits for approval: short and fixed, so an
/// approval in DevEye takes effect within half a minute.
const PENDING_RETRY: Duration = Duration::from_secs(30);
/// How often to send the OS/security report.
const REPORT_INTERVAL: Duration = Duration::from_secs(60 * 60);
/// Default used until the server pushes `agent.config` (≈immediately on
/// connect). Mirrors the server default (`DEFAULT_PROCESS_CAPTURE`).
const DEFAULT_CAPTURE: &str = "all";
/// Silence du serveur au-delà duquel l'agent considère le lien mort.
///
/// L'agent n'émet aucun ping : le serveur le pingue déjà (`AGENT_HEARTBEAT_MS`),
/// il suffit de constater que la trame n'arrive plus. Ne pas réintroduire un
/// ping émis d'ici : le délai de silence couvre aussi le cas d'un serveur
/// disparu sans fermer la socket (sinon bloqué dans `stream.next()` jusqu'au
/// keepalive TCP, plus de deux heures), sans envoyer un octet.
///
/// Doit rester au-dessus de deux fois `AGENT_HEARTBEAT_MS` (60 s), sinon un
/// balayage en retard sous charge ferait reconnecter des agents sains.
const SERVER_SILENCE_LIMIT: Duration = Duration::from_secs(150);

/// Cadence du contrôle de sortie de veille, et écart au-delà duquel on conclut
/// que la machine a dormi. Voir le bras `wake_ticker` de la boucle.
const WAKE_CHECK_INTERVAL: Duration = Duration::from_secs(1);
const WAKE_SKEW_THRESHOLD: Duration = Duration::from_secs(10);

/// Cadence par défaut du manifeste de persistance, jusqu'à ce que le serveur
/// pousse la sienne : empreinter cinq cents fichiers ne se fait pas au rythme
/// d'un relevé CPU.
const DEFAULT_INTEGRITY_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

/// Cadence du relevé d'authentification. Plus serrée que la persistance : une
/// campagne de tentatives se compte en minutes, pas en heures — mais la fenêtre
/// étant glissante, rien n'est perdu entre deux relevés.
const AUTH_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// Tirage uniforme dans `[min, max]`, pour désynchroniser une flotte entière :
/// un recul exponentiel nu garde les agents en phase (chacun double au même
/// instant que les autres).
/// How a close frame received before the config ends the session. `1008` is
/// the ONLY code by which the server refuses an agent (`deny()` in
/// `src/agent/ws.ts`, identical for unknown, revoked and removed devices);
/// `CLOSE_PENDING_APPROVAL` means "linked again, not yet approved". Any other
/// code is an accident: `1012` "session replaced", `1001` server shutdown.
fn outcome_of_close(code: Option<CloseCode>) -> SessionOutcome {
    match code {
        Some(CloseCode::Policy) => SessionOutcome::Rejected,
        Some(CloseCode::Library(CLOSE_PENDING_APPROVAL)) => SessionOutcome::PendingApproval,
        _ => SessionOutcome::Established,
    }
}

pub(crate) fn jittered(min: Duration, max: Duration) -> Duration {
    if max <= min {
        return min;
    }
    let span = (max - min).as_millis() as u64;
    min + Duration::from_millis(rand::Rng::gen_range(&mut rand::thread_rng(), 0..=span))
}

/// Un travail périodique fait à la connexion doit-il être rejoué ?
///
/// `None` = jamais fait dans ce processus (démarrage) : on le fait. Sinon
/// seulement si le précédent a dépassé `gap`, ce qui empêche une boucle de
/// reconnexion de multiplier un travail coûteux. `now` est un paramètre pour
/// que la décision soit testable.
///
/// `Instant` est relatif au processus : un agent qui plante en boucle repart de
/// `None` et rejoue ; le plancher côté serveur rattrape ce cas.
fn due_at(last: Option<Instant>, now: Instant, gap: Duration) -> bool {
    match last {
        None => true,
        Some(previous) => now.saturating_duration_since(previous) >= gap,
    }
}

/// Ce que ce processus a déjà fait, conservé d'une session à l'autre : vit dans
/// la boucle externe, jamais dans la session, pour que les gardes reconnaissent
/// une reconnexion.
#[derive(Default)]
struct ConnectMarks {
    /// Dernier instant complet (métriques + liste de processus).
    snapshot: Option<Instant>,
    /// Dernier rapport OS/sécurité émis.
    report: Option<Instant>,
    /// Dernier relevé Sentinelle émis.
    scan: Option<Instant>,
}

/// Attend un ordre d'arrêt du système (SIGTERM, celui que systemd et launchd
/// envoient) ou du terminal (Ctrl-C), pour fermer la socket avant de mourir.
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

pub async fn run(mut config: Config, opts: RunOptions) -> Result<()> {
    // Built once here to fail early on a missing token; each session rebuilds it,
    // since the server may have rotated the token in between.
    config.ws_request()?;
    let device_id = config
        .device_id
        .clone()
        .context("device id missing; run `deveye-agent link <code>` first")?;

    if opts.once {
        info!(device_id = %device_id, "DevEye agent: single collection (--once)");
        return run_once(&config, &device_id).await;
    }
    // Across reconnects: an order captured on one connection must not pass on the next.
    let mut guard = crate::orders::OrderGuard::new(config.order_key.as_deref());
    if !guard.has_key() {
        warn!(
            "no usable order-signing key pinned: terminal, file writes, power, upgrades, elevation \
             and removal orders will be refused until this machine is re-linked (`deveye-agent link`)"
        );
    }

    let mut collector = Collector::new();
    let mut queue: VecDeque<MetricSnapshot> = VecDeque::with_capacity(QUEUE_CAPACITY);
    let mut backoff = MIN_BACKOFF;
    // Refus consécutifs, pour l'échelle `REJECTED_MIN` → `REJECTED_MAX`.
    let mut rejected_streak: u32 = 0;
    let mut marks = ConnectMarks::default();

    info!(device_id = %device_id, metric_interval_secs = opts.interval.as_secs(), "DevEye agent starting");

    loop {
        match stream_session(
            &mut config,
            &mut guard,
            &device_id,
            opts.interval,
            &mut collector,
            &mut queue,
            &mut marks,
        )
        .await
        {
            Ok(SessionOutcome::Established) => {
                let delay = jittered(RECONNECT_DELAY_MIN, RECONNECT_DELAY_MAX);
                info!(
                    delay_ms = delay.as_millis() as u64,
                    "connection closed by server, reconnecting"
                );
                backoff = MIN_BACKOFF;
                rejected_streak = 0;
                tokio::time::sleep(delay).await;
            }
            Ok(SessionOutcome::Woke) => {
                // Aucune attente : c'est le SEUL cas où l'on sait déjà que la
                // session précédente ne vaut plus rien. `sink.send` sur une
                // socket morte réussit (tampon du noyau), donc attendre le
                // prochain ping reviendrait à parler dans le vide.
                info!("resuming from sleep, reconnecting immediately");
                backoff = MIN_BACKOFF;
                rejected_streak = 0;
            }
            Ok(SessionOutcome::Rejected) => {
                // Plafonné avant le décalage pour ne jamais déborder `u32`.
                let step = REJECTED_MIN * 2u32.saturating_pow(rejected_streak.min(8));
                let delay = jittered(REJECTED_MIN, step.min(REJECTED_MAX));
                rejected_streak = rejected_streak.saturating_add(1);
                warn!(
                    retry_secs = delay.as_secs(),
                    streak = rejected_streak,
                    "refused by the server (unknown, revoked or removed device): run `deveye-agent link` again on this machine"
                );
                tokio::time::sleep(delay).await;
            }
            Ok(SessionOutcome::PendingApproval) => {
                backoff = MIN_BACKOFF;
                rejected_streak = 0;
                let delay = jittered(PENDING_RETRY, PENDING_RETRY + PENDING_RETRY / 3);
                info!(
                    retry_secs = delay.as_secs(),
                    "device awaiting approval in DevEye (Appareils, Agent popup); retrying"
                );
                tokio::time::sleep(delay).await;
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
                // « Full jitter » : on dort dans `[MIN_BACKOFF, backoff]` plutôt
                // que `backoff` tout rond. C'est ce qui disperse réellement une
                // flotte, là où un recul exponentiel nu la garde en phase.
                let delay = jittered(MIN_BACKOFF, backoff);
                warn!(error = %e, backoff_secs = delay.as_secs(), "session error, retrying");
                tokio::time::sleep(delay).await;
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
    /// we ever received config → back off hard (`REJECTED_MIN`..`REJECTED_MAX`).
    /// Réservé à une fermeture 1008, le SEUL code par lequel le serveur refuse un
    /// agent (`deny()` dans `src/agent/ws.ts`).
    Rejected,
    /// The server closed us at the handshake with `CLOSE_PENDING_APPROVAL`: the
    /// device was linked again and waits for approval → retry on `PENDING_RETRY`.
    PendingApproval,
    /// La machine sort de veille : la socket est presque certainement morte, et
    /// on le sait sans attendre le prochain ping → reconnexion immédiate.
    Woke,
    /// The server ordered `agent.lifecycle stop` → exit the process. A supervised
    /// install comes back through its service manager; standalone stays down.
    Stop,
    /// The server ordered `agent.lifecycle restart` → exit and come back
    /// (manager relaunch when managed, self-respawn otherwise).
    Restart,
}

/// This machine's clock, unix ms: what an order's `issuedAt` is compared to.
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Connect once, push one full instant + the report, then exit.
async fn run_once(config: &Config, device_id: &str) -> Result<()> {
    let (ws_stream, _) = tokio_tungstenite::connect_async(config.ws_request()?)
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
    config: &mut Config,
    guard: &mut crate::orders::OrderGuard,
    device_id: &str,
    initial_interval: Duration,
    collector: &mut Collector,
    queue: &mut VecDeque<MetricSnapshot>,
    marks: &mut ConnectMarks,
) -> Result<SessionOutcome> {
    let (ws_stream, _) = tokio_tungstenite::connect_async(config.ws_request()?)
        .await
        .context("connecting to agent WebSocket")?;
    info!("connected");
    let (mut sink, mut stream) = ws_stream.split();

    send_hello(&mut sink).await?;

    // Collection config — overwritten by the server's `agent.config` (sent on
    // connect, almost immediately) and on any later change.
    let mut interval = initial_interval;
    let mut capture = DEFAULT_CAPTURE.to_string();
    // Sentinelle : éteinte tant que le serveur ne l'a pas demandée, pour ne pas
    // lire les journaux d'une machine que personne n'a choisi de surveiller.
    let mut sentinel = false;
    let mut integrity_interval = DEFAULT_INTEGRITY_INTERVAL;
    let mut auth_enabled = true;
    // Fin du dernier relevé d'authentification, en unix ms ; la fenêtre suivante
    // repart d'ici. `0` au premier passage (voir `authlog::collect`).
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
                if let crate::orders::Admission::Refused {
                    command,
                    payload,
                    reason,
                } = crate::orders::admit(&txt, guard, &config.policy, now_ms())
                {
                    commands::refuse_order(&mut sink, device_id, &command, &payload, &reason).await;
                    continue;
                }
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
            // C'est ici que se décide « refusé » ou « en attente » contre
            // « incident de transport » (voir `outcome_of_close`).
            Ok(Some(Ok(Message::Close(frame)))) => {
                let code = frame.map(|f| f.code);
                warn!(?code, "server closed during the config window");
                return Ok(outcome_of_close(code));
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(e))) => return Err(e).context("WebSocket stream error"),
            // Flux terminé sans trame de fermeture : c'est une fin de transport
            // brutale, pas un refus. Un refus ou une attente arrive toujours par
            // une trame de fermeture, traitée juste au-dessus.
            Ok(None) => return Ok(SessionOutcome::Established),
            Err(_) => break, // timeout: fall back to defaults
        }
    }

    // On connect: one immediate instant (so a fresh dashboard isn't blank),
    // skipped when the last one is recent (a reconnect loop must not mint an
    // instant per connection). Its socket probe then feeds the report.
    let due = due_at(marks.snapshot, Instant::now(), MIN_CONNECT_SNAPSHOT_GAP);
    let sockets = if due {
        let (snapshot, sockets) = collect(collector, &capture, true).await?;
        push_bounded(queue, snapshot);
        marks.snapshot = Some(Instant::now());
        sockets
    } else {
        sockets::read_sockets(true)
    };
    // Les métriques partent avant le rapport : elles sont ce que l'interface
    // attend, et le rapport peut être lent (voir `spawn_report`).
    flush_queue(&mut sink, device_id, queue).await?;

    // Le rapport voyage par ce canal, construit hors de la boucle. Borné par le
    // même garde que l'instant : c'est le travail le plus lourd de la connexion,
    // et le serveur réévalue ses règles de sécurité à chaque rapport reçu.
    let (report_tx, mut report_rx) = tokio::sync::mpsc::channel::<DeviceReport>(4);
    if due_at(marks.report, Instant::now(), MIN_CONNECT_WORK_GAP) {
        spawn_report(&report_tx, &sockets);
        marks.report = Some(Instant::now());
    }

    // Les relevés Sentinelle voyagent par ce canal, comme le rapport : ils
    // empreintent des centaines de fichiers, donc ils tournent hors de la boucle.
    let (scan_tx, mut scan_rx) = tokio::sync::mpsc::channel::<ScanResult>(4);
    if sentinel && due_at(marks.scan, Instant::now(), MIN_CONNECT_WORK_GAP) {
        // Une machine qu'on vient d'allumer rend son état sans attendre le
        // premier tour d'horloge ; le garde refuse de le rejouer à chaque reconnexion.
        spawn_scan(&scan_tx, auth_enabled, auth_cursor);
        marks.scan = Some(Instant::now());
    }

    let mut ticker = new_ticker(interval);
    let mut report_ticker = new_ticker(REPORT_INTERVAL);
    let mut integrity_ticker = new_ticker(integrity_interval);
    let mut auth_ticker = new_ticker(AUTH_INTERVAL);
    // Dernière trame REÇUE du serveur, quelle qu'elle soit : la seule mesure de
    // vivacité du lien côté agent.
    let mut last_seen = Instant::now();
    // Détection de sortie de veille. `Instant` est monotone et n'avance PAS
    // pendant la suspension ; `SystemTime` est relue de l'horloge matérielle au
    // réveil. L'écart entre les deux est donc la durée du sommeil, sans code par
    // plateforme ni abonnement à logind, IOPMrootDomain ou WM_POWERBROADCAST.
    let mut wake_ticker = new_ticker(WAKE_CHECK_INTERVAL);
    let mut last_mono = Instant::now();
    let mut last_wall = std::time::SystemTime::now();
    // The socket map of the latest tick, reused by the next report so a report
    // never re-probes what a tick just enumerated.
    let mut last_sockets = sockets;

    // Package list/upgrade tasks run off the loop (an upgrade can take minutes)
    // and stream their results back through this channel.
    let (pkg_tx, mut pkg_rx) = tokio::sync::mpsc::channel::<crate::packages::PkgEvent>(256);
    // Gestionnaires dont une mise à jour tourne, pour ne jamais en lancer deux.
    let mut pkg_running: HashSet<String> = HashSet::new();
    // Container inventory/stats/actions run off the loop (a pull or a prune takes
    // minutes) and stream back here, same as packages.
    let (docker_tx, mut docker_rx) = tokio::sync::mpsc::channel::<crate::docker::DockerEvent>(256);
    // L'action longue en cours, s'il y en a une : le serveur tient déjà un
    // verrou, celui-ci lui survit s'il redémarre. On retient l'`opId` et non un
    // booléen, sans quoi la fin d'une action brève relâcherait le verrou d'une
    // longue toujours en cours.
    let mut docker_long: Option<String> = None;
    // Log source/query tasks (a query shells out to journalctl/docker and can return
    // many lines) stream their results back through this channel, same as packages.
    let (log_tx, mut log_rx) = tokio::sync::mpsc::channel::<crate::logs::LogEvent>(256);
    // Interactive terminals: PTY reader threads push output/exit events here; the
    // manager owns the live sessions and is dropped (killing shells) when we return.
    let (term_tx, mut term_rx) = tokio::sync::mpsc::channel::<crate::terminal::TermEvent>(1024);
    let mut terminals = crate::terminal::TermManager::new(term_tx);
    // File explorer tasks (list/analyze/search/mutate) stream their results here.
    let (files_tx, mut files_rx) = tokio::sync::mpsc::channel::<crate::files::FilesEvent>(256);
    // Folder archives run on their own threads under the server's credits; the
    // manager cancels them all when the session ends.
    let mut archives = crate::archive::ArchiveManager::new(files_tx.clone());
    // CloudSync: scans, uploads and the debounced watchers stream through here;
    // the manager owns assignments + watchers and is dropped with the session.
    let (sync_tx, mut sync_rx) = tokio::sync::mpsc::channel::<crate::sync::SyncEvent>(256);
    let mut sync_mgr = crate::sync::SyncManager::new(sync_tx, config.sync_roots.clone());
    // Tunnels: each relays one TCP connection under the server's credits; the
    // manager drops them all when the session ends.
    let (tunnel_tx, mut tunnel_rx) = tokio::sync::mpsc::channel::<crate::tunnel::TunnelEvent>(256);
    let mut tunnels = crate::tunnel::TunnelManager::new(tunnel_tx, config.tunnel_targets.clone());

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
                    // Le curseur n'avance qu'une fois la fenêtre envoyée : avancer
                    // à la collecte perdrait la fenêtre si la session tombait
                    // entre les deux.
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
            Some(ev) = docker_rx.recv() => {
                if let crate::docker::DockerEvent::Done { op_id, .. } = &ev {
                    if docker_long.as_deref() == Some(op_id.as_str()) {
                        docker_long = None;
                    }
                }
                commands::send_docker_event(&mut sink, device_id, ev).await;
            }
            Some(ev) = log_rx.recv() => {
                commands::send_log_event(&mut sink, device_id, ev).await;
            }
            Some(ev) = files_rx.recv() => {
                if let crate::files::FilesEvent::ArchiveEnd { op_id, .. } = &ev {
                    archives.forget(op_id);
                }
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
            Some(ev) = tunnel_rx.recv() => {
                if let crate::tunnel::TunnelEvent::Closed { tunnel_id, .. } = &ev {
                    tunnels.close(tunnel_id);
                }
                commands::send_tunnel_event(&mut sink, device_id, ev).await;
            }
            _ = ticker.tick() => {
                let (snapshot, sockets) = collect(collector, &capture, false).await?;
                last_sockets = sockets;
                push_bounded(queue, snapshot);
                marks.snapshot = Some(Instant::now());
                flush_queue(&mut sink, device_id, queue).await?;
            }
            _ = shutdown_signal() => {
                // Fermeture propre pour que le serveur enregistre le départ tout
                // de suite, plutôt qu'à l'expiration.
                info!("shutdown signal — closing the session");
                let _ = sink.send(Message::Close(None)).await;
                let _ = sink.flush().await;
                return Ok(SessionOutcome::Stop);
            }
            _ = wake_ticker.tick() => {
                // Contrôle de silence, logé dans le ticker du réveil : il n'émet
                // rien, donc pas besoin d'une cadence à lui.
                if last_seen.elapsed() > SERVER_SILENCE_LIMIT {
                    warn!(
                        silent_secs = last_seen.elapsed().as_secs(),
                        "server silent for too long — reconnecting"
                    );
                    return Ok(SessionOutcome::Established);
                }
                let now_mono = Instant::now();
                let now_wall = std::time::SystemTime::now();
                let mono = now_mono.saturating_duration_since(last_mono);
                // Un saut d'horloge EN ARRIÈRE (NTP qui recule) rend une erreur :
                // on retombe sur l'écart monotone et on ne conclut rien, sinon
                // chaque correction d'horloge ferait reconnecter.
                let wall = now_wall.duration_since(last_wall).unwrap_or(mono);
                last_mono = now_mono;
                last_wall = now_wall;
                if wall > mono + WAKE_SKEW_THRESHOLD {
                    warn!(slept_secs = (wall - mono).as_secs(), "wake from sleep detected");
                    // Le tableau de bord affiche encore l'état d'avant la veille :
                    // on rouvre le droit à l'instant de connexion. Ni `marks.report`
                    // ni `marks.scan` : un portable ouvert dix fois par jour
                    // rejouerait sinon dix rapports lourds alors que rien n'a bougé.
                    marks.snapshot = None;
                    // Rien ne garantit qu'une surveillance inotify / FSEvents ait
                    // survécu à la suspension (voir `mark_all_dirty`).
                    sync_mgr.mark_all_dirty();
                    // Pas de trame de fermeture : `send` sur une socket à moitié
                    // morte peut bloquer jusqu'au délai de retransmission TCP.
                    // Sortir suffit, le descripteur est fermé au drop.
                    return Ok(SessionOutcome::Woke);
                }
            }
            _ = integrity_ticker.tick(), if sentinel => {
                // Les tickers posent le jalon eux aussi, sinon un relevé fait à
                // l'horloge serait rejoué par la reconnexion suivante.
                spawn_scan(&scan_tx, false, auth_cursor);
                marks.scan = Some(Instant::now());
            }
            _ = auth_ticker.tick(), if sentinel && auth_enabled => {
                spawn_scan_auth_only(&scan_tx, auth_cursor);
                marks.scan = Some(Instant::now());
            }
            _ = report_ticker.tick() => {
                // The last tick's socket map already has everything — except on
                // macOS, where owner attribution needs the slower `lsof` that a
                // tick can't afford but an hourly report can.
                if cfg!(target_os = "macos") {
                    last_sockets = tokio::task::spawn_blocking(|| sockets::read_sockets(true)).await?;
                }
                spawn_report(&report_tx, &last_sockets);
                marks.report = Some(Instant::now());
            }
            incoming = stream.next() => {
                // AVANT le tri : ping, pong, texte ou binaire, toute trame prouve
                // que le lien est vivant.
                if matches!(incoming, Some(Ok(_))) {
                    last_seen = Instant::now();
                }
                match incoming {
                    Some(Ok(Message::Text(txt))) => {
                        if let crate::orders::Admission::Refused { command, payload, reason } =
                            crate::orders::admit(&txt, guard, &config.policy, now_ms())
                        {
                            commands::refuse_order(&mut sink, device_id, &command, &payload, &reason).await;
                            continue;
                        }
                        match serde_json::from_str::<ServerMessage>(&txt) {
                            // "Collect now" (user refresh): one full instant + report.
                            Ok(ServerMessage::Collect {}) => {
                                let (snapshot, sockets) = collect(collector, &capture, true).await?;
                                push_bounded(queue, snapshot);
                                marks.snapshot = Some(Instant::now());
                                flush_queue(&mut sink, device_id, queue).await?;
                                // Demandé explicitement : jamais borné, mais le
                                // jalon est posé pour qu'une reconnexion ne le refasse pas.
                                spawn_report(&report_tx, &sockets);
                                marks.report = Some(Instant::now());
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
                                        // Recréer le ticker : sinon le nouveau réglage
                                        // n'aurait d'effet qu'au tour suivant, dans six heures.
                                        integrity_ticker = new_ticker(integrity_interval);
                                    }
                                }
                                // Vient d'être allumée : on relève tout de suite,
                                // sinon la première mesure attendrait six heures.
                                // Borné, parce que ce chemin est aussi celui d'une
                                // config arrivée après le délai de l'accueil, où
                                // `was_on` est faux à chaque connexion.
                                if sentinel
                                    && !was_on
                                    && due_at(marks.scan, Instant::now(), MIN_CONNECT_WORK_GAP)
                                {
                                    spawn_scan(&scan_tx, auth_enabled, auth_cursor);
                                    marks.scan = Some(Instant::now());
                                }
                                info!(
                                    interval_secs = interval.as_secs(),
                                    capture = %capture,
                                    sentinel,
                                    "applied server config"
                                );
                            }
                            // Relevé Sentinelle à la demande. Jamais borné (c'est un
                            // ordre explicite), mais pose le jalon comme les autres.
                            Ok(ServerMessage::Scan {}) => {
                                if sentinel {
                                    spawn_scan(&scan_tx, auth_enabled, auth_cursor);
                                    marks.scan = Some(Instant::now());
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
                            // The server replaced the token before it expires. Kept
                            // in memory even if the save fails: the server still
                            // accepts the old one until the new one has been used.
                            Ok(ServerMessage::TokenRotate { token }) => {
                                match Config::persist_rotated_token(device_id, &token) {
                                    Ok(()) => info!("device token rotated"),
                                    Err(e) => warn!(error = %e, "rotated token could not be saved"),
                                }
                                config.device_token = Some(token);
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
                                offset,
                                anchor,
                            }) => {
                                tokio::spawn(crate::logs::run_query_task(
                                    query_id,
                                    source_id,
                                    filter.unwrap_or_default(),
                                    crate::logs::LogWindow {
                                        limit: limit.map(|l| l as usize).unwrap_or(crate::logs::DEFAULT_LIMIT),
                                        offset: offset.unwrap_or(0) as usize,
                                        anchor: anchor.unwrap_or_default(),
                                    },
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
                            Ok(ServerMessage::TunnelOpen { tunnel_id, host, port, window }) => {
                                if let Err(error) = tunnels.open(tunnel_id.clone(), host, port, window) {
                                    commands::send_tunnel_event(
                                        &mut sink,
                                        device_id,
                                        crate::tunnel::TunnelEvent::Closed { tunnel_id, error: Some(error) },
                                    )
                                    .await;
                                }
                            }
                            Ok(ServerMessage::TunnelWrite { tunnel_id, data }) => {
                                if let Ok(bytes) =
                                    base64::engine::general_purpose::STANDARD.decode(data.as_bytes())
                                {
                                    if !tunnels.write(&tunnel_id, bytes) {
                                        tunnels.close(&tunnel_id);
                                        commands::send_tunnel_event(
                                            &mut sink,
                                            device_id,
                                            crate::tunnel::TunnelEvent::Closed {
                                                tunnel_id,
                                                error: Some("La cible ne lit pas assez vite ce que le serveur lui envoie.".into()),
                                            },
                                        )
                                        .await;
                                    }
                                }
                            }
                            Ok(ServerMessage::TunnelCredit { tunnel_id, credits }) => {
                                tunnels.credit(&tunnel_id, credits);
                            }
                            Ok(ServerMessage::TunnelClose { tunnel_id }) => {
                                tunnels.close(&tunnel_id);
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
                            Ok(ServerMessage::FilesArchive { op_id, path, exclusions, one_file_system, window }) => {
                                let request = crate::archive::ArchiveRequest { path, exclusions, one_file_system };
                                archives.start(op_id, request, window);
                            }
                            Ok(ServerMessage::FilesArchiveCredit { op_id, credits }) => {
                                archives.credit(&op_id, credits);
                            }
                            Ok(ServerMessage::FilesArchiveCancel { op_id }) => {
                                archives.cancel(&op_id);
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
                            Ok(ServerMessage::SyncScan { session_id, share_id, mode }) => {
                                sync_mgr.start_scan(session_id, share_id, mode);
                            }
                            // CloudSync: upload one file (off-loop; streams via sync_rx).
                            Ok(ServerMessage::SyncPush { op_id, share_id, rel_path, start_offset, window }) => {
                                sync_mgr.start_push(op_id, share_id, rel_path, start_offset, window);
                            }
                            // CloudSync: one credit back for a windowed push (never blocks).
                            Ok(ServerMessage::SyncPushAck { op_id, seq }) => {
                                sync_mgr.push_ack(&op_id, seq);
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
                            // CloudSync: rename in place (no transfer, no trash).
                            Ok(ServerMessage::SyncMove { op_id, share_id, from_rel_path, rel_path, hash, size, mtime, mode }) => {
                                let ev = tokio::task::block_in_place(|| {
                                    sync_mgr.move_file(&op_id, share_id, &from_rel_path, &rel_path, &hash, size, mtime, mode)
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
                            // Dernière barrière contre les exécutions doublées (le
                            // serveur perd son verrou s'il redémarre pendant une mise
                            // à jour) : une demande en double est ignorée, jamais
                            // terminée par un `Done`, qui relâcherait le verrou de
                            // celle qui tourne.
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
                            // Container inventory (off-loop; replies via docker_rx).
                            Ok(ServerMessage::DockerInventory {}) => {
                                let tx = docker_tx.clone();
                                tokio::spawn(async move {
                                    let inv = tokio::task::spawn_blocking(crate::docker::inventory)
                                        .await
                                        .ok();
                                    if let Some(inv) = inv {
                                        let _ = tx.send(crate::docker::DockerEvent::Inventory(inv)).await;
                                    }
                                });
                            }
                            // One-shot container stats sample (off-loop).
                            Ok(ServerMessage::DockerStats {}) => {
                                let tx = docker_tx.clone();
                                tokio::spawn(async move {
                                    let stats = tokio::task::spawn_blocking(crate::docker::stats)
                                        .await
                                        .unwrap_or_default();
                                    let _ = tx.send(crate::docker::DockerEvent::Stats(stats)).await;
                                });
                            }
                            // Act on a container/image/volume/network (off-loop; streams via docker_rx).
                            Ok(ServerMessage::DockerAction { op_id, engine, action, target }) => {
                                let long = crate::docker::is_long_action(&action);
                                if long && docker_long.is_some() {
                                    warn!(%action, "docker action already running — request ignored");
                                } else {
                                    if long {
                                        docker_long = Some(op_id.clone());
                                    }
                                    tokio::spawn(crate::docker::run_action(
                                        engine,
                                        action,
                                        target,
                                        op_id,
                                        docker_tx.clone(),
                                    ));
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
                    // Le pong ne porte rien de particulier : `last_seen` ci-dessus compte.
                    Some(Ok(Message::Pong(_))) => {}
                    Some(Ok(Message::Close(_))) | None => return Ok(SessionOutcome::Established),
                    Some(Ok(_)) => {}
                    Some(Err(e)) => return Err(e).context("WebSocket stream error"),
                }
            }
        }
    }
}

/// A skip-on-miss interval ticker whose first tick fires one full period from
/// now (the connect-time sample/report has already been sent).
///
/// `Skip` est ce qui rend la sortie de veille supportable : les horloges de
/// tokio n'avancent pas pendant la suspension, et avec `Burst` chaque ticker
/// rattraperait tout son arriéré au réveil (~3600 tics pour une heure).
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

/// Ce qu'un relevé Sentinelle rapporte. Les deux sondes voyagent ensemble, mais
/// chacune peut manquer : la persistance est sautée par le relevé horaire
/// d'authentification, et l'authentification l'est quand elle est désactivée.
struct ScanResult {
    integrity: Option<crate::integrity::IntegrityReport>,
    auth: Option<crate::authlog::AuthWindow>,
}

/// Lance un relevé complet hors de la boucle. `spawn_blocking` et non une tâche
/// async : les deux sondes lisent des fichiers et attendent des commandes
/// externes, ce qui bloquerait les pings et les métriques.
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

/// Le relevé d'authentification seul, à sa propre cadence : lire une fenêtre de
/// journal coûte cent fois moins qu'empreinter les surfaces de persistance.
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

/// Lance la construction du rapport sans l'attendre ; la boucle l'enverra.
///
/// Les sondes de sécurité sortent du processus, et `apt-get -s upgrade` peut
/// attendre le verrou dpkg pendant des minutes : attendre le rapport avant
/// d'entrer dans la boucle rendrait la machine muette (ni métriques ni
/// commandes) tout en restant affichée « en ligne ».
fn spawn_report(tx: &tokio::sync::mpsc::Sender<DeviceReport>, sockets: &SocketMap) {
    let listening = sockets.listening.clone();
    let established = sockets.established.clone();
    let tx = tx.clone();
    tokio::task::spawn_blocking(move || {
        let report = report::collect(listening, established);
        // `blocking_send` : on est hors du runtime. Un canal plein ou fermé
        // signifie une session finie, rien à rattraper.
        let _ = tx.blocking_send(report);
    });
}

async fn send_report<S>(sink: &mut S, device_id: &str, sockets: &SocketMap) -> Result<()>
where
    S: SinkExt<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    // Security probes shell out: run off the runtime. The socket picture is
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn close_codes_at_the_handshake() {
        assert!(matches!(
            outcome_of_close(Some(CloseCode::Policy)),
            SessionOutcome::Rejected
        ));
        assert!(matches!(
            outcome_of_close(Some(CloseCode::from(CLOSE_PENDING_APPROVAL))),
            SessionOutcome::PendingApproval
        ));
        assert!(matches!(
            outcome_of_close(Some(CloseCode::Restart)),
            SessionOutcome::Established
        ));
        assert!(matches!(
            outcome_of_close(None),
            SessionOutcome::Established
        ));
    }

    /// `now` est construit en avant d'une base, jamais en arrière : un `Instant`
    /// fraîchement lu peut être proche de l'origine de la plateforme, et lui
    /// soustraire une heure déborderait.
    #[test]
    fn connect_work_runs_when_never_done() {
        assert!(due_at(None, Instant::now(), MIN_CONNECT_WORK_GAP));
    }

    #[test]
    fn connect_work_waits_for_the_whole_gap() {
        let base = Instant::now();
        // La boucle de reconnexion : on vient de le faire, on ne le refait pas.
        assert!(!due_at(Some(base), base, MIN_CONNECT_WORK_GAP));
        assert!(!due_at(
            Some(base),
            base + MIN_CONNECT_WORK_GAP - Duration::from_secs(1),
            MIN_CONNECT_WORK_GAP
        ));
        // Pile à l'échéance, puis bien après.
        assert!(due_at(
            Some(base),
            base + MIN_CONNECT_WORK_GAP,
            MIN_CONNECT_WORK_GAP
        ));
        assert!(due_at(
            Some(base),
            base + Duration::from_secs(3600),
            MIN_CONNECT_WORK_GAP
        ));
    }

    #[test]
    fn a_clock_going_backwards_does_not_unlock_the_gap() {
        // `saturating_duration_since` rend zéro : un `now` antérieur au jalon
        // doit SAUTER le travail, le sens qui ne peut pas inonder le serveur.
        let base = Instant::now();
        assert!(!due_at(
            Some(base + Duration::from_secs(600)),
            base,
            MIN_CONNECT_WORK_GAP
        ));
    }

    #[test]
    fn the_gaps_stay_ordered() {
        // Un garde plus long que la cadence qu'il borne empêcherait le travail
        // au lieu de le dédoublonner.
        assert!(MIN_CONNECT_SNAPSHOT_GAP < MIN_CONNECT_WORK_GAP);
        assert!(MIN_CONNECT_WORK_GAP < REPORT_INTERVAL);
    }

    #[test]
    fn the_silence_limit_leaves_room_for_two_server_beats() {
        // Le serveur balaie toutes les 60 s (`AGENT_HEARTBEAT_MS`) ; sous deux
        // battements plus une marge, un balayage en retard sous charge ferait
        // reconnecter un agent sain. Réduire la marge demande de relire hub.ts.
        assert!(SERVER_SILENCE_LIMIT >= Duration::from_secs(150));
        assert!(WAKE_CHECK_INTERVAL < WAKE_SKEW_THRESHOLD);
        assert!(REJECTED_MIN < REJECTED_MAX);
        assert!(RECONNECT_DELAY_MIN < RECONNECT_DELAY_MAX);
    }

    #[test]
    fn jitter_stays_inside_its_bounds() {
        for _ in 0..200 {
            let d = jittered(RECONNECT_DELAY_MIN, RECONNECT_DELAY_MAX);
            assert!(d >= RECONNECT_DELAY_MIN && d <= RECONNECT_DELAY_MAX);
        }
        // Bornes inversées ou égales : on rend le minimum, jamais une panique.
        assert_eq!(jittered(MAX_BACKOFF, MIN_BACKOFF), MAX_BACKOFF);
    }
}
