# DevEye Agent

Lightweight, cross-platform monitoring daemon for DevEye. It enrolls a machine
with the DevEye server, then streams health metrics and a periodic
health/security report over a single WebSocket.

Supported platforms: **Linux** and **macOS** (same codebase; OS-specific probes
are `#[cfg(target_os)]`-gated).

> Scope, on purpose: the agent only handles **pairing, run, stop** and a few
> base commands. It does **not** install itself or configure start-on-boot.
> Run it in the foreground, or detached, and stop it yourself.

## Build

A native binary is produced per platform — build it on the machine that will run
it (or cross-compile with the matching Rust target):

```sh
cd DevEye/agent
cargo build --release
# binary: target/release/deveye-agent
```

Requires a stable Rust toolchain (`rust-toolchain.toml` pins `stable`).

## Quick start

1. In the DevEye web UI, open **Appareils** (top-right menu) → **Ajouter un
   appareil** to generate a one-time link code.
2. Enroll this machine:
   ```sh
   deveye-agent link ABCD-EFGH --server https://deveye.example.com
   ```
3. Back in **Appareils**, **approve** the device (it starts as “En attente”).
   Until approved, the server drops its metrics — this is the gate that makes a
   device trusted. You can revoke or delete it later there too.
4. Start streaming:
   ```sh
   deveye-agent run            # foreground
   deveye-agent run --detach   # background (writes a PID file)
   ```

The first sample and a health/security report are sent **immediately** on
connect, so the dashboard shows data without waiting a full interval.

## Commands

| Command | Description |
| --- | --- |
| `link <code> --server <url> [--name <name>]` | Enroll using a one-time code. Platform is auto-detected; name defaults to the hostname. Re-linking keeps the machine identity. |
| `run [--once] [--interval <secs>] [--detach]` | Run the monitoring loop. `--once`: collect+send a single cycle then exit (handy to test). `--interval`: seconds between samples (default 30). `--detach`: background + PID file. |
| `stop` | Stop a backgrounded agent (reads the PID file, sends SIGTERM). |
| `status` | Print platform, server, enrollment and running state. |
| `unlink` | Forget the local enrollment (deletes the config + token). |

Test a freshly approved device end-to-end:

```sh
deveye-agent run --once     # one snapshot + report, then exits
```

## Configuration & files

The agent writes its own config during `link`. Location: `$DEVEYE_CONFIG`, or
`<config-dir>/deveye/agent.toml`:

- Linux: `~/.config/deveye/agent.toml`
- macOS: `~/Library/Application Support/deveye/agent.toml`

Alongside it, when running: `agent.pid` (for `stop`/`status`) and, when detached,
`agent.log`. See `agent.example.toml` for the file format.

## What is collected

**Time-series metrics** (every cycle): CPU %, RAM, disk, network counters,
logged-in users, 1-minute load average, CPU temperature, uptime, process count,
active TCP connections.

**Health/security report** (on connect, then every ~2 min): OS name/version/arch,
top processes by CPU, and security posture:

| Signal | Linux | macOS |
| --- | --- | --- |
| Firewall | `ufw` / `firewalld` | Application Firewall (`socketfilterfw`) |
| Disk encryption | LUKS (via `lsblk`) | FileVault (`fdesetup`) |
| SIP | — | `csrutil status` |
| Pending updates | `apt-get -s upgrade` / `dnf check-update` | not collected (slow) |

Every security probe is **best-effort and nullable**: when the underlying tool is
absent or not permitted, the value is reported as “unknown” and the UI shows it
as such. Notable limitation: **CPU temperature is unavailable on Apple Silicon**
(SMC access is privileged), so it is reported as `null` there.
