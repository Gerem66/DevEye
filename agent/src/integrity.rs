//! Empreintes des surfaces de persistance : les endroits où un programme
//! s'installe pour survivre au redémarrage (cron, unités systemd, agents de
//! lancement, clés SSH autorisées, comptes, sudoers, préchargement du linker).
//!
//! Jamais le contenu d'un fichier : seulement une empreinte et des métadonnées
//! (chemin, sha256, taille, date, propriétaire, droits), ce qui suffit au diff
//! serveur sans rien révéler.
//!
//! Les surfaces sont énumérées en dur, pas découvertes : un balayage large
//! coûterait cher et noierait le signal.

#[cfg(any(target_os = "linux", test))]
use std::collections::HashMap;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};

/// Plafond d'entrées d'un manifeste, aligné sur `PERSISTENCE_ENTRY_LIMIT` côté
/// serveur. Atteint, le drapeau `truncated` **coupe les suppressions** : un
/// manifeste tronqué ne prouve pas qu'une entrée a disparu, seulement qu'on a
/// cessé de regarder.
const MAX_ENTRIES: usize = 2000;

/// Taille au-delà de laquelle on n'empreinte pas : un fichier de 8 Mio dans
/// `/etc/cron.d` n'est pas une tâche planifiée, et le lire à chaque cycle
/// coûterait plus que tout le reste de la sonde.
const MAX_FILE_BYTES: u64 = 1024 * 1024;

/// How entries are fingerprinted. Bumped whenever that changes: the server
/// cannot diff two manifests of different formats, so it learns the first one
/// in the new format without findings.
///
/// 2: a link into `/usr` is fingerprinted by its target, and Windows reports
/// one entry per `Run` value and per scheduled task.
const MANIFEST_FORMAT: u32 = 2;

/// Profondeur maximale de descente dans un répertoire de surface.
///
/// `/etc/systemd/system` contient des répertoires `*.wants/` peuplés de liens :
/// deux niveaux suffisent à les voir sans partir dans une arborescence entière.
const MAX_DEPTH: usize = 2;

/// Une entrée du manifeste. Miroir de `persistenceEntrySchema` côté serveur.
#[derive(Debug, Clone, Serialize)]
pub struct PersistenceEntry {
    /// Famille d'origine : `cron`, `systemd`, `launchd`, `authorized_keys`…
    pub surface: &'static str,
    pub path: String,
    pub sha256: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
    /// Unix ms de dernière modification ; `None` si le système ne l'expose pas.
    pub mtime: Option<i64>,
    /// Mode POSIX en octal (`0644`) ; `None` sur Windows.
    pub mode: Option<String>,
    pub owner: Option<String>,
    /// The content is exactly what the installed package ships (rpm or dpkg
    /// database): an update, not an edit. `None` = not owned or not checked.
    pub vendor: Option<bool>,
}

/// Le manifeste complet. Miroir d'`integrityReportSchema`.
#[derive(Debug, Clone, Serialize)]
pub struct IntegrityReport {
    #[serde(rename = "collectedAt")]
    pub collected_at: i64,
    pub format: u32,
    pub entries: Vec<PersistenceEntry>,
    pub truncated: bool,
}

/// Une surface à relever : sa famille, et où regarder.
struct Surface {
    name: &'static str,
    /// Chemin d'un fichier **ou** d'un répertoire à parcourir.
    path: &'static str,
    /// Ne retenir que les fichiers dont le nom finit par l'un de ces suffixes.
    /// Vide = tout retenir.
    suffixes: &'static [&'static str],
}

// Les deux fabriques ne servent qu'aux tables de surfaces, propres à chaque
// plateforme ; sans `cfg`, elles seraient du code mort sur Windows.
#[cfg(any(target_os = "linux", target_os = "macos"))]
const fn s(name: &'static str, path: &'static str) -> Surface {
    Surface {
        name,
        path,
        suffixes: &[],
    }
}

#[cfg(target_os = "linux")]
const fn s_ext(
    name: &'static str,
    path: &'static str,
    suffixes: &'static [&'static str],
) -> Surface {
    Surface {
        name,
        path,
        suffixes,
    }
}

