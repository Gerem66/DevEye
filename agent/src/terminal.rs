//! Interactive remote terminals: spawn a PTY running the agent user's shell per
//! session and bridge it to the server's WebSocket.
//!
//! Each session pairs two OS threads with the async session loop:
//! - a **reader** thread pumps PTY output into a tokio channel (`TermEvent`),
//! - a **writer** thread drains keystrokes from a std channel into the PTY.
//!
//! `TermManager` is owned by the session loop (single task), so its map needs no
//! locking. Sessions are killed on explicit close, on shell exit (reader EOF), and
//! on drop (socket close), so a disconnect never leaves an orphan shell.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::mpsc as std_mpsc;

use anyhow::{bail, Context, Result};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tokio::sync::mpsc::Sender;

/// Output / lifecycle events a session streams back to the loop (which stamps the
/// device id and base64-encodes the bytes before sending them on the wire).
pub enum TermEvent {
    Output {
        session_id: String,
        data: Vec<u8>,
    },
    Exit {
        session_id: String,
        code: Option<i32>,
        error: Option<String>,
    },
}

struct Session {
    /// Keystrokes go here; the writer thread drains it into the PTY. Dropping it
    /// (on close/manager-drop) ends that thread.
    input: std_mpsc::Sender<Vec<u8>>,
    /// Kept for resize.
    master: Box<dyn MasterPty + Send>,
    /// Kept to kill the shell on close.
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

/// Owns the live terminal sessions for one agent connection.
pub struct TermManager {
    sessions: HashMap<String, Session>,
    tx: Sender<TermEvent>,
}

impl TermManager {
    pub fn new(tx: Sender<TermEvent>) -> Self {
        Self {
            sessions: HashMap::new(),
            tx,
        }
    }

    /// Spawn a PTY + shell for `session_id` and start pumping I/O. A duplicate id is
    /// a no-op (the existing session stays). `user`, when set, runs the shell under
    /// that account (`su -l`).
    pub fn open(
        &mut self,
        session_id: String,
        cols: u16,
        rows: u16,
        user: Option<String>,
    ) -> Result<()> {
        if self.sessions.contains_key(&session_id) {
            return Ok(());
        }
        if requested(user.as_deref()).is_some_and(|name| !is_account_name(name)) {
            bail!("invalid account name");
        }
        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("ouverture du PTY")?;
        let child = pair
            .slave
            .spawn_command(build_shell(user.as_deref()))
            .context("lancement du shell")?;
        // The child owns the slave now; drop our handle so the reader sees EOF when
        // the shell exits.
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().context("lecteur PTY")?;
        let mut writer = pair.master.take_writer().context("écrivain PTY")?;

        // Reader thread → async loop (back-pressured by the bounded channel).
        let tx = self.tx.clone();
        let id_out = session_id.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let ev = TermEvent::Output {
                            session_id: id_out.clone(),
                            data: buf[..n].to_vec(),
                        };
                        if tx.blocking_send(ev).is_err() {
                            break;
                        }
                    }
                }
            }
            let _ = tx.blocking_send(TermEvent::Exit {
                session_id: id_out,
                code: None,
                error: None,
            });
        });

        let (in_tx, in_rx) = std_mpsc::channel::<Vec<u8>>();
        std::thread::spawn(move || {
            while let Ok(data) = in_rx.recv() {
                if writer.write_all(&data).is_err() {
                    break;
                }
                let _ = writer.flush();
            }
        });

        self.sessions.insert(
            session_id,
            Session {
                input: in_tx,
                master: pair.master,
                child,
            },
        );
        Ok(())
    }

    /// Forward raw input bytes to a session's PTY (no-op for an unknown session).
    pub fn input(&self, session_id: &str, data: Vec<u8>) {
        if let Some(s) = self.sessions.get(session_id) {
            let _ = s.input.send(data);
        }
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) {
        if let Some(s) = self.sessions.get(session_id) {
            let _ = s.master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            });
        }
    }

    /// Kill and forget a session. Dropping it ends the writer thread; killing the
    /// child makes the reader hit EOF and end too.
    pub fn close(&mut self, session_id: &str) {
        if let Some(mut s) = self.sessions.remove(session_id) {
            let _ = s.child.kill();
        }
    }
}

