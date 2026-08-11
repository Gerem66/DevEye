//! Signed self-update: download a newer agent binary, verify it, and swap it in.
//!
//! Triggered by the server's `agent.update` order. The new binary is **never**
//! trusted on download alone — it is accepted only when its sha256 matches the
//! value the server sent AND an ed25519 signature over those sha256 bytes verifies
//! against the public key embedded at build time (`DEVEYE_UPDATE_PUBKEY`, from
//! update-signing.pub). The private half lives only in a CI secret, so even a
//! compromised download path (or release host) can't make the agent run an
//! unsigned binary.
//!
//! Swap is atomic: on Unix we rename the new file over the running executable
//! (the kernel keeps the old inode alive until exit); on Windows we move the
//! running .exe aside first (it can't be overwritten while open) and drop the new
//! one in its place. The caller then restarts (see [`restart_and_exit`]).

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signature, VerifyingKey};
use sha2::{Digest, Sha256};
use tracing::info;

use crate::config::Config;

/// Public key (base64) the agent was built with; empty when no key was embedded.
const UPDATE_PUBKEY_B64: &str = env!("DEVEYE_UPDATE_PUBKEY");

/// Download, verify (sha256 + ed25519 signature) and atomically swap in the new
/// binary for `target_id`. On success the running executable on disk is the new
/// version and its path is returned, so the caller can [`restart_and_exit`] into
/// it. On any failure the current binary is left untouched and an error is
/// returned (reported upstream).
pub async fn apply(
    config: &Config,
    target_id: &str,
    version: &str,
    sha256_hex: &str,
    signature_b64: &str,
) -> Result<PathBuf> {
    let verifying_key =
        embedded_key().context("update refused: no signing key embedded in this agent")?;

    let token = config
        .device_token
        .as_deref()
        .context("device token missing")?;
    let base = config.server.trim_end_matches('/');
    let url = format!("{base}/api/agent/self-update/{target_id}");

    info!(%url, %version, "downloading update");
    let bytes = reqwest::Client::new()
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .context("requesting update binary")?
        .error_for_status()
        .context("server refused the update download")?
        .bytes()
        .await
        .context("reading update binary")?;

    // 1. Integrity: the bytes must hash to exactly what the server announced.
    let digest = Sha256::digest(&bytes);
    let expected = decode_hex32(sha256_hex).context("invalid sha256 from server")?;
    if digest.as_slice() != expected {
        return Err(anyhow!(
            "sha256 mismatch: downloaded binary is corrupt or wrong"
        ));
    }

    // 2. Authenticity: the signature over those sha256 bytes must verify.
    let sig_bytes: [u8; 64] = STANDARD
        .decode(signature_b64)
        .context("signature is not valid base64")?
        .try_into()
        .map_err(|_| anyhow!("signature must be 64 bytes"))?;
    let signature = Signature::from_bytes(&sig_bytes);
    verifying_key
        .verify_strict(&expected, &signature)
        .map_err(|_| anyhow!("signature verification failed — refusing to install"))?;

    info!(%version, "update verified (sha256 + signature); swapping binary");
    let exe = std::env::current_exe().context("locating current executable")?;
    swap_binary(&exe, &bytes).context("swapping in the new binary")?;
    // Return the (stable) install path: after the swap it holds the new binary,
    // whereas `current_exe()` may now resolve to the unlinked old inode on Linux.
    Ok(exe)
}

/// Parse the embedded base64 public key into a verifier; `None` when no key was
/// baked in (a dev build that predates `deveye-sign keygen`).
///
/// `const_is_empty` voit une constante et conclut « toujours faux ». C'est vrai
/// **de ce build-là** : `UPDATE_PUBKEY_B64` vient d'`env!`, donc sa valeur est
/// figée à la compilation. Mais le garde protège l'autre configuration — celle
/// d'un build sans clé signée —, et l'écart entre les deux est exactement ce que
/// la fonction est censée absorber. Clippy 1.97 ne le signale plus ; 1.91, celui
/// des paquets Fedora, si.
#[allow(clippy::const_is_empty)]
fn embedded_key() -> Option<VerifyingKey> {
    if UPDATE_PUBKEY_B64.is_empty() {
        return None;
    }
    let bytes: [u8; 32] = STANDARD.decode(UPDATE_PUBKEY_B64).ok()?.try_into().ok()?;
    VerifyingKey::from_bytes(&bytes).ok()
}

/// Decode a 64-char hex sha256 into its 32 raw bytes.
fn decode_hex32(hex: &str) -> Result<[u8; 32]> {
    let hex = hex.trim();
    if hex.len() != 64 {
        return Err(anyhow!("sha256 must be 64 hex chars"));
    }
    let mut out = [0u8; 32];
    for (i, slot) in out.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16)
            .context("non-hex character in sha256")?;
    }
    Ok(out)
}

/// Atomically replace the running executable at `exe` with `bytes`.
#[cfg(unix)]
fn swap_binary(exe: &Path, bytes: &[u8]) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let dir = exe.parent().unwrap_or_else(|| Path::new("."));
    let tmp = dir.join(format!(".deveye-agent.new-{}", std::process::id()));
    std::fs::write(&tmp, bytes).with_context(|| format!("writing {}", tmp.display()))?;
    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))?;
    // Same-directory rename is atomic; the running process keeps the old inode.
    std::fs::rename(&tmp, exe).with_context(|| format!("renaming over {}", exe.display()))?;
    Ok(())
}

