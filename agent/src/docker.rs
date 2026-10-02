//! Container management: inventory the host's containers, images, volumes and
//! networks, sample their live resource use, and carry out a closed list of
//! actions on them.
//!
//! Engines are driven through their CLI, the way `logs.rs` already reads
//! container logs: no daemon socket and no client crate, so podman comes free
//! (it takes the same flags) and the cross-compiled binary gains no dependency.
//! Output is asked for as tab-separated Go templates rather than `--format
//! json`: the JSON field names diverge between the two engines, the templates
//! do not.
//!
//! Everything runs with the agent's own privileges. An engine whose daemon
//! refuses (socket permissions, daemon down) is reported as unreachable rather
//! than as an empty host: "no containers" and "not allowed to look" must not
//! read the same on screen.

use std::process::Stdio;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command as TokioCommand;
use tokio::sync::mpsc::Sender;

use crate::logs::{run_bounded_capped, run_capture, DETECT_TIMEOUT};
use crate::protocol::{
    DockerContainer, DockerEngineStatus, DockerImage, DockerInventory, DockerNetwork, DockerStat,
    DockerVolume,
};

/// Container engines we drive. Both expose the same `ps`, `logs` and management
/// surface, so one implementation serves them; every object carries which engine
/// it came from, because a host can perfectly well run both.
pub(crate) const CONTAINER_RUNTIMES: [&str; 2] = ["docker", "podman"];

/// Séparateur des gabarits Go. Une tabulation littérale ne peut pas apparaître
/// dans les champs qu'on demande (noms, images, états), donc le découpage est sûr.
const SEP: char = '\t';

/// Deadline of a long action. `pull` d'une grosse image et `prune` d'un hôte
/// chargé se comptent en minutes ; au-delà, c'est un blocage, pas une lenteur.
const ACTION_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// Events streamed from a docker task back to the session loop (which turns them
/// into wire messages carrying the device id).
pub enum DockerEvent {
    Inventory(DockerInventory),
    Stats(Vec<DockerStat>),
    Progress {
        op_id: String,
        line: String,
    },
    Done {
        op_id: String,
        action: String,
        ok: bool,
        error: Option<String>,
    },
}

/// Split a template line on tabs, into exactly `n` fields; `None` when the line
/// is short (an engine that dropped a column) so it is skipped rather than
/// yielding a half-built object.
fn fields(line: &str, n: usize) -> Option<Vec<&str>> {
    let parts: Vec<&str> = line.splitn(n, SEP).collect();
    if parts.len() < n || parts[0].is_empty() {
        return None;
    }
    Some(parts)
}

/// Normalise the engines' state wording. Anything unmodelled becomes `unknown`
/// rather than dropping the container from the inventory.
fn normalise_state(raw: &str) -> String {
    let s = raw.trim().to_ascii_lowercase();
    let known = [
        "running",
        "exited",
        "paused",
        "created",
        "restarting",
        "removing",
        "dead",
    ];
    if known.contains(&s.as_str()) {
        s
    } else {
        "unknown".to_string()
    }
}

fn opt(value: &str) -> Option<String> {
    let v = value.trim();
    if v.is_empty() {
        None
    } else {
        Some(v.to_string())
    }
}

/// Probe one engine: is the binary there, and does its daemon answer?
fn engine_status(bin: &str) -> Option<DockerEngineStatus> {
    // `version --format {{.Server.Version}}` échoue si le démon ne répond pas,
    // là où `--version` réussit sur le seul binaire : c'est la distinction qu'on
    // cherche à faire.
    let probe = run_bounded_capped(
        &format!("{bin} version"),
        bin,
        &["version", "--format", "{{.Server.Version}}"],
        DETECT_TIMEOUT,
        None,
        None,
    );
    match probe {
        Ok((stdout, _)) => Some(DockerEngineStatus {
            engine: bin.to_string(),
            reachable: true,
            version: opt(&String::from_utf8_lossy(&stdout)),
            error: None,
        }),
        Err(e) => {
            // Binaire absent : l'hôte ne fait simplement pas de conteneurs avec
            // ce moteur, on n'en dit rien. Démon injoignable : on le dit.
            if which(bin) {
                Some(DockerEngineStatus {
                    engine: bin.to_string(),
                    reachable: false,
                    version: None,
                    error: Some(truncate(&e.to_string(), 255)),
                })
            } else {
                None
            }
        }
    }
}