#[cfg(target_os = "linux")]
const SURFACES: &[Surface] = &[
    s("cron", "/etc/crontab"),
    s("cron", "/etc/cron.d"),
    s("cron", "/etc/cron.hourly"),
    s("cron", "/etc/cron.daily"),
    s("cron", "/etc/cron.weekly"),
    s("cron", "/etc/cron.monthly"),
    s("cron", "/var/spool/cron/crontabs"),
    s("cron", "/var/spool/cron"),
    // `/etc/systemd/system` et non `/usr/lib/systemd/system` : le second est
    // peuplé par les paquets et compte des centaines d'unités qui changent à
    // chaque mise à jour. Le premier est celui de l'administrateur — et donc
    // celui où un intrus dépose son unité.
    s_ext(
        "systemd",
        "/etc/systemd/system",
        &[".service", ".timer", ".socket"],
    ),
    s_ext("systemd", "/run/systemd/system", &[".service", ".timer"]),
    s("accounts", "/etc/passwd"),
    s("sudoers", "/etc/sudoers"),
    s("sudoers", "/etc/sudoers.d"),
    // Le préchargement du linker : un rootkit en espace utilisateur y pose sa
    // bibliothèque, et elle s'injecte alors dans **tout** ce qui démarre.
    s("ld_preload", "/etc/ld.so.preload"),
    s("profile", "/etc/profile.d"),
];

#[cfg(target_os = "macos")]
const SURFACES: &[Surface] = &[
    s("launchd", "/Library/LaunchDaemons"),
    s("launchd", "/Library/LaunchAgents"),
    s("launchd", "/System/Library/LaunchAgents"),
    s("cron", "/etc/periodic"),
    s("accounts", "/etc/passwd"),
    s("sudoers", "/etc/sudoers"),
    s("sudoers", "/etc/sudoers.d"),
];

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
const SURFACES: &[Surface] = &[];

/// L'état d'un relevé en cours. `owners` est lu une fois pour tout le relevé,
/// jamais par entrée (ce serait relire `/etc/passwd` par fichier).
struct Scan {
    entries: Vec<PersistenceEntry>,
    seen: HashSet<String>,
    owners: std::collections::HashMap<u32, String>,
}

/// Relève le manifeste. Ne lève jamais : une surface illisible est une surface
/// absente, et le reste du relevé garde toute sa valeur.
pub fn collect() -> IntegrityReport {
    let mut scan = Scan {
        entries: Vec::new(),
        seen: HashSet::new(),
        owners: passwd_owners(),
    };
    let mut truncated = false;

    for surface in SURFACES {
        if walk(surface, Path::new(surface.path), 0, &mut scan) {
            truncated = true;
            break;
        }
    }

    if !truncated && collect_home_surfaces(&mut scan) {
        truncated = true;
    }

    #[cfg(target_os = "windows")]
    if !truncated {
        truncated = collect_windows(&mut scan);
    }

    let mut entries = scan.entries;

    #[cfg(target_os = "linux")]
    mark_vendor(&mut entries);

    // Ordre stable : le serveur diffe sur les chemins, mais un manifeste trié
    // se relit à l'œil quand on le déverse dans un journal de diagnostic.
    entries.sort_by(|a, b| a.path.cmp(&b.path));

    IntegrityReport {
        collected_at: now_millis(),
        format: MANIFEST_FORMAT,
        entries,
        truncated,
    }
}

/// Parcourt une surface. Rend `true` si le plafond a été atteint.
fn walk(surface: &Surface, path: &Path, depth: usize, scan: &mut Scan) -> bool {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return false; // absent : la plupart des surfaces le sont sur une machine donnée
    };

    if meta.is_dir() {
        if depth >= MAX_DEPTH {
            return false;
        }
        let Ok(dir) = std::fs::read_dir(path) else {
            return false; // répertoire illisible sans les droits : ce n'est pas une erreur
        };
        for entry in dir.flatten() {
            if walk(surface, &entry.path(), depth + 1, scan) {
                return true;
            }
        }
        return false;
    }

    if !surface.suffixes.is_empty() {
        let name = path.file_name().map(|n| n.to_string_lossy().to_string());
        let matches = name
            .as_deref()
            .is_some_and(|n| surface.suffixes.iter().any(|ext| n.ends_with(ext)));
        if !matches {
            return false;
        }
    }

    let display = path.to_string_lossy().to_string();
    // Les surfaces se recoupent (`/var/spool/cron` et `/var/spool/cron/crontabs`)
    // et un lien peut viser un fichier déjà relevé : une entrée par chemin.
    if !scan.seen.insert(display.clone()) {
        return false;
    }

    if let Some(entry) = fingerprint(surface.name, path, &display, &scan.owners) {
        scan.entries.push(entry);
    }
    scan.entries.len() >= MAX_ENTRIES
}

