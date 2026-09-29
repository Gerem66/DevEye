//! Tunnels: a TCP connection this machine opens on the server's order and
//! relays over the session, so a module reaches a service only this machine
//! sees (a database on its loopback). The target is this machine's loopback,
//! or a host its operator listed in `tunnel_targets`: a linked machine is never
//! a door into its whole network.
//!
//! Each piece read from the target spends one credit, which the server grants
//! back as it consumes them: out of credits, the target is no longer read and
//! TCP slows it down, whatever the size of what it sends.
//!
//! `TunnelManager` is owned by the session loop, like the terminals: a tunnel
//! dies with its session.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc::{self, error::TrySendError, Sender};
use tokio::sync::Semaphore;
use tokio::task::JoinHandle;

/// Raw bytes per `tunnel.data` frame (mirrors `AGENT_TUNNEL_PIECE_BYTES`).
const PIECE_BYTES: usize = 64 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_TUNNELS: usize = 32;
/// Pieces for the target not yet written: beyond, the target does not keep up.
const WRITE_QUEUE: usize = 64;
/// Never more credits than this, whatever the server grants.
const MAX_CREDITS: usize = 64;

const SESSION_CLOSED: &str = "session fermée";

/// What a tunnel reports to the loop, which stamps the device id and encodes
/// the bytes before sending them on the wire.
pub enum TunnelEvent {
    Opened {
        tunnel_id: String,
    },
    Data {
        tunnel_id: String,
        data: Vec<u8>,
    },
    Closed {
        tunnel_id: String,
        error: Option<String>,
    },
}

struct Tunnel {
    writes: Sender<Vec<u8>>,
    credits: Arc<Semaphore>,
    task: JoinHandle<()>,
}

/// The live tunnels of one agent session.
pub struct TunnelManager {
    tunnels: HashMap<String, Tunnel>,
    tx: Sender<TunnelEvent>,
    targets: Arc<Vec<String>>,
}

impl TunnelManager {
    pub fn new(tx: Sender<TunnelEvent>, targets: Vec<String>) -> Self {
        Self {
            tunnels: HashMap::new(),
            tx,
            targets: Arc::new(targets),
        }
    }

    /// Starts connecting; the tunnel then reports `Opened` or `Closed`. `Err`
    /// is a refusal before anything starts. A duplicate id is a no-op.
    pub fn open(
        &mut self,
        tunnel_id: String,
        host: String,
        port: u16,
        window: u32,
    ) -> Result<(), String> {
        if self.tunnels.contains_key(&tunnel_id) {
            return Ok(());
        }
        if self.tunnels.len() >= MAX_TUNNELS {
            return Err("Trop de tunnels ouverts en même temps sur cette machine.".into());
        }
        let (writes, write_rx) = mpsc::channel(WRITE_QUEUE);
        let credits = Arc::new(Semaphore::new((window as usize).min(MAX_CREDITS)));
        let task = tokio::spawn(run(
            tunnel_id.clone(),
            host,
            port,
            self.targets.clone(),
            credits.clone(),
            write_rx,
            self.tx.clone(),
        ));
        self.tunnels.insert(
            tunnel_id,
            Tunnel {
                writes,
                credits,
                task,
            },
        );
        Ok(())
    }

    /// Queues bytes for the target. `false`: the target does not keep up, the
    /// caller closes the tunnel.
    pub fn write(&self, tunnel_id: &str, data: Vec<u8>) -> bool {
        match self.tunnels.get(tunnel_id) {
            Some(tunnel) => !matches!(tunnel.writes.try_send(data), Err(TrySendError::Full(_))),
            None => true,
        }
    }

    pub fn credit(&self, tunnel_id: &str, credits: u32) {
        if let Some(tunnel) = self.tunnels.get(tunnel_id) {
            let room = MAX_CREDITS.saturating_sub(tunnel.credits.available_permits());
            tunnel.credits.add_permits((credits as usize).min(room));
        }
    }

    /// Drops the connection. Also frees the slot of a tunnel that ended by itself.
    pub fn close(&mut self, tunnel_id: &str) {
        if let Some(tunnel) = self.tunnels.remove(tunnel_id) {
            tunnel.task.abort();
        }
    }
}

impl Drop for TunnelManager {
    fn drop(&mut self) {
        for (_, tunnel) in self.tunnels.drain() {
            tunnel.task.abort();
        }
    }
}

async fn run(
    tunnel_id: String,
    host: String,
    port: u16,
    targets: Arc<Vec<String>>,
    credits: Arc<Semaphore>,
    write_rx: mpsc::Receiver<Vec<u8>>,
    tx: Sender<TunnelEvent>,
) {
    let error = relay(&tunnel_id, &host, port, &targets, &credits, write_rx, &tx)
        .await
        .err();
    let _ = tx.send(TunnelEvent::Closed { tunnel_id, error }).await;
}