fn which(bin: &str) -> bool {
    std::process::Command::new(bin)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn truncate(s: &str, max: usize) -> String {
    let t = s.trim();
    if t.chars().count() <= max {
        return t.to_string();
    }
    t.chars().take(max).collect()
}

/// Enumerate everything one reachable engine holds.
fn collect_engine(
    bin: &str,
    containers: &mut Vec<DockerContainer>,
    images: &mut Vec<DockerImage>,
    volumes: &mut Vec<DockerVolume>,
    networks: &mut Vec<DockerNetwork>,
) {
    if let Some(list) = run_capture(
        bin,
        &[
            "ps",
            "-a",
            "--no-trunc",
            "--format",
            concat!(
                "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}\t{{.Ports}}\t{{.CreatedAt}}",
                "\t{{.Label \"com.docker.compose.project\"}}",
                "\t{{.Label \"com.docker.compose.service\"}}",
                "\t{{.Label \"com.docker.compose.project.working_dir\"}}"
            ),
        ],
    ) {
        for line in list.lines() {
            let Some(f) = fields(line, 10) else { continue };
            containers.push(DockerContainer {
                engine: bin.to_string(),
                id: f[0].to_string(),
                name: f[1].to_string(),
                image: f[2].to_string(),
                state: normalise_state(f[3]),
                status: f[4].to_string(),
                ports: f[5].to_string(),
                created_at: f[6].to_string(),
                compose_project: opt(f[7]),
                compose_service: opt(f[8]),
                compose_working_dir: opt(f[9]),
            });
        }
    }

    if let Some(list) = run_capture(
        bin,
        &[
            "images",
            "--no-trunc",
            "--format",
            "{{.ID}}\t{{.Repository}}\t{{.Tag}}\t{{.Size}}\t{{.CreatedAt}}",
        ],
    ) {
        for line in list.lines() {
            let Some(f) = fields(line, 5) else { continue };
            let dangling = f[1] == "<none>" || f[2] == "<none>";
            images.push(DockerImage {
                engine: bin.to_string(),
                id: f[0].to_string(),
                reference: format!("{}:{}", f[1], f[2]),
                size: f[3].to_string(),
                created_at: f[4].to_string(),
                dangling,
            });
        }
    }

    if let Some(list) = run_capture(
        bin,
        &[
            "volume",
            "ls",
            "--format",
            "{{.Name}}\t{{.Driver}}\t{{.Mountpoint}}",
        ],
    ) {
        for line in list.lines() {
            let Some(f) = fields(line, 3) else { continue };
            volumes.push(DockerVolume {
                engine: bin.to_string(),
                name: f[0].to_string(),
                driver: f[1].to_string(),
                mountpoint: f[2].to_string(),
            });
        }
    }

    if let Some(list) = run_capture(
        bin,
        &[
            "network",
            "ls",
            "--no-trunc",
            "--format",
            "{{.ID}}\t{{.Name}}\t{{.Driver}}\t{{.Scope}}",
        ],
    ) {
        for line in list.lines() {
            let Some(f) = fields(line, 4) else { continue };
            networks.push(DockerNetwork {
                engine: bin.to_string(),
                id: f[0].to_string(),
                name: f[1].to_string(),
                driver: f[2].to_string(),
                scope: f[3].to_string(),
            });
        }
    }
}

/// The host's whole container inventory. Synchronous (shells out); the caller
/// runs it off the runtime via `spawn_blocking`.
pub fn inventory() -> DockerInventory {
    let mut engines = Vec::new();
    let mut containers = Vec::new();
    let mut images = Vec::new();
    let mut volumes = Vec::new();
    let mut networks = Vec::new();

    for bin in CONTAINER_RUNTIMES {
        let Some(status) = engine_status(bin) else {
            continue;
        };
        if status.reachable {
            collect_engine(
                bin,
                &mut containers,
                &mut images,
                &mut volumes,
                &mut networks,
            );
        }
        engines.push(status);
    }

    DockerInventory {
        engines,
        containers,
        images,
        volumes,
        networks,
    }
}

/// Parse a percentage the engine printed ("12.34%").
fn parse_percent(s: &str) -> Option<f64> {
    s.trim().trim_end_matches('%').parse::<f64>().ok()
}

/// Parse one of the engines' human sizes ("1.5GiB", "934.2kB", "0B").
fn parse_size(s: &str) -> Option<u64> {
    let t = s.trim();
    let split = t.find(|c: char| c.is_ascii_alphabetic()).unwrap_or(t.len());
    let value: f64 = t[..split].trim().parse().ok()?;
    let unit = t[split..].trim().to_ascii_lowercase();
    // Les deux moteurs impriment tantôt les unités SI, tantôt les binaires.
    let factor: f64 = match unit.as_str() {
        "" | "b" => 1.0,
        "kb" => 1e3,
        "mb" => 1e6,
        "gb" => 1e9,
        "tb" => 1e12,
        "kib" => 1024.0,
        "mib" => 1024f64.powi(2),
        "gib" => 1024f64.powi(3),
        "tib" => 1024f64.powi(4),
        _ => return None,
    };
    let bytes = value * factor;
    if bytes.is_finite() && bytes >= 0.0 {
        Some(bytes as u64)
    } else {
        None
    }
}

/// Split one of the engines' `A / B` pairs (mem usage, net I/O, block I/O).
fn parse_pair(s: &str) -> (Option<u64>, Option<u64>) {
    match s.split_once('/') {
        Some((a, b)) => (parse_size(a), parse_size(b)),
        None => (parse_size(s), None),
    }
}

/// One resource sample per running container. Synchronous; run off the runtime.
pub fn stats() -> Vec<DockerStat> {
    let mut out = Vec::new();
    for bin in CONTAINER_RUNTIMES {
        let Some(list) = run_capture(
            bin,
            &[
                "stats",
                "--no-stream",
                "--no-trunc",
                "--format",
                "{{.ID}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.NetIO}}\t{{.BlockIO}}\t{{.PIDs}}",
            ],
        ) else {
            continue;
        };
        for line in list.lines() {
            let Some(f) = fields(line, 7) else { continue };
            let (mem_used, mem_limit) = parse_pair(f[2]);
            let (rx, tx) = parse_pair(f[4]);
            let (read, write) = parse_pair(f[5]);
            out.push(DockerStat {
                engine: bin.to_string(),
                id: f[0].to_string(),
                cpu_percent: parse_percent(f[1]),
                mem_used_bytes: mem_used,
                mem_limit_bytes: mem_limit,
                mem_percent: parse_percent(f[3]),
                net_rx_bytes: rx,
                net_tx_bytes: tx,
                block_read_bytes: read,
                block_write_bytes: write,
                pids: f[6].trim().parse::<u64>().ok(),
            });
        }
    }
    out
}

/// Actions that stream their output and can run for minutes. Mirrors
/// `DOCKER_LONG_ACTIONS` in @deveye/types: only these take the single-slot lock.
pub fn is_long_action(action: &str) -> bool {
    matches!(
        action,
        "pull"
            | "recreate"
            | "composeDeploy"
            | "pruneContainers"
            | "pruneImages"
            | "pruneVolumes"
            | "pruneNetworks"
            | "pruneBuildCache"
    )
}

/// What one command runs: the arguments, and the directory it runs in (compose
/// needs its project's, everything else runs anywhere). An action is one or
/// more of them, run in order.
#[derive(Debug, PartialEq)]
struct ActionSpec {
    args: Vec<String>,
    cwd: Option<String>,
}

/// Map an action to its command line. The server already validates the enum —
/// this `match` is the defence in depth, and the reason no caller-supplied
/// string but `target` ever reaches a command line. There is no shell: the
/// arguments go straight to `exec`.
fn action_command(action: &str, target: Option<&str>) -> Result<ActionSpec> {
    let simple = |verb: &[&str]| -> Result<ActionSpec> {
        let t = target.context("cette action demande une cible")?;
        let mut args: Vec<String> = verb.iter().map(|s| s.to_string()).collect();
        args.push(t.to_string());
        Ok(ActionSpec { args, cwd: None })
    };
    let bare = |verb: &[&str]| -> Result<ActionSpec> {
        Ok(ActionSpec {
            args: verb.iter().map(|s| s.to_string()).collect(),
            cwd: None,
        })
    };

    match action {
        "start" => simple(&["start"]),
        "stop" => simple(&["stop"]),
        "restart" => simple(&["restart"]),
        "pause" => simple(&["pause"]),
        "unpause" => simple(&["unpause"]),
        "kill" => simple(&["kill"]),
        "removeContainer" => simple(&["rm", "-f"]),
        "removeImage" => simple(&["rmi", "-f"]),
        "removeVolume" => simple(&["volume", "rm", "-f"]),
        "removeNetwork" => simple(&["network", "rm"]),
        "pull" => simple(&["pull"]),
        "pruneContainers" => bare(&["container", "prune", "-f"]),
        "pruneImages" => bare(&["image", "prune", "-a", "-f"]),
        "pruneVolumes" => bare(&["volume", "prune", "-f"]),
        "pruneNetworks" => bare(&["network", "prune", "-f"]),
        "pruneBuildCache" => bare(&["builder", "prune", "-a", "-f"]),
        other => bail!("action inconnue : {other}"),
    }
}

/// One compose label of a container, `None` when absent.
fn compose_label(bin: &str, container_id: &str, key: &str) -> Option<String> {
    run_capture(
        bin,
        &[
            "inspect",
            "--format",
            &format!("{{{{index .Config.Labels \"{key}\"}}}}"),
            container_id,
        ],
    )
    .and_then(|s| opt(&s))
}

/// Recreating a container means rebuilding its whole run configuration (ports,
/// mounts, env, networks, restart policy). Reading that back out of `inspect` is
/// not faithful enough to be safe, so only compose-managed containers can be
/// recreated: compose already holds the configuration, and re-applies it.
fn recreate_command(bin: &str, container_id: &str) -> Result<ActionSpec> {
    let label = |key: &str| compose_label(bin, container_id, key);
    let (Some(project), Some(service)) = (
        label("com.docker.compose.project"),
        label("com.docker.compose.service"),
    ) else {
        bail!(
            "Ce conteneur n'a pas été créé par compose : sa configuration de lancement \
             (ports, montages, variables, réseaux) n'est pas reconstructible de façon fiable. \
             Recréez-le depuis l'outil qui l'a créé."
        );
    };
    let cwd = label("com.docker.compose.project.working_dir");
    Ok(ActionSpec {
        args: vec![
            "compose".into(),
            "-p".into(),
            project,
            "up".into(),
            "-d".into(),
            "--force-recreate".into(),
            service,
        ],
        cwd,
    })
}

/// A compose name as the engines accept it: letters, digits, `_`, `-`, and `.`
/// past the first character. Anything else is refused before any command runs,
/// though no shell would read it.
fn is_compose_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
        && name.len() <= 128
}

