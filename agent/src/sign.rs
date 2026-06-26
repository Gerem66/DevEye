//! DevEye update-signing helper (build-time / CI only, behind `--features signer`).
//!
//! The agent self-update channel is signed: each released binary's sha256 is
//! signed with a dedicated ed25519 key whose **private** half lives only in a CI
//! secret and whose **public** half is embedded in the agent (`update-signing.pub`
//! → `DEVEYE_UPDATE_PUBKEY`). The agent refuses any binary whose signature doesn't
//! verify. This tool produces those artifacts:
//!
//!   deveye-sign keygen                              # print a fresh private+public pair
//!   deveye-sign sign <priv_b64> <hex_sha256>        # print the base64 signature
//!   deveye-sign verify <pub_b64> <hex_sha256> <sig> # exit 0 iff it verifies
//!
//! `verify` uses the exact same `verify_strict` the agent uses, so it doubles as a
//! CI/dev self-check that a signed manifest will actually be accepted on-device.
//!
//! Build/run with: `cargo run --features signer --bin deveye-sign -- …`

use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};

fn die(msg: &str) -> ! {
    eprintln!("{msg}");
    std::process::exit(2);
}

/// Decode an even-length lowercase/uppercase hex string into bytes.
fn hex_decode(s: &str) -> Vec<u8> {
    let s = s.trim();
    if s.len() & 1 != 0 {
        die("hex input must have an even length");
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap_or_else(|_| die("invalid hex input")))
        .collect()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("keygen") => {
            use rand::rngs::OsRng;
            let sk = SigningKey::generate(&mut OsRng);
            let vk: VerifyingKey = sk.verifying_key();
            // The public line is what goes into agent/update-signing.pub; the
            // private line is what goes into the CI secret AGENT_UPDATE_SIGNING_KEY.
            println!("private {}", STANDARD.encode(sk.to_bytes()));
            println!("public {}", STANDARD.encode(vk.to_bytes()));
        }
        Some("sign") => {
            let priv_b64 = args
                .get(2)
                .unwrap_or_else(|| die("usage: deveye-sign sign <priv_b64> <hex_sha256>"));
            let hex = args
                .get(3)
                .unwrap_or_else(|| die("usage: deveye-sign sign <priv_b64> <hex_sha256>"));
            let sk_bytes: [u8; 32] = STANDARD
                .decode(priv_b64.trim())
                .unwrap_or_else(|_| die("private key is not valid base64"))
                .try_into()
                .unwrap_or_else(|_| die("private key must decode to 32 bytes"));
            let sk = SigningKey::from_bytes(&sk_bytes);
            let sig = sk.sign(&hex_decode(hex));
            println!("{}", STANDARD.encode(sig.to_bytes()));
        }
        Some("verify") => {
            let pub_b64 = args.get(2).unwrap_or_else(|| die("usage: deveye-sign verify <pub_b64> <hex_sha256> <sig_b64>"));
            let hex = args.get(3).unwrap_or_else(|| die("usage: deveye-sign verify <pub_b64> <hex_sha256> <sig_b64>"));
            let sig_b64 = args.get(4).unwrap_or_else(|| die("usage: deveye-sign verify <pub_b64> <hex_sha256> <sig_b64>"));
            let vk_bytes: [u8; 32] = STANDARD
                .decode(pub_b64.trim())
                .unwrap_or_else(|_| die("public key is not valid base64"))
                .try_into()
                .unwrap_or_else(|_| die("public key must decode to 32 bytes"));
            let vk = VerifyingKey::from_bytes(&vk_bytes).unwrap_or_else(|_| die("invalid public key"));
            let sig_bytes: [u8; 64] = STANDARD
                .decode(sig_b64.trim())
                .unwrap_or_else(|_| die("signature is not valid base64"))
                .try_into()
                .unwrap_or_else(|_| die("signature must decode to 64 bytes"));
            // verify_strict mirrors exactly what the agent's update.rs runs.
            match vk.verify_strict(&hex_decode(hex), &Signature::from_bytes(&sig_bytes)) {
                Ok(()) => println!("OK"),
                Err(_) => die("FAIL: signature does not verify"),
            }
        }
        _ => die("usage: deveye-sign keygen | sign <priv_b64> <hex_sha256> | verify <pub_b64> <hex_sha256> <sig_b64>"),
    }
}
