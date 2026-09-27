# DevEye Agent

Lightweight, cross-platform monitoring daemon for DevEye. It enrolls a machine
with the DevEye server, then streams health metrics and a periodic
health/security report over a single WebSocket.

Supported platforms: **Linux**, **macOS** and **Windows** (same codebase;
OS-specific probes are `#[cfg(target_os)]`-gated).

> Scope, on purpose: the agent handles **pairing, run, stop**, optional
> **start-on-boot** (`service install`, also driven from the UI's « Démarrage
> auto » toggle) and **self-update**. It never installs anything without being
> asked: by default, run it in the foreground or detached and stop it yourself.

## Build

A native binary is produced per platform. The simplest path is to build on the
machine that will run it:

```sh
cd DevEye/agent
cargo build --release
# binary: target/release/deveye-agent  (deveye-agent.exe on Windows)
```

Requires a stable Rust toolchain (`rust-toolchain.toml` pins `stable`).

**The whole matrix at once.** A release ships **8 binaries** (the same set the
web UI offers under **Appareils → Télécharger l'agent**, and the canonical list
in `@deveye/types` `AGENT_TARGETS`):

| OS                    | Cibles                                      |
| --------------------- | ------------------------------------------- |
| Linux (musl statique) | `x86_64`, `aarch64`, `armv7` (Raspberry Pi) |
| macOS                 | `x86_64` (Intel), `arm64` (Silicon)         |
| Windows (MSVC)        | `x86_64`, `x86`, `arm64`                    |

Two ways to produce them:

- **CI** — built natively on each OS on every push to `main` that touches the
  agent, and published (with a `manifest.json`) to the rolling **`agent-latest`**
  prerelease. See `.github/workflows/agent-build.yml` in the `DevEye` repo. No local setup.
- **Locally** — `./build-all.sh` cross-compiles the matrix into `dist/` (handy to
  smoke-test). It needs `rustup` + `zig` + `cargo-zigbuild` (Homebrew Rust can't
  cross-compile); the script preflights and prints the exact install commands if
  anything is missing. It is _best-effort_: Linux is built as static musl and
  Windows via MinGW so it cross-builds from a Mac, while the shipped Windows
  binaries are MSVC (native CI).

**Distribution.** The DevEye server syncs these binaries onto a persistent volume
(`AGENT_DIST_DIR`) **once at boot** from the `agent-latest` release — the only
runtime GitHub touch, isolated in `src/agent/sync.ts` — then serves them from
disk via the **Télécharger l'agent** picker. End users never touch this repo. In
dev, run `cargo build --release` (or `build-all.sh`) to populate `agent/dist/`
and exercise the same flow (no token needed; the sync is skipped).

### Scripts

| Script           | What it does                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------- |
| `./build-all.sh` | Cross-compile **all three** OSes into `dist/` (needs rustup + zig + cargo-zigbuild).      |
| `./clean.sh`     | Remove `target/` (cargo cache, all targets) + `dist/`. Both regenerate on the next build. |

### CI (GitHub Actions, `DevEye` repo)

Two workflows:

| Workflow          | Trigger                                                | Does                                                                                  |
| ----------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `ci.yml`          | every push / PR                                        | server + client + agent: lint, typecheck, build                                       |
| `agent-build.yml` | push to `main` touching `agent/**` (or a version bump) | build the 8-target matrix natively → rolling `agent-latest` release + `manifest.json` |

So every push is checked (the agent on Linux); the full matrix is rebuilt and
published whenever the agent (or the DevEye version) changes.

## Quick start

1. In the DevEye web UI, open **Appareils** → **Appairer un appareil** to
   generate a one-time link code (valid one hour at most).