/// `project/service`: the target of a `composeDeploy`. A service, not a
/// container: the container id changes at every recreate.
fn parse_compose_target(target: &str) -> Result<(String, String)> {
    let (project, service) = target
        .split_once('/')
        .context("cible attendue : projet/service")?;
    if !is_compose_name(project) || !is_compose_name(service) {
        bail!("nom de projet ou de service compose invalide : {target}");
    }
    Ok((project.to_string(), service.to_string()))
}

/// Deploying a compose service: pull its image, then recreate it alone
/// (`--no-deps` leaves its neighbours running). The project is addressed the
/// way compose started it: its name, its files when the label lists them, and
/// its directory. Nothing is built here: the image comes from its registry.
fn compose_deploy_commands(
    project: &str,
    service: &str,
    working_dir: Option<String>,
    config_files: &[String],
) -> Vec<ActionSpec> {
    let mut base: Vec<String> = vec!["compose".into(), "-p".into(), project.into()];
    for file in config_files {
        base.push("-f".into());
        base.push(file.clone());
    }
    let step = |tail: &[&str]| ActionSpec {
        args: base
            .iter()
            .cloned()
            .chain(tail.iter().map(|s| s.to_string()))
            .collect(),
        cwd: working_dir.clone(),
    };
    vec![
        step(&["pull", service]),
        step(&["up", "-d", "--force-recreate", "--no-deps", service]),
    ]
}