/// Empreinte un fichier. `None` s'il est illisible, trop gros, ou pas un fichier.
fn fingerprint(
    surface: &'static str,
    path: &Path,
    display: &str,
    owners: &std::collections::HashMap<u32, String>,
) -> Option<PersistenceEntry> {
    // `metadata` et non `symlink_metadata` : on veut la cible d'un lien, parce
    // qu'un `*.wants/` de systemd n'est fait que de liens et que c'est bien
    // l'unité pointée qui compte.
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let size = meta.len();
    if size > MAX_FILE_BYTES {
        return None;
    }
    let linked = std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink());
    // A link into `/usr` points at a file the package manager rewrites on every
    // update: what the link says is where it points, not what the target holds.
    let digest = match linked.then(|| std::fs::canonicalize(path).ok()).flatten() {
        Some(target) if target.starts_with("/usr/") => {
            Sha256::digest(format!("→{}", target.to_string_lossy()).as_bytes())
        }
        _ => Sha256::digest(std::fs::read(path).ok()?),
    };

    Some(PersistenceEntry {
        surface,
        path: display.to_string(),
        sha256: hex(&digest),
        size_bytes: size,
        mtime: meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64),
        mode: file_mode(&meta),
        owner: file_owner(&meta, owners),
        vendor: None,
    })
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(out, "{b:02x}");
    }
    out
}

#[cfg(unix)]
fn file_mode(meta: &std::fs::Metadata) -> Option<String> {
    use std::os::unix::fs::PermissionsExt;
    Some(format!("{:04o}", meta.permissions().mode() & 0o7777))
}

#[cfg(not(unix))]
fn file_mode(_meta: &std::fs::Metadata) -> Option<String> {
    None
}

#[cfg(unix)]
fn file_owner(
    meta: &std::fs::Metadata,
    owners: &std::collections::HashMap<u32, String>,
) -> Option<String> {
    use std::os::unix::fs::MetadataExt;
    let uid = meta.uid();
    // Le numéro à défaut du nom : « 0 » reste plus utile qu'un vide, et un uid
    // sans entrée dans `/etc/passwd` est en soi une information.
    Some(owners.get(&uid).cloned().unwrap_or_else(|| uid.to_string()))
}

#[cfg(not(unix))]
fn file_owner(
    _meta: &std::fs::Metadata,
    _owners: &std::collections::HashMap<u32, String>,
) -> Option<String> {
    None
}

/// uid → nom de compte, lu une fois par relevé. `/etc/passwd` ne couvre pas les
/// comptes d'un annuaire distant : un uid non résolu reste sans nom.
#[cfg(unix)]
pub(crate) fn passwd_owners() -> std::collections::HashMap<u32, String> {
    let mut map = std::collections::HashMap::new();
    let Ok(text) = std::fs::read_to_string("/etc/passwd") else {
        return map;
    };
    for line in text.lines() {
        let mut f = line.split(':');
        let (Some(name), Some(_), Some(uid)) = (f.next(), f.next(), f.next()) else {
            continue;
        };
        if let Ok(uid) = uid.parse::<u32>() {
            map.insert(uid, name.to_string());
        }
    }
    map
}

#[cfg(not(unix))]
pub(crate) fn passwd_owners() -> std::collections::HashMap<u32, String> {
    std::collections::HashMap::new()
}

