# DevEye Agent

Lightweight, cross-platform monitoring daemon for DevEye. It enrolls a machine
with a DevEye server, then streams health metrics and a periodic
health/security report over a single WebSocket, and carries out the orders the
server is allowed to give it (shell, files, packages, power, containers,
CloudSync, tunnels).

Supported platforms: **Linux**, **macOS** and **Windows** (same codebase;
OS-specific probes are `#[cfg(target_os)]`-gated).

> Scope, on purpose: the agent handles **pairing, run, stop**, optional
> **start-on-boot** (`service install`, armed or disarmed from the UI's
> « Démarrage automatique » entry), **self-update** and its own **removal**. It never installs
> anything without being asked: by default, run it in the foreground or detached
> and stop it yourself.

## Build

A native binary is produced per platform. The simplest path is to build on the
machine that will run it:

```sh
cd DevEye/agent
cargo build --release
# binary: target/release/deveye-agent  (deveye-agent.exe on Windows)
```

Requires a stable Rust toolchain (`rust-toolchain.toml` pins `stable`, with
`rustfmt` and `clippy`). `build.rs` reads the agent version from the root
`package.json` of DevEye, so the server, the web client and the agent report the
same version, and embeds the update-signing public key (`update-signing.pub`)
that self-updates are verified against.

**The whole matrix at once.** A release ships **8 binaries** (the same set the
web UI offers under **Appareils → Télécharger l'agent**, and the canonical list
in `@deveye/types` `AGENT_TARGETS`):

| OS                  | Targets                                     |
| ------------------- | ------------------------------------------- |
| Linux (static musl) | `x86_64`, `aarch64`, `armv7` (Raspberry Pi) |
| macOS               | `x86_64` (Intel), `arm64` (Silicon)         |
| Windows (MSVC)      | `x86_64`, `x86`, `arm64`                    |

Two ways to produce them:

- **CI**: built natively on each OS on every push to `main` that touches the
  agent, and published (with a `manifest.json`) to the rolling **`agent-latest`**
  prerelease. See `.github/workflows/agent-build.yml` in the `DevEye` repo. No
  local setup.
- **Locally**: `./build-all.sh` cross-compiles the matrix into `dist/` (handy to
  smoke-test). It needs `rustup` + `zig` + `cargo-zigbuild` (Homebrew Rust can't
  cross-compile); the script preflights and prints the exact install commands if
  anything is missing. It is _best-effort_: Linux is built as static musl and
  Windows via MinGW so it cross-builds from a Mac, while the shipped Windows
  binaries are MSVC (native CI).

**Distribution.** The DevEye server syncs these binaries onto a persistent volume
(`AGENT_DIST_DIR`, `agent/dist` by default) **once at boot** from the
`agent-latest` release (the only runtime GitHub touch, isolated in
`src/agent/source.ts` and `src/agent/sync.ts`), then serves them from disk via
the **Télécharger l'agent** picker. End users never touch this repo. In dev, run
`./build-all.sh` (or copy `target/release/deveye-agent` into `agent/dist/` under
the filename `AGENT_TARGETS` gives its target) to exercise the same flow; without
a GitHub token the sync is skipped.

### Scripts

| Script           | What it does                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------- |
| `./build-all.sh` | Cross-compile **all three** OSes into `dist/` (needs rustup + zig + cargo-zigbuild).      |
| `./clean.sh`     | Remove `target/` (cargo cache, all targets) + `dist/`. Both regenerate on the next build. |

### CI (GitHub Actions, `DevEye` repo)

Three workflows touch the agent:

| Workflow          | Trigger                                                                                        | Does                                                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `ci.yml`          | every push / PR                                                                                | the `agent` job, on Linux: `cargo fmt --check`, `cargo clippy` with warnings as errors, a release build, `cargo test`, `cargo audit` |
| `agent-build.yml` | push to `main` touching `agent/**`, or changing the version in `package.json`; manual dispatch | build the 8-target matrix natively, then publish the rolling `agent-latest` release + `manifest.json`                                |
| `agent-audit.yml` | every Monday at 06:00 UTC; manual dispatch                                                     | `cargo audit` against the RUSTSEC advisories: a vulnerable crate does not wait for a push, the agent runs as root on other machines  |

So every push is checked (the agent on Linux); the full matrix is rebuilt and
published whenever the agent (or the DevEye version) changes.

## Quick start

1. In the DevEye web UI, open **Appareils** → **Appairer un appareil**. Pick the
   system and what DevEye may do on the machine, then generate a link code.
