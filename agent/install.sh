#!/usr/bin/env bash
# Install the DevEye agent: build the release binary, install it and the
# system service, then enroll this machine with a link code.
#
# Usage:
#   sudo ./install.sh --server https://deveye.example.com --code ABCD-EFGH [--name host]
set -euo pipefail

SERVER=""
CODE=""
NAME=""
BIN_DEST="/usr/local/bin/deveye-agent"
UNIT_DEST="/etc/systemd/system/deveye-agent.service"
CONFIG_DIR="/etc/deveye"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --server) SERVER="$2"; shift 2 ;;
        --code) CODE="$2"; shift 2 ;;
        --name) NAME="$2"; shift 2 ;;
        *) echo "Unknown argument: $1" >&2; exit 1 ;;
    esac
done

if [[ -z "$SERVER" || -z "$CODE" ]]; then
    echo "Usage: sudo $0 --server <url> --code <link-code> [--name <device-name>]" >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Building release binary"
( cd "$SCRIPT_DIR" && cargo build --release )

echo "==> Installing binary to $BIN_DEST"
install -m 0755 "$SCRIPT_DIR/target/release/deveye-agent" "$BIN_DEST"

echo "==> Installing systemd unit to $UNIT_DEST"
install -m 0644 "$SCRIPT_DIR/systemd/deveye-agent.service" "$UNIT_DEST"

echo "==> Preparing config dir $CONFIG_DIR"
mkdir -p "$CONFIG_DIR"

echo "==> Enrolling this machine"
ENROLL_ARGS=(link "$CODE" --server "$SERVER")
[[ -n "$NAME" ]] && ENROLL_ARGS+=(--name "$NAME")
DEVEYE_CONFIG="$CONFIG_DIR/agent.toml" "$BIN_DEST" "${ENROLL_ARGS[@]}"
chmod 0600 "$CONFIG_DIR/agent.toml"

echo "==> Enabling and starting the service"
systemctl daemon-reload
systemctl enable --now deveye-agent

echo "✓ DevEye agent installed. Confirm the device in DevEye → Clients."
echo "  Logs: journalctl -u deveye-agent -f"
