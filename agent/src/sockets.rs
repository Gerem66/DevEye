//! One socket probe per collection tick.
//!
//! Listening ports, established connections, the `activeConnections` count and
//! the per-process connection counts all come from the *same* enumeration. That
//! replaces three separate shell-outs (`ss -tulnH` for ports, `ss -tn state
//! established` twice — once for the count, once for the connection list) with a
//! single `ss -tuanpH`, which measured faster than the three it supersedes even
//! though it additionally maps every socket to its owning process.
//!
//! Process attribution needs privileges for *other users'* sockets: unprivileged
//! agents simply get `None` there, never a wrong owner.

use std::collections::HashMap;

use crate::protocol::{OpenPort, TcpConnection};

/// Hard cap on reported listening ports.
const OPEN_PORTS_LIMIT: usize = 500;
/// Hard cap on reported connections (mirrors the listening-ports cap).
const CONNECTIONS_LIMIT: usize = 500;

/// What one process holds open, derived from the socket table.
#[derive(Debug, Clone, Default)]
pub struct ProcSockets {
    /// Ports this process listens on (ascending, deduped).
    pub listen_ports: Vec<u16>,
    /// Established connections *to* one of its listening ports.
    pub conn_in: u32,
    /// Established connections it opened outwards.
    pub conn_out: u32,
}

/// One parsed row of the OS socket table, before classification.
struct RawSocket {
    proto: &'static str,
    listening: bool,
    established: bool,
    local_address: String,
    local_zone: Option<String>,
    local_port: u16,
    remote_address: String,
    remote_port: u16,
    pid: Option<u32>,
    process: Option<String>,
}

/// The whole socket picture at one instant.
pub struct SocketMap {
    /// Listening sockets, one entry per bind address, sorted and capped.
    pub listening: Vec<OpenPort>,
    /// Established TCP connections, sorted and capped.
    pub established: Vec<TcpConnection>,
    /// Total established TCP connections *before* the cap (the graph metric).
    /// `None` when the probe was unusable, so the UI hides it rather than
    /// drawing a misleading zero.
    pub established_count: Option<u32>,
    /// Per-process view, keyed by pid. Empty when nothing could be attributed.
    pub by_pid: HashMap<u32, ProcSockets>,
}

impl SocketMap {
    /// An empty map, for platforms/failures with no usable probe.
    fn empty() -> Self {
        Self {
            listening: Vec::new(),
            established: Vec::new(),
            established_count: None,
            by_pid: HashMap::new(),
        }
    }

    /// Fill in owner names the socket probe couldn't resolve, from the pid→name
    /// table the process scan produced. On Windows `netstat` only reports pids,
    /// and on Linux `ss -p` hides other users' processes without privileges;
    /// either way the process enumeration often knows the name anyway.
    pub fn resolve_names(&mut self, names: &HashMap<u32, String>) {
        for port in &mut self.listening {
            if port.process.is_some() {
                continue;
            }
            if let Some(name) = port.pid.and_then(|pid| names.get(&pid)) {
                port.process = Some(name.clone());
            }
        }
    }
}

/// Probe every socket on the host. `deep` asks for owner attribution even when
/// that costs a second, slower tool (macOS `lsof`, ~300 ms) — the periodic
/// report can afford it, a collection tick cannot.
pub fn read_sockets(deep: bool) -> SocketMap {
    let raw = collect_raw(deep);
    if raw.is_empty() {
        return SocketMap::empty();
    }
    build(raw)
}