/// Les surfaces qui vivent dans les répertoires personnels.
///
/// `~/.ssh/authorized_keys` est la porte dérobée la plus discrète qui soit : une
/// ligne ajoutée dans un fichier que personne ne relit, et l'accès survit à tous
/// les changements de mot de passe.
fn collect_home_surfaces(scan: &mut Scan) -> bool {
    // `#[cfg]` ne s'applique pas aux éléments d'un tableau : la variante de
    // plateforme est donc portée par une constante, pas par le littéral.
    #[cfg(target_os = "macos")]
    const USER_UNITS: (&str, &str) = ("launchd", "Library/LaunchAgents");
    #[cfg(not(target_os = "macos"))]
    const USER_UNITS: (&str, &str) = ("systemd", ".config/systemd/user");

    for home in home_dirs() {
        let candidates: [(&'static str, PathBuf); 2] = [
            ("authorized_keys", home.join(".ssh/authorized_keys")),
            (USER_UNITS.0, home.join(USER_UNITS.1)),
        ];
        for (surface, path) in candidates {
            let descriptor = Surface {
                name: surface,
                // Non lu : `walk` reçoit le chemin directement, seuls `name` et
                // `suffixes` comptent ici.
                path: "",
                suffixes: &[],
            };
            if walk(&descriptor, &path, 0, scan) {
                return true;
            }
        }
    }
    false
}

/// Les répertoires personnels réels, lus dans `/etc/passwd`.
///
/// Bornés aux comptes « humains » (uid ≥ 1000 ou root) : une machine porte des
/// dizaines de comptes de service dont le home est `/nonexistent` ou `/`, et
/// parcourir `/` serait catastrophique.
#[cfg(unix)]
fn home_dirs() -> Vec<PathBuf> {
    let Ok(text) = std::fs::read_to_string("/etc/passwd") else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for line in text.lines() {
        let f: Vec<&str> = line.split(':').collect();
        let (Some(uid), Some(home)) = (f.get(2).and_then(|u| u.parse::<u32>().ok()), f.get(5))
        else {
            continue;
        };
        if uid != 0 && uid < 1000 {
            continue;
        }
        // `/` comme home est le marqueur d'un compte de service : le parcourir
        // reviendrait à empreinter le système de fichiers entier.
        if home.is_empty() || *home == "/" || home.starts_with("/nonexistent") {
            continue;
        }
        out.push(PathBuf::from(home));
    }
    out.sort();
    out.dedup();
    out
}

#[cfg(not(unix))]
fn home_dirs() -> Vec<PathBuf> {
    std::env::var_os("USERPROFILE")
        .map(|p| vec![PathBuf::from(p)])
        .unwrap_or_default()
}

/// `Run`/`RunOnce` keys and scheduled tasks. Windows has no file to fingerprint
/// for these surfaces: their rendered definition is fingerprinted instead, one
/// entry per value and per task, so a finding names the program that changed.
/// A task is fingerprinted by its definition only: its state and next run time
/// change every time it runs.
#[cfg(target_os = "windows")]
fn collect_windows(scan: &mut Scan) -> bool {
    const KEYS: [&str; 4] = [
        r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run",
        r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce",
        r"HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Run",
        r"HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce",
    ];
    for key in KEYS {
        let Some(text) = crate::report::run("reg", &["query", key]) else {
            continue;
        };
        for (name, definition) in parse_reg_values(&text) {
            if push_synthetic(scan, "run_key", &format!(r"{key}\{name}"), &definition) {
                return true;
            }
        }
    }
    // Like the keys above: no PowerShell is not an error, only a surface that
    // cannot be read.
    let Some(out) = crate::report::run_timeout(
        "powershell",
        &[
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            SCHEDULED_TASKS_SCRIPT,
        ],
        std::time::Duration::from_secs(30),
    ) else {
        return false;
    };
    if !out.success {
        return false;
    }
    for (path, definition) in parse_scheduled_tasks(&out.stdout) {
        if push_synthetic(scan, "scheduled_task", &path, &definition) {
            return true;
        }
    }
    false
}

/// Every task's path, whether it is enabled, its account and its actions:
/// what decides what runs, and nothing that changes when it does.
#[cfg(target_os = "windows")]
const SCHEDULED_TASKS_SCRIPT: &str = "Get-ScheduledTask | ForEach-Object { [pscustomobject]@{ \
     p = $_.TaskPath + $_.TaskName; e = [bool]$_.Settings.Enabled; u = [string]$_.Principal.UserId; \
     a = (@($_.Actions | ForEach-Object { ([string]$_.Execute + ' ' + [string]$_.Arguments + ' ' + [string]$_.ClassId).Trim() }) -join ' | ') } } \
     | ConvertTo-Json -Compress -Depth 3";

/// `    Name    REG_SZ    data` lines of `reg query`: the value name, and its
/// type and data as one definition. Names may hold spaces, types never do.
#[cfg(any(target_os = "windows", test))]
fn parse_reg_values(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter_map(|line| {
            let line = line.strip_prefix("    ")?;
            let (name, rest) = line.split_once("    REG_")?;
            let (kind, data) = rest.split_once("    ").unwrap_or((rest, ""));
            Some((name.to_string(), format!("REG_{kind}\u{0}{data}")))
        })
        .collect()
}

/// The JSON of `SCHEDULED_TASKS_SCRIPT`: an array, or a bare object when
/// there is a single task. The actions come joined into one string: Windows
/// PowerShell may serialise an array property as `{"value": […], "Count": n}`.
#[cfg(any(target_os = "windows", test))]
fn parse_scheduled_tasks(json: &str) -> Vec<(String, String)> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json.trim()) else {
        return Vec::new();
    };
    let tasks = match value {
        serde_json::Value::Array(items) => items,
        single @ serde_json::Value::Object(_) => vec![single],
        _ => return Vec::new(),
    };
    tasks
        .iter()
        .filter_map(|task| {
            let path = task.get("p")?.as_str()?.to_string();
            let enabled = task
                .get("e")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(true);
            let user = task
                .get("u")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            let actions = task
                .get("a")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            Some((path, format!("{enabled}\u{0}{user}\u{0}{actions}")))
        })
        .collect()
}

