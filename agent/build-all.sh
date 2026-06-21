#!/usr/bin/env bash
#
# Build the DevEye agent for Linux, macOS and Windows in one go, into agent/dist/.
# Lets you smoke-test all three locally before tagging a release. The CI does the
# same on native runners — see ../.github/workflows/ci.yml.
#
# Cross-compiling needs rustup (Homebrew Rust ships only the host target) plus
# Zig as the cross-linker. One-time setup:
#
#   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
#   rustup target add x86_64-unknown-linux-gnu aarch64-apple-darwin x86_64-pc-windows-gnu
#   brew install zig && cargo install cargo-zigbuild
#
set -euo pipefail
cd "$(dirname "$0")"

# target | output name in dist/ | binary name under target/<t>/release/
TARGETS=(
    "x86_64-unknown-linux-gnu  deveye-agent-linux-x86_64       deveye-agent"
    "aarch64-apple-darwin      deveye-agent-macos-arm64        deveye-agent"
    "x86_64-pc-windows-gnu     deveye-agent-windows-x86_64.exe deveye-agent.exe"
)

# ── Preflight: fail early, with the exact fix for whatever is missing ────────
missing=0
note() { echo "  ✗ $1"; missing=1; }

command -v cargo >/dev/null 2>&1 || note "cargo not found — install rustup (see header)"
command -v rustup >/dev/null 2>&1 || note "rustup not found — install: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
command -v zig >/dev/null 2>&1 || note "zig not found — install: brew install zig"
command -v cargo-zigbuild >/dev/null 2>&1 || note "cargo-zigbuild not found — install: cargo install cargo-zigbuild"

# Homebrew Rust has no cross targets; if it shadows rustup's cargo, nothing works.
if command -v cargo >/dev/null 2>&1 && cargo --version 2>/dev/null | grep -qi homebrew; then
    note "'cargo' resolves to Homebrew Rust (no cross targets). Put ~/.cargo/bin before /opt/homebrew/bin in PATH, or 'brew uninstall rust'."
fi

if (( missing )); then
    echo "Prerequisites missing:" >&2
    echo "Fix the above, then re-run. One-time setup is documented in this script's header." >&2
    exit 1
fi

# Make sure each target's std is installed (idempotent, quiet).
for spec in "${TARGETS[@]}"; do
    # shellcheck disable=SC2086
    set -- $spec
    rustup target add "$1" >/dev/null 2>&1 || true
done

mkdir -p dist
for spec in "${TARGETS[@]}"; do
    # shellcheck disable=SC2086
    set -- $spec
    target="$1" out="$2" bin="$3"
    echo "→ building $target"
    if [[ "$target" == *apple-darwin ]]; then
        # Native target on a Mac: plain cargo, no Zig needed.
        cargo build --release --target "$target"
    else
        cargo zigbuild --release --target "$target"
    fi
    cp "target/$target/release/$bin" "dist/$out"
done

echo "✓ Binaries in agent/dist/:"
ls -la dist