/// Classify raw rows into the listening/established/per-process views.
fn build(raw: Vec<RawSocket>) -> SocketMap {
    // Pass 1: each process's listening ports, needed to tell inbound from outbound.
    let mut by_pid: HashMap<u32, ProcSockets> = HashMap::new();
    for s in raw.iter().filter(|s| s.listening) {
        if let Some(pid) = s.pid {
            by_pid.entry(pid).or_default().listen_ports.push(s.local_port);
        }
    }
    for entry in by_pid.values_mut() {
        entry.listen_ports.sort_unstable();
        entry.listen_ports.dedup();
    }

    // Pass 2: split established connections by direction. A socket whose local
    // port is one the process listens on was accepted (inbound); anything else
    // it dialed out (outbound).
    let mut established_count: u32 = 0;
    let mut established = Vec::new();
    for s in raw.iter().filter(|s| s.established) {
        established_count = established_count.saturating_add(1);
        established.push(TcpConnection {
            local_address: s.local_address.clone(),
            local_port: s.local_port,
            remote_address: s.remote_address.clone(),
            remote_port: s.remote_port,
        });
        if let Some(pid) = s.pid {
            let entry = by_pid.entry(pid).or_default();
            if entry.listen_ports.binary_search(&s.local_port).is_ok() {
                entry.conn_in = entry.conn_in.saturating_add(1);
            } else {
                entry.conn_out = entry.conn_out.saturating_add(1);
            }
        }
    }

    let mut listening: Vec<OpenPort> = raw
        .into_iter()
        .filter(|s| s.listening)
        .map(|s| OpenPort {
            proto: s.proto,
            port: s.local_port,
            address: s.local_address,
            zone: s.local_zone,
            pid: s.pid,
            process: s.process,
        })
        .collect();

    // Sorted so the UI gets a stable order, then deduped: the same socket is
    // often reported many times (mDNS binds one port on every interface), and
    // byte-identical rows carry no information. Rows differing only by bind
    // address are *kept* — they are genuinely distinct sockets, and the UI
    // merges them into one bubble.
    listening.sort_by(|a, b| {
        a.port
            .cmp(&b.port)
            .then(a.proto.cmp(b.proto))
            .then_with(|| a.address.cmp(&b.address))
            .then_with(|| a.zone.cmp(&b.zone))
            .then_with(|| a.pid.cmp(&b.pid))
    });
    listening.dedup_by(|a, b| {
        a.port == b.port && a.proto == b.proto && a.address == b.address && a.zone == b.zone && a.pid == b.pid
    });
    listening.truncate(OPEN_PORTS_LIMIT);

    established.sort_by(|a, b| {
        a.remote_address
            .cmp(&b.remote_address)
            .then(a.remote_port.cmp(&b.remote_port))
            .then(a.local_port.cmp(&b.local_port))
    });
    established.truncate(CONNECTIONS_LIMIT);

    SocketMap {
        listening,
        established,
        established_count: Some(established_count),
        by_pid,
    }
}

/// Split `host:port` from the right into `(address, zone, port)`.
///
/// Handles `0.0.0.0:22`, `[::]:22` and the link-local form `ss` prints as
/// `[fe80::1]%eth0:546`, where the scope id sits between the address and the
/// port — hence stripping the brackets *after* splitting off the zone.
fn split_host_port(s: &str) -> Option<(String, Option<String>, u16)> {
    let (host, port) = s.rsplit_once(':')?;
    let port: u16 = port.parse().ok()?;
    let (addr, zone) = match host.split_once('%') {
        Some((a, z)) => (a, Some(z.to_string())),
        None => (host, None),
    };
    let addr = addr.trim_start_matches('[').trim_end_matches(']');
    Some((addr.to_string(), zone, port))
}

/// Same, for the BSD `host.port` form (`*.22`, `127.0.0.1.631`, `::1.631`).
#[cfg(target_os = "macos")]
fn split_host_dot_port(s: &str) -> Option<(String, Option<String>, u16)> {
    let (host, port) = s.rsplit_once('.')?;
    let port: u16 = port.parse().ok()?;
    let (addr, zone) = match host.split_once('%') {
        Some((a, z)) => (a, Some(z.to_string())),
        None => (host, None),
    };
    Some((addr.to_string(), zone, port))
}

/// Parse `ss`'s owner column, `users:(("sshd",pid=1234,fd=3),("sshd",pid=1235,fd=4))`,
/// into the first `(name, pid)` pair. One socket can be shared by several
/// processes (a forking server); the first owner is the representative one.
#[cfg(target_os = "linux")]
fn parse_ss_users(line: &str) -> Option<(String, u32)> {
    let start = line.find("users:((")?;
    let rest = &line[start + "users:((".len()..];
    let name = rest.strip_prefix('"')?;
    let (name, after) = name.split_once('"')?;
    let pid_at = after.find("pid=")?;
    let digits: String = after[pid_at + 4..]
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    Some((name.to_string(), digits.parse().ok()?))
}

#[cfg(target_os = "linux")]
fn collect_raw(_deep: bool) -> Vec<RawSocket> {
    // -t TCP, -u UDP, -a all states, -n numeric, -p owning process, -H no header.
    let out = match crate::report::run("ss", &["-tuanpH"]) {
        Some(o) => o,
        None => return Vec::new(),
    };
    let mut v = Vec::new();
    for line in out.lines() {
        // Netid State Recv-Q Send-Q Local:Port Peer:Port [users:(…)]
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 6 {
            continue;
        }
        let proto = match cols[0] {
            "tcp" => "tcp",
            "udp" => "udp",
            _ => continue,
        };
        let state = cols[1];
        // A bound UDP socket sits in UNCONN: it has no peer but is listening.
        let listening = state == "LISTEN" || (proto == "udp" && state == "UNCONN");
        let established = proto == "tcp" && state == "ESTAB";
        if !listening && !established {
            continue;
        }
        let Some((local_address, local_zone, local_port)) = split_host_port(cols[4]) else {
            continue;
        };
        let (remote_address, remote_port) = split_host_port(cols[5])
            .map(|(a, _, p)| (a, p))
            .unwrap_or_else(|| (String::new(), 0));
        let owner = parse_ss_users(line);
        v.push(RawSocket {
            proto,
            listening,
            established,
            local_address,
            local_zone,
            local_port,
            remote_address,
            remote_port,
            pid: owner.as_ref().map(|(_, pid)| *pid),
            process: owner.map(|(name, _)| name),
        });
    }
    v
}