/// Where compose keeps a service: read on one of its containers, running or not.
fn compose_deploy_plan(bin: &str, target: &str) -> Result<Vec<ActionSpec>> {
    let (project, service) = parse_compose_target(target)?;
    let listed = run_capture(
        bin,
        &[
            "ps",
            "-a",
            "--filter",
            &format!("label=com.docker.compose.project={project}"),
            "--filter",
            &format!("label=com.docker.compose.service={service}"),
            "--format",
            "{{.ID}}",
        ],
    )
    .unwrap_or_default();
    let Some(id) = listed.lines().map(str::trim).find(|l| !l.is_empty()) else {
        bail!("Aucun conteneur du service {service} dans le projet compose {project} sur cette machine.");
    };
    let working_dir = compose_label(bin, id, "com.docker.compose.project.working_dir");
    let config_files: Vec<String> =
        compose_label(bin, id, "com.docker.compose.project.config_files")
            .map(|files| {
                files
                    .split(',')
                    .map(str::trim)
                    .filter(|f| !f.is_empty())
                    .map(String::from)
                    .collect()
            })
            .unwrap_or_default();
    if working_dir.is_none() && config_files.is_empty() {
        bail!("Le projet compose {project} ne dit pas où vit son fichier : impossible de le relancer d'ici.");
    }
    Ok(compose_deploy_commands(
        &project,
        &service,
        working_dir,
        &config_files,
    ))
}

