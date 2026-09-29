//! Starts `deveye-agent tray run` at every desktop login.
//!
//! A privileged agent registers the tray for every user of the machine (XDG
//! autostart in `/etc`, a LaunchAgent in `/Library`, `HKLM\…\Run`), a per-user
//! one for its own account. Hiding the icon never removes the entry: it is a
//! per-user marker the tray checks at start (see `super::is_hidden`), so each
//! user of a shared machine keeps their own choice and an agent that rewrites
//! its entry on start cannot bring a hidden icon back.

use anyhow::{Context, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    User,
    System,
}

impl Scope {
    /// The scope an agent running with these rights registers.
    pub fn for_privileged(privileged: bool) -> Self {
        if privileged {
            Scope::System
        } else {
            Scope::User
        }
    }
}

fn exe() -> Result<String> {
    Ok(std::env::current_exe()
        .context("locating executable")?
        .to_string_lossy()
        .into_owned())
}

/// Register the tray for `scope`. Rewrites the entry only when it differs (a
/// moved executable).
pub fn ensure(scope: Scope) -> Result<()> {
    imp::ensure(scope, &exe()?)
}

/// [`ensure`], unless this machine has no desktop: what the agent does on its
/// own, where nobody asked for an icon.
pub fn ensure_if_desktop(scope: Scope) -> Result<()> {
    if !imp::has_desktop() {
        return Ok(());
    }
    ensure(scope)
}

/// Whether an entry is registered for `scope`.
pub fn installed(scope: Scope) -> bool {
    imp::installed(scope)
}

/// Remove the entries of both scopes (the system one needs privileges).
pub fn remove_all() {
    imp::remove(Scope::User);
    imp::remove(Scope::System);
}

/// Write `contents` to `path` unless it already holds exactly that.
#[cfg(unix)]
fn write_if_changed(path: &std::path::Path, contents: &str) -> Result<()> {
    if std::fs::read_to_string(path).is_ok_and(|current| current == contents) {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    std::fs::write(path, contents).with_context(|| format!("writing {}", path.display()))
}

#[cfg(target_os = "linux")]
mod imp {
    use std::path::PathBuf;

    use super::*;

    const FILE: &str = "deveye-agent-tray.desktop";

    fn path(scope: Scope) -> Option<PathBuf> {
        match scope {
            Scope::System => Some(PathBuf::from("/etc/xdg/autostart").join(FILE)),
            Scope::User => dirs::config_dir().map(|d| d.join("autostart").join(FILE)),
        }
    }

    /// A display manager's session list: a server without a screen gets no
    /// autostart file it would never read.
    pub fn has_desktop() -> bool {
        ["/usr/share/xsessions", "/usr/share/wayland-sessions"]
            .iter()
            .any(|dir| std::fs::read_dir(dir).is_ok_and(|mut d| d.next().is_some()))
    }

    /// An `Exec` argument, quoted as the Desktop Entry spec wants it.
    fn exec_quote(arg: &str) -> String {
        let mut out = String::from("\"");
        for c in arg.chars() {
            match c {
                '"' | '`' | '$' | '\\' => {
                    out.push('\\');
                    out.push(c);
                }
                '%' => out.push_str("%%"),
                _ => out.push(c),
            }
        }
        out.push('"');
        out
    }

    pub(super) fn entry(exe: &str) -> String {
        format!(
            "[Desktop Entry]\n\
             Type=Application\n\
             Name=DevEye\n\
             Comment=DevEye agent status icon\n\
             Exec={} tray run\n\
             Terminal=false\n\
             NoDisplay=true\n\
             X-GNOME-Autostart-enabled=true\n",
            exec_quote(exe)
        )
    }

    pub fn ensure(scope: Scope, exe: &str) -> Result<()> {
        let path = path(scope).context("no config directory")?;
        write_if_changed(&path, &entry(exe))
    }

    pub fn installed(scope: Scope) -> bool {
        path(scope).is_some_and(|p| p.exists())
    }

    pub fn remove(scope: Scope) {
        if let Some(path) = path(scope) {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use std::path::PathBuf;

    use super::*;

    const LABEL: &str = "com.deveye.agent.tray";

    fn path(scope: Scope) -> Option<PathBuf> {
        let dir = match scope {
            Scope::System => PathBuf::from("/Library/LaunchAgents"),
            Scope::User => dirs::home_dir()?.join("Library/LaunchAgents"),
        };
        Some(dir.join(format!("{LABEL}.plist")))
    }

    pub fn has_desktop() -> bool {
        true
    }

    fn xml_escape(s: &str) -> String {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    }

    /// Loaded at each graphical login only (`Aqua`), never relaunched: quitting
    /// or hiding must stick until the next session.
    pub(super) fn entry(exe: &str) -> String {
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{}</string>
    <string>tray</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
"#,
            xml_escape(exe)
        )
    }

    pub fn ensure(scope: Scope, exe: &str) -> Result<()> {
        let path = path(scope).context("no home directory")?;
        write_if_changed(&path, &entry(exe))
    }

    pub fn installed(scope: Scope) -> bool {
        path(scope).is_some_and(|p| p.exists())
    }

    pub fn remove(scope: Scope) {
        if let Some(path) = path(scope) {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[cfg(windows)]
mod imp {
    use super::*;
    use crate::winreg::{self, Hive};

    const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const VALUE: &str = "DevEyeTray";

    fn hive(scope: Scope) -> Hive {
        match scope {
            Scope::System => Hive::LocalMachine,
            Scope::User => Hive::CurrentUser,
        }
    }

    pub fn has_desktop() -> bool {
        true
    }

    pub(super) fn entry(exe: &str) -> String {
        format!("\"{exe}\" tray run")
    }

    pub fn ensure(scope: Scope, exe: &str) -> Result<()> {
        let value = entry(exe);
        if winreg::get_string(hive(scope), RUN_KEY, VALUE).as_deref() == Some(value.as_str()) {
            return Ok(());
        }
        winreg::set_string(hive(scope), RUN_KEY, VALUE, &value)
            .with_context(|| format!("writing the {VALUE} autostart value"))
    }

    pub fn installed(scope: Scope) -> bool {
        winreg::get_string(hive(scope), RUN_KEY, VALUE).is_some()
    }

    pub fn remove(scope: Scope) {
        let _ = winreg::delete_value(hive(scope), RUN_KEY, VALUE);
    }
}

#[cfg(test)]
mod tests {
    use super::imp::entry;

    #[test]
    fn the_entry_runs_the_tray_from_this_exact_executable() {
        let text = entry("/opt/Dev Eye/deveye-agent");
        #[cfg(target_os = "linux")]
        {
            assert!(text.contains("Exec=\"/opt/Dev Eye/deveye-agent\" tray run\n"));
            assert!(text.contains("NoDisplay=true"));
        }
        #[cfg(target_os = "macos")]
        assert!(text.contains("<string>/opt/Dev Eye/deveye-agent</string>"));
        #[cfg(windows)]
        assert_eq!(text, "\"/opt/Dev Eye/deveye-agent\" tray run");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn desktop_entry_quoting_escapes_what_the_spec_reserves() {
        let text = entry("/home/a$b/x%y\"z");
        assert!(
            text.contains(r#"Exec="/home/a\$b/x%%y\"z" tray run"#),
            "{text}"
        );
    }
}