2. Enroll this machine:
    ```sh
    deveye-agent link ABCD-EFGH --server https://deveye.example.com
    ```
    A plain `http://` server is refused unless it is this machine (see
    [the transport](#what-the-server-can-do-here-and-how-to-limit-it)).
3. A machine new to the workspace is **active at once**, if the plan allows one
   more device (otherwise `link` says so and the code stays valid). Linking a
   machine the workspace already knew takes over its record and puts it back to
   “En attente d’approbation”: its agent is refused until someone approves it in
   **Appareils** (Agent popup), and retries every 30 s. Revoking a device
   archives it and wipes its token; only a new `link` brings it back.
4. Start streaming (restart the agent if it was already running: it still holds
   the old token):
    ```sh
    deveye-agent run            # foreground
    deveye-agent run --detach   # background (writes a PID file)
    ```

The first sample and a health/security report are sent **immediately** on
connect, so the dashboard shows data without waiting a full interval.

## Commands

| Command                                                                     | Description                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `link <code> --server <url> [--name <name>]`                                | Enroll using a one-time code. Platform is auto-detected; name defaults to the hostname. Re-linking keeps the machine identity.                                                                                                                                                                                                         |
| `run [--once] [--interval <secs>] [--detach] [--managed] [--config <path>]` | Run the monitoring loop. `--once`: collect+send a single cycle then exit (handy to test). `--interval`: seconds between samples (default 30). `--detach`: background + PID file. `--managed` / `--config`: **internal**, injected by the installed service — see [Supervision](#supervision---managed) below; never pass them by hand. |
| `stop`                                                                      | Stop a backgrounded agent (reads the PID file, sends SIGTERM).                                                                                                                                                                                                                                                                         |
| `status`                                                                    | Print platform, server, enrollment and running state.                                                                                                                                                                                                                                                                                  |
| `service install [--system] \| uninstall \| status`                         | Manage the autostart service (launchd / systemd / Task Scheduler). Per-user by default, `--system` needs root. Also driven from the UI (« Démarrage auto »).                                                                                                                                                                           |
| `unlink`                                                                    | Forget the local enrollment (deletes the config + token).                                                                                                                                                                                                                                                                              |
| `uninstall [--yes] [--purge-shares]`                                        | **Retrait complet** de la machine : autostart, linger, processus, config, jeton, journal, caches, binaire. Voir [Retrait complet](#retrait-complet-uninstall).                                                                                                                                                                         |

Test a freshly linked device end-to-end:

```sh
deveye-agent run --once     # one instant + report, then exits
```

### System scope: two traps the per-user scope never hits

Both surface only on a real machine, and one of them only on the Fedora family.

1. **The elevated process has root's `$HOME`.** `pkexec` (Linux), `osascript …
with administrator privileges` (macOS) and `sudo` on the distributions that
   set `always_set_home` all rewrite it, so a config path computed inside the
   elevated install pointed at `/root/.config/deveye/agent.toml` — a file that
   does not exist. The running agent knows its own config, so it now passes
   `--config <path>` to the elevated `service install --system`; when nobody
   does, `invoking_config_path()` resolves the caller's home via `SUDO_USER` or
   `PKEXEC_UID` (`pkexec` sets only the latter).

2. **SELinux forbids `init` from executing a file in a home directory.** The
   agent is downloaded into `~`, where it is labelled `user_home_t`; `init_t`
   has no `execute` on that type, so the unit fails `203/EXEC` in a restart loop
   while `systemctl status` only says "Permission denied" about a file that is
   plainly `0755`. Machines without SELinux ran it fine — hence a bug that only
   ever showed on Fedora and its derivatives. A **system** install therefore
   copies the binary to `/usr/local/bin/deveye-agent` (`bin_t`, and writable on
   ostree systems where `/usr/local` links to `/var/usrlocal`) and points the
   unit there. The copy is removed by `service uninstall`, unless it is the
   binary currently running.

## Retrait complet (`uninstall`)

```sh
deveye-agent uninstall                  # récapitule, demande confirmation, retire tout
sudo deveye-agent uninstall             # si un service *système* est installé
deveye-agent uninstall --yes            # sans confirmation (scripts, non interactif)
deveye-agent uninstall --purge-shares   # + la corbeille locale des partages CloudSync
```

`unlink` oublie l'enrôlement. `uninstall` retire **la machine de l'équation** :

1. le service de démarrage automatique (les deux portées, plus la copie
   `/usr/local/bin/deveye-agent`), **avant tout effacement** ;
2. le « linger » systemd qu'une install utilisateur avait allumé — rien ne
   l'éteignait jusqu'ici, et il survivait à l'agent ;
3. l'agent en marche, y compris un `run --detach` que le service ne connaît pas ;
4. le dossier de config (`agent.toml`, `agent.pid`, `agent.log`, `agent.state`,
   `sync-*.index.json`), puis le dossier lui-même s'il est vide ;
5. les `.deveye-tmp` des partages CloudSync ;
6. les résidus d'une mise à jour interrompue, puis **son propre binaire**.

Trois choses à savoir :

- **L'ordre du point 1 n'est pas cosmétique.** Une unité systemd est en
  `Restart=always` / `StartLimitIntervalSec=0` : effacer le binaire sans retirer
  l'unité la fait reboucler toutes les deux secondes sur un `ExecStart` qui
  n'existe plus, indéfiniment. C'est exactement ce que produit une **suppression
  d'appareil depuis l'interface** quand un service est installé
  (`commands::handle_destroy` efface config et binaire, jamais l'unité) — d'où
  cette commande.
- **Un service système fait refuser la commande sans droits root**, avant d'avoir
  touché quoi que ce soit : un retrait à moitié fait est pire que pas de retrait.
- **`.deveye-trash` est conservé par défaut** : c'est la corbeille locale d'un
  partage, donc des fichiers de l'utilisateur. Son chemin est affiché, et
  `--purge-shares` l'efface aussi. (C'est pour ça que le cache de scan enregistre
  la racine du partage : hors ligne, l'agent n'a aucun autre moyen de la
  retrouver.)

Restent hors de portée, et la commande le dit : l'appareil **côté serveur** (à
supprimer dans **Appareils**, ce qui emporte son historique) et les lignes du
service dans le journal systemd, qui ne partent qu'à la rotation du journal.

## Supervision (`--managed`)

`run --managed` declares to the process: _“I am supervised by a service manager
— it will relaunch me if I exit.”_ You never pass it by hand: the service
definitions generated by `service install` inject it themselves
(`ExecStart={exe} run --managed --config {cfg}` in the systemd unit, and the
same in the launchd plist and the Windows scheduled task — see
`src/service.rs`). Setting the `DEVEYE_MANAGED` env var has the same effect.
The value is frozen at startup (`MANAGED` `OnceLock` in `src/main.rs`) and it
exists as an explicit flag because a process cannot reliably detect
cross-platform that it is supervised.

It has exactly three effects:

1. **Restart after self-update** (`update::restart_and_exit`). After swapping
   its binary, a _managed_ agent simply `exit(0)`s — systemd (`Restart=always`)
   or launchd (`KeepAlive`) relaunches it at once on the new binary. An
   unmanaged agent (or Windows, where Task Scheduler does not relaunch a task
   that exits) must spawn a detached successor itself before exiting. We never
   re-exec in place: macOS kills a freshly replaced binary
   (code-signing/AMFI).

2. **Hand-off when autostart is disabled** (`commands::handle_disable_autostart`).
   If the agent _is_ the process supervised by the service being uninstalled,
   the uninstall will SIGTERM it. So it first spawns a standalone (unmanaged)
   copy — in its own process group, to survive the group SIGTERM — then exits.
   This is why toggling « Démarrage auto » off restarts the agent when it runs
   supervised. Without `--managed`, it just removes the service and keeps
   running.

3. **Reported to the server** (`managed` field of the agent report), so the
   server/UI know whether the agent runs under supervision.

**In dev: don't use it.** Nothing relaunches you on exit, so a `--managed`
agent would die for good at its first self-update. The flag only makes sense
when something actually guarantees the relaunch — that is precisely the
information it encodes.

## Configuration & files

The agent writes its own config during `link`. Location: `$DEVEYE_CONFIG`, or
`<config-dir>/deveye/agent.toml`:

- Linux: `~/.config/deveye/agent.toml`
- macOS: `~/Library/Application Support/deveye/agent.toml`
- Windows: `%APPDATA%\deveye\agent.toml`

Alongside it, when running: `agent.pid` (for `stop`/`status`), `agent.state` (the
runtime facts `status` reports), `sync-<shareId>.index.json` (caches de scan
CloudSync) and, when detached, `agent.log`. See `agent.example.toml` for the file
format, et [`uninstall`](#retrait-complet-uninstall) pour tout reprendre.

The directory is `0700` and every file in it `0600`: the config holds the device
token, the log may hold server frames, the sync caches name every file of a
share. The config is read once, at start: **edit it, then restart the agent**.

## What the server can do here, and how to limit it

An agent is a remote administration daemon: with the matching permission in
DevEye, an operator gets a shell, a file explorer, package upgrades and power
control on this machine, as the account the agent runs as (root for a system
service). Three things bound that.

**The local policy.** The `[policy]` section of `agent.toml` says what this
machine accepts, and no server order can change it. Set a key to `false` to keep
monitoring without that kind of remote control; the matching buttons are greyed
out in DevEye, and `deveye-agent status` lists what is refused.

| Key                     | Refuses                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| `allow_terminal`        | opening a shell                                                    |
| `allow_files_write`     | delete, rename, create, upload (browsing and download stay)        |
| `allow_power`           | shut down, reboot, suspend, hibernate, lock                        |
| `allow_pkg_upgrade`     | system package upgrades                                            |
| `allow_service_elevate` | asking the desktop to turn the agent into a root service           |
| `allow_destroy`         | wiping the agent when the device is deleted (uninstall it by hand) |
| `allow_docker_deploy`   | deployments: pulling a compose service's image and recreating it   |

Whatever the policy, the explorer never writes into the agent's own directory:
that is where the policy lives. Be honest about the limit: a machine that allows
the terminal to a root agent has allowed everything else with it.

**Signed orders.** The orders above, plus `agent.service`, `agent.lifecycle` and
every Docker action, must carry the server's Ed25519 signature (`ORDER_SIGNING_KEY` on the server),
over the exact payload, a nonce and a timestamp. The agent pins the public key at
`link` (`order_key`), refuses an unsigned or replayed order, and refuses one
whose timestamp is more than five minutes off (keep the clock right). Holding the
socket is therefore not enough: a TLS-terminating proxy or a stolen device token
cannot order anything. A machine linked before this existed has no `order_key`:
run `link` again, it keeps its device record.

**The transport.** Plain `http://` is refused unless the server is this very
machine; `link --insecure-plaintext` (kept as `allow_plaintext`) accepts it
knowingly, and DevEye then flags the device. The device token travels in the
`Authorization` header, never in the URL, expires after 30 days and is replaced
by the server at connection before that.

**CloudSync roots.** The server chooses the folder of a share. The agent refuses
a system directory (`/etc`, `/usr`, `/var/lib`, `C:\Windows`, ...), the
filesystem root and its own directory, and a path that a symlink would lead out
of the share. `sync_roots = ["/data", "/home/lea/Sync"]` narrows it to the
directories you name (and opens a system one if you name it).

The systemd system unit carries only `RestrictRealtime` and `LockPersonality`:
anything stricter (`ProtectSystem`, `NoNewPrivileges`, a reduced capability set)
also confines the agent's children, which are the operator's root shell and the
package upgrades, and breaks them. What this machine refuses is the policy's job.

## What is collected & cadence

Designed to stay light, with **one cadence pushed by the server** (`agent.config`,
sent on connect and whenever you change it in the **Appareils** page):

- **Collection — every ~60 s** (configurable): one _instant_, sent as one message
  under one timestamp — the graph signals (CPU %, RAM, disk usage, network
  counters, load, CPU temperature, GPU %, uptime, logged-in users, active TCP
  connections), the **process count**, **disk I/O**, and the **process list**
  itself. Every point is therefore a clickable mark on the timeline.
- **Hourly** (and on connect): the **health/security report**.
- **On connect**: an immediate first instant so the dashboard isn't blank.
- **Manual refresh** (UI button): an immediate instant + report.

It stays cheap because one tick runs exactly **two probes**, shared by everything:
an extended `ps` (list, count, and on Linux per-process disk I/O from
`/proc/<pid>/io`) and a single `ss -tuanpH` (listening ports, established
connections, the connection count, and per-process connection counts). That one
socket call replaces the three the agent used to make. Measured at ~40 ms per
tick on a 700-process machine — less than the old heavy cycle cost.

**Process capture mode** (per device): `all` (every program), `top` (the 20
heaviest, scored on **CPU % + memory %**), or `off` (no process history).
Processes are aggregated **by program name** (a browser spreads work over many
helpers), carrying instance count, threads, owner, uptime, disk I/O and
established connections in/out. Per-process network _bytes_ are not collected: no
OS exposes them without eBPF or packet capture. Fields needing privileges we
don't have are reported as `null`, never as zero.

`--interval` only sets the initial cadence used before the server's config
arrives (it arrives within ~1 s of connecting); the real cadence is UI-controlled.

**Health/security report** (OS name/version/arch + posture):

| Signal           | Linux                                                   | macOS                                   | Windows                      |
| ---------------- | ------------------------------------------------------- | --------------------------------------- | ---------------------------- |
| Firewall         | `ufw` / `firewalld`, then `systemctl is-active` / `nft` | Application Firewall (`socketfilterfw`) | `netsh advfirewall`          |
| Disk encryption  | LUKS (via `lsblk`)                                      | FileVault (`fdesetup`)                  | BitLocker (`manage-bde`)     |
| SIP              | —                                                       | `csrutil status`                        | —                            |
| Pending updates  | `apt-get -s upgrade` / `dnf check-update`               | not collected (slow)                    | not collected (slow)         |
| Open ports       | `ss -tuanp` (TCP+UDP, +owner)                           | `netstat -an` + `lsof` (owner)          | `netstat -ano` (+pid)        |
| Privilege        | `id -u` / `id -un`                                      | `id -u` / `id -un`                      | `net session` / `%USERNAME%` |
| GPU %            | `nvidia-smi`                                            | IOAccelerator (`ioreg`)                 | `nvidia-smi`                 |
| Logged-in users  | `who`                                                   | `who`                                   | `query user`                 |
| Active TCP conns | `ss -tuanp` (same call)                                 | `netstat -an`                           | `netstat -ano`               |
| Machine id       | `/etc/machine-id`                                       | IOPlatformUUID (`ioreg`)                | registry `MachineGuid`       |
| Processes        | `ps`                                                    | `ps`                                    | `sysinfo`                    |

Every probe is **best-effort and nullable**: when the underlying tool is absent
or not permitted, the value is reported as “unknown”/empty. Notable limitations:
**CPU temperature is unavailable on Apple Silicon** (SMC access is privileged), and
**disk I/O is reported on Linux** but may be unavailable (hidden) on macOS/Windows.

The report also carries the agent's **privilege level** (root/elevated or not) and
the account it runs as. The UI uses this to flag which signals are limited by a
lack of privileges. On Linux the firewall state now resolves without root when the
firewall is a managed systemd unit (`ufw`/`firewalld`/`nftables`); listing open
ports needs no privileges (only mapping a port to its owning process would).
On Windows, `stop` force-terminates (`taskkill /F`) and a running agent can't
delete its own binary, so a self-destruct leaves the `.exe` behind (the config
and token are still wiped).

**Persistence & retention**: the server stores metrics, the connectivity timeline
and process samples so the dashboard can "go back in time" and survive the agent
going offline (last-known data is kept, live rates show 0). Retention is a
**single per-device duration** (default 30 days), configurable from the device's
"Configurer la collecte" dialog: one tick produces one _instant_ carrying metrics,
presence and the process list together, and they expire together. Pinned instants
are kept regardless of age.