async fn relay(
    tunnel_id: &str,
    host: &str,
    port: u16,
    targets: &[String],
    credits: &Semaphore,
    mut write_rx: mpsc::Receiver<Vec<u8>>,
    tx: &Sender<TunnelEvent>,
) -> Result<(), String> {
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((bare, port))
        .await
        .map_err(|e| format!("« {host} » est introuvable depuis cette machine : {e}"))?
        .collect();
    if !is_allowed(bare, &addrs, targets) {
        return Err(format!(
            "« {host} » n'est pas cette machine : pour l'atteindre, ajoutez-le à `tunnel_targets` dans agent.toml."
        ));
    }
    // Connected to the addresses checked above, never to the name again: it
    // cannot point elsewhere between the check and the connection.
    let stream = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(&addrs[..]))
        .await
        .map_err(|_| format!("{host}:{port} n'a pas répondu dans le délai imparti."))?
        .map_err(|e| format!("Connexion à {host}:{port} impossible : {e}"))?;
    let _ = stream.set_nodelay(true);
    tx.send(TunnelEvent::Opened {
        tunnel_id: tunnel_id.to_string(),
    })
    .await
    .map_err(|_| SESSION_CLOSED.to_string())?;

    let (mut reader, mut writer) = stream.into_split();
    let read = async {
        let mut buf = vec![0u8; PIECE_BYTES];
        loop {
            credits
                .acquire()
                .await
                .map_err(|_| SESSION_CLOSED.to_string())?
                .forget();
            let n = reader
                .read(&mut buf)
                .await
                .map_err(|e| format!("Lecture de {host}:{port} impossible : {e}"))?;
            if n == 0 {
                return Ok(());
            }
            tx.send(TunnelEvent::Data {
                tunnel_id: tunnel_id.to_string(),
                data: buf[..n].to_vec(),
            })
            .await
            .map_err(|_| SESSION_CLOSED.to_string())?;
        }
    };
    let write = async {
        while let Some(bytes) = write_rx.recv().await {
            writer
                .write_all(&bytes)
                .await
                .map_err(|e| format!("Écriture vers {host}:{port} impossible : {e}"))?;
        }
        Ok(())
    };
    tokio::select! {
        result = read => result,
        result = write => result,
    }
}

/// Every address of the target is this machine's loopback, or the operator
/// listed the target (by the name asked, or by each of its addresses).
fn is_allowed(host: &str, addrs: &[SocketAddr], targets: &[String]) -> bool {
    let listed = |name: &str| targets.iter().any(|t| t.trim().eq_ignore_ascii_case(name));
    if addrs.is_empty() {
        return false;
    }
    listed(host)
        || addrs
            .iter()
            .all(|a| a.ip().is_loopback() || listed(&a.ip().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn addrs(list: &[&str]) -> Vec<SocketAddr> {
        list.iter()
            .map(|ip| SocketAddr::new(ip.parse().unwrap(), 5432))
            .collect()
    }

    #[test]
    fn only_loopback_unless_listed() {
        let none: Vec<String> = Vec::new();
        assert!(is_allowed(
            "localhost",
            &addrs(&["127.0.0.1", "::1"]),
            &none
        ));
        assert!(!is_allowed("db.lan", &addrs(&["192.168.1.20"]), &none));
        // A name that resolves partly outside the machine is refused whole.
        assert!(!is_allowed(
            "mixed",
            &addrs(&["127.0.0.1", "10.0.0.5"]),
            &none
        ));
        assert!(!is_allowed("nothing", &[], &none));

        let listed = vec!["DB.lan".to_string(), "10.0.0.5".to_string()];
        assert!(is_allowed("db.lan", &addrs(&["192.168.1.20"]), &listed));
        assert!(is_allowed("10.0.0.5", &addrs(&["10.0.0.5"]), &listed));
        assert!(!is_allowed("other.lan", &addrs(&["192.168.1.21"]), &listed));
    }

    #[tokio::test]
    async fn relays_under_credits_and_reports_the_end() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4];
            socket.read_exact(&mut buf).await.unwrap();
            socket.write_all(b"pong").await.unwrap();
        });

        let (tx, mut rx) = mpsc::channel(16);
        let mut manager = TunnelManager::new(tx, Vec::new());
        manager
            .open("t1".into(), "127.0.0.1".into(), port, 1)
            .unwrap();
        assert!(matches!(rx.recv().await, Some(TunnelEvent::Opened { .. })));
        assert!(manager.write("t1", b"ping".to_vec()));
        match rx.recv().await {
            Some(TunnelEvent::Data { data, .. }) => assert_eq!(data, b"pong"),
            _ => panic!("expected the target's answer"),
        }
        // The one credit is spent: the end of the target waits for another.
        manager.credit("t1", 1);
        match rx.recv().await {
            Some(TunnelEvent::Closed { error, .. }) => assert_eq!(error, None),
            _ => panic!("expected the end of the tunnel"),
        }
    }

    #[tokio::test]
    async fn refuses_a_host_beyond_the_machine() {
        let (tx, mut rx) = mpsc::channel(16);
        let mut manager = TunnelManager::new(tx, Vec::new());
        manager
            .open("t2".into(), "192.0.2.1".into(), 5432, 1)
            .unwrap();
        match rx.recv().await {
            Some(TunnelEvent::Closed { error, .. }) => {
                assert!(error.unwrap().contains("tunnel_targets"))
            }
            _ => panic!("expected a refusal"),
        }
    }
}
