//! A privileged agent's enrollment, out of reach of ordinary accounts.
//!
//! The config tells the agent which server to trust, which key signs its orders
//! and what the machine refuses. A root agent reading it from a folder an
//! ordinary account can write would hand root to that account: it would put its
//! own server and key there. A system service therefore keeps its enrollment in
//! a root-only folder, and a privileged agent refuses to run on any file another
//! account could rewrite.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

use crate::config::{
    private_dir, write_private, Config, CONFIG_FILE, SIBLING_FILES, SYNC_DEVICE_KEY_FILE,
};
use crate::service::{self, ServiceScope};

/// Where a system service keeps its enrollment.
pub fn dir() -> PathBuf {
    #[cfg(target_os = "linux")]
    {
        PathBuf::from("/var/lib/deveye")
    }
    #[cfg(target_os = "macos")]
    {
        PathBuf::from("/Library/Application Support/deveye")
    }
    #[cfg(windows)]
    {
        std::env::var_os("ProgramData")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"))
            .join("deveye")
    }
}

pub fn config_path() -> PathBuf {
    dir().join(CONFIG_FILE)
}

/// A system service holds this machine's enrollment, as far as this process
/// can tell. An ordinary account is denied the folder: a refusal counts as
/// held, since only an enrollment would have made the folder root's.
pub fn held() -> bool {
    if service::installed_scope() == ServiceScope::System {
        return true;
    }
    match std::fs::metadata(config_path()) {
        Ok(_) => true,
        Err(e) => e.kind() == std::io::ErrorKind::PermissionDenied,
    }
}

/// `deveye-agent <args>` as the system service's owner runs it, for messages.
pub fn elevated(args: &str) -> String {
    #[cfg(unix)]
    {
        format!("`sudo deveye-agent {args}`")
    }
    #[cfg(windows)]
    {
        format!("`deveye-agent {args}` from an administrator PowerShell")
    }
}

/// Why a privileged agent cannot trust this file, `None` when it can: the file
/// and every folder above it belong to root and are writable neither by their
/// group nor by others. Checked on the path as written (a link an ordinary
/// account could retarget), then as resolved.
#[cfg(unix)]
pub fn untrusted(path: &Path) -> Option<String> {
    use std::os::unix::fs::MetadataExt;

    let literal = if path.is_absolute() {
        path.to_path_buf()
    } else {
        match std::env::current_dir() {
            Ok(cwd) => cwd.join(path),
            Err(e) => return Some(format!("current directory unreadable: {e}")),
        }
    };
    let resolved = match literal.canonicalize() {
        Ok(real) => real,
        Err(e) => return Some(format!("{}: {e}", literal.display())),
    };
    for chain in [&literal, &resolved] {
        for step in chain.ancestors() {
            let meta = match std::fs::symlink_metadata(step) {
                Ok(meta) => meta,
                Err(e) => return Some(format!("{}: {e}", step.display())),
            };
            if meta.uid() != 0 {
                return Some(format!(
                    "{} belongs to uid {}, not root",
                    step.display(),
                    meta.uid()
                ));
            }
            if !meta.file_type().is_symlink() && meta.mode() & 0o022 != 0 {
                return Some(format!(
                    "{} is writable by its group or by others",
                    step.display()
                ));
            }
        }
    }
    None
}

/// On Windows, the one folder whose rights the agent sets itself
/// ([`restrict_acl`]): anywhere else is refused.
#[cfg(windows)]
pub fn untrusted(path: &Path) -> Option<String> {
    let parent = path.parent()?.to_string_lossy().to_lowercase();
    let own = dir().to_string_lossy().to_lowercase();
    (parent.trim_end_matches('\\') != own.trim_end_matches('\\'))
        .then(|| format!("{} is outside {}", path.display(), dir().display()))
}

/// The system folder, created root-only. A folder already there must pass the
/// same check as a config file.
fn secure_dir() -> Result<PathBuf> {
    let dir = dir();
    private_dir(&dir).with_context(|| format!("creating {}", dir.display()))?;
    #[cfg(windows)]
    restrict_acl(&dir)?;
    #[cfg(unix)]
    if let Some(why) = untrusted(&dir) {
        bail!("{} cannot hold the enrollment: {why}", dir.display());
    }
    Ok(dir)
}

