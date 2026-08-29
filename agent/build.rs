use std::path::Path;

/// Map a Rust target triple to the DevEye agent target id (mirrors
/// `@deveye/types` `AGENT_TARGETS` and `build-all.sh`). Returns `""` for an
/// unknown triple, in which case the agent simply omits its target from
/// `agent.hello` and can't be self-updated (but otherwise runs fine).
fn agent_target(triple: &str) -> &'static str {
    match triple {
        "x86_64-unknown-linux-musl" | "x86_64-unknown-linux-gnu" => "linux-x86_64",
        "aarch64-unknown-linux-musl" | "aarch64-unknown-linux-gnu" => "linux-aarch64",
        "armv7-unknown-linux-musleabihf" | "armv7-unknown-linux-gnueabihf" => "linux-armv7",
        "x86_64-apple-darwin" => "macos-x86_64",
        "aarch64-apple-darwin" => "macos-arm64",
        "x86_64-pc-windows-gnu" | "x86_64-pc-windows-msvc" => "windows-x86_64",
        "i686-pc-windows-gnu" | "i686-pc-windows-msvc" => "windows-x86",
        "aarch64-pc-windows-gnullvm" | "aarch64-pc-windows-msvc" => "windows-arm64",
        _ => "",
    }
}

/// The agent version comes from the root DevEye `package.json` (the file the web
/// client bakes into `__APP_VERSION__` and the server reads in `version.ts`),
/// exposed as `DEVEYE_VERSION` so all three report the same version. Falls back
/// to the crate's own `version` when the file can't be read (standalone build).
fn main() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR unset");
    let pkg_path = Path::new(&manifest_dir).join("../package.json");
    println!("cargo:rerun-if-changed={}", pkg_path.display());

    let version = std::fs::read_to_string(&pkg_path)
        .ok()
        .and_then(|raw| {
            serde_json::from_str::<serde_json::Value>(&raw)
                .ok()
                .and_then(|v| v.get("version")?.as_str().map(str::to_owned))
        })
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());

    println!("cargo:rustc-env=DEVEYE_VERSION={version}");

    // The build target id, so the agent reports it in `agent.hello` and the
    // server can resolve which binary to push for a self-update. `TARGET` is set
    // by cargo for every build (host or cross).
    let target = std::env::var("TARGET")
        .map(|t| agent_target(&t))
        .unwrap_or("");
    println!("cargo:rustc-env=DEVEYE_TARGET={target}");

    // The update-signing public key (base64), embedded so the agent can verify a
    // pushed binary before swapping it in. Empty when the key file is absent (e.g.
    // a dev build that predates `deveye-sign keygen`) — self-update then refuses.
    let pubkey_path = Path::new(&manifest_dir).join("update-signing.pub");
    println!("cargo:rerun-if-changed={}", pubkey_path.display());
    let pubkey = std::fs::read_to_string(&pubkey_path)
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    println!("cargo:rustc-env=DEVEYE_UPDATE_PUBKEY={pubkey}");
}
