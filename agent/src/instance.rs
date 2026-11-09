//! Several enrollments on one machine: one named instance per DevEye server.
//!
//! The default enrollment lives in the `deveye` folder itself; a named one in
//! `deveye/instances/<name>/`, with its own token, policy, lock and caches.
//! Every name the agent claims on the machine (service unit, launchd label,
//! scheduled task, published status) carries the instance as a suffix, so two
//! instances never take each other's place.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{bail, Result};

use crate::config::{Config, CONFIG_FILE};

/// What `--instance` sets, and what the processes the agent starts inherit.
pub const ENV: &str = "DEVEYE_INSTANCE";
/// The folder of the named instances, inside a `deveye` folder.
pub const DIR: &str = "instances";
/// What `status` calls the enrollment without a name, so no instance takes it.
pub const DEFAULT_LABEL: &str = "default";
const MAX_LEN: usize = 32;

/// An instance name: it ends up in file, unit and task names.
pub fn parse(raw: &str) -> Result<String, String> {
    let valid = !raw.is_empty()
        && raw.len() <= MAX_LEN
        && raw
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !raw.starts_with('-')
        && !raw.ends_with('-')
        && raw != DEFAULT_LABEL;
    if valid {
        Ok(raw.to_string())
    } else {
        Err(format!(
            "an instance name is 1 to {MAX_LEN} lowercase letters, digits and dashes, \
             without a dash at either end, other than `{DEFAULT_LABEL}` (the enrollment \
             without --instance)"
        ))
    }
}

/// Set by [`scoped`] for what walks every instance (`uninstall`).
static OVERRIDE: Mutex<Option<Option<String>>> = Mutex::new(None);

/// The instance this process acts for, `None` for the default one:
/// `DEVEYE_INSTANCE`, else the instance a `DEVEYE_CONFIG` path belongs to.
pub fn current() -> Option<String> {
    if let Some(name) = OVERRIDE.lock().unwrap_or_else(|e| e.into_inner()).clone() {
        return name;
    }
    match std::env::var(ENV) {
        Ok(raw) if !raw.is_empty() => parse(&raw).ok(),
        _ => std::env::var_os("DEVEYE_CONFIG").and_then(|p| of_config(Path::new(&p))),
    }
}

/// Run `f` as the process acting for `name` would.
pub fn scoped<T>(name: Option<&str>, f: impl FnOnce() -> T) -> T {
    let previous = OVERRIDE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .replace(name.map(str::to_string));
    let out = f();
    *OVERRIDE.lock().unwrap_or_else(|e| e.into_inner()) = previous;
    out
}

/// `-<name>`, empty for the default instance.
pub fn suffix_of(name: Option<&str>) -> String {
    name.map(|n| format!("-{n}")).unwrap_or_default()
}

/// The `--instance <name>` arguments that start a process for this instance,
/// for the command lines the environment does not reach (services, elevation).
pub fn args() -> Vec<String> {
    args_of(current().as_deref())
}

pub fn args_of(name: Option<&str>) -> Vec<String> {
    match name {
        Some(n) => vec!["--instance".into(), n.into()],
        None => Vec::new(),
    }
}

/// The instance a config file belongs to: `…/instances/<name>/<file>`.
pub fn of_config(path: &Path) -> Option<String> {
    let dir = path.parent()?;
    if dir.parent()?.file_name()? != DIR {
        return None;
    }
    parse(dir.file_name()?.to_str()?).ok()
}

/// The folder of an instance's enrollment under a `deveye` folder.
pub fn dir_under(root: &Path, name: Option<&str>) -> PathBuf {
    match name {
        Some(n) => root.join(DIR).join(n),
        None => root.to_path_buf(),
    }
}

/// The `deveye` folder an enrollment folder belongs to.
pub fn root_of(dir: &Path) -> &Path {
    match dir.parent() {
        Some(parent) if parent.file_name().is_some_and(|n| n == DIR) => {
            parent.parent().unwrap_or(dir)
        }
        _ => dir,
    }
}

/// The named instance folders under a `deveye` folder, sorted.
pub fn named_dirs(root: &Path) -> Vec<(String, PathBuf)> {
    let Ok(entries) = std::fs::read_dir(root.join(DIR)) else {
        return Vec::new();
    };
    let mut dirs: Vec<(String, PathBuf)> = entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| Some((parse(e.file_name().to_str()?).ok()?, e.path())))
        .collect();
    dirs.sort();
    dirs
}

/// The enrollments under a `deveye` folder, the default one first: each
/// instance with its config file.
pub fn enrollments(root: &Path) -> Vec<(Option<String>, PathBuf)> {
    let mut out = Vec::new();
    let default = root.join(CONFIG_FILE);
    if default.exists() {
        out.push((None, default));
    }
    for (name, dir) in named_dirs(root) {
        let config = dir.join(CONFIG_FILE);
        if config.exists() {
            out.push((Some(name), config));
        }
    }
    out
}

/// The `deveye` folders where this account keeps enrollments.
pub fn roots() -> Vec<PathBuf> {
    let mut roots = vec![Config::user_root()];
    if crate::config::privileged() {
        roots.push(crate::system_dir::root());
    }
    roots
}

/// Whether the machine keeps another enrollment once this one goes, so the
/// binary, the icon and its login entry stay: one in a folder of this account,
/// or another agent running from the same executable.
pub fn others_remain() -> bool {
    let own = canonical(&Config::path());
    let another_config = roots()
        .iter()
        .flat_map(|root| enrollments(root))
        .any(|(_, config)| canonical(&config) != own);
    another_config || other_agent_running()
}

