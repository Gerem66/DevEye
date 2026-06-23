use std::path::Path;

/// Single source of truth for the agent version = the root DevEye `package.json`
/// (the very file the web client bakes into `__APP_VERSION__` and the server reads
/// in `version.ts`). We read it at build time and expose it as `DEVEYE_VERSION`, so
/// the server, the web client and the agent always report the same version — the
/// agent is no longer flagged "too old" just because it lived on its own scale.
///
/// Falls back to the crate's own `version` if the file can't be read (e.g. the
/// crate is built standalone, outside the monorepo checkout).
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
}
