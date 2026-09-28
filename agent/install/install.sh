#!/bin/sh
# DevEye agent installer for Linux and macOS: downloads the agent built for
# this machine, then links it to the server that served this script.
#
#   curl -fsSL <server>/install.sh | sh -s -- <CODE> [link options]
#
# The options after the code go to `deveye-agent link` (see its --help):
# --autostart, --deny terminal,power, --monitor-only, --shuffle-id, --name.
# Without a code, DEVEYE_LINK_CODE is used. As root, the agent goes to
# /usr/local/bin and a system service; otherwise to ~/.local/bin.
#
# Everything runs from `main`, called on the last line: a download cut short
# runs nothing.

main() {
    set -eu
    server='__DEVEYE_SERVER__'

    code=''
    if [ $# -gt 0 ] && [ "${1#-}" = "$1" ]; then
        code=$1
        shift
    fi
    [ -n "$code" ] || code=${DEVEYE_LINK_CODE:-}
    [ -n "$code" ] || fail "no link code: curl -fsSL $server/install.sh | sh -s -- <CODE>"

    target=$(detect_target)
    if [ "$(id -u)" = 0 ]; then
        dir=/usr/local/bin
        # Some sudo keep the caller's HOME: the config must be root's, where the
        # system service looks for it.
        HOME=$(root_home)
        export HOME
    else
        dir=$HOME/.local/bin
        if [ -x /usr/local/bin/deveye-agent ]; then
            say "Note: an agent is also installed system-wide (/usr/local/bin). This one is for $(id -un) alone."
        fi
    fi
    mkdir -p "$dir"
    dest=$dir/deveye-agent
    # Next to its destination: /tmp may be mounted noexec, and the final move
    # stays a rename (a binary rewritten in place is killed on macOS).
    tmp=$(mktemp "$dir/.deveye-agent.XXXXXX")
    trap 'rm -f "$tmp"' EXIT INT TERM

    say "Downloading the DevEye agent ($target)..."
    download "$server/api/agent/install/$target" "$code" "$tmp"
    chmod 755 "$tmp"
    "$tmp" --version >/dev/null 2>&1 || fail "the downloaded agent does not run on this machine ($target)"
    mv -f "$tmp" "$dest"
    trap - EXIT INT TERM
    say "Installed $dest"
    case ":$PATH:" in
        *":$dir:"*) ;;
        *) say "Note: $dir is not in your PATH." ;;
    esac

    # Through the environment rather than the command line, which every user
    # of the machine can read.
    DEVEYE_LINK_CODE=$code
    export DEVEYE_LINK_CODE
    if names_server "$@"; then
        exec "$dest" link "$@"
    fi
    exec "$dest" link --server "$server" "$@"
}

say() {
    printf '%s\n' "$*"
}

fail() {
    printf 'deveye: %s\n' "$*" >&2
    exit 1
}

names_server() {
    for arg in "$@"; do
        case $arg in
            --server | --server=*) return 0 ;;
        esac
    done
    return 1
}

root_home() {
    home=~root
    if [ -d "$home" ]; then
        printf '%s\n' "$home"
    else
        printf '/root\n'
    fi
}

detect_target() {
    os=$(uname -s)
    arch=$(uname -m)
    case $os in
        Linux) os=linux ;;
        Darwin)
            os=macos
            # An x86_64 shell under Rosetta on Apple silicon.
            if [ "$arch" = x86_64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then
                arch=arm64
            fi
            ;;
        *) fail "unsupported system: $os (Windows installs with install.ps1)" ;;
    esac
    case $os-$arch in
        linux-x86_64 | linux-amd64) echo linux-x86_64 ;;
        linux-aarch64 | linux-arm64) echo linux-aarch64 ;;
        linux-armv7* | linux-armv8l) echo linux-armv7 ;;
        macos-x86_64) echo macos-x86_64 ;;
        macos-arm64 | macos-aarch64) echo macos-arm64 ;;
        *) fail "unsupported processor: $arch ($os)" ;;
    esac
}

# url code output
download() {
    if command -v curl >/dev/null 2>&1; then
        status=$(curl -sSL -w '%{http_code}' -H "X-DevEye-Link-Code: $2" -o "$3" "$1") ||
            fail "download failed: $1"
    elif command -v wget >/dev/null 2>&1; then
        # busybox wget prints no status: a refusal only reads as a failure.
        wget -q --header "X-DevEye-Link-Code: $2" -O "$3" "$1" ||
            fail "download failed ($1): invalid or expired code, or too many attempts"
        return 0
    else
        fail "curl or wget is needed"
    fi
    case $status in
        200) ;;
        401) fail "the link code is invalid, expired or used up: generate a new one in DevEye" ;;
        404) fail "this server has no agent for $target yet" ;;
        429) fail "too many attempts from this address: try again in a few minutes" ;;
        *) fail "download failed (HTTP $status)" ;;
    esac
}

main "$@"