fn canonical(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

/// Another `run` of this executable, whatever its instance or account.
fn other_agent_running() -> bool {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

    let Some(name) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.file_name().map(|n| n.to_os_string()))
    else {
        return false;
    };
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::new().with_cmd(UpdateKind::Always),
    );
    let me = std::process::id();
    sys.processes().iter().any(|(pid, process)| {
        pid.as_u32() != me
            && process.name() == name.as_os_str()
            && is_run(process.cmd().iter().skip(1))
    })
}

/// The arguments of `deveye-agent [--instance <name>] run …`, not those of
/// `tray run`.
fn is_run<'a>(mut args: impl Iterator<Item = &'a std::ffi::OsString>) -> bool {
    loop {
        match args.next() {
            Some(arg) if arg == "--instance" => {
                args.next();
            }
            Some(arg) if arg.to_string_lossy().starts_with("--instance=") => {}
            first => return first.is_some_and(|arg| arg == "run"),
        }
    }
}

/// A `--config` of a named instance acts for it: the services and the status
/// take its name, even without `--instance`, which must then agree.
pub fn follow_config(config: &Path) -> Result<()> {
    let Some(from_path) = of_config(config) else {
        return Ok(());
    };
    match std::env::var(ENV).ok().filter(|n| !n.is_empty()) {
        Some(named) if named != from_path => bail!(
            "--instance {named} with the config of instance {from_path} ({})",
            config.display()
        ),
        Some(_) => {}
        None => std::env::set_var(ENV, from_path),
    }
    Ok(())
}

/// Remove an enrollment folder left empty, with `instances` and the `deveye`
/// folder above it when they are empty too.
pub fn remove_empty_dirs(dir: &Path) {
    let root = root_of(dir).to_path_buf();
    if root != dir {
        let _ = std::fs::remove_dir(dir);
        let _ = std::fs::remove_dir(root.join(DIR));
    }
    if crate::uninstall::is_own_dir(&root) {
        let _ = std::fs::remove_dir(&root);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_fit_in_a_unit_name() {
        for good in ["nas", "prod-2", "a", &"x".repeat(MAX_LEN)] {
            assert_eq!(parse(good).as_deref(), Ok(good), "{good}");
        }
        for bad in [
            "",
            DEFAULT_LABEL,
            "-nas",
            "nas-",
            "Nas",
            "nas.lan",
            "nas/x",
            "..",
            "é",
            &"x".repeat(MAX_LEN + 1),
        ] {
            assert!(parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_config_path_names_its_instance() {
        let root = Path::new("/home/lea/.config/deveye");
        let named = dir_under(root, Some("nas"));
        assert_eq!(named, root.join("instances/nas"));
        assert_eq!(dir_under(root, None), root);
        assert_eq!(of_config(&named.join(CONFIG_FILE)).as_deref(), Some("nas"));
        assert_eq!(of_config(&root.join(CONFIG_FILE)), None);
        assert_eq!(of_config(Path::new("/etc/deveye.toml")), None);
        assert_eq!(of_config(Path::new("/x/instances/Bad/agent.toml")), None);
        assert_eq!(root_of(&named), root);
        assert_eq!(root_of(root), root);
    }

    #[test]
    fn the_default_instance_adds_nothing_to_a_name() {
        assert_eq!(suffix_of(None), "");
        assert_eq!(suffix_of(Some("nas")), "-nas");
        assert!(args_of(None).is_empty());
        assert_eq!(args_of(Some("nas")), ["--instance", "nas"]);
    }

    #[test]
    fn an_agent_is_a_run_and_the_icon_is_not() {
        let check = |args: &[&str]| {
            let args: Vec<std::ffi::OsString> = args.iter().map(Into::into).collect();
            is_run(args.iter())
        };
        assert!(check(&["run", "--managed"]));
        assert!(check(&["--instance", "nas", "run"]));
        assert!(check(&["--instance=nas", "run"]));
        assert!(!check(&["tray", "run"]));
        assert!(!check(&["status"]));
        assert!(!check(&[]));
    }

    #[test]
    fn enrollments_list_the_default_first_then_each_named_one() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        for name in ["prod", "nas"] {
            std::fs::create_dir_all(dir_under(root, Some(name))).unwrap();
            std::fs::write(dir_under(root, Some(name)).join(CONFIG_FILE), "").unwrap();
        }
        // A folder without config, or with a name the agent never writes, is not one.
        std::fs::create_dir_all(dir_under(root, Some("old"))).unwrap();
        std::fs::create_dir_all(root.join(DIR).join("Bad")).unwrap();
        std::fs::write(root.join(DIR).join("Bad").join(CONFIG_FILE), "").unwrap();
        assert_eq!(
            enrollments(root)
                .into_iter()
                .map(|(n, _)| n)
                .collect::<Vec<_>>(),
            vec![Some("nas".to_string()), Some("prod".to_string())]
        );
        std::fs::write(root.join(CONFIG_FILE), "").unwrap();
        assert_eq!(enrollments(root)[0], (None, root.join(CONFIG_FILE)));
    }

    #[test]
    fn an_emptied_instance_takes_its_empty_parents_along() {
        let base = tempfile::tempdir().unwrap();
        let root = base.path().join("deveye");
        let nas = dir_under(&root, Some("nas"));
        let prod = dir_under(&root, Some("prod"));
        std::fs::create_dir_all(&nas).unwrap();
        std::fs::create_dir_all(&prod).unwrap();
        remove_empty_dirs(&nas);
        assert!(!nas.exists() && prod.exists(), "the other instance stays");
        remove_empty_dirs(&prod);
        assert!(!root.exists(), "nothing left: the deveye folder goes too");
    }
}