/// Carry out one action, streaming its output then a terminal `Done`.
pub async fn run_action(
    engine: String,
    action: String,
    target: Option<String>,
    op_id: String,
    tx: Sender<DockerEvent>,
) {
    let result = action_inner(&engine, &action, target.as_deref(), &op_id, &tx).await;
    let done = match result {
        Ok(()) => DockerEvent::Done {
            op_id,
            action,
            ok: true,
            error: None,
        },
        Err(e) => DockerEvent::Done {
            op_id,
            action,
            ok: false,
            error: Some(truncate(&e.to_string(), 500)),
        },
    };
    let _ = tx.send(done).await;
}

async fn action_inner(
    engine: &str,
    action: &str,
    target: Option<&str>,
    op_id: &str,
    tx: &Sender<DockerEvent>,
) -> Result<()> {
    if !CONTAINER_RUNTIMES.contains(&engine) {
        bail!("moteur inconnu : {engine}");
    }
    let steps = match action {
        "recreate" | "composeDeploy" => {
            let target = target
                .context("cette action demande une cible")?
                .to_string();
            let bin = engine.to_string();
            let action = action.to_string();
            tokio::task::spawn_blocking(move || {
                if action == "recreate" {
                    recreate_command(&bin, &target).map(|spec| vec![spec])
                } else {
                    compose_deploy_plan(&bin, &target)
                }
            })
            .await??
        }
        _ => vec![action_command(action, target)?],
    };
    // Une seule échéance pour toutes les étapes : le serveur attend l'action
    // entière, pas chacune de ses commandes.
    let deadline = tokio::time::Instant::now() + ACTION_TIMEOUT;
    for spec in &steps {
        run_step(engine, action, spec, op_id, tx, deadline).await?;
    }
    Ok(())
}

