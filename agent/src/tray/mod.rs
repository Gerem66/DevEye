//! The DevEye icon in the desktop's notification area: the agent's state at a
//! glance, and a menu to open DevEye, hide the icon or stop the agent.
//!
//! The icon is its own process, one per desktop session (`deveye-agent tray
//! run`, started at login by [`autostart`]): the agent often runs as root or
//! SYSTEM, outside any session, where no icon can be shown. It learns the
//! agent's state from what the agent publishes (`crate::live_status`).

pub mod autostart;
mod icon;
mod view;

#[cfg(any(windows, target_os = "macos"))]
mod desktop;
#[cfg(target_os = "linux")]
mod linux;

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use tracing::{info, warn};

use crate::live_status::{self, LiveStatus};
use icon::{Look, FRAMES};
use view::{Lang, Mood, TrayView};

/// Animation step, and the cadence at which the backends call [`Controller::tick`].
pub const TICK: Duration = Duration::from_millis(200);
/// The published status is read every this many ticks.
const READ_EVERY: u32 = 5;
/// Set on a tray relaunched after an agent update: the version it was relaunched
/// for, so an executable that still disagrees with the agent cannot loop.
const RESPAWNED_FOR: &str = "DEVEYE_TRAY_RESPAWNED_FOR";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Open,
    Hide,
    Quit,
}

/// What a backend has to do after a tick or an action.
#[derive(Debug, Default)]
pub struct Step {
    pub exit: bool,
    pub menu: bool,
    pub icon: bool,
    /// A desktop notification to show before anything else.
    pub notice: Option<(&'static str, &'static str)>,
}

/// `deveye-agent tray run`: show the icon until quit, hidden or superseded.
pub fn run() -> Result<()> {
    if is_hidden() {
        return Ok(());
    }
    let Some(lock) = Lock::acquire() else {
        info!("the DevEye icon already runs in this session");
        return Ok(());
    };
    #[cfg(windows)]
    detach_console();
    let controller = Controller::new(lock);
    #[cfg(target_os = "linux")]
    return linux::run(controller);
    #[cfg(any(windows, target_os = "macos"))]
    return desktop::run(controller);
}

/// `deveye-agent tray show`: undo a hide and start the icon now.
pub fn show() -> Result<()> {
    #[cfg(unix)]
    if crate::report::is_privileged() && std::env::var_os("SUDO_USER").is_some() {
        bail!(
            "run `deveye-agent tray show` without sudo: the icon belongs to your desktop session"
        );
    }
    set_hidden(false)?;
    if !autostart::installed(autostart::Scope::System) {
        autostart::ensure(autostart::Scope::User)?;
    }
    if Lock::held_by_another() {
        println!("✓ The DevEye icon is already shown.");
        return Ok(());
    }
    let exe = std::env::current_exe().context("locating executable")?;
    spawn_detached(Command::new(exe).args(["tray", "run"])).context("starting the icon")?;
    println!("✓ DevEye icon shown.");
    Ok(())
}

/// After `link --autostart`: the icon right away when this terminal is in a
/// desktop session, instead of at the next login.
pub fn start_after_link(system: bool) {
    let scope = autostart::Scope::for_privileged(system);
    // No entry: no desktop on this machine.
    if !autostart::installed(scope) || is_hidden() || Lock::held_by_another() {
        return;
    }
    // Under sudo the session bus and display are gone: the user starts it.
    #[cfg(unix)]
    if crate::report::is_privileged() {
        println!(
            "  The DevEye icon appears at the next desktop login (now: `deveye-agent tray show`, without sudo)."
        );
        return;
    }
    #[cfg(target_os = "linux")]
    if std::env::var_os("WAYLAND_DISPLAY").is_none() && std::env::var_os("DISPLAY").is_none() {
        return;
    }
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    if spawn_detached(Command::new(exe).args(["tray", "run"])).is_ok() {
        println!("✓ DevEye icon shown in the notification area.");
    }
}

/// `deveye-agent tray hide`: hide the icon for this user, now and at every login.
pub fn hide() -> Result<()> {
    set_hidden(true)?;
    println!(
        "✓ DevEye icon hidden. The agent keeps running.\n  Show it again: deveye-agent tray show"
    );
    Ok(())
}

/// Stop every tray process of this executable (uninstall): the binary is about
/// to go, and Windows cannot delete one that runs.
pub fn stop_all() {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let Some(name) = exe.file_name() else {
        return;
    };
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::new().with_cmd(UpdateKind::Always),
    );
    let me = std::process::id();
    for (pid, process) in sys.processes() {
        let is_tray = process.name() == name
            && process.cmd().get(1).is_some_and(|arg| arg == "tray")
            && process.cmd().get(2).is_some_and(|arg| arg == "run");
        if is_tray && pid.as_u32() != me {
            process.kill();
        }
    }
}

/// What the tray keeps in the user's `deveye` config directory.
pub const USER_FILES: [&str; 2] = [HIDDEN_FILE, LOCK_FILE];
const HIDDEN_FILE: &str = "tray-hidden";
const LOCK_FILE: &str = "tray.lock";

