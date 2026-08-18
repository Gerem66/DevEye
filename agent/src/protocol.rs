//! Wire types shared with the DevEye server.
//!
//! These mirror `@gerem66/deveye-types` (`protocol/agent.ts`, `domain/metrics.ts`
//! and the HTTP enrollment contract). Field names use the server's camelCase.

use serde::{Deserialize, Serialize};

/// A point-in-time metric sample. `timestamp` is unix milliseconds.
#[derive(Debug, Clone, Serialize)]
pub struct MetricSnapshot {
    pub timestamp: i64,
    #[serde(rename = "cpuPercent")]
    pub cpu_percent: f64,
    #[serde(rename = "memUsedBytes")]
    pub mem_used_bytes: u64,
    #[serde(rename = "memTotalBytes")]
    pub mem_total_bytes: u64,
    #[serde(rename = "diskUsedBytes")]
    pub disk_used_bytes: u64,
    #[serde(rename = "diskTotalBytes")]
    pub disk_total_bytes: u64,
    #[serde(rename = "netRxBytes")]
    pub net_rx_bytes: u64,
    #[serde(rename = "netTxBytes")]
    pub net_tx_bytes: u64,
    #[serde(rename = "usersCount")]
    pub users_count: u32,
    #[serde(rename = "loadAvg1")]
    pub load_avg_1: Option<f64>,
    #[serde(rename = "cpuTempC")]
    pub cpu_temp_c: Option<f64>,
    #[serde(rename = "uptimeSeconds")]
    pub uptime_seconds: Option<u64>,
    #[serde(rename = "processCount")]
    pub process_count: Option<u32>,
    #[serde(rename = "activeConnections")]
    pub active_connections: Option<u32>,
    #[serde(rename = "gpuPercent")]
    pub gpu_percent: Option<f64>,
    /// Cumulative disk bytes read, summed over every process. `None` when the
    /// platform doesn't expose per-process I/O or we lack the privileges.
    #[serde(rename = "diskReadBytes")]
    pub disk_read_bytes: Option<u64>,
    #[serde(rename = "diskWriteBytes")]
    pub disk_write_bytes: Option<u64>,
    /// Battery charge (%); None when the machine has no battery.
    #[serde(rename = "batteryPercent")]
    pub battery_percent: Option<f64>,
    /// Whether the battery is charging / on AC; None when unknown.
    #[serde(rename = "batteryCharging")]
    pub battery_charging: Option<bool>,
    /// Programs running at this instant, heaviest first. `None` when capture is
    /// `off`, or when the detail was trimmed off an old queued snapshot (graphs
    /// keep full fidelity, process detail is bounded — see `runner::push_bounded`).
    pub processes: Option<Vec<ProcessInfo>>,
    /// Capture mode in effect when `processes` was taken, so history stays
    /// labelled correctly even after the setting later changes. `None` with
    /// `processes`.
    #[serde(rename = "processKind")]
    pub process_kind: Option<&'static str>,
}

/// Latest-known health/security report (sent on connect, then periodically).
/// Mirrors `deveye-types` `domain/report.ts`. Security fields are nullable:
/// collectors are best-effort and may be unavailable on a given platform.
#[derive(Debug, Clone, Serialize)]
pub struct DeviceReport {
    #[serde(rename = "collectedAt")]
    pub collected_at: i64,
    pub os: OsInfo,
    pub security: Security,
    pub disks: Vec<ReportDisk>,
    /// How the agent itself runs (privilege level + account). Lets the UI explain
    /// why some best-effort probes are limited (e.g. not running as root).
    pub agent: AgentInfo,
    /// Listening sockets (TCP, plus UDP on Linux). Empty = none found; a legacy
    /// report that predates this field deserialises to `null` server-side.
    #[serde(rename = "openPorts")]
    pub open_ports: Vec<OpenPort>,
    /// Established TCP connections (the detail behind the `activeConnections`
    /// metric). Empty = none; a legacy report deserialises to `null` server-side.
    pub connections: Vec<TcpConnection>,
    /// Static hardware inventory (CPU, RAM, GPU, network, bluetooth). Slow-moving;
    /// a legacy report that predates this field deserialises to `null` server-side.
    pub hardware: DeviceHardware,
}

/// One established TCP connection: the local and remote socket. `activeConnections`
/// in the metric stream is just the count of these.
#[derive(Debug, Clone, Serialize)]
pub struct TcpConnection {
    #[serde(rename = "localAddress")]
    pub local_address: String,
    #[serde(rename = "localPort")]
    pub local_port: u16,
    #[serde(rename = "remoteAddress")]
    pub remote_address: String,
    #[serde(rename = "remotePort")]
    pub remote_port: u16,
}

/// Static hardware inventory of the host. Every list is best-effort and may be
/// empty; `bluetooth` is `None` when no adapter was detected.
#[derive(Debug, Clone, Serialize)]
pub struct DeviceHardware {
    pub cpu: CpuInfo,
    #[serde(rename = "memoryTotalBytes")]
    pub memory_total_bytes: u64,
    pub gpus: Vec<String>,
    pub network: Vec<NetInterface>,
    pub bluetooth: Option<String>,
}