/// macOS: `netstat` gives states but never owners, and `lsof` — the only tool
/// that does — takes hundreds of milliseconds, so owners are resolved only on
/// the `deep` (report) pass. `netstat -an` also covers UDP, which the previous
/// TCP-only probe missed entirely.
#[cfg(target_os = "macos")]
fn collect_raw(deep: bool) -> Vec<RawSocket> {
    let out = match crate::report::run("netstat", &["-an"]) {
        Some(o) => o,
        None => return Vec::new(),
    };
    let mut v = Vec::new();
    for line in out.lines() {
        // Proto Recv-Q Send-Q Local-Address Foreign-Address (state)
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 5 {
            continue;
        }
        let proto = if cols[0].starts_with("tcp") {
            "tcp"
        } else if cols[0].starts_with("udp") {
            "udp"
        } else {
            continue;
        };
        let state = cols.get(5).copied().unwrap_or("");
        // BSD leaves UDP stateless; a UDP row with no peer is a bound socket.
        let listening = state == "LISTEN" || (proto == "udp" && cols[4].ends_with('*'));
        let established = state == "ESTABLISHED";
        if !listening && !established {
            continue;
        }
        let Some((local_address, local_zone, local_port)) = split_host_dot_port(cols[3]) else {
            continue;
        };
        let (remote_address, remote_port) = split_host_dot_port(cols[4])
            .map(|(a, _, p)| (a, p))
            .unwrap_or_else(|| (String::new(), 0));
        v.push(RawSocket {
            proto,
            listening,
            established,
            local_address,
            local_zone,
            local_port,
            remote_address,
            remote_port,
            pid: None,
            process: None,
        });
    }
    if deep {
        attach_macos_owners(&mut v);
    }
    v
}