fn user_dir() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("deveye"))
}

fn hidden_marker() -> Option<PathBuf> {
    user_dir().map(|d| d.join(HIDDEN_FILE))
}

fn is_hidden() -> bool {
    hidden_marker().is_some_and(|p| p.exists())
}

fn set_hidden(hidden: bool) -> Result<()> {
    let path = hidden_marker().context("no config directory")?;
    if hidden {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
        }
        std::fs::write(&path, b"").with_context(|| format!("writing {}", path.display()))
    } else {
        match std::fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                Err(e).with_context(|| format!("removing {}", path.display()))
            }
            _ => Ok(()),
        }
    }
}

/// One tray per user: the file names the process holding it, by pid and start
/// time, so a pid recycled after a crash does not count.
struct Lock(PathBuf);

impl Lock {
    fn path() -> Option<PathBuf> {
        user_dir().map(|d| d.join(LOCK_FILE))
    }

    fn held_by_another() -> bool {
        let Some(raw) = Self::path().and_then(|p| std::fs::read_to_string(p).ok()) else {
            return false;
        };
        let mut fields = raw.split_whitespace().map(str::parse::<u64>);
        match (fields.next(), fields.next()) {
            (Some(Ok(pid)), Some(Ok(started))) => {
                pid != u64::from(std::process::id())
                    && crate::state::start_time(pid as u32) == Some(started)
            }
            _ => false,
        }
    }

    fn acquire() -> Option<Lock> {
        if Self::held_by_another() {
            return None;
        }
        let path = Self::path()?;
        let pid = std::process::id();
        let started = crate::state::start_time(pid).unwrap_or(0);
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&path, format!("{pid} {started}"));
        Some(Lock(path))
    }
}

impl Drop for Lock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// The platform-independent part of the tray: state, animation and actions.
/// Backends own the icon and the menu, and call [`tick`](Self::tick) every
/// [`TICK`].
pub struct Controller {
    lang: Lang,
    view: TrayView,
    frame: usize,
    ticks: u32,
    /// The freshest live status, `None` when no agent runs.
    status: Option<LiveStatus>,
    /// The last server any status named: still what "Open" opens once the
    /// agent has stopped.
    server: String,
    quitting: Option<mpsc::Receiver<bool>>,
    lock: Option<Lock>,
}

impl Controller {
    fn new(lock: Lock) -> Self {
        let lang = view::detect_lang();
        let server = crate::config::Config::load()
            .map(|c| c.server)
            .unwrap_or_else(|_| crate::config::DEFAULT_SERVER.to_string());
        let mut controller = Controller {
            lang,
            view: view::view(None, 0, lang),
            frame: 0,
            ticks: 0,
            status: None,
            server,
            quitting: None,
            lock: Some(lock),
        };
        controller.refresh();
        controller
    }

    pub fn lang(&self) -> Lang {
        self.lang
    }

    pub fn view(&self) -> &TrayView {
        &self.view
    }

    /// A turn in progress completes before the eye rests.
    pub fn look(&self) -> Look {
        match self.view.mood {
            Mood::Off => Look::Off,
            _ if self.frame != 0 => Look::Busy(self.frame),
            mood => mood.look(self.frame),
        }
    }

    fn refresh(&mut self) {
        let now = live_status::now_secs();
        let all = live_status::read_all();
        if let Some(latest) = all.iter().max_by_key(|s| s.updated_at) {
            self.server = latest.server.clone();
        }
        self.status = all
            .into_iter()
            .filter(|s| s.is_fresh(now))
            .max_by_key(|s| s.updated_at);
        self.view = view::view(self.status.as_ref(), now, self.lang);
    }

    pub fn tick(&mut self) -> Step {
        let mut step = Step::default();
        if let Some(rx) = &self.quitting {
            match rx.try_recv() {
                Ok(true) => {
                    step.exit = true;
                    return step;
                }
                Ok(false) | Err(mpsc::TryRecvError::Disconnected) => self.quitting = None,
                Err(mpsc::TryRecvError::Empty) => {}
            }
        }
        self.ticks = self.ticks.wrapping_add(1);
        if self.ticks.is_multiple_of(READ_EVERY) {
            if is_hidden() || self.respawn_if_updated() {
                step.exit = true;
                return step;
            }
            let before = self.view.clone();
            self.refresh();
            if self.view != before {
                step.menu = true;
                step.icon = before.mood != self.view.mood;
            }
        }
        if self.animate() {
            step.icon = true;
        }
        step
    }

    /// Advance the highlight one step; `true` when the eye must be redrawn.
    fn animate(&mut self) -> bool {
        let turning =
            self.view.mood == Mood::Busy || (self.view.mood == Mood::Idle && self.frame != 0);
        if turning {
            self.frame = (self.frame + 1) % FRAMES;
            true
        } else if self.frame != 0 {
            self.frame = 0;
            true
        } else {
            false
        }
    }