/// One command of an action: its output streamed line by line, bounded by the
/// action's deadline.
async fn run_step(
    engine: &str,
    action: &str,
    spec: &ActionSpec,
    op_id: &str,
    tx: &Sender<DockerEvent>,
    deadline: tokio::time::Instant,
) -> Result<()> {
    let mut cmd = TokioCommand::new(engine);
    cmd.args(&spec.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = spec.cwd.as_deref() {
        cmd.current_dir(dir);
    }
    let mut child = cmd
        .spawn()
        .with_context(|| format!("lancement de {engine} {}", spec.args.join(" ")))?;

    let stdout = child.stdout.take().context("stdout")?;
    let stderr = child.stderr.take().context("stderr")?;

    // Les moteurs écrivent leur progression sur stderr : les deux flux comptent,
    // et chacun a sa tâche pour qu'aucun ne bloque l'autre en remplissant son tuyau.
    let mut tasks = Vec::new();
    for pipe in [
        Box::new(stdout) as Box<dyn tokio::io::AsyncRead + Send + Unpin>,
        Box::new(stderr),
    ] {
        let tx = tx.clone();
        let op_id = op_id.to_string();
        tasks.push(tokio::spawn(async move {
            let mut lines = BufReader::new(pipe).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let trimmed = line.trim_end();
                if trimmed.is_empty() {
                    continue;
                }
                let _ = tx
                    .send(DockerEvent::Progress {
                        op_id: op_id.clone(),
                        line: truncate(trimmed, 2000),
                    })
                    .await;
            }
        }));
    }

    let status = match tokio::time::timeout_at(deadline, child.wait()).await {
        Ok(status) => status.context("attente du moteur")?,
        Err(_) => {
            let _ = child.kill().await;
            bail!(
                "abandon après {} min : le moteur n'a pas rendu la main",
                ACTION_TIMEOUT.as_secs() / 60
            );
        }
    };
    for t in tasks {
        let _ = t.await;
    }
    if !status.success() {
        match status.code() {
            Some(code) => bail!("{engine} {action} a échoué (code {code})"),
            None => bail!("{engine} {action} a été interrompu par un signal"),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_size_handles_si_and_binary_units() {
        assert_eq!(parse_size("0B"), Some(0));
        assert_eq!(parse_size("1kB"), Some(1_000));
        assert_eq!(parse_size("1KiB"), Some(1_024));
        assert_eq!(parse_size("1.5GiB"), Some(1_610_612_736));
        assert_eq!(parse_size("934.2kB"), Some(934_200));
        assert_eq!(parse_size("--"), None);
    }

    #[test]
    fn parse_pair_splits_the_engines_slash_notation() {
        assert_eq!(
            parse_pair("12MiB / 2GiB"),
            (Some(12_582_912), Some(2_147_483_648))
        );
        assert_eq!(parse_pair("5kB"), (Some(5_000), None));
    }

    #[test]
    fn parse_percent_strips_the_sign() {
        assert_eq!(parse_percent("12.34%"), Some(12.34));
        assert_eq!(parse_percent("0.00%"), Some(0.0));
        assert_eq!(parse_percent("--"), None);
    }

    #[test]
    fn normalise_state_keeps_known_words_and_folds_the_rest() {
        assert_eq!(normalise_state("Running"), "running");
        assert_eq!(normalise_state("exited"), "exited");
        assert_eq!(normalise_state("configured"), "unknown");
    }

    #[test]
    fn fields_skips_short_and_headless_lines() {
        assert!(fields("a\tb\tc", 3).is_some());
        assert!(fields("a\tb", 3).is_none());
        assert!(fields("\tb\tc", 3).is_none());
    }

    #[test]
    fn action_command_is_a_closed_list() {
        assert!(action_command("start", Some("abc")).is_ok());
        // Une cible est exigée là où la commande en attend une.
        assert!(action_command("start", None).is_err());
        // Les nettoyages n'en prennent aucune.
        assert!(action_command("pruneImages", None).is_ok());
        assert!(action_command("exec", Some("abc")).is_err());
        assert!(action_command("run", Some("abc")).is_err());
    }

    #[test]
    fn compose_target_is_project_slash_service_with_safe_names() {
        assert_eq!(
            parse_compose_target("site/web").unwrap(),
            ("site".to_string(), "web".to_string())
        );
        assert!(parse_compose_target("site").is_err());
        assert!(parse_compose_target("site/web;rm").is_err());
        assert!(parse_compose_target("-p/web").is_err());
        assert!(parse_compose_target("../etc/web").is_err());
    }

    #[test]
    fn compose_deploy_pulls_then_recreates_the_service_alone() {
        let steps = compose_deploy_commands(
            "site",
            "web",
            Some("/srv/site".into()),
            &["/srv/site/compose.yml".into(), "/srv/site/prod.yml".into()],
        );
        let base = [
            "compose",
            "-p",
            "site",
            "-f",
            "/srv/site/compose.yml",
            "-f",
            "/srv/site/prod.yml",
        ];
        let expect = |tail: &[&str]| ActionSpec {
            args: base.iter().chain(tail).map(|s| s.to_string()).collect(),
            cwd: Some("/srv/site".into()),
        };
        assert_eq!(
            steps,
            vec![
                expect(&["pull", "web"]),
                expect(&["up", "-d", "--force-recreate", "--no-deps", "web"]),
            ]
        );
    }

    #[test]
    fn compose_deploy_is_a_long_action() {
        assert!(is_long_action("composeDeploy"));
    }

    #[test]
    fn action_command_passes_the_target_as_one_argument() {
        let spec = action_command("stop", Some("a b; rm -rf /")).unwrap();
        // Pas de shell : la cible reste un seul argument, quoi qu'elle contienne.
        assert_eq!(spec.args, vec!["stop", "a b; rm -rf /"]);
    }
}