/// Entrée dont la « source » n'est pas un fichier (registre, sortie de commande).
#[cfg(target_os = "windows")]
fn push_synthetic(scan: &mut Scan, surface: &'static str, id: &str, text: &str) -> bool {
    if !scan.seen.insert(id.to_string()) {
        return false;
    }
    scan.entries.push(PersistenceEntry {
        surface,
        path: id.to_string(),
        sha256: hex(&Sha256::digest(text.as_bytes())),
        size_bytes: text.len() as u64,
        mtime: None,
        mode: None,
        owner: None,
        vendor: None,
    });
    scan.entries.len() >= MAX_ENTRIES
}

/// Package database lookups get more room than a probe: `rpm -qf` lists every
/// file of the owning packages, and systemd alone ships over a thousand.
#[cfg(target_os = "linux")]
const PACKAGE_DB_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// Marks the entries whose content is exactly what their package ships. One
/// pass for the whole manifest: the owning packages are asked once, never per
/// file. A link is never checked: it is fingerprinted by its target, and
/// enabling a service must stay visible even when the unit itself is vendor.
#[cfg(target_os = "linux")]
fn mark_vendor(entries: &mut [PersistenceEntry]) {
    let is_link =
        |path: &str| std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink());
    let paths: Vec<&str> = entries
        .iter()
        .map(|e| e.path.as_str())
        .filter(|p| !is_link(p))
        .collect();
    if paths.is_empty() {
        return;
    }
    let verdicts = if Path::new("/var/lib/dpkg/status").exists() {
        dpkg_vendor(&paths)
    } else {
        rpm_vendor(&paths, entries)
    };
    for entry in entries.iter_mut() {
        entry.vendor = verdicts.get(&entry.path).copied();
    }
}

/// rpm records a SHA-256 per file: compared with ours, no file is read twice.
#[cfg(target_os = "linux")]
fn rpm_vendor(paths: &[&str], entries: &[PersistenceEntry]) -> HashMap<String, bool> {
    let mut args = vec!["-qf", "--queryformat", "[%{FILENAMES}\t%{FILEDIGESTS}\n]"];
    args.extend_from_slice(paths);
    // Exits non-zero as soon as one path is not owned: the owned ones still print.
    let Some(out) = crate::report::run_timeout("rpm", &args, PACKAGE_DB_TIMEOUT) else {
        return HashMap::new();
    };
    let shipped = parse_rpm_digests(&out.stdout, paths);
    entries
        .iter()
        .filter_map(|e| {
            let digest = shipped.get(&e.path)?;
            Some((e.path.clone(), digest.eq_ignore_ascii_case(&e.sha256)))
        })
        .collect()
}

