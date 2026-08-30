//! Ownership of what the agent creates on disk.
//!
//! The agent usually runs as a system service, so as root: everything it writes
//! belongs to root, and whoever owns the folder can no longer edit or delete it.
//! What the agent creates therefore takes the owner of the directory it lands in.

use std::path::Path;

/// Give `path` the owner of `reference`. Best-effort: without the privilege the
/// `chown` fails, but the file then already has the right owner.
#[cfg(unix)]
pub fn adopt_owner(reference: &Path, path: &Path) {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;

    let Ok(reference) = std::fs::metadata(reference) else {
        return;
    };
    let Ok(current) = std::fs::symlink_metadata(path) else {
        return;
    };
    if current.uid() == reference.uid() && current.gid() == reference.gid() {
        return;
    }
    let Ok(raw) = CString::new(path.as_os_str().as_bytes()) else {
        return;
    };
    // `lchown` and not `chown`: never follow a symlink, its target is not ours
    // to hand over.
    unsafe {
        libc::lchown(raw.as_ptr(), reference.uid(), reference.gid());
    }
}

#[cfg(not(unix))]
pub fn adopt_owner(_reference: &Path, _path: &Path) {}

/// Give a path just created the owner of the folder it sits in.
pub fn adopt_from_parent(path: &Path) {
    if let Some(parent) = path.parent() {
        adopt_owner(parent, path);
    }
}

/// Create `path` and any missing parent, each new directory taking the owner of
/// the deepest one that was already there. `create_dir_all` can create several
/// levels at once: left to root, they would be a tree the user cannot touch.
pub fn create_dir_all_owned(path: &Path) -> std::io::Result<()> {
    // Missing ancestors, deepest first, until a directory that already exists.
    let mut missing: Vec<&Path> = Vec::new();
    let mut existing: Option<&Path> = None;
    let mut cursor = Some(path);
    while let Some(dir) = cursor {
        if dir.exists() {
            existing = Some(dir);
            break;
        }
        missing.push(dir);
        cursor = dir.parent();
    }
    std::fs::create_dir_all(path)?;
    if let Some(reference) = existing {
        for dir in missing.into_iter().rev() {
            adopt_owner(reference, dir);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_every_missing_level_and_stays_idempotent() {
        let root = std::env::temp_dir().join(format!("deveye-ownership-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();

        let deep = root.join("a").join("b").join("c");
        create_dir_all_owned(&deep).unwrap();
        assert!(deep.is_dir(), "every level must exist");

        // Called again on a tree already there, it breaks nothing.
        create_dir_all_owned(&deep).unwrap();
        assert!(deep.is_dir());

        std::fs::remove_dir_all(&root).ok();
    }
}