2. Paste the command the dialog shows into a terminal of the machine. On Linux
   and macOS:
    ```sh
    curl -fsSL https://<your-server>/install.sh | sh -s -- ABCD-EFGH --autostart
    ```
    and in PowerShell on Windows:
    ```powershell
    & ([scriptblock]::Create((irm https://<your-server>/install.ps1))) ABCD-EFGH --autostart
    ```
    The script downloads the agent built for this machine (the code stands for
    a session, no use of it is spent), installs it (`/usr/local/bin` as root,
    `~/.local/bin` otherwise; `Program Files` or the user's `LOCALAPPDATA` on
    Windows), then runs `deveye-agent link` with the options that follow the
    code. With `sudo sh` (or an administrator PowerShell), `--autostart`
    installs a system service.
3. A machine new to the workspace is **active at once**, if the plan allows one
   more device (otherwise `link` says so and the code stays valid). Linking a
   machine the workspace already knew takes over its record and puts it back to
   “En attente d’approbation”: its agent is refused until someone approves it in
   **Appareils** (Agent popup), and retries every 30 s. Revoking a device
   archives it and wipes its token; only a new `link` brings it back.

Without the script: download the binary from **Télécharger l’agent**, then
`deveye-agent link ABCD-EFGH` and `deveye-agent run` (or `link --autostart`). A
plain `http://` server is refused unless it is this machine (see
[the transport](#what-the-server-can-do-here-and-how-to-limit-it)). The first
sample and a health/security report are sent **immediately** on connect, so the
dashboard shows data without waiting a full interval.

The server a `link` talks to is the one named (`--server` or `DEVEYE_SERVER`),
else the one this machine is already linked to, else the build's default:
`DEFAULT_SERVER` in `src/config.rs`, which is the hosted service
(`https://app.deveye.fr`) unless the build sets `DEVEYE_DEFAULT_SERVER` at
compile time. A self-hosted build sets it to its own origin; the commands the
pairing dialog shows always name the server that generated the code.

The installer is only as trustworthy as the server that serves it: `curl | sh`
runs what that server sends, with the `--deny` options it was given. For a
machine where that matters, take the released binary and run `link` yourself;
self-updates, on the other hand, only ever install a binary signed by the
release CI (see [update.rs](src/update.rs)).

## Commands

| Command                                                                                                                             | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `link <code> [--server <url>] [--name <name>] [--deny <list>] [--monitor-only] [--shuffle-id] [--insecure-plaintext] [--autostart]` | Enroll with a link code. The server defaults to the one saved by a previous link, else the build's default. `--deny` and `--monitor-only` refuse kinds of orders ([the policy](#what-the-server-can-do-here-and-how-to-limit-it)); on a re-link they only add refusals. `--shuffle-id`: see [cloned machines](#cloned-machines). `--insecure-plaintext`: accept a plain `http://` server that is not this machine. `--autostart`: then install and start the service, system-wide as root. Re-linking keeps the machine identity. |
| `run [--once] [--interval <secs>] [--detach] [--managed] [--config <path>]`                                                         | Run the monitoring loop. Not linked yet, it enrolls first with `DEVEYE_LINK_CODE` and the `link` options ([fleets](#linking-a-fleet)). `--once`: collect+send a single cycle then exit (handy to test). `--interval`: seconds between samples before the server's config arrives (default 30). `--detach`: background + PID file. `--managed` / `--config`: **internal**, injected by the installed service (see [Supervision](#supervision---managed)); never pass them by hand.                                                 |
| `policy [--allow <list>] [--deny <list>] [--monitor-only] [--config <path>]`                                                        | Show what this machine lets the server order, or change it, then restart the agent so it applies.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `stop`                                                                                                                              | Stop the running agent: the installed service until the next boot or login (`systemctl stop`, `launchctl bootout`, `schtasks /End`), else a backgrounded one (PID file, SIGTERM).                                                                                                                                                                                                                                                                                                                                                 |
| `status`                                                                                                                            | Print platform, server, enrollment and running state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `service install [--system \| --user] [--no-autostart] [--config <path>] \| enable \| disable \| uninstall \| status`               | Manage the autostart service (launchd / systemd / Task Scheduler). Per-user by default (`--user` says so explicitly), `--system` needs root. `--no-autostart` installs and starts it without arming it for the next boot. `enable` / `disable` arm or disarm the installed service (see [Start at boot](#start-at-boot)). `--config` bakes a config path into the service definition (see [System scope](#system-scope)). Also driven from the UI.                                                                                |
| `tray show \| hide`                                                                                                                 | Show or hide the DevEye icon in the notification area, for this user. See [Notification-area icon](#notification-area-icon-tray).                                                                                                                                                                                                                                                                                                                                                                                                 |
| `packages`                                                                                                                          | List the package managers found on this machine and their pending updates (diagnostic).                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `unlink`                                                                                                                            | Forget the local enrollment (deletes the config + token).                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `uninstall [--yes] [--purge-shares]`                                                                                                | Remove the agent from the machine entirely: autostart service, linger, running process, config, token, log, caches, binary. See [Full removal](#full-removal-uninstall).                                                                                                                                                                                                                                                                                                                                                          |

Test a freshly linked device end-to-end:

```sh
deveye-agent run --once     # one instant + report, then exits
```

## Linking a fleet

A link code serves as many machines as it was generated for (a thousand at
most), for up to seven days, in one workspace. Every new machine takes a device
of the plan; one the plan has no room for is refused, and the code stays valid.
Keep both numbers as small as the rollout allows, and revoke the code once it is
done: whoever holds it can link a machine to the workspace until then.

Everything `link` takes can come from the environment, which is how an image or
a provisioning tool links machines without a human at the keyboard:

| Variable                 | Stands for                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| `DEVEYE_LINK_CODE`       | the code; `run` enrolls with it when the machine is not linked yet, and only then         |
| `DEVEYE_SERVER`          | `--server`                                                                                |
| `DEVEYE_NAME`            | `--name` (the hostname otherwise)                                                         |
| `DEVEYE_DENY`            | `--deny`, e.g. `terminal,power`; on an agent already linked, added at every start         |
| `DEVEYE_MONITOR_ONLY`    | `--monitor-only` (`1`, `true`, `yes`)                                                     |
| `DEVEYE_SHUFFLE_ID`      | `--shuffle-id` (`1`, `true`, `yes`)                                                       |
| `DEVEYE_CONFIG`          | the config file, instead of `<config-dir>/deveye/agent.toml`                              |
| `DEVEYE_MANAGED`         | same as `run --managed`                                                                   |
| `DEVEYE_ALLOW_PLAINTEXT` | `1` accepts a plain `http://` server that is not this machine (as `--insecure-plaintext`) |
| `RUST_LOG`               | log level (`info` by default)                                                             |

A machine that is linked ignores `DEVEYE_LINK_CODE`, so it can stay in a unit or
an image: nothing happens twice, and a revoked device never comes back on its
own (only a new `link` does). Under a service manager, a failed enrollment never
ends the agent (it would be relaunched at once): it retries a network failure
within five minutes, a full plan after fifteen minutes to an hour, a rate limit
after the delay the server names, and stops calling the server for a code that
is invalid, spent or refused, waiting for a `link` made by hand.

**cloud-init**, once per instance:

```yaml
runcmd:
    - curl -fsSL https://<your-server>/install.sh | sh -s -- ABCD-EFGH-JKLM --autostart --deny terminal
```

**Ansible**, keeping the code out of the logs:

```yaml
- name: Link to DevEye
  ansible.builtin.shell: curl -fsSL https://<your-server>/install.sh | sh -s -- --autostart
  args:
      creates: /root/.config/deveye/agent.toml
  environment:
      DEVEYE_LINK_CODE: '{{ deveye_link_code }}'
  no_log: true
```

**systemd**, for an image that links at first boot: put the code in a file only
root reads (a unit file is readable by every user), then run the agent as usual.

```ini
# /etc/systemd/system/deveye-agent.service.d/link.conf
[Service]
EnvironmentFile=/etc/deveye/link.env
```

```sh
# /etc/deveye/link.env, mode 0600
DEVEYE_LINK_CODE=ABCD-EFGH-JKLM
DEVEYE_SHUFFLE_ID=1
```

**Docker**: a container has no machine-id, and its hostname changes with every
recreation. Keep the config on a volume, with a random identity drawn once:

```sh
docker run -d --restart unless-stopped --name deveye-agent \
  -v deveye-agent:/data -e DEVEYE_CONFIG=/data/agent.toml \
  -e DEVEYE_LINK_CODE=ABCD-EFGH-JKLM -e DEVEYE_SHUFFLE_ID=1 -e DEVEYE_NAME=web-1 \
  <image with deveye-agent> deveye-agent run --managed
```

### Cloned machines

A machine is known to DevEye by its fingerprint: `/etc/machine-id` on Linux
(`/var/lib/dbus/machine-id` as fallback), the `IOPlatformUUID` on macOS, the
`MachineGuid` on Windows. VMs cloned from an image that kept its `machine-id`
share it, and would share one device record. So a code that serves several
machines refuses one the workspace already knows (`conflict`), rather than let
a clone take over its sibling's record.

- An image sealed with an empty `/etc/machine-id` (the systemd way) needs
  nothing: each clone draws its own at first boot.
- Otherwise, link with `--shuffle-id` (or `DEVEYE_SHUFFLE_ID=1`): the agent draws
  a random identity, stored in its config, instead of reading the machine's.
  Running the same command again keeps it; on a machine that was linked under
  its machine-id, it links as a new device and says so.
- Never clone a machine that is already linked: the copies would share one
  token and knock each other off the server. `deveye-agent unlink` before
  sealing the image.

### System scope

A system service (`service install --system`, or `link --autostart` as root)
differs from a per-user one in two ways that the code handles for you:

1. **The elevated process has root's `$HOME`.** `pkexec` (Linux), `osascript …
with administrator privileges` (macOS) and `sudo` on the distributions that
   set `always_set_home` all rewrite it, so a config path computed inside the
   elevated process would point at `/root/.config/deveye/agent.toml`, a file
   that does not exist. The running agent knows its own config and passes
   `--config <path>` to the elevated `service install --system`; when nobody
   does, `invoking_config_path()` resolves the caller's home via `SUDO_USER` or
   `PKEXEC_UID` (`pkexec` sets only the latter).

2. **SELinux forbids `init` from executing a file in a home directory.** A
   binary downloaded into `~` is labelled `user_home_t`, and `init_t` has no
   `execute` on that type: the unit would fail `203/EXEC` in a restart loop
   while `systemctl status` only says "Permission denied" about a file that is
   plainly `0755`. A **system** install therefore copies the binary to
   `/usr/local/bin/deveye-agent` (labelled `bin_t`, and writable on ostree
   systems where `/usr/local` links to `/var/usrlocal`) and points the unit
   there. `service uninstall` removes the copy, unless it is the binary
   currently running.

### Start at boot

Which service carries the agent (per-user or system, that is root or not) and
whether it starts with the machine are two separate settings. The report
carries both: `serviceScope` and `autostart`.

Disarming leaves the service installed and the agent running under it; it only
stops it from coming back after a reboot:

| Platform | Disarm                               | Read back                              |
| -------- | ------------------------------------ | -------------------------------------- |
| Linux    | `systemctl [--user] disable`         | `systemctl [--user] is-enabled`        |
| macOS    | `launchctl disable <domain>/<label>` | `launchctl print-disabled <domain>`    |
| Windows  | `schtasks /Change /DISABLE`          | `<Settings><Enabled>` of `/Query /XML` |

A disarmed launchd job or scheduled task refuses to be started, so `start` and
`restart` arm it for the launch and disarm it again. On Linux a per-user unit
starts with the machine only under « linger », which arming turns on;
disarming leaves it on, since turning it off would stop the user's service
manager, and the agent with it, outside any open session.

From the UI, arming an agent that has no service installs one matching its
privileges (system when root, per-user otherwise) and hands over to it. A
system service needs root to be armed or disarmed: an agent without it
replies with the command to run on the machine (`sudo deveye-agent service
enable`). Elevating keeps the current choice (`--no-autostart` when disarmed).

## Full removal (`uninstall`)

```sh
deveye-agent uninstall                  # recaps, asks for confirmation, removes everything
sudo deveye-agent uninstall             # when a *system* service is installed
deveye-agent uninstall --yes            # no confirmation (scripts, non-interactive)
deveye-agent uninstall --purge-shares   # also the local trash of CloudSync shares
```

`unlink` forgets the enrollment. `uninstall` takes **the machine out of the
equation**, in this order:

1. the autostart service (both scopes, plus the `/usr/local/bin/deveye-agent`
   copy), **before anything is erased**;
2. the systemd « linger » a per-user install turned on;
3. the running agent, including a `run --detach` the service knows nothing
   about;
4. the [notification-area icon](#notification-area-icon-tray): its processes,
   its login entries and the status published for it;
5. the config directory (`agent.toml`, `agent.pid`, `agent.log`, `agent.state`,
   `sync-device.key`, `sync-*.index.json`, `status.json`, `tray-hidden`,
   `tray.lock`), then the directory itself when it is empty and named `deveye`.
   Run elevated, it sweeps the caller's directory too (the one `sudo` hides
   behind root's `$HOME`), where the real enrollment lives;
6. the `.deveye-tmp` scratch directory of every CloudSync share;
7. the leftovers of an interrupted update, then **its own binary**.

Three things to know:

- **The order of step 1 is not cosmetic.** A systemd unit runs with
  `Restart=always` / `StartLimitIntervalSec=0`: erasing the binary without
  removing the unit makes it loop every two seconds on an `ExecStart` that no
  longer exists, indefinitely.
- **A system service makes the command refuse without root**, before it has
  touched anything: a half-done removal is worse than none.
- **`.deveye-trash` is kept by default**: it is the local trash of a share,
  hence the user's files. Its path is printed, and `--purge-shares` erases it
  too. The share roots are read from the scan caches, which is why those record
  the root of their share: offline, the agent has no other way to find it.

Out of reach, and the command says so: the device **on the server side** (delete
it in **Appareils**, which takes its history with it) and the service's lines in
the systemd journal, which only leave at journal rotation.

**Deleting the device from DevEye** sends the agent an `agent.destroy` order,
and the agent removes itself the same way, from inside: the files of step 5 in
its own config directory (`Config::self_destruct` in `src/config.rs`), its
binary, its service definition and the tray (`commands::handle_destroy`). The
running agent is the instance its service supervises, so the order differs
from `uninstall`: the unit is disabled and its file erased without stopping it,
the confirmation goes to the server, and only then does the agent ask its
manager to stop it (`systemctl stop --no-block`, `launchctl bootout`), a stop
that `Restart=always` and `KeepAlive` do not undo. A remote order leaves the
share folders (`.deveye-tmp`, `.deveye-trash`) alone, and the systemd
« linger », which other services of the account may rely on.

## Supervision (`--managed`)

`run --managed` declares to the process: _“I am supervised by a service manager,
it will relaunch me if I exit.”_ You never pass it by hand: the service
definitions generated by `service install` inject it themselves
(`ExecStart={exe} run --managed --config {cfg}` in the systemd unit, and the
same in the launchd plist and the Windows scheduled task, see `src/service.rs`).
Setting the `DEVEYE_MANAGED` env var has the same effect. The value is frozen at
startup (`MANAGED` `OnceLock` in `src/main.rs`) and it exists as an explicit
flag because a process cannot reliably detect cross-platform that it is
supervised.

It has exactly three effects:

1. **Restart after self-update** (`update::restart_and_exit`). After swapping
   its binary, a _managed_ agent simply `exit(0)`s: systemd (`Restart=always`)
   or launchd (`KeepAlive`) relaunches it at once on the new binary. An
   unmanaged agent (or Windows, where Task Scheduler does not relaunch a task
   that exits) must spawn a detached successor itself before exiting. The agent
   never re-execs in place: macOS kills a freshly replaced binary
   (code-signing/AMFI).

2. **Reported to the server** (`managed` field of the agent report), so the
   server/UI know whether the agent runs under supervision.

3. **The tray icon is registered at login** on every start, so the login entry
   exists even when the service was installed by an older agent (see
   [Notification-area icon](#notification-area-icon-tray)).

**In dev: don't use it.** Nothing relaunches you on exit, so a `--managed`
agent would die for good at its first self-update. The flag only makes sense
when something actually guarantees the relaunch: that is precisely the
information it encodes.

## Notification-area icon (`tray`)

On a machine with a desktop, the DevEye eye sits in the notification area (the
menu bar on macOS). Its menu shows the agent's state (connected, connecting,
waiting for approval, offline, stopped) and what it is doing (CloudSync
transfers, a self-update, a deployment, package upgrades), then an entry that
opens DevEye (the server this machine is linked to), one that hides the icon
and one that quits DevEye; the labels follow the desktop's language (French or
English). While the agent works, the eye's highlight circles the pupil; when it
is not connected, the eye turns grey.

```sh
deveye-agent tray show   # show the icon again, now and at every login
deveye-agent tray hide   # hide it for this user; the agent keeps running
```

- **One process per desktop session** (`deveye-agent tray run`): the agent
  usually runs as root or SYSTEM, where no icon can be shown. The icon starts at
  login from an entry written when the service is installed, and again on every
  supervised start:

    | OS      | System service (every user)                         | Per-user service                                     |
    | ------- | --------------------------------------------------- | ---------------------------------------------------- |
    | Linux   | `/etc/xdg/autostart/deveye-agent-tray.desktop`      | `~/.config/autostart/deveye-agent-tray.desktop`      |
    | macOS   | `/Library/LaunchAgents/com.deveye.agent.tray.plist` | `~/Library/LaunchAgents/com.deveye.agent.tray.plist` |
    | Windows | `HKLM\…\Run`, value `DevEyeTray`                    | `HKCU\…\Run`, value `DevEyeTray`                     |

    The agent writes the Linux entry only where a display manager lists a session
    (`/usr/share/xsessions`, `/usr/share/wayland-sessions`): a headless server
    gets nothing.

- **The agent publishes its state** for the icon, on every change and every 5 s:
  `/run/deveye-agent/status.json` (`/var/run/…` on macOS,
  `HKLM\Software\DevEye\AgentStatus` on Windows) for a privileged agent,
  readable by every user and writable by root or administrators only; the
  config directory (`HKCU` on Windows) for a per-user one. It holds no secret:
  state, version, server URL. A status older than 20 s means the agent is gone.
  After an update, the icon relaunches itself from the agent's new binary.
- **Hiding is per user** (a `tray-hidden` marker in `<config-dir>/deveye/`); the
  login entry stays, so each user of a shared machine keeps their own choice.
- **Quit stops the agent** until the next boot (next login for a per-user
  service), as `deveye-agent stop` does. For a system service it asks for the
  administrator password (polkit, the macOS dialog, UAC).
- **Linux** speaks StatusNotifierItem over D-Bus: KDE and most panels show it
  natively, **GNOME** only with the "AppIndicator and KStatusNotifierItem
  Support" extension (on by default on Ubuntu).
- **Windows**: the agent is a console program; started at login, its console
  window may show for an instant before the icon detaches from it.

## Configuration & files

The agent writes its own config during `link`. Location: `$DEVEYE_CONFIG`, or
`<config-dir>/deveye/agent.toml`:

- Linux: `~/.config/deveye/agent.toml`
- macOS: `~/Library/Application Support/deveye/agent.toml`
- Windows: `%APPDATA%\deveye\agent.toml`

Alongside it, when running: `agent.pid` (for `stop`/`status`), `agent.state`
(the runtime facts `status` reports), `sync-<shareId>.index.json` (CloudSync
scan caches), `sync-device.key` (this machine's X25519 private key, which opens
the key of an end-to-end encrypted CloudSync share and never leaves the
machine), for a per-user agent `status.json` (what the
[tray icon](#notification-area-icon-tray) reads), `tray-hidden` and `tray.lock`,
and, when detached, `agent.log`. See `agent.example.toml` for the file format,
and [`uninstall`](#full-removal-uninstall) to remove everything.

The directory is `0700` and every file in it `0600`: the config holds the device
token, the log may hold server frames, the sync caches name every file of a
share. The config is read once, at start: **edit it, then restart the agent**
(`deveye-agent policy` does both for the policy). A token the server rotates
meanwhile is written into the file as it is on disk, so an edit made while the
agent runs stays.

## What the server can do here, and how to limit it

An agent is a remote administration daemon: with the matching permission in
DevEye, an operator gets a shell, a file explorer, package upgrades and power
control on this machine, as the account the agent runs as (root for a system
service). Three things bound that.

**The local policy.** The `[policy]` section of `agent.toml` says what this
machine accepts, and no server order can change it. Set a key to `false` to keep
monitoring without that kind of remote control; the matching buttons are greyed
out in DevEye, and `deveye-agent status` lists what is refused. It is decided at
`link` (`--deny terminal,power`, or `--monitor-only` for every key) and changed
on the machine only, with `deveye-agent policy --allow <list>` / `--deny <list>`,
which restarts the agent so it applies.

| Key                     | `--deny` value    | Refuses                                                            |
| ----------------------- | ----------------- | ------------------------------------------------------------------ |
| `allow_terminal`        | `terminal`        | opening a shell                                                    |
| `allow_files_read`      | `files-read`      | browsing, searching, downloading and archiving files               |
| `allow_files_write`     | `files-write`     | delete, rename, create, upload                                     |
| `allow_power`           | `power`           | shut down, reboot, suspend, hibernate, lock                        |
| `allow_pkg_upgrade`     | `pkg-upgrade`     | system package upgrades                                            |
| `allow_service_elevate` | `service-elevate` | asking the desktop to turn the agent into a root service           |
| `allow_destroy`         | `destroy`         | wiping the agent when the device is deleted (uninstall it by hand) |
| `allow_docker`          | `docker`          | every container action (the inventory stays readable)              |
| `allow_docker_deploy`   | `docker-deploy`   | deployments: pulling a compose service's image and recreating it   |
| `allow_sync`            | `sync`            | CloudSync shares: the server reading and writing a synced folder   |
| `allow_tunnel`          | `tunnel`          | tunnels: a module reaching a service of this machine (a database)  |

`all` stands for every key. Monitoring (metrics, reports, the Docker inventory)
is never refused: it is what the agent is for. Nor can the server install an
older agent to get around a key it does not know: a self-update to a version
older than the running one is refused.

Whatever the policy, the explorer never writes into the agent's own directory:
that is where the policy lives. Be honest about the limit: a machine that allows
the terminal to a root agent has allowed everything else with it.

**Signed orders.** Ten orders must carry the server's Ed25519 signature
(`ORDER_SIGNING_KEY` on the server) over the exact payload, a nonce and a
timestamp: `term.open`, `files.mutate`, `files.upload`, `agent.service`,
`agent.power`, `agent.destroy`, `pkg.upgrade`, `agent.lifecycle`,
`docker.action` and `tunnel.open` (`SIGNED_COMMANDS` in `src/protocol.rs`).
Reads (file listing, search and download, the Docker inventory) are bound by
the policy only. The agent pins the public key at `link` (`order_key`), refuses
an unsigned or replayed order (nonces are remembered across reconnects), and
refuses one whose timestamp is more than five minutes off (keep the clock
right). Holding the socket is therefore not enough: a TLS-terminating proxy or a
stolen device token cannot order anything. A config without `order_key` refuses
every signed order: run `link` again, it keeps the device record.

**The transport.** Plain `http://` is refused unless the server is this very
machine; `link --insecure-plaintext` (kept as `allow_plaintext`) accepts it
knowingly, and DevEye then flags the device. The device token travels in the
`Authorization` header, never in the URL, expires after 30 days and is replaced
by the server at connection once fewer than seven days remain; the previous
token is still accepted for that handshake, so a rotation never cuts a machine
off.

**CloudSync roots.** The server chooses the folder of a share. The agent refuses
the filesystem root, its own directory, a path that a symlink would lead out of
the share, and the system directories: on Linux `/etc`, `/usr`, `/bin`, `/sbin`,
`/lib`, `/lib64`, `/boot`, `/sys`, `/proc`, `/dev`, `/run`, `/var/lib` and
`/root/.ssh`; on macOS the same plus `/Library`, `/System`, `/private` and
`/Applications`; on Windows `C:\Windows`, `C:\Program Files`,
`C:\Program Files (x86)` and `C:\ProgramData`. `sync_roots = ["/data",
"/home/lea/Sync"]` narrows it to the directories you name (and opens a system
one if you name it).

**Tunnel targets.** A tunnel is a TCP connection this machine opens for the
server, so that a DevEye module reaches a service only this machine sees: the
Bases de données feature uses it for a database listening on `127.0.0.1`. By
default it reaches this machine's loopback and nothing else, so a linked machine
is not a door into its network. `tunnel_targets = ["db.lan", "192.168.1.20"]`
opens the hosts you name; a name is resolved once, every address it resolves to
must be loopback or listed (a name that resolves partly outside is refused
whole), and the connection goes to the addresses checked, never to the name
again.

The systemd system unit carries only `RestrictRealtime` and `LockPersonality`:
anything stricter (`ProtectSystem`, `NoNewPrivileges`, a reduced capability set)
also confines the agent's children, which are the operator's root shell and the
package upgrades, and breaks them. What this machine refuses is the policy's job.

## What is collected & cadence

Designed to stay light, with **one cadence pushed by the server** (`agent.config`,
sent on connect and whenever you change it in the device's settings):

- **Collection**: every 60 s on a paid plan, every 300 s otherwise
  (`DEFAULT_METRIC_INTERVAL_SECONDS` in `@deveye/types`), configurable per
  device. One _instant_, sent as one message under one timestamp: the graph
  signals (CPU %, RAM, disk usage, network counters, load, CPU temperature,
  GPU %, battery level and charging state, uptime, logged-in users, active TCP
  connections), the **process count**, **disk I/O**, and the **process list**
  itself. Every point is therefore a clickable mark on the timeline.
- **Hourly** (and on connect): the **health/security report**.
- **On connect**: an immediate first instant so the dashboard isn't blank.
- **Manual refresh** (UI button): an immediate instant + report.

It stays cheap because one tick runs exactly **two probes**, shared by everything:
a process scan (`/proc` on Linux, with per-process disk I/O from
`/proc/<pid>/io` and `ps` as fallback; `ps` on macOS; `sysinfo` on Windows) and
a single socket listing (`ss -tuanpH` on Linux, `netstat -an` + `lsof` on
macOS, `netstat -ano` on Windows) that yields listening ports, established
connections, the connection count and per-process connection counts. Measured
at about 40 ms per tick on a 700-process machine.

**Process capture mode** (per device): `all` (every program), `top` (the 20
heaviest, scored on **CPU % + memory %**), or `off` (no process history).
Processes are aggregated **by program name and executable path** (a browser
spreads work over many helpers), carrying instance count, threads, owner,
uptime, disk I/O and established connections in/out. Per-process network
_bytes_ are not collected: no OS exposes them without eBPF or packet capture.
Fields needing privileges the agent does not have are reported as `null`, never
as zero.

`--interval` only sets the initial cadence used before the server's config
arrives; on connect the agent waits up to 2 s for it before its first sample,
so that one already reflects the saved per-device settings. The real cadence is
UI-controlled.

**Health/security report** (OS name/version/arch + posture):

| Signal                   | Linux                                                                                  | macOS                                   | Windows                                    |
| ------------------------ | -------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------ |
| Firewall                 | `ufw status` / `nft list ruleset` as root; `systemctl is-active` on the unit otherwise | Application Firewall (`socketfilterfw`) | `netsh advfirewall show allprofiles state` |
| Disk encryption          | LUKS (via `lsblk`)                                                                     | FileVault (`fdesetup`)                  | BitLocker (`manage-bde -status`)           |
| SIP                      | not applicable                                                                         | `csrutil status`                        | not applicable                             |
| Pending updates          | `apt-get -s upgrade` / `dnf check-update`                                              | not collected (slow)                    | not collected                              |
| Security updates         | `*-security` suites (apt) / `dnf updateinfo list security`                             | not collected                           | not collected                              |
| Reboot required          | `/var/run/reboot-required` (Debian family) / `needs-restarting -r`                     | not collected                           | not collected                              |
| SSH root login           | `PermitRootLogin` in `sshd_config` (`Include` and `Match` honoured)                    | same                                    | not collected                              |
| SSH password auth        | `PasswordAuthentication` in `sshd_config`                                              | same                                    | not collected                              |
| Mandatory access control | `getenforce` (SELinux), `aa-status --enabled` (AppArmor)                               | not collected                           | not collected                              |
| Open ports               | `ss -tuanp` (TCP+UDP, +owner)                                                          | `netstat -an` + `lsof` (owner)          | `netstat -ano` (+pid)                      |
| Privilege                | `id -u` / `id -un`                                                                     | `id -u` / `id -un`                      | `net session` / `%USERNAME%`               |
| GPU %                    | `nvidia-smi`                                                                           | IOAccelerator (`ioreg`)                 | not collected                              |
| Battery                  | `/sys/class/power_supply/BAT*`                                                         | `pmset -g batt`                         | not collected                              |
| Logged-in users          | `who`                                                                                  | `who`                                   | `query user`                               |
| Active TCP conns         | `ss -tuanp` (same call)                                                                | `netstat -an`                           | `netstat -ano`                             |
| Machine id               | `/etc/machine-id`                                                                      | IOPlatformUUID (`ioreg`)                | registry `MachineGuid`                     |
| Processes                | `/proc` (`ps` as fallback)                                                             | `ps`                                    | `sysinfo`                                  |

The `security` section of the report carries `firewall`, `diskEncryption`,
`sip`, `pendingUpdates`, `pendingSecurityUpdates`, `updatesCheckedAt` (the
moment of the last update check: its age is the finding, not the count),
`sshRootLogin`, `sshPasswordAuth`, `mandatoryAccessControl`
(`selinux-enforcing`, `selinux-permissive`, `apparmor` or `none`) and
`rebootRequired` (`Security` in `src/protocol.rs`).

Every probe is **best-effort and nullable**: when the underlying tool is absent
or not permitted, the value is reported as “unknown”/empty. Notable limitations:
**CPU temperature is unavailable on Apple Silicon** (SMC access is privileged),
and **per-process disk I/O is reported on Linux and Windows only** (macOS has no
unprivileged source).

The report also carries the agent's **privilege level** (root/elevated or not),
the account it runs as, its local policy and its transport. The UI uses this to
flag which signals are limited by a lack of privileges. On Linux the firewall
state resolves without root when the firewall is a managed systemd unit
(`ufw`/`firewalld`/`nftables`); listing open ports needs no privileges (only
mapping a port to its owning process would). On Windows, `stop` force-terminates
(`taskkill /F`) and a running agent can't delete its own binary, so a
self-destruct leaves the `.exe` behind (the config and token are still wiped).

**Persistence & retention**: the server stores metrics, the connectivity timeline
and process samples so the dashboard can "go back in time" and survive the agent
going offline (last-known data is kept, live rates show 0). Retention is a
**single per-device duration** (default 30 days), configurable from the device's
settings, **Collecte** tab: one tick produces one _instant_ carrying metrics,
presence and the process list together, and they expire together. Pinned
instants are kept regardless of age.