/// dpkg records MD5s: the owned files are hashed again by `md5sum`, the only
/// MD5 at hand without a dependency for it.
#[cfg(target_os = "linux")]
fn dpkg_vendor(paths: &[&str]) -> HashMap<String, bool> {
    let run = |cmd: &str, args: &[&str]| {
        crate::report::run_timeout(cmd, args, PACKAGE_DB_TIMEOUT).map(|o| o.stdout)
    };
    let Some(search) = run("dpkg-query", &[&["-S"][..], paths].concat()) else {
        return HashMap::new();
    };
    let owners = parse_dpkg_search(&search);
    let mut packages: Vec<&str> = owners.values().flatten().map(String::as_str).collect();
    packages.sort_unstable();
    packages.dedup();
    if packages.is_empty() {
        return HashMap::new();
    }

    let mut shipped = run(
        "dpkg-query",
        &[&["-W", "-f", "${Conffiles}\n"][..], packages.as_slice()].concat(),
    )
    .map(|out| parse_dpkg_conffiles(&out))
    .unwrap_or_default();
    for package in &packages {
        let list = format!("/var/lib/dpkg/info/{package}.md5sums");
        if let Ok(text) = std::fs::read_to_string(list) {
            for (path, md5) in parse_md5sums_list(&text) {
                shipped.entry(path).or_insert(md5);
            }
        }
    }

    let owned: Vec<&str> = paths
        .iter()
        .copied()
        .filter(|p| shipped.contains_key(*p))
        .collect();
    if owned.is_empty() {
        return HashMap::new();
    }
    let Some(sums) = run("md5sum", &[&["--"][..], owned.as_slice()].concat()) else {
        return HashMap::new();
    };
    parse_md5sum_output(&sums)
        .into_iter()
        .filter_map(|(path, actual)| {
            let expected = shipped.get(&path)?;
            let same = expected.eq_ignore_ascii_case(&actual);
            Some((path, same))
        })
        .collect()
}

/// `path\tdigest` lines of `rpm -qf --queryformat '[%{FILENAMES}\t%{FILEDIGESTS}\n]'`,
/// kept for the asked paths only. rpm prints every file of each owning
/// package, and its "not owned" notice (translated) has no tab.
#[cfg(any(target_os = "linux", test))]
fn parse_rpm_digests(out: &str, paths: &[&str]) -> HashMap<String, String> {
    let wanted: HashSet<&str> = paths.iter().copied().collect();
    out.lines()
        .filter_map(|line| line.split_once('\t'))
        .filter(|(path, digest)| wanted.contains(path) && !digest.is_empty())
        .map(|(path, digest)| (path.to_string(), digest.to_string()))
        .collect()
}

/// `pkg1, pkg2: /path` lines of `dpkg-query -S`. Diversion notices and the
/// "no path found" errors (on stderr) carry no package list.
#[cfg(any(target_os = "linux", test))]
fn parse_dpkg_search(out: &str) -> HashMap<String, Vec<String>> {
    out.lines()
        .filter(|line| !line.starts_with("diversion "))
        .filter_map(|line| line.split_once(": /"))
        .map(|(packages, path)| {
            let packages = packages.split(", ").map(str::to_string).collect();
            (format!("/{path}"), packages)
        })
        .collect()
}

/// ` /etc/x 0123…[ obsolete]` lines of `dpkg-query -W -f='${Conffiles}\n'`. An
/// obsolete conffile is no longer shipped: its digest proves nothing.
#[cfg(any(target_os = "linux", test))]
fn parse_dpkg_conffiles(out: &str) -> HashMap<String, String> {
    out.lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let (path, md5) = (fields.next()?, fields.next()?);
            (path.starts_with('/') && fields.next().is_none())
                .then(|| (path.to_string(), md5.to_string()))
        })
        .collect()
}

/// `md5  relative/path` lines of `/var/lib/dpkg/info/<pkg>.md5sums`.
#[cfg(any(target_os = "linux", test))]
fn parse_md5sums_list(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter_map(|line| line.split_once("  "))
        .map(|(md5, path)| (format!("/{path}"), md5.to_string()))
        .collect()
}