    pub fn act(&mut self, action: Action) -> Step {
        match action {
            Action::Open => {
                open_url(&self.server);
                Step::default()
            }
            Action::Hide => match set_hidden(true) {
                Ok(()) => Step {
                    exit: true,
                    notice: Some(view::hidden_notice(self.lang)),
                    ..Step::default()
                },
                Err(e) => {
                    warn!(error = %e, "cannot hide the icon");
                    Step::default()
                }
            },
            Action::Quit => {
                if self.quitting.is_none() {
                    let status = self.status.clone();
                    let (tx, rx) = mpsc::channel();
                    // The stop may wait on a password prompt: the icon stays responsive.
                    std::thread::spawn(move || {
                        let _ = tx.send(stop_agent(status.as_ref()));
                    });
                    self.quitting = Some(rx);
                }
                Step::default()
            }
        }
    }

    /// The agent was updated under us: hand over to a tray of its version.
    fn respawn_if_updated(&mut self) -> bool {
        let Some(status) = &self.status else {
            return false;
        };
        if status.version == env!("DEVEYE_VERSION")
            || status.exe.is_empty()
            || std::env::var(RESPAWNED_FOR).is_ok_and(|v| v == status.version)
        {
            return false;
        }
        let mut cmd = Command::new(&status.exe);
        cmd.args(["tray", "run"])
            .env(RESPAWNED_FOR, &status.version);
        // The successor must find the lock free.
        let lock = self.lock.take();
        drop(lock);
        match spawn_detached(&mut cmd) {
            Ok(()) => {
                info!(version = %status.version, "agent updated; relaunching the icon");
                true
            }
            Err(e) => {
                warn!(error = %e, "cannot relaunch the icon after an update");
                self.lock = Lock::acquire();
                false
            }
        }
    }
}

/// Stop the agent the way `deveye-agent stop` does, asking for elevation when
/// it runs with more rights than this session. `true` once stopped (or when
/// nothing was running).
fn stop_agent(status: Option<&LiveStatus>) -> bool {
    let Some(status) = status else {
        return true;
    };
    let result = if status.privileged && !crate::report::is_privileged() {
        crate::elevate::run_elevated(&["stop"])
    } else {
        std::env::current_exe()
            .context("locating executable")
            .and_then(|exe| {
                let mut cmd = Command::new(exe);
                cmd.arg("stop").stdin(Stdio::null()).stdout(Stdio::null());
                hide_window(&mut cmd);
                let status = cmd.status().context("running stop")?;
                if !status.success() {
                    bail!("stop exited with {status}");
                }
                Ok(())
            })
    };
    match result {
        Ok(()) => true,
        Err(e) => {
            warn!(error = %e, "the agent was not stopped");
            false
        }
    }
}

/// Open the DevEye web app in the default browser. Only a web URL is handed to
/// the system opener, which would run anything else.
fn open_url(url: &str) {
    let is_web = url.starts_with("https://") || url.starts_with("http://");
    if !is_web || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        warn!(%url, "not a web address; not opening it");
        return;
    }
    #[cfg(target_os = "linux")]
    let mut cmd = Command::new("xdg-open");
    #[cfg(target_os = "macos")]
    let mut cmd = Command::new("open");
    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("rundll32");
        c.arg("url.dll,FileProtocolHandler");
        c
    };
    cmd.arg(url);
    if let Err(e) = spawn_detached(&mut cmd) {
        warn!(error = %e, "cannot open the browser");
    }
}

/// Start `cmd` out of our session and console, and reap it in the background.
fn spawn_detached(cmd: &mut Command) -> std::io::Result<()> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn()?;
    std::thread::spawn(move || child.wait());
    Ok(())
}

/// A console program started from the tray would open a console window.
fn hide_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

/// The agent is a console program: started at login, Windows gives it a
/// console window. Leaving it closes that window.
#[cfg(windows)]
fn detach_console() {
    // SAFETY: no arguments; failing only means there was no console.
    unsafe {
        windows_sys::Win32::System::Console::FreeConsole();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn controller() -> Controller {
        Controller {
            lang: Lang::En,
            view: view::view(None, 0, Lang::En),
            frame: 0,
            ticks: 0,
            status: None,
            server: "https://app.deveye.fr".into(),
            quitting: None,
            lock: None,
        }
    }

    #[test]
    fn a_turn_completes_before_the_eye_rests() {
        let mut c = controller();
        c.view.mood = Mood::Busy;
        for _ in 0..3 {
            assert!(c.animate());
        }
        assert_eq!(c.look(), Look::Busy(3));
        c.view.mood = Mood::Idle;
        while c.frame != 0 {
            assert!(matches!(c.look(), Look::Busy(_)));
            c.animate();
        }
        assert_eq!(c.look(), Look::Idle);
        assert!(!c.animate(), "a resting eye is not redrawn");
    }

    #[test]
    fn a_stopped_agent_greys_the_eye_at_once() {
        let mut c = controller();
        c.view.mood = Mood::Busy;
        c.animate();
        c.view.mood = Mood::Off;
        assert_eq!(c.look(), Look::Off);
        assert!(c.animate());
        assert_eq!(c.frame, 0);
    }

    #[test]
    fn quitting_with_no_agent_just_closes_the_icon() {
        assert!(stop_agent(None));
    }
}