/// Processor identity (best-effort, from `sysinfo`).
#[derive(Debug, Clone, Serialize)]
pub struct CpuInfo {
    /// Brand string, e.g. "Apple M1 Pro" / "Intel(R) Core(TM) i7-1185G7".
    pub model: String,
    /// Vendor id (`GenuineIntel`, `AuthenticAMD`, …); None when unknown.
    pub vendor: Option<String>,
    /// Physical cores; None when the OS can't report them.
    #[serde(rename = "physicalCores")]
    pub physical_cores: Option<u32>,
    /// Logical cores (threads).
    #[serde(rename = "logicalCores")]
    pub logical_cores: u32,
    /// Nominal/base frequency in MHz; None when unknown.
    #[serde(rename = "frequencyMhz")]
    pub frequency_mhz: Option<u64>,
}

/// One network interface: name + hardware address + an inferred class.
#[derive(Debug, Clone, Serialize)]
pub struct NetInterface {
    pub name: String,
    /// One of: wifi, ethernet, bluetooth, loopback, virtual, other.
    pub kind: &'static str,
    pub mac: Option<String>,
    /// IP addresses assigned to the interface, so the ports view can attribute a
    /// bind address to the interface it belongs to. Empty when unknown.
    pub addresses: Vec<String>,
}

/// The agent's own runtime identity, used by the UI to flag privilege-gated gaps.
#[derive(Debug, Clone, Serialize)]
pub struct AgentInfo {
    /// `true` when running as root (Unix euid 0) / elevated (Windows).
    pub privileged: bool,
    /// The OS account the agent runs as (e.g. `root`, `deploy`).
    pub user: String,
    /// Installed persistence scope: `none` | `user` | `system`.
    #[serde(rename = "serviceScope")]
    pub service_scope: &'static str,
    /// `true` when launched under a service manager (so a self-update just exits).
    pub managed: bool,
    /// Ce que cet agent sait relever, déclaré par lui-même.
    ///
    /// Sans cette liste, rien ne distingue « la sonde a échoué » d'« un agent
    /// trop ancien pour l'avoir » : les deux rendent `null`, et l'interface
    /// afficherait le même vide pour deux situations qui n'appellent pas la
    /// même réaction. La version ne peut pas servir — elle est injectée à la
    /// compilation et vaut `0.0.0` sur une construction locale.
    pub probes: Vec<&'static str>,
}

/// One detected package manager + its pending state (mirrors deveye-types
/// `packageManagerSchema`).
#[derive(Debug, Clone, Serialize)]
pub struct PackageManagerInfo {
    pub id: &'static str,
    #[serde(rename = "pendingCount")]
    pub pending_count: Option<u32>,
    #[serde(rename = "needsRoot")]
    pub needs_root: bool,
    #[serde(rename = "rebootRequired")]
    pub reboot_required: bool,
}

/// One listening socket. `address` is the bind address (e.g. `0.0.0.0`, `::`,
/// `127.0.0.1`) so the UI can tell world-exposed ports from loopback-only ones
/// and group them per interface. One entry per bind address: a dual-stack
/// service legitimately yields two (`0.0.0.0:22` and `:::22`), which the UI
/// merges into one bubble.
#[derive(Debug, Clone, Serialize)]
pub struct OpenPort {
    pub proto: &'static str,
    pub port: u16,
    pub address: String,
    /// IPv6 scope id — the interface a link-local socket is bound to
    /// (`fe80::1%eth0`). `None` for a plain address.
    pub zone: Option<String>,
    /// Owning process; `None` when the mapping needs privileges we don't have.
    pub pid: Option<u32>,
    pub process: Option<String>,
}

/// One mounted disk/volume (per-disk breakdown for multi-disk machines).
#[derive(Debug, Clone, Serialize)]
pub struct ReportDisk {
    pub mount: String,
    #[serde(rename = "usedBytes")]
    pub used_bytes: u64,
    #[serde(rename = "totalBytes")]
    pub total_bytes: u64,
}

/// One queryable log source on the host (mirrors deveye-types `deviceLogSourceSchema`).
#[derive(Debug, Clone, Serialize)]
pub struct LogSource {
    /// Opaque token the agent resolves back to a reader (`journald`, `docker:<id>`,
    /// `file:<path>`, `oslog`, `eventlog:<channel>`).
    pub id: String,
    /// One of: journald, docker, syslog, oslog, eventlog.
    pub kind: &'static str,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub running: Option<bool>,
}

/// One normalised log line (mirrors deveye-types `deviceLogLineSchema`). `ts` is
/// unix milliseconds; both `ts` and `level` are nullable (sent as `null`).
#[derive(Debug, Clone, Serialize)]
pub struct LogLine {
    pub ts: Option<i64>,
    pub level: Option<&'static str>,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
}