impl Drop for TermManager {
    fn drop(&mut self) {
        for (_, mut s) in self.sessions.drain() {
            let _ = s.child.kill();
        }
    }
}

/// The account a session names, when it names one.
fn requested(user: Option<&str>) -> Option<&str> {
    user.map(str::trim).filter(|u| !u.is_empty())
}

/// A name `su` reads as an account, never as one of its options.
fn is_account_name(name: &str) -> bool {
    !name.starts_with('-')
}

/// Would a shell opened for `user` be root's (an elevated one on Windows)?
/// Only a privileged agent hands one out: `su` asks any other for a password.
pub fn opens_root_shell(user: Option<&str>) -> bool {
    crate::config::privileged() && runs_as_root(user, account_uid)
}

/// Whether a privileged agent's shell for `user` runs as root: no account
/// named, or one of uid 0. An account that does not resolve counts as root,
/// since `su` falls back to it when it is given none.
#[cfg(unix)]
fn runs_as_root(user: Option<&str>, uid_of: impl Fn(&str) -> Option<u32>) -> bool {
    match requested(user) {
        None => true,
        Some(name) => !is_account_name(name) || uid_of(name).unwrap_or(0) == 0,
    }
}

/// Windows has no `su`: the shell is always the agent's own.
#[cfg(windows)]
fn runs_as_root(_user: Option<&str>, _uid_of: impl Fn(&str) -> Option<u32>) -> bool {
    true
}

/// The uid behind an account name, asked of `id`, which resolves it the way
/// `su` will (directory accounts included).
fn account_uid(name: &str) -> Option<u32> {
    crate::report::run("id", &["-u", name])?.trim().parse().ok()
}

/// The shell to run, with a sane terminal env and the agent user's home as cwd.
/// `user` (Unix only), when set to a *different* account, switches to it with
/// `su -l`: a login shell, so that user's rc files (oh-my-zsh, etc.) load. As
/// root this is seamless; otherwise `su` simply prompts for the password in the PTY.
fn build_shell(user: Option<&str>) -> CommandBuilder {
    #[cfg(windows)]
    let mut cmd = {
        let _ = user; // Windows has no `su`; always the agent's own shell.
        CommandBuilder::new(std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string()))
    };
    #[cfg(unix)]
    let mut cmd = {
        let me = crate::report::current_user();
        let switch = requested(user).filter(|u| *u != me.as_str());
        match switch {
            Some(u) => {
                let mut c = CommandBuilder::new("su");
                c.arg("-l");
                c.arg(u);
                c
            }
            None => CommandBuilder::new(
                std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string()),
            ),
        }
    };
    cmd.env("TERM", "xterm-256color");
    if let Some(home) = dirs::home_dir() {
        cmd.cwd(home);
    }
    cmd
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn uid_of(name: &str) -> Option<u32> {
        match name {
            "root" | "toor" => Some(0),
            "alice" => Some(1000),
            _ => None,
        }
    }

    #[test]
    fn only_a_named_account_that_is_not_root_keeps_a_privileged_shell_out_of_root() {
        assert!(runs_as_root(None, uid_of));
        assert!(runs_as_root(Some("  "), uid_of));
        assert!(runs_as_root(Some("root"), uid_of));
        assert!(
            runs_as_root(Some("toor"), uid_of),
            "uid 0 under another name"
        );
        assert!(!runs_as_root(Some("alice"), uid_of));
        assert!(!runs_as_root(Some(" alice "), uid_of));
        assert!(runs_as_root(Some("nobody-here"), uid_of), "unresolved");
    }

    #[test]
    fn the_system_tells_root_from_an_account_it_does_not_know() {
        assert_eq!(account_uid("root"), Some(0));
        assert_eq!(account_uid("deveye-no-such-account"), None);
    }

    #[test]
    fn a_name_su_would_read_as_an_option_is_never_an_account() {
        for name in ["-", "-l", "--help", "-s/bin/sh"] {
            assert!(!is_account_name(name), "{name}");
            // Even if something resolved it, `su` would get no account: root.
            assert!(runs_as_root(Some(name), |_| Some(1000)), "{name}");
        }
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        let mut terminals = TermManager::new(tx);
        let refused = terminals.open("s".into(), 80, 24, Some("-l".into()));
        assert!(refused.unwrap_err().to_string().contains("account name"));
    }
}