/// `md5  /path` lines of `md5sum`.
#[cfg(any(target_os = "linux", test))]
fn parse_md5sum_output(out: &str) -> HashMap<String, String> {
    out.lines()
        .filter_map(|line| line.split_once("  "))
        .map(|(md5, path)| (path.to_string(), md5.to_string()))
        .collect()
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// L'empreinte doit être celle du contenu, et changer avec lui.
    #[test]
    fn fingerprint_tracks_content() {
        let dir = std::env::temp_dir().join(format!("deveye-int-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("unit.service");
        std::fs::write(&file, b"ExecStart=/usr/bin/true\n").unwrap();

        let display = file.to_string_lossy().to_string();
        let owners = passwd_owners();
        let a = fingerprint("systemd", &file, &display, &owners).expect("fichier lisible");
        assert_eq!(a.sha256.len(), 64, "sha256 en hexadécimal");
        assert_eq!(a.size_bytes, 24);

        std::fs::write(&file, b"ExecStart=/tmp/evil\n").unwrap();
        let b = fingerprint("systemd", &file, &display, &owners).unwrap();
        assert_ne!(a.sha256, b.sha256, "un contenu modifié change l'empreinte");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// A link into `/usr` is fingerprinted by where it points: a package update
    /// rewriting the target changes nothing, pointing elsewhere does.
    #[cfg(unix)]
    #[test]
    fn link_into_usr_is_fingerprinted_by_its_target() {
        let dir = std::env::temp_dir().join(format!("deveye-int-link-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let owners = passwd_owners();
        let link = dir.join("env.service");
        std::os::unix::fs::symlink("/usr/bin/env", &link).unwrap();
        let display = link.to_string_lossy().to_string();

        let entry = fingerprint("systemd", &link, &display, &owners).expect("cible lisible");
        let target = std::fs::canonicalize("/usr/bin/env").unwrap();
        let expected = hex(&Sha256::digest(
            format!("→{}", target.to_string_lossy()).as_bytes(),
        ));
        assert_eq!(entry.sha256, expected);

        // A link outside `/usr` keeps the content of what it points to.
        let local = dir.join("local.service");
        std::fs::write(&local, b"ExecStart=/opt/x\n").unwrap();
        let alias = dir.join("alias.service");
        std::os::unix::fs::symlink(&local, &alias).unwrap();
        let alias_display = alias.to_string_lossy().to_string();
        let local_display = local.to_string_lossy().to_string();
        assert_eq!(
            fingerprint("systemd", &alias, &alias_display, &owners)
                .unwrap()
                .sha256,
            fingerprint("systemd", &local, &local_display, &owners)
                .unwrap()
                .sha256
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rpm_digests_keep_the_asked_paths_only() {
        let out = "/etc/profile.d/debuginfod.sh\tab12\n\
                   /usr/bin/debuginfod-find\tcd34\n\
                   le fichier /etc/x n'appartient à aucun paquet\n\
                   /etc/ghost\t\n";
        let digests = parse_rpm_digests(
            out,
            &["/etc/profile.d/debuginfod.sh", "/etc/x", "/etc/ghost"],
        );
        assert_eq!(digests.len(), 1);
        assert_eq!(digests["/etc/profile.d/debuginfod.sh"], "ab12");
    }

    #[test]
    fn dpkg_outputs_are_parsed() {
        let search = parse_dpkg_search(
            "cron: /etc/crontab\n\
             diversion by dash from: /bin/sh\n\
             libc-bin, locales: /etc/profile.d/x.sh\n",
        );
        assert_eq!(search["/etc/crontab"], vec!["cron"]);
        assert_eq!(search["/etc/profile.d/x.sh"], vec!["libc-bin", "locales"]);
        assert_eq!(search.len(), 2);

        let conffiles =
            parse_dpkg_conffiles(" /etc/crontab 0123abcd\n /etc/cron.d/old 4567ef obsolete\n\n");
        assert_eq!(conffiles.len(), 1);
        assert_eq!(conffiles["/etc/crontab"], "0123abcd");

        assert_eq!(
            parse_md5sums_list("89ab  etc/cron.daily/apt\n"),
            vec![("/etc/cron.daily/apt".to_string(), "89ab".to_string())]
        );
        assert_eq!(
            parse_md5sum_output("0123abcd  /etc/crontab\n")["/etc/crontab"],
            "0123abcd"
        );
    }

    #[test]
    fn reg_values_are_one_entry_each() {
        let text = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run\r\n\
                    \x20   SecurityHealth    REG_EXPAND_SZ    %windir%\\system32\\SecurityHealthSystray.exe\r\n\
                    \x20   Mon outil    REG_SZ    \"C:\\Program Files\\Outil\\outil.exe\" /background\r\n";
        let values = parse_reg_values(&text.replace('\r', ""));
        assert_eq!(values.len(), 2);
        assert_eq!(values[1].0, "Mon outil");
        assert_eq!(
            values[1].1,
            "REG_SZ\u{0}\"C:\\Program Files\\Outil\\outil.exe\" /background"
        );
    }

    #[test]
    fn scheduled_tasks_ignore_what_changes_when_they_run() {
        let tasks = parse_scheduled_tasks(
            r#"[{"p":"\\Microsoft\\Windows\\Defrag\\ScheduledDefrag","e":true,"u":"SYSTEM","a":"%windir%\\system32\\defrag.exe -c"},
               {"p":"\\Updater","e":false,"u":"","a":"C:\\u.exe | C:\\v.exe"}]"#,
        );
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].0, "\\Microsoft\\Windows\\Defrag\\ScheduledDefrag");
        assert_eq!(
            tasks[0].1,
            "true\u{0}SYSTEM\u{0}%windir%\\system32\\defrag.exe -c"
        );
        assert_eq!(tasks[1].1, "false\u{0}\u{0}C:\\u.exe | C:\\v.exe");
        // A single task comes back as a bare object.
        assert_eq!(
            parse_scheduled_tasks(r#"{"p":"\\Seul","e":true,"u":"x","a":""}"#).len(),
            1
        );
    }

    /// Un fichier trop gros n'est pas empreinté.
    #[test]
    fn fingerprint_skips_oversized_files() {
        let dir = std::env::temp_dir().join(format!("deveye-int-big-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("huge.service");
        std::fs::write(&file, vec![b'x'; (MAX_FILE_BYTES + 1) as usize]).unwrap();
        let display = file.to_string_lossy().to_string();
        assert!(fingerprint("systemd", &file, &display, &passwd_owners()).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Le suffixe filtre : `/etc/systemd/system` contient aussi des répertoires
    /// et des fichiers qui ne sont pas des unités.
    #[test]
    fn walk_honours_suffix_filter() {
        let dir = std::env::temp_dir().join(format!("deveye-int-sfx-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.service"), b"x").unwrap();
        std::fs::write(dir.join("b.txt"), b"x").unwrap();

        let surface = Surface {
            name: "systemd",
            path: "",
            suffixes: &[".service"],
        };
        let mut scan = Scan {
            entries: Vec::new(),
            seen: HashSet::new(),
            owners: passwd_owners(),
        };
        walk(&surface, &dir, 0, &mut scan);

        assert_eq!(scan.entries.len(), 1);
        assert!(scan.entries[0].path.ends_with("a.service"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Le relevé complet sur la machine qui exécute les tests : rien sur ce
    /// qu'elle contient, tout sur la forme (empreinte tronquée, chemin relatif
    /// ou doublon deviendraient des constats fantômes rejouant à chaque cycle).
    #[test]
    fn collect_yields_a_well_formed_manifest() {
        let report = collect();
        assert!(report.collected_at > 0);
        assert!(
            report.entries.len() <= MAX_ENTRIES,
            "le plafond est respecté"
        );

        let mut paths = HashSet::new();
        for e in &report.entries {
            assert_eq!(
                e.sha256.len(),
                64,
                "sha256 hexadécimal complet : {}",
                e.path
            );
            assert!(
                e.sha256.chars().all(|c| c.is_ascii_hexdigit()),
                "sha256 hexadécimal : {}",
                e.sha256
            );
            assert!(!e.surface.is_empty());
            assert!(
                std::path::Path::new(&e.path).is_absolute() || cfg!(windows),
                "chemin absolu, sinon le diff serveur compare des clés instables : {}",
                e.path
            );
            assert!(
                paths.insert(e.path.clone()),
                "un chemin ne doit apparaître qu'une fois : {}",
                e.path
            );
        }

        eprintln!(
            "manifeste de cette machine : {} entrées, tronqué={}",
            report.entries.len(),
            report.truncated
        );
        for e in report.entries.iter().take(8) {
            eprintln!("  [{}] {} ({} o)", e.surface, e.path, e.size_bytes);
        }
    }
}