/// Advanced log-query filter as the server sends it (mirrors `deviceLogFilterSchema`).
#[derive(Debug, Default, Clone, Deserialize)]
pub struct LogFilter {
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub regex: Option<bool>,
    #[serde(rename = "levelMin", default)]
    pub level_min: Option<String>,
    #[serde(default)]
    pub unit: Option<String>,
    /// Window start, unix epoch seconds.
    #[serde(default)]
    pub since: Option<i64>,
    /// Window end, unix epoch seconds.
    #[serde(default)]
    pub until: Option<i64>,
}

/// One directory entry (mirrors deveye-types `fileEntrySchema`). `size` is the
/// entry's own size; recursive sizes come from the separate usage analysis.
#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    pub name: String,
    /// One of: file, dir, symlink, other.
    pub kind: &'static str,
    pub size: u64,
    /// Last-modified, unix milliseconds (null when unavailable).
    pub mtime: Option<i64>,
    /// Unix permission bits for display; null on platforms without them.
    pub mode: Option<u32>,
    #[serde(rename = "symlinkTarget", skip_serializing_if = "Option::is_none")]
    pub symlink_target: Option<String>,
}

/// A directory listing (mirrors `fileListingSchema`).
#[derive(Debug, Clone, Serialize)]
pub struct FileListing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<FileEntry>,
}

/// One child's recursive size (mirrors `fileUsageEntrySchema`).
#[derive(Debug, Clone, Serialize)]
pub struct FileUsageEntry {
    pub name: String,
    pub kind: &'static str,
    #[serde(rename = "totalSize")]
    pub total_size: u64,
    pub partial: bool,
}

/// One search hit (mirrors `fileMatchSchema`).
#[derive(Debug, Clone, Serialize)]
pub struct FileMatch {
    pub path: String,
    pub name: String,
    pub kind: &'static str,
    pub size: u64,
    pub mtime: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
}

