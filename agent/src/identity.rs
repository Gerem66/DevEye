//! Stable machine identity: fingerprint + Ed25519 signing keypair.

use anyhow::{Context, Result};
use base64::Engine;
use ed25519_dalek::SigningKey;
use rand::rngs::OsRng;

/// Derive a stable fingerprint for this machine.
///
/// Prefers the systemd/D-Bus machine-id (stable across reboots, unique per
/// install). Falls back to the hostname when no machine-id is available.
pub fn machine_fingerprint() -> String {
    for path in ["/etc/machine-id", "/var/lib/dbus/machine-id"] {
        if let Ok(id) = std::fs::read_to_string(path) {
            let id = id.trim();
            if !id.is_empty() {
                return id.to_string();
            }
        }
    }
    hostname()
}

pub fn hostname() -> String {
    sysinfo::System::host_name().unwrap_or_else(|| "deveye-host".to_string())
}

/// A freshly generated Ed25519 keypair, encoded base64 for storage/transport.
pub struct Keypair {
    pub secret_b64: String,
    pub public_b64: String,
}

pub fn generate_keypair() -> Keypair {
    let signing = SigningKey::generate(&mut OsRng);
    let engine = base64::engine::general_purpose::STANDARD;
    Keypair {
        secret_b64: engine.encode(signing.to_bytes()),
        public_b64: engine.encode(signing.verifying_key().to_bytes()),
    }
}

/// Reconstruct the signing key from its stored base64 seed (for future use).
#[allow(dead_code)]
pub fn load_signing_key(secret_b64: &str) -> Result<SigningKey> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(secret_b64)
        .context("decoding secret key")?;
    let seed: [u8; 32] = bytes.as_slice().try_into().context("secret key must be 32 bytes")?;
    Ok(SigningKey::from_bytes(&seed))
}