/// SYSTEM and Administrators only, named by SID (names follow the system
/// language). Owner first, then a reset: an ordinary account may create folders
/// under `ProgramData`, and one created ahead of us would otherwise keep its
/// rights on it.
#[cfg(windows)]
fn restrict_acl(dir: &Path) -> Result<()> {
    const ADMINS: &str = "*S-1-5-32-544";
    let steps: [&[&str]; 3] = [
        &["/setowner", ADMINS, "/T", "/C", "/Q"],
        &["/reset", "/T", "/C", "/Q"],
        &[
            "/inheritance:r",
            "/grant:r",
            "*S-1-5-18:(OI)(CI)F",
            "*S-1-5-32-544:(OI)(CI)F",
            "/T",
            "/C",
            "/Q",
        ],
    ];
    for args in steps {
        let out = std::process::Command::new("icacls")
            .arg(dir)
            .args(args)
            .output()
            .context("running icacls")?;
        if !out.status.success() {
            bail!(
                "icacls {} failed: {}",
                args[0],
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }
    }
    Ok(())
}

/// What follows the enrollment from one folder to another: the config, the
/// device key of encrypted shares, the scan caches. The rest (pid, state, log)
/// belongs to the process that ran there.
fn enrollment_files(config: &Path) -> Vec<(PathBuf, String)> {
    let mut files = vec![(config.to_path_buf(), CONFIG_FILE.to_string())];
    let Some(dir) = config.parent() else {
        return files;
    };
    let key = dir.join(SYNC_DEVICE_KEY_FILE);
    if key.exists() {
        files.push((key, SYNC_DEVICE_KEY_FILE.to_string()));
    }
    for index in crate::uninstall::sync_index_files(dir) {
        if let Some(name) = index.file_name().and_then(|n| n.to_str()) {
            let name = name.to_string();
            files.push((index, name));
        }
    }
    files
}

/// Copy then delete: `rename` fails across file systems, and on Windows would
/// carry the source folder's rights along. Returns the files written.
fn move_files(files: &[(PathBuf, String)], to: &Path) -> Result<Vec<PathBuf>> {
    let mut written = Vec::new();
    for (src, name) in files {
        let bytes = std::fs::read(src).with_context(|| format!("reading {}", src.display()))?;
        let dest = to.join(name);
        write_private(&dest, &bytes).with_context(|| format!("writing {}", dest.display()))?;
        written.push(dest);
    }
    for (src, _) in files {
        let _ = std::fs::remove_file(src);
    }
    Ok(written)
}

/// Move the enrollment at `from` into the system folder and return its new
/// path, the one the service bakes. The original goes: it holds the same token.
/// The rest of this process (log, state, token rotation) uses the new place.
pub fn adopt(from: &Path) -> Result<PathBuf> {
    let target = config_path();
    let same = from
        .canonicalize()
        .ok()
        .zip(target.canonicalize().ok())
        .is_some_and(|(a, b)| a == b);
    if same || (!from.exists() && target.exists()) {
        secure_dir()?;
    } else if !from.exists() {
        bail!(
            "no enrollment at {}: run `deveye-agent link <code>` first",
            from.display()
        );
    } else {
        let dir = secure_dir()?;
        move_files(&enrollment_files(from), &dir)?;
        // The running agent's lock comes along, copied: the system service
        // started next to it waits for it to leave, as when both read the same
        // folder (`state::read_running`).
        if let Some(state) = from.parent().map(|d| d.join(SIBLING_FILES[2])) {
            if let Ok(bytes) = std::fs::read(&state) {
                let _ = write_private(&dir.join(SIBLING_FILES[2]), &bytes);
            }
        }
    }
    std::env::set_var("DEVEYE_CONFIG", &target);
    Ok(target)
}

/// Hand the system service's enrollment back to the account removing it
/// (`sudo deveye-agent service uninstall`), so a per-user service can take it
/// over. Returns its new path, `None` without a system enrollment.
pub fn release() -> Result<Option<PathBuf>> {
    let source = config_path();
    if !source.exists() {
        return Ok(None);
    }
    let dest_dir = invoking_config_dir().context(
        "no invoking account to hand it back to: run `sudo deveye-agent service uninstall` from that account",
    )?;
    // `adopt` moved the account's file away: one there now comes from a later
    // link, newer than the system one, and stays.
    let own = dest_dir.join(CONFIG_FILE);
    if own.exists() {
        bail!(
            "this account has its own enrollment ({}), kept as is; delete {} if nothing uses it",
            own.display(),
            dir().display()
        );
    }
    crate::ownership::create_dir_all_owned(&dest_dir)
        .with_context(|| format!("creating {}", dest_dir.display()))?;
    private_dir(&dest_dir)?;
    for path in move_files(&enrollment_files(&source), &dest_dir)? {
        crate::ownership::adopt_from_parent(&path);
    }
    let dir = dir();
    for path in crate::uninstall::own_files(&dir) {
        let _ = std::fs::remove_file(path);
    }
    let _ = std::fs::remove_dir(&dir);
    Ok(Some(dest_dir.join(CONFIG_FILE)))
}

/// The config folder of the account behind `sudo` or `pkexec`.
#[cfg(unix)]
fn invoking_config_dir() -> Option<PathBuf> {
    Some(service::invoking_home()?.join(crate::uninstall::CONFIG_SUBPATH))
}

/// UAC elevation keeps the user's profile, and its `%APPDATA%`.
#[cfg(windows)]
fn invoking_config_dir() -> Option<PathBuf> {
    Some(dirs::config_dir()?.join("deveye"))
}

/// A privileged agent only runs on an enrollment root alone can write. One
/// exception, once: a system service installed by a version that baked a
/// config in a home folder moves it itself and rewrites its service; otherwise
/// the self-update would stop it on every such machine.
pub fn secure_for_run(managed: bool) -> Result<()> {
    let path = Config::path();
    let Some(why) = untrusted(&path) else {
        return Ok(());
    };
    if managed && service::installed_scope() == ServiceScope::System {
        let moved = adopt(&path)?;
        service::rebake_system_config(&moved.to_string_lossy())?;
        tracing::warn!(
            from = %path.display(),
            to = %moved.display(),
            "enrollment moved out of reach of non-root accounts"
        );
        return Ok(());
    }
    bail!(
        "refusing to run with privileges on {}: {why}. Any account able to rewrite it could \
         point this agent at its own server. Install the system service instead \
         (`sudo deveye-agent service install --system`): it moves the enrollment to {}",
        path.display(),
        dir().display()
    )
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn a_file_in_a_users_folder_is_not_trusted() {
        // Tests do not run as root: the temp folder belongs to the user.
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("agent.toml");
        std::fs::write(&file, "x").unwrap();
        let why = untrusted(&file).expect("a user-owned file must be refused");
        assert!(why.contains("not root"), "{why}");
    }

    #[test]
    fn a_root_owned_chain_is_trusted() {
        // Root-owned and not writable by others.
        let probe = ["/etc/passwd", "/etc/hostname"]
            .into_iter()
            .map(Path::new)
            .find(|p| p.exists())
            .expect("a root-owned file");
        assert_eq!(untrusted(probe), None);
    }

    #[test]
    fn a_missing_file_is_not_trusted() {
        assert!(untrusted(Path::new("/nonexistent/deveye/agent.toml")).is_some());
    }

    #[test]
    fn the_enrollment_carries_its_key_and_caches_not_its_runtime_files() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("custom.toml");
        for name in [
            "custom.toml",
            SYNC_DEVICE_KEY_FILE,
            "sync-7.index.json",
            "agent.pid",
            "agent.log",
        ] {
            std::fs::write(dir.path().join(name), name).unwrap();
        }
        let mut names: Vec<String> = enrollment_files(&config)
            .into_iter()
            .map(|(_, name)| name)
            .collect();
        names.sort();
        assert_eq!(
            names,
            vec![
                CONFIG_FILE.to_string(),
                "sync-7.index.json".to_string(),
                SYNC_DEVICE_KEY_FILE.to_string()
            ]
        );

        let to = tempfile::tempdir().unwrap();
        let written = move_files(&enrollment_files(&config), to.path()).unwrap();
        assert_eq!(written.len(), 3);
        assert_eq!(
            std::fs::read_to_string(to.path().join(CONFIG_FILE)).unwrap(),
            "custom.toml"
        );
        assert!(
            !config.exists(),
            "the original goes: it holds the same token"
        );
        assert!(dir.path().join("agent.pid").exists());
    }
}