/// Resolve listening-socket owners on macOS via one `lsof` pass. Field-mode
/// output (`-F pcnPn`) emits `p<pid>`, `c<command>` then one `n<addr:port>` per
/// socket, so a single scan attributes every listener.
#[cfg(target_os = "macos")]
fn attach_macos_owners(sockets: &mut [RawSocket]) {
    let out = match crate::report::run("lsof", &["-nP", "-i", "-sTCP:LISTEN", "-FpcPn"]) {
        Some(o) => o,
        None => return,
    };
    // (proto, port) → (name, pid). Bind addresses vary per row; the port and
    // protocol are enough to attribute a listener to its process.
    let mut owners: HashMap<(&'static str, u16), (String, u32)> = HashMap::new();
    let (mut pid, mut name, mut proto) = (None::<u32>, None::<String>, "tcp");
    for line in out.lines() {
        // Field mode prefixes each value with a one-byte tag; blank lines occur
        // and must not be sliced.
        let Some(tag) = line.as_bytes().first().copied() else {
            continue;
        };
        let value = &line[1..];
        match tag {
            b'p' => pid = value.parse().ok(),
            b'c' => name = Some(value.to_string()),
            b'P' => proto = if value.eq_ignore_ascii_case("UDP") { "udp" } else { "tcp" },
            b'n' => {
                // `n` holds `host:port` (lsof uses a colon even on BSD).
                if let (Some(pid), Some(name), Some((_, _, port))) =
                    (pid, name.clone(), split_host_port(value))
                {
                    owners.entry((proto, port)).or_insert((name, pid));
                }
            }
            _ => {}
        }
    }
    for s in sockets.iter_mut().filter(|s| s.listening) {
        if let Some((name, pid)) = owners.get(&(s.proto, s.local_port)) {
            s.process = Some(name.clone());
            s.pid = Some(*pid);
        }
    }
}

/// Windows: `netstat -ano` already reports the owning pid in its last column
/// (the previous parser threw it away). Names come from the process scan via
/// [`SocketMap::resolve_names`], so no extra tool is spawned.
#[cfg(target_os = "windows")]
fn collect_raw(_deep: bool) -> Vec<RawSocket> {
    let out = match crate::report::run("netstat", &["-ano"]) {
        Some(o) => o,
        None => return Vec::new(),
    };
    let mut v = Vec::new();
    for line in out.lines() {
        // TCP: Proto Local Foreign State PID | UDP: Proto Local Foreign PID
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 4 {
            continue;
        }
        let proto = match cols[0] {
            "TCP" => "tcp",
            "UDP" => "udp",
            _ => continue,
        };
        let (state, pid_col) = if proto == "tcp" {
            (cols.get(3).copied().unwrap_or(""), cols.get(4))
        } else {
            ("", cols.get(3))
        };
        let listening = if proto == "tcp" { state == "LISTENING" } else { true };
        let established = state == "ESTABLISHED";
        if !listening && !established {
            continue;
        }
        let Some((local_address, local_zone, local_port)) = split_host_port(cols[1]) else {
            continue;
        };
        let (remote_address, remote_port) = split_host_port(cols[2])
            .map(|(a, _, p)| (a, p))
            .unwrap_or_else(|| (String::new(), 0));
        v.push(RawSocket {
            proto,
            listening,
            established,
            local_address,
            local_zone,
            local_port,
            remote_address,
            remote_port,
            pid: pid_col.and_then(|p| p.parse().ok()),
            process: None,
        });
    }
    v
}

/// Fallback for any other target: no portable probe.
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn collect_raw(_deep: bool) -> Vec<RawSocket> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_host_port_handles_v4_v6_and_scope() {
        assert_eq!(
            split_host_port("0.0.0.0:22"),
            Some(("0.0.0.0".into(), None, 22))
        );
        assert_eq!(split_host_port("[::]:22"), Some(("::".into(), None, 22)));
        assert_eq!(
            split_host_port("127.0.0.53:53"),
            Some(("127.0.0.53".into(), None, 53))
        );
        // Link-local: `ss` puts the scope id between the address and the port,
        // so the brackets must be stripped *after* splitting the zone off.
        assert_eq!(
            split_host_port("[fe80::1]%eth0:546"),
            Some(("fe80::1".into(), Some("eth0".into()), 546))
        );
        assert_eq!(split_host_port("nonsense"), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn parse_ss_users_reads_first_owner() {
        assert_eq!(
            parse_ss_users(r#"tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1234,fd=3))"#),
            Some(("sshd".to_string(), 1234))
        );
        // A forking server shares one socket across PIDs; the first is representative.
        assert_eq!(
            parse_ss_users(r#"tcp LISTEN 0 511 *:80 *:* users:(("nginx",pid=900,fd=6),("nginx",pid=901,fd=6))"#),
            Some(("nginx".to_string(), 900))
        );
        // Unprivileged agents get no owner column at all.
        assert_eq!(
            parse_ss_users("tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*"),
            None
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn build_merges_nothing_but_identical_rows() {
        let raw = vec![
            // Dual-stack sshd: two genuinely distinct sockets that used to render
            // as two identical "22 tcp · SSH" bubbles.
            mk("tcp", true, false, "0.0.0.0", 22, Some(1)),
            mk("tcp", true, false, "::", 22, Some(1)),
            // Byte-identical duplicate (mDNS reports one per interface): dropped.
            mk("udp", true, false, "0.0.0.0", 5353, Some(2)),
            mk("udp", true, false, "0.0.0.0", 5353, Some(2)),
        ];
        let map = build(raw);
        assert_eq!(map.listening.len(), 3, "distinct binds kept, exact dupes dropped");
        assert_eq!(map.listening[0].port, 22);
        assert_eq!(map.listening[0].address, "0.0.0.0");
        assert_eq!(map.listening[1].address, "::");
        assert_eq!(map.by_pid[&1].listen_ports, vec![22]);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn build_splits_connections_by_direction() {
        let raw = vec![
            mk("tcp", true, false, "0.0.0.0", 22, Some(1)),
            // Accepted on the listening port → inbound.
            mk("tcp", false, true, "192.168.1.10", 22, Some(1)),
            // Dialed out from an ephemeral port → outbound.
            mk("tcp", false, true, "192.168.1.10", 51234, Some(1)),
        ];
        let map = build(raw);
        assert_eq!(map.established_count, Some(2));
        assert_eq!(map.by_pid[&1].conn_in, 1);
        assert_eq!(map.by_pid[&1].conn_out, 1);
    }

    #[cfg(target_os = "linux")]
    fn mk(
        proto: &'static str,
        listening: bool,
        established: bool,
        address: &str,
        port: u16,
        pid: Option<u32>,
    ) -> RawSocket {
        RawSocket {
            proto,
            listening,
            established,
            local_address: address.to_string(),
            local_zone: None,
            local_port: port,
            remote_address: String::new(),
            remote_port: 0,
            pid,
            process: None,
        }
    }
}
