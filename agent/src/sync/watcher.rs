//! Watcher temps réel d'un partage (crate `notify` : inotify / FSEvents /
//! ReadDirectoryChangesW), débouncé — il ne PORTE aucune vérité : il se
//! contente d'émettre `SyncEvent::Changed`, et le serveur déclenche alors une
//! session basée sur un scan complet. Rater un événement n'est donc jamais
//! grave (le scan périodique rattrape) ; en émettre trop non plus (coalescé).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::mpsc::Sender;
use tracing::debug;

use crate::sync::paths::is_reserved_top;
use crate::sync::SyncEvent;

/// Fenêtre de silence avant d'émettre (une rafale de writes = un seul event).
const QUIET: Duration = Duration::from_secs(2);
/// Émission forcée si ça bouge sans interruption depuis aussi longtemps.
const MAX_WAIT: Duration = Duration::from_secs(30);
/// Cadence de la boucle de debounce.
const POLL: Duration = Duration::from_millis(500);

#[derive(Default)]
struct Pending {
    first: Option<Instant>,
    last: Option<Instant>,
}

/// Le watcher d'un partage. Le drop arrête tout (watcher natif + thread).
pub struct ShareWatcher {
    _watcher: RecommendedWatcher,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for ShareWatcher {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// Un chemin touché par un événement concerne-t-il la synchro ? (Les dossiers
/// réservés `.deveye-*` bougent en permanence pendant nos propres transferts.)
fn relevant(root: &Path, path: &Path) -> bool {
    let Ok(stripped) = path.strip_prefix(root) else {
        return true; // Hors racine (rename du root ?) : mieux vaut re-scanner.
    };
    match stripped.components().next() {
        Some(std::path::Component::Normal(first)) => {
            !first.to_str().map(is_reserved_top).unwrap_or(false)
        }
        _ => true,
    }
}

pub fn start(share_id: i64, root: PathBuf, tx: Sender<SyncEvent>) -> Result<ShareWatcher> {
    std::fs::create_dir_all(&root).with_context(|| format!("création de {}", root.display()))?;

    let pending = Arc::new(Mutex::new(Pending::default()));
    let handler_pending = Arc::clone(&pending);
    let handler_root = root.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        // Une erreur du backend (débordement de la file inotify, typiquement)
        // veut dire qu'on a PERDU des événements : c'est le moment de re-scanner,
        // surtout pas de se taire. On tombe donc volontairement dans le cas
        // « quelque chose a bougé » sans filtrer sur les chemins.
        if let Ok(event) = &res {
            if !event.paths.is_empty() && !event.paths.iter().any(|p| relevant(&handler_root, p)) {
                return;
            }
        }
        let mut p = handler_pending.lock().expect("pending lock");
        let now = Instant::now();
        p.first.get_or_insert(now);
        p.last = Some(now);
    })
    .context("création du watcher")?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .with_context(|| format!("surveillance de {}", root.display()))?;

    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop);
    let thread = std::thread::spawn(move || {
        while !thread_stop.load(Ordering::Relaxed) {
            std::thread::sleep(POLL);
            let fire = {
                let mut p = pending.lock().expect("pending lock");
                let now = Instant::now();
                let due = match (p.first, p.last) {
                    (Some(first), Some(last)) => {
                        now.duration_since(last) >= QUIET || now.duration_since(first) >= MAX_WAIT
                    }
                    _ => false,
                };
                if due {
                    *p = Pending::default();
                }
                due
            };
            if fire {
                debug!(share_id, "sync watcher: change detected");
                if tx.blocking_send(SyncEvent::Changed { share_id }).is_err() {
                    return; // Session terminée : le thread s'arrête.
                }
            }
        }
    });

    Ok(ShareWatcher {
        _watcher: watcher,
        stop,
        thread: Some(thread),
    })
}