/// Windows can't overwrite a running .exe, but it can be *moved*: shift the
/// running image aside (`.old`) and drop the new binary in its place. The `.old`
/// file is cleaned up by [`cleanup_after_update`] on the next start.
#[cfg(windows)]
fn swap_binary(exe: &Path, bytes: &[u8]) -> Result<()> {
    let old = old_path(exe);
    let _ = std::fs::remove_file(&old); // a leftover from a previous update
    std::fs::rename(exe, &old).with_context(|| format!("moving {} aside", exe.display()))?;
    std::fs::write(exe, bytes).with_context(|| format!("writing {}", exe.display()))?;
    Ok(())
}

#[cfg(windows)]
fn old_path(exe: &Path) -> PathBuf {
    exe.with_extension("old")
}

/// Remove the `.old` binary a previous Windows update left behind (best effort).
/// No-op on Unix, where the swap leaves nothing to clean. Call once at startup.
pub fn cleanup_after_update() {
    #[cfg(windows)]
    if let Ok(exe) = std::env::current_exe() {
        let _ = std::fs::remove_file(old_path(&exe));
    }
}

/// Restart into the (already-swapped) binary at `exe` and terminate this process.
/// Never returns.
///
/// We restart by letting a **fresh process** load the new binary, never by
/// re-exec-ing in place: macOS refuses to exec a just-replaced executable image
/// (code-signing/AMFI kills it), so an in-place re-exec leaves the agent stuck on
/// the old version. A clean exit + relaunch is the portable, reliable path.
///
/// - **Supervised** (systemd `Restart=always`, launchd `KeepAlive`): just exit; the
///   manager relaunches us at once (tuned via `RestartSec` / `ThrottleInterval`).
/// - **Unsupervised** (foreground/detached) **or Windows** (Task Scheduler won't
///   relaunch a task that exits): spawn a detached successor ourselves, then exit.
pub fn restart_and_exit(exe: &Path) -> ! {
    // Hand off the single-instance lock: the successor (spawned below, or
    // relaunched by the service manager) checks the runtime-state file on
    // startup and must not find one still pointing at this exiting process.
    crate::state::clear();
    let _ = std::fs::remove_file(Config::pid_path());
    // On Windows nothing relaunches us on exit; on Unix a service manager does
    // (when we're managed). Otherwise we respawn ourselves.
    let respawn_ourselves = cfg!(windows) || !crate::managed();
    if respawn_ourselves {
        if let Err(e) = relaunch_detached(exe) {
            tracing::error!(error = %e, "failed to relaunch after update");
        }
    }
    std::process::exit(0);
}

/// Spawn a fresh **unmanaged** background `run` of `exe`, mirroring the detach path
/// in `main.rs`: log to the config dir, record the new PID. Used for the Windows
/// update restart (and as the Unix re-exec fallback), and for the autostart-disable
/// handoff (where a supervised agent hands off to a standalone copy before the
/// service that supervises it is removed).
pub(crate) fn relaunch_detached(exe: &Path) -> Result<()> {
    // Hand off the single-instance lock before spawning (see restart_and_exit;
    // also called directly for the autostart-disable handoff, where *we* keep
    // running until the service teardown kills us — the successor must not see
    // our runtime-state file and refuse to start).
    crate::state::clear();
    let _ = std::fs::remove_file(Config::pid_path());
    let log = std::fs::File::create(Config::log_path()).context("creating log file")?;
    let log_err = log.try_clone()?;

    let mut cmd = Command::new(exe);
    cmd.arg("run");
    if let Ok(cfg) = std::env::var("DEVEYE_CONFIG") {
        cmd.env("DEVEYE_CONFIG", cfg);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err));
    // Detach into a new process group so the successor survives a signal aimed at
    // *our* group — notably the autostart-disable handoff, where the service
    // manager SIGTERMs the supervised job (us) as it tears the service down.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let child = cmd.spawn().context("spawning standalone agent")?;
    let _ = std::fs::write(Config::pid_path(), child.id().to_string());
    info!(pid = child.id(), "spawned standalone agent");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    #[test]
    fn decode_hex32_roundtrips_and_rejects_bad_input() {
        let hex = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
        let bytes = decode_hex32(hex).expect("valid 64-char hex");
        assert_eq!(bytes[0], 0x00);
        assert_eq!(bytes[1], 0x11);
        assert_eq!(bytes[31], 0xff);

        assert!(decode_hex32("abcd").is_err()); // too short
        assert!(decode_hex32(&"zz".repeat(32)).is_err()); // non-hex chars
    }

    /// The same `verify_strict` over the announced sha256 the agent runs before it
    /// swaps a binary: a correctly-signed digest verifies, any tamper is rejected.
    #[test]
    fn signature_gate_accepts_valid_and_rejects_tampered() {
        let signing = SigningKey::from_bytes(&[7u8; 32]);
        let verifying = signing.verifying_key();
        let digest = [0xABu8; 32];
        let signature = signing.sign(&digest);

        assert!(verifying.verify_strict(&digest, &signature).is_ok());

        let mut tampered = digest;
        tampered[0] ^= 0x01;
        assert!(verifying.verify_strict(&tampered, &signature).is_err());
    }
}
