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

## What is collected & cadence

Designed to stay light, with **two cadences pushed by the server** (`agent.config`,
sent on connect and whenever you change them in the **Appareils** page):

- **Metrics — every ~10 s** (configurable): a light sample for the graphs (CPU %,
  RAM, disk usage, network counters, load, CPU temperature, GPU %, uptime,
  logged-in users, active TCP connections). No full process scan, so it stays
  cheap at this rate.
- **Snapshots — every ~5 min** (configurable): the **process list** (mode below)
  plus the heavier signals that need a process scan — **process count** and
  **disk I/O** (read/write). These are the clickable marks on the timeline.
- **Hourly** (and on connect): the **health/security report**.
- **On connect**: an immediate first snapshot so the dashboard isn't blank.
- **Manual refresh** (UI button): an immediate snapshot + processes + report.

**Process capture mode** (per device): `all` (every process), `top` (the 20
heaviest, scored on **CPU % + memory %**), or `off` (no process history). Per-process
GPU/network usage aren't portably available, so they're not part of the score.

`--interval` only sets the initial metric interval used before the server's config
arrives (it arrives within ~1 s of connecting); the real cadence is UI-controlled.

**Health/security report** (OS name/version/arch + posture):

| Signal | Linux | macOS |
| --- | --- | --- |
| Firewall | `ufw` / `firewalld` | Application Firewall (`socketfilterfw`) |
| Disk encryption | LUKS (via `lsblk`) | FileVault (`fdesetup`) |
| SIP | — | `csrutil status` |
| Pending updates | `apt-get -s upgrade` / `dnf check-update` | not collected (slow) |
| GPU % | `nvidia-smi` | IOAccelerator (`ioreg`) |

Every probe is **best-effort and nullable**: when the underlying tool is absent
or not permitted, the value is reported as “unknown”/empty. Notable limitations:
**CPU temperature is unavailable on Apple Silicon** (SMC access is privileged), and
**disk I/O is reported on Linux** but may be unavailable (hidden) on macOS.

**Persistence & retention**: the server stores metrics, the connectivity timeline
and process samples so the dashboard can "go back in time" and survive the agent
going offline (last-known data is kept, live rates show 0). Both retentions are
**per device, configurable from the Appareils page**: metric/timeline history
(default 30 days) and the bulkier **process history** (default 1 day).