/// Advanced file-search filter as the server sends it (mirrors `fileSearchFilterSchema`).
#[derive(Debug, Default, Clone, Deserialize)]
pub struct FileSearchFilter {
    #[serde(default)]
    pub query: Option<String>,
    /// `name` (default) | `extension` | `content`.
    #[serde(default)]
    pub field: Option<String>,
    #[serde(default)]
    pub regex: Option<bool>,
    /// mtime window, unix epoch seconds.
    #[serde(default)]
    pub since: Option<i64>,
    #[serde(default)]
    pub until: Option<i64>,
    #[serde(rename = "minSize", default)]
    pub min_size: Option<u64>,
    #[serde(rename = "maxSize", default)]
    pub max_size: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OsInfo {
    pub name: String,
    pub version: String,
    pub arch: String,
    pub cores: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct Security {
    pub firewall: Option<bool>,
    #[serde(rename = "diskEncryption")]
    pub disk_encryption: Option<bool>,
    pub sip: Option<bool>,
    #[serde(rename = "pendingUpdates")]
    pub pending_updates: Option<u32>,
    /// Correctifs de **sécurité** en attente, distingués du total.
    ///
    /// C'est la distinction qui porte le signal : quarante mises à jour dont
    /// aucune de sécurité n'est qu'un retard d'entretien, tandis qu'une seule
    /// faille non corrigée est une porte.
    #[serde(rename = "pendingSecurityUpdates")]
    pub pending_security_updates: Option<u32>,
    /// Unix ms du dernier contrôle des mises à jour — c'est son **ancienneté**
    /// qui fait le constat, pas le nombre.
    #[serde(rename = "updatesCheckedAt")]
    pub updates_checked_at: Option<i64>,
    /// `PermitRootLogin` du serveur SSH.
    #[serde(rename = "sshRootLogin")]
    pub ssh_root_login: Option<bool>,
    /// `PasswordAuthentication` du serveur SSH.
    #[serde(rename = "sshPasswordAuth")]
    pub ssh_password_auth: Option<bool>,
    /// `selinux-enforcing` | `selinux-permissive` | `apparmor` | `none`.
    #[serde(rename = "mandatoryAccessControl")]
    pub mandatory_access_control: Option<&'static str>,
    /// Des correctifs installés attendent un redémarrage pour prendre effet.
    #[serde(rename = "rebootRequired")]
    pub reboot_required: Option<bool>,
}

/// One *program* at sample time, aggregated across every PID sharing its name.
/// Fields beyond CPU/memory are best-effort: `None` means "couldn't be read"
/// (platform gap or missing privileges), never a misleading zero.
#[derive(Debug, Clone, Serialize)]
pub struct ProcessInfo {
    pub name: String,
    /// Chemin de l'exécutable, et **seconde moitié de la clé d'agrégation**.
    ///
    /// Agréger sur le seul nom fusionnait deux binaires homonymes rangés à des
    /// endroits différents — exactement ce derrière quoi un imposteur se cache.
    /// `None` quand la plateforme ou les droits ne l'exposent pas : la règle
    /// serveur qui en dépend reste alors muette plutôt que de conclure à vide.
    #[serde(rename = "execPath")]
    pub exec_path: Option<String>,
    /// L'exécutable a été effacé du disque mais le processus tourne toujours.
    ///
    /// Un des indicateurs les plus francs d'un implant résident en mémoire, et
    /// il ne coûte rien : le lien `/proc/<pid>/exe` est déjà lu pour `exec_path`.
    /// `None` là où la plateforme ne l'expose pas.
    pub deleted: Option<bool>,
    /// Number of PIDs aggregated under this name.
    pub instances: u32,
    #[serde(rename = "cpuPercent")]
    pub cpu_percent: f64,
    #[serde(rename = "memBytes")]
    pub mem_bytes: u64,
    /// Summed thread count; `None` on macOS (`ps` exposes no thread column).
    pub threads: Option<u32>,
    /// Owning OS account (the most frequent one among the aggregated PIDs).
    pub user: Option<String>,
    /// Age of the oldest instance, in seconds.
    #[serde(rename = "uptimeSeconds")]
    pub uptime_seconds: Option<u64>,
    /// Cumulative bytes read/written; `None` when unreadable (privileges) or
    /// unsupported (macOS has no `/proc`).
    #[serde(rename = "diskReadBytes")]
    pub disk_read_bytes: Option<u64>,
    #[serde(rename = "diskWriteBytes")]
    pub disk_write_bytes: Option<u64>,
    /// Established connections to one of this program's listening ports
    /// (inbound) and away from it (outbound). Byte counters per process are not
    /// collected: no OS exposes them without eBPF/packet capture.
    #[serde(rename = "connIn")]
    pub conn_in: Option<u32>,
    #[serde(rename = "connOut")]
    pub conn_out: Option<u32>,
    /// Ports this program listens on (ascending, deduped).
    #[serde(rename = "listenPorts")]
    pub listen_ports: Vec<u16>,
}

/// One CloudSync exclusion rule (`path` = exact rel path or dir prefix,
/// `name` = exact path component, `regex` = linear-time regex on the rel path).
#[derive(Debug, Clone, Deserialize)]
pub struct SyncExclusion {
    pub kind: String,
    pub pattern: String,
}

/// One CloudSync share assigned to this device (pushed via `sync.config`).
#[derive(Debug, Clone, Deserialize)]
pub struct SyncShareAssignment {
    #[serde(rename = "shareId")]
    pub share_id: i64,
    #[serde(rename = "localPath")]
    pub local_path: String,
    /// `active` | `paused` (share-level OR device-level pause, pre-merged).
    pub status: String,
    pub exclusions: Vec<SyncExclusion>,
    /// Plafond de débit des MONTÉES en octets/s ; `None` = illimité. Appliqué
    /// ici parce que l'agent est l'émetteur : brider côté serveur ne ferait que
    /// gonfler les tampons intermédiaires sans ralentir la lecture du disque.
    #[serde(rename = "rateUpBps", default)]
    pub rate_up_bps: Option<u64>,
    /// Rétention de `.deveye-trash/`, en jours.
    #[serde(rename = "trashKeepDays", default = "default_trash_days")]
    pub trash_keep_days: u64,
}

fn default_trash_days() -> u64 {
    30
}

fn default_dir_kind() -> String {
    "dir".to_string()
}

/// One entry of a CloudSync scan (mirrors `syncIndexEntrySchema`). `mtime` is
/// unix milliseconds; `hash` is the SHA-256 (hex) of the file content.
#[derive(Debug, Clone, Serialize)]
pub struct SyncIndexEntry {
    #[serde(rename = "relPath")]
    pub rel_path: String,
    /// `file`, ou `dir` pour un dossier VIDE (les dossiers peuplés sont implicites).
    pub kind: String,
    pub hash: String,
    pub size: u64,
    pub mtime: i64,
    /// Bits de permission Unix ; `None` sous Windows, que le serveur interprète
    /// comme « inconnu » et non comme « aucune permission ».
    pub mode: Option<u32>,
}

/// Messages the agent sends to the server over the `/agent` WebSocket.
#[derive(Debug, Serialize)]
#[serde(tag = "command", content = "payload")]
pub enum ClientMessage {
    #[serde(rename = "agent.hello")]
    Hello {
        #[serde(rename = "agentVersion")]
        agent_version: String,
        /// Build target id (e.g. `linux-x86_64`); omitted when unknown. Lets the
        /// server resolve which binary to push for a self-update.
        #[serde(skip_serializing_if = "Option::is_none")]
        target: Option<String>,
    },
    #[serde(rename = "metrics.batch")]
    MetricsBatch {
        #[serde(rename = "deviceId")]
        device_id: String,
        snapshots: Vec<MetricSnapshot>,
    },
    /// Manifeste des surfaces de persistance (Sentinelle).
    #[serde(rename = "agent.integrity")]
    Integrity {
        #[serde(rename = "deviceId")]
        device_id: String,
        // Boxé comme `Report` : c'est l'une des plus grosses variantes, et la
        // laisser en ligne gonflerait l'enum entier (clippy::large_enum_variant).
        integrity: Box<crate::integrity::IntegrityReport>,
    },
    /// Fenêtre d'issues d'authentification (Sentinelle).
    #[serde(rename = "agent.authEvents")]
    AuthEvents {
        #[serde(rename = "deviceId")]
        device_id: String,
        auth: Box<crate::authlog::AuthWindow>,
    },
    #[serde(rename = "agent.report")]
    Report {
        #[serde(rename = "deviceId")]
        device_id: String,
        // Boxed: the report is by far the largest variant; boxing keeps the enum
        // small (clippy::large_enum_variant) without changing the wire shape.
        report: Box<DeviceReport>,
    },
    /// Outcome of an `agent.destroy`: whether the agent wiped itself successfully.
    #[serde(rename = "agent.destroyed")]
    Destroyed {
        #[serde(rename = "deviceId")]
        device_id: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// Outcome of an `agent.update`: whether the new binary verified and swapped in.
    #[serde(rename = "agent.updated")]
    Updated {
        #[serde(rename = "deviceId")]
        device_id: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        version: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// Outcome of an `agent.service` persistence/privilege change.
    #[serde(rename = "agent.serviceResult")]
    ServiceResult {
        #[serde(rename = "deviceId")]
        device_id: String,
        action: String,
        ok: bool,
        #[serde(rename = "needsManualCommand", skip_serializing_if = "Option::is_none")]
        needs_manual_command: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// Outcome of an `agent.power` system power action (shutdown/reboot/suspend…).
    #[serde(rename = "agent.powerResult")]
    PowerResult {
        #[serde(rename = "deviceId")]
        device_id: String,
        action: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// Reply to `log.sources`: the log sources discovered on the host.
    #[serde(rename = "log.sourcesResult")]
    LogSourcesResult {
        #[serde(rename = "deviceId")]
        device_id: String,
        sources: Vec<LogSource>,
    },
    /// Reply to `log.query`: one chunk of matched log lines (last one `done: true`).
    #[serde(rename = "log.lines")]
    LogLines {
        #[serde(rename = "deviceId")]
        device_id: String,
        #[serde(rename = "queryId")]
        query_id: String,
        lines: Vec<LogLine>,
        done: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// A chunk of PTY output for a terminal session (`data` is base64 of raw bytes).
    #[serde(rename = "term.output")]
    TermOutput {
        #[serde(rename = "deviceId")]
        device_id: String,
        #[serde(rename = "sessionId")]
        session_id: String,
        data: String,
    },
    /// A terminal session ended (shell exited, killed, or open failed).
    #[serde(rename = "term.exit")]
    TermExit {
        #[serde(rename = "deviceId")]
        device_id: String,
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<i32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// A directory listing (reply to `files.list`).
    #[serde(rename = "files.listing")]
    FilesListing {
        #[serde(rename = "deviceId")]
        device_id: String,
        #[serde(rename = "opId")]
        op_id: String,
        listing: Option<FileListing>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// Recursive usage of a directory's children (reply to `files.analyze`).
    #[serde(rename = "files.usage")]
    FilesUsage {
        #[serde(rename = "deviceId")]
        device_id: String,
        #[serde(rename = "opId")]
        op_id: String,
        entries: Vec<FileUsageEntry>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// Search hits (reply to `files.search`).
    #[serde(rename = "files.matches")]
    FilesMatches {
        #[serde(rename = "deviceId")]
        device_id: String,
        #[serde(rename = "opId")]
        op_id: String,
        matches: Vec<FileMatch>,
        truncated: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// Outcome of a `files.mutate` (delete/mkdir/rename) or an upload.
    #[serde(rename = "files.opResult")]
    FilesOpResult {
        #[serde(rename = "deviceId")]
        device_id: String,
        #[serde(rename = "opId")]
        op_id: String,
        op: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// One chunk of a downloaded file (`data` base64; the last carries `done`).
    #[serde(rename = "files.chunk")]
    FilesChunk {
        #[serde(rename = "deviceId")]
        device_id: String,
        #[serde(rename = "opId")]
        op_id: String,
        data: String,
        done: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// CloudSync: the local watcher saw the share's folder change (debounced).
    #[serde(rename = "sync.changed")]
    SyncChanged {
        #[serde(rename = "deviceId")]
        device_id: String,
        #[serde(rename = "shareId")]
        share_id: i64,
    },
    /// CloudSync: one batch of scanned index entries (last carries `done`).
    #[serde(rename = "sync.index")]
    SyncIndex {
        #[serde(rename = "deviceId")]
        device_id: String,
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "shareId")]
        share_id: i64,
        entries: Vec<SyncIndexEntry>,
        done: bool,
        /// Le disque a-t-il réellement été parcouru ? Toujours sérialisé : un
        /// serveur récent en a besoin pour distinguer « rien à signaler » d'un
        /// scan complet qui n'a rien trouvé.
        scanned: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        fingerprint: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// CloudSync: one upload chunk (reply to `sync.push`); the final frame
    /// carries the observed hash/size/mtime so the server can detect a file
    /// that changed mid-read (it then discards the transfer).
    #[serde(rename = "sync.chunk")]
    SyncChunk {
        #[serde(rename = "deviceId")]
        device_id: String,
        #[serde(rename = "opId")]
        op_id: String,
        data: String,
        done: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        hash: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        size: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        mtime: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// CloudSync: flow-control credit — chunk `seq` of a `sync.applyChunk` landed.
    #[serde(rename = "sync.ack")]
    SyncAck {
        #[serde(rename = "deviceId")]
        device_id: String,
        #[serde(rename = "opId")]
        op_id: String,
        seq: u64,
    },
    /// CloudSync: outcome of a local op (`apply` install, `delete` to trash, `push`).
    #[serde(rename = "sync.opResult")]
    SyncOpResult {
        #[serde(rename = "deviceId")]
        device_id: String,
        #[serde(rename = "opId")]
        op_id: String,
        op: String,
        ok: bool,
        /// `applyReady` seulement : octets de clair déjà détenus pour ce hash,
        /// pour que le serveur ne renvoie que ce qui manque.
        #[serde(rename = "resumeFrom", skip_serializing_if = "Option::is_none")]
        resume_from: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// Reply to `pkg.list`: the package managers present + their pending counts.
    #[serde(rename = "pkg.listResult")]
    PkgListResult {
        #[serde(rename = "deviceId")]
        device_id: String,
        managers: Vec<PackageManagerInfo>,
    },
    /// One live output line of an in-progress `pkg.upgrade`.
    #[serde(rename = "pkg.progress")]
    PkgProgress {
        #[serde(rename = "deviceId")]
        device_id: String,
        manager: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        percent: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        phase: Option<String>,
        line: String,
    },
    /// Final outcome of a `pkg.upgrade`.
    #[serde(rename = "pkg.done")]
    PkgDone {
        #[serde(rename = "deviceId")]
        device_id: String,
        manager: String,
        ok: bool,
        #[serde(rename = "rebootRequired", skip_serializing_if = "Option::is_none")]
        reboot_required: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
}

/// Messages the server sends back to the agent.
#[derive(Debug, Deserialize)]
#[serde(tag = "command", content = "payload")]
pub enum ServerMessage {
    #[serde(rename = "agent.ack")]
    Ack { received: u32 },
    #[serde(rename = "agent.error")]
    Error { code: String, message: String },
    /// Push a fresh sample + report immediately (user clicked "refresh").
    #[serde(rename = "agent.collect")]
    Collect {},
    /// Relevé Sentinelle immédiat (persistance + authentification).
    ///
    /// Distinct de `Collect` exprès : celui-là coûte quelques millisecondes,
    /// celui-ci empreinte des centaines de fichiers. Les confondre ferait payer
    /// ce prix à chaque « rafraîchir » de la page Monitoring.
    #[serde(rename = "agent.scan")]
    Scan {},
    /// Self-destruct: wipe local config + binary and exit (device being deleted).
    #[serde(rename = "agent.destroy")]
    Destroy {},
    /// Self-update: download, verify (sha256 + ed25519 signature) and swap in a
    /// newer binary for `target_id`, then restart.
    #[serde(rename = "agent.update")]
    Update {
        #[serde(rename = "targetId")]
        target_id: String,
        version: String,
        sha256: String,
        signature: String,
    },
    /// Persistence/privilege change: `action` is one of `install-user` |
    /// `uninstall-user` | `elevate` | `drop`.
    #[serde(rename = "agent.service")]
    Service { action: String },
    /// System power action: `action` is one of `shutdown` | `reboot` | `suspend` |
    /// `hibernate` | `lock`. The agent applies it best-effort and replies
    /// `agent.powerResult`.
    #[serde(rename = "agent.power")]
    Power { action: String },
    /// Enumerate the host's log sources (replies `log.sourcesResult`).
    #[serde(rename = "log.sources")]
    LogSources {},
    /// Run one log query; streams `log.lines` back, the last with `done: true`.
    #[serde(rename = "log.query")]
    LogQuery {
        #[serde(rename = "queryId")]
        query_id: String,
        #[serde(rename = "sourceId")]
        source_id: String,
        #[serde(default)]
        filter: Option<LogFilter>,
        #[serde(default)]
        limit: Option<u32>,
    },
    /// Open an interactive PTY session. `user`, when set, runs the shell under that
    /// account (`su -l`); otherwise it's the account the agent runs as.
    #[serde(rename = "term.open")]
    TermOpen {
        #[serde(rename = "sessionId")]
        session_id: String,
        cols: u16,
        rows: u16,
        #[serde(default)]
        user: Option<String>,
    },
    /// Write input bytes (base64) to a session's PTY.
    #[serde(rename = "term.input")]
    TermInput {
        #[serde(rename = "sessionId")]
        session_id: String,
        data: String,
    },
    /// Resize a session's PTY.
    #[serde(rename = "term.resize")]
    TermResize {
        #[serde(rename = "sessionId")]
        session_id: String,
        cols: u16,
        rows: u16,
    },
    /// Close a session (kill the shell, free the PTY).
    #[serde(rename = "term.close")]
    TermClose {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    /// List a directory (replies `files.listing`).
    #[serde(rename = "files.list")]
    FilesList {
        #[serde(rename = "opId")]
        op_id: String,
        path: String,
    },
    /// Analyse a directory's recursive usage (replies `files.usage`).
    #[serde(rename = "files.analyze")]
    FilesAnalyze {
        #[serde(rename = "opId")]
        op_id: String,
        path: String,
    },
    /// Recursively search a directory (replies `files.matches`).
    #[serde(rename = "files.search")]
    FilesSearch {
        #[serde(rename = "opId")]
        op_id: String,
        path: String,
        filter: FileSearchFilter,
    },
    /// Mutate the filesystem: delete / mkdir / rename (replies `files.opResult`).
    #[serde(rename = "files.mutate")]
    FilesMutate {
        #[serde(rename = "opId")]
        op_id: String,
        op: String,
        path: String,
        #[serde(default)]
        dest: Option<String>,
    },
    /// Download a file (streams `files.chunk`).
    #[serde(rename = "files.download")]
    FilesDownload {
        #[serde(rename = "opId")]
        op_id: String,
        path: String,
    },
    /// Upload one chunk of a file at `offset` (base64 `data`; confirms on `done`).
    #[serde(rename = "files.upload")]
    FilesUpload {
        #[serde(rename = "opId")]
        op_id: String,
        path: String,
        offset: u64,
        data: String,
        done: bool,
    },
    /// CloudSync: full assignment list (on connect + on any change). Replaces
    /// the previous set: shares absent from the list stop being watched.
    #[serde(rename = "sync.config")]
    SyncConfig { shares: Vec<SyncShareAssignment> },
    /// CloudSync: scan the share's local folder (streams `sync.index` batches).
    #[serde(rename = "sync.scan")]
    SyncScan {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "shareId")]
        share_id: i64,
        /// `auto` autorise la réponse rapide, `full` impose le parcours complet.
        ///
        /// `Option` plutôt qu'un défaut serde : champ ABSENT veut dire vieux
        /// serveur, et un vieux serveur doit obtenir le comportement d'avant,
        /// c'est-à-dire un scan complet. La dissymétrie de version dégrade donc
        /// vers « on parcourt », jamais vers « on saute ».
        #[serde(default)]
        mode: Option<String>,
    },
    /// CloudSync: upload one local file (streams `sync.chunk`).
    #[serde(rename = "sync.push")]
    SyncPush {
        #[serde(rename = "opId")]
        op_id: String,
        #[serde(rename = "shareId")]
        share_id: i64,
        #[serde(rename = "relPath")]
        rel_path: String,
        /// Reprise : octets déjà détenus par le serveur, à ne pas renvoyer.
        #[serde(rename = "startOffset", default)]
        start_offset: u64,
    },
    /// CloudSync: one download chunk to install (hash/size/mtime repeated on
    /// every frame; ack each chunk; on `done` verify then rename atomically).
    #[serde(rename = "sync.applyChunk")]
    SyncApplyChunk {
        #[serde(rename = "opId")]
        op_id: String,
        #[serde(rename = "shareId")]
        share_id: i64,
        #[serde(rename = "relPath")]
        rel_path: String,
        seq: u64,
        data: String,
        done: bool,
        hash: String,
        size: u64,
        mtime: i64,
        #[serde(default)]
        mode: Option<u32>,
        /// Offset de clair décidé par le SERVEUR pour cette reprise. L'agent
        /// tronque son temporaire à cette valeur : il ne doit jamais présumer
        /// de son propre point de reprise, sous peine de diverger.
        #[serde(rename = "resumeFrom", default)]
        resume_from: u64,
    },
    /// CloudSync: prepare a download. The agent replies `sync.opResult` with
    /// `op: "applyReady"` and the number of plaintext bytes it already holds for
    /// this exact hash, so the server only resends what is missing.
    // `rel_path`/`size`/`mtime`/`mode` sont portés par le protocole (le serveur
    // les répète sur chaque frame) mais l'amorce n'a besoin que du hash : c'est
    // lui seul qui identifie le partiel réutilisable.
    #[allow(dead_code)]
    #[serde(rename = "sync.applyStart")]
    SyncApplyStart {
        #[serde(rename = "opId")]
        op_id: String,
        #[serde(rename = "shareId")]
        share_id: i64,
        #[serde(rename = "relPath")]
        rel_path: String,
        hash: String,
        size: u64,
        mtime: i64,
        #[serde(default)]
        mode: Option<u32>,
    },
    /// CloudSync: create an empty directory (no bytes transferred). The
    /// counterpart of `sync.applyChunk` for `dir` index entries, and the way a
    /// permission-only change reaches a device.
    #[serde(rename = "sync.applyDir")]
    SyncApplyDir {
        #[serde(rename = "opId")]
        op_id: String,
        #[serde(rename = "shareId")]
        share_id: i64,
        #[serde(rename = "relPath")]
        rel_path: String,
        /// `dir` autorise la création du chemin ; `file` ne fait qu'ajuster le
        /// mode d'un chemin existant.
        #[serde(default = "default_dir_kind")]
        kind: String,
        #[serde(default)]
        mode: Option<u32>,
    },
    /// CloudSync: install content the device ALREADY holds elsewhere in the
    /// share (rename, move, copy). The agent verifies the source's hash before
    /// copying; on any failure the server falls back to a chunked download.
    #[serde(rename = "sync.applyLocal")]
    SyncApplyLocal {
        #[serde(rename = "opId")]
        op_id: String,
        #[serde(rename = "shareId")]
        share_id: i64,
        #[serde(rename = "relPath")]
        rel_path: String,
        #[serde(rename = "sourceRelPath")]
        source_rel_path: String,
        hash: String,
        size: u64,
        mtime: i64,
        #[serde(default)]
        mode: Option<u32>,
    },
    /// CloudSync: rename a file in place. No transfer, no trash — the content
    /// does not move, only its path does.
    #[serde(rename = "sync.move")]
    SyncMove {
        #[serde(rename = "opId")]
        op_id: String,
        #[serde(rename = "shareId")]
        share_id: i64,
        #[serde(rename = "fromRelPath")]
        from_rel_path: String,
        #[serde(rename = "relPath")]
        rel_path: String,
        hash: String,
        size: u64,
        mtime: i64,
        #[serde(default)]
        mode: Option<u32>,
    },
    /// CloudSync: move a local file to the share's trash (`.deveye-trash/`).
    /// Only ever sent once a hash-verified server-side version exists.
    #[serde(rename = "sync.delete")]
    SyncDelete {
        #[serde(rename = "opId")]
        op_id: String,
        #[serde(rename = "shareId")]
        share_id: i64,
        #[serde(rename = "relPath")]
        rel_path: String,
    },
    /// Enumerate package managers + pending updates (replies `pkg.listResult`).
    #[serde(rename = "pkg.list")]
    PkgList {},
    /// Apply all updates of one manager, streaming `pkg.progress` then `pkg.done`.
    #[serde(rename = "pkg.upgrade")]
    PkgUpgrade { manager: String },
    /// Stop (`stop`) or cleanly restart (`restart`) this agent *process* — not
    /// the machine. No reply frame: the process exits (and possibly comes back).
    #[serde(rename = "agent.lifecycle")]
    Lifecycle { action: String },
    /// Per-device collection config (one cadence + capture mode), pushed by the
    /// server on connect and whenever the user changes it in the UI.
    #[serde(rename = "agent.config")]
    Config {
        /// The single collection interval: one tick = metrics + processes.
        #[serde(rename = "metricIntervalMs")]
        metric_interval_ms: u64,
        #[serde(rename = "processCapture")]
        process_capture: String,
        /// Sentinelle est-elle active sur cet appareil ?
        ///
        /// Éteinte, l'agent ne relève ni persistance ni authentification. Ces
        /// deux sondes ne coûtent rien à qui ne les demande pas, et une machine
        /// non surveillée ne doit pas voir ses journaux lus « au cas où ».
        ///
        /// `Option` avec défaut : un serveur antérieur à Sentinelle n'envoie pas
        /// le champ, et l'agent se comporte alors comme avant.
        #[serde(rename = "sentinelEnabled", default)]
        sentinel_enabled: Option<bool>,
        #[serde(rename = "integrityIntervalMs", default)]
        integrity_interval_ms: Option<u64>,
        #[serde(rename = "authEventsEnabled", default)]
        auth_events_enabled: Option<bool>,
    },
}

/// Standard server result envelope: `{ ok, data? , error? }`.
#[derive(Debug, Deserialize)]
pub struct ApiResult<T> {
    pub ok: bool,
    #[serde(default)]
    pub data: Option<T>,
    #[serde(default)]
    pub error: Option<ApiError>,
}

#[derive(Debug, Default, Deserialize)]
pub struct ApiError {
    pub code: String,
    pub message: String,
}

/// POST /api/agent/enroll request body.
#[derive(Debug, Serialize)]
pub struct EnrollRequest {
    pub code: String,
    pub name: String,
    pub fingerprint: String,
    pub platform: String,
    #[serde(rename = "publicKey")]
    pub public_key: String,
}

/// POST /api/agent/enroll response payload.
#[derive(Debug, Default, Deserialize)]
pub struct EnrollData {
    #[serde(rename = "deviceId")]
    pub device_id: String,
    #[serde(rename = "deviceToken")]
    pub device_token: String,
    /// The enrolled device, so the agent can report the real status (a code with
    /// auto-approval lands the device directly as `active`, not `pending`).
    #[serde(default)]
    pub device: Option<EnrolledDevice>,
}

#[derive(Debug, Default, Deserialize)]
pub struct EnrolledDevice {
    #[serde(default)]
    pub status: String,
}
