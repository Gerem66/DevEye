//! What the tray shows for a published status: menu texts and the eye's look.
//! Pure, so every state is testable without a desktop.

use crate::live_status::{Conn, LiveStatus, Work};

use super::icon::Look;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    Fr,
    En,
}

/// What the eye does, before an animation frame is picked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mood {
    Idle,
    Busy,
    Off,
}

impl Mood {
    pub fn look(self, frame: usize) -> Look {
        match self {
            Mood::Idle => Look::Idle,
            Mood::Busy => Look::Busy(frame),
            Mood::Off => Look::Off,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrayView {
    pub status: String,
    pub activity: Option<String>,
    pub mood: Mood,
}

impl TrayView {
    #[cfg(any(windows, target_os = "macos"))]
    pub fn tooltip(&self) -> String {
        match &self.activity {
            Some(activity) => format!("DevEye\n{}\n{activity}", self.status),
            None => format!("DevEye\n{}", self.status),
        }
    }
}

/// The fixed menu entries.
pub struct Labels {
    pub open: &'static str,
    pub hide: &'static str,
    pub quit: &'static str,
}

pub fn labels(lang: Lang) -> Labels {
    match lang {
        Lang::Fr => Labels {
            open: "Ouvrir DevEye",
            hide: "Masquer l'icône",
            quit: "Quitter DevEye",
        },
        Lang::En => Labels {
            open: "Open DevEye",
            hide: "Hide icon",
            quit: "Quit DevEye",
        },
    }
}

/// The notice shown once the icon is hidden, since nothing on screen tells how
/// to get it back.
pub fn hidden_notice(lang: Lang) -> (&'static str, &'static str) {
    match lang {
        Lang::Fr => (
            "Icône DevEye masquée",
            "L'agent continue de tourner. Pour réafficher l'icône : deveye-agent tray show",
        ),
        Lang::En => (
            "DevEye icon hidden",
            "The agent keeps running. To show the icon again: deveye-agent tray show",
        ),
    }
}

/// `status` is the freshest live status, `None` when no agent runs.
pub fn view(status: Option<&LiveStatus>, now: u64, lang: Lang) -> TrayView {
    let fr = lang == Lang::Fr;
    let Some(status) = status else {
        return TrayView {
            status: pick(fr, "Agent arrêté", "Agent stopped"),
            activity: None,
            mood: Mood::Off,
        };
    };
    let (text, mood) = match status.conn {
        Conn::Connecting => (pick(fr, "Connexion en cours…", "Connecting…"), Mood::Busy),
        Conn::Connected => {
            let host = host_of(&status.server);
            let text = if fr {
                format!("Connecté à {host}")
            } else {
                format!("Connected to {host}")
            };
            let mood = if status.work.any() {
                Mood::Busy
            } else {
                Mood::Idle
            };
            (text, mood)
        }
        Conn::PendingApproval => (
            pick(
                fr,
                "En attente d'approbation dans DevEye",
                "Waiting for approval in DevEye",
            ),
            Mood::Off,
        ),
        Conn::Rejected => (
            pick(fr, "Refusé par le serveur", "Refused by the server"),
            Mood::Off,
        ),
        Conn::Offline { retry_at } => {
            let text = match retry_at.checked_sub(now).filter(|&s| s > 0) {
                Some(secs) if fr => format!("Hors ligne, nouvel essai dans {}", delay(secs)),
                Some(secs) => format!("Offline, retrying in {}", delay(secs)),
                None => pick(fr, "Hors ligne, nouvel essai…", "Offline, retrying…"),
            };
            (text, Mood::Off)
        }
    };
    TrayView {
        status: text,
        activity: activity(&status.work, fr),
        mood,
    }
}

fn pick(fr: bool, fr_text: &str, en_text: &str) -> String {
    if fr { fr_text } else { en_text }.to_string()
}

fn delay(secs: u64) -> String {
    if secs < 60 {
        format!("{secs} s")
    } else {
        format!("{} min", secs.div_ceil(60))
    }
}

fn activity(work: &Work, fr: bool) -> Option<String> {
    let mut parts = Vec::new();
    match (work.sync_transfers, fr) {
        (0, _) => {
            if work.sync_scans > 0 {
                parts.push(pick(
                    fr,
                    "CloudSync : analyse des dossiers",
                    "CloudSync: scanning folders",
                ));
            }
        }
        (1, true) => parts.push("CloudSync : 1 transfert en cours".into()),
        (n, true) => parts.push(format!("CloudSync : {n} transferts en cours")),
        (1, false) => parts.push("CloudSync: 1 transfer in progress".into()),
        (n, false) => parts.push(format!("CloudSync: {n} transfers in progress")),
    }
    if work.update > 0 {
        parts.push(pick(fr, "Mise à jour de l'agent", "Updating the agent"));
    }
    if work.deploy > 0 {
        parts.push(pick(fr, "Déploiement en cours", "Deployment in progress"));
    }
    if work.packages > 0 {
        parts.push(pick(fr, "Mise à jour des paquets", "Updating packages"));
    }
    (!parts.is_empty()).then(|| parts.join(" · "))
}

/// `app.deveye.fr` out of `https://app.deveye.fr/`.
fn host_of(server: &str) -> &str {
    let rest = server.split_once("://").map_or(server, |(_, rest)| rest);
    rest.split('/').next().unwrap_or(rest)
}

/// The session's language: French when the user's locale is French, English
/// otherwise.
pub fn detect_lang() -> Lang {
    if locale_is_french() {
        Lang::Fr
    } else {
        Lang::En
    }
}

#[cfg(target_os = "linux")]
fn locale_is_french() -> bool {
    ["LC_ALL", "LC_MESSAGES", "LANG"]
        .iter()
        .find_map(|k| std::env::var(k).ok().filter(|v| !v.is_empty()))
        .is_some_and(|v| v.starts_with("fr"))
}

/// A LaunchAgent gets no `LANG`: the language is a user default.
#[cfg(target_os = "macos")]
fn locale_is_french() -> bool {
    crate::report::run("defaults", &["read", "-g", "AppleLocale"])
        .is_some_and(|v| v.trim().starts_with("fr"))
}

#[cfg(windows)]
fn locale_is_french() -> bool {
    use windows_sys::Win32::Globalization::GetUserDefaultUILanguage;
    const LANG_FRENCH: u16 = 0x0c;
    // SAFETY: no arguments, no failure mode.
    let lang_id = unsafe { GetUserDefaultUILanguage() };
    lang_id & 0x3ff == LANG_FRENCH
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(conn: Conn, work: Work) -> LiveStatus {
        LiveStatus {
            version: "1".into(),
            pid: 1,
            exe: String::new(),
            server: "https://app.deveye.fr/".into(),
            privileged: false,
            updated_at: 100,
            conn,
            work,
        }
    }

    #[test]
    fn no_agent_is_stopped_and_grey() {
        let v = view(None, 100, Lang::Fr);
        assert_eq!(v.status, "Agent arrêté");
        assert_eq!(v.mood, Mood::Off);
    }

    #[test]
    fn connected_names_the_host_and_rests() {
        let s = status(Conn::Connected, Work::default());
        let v = view(Some(&s), 100, Lang::Fr);
        assert_eq!(v.status, "Connecté à app.deveye.fr");
        assert_eq!(v.activity, None);
        assert_eq!(v.mood, Mood::Idle);
        assert_eq!(
            view(Some(&s), 100, Lang::En).status,
            "Connected to app.deveye.fr"
        );
    }

    #[test]
    fn work_animates_and_is_spelled_out() {
        let work = Work {
            sync_transfers: 3,
            deploy: 1,
            ..Work::default()
        };
        let v = view(Some(&status(Conn::Connected, work)), 100, Lang::Fr);
        assert_eq!(v.mood, Mood::Busy);
        assert_eq!(
            v.activity.as_deref(),
            Some("CloudSync : 3 transferts en cours · Déploiement en cours")
        );
        let one = Work {
            sync_transfers: 1,
            sync_scans: 2,
            ..Work::default()
        };
        let v = view(Some(&status(Conn::Connected, one)), 100, Lang::En);
        assert_eq!(
            v.activity.as_deref(),
            Some("CloudSync: 1 transfer in progress")
        );
    }

    #[test]
    fn connecting_animates_and_the_rest_is_grey() {
        let v = view(
            Some(&status(Conn::Connecting, Work::default())),
            100,
            Lang::Fr,
        );
        assert_eq!(
            (v.status.as_str(), v.mood),
            ("Connexion en cours…", Mood::Busy)
        );
        for conn in [
            Conn::PendingApproval,
            Conn::Rejected,
            Conn::Offline { retry_at: 0 },
        ] {
            let v = view(Some(&status(conn, Work::default())), 100, Lang::Fr);
            assert_eq!(v.mood, Mood::Off, "{conn:?}");
        }
    }

    #[test]
    fn offline_counts_down_to_the_next_attempt() {
        let s = status(Conn::Offline { retry_at: 112 }, Work::default());
        assert_eq!(
            view(Some(&s), 100, Lang::Fr).status,
            "Hors ligne, nouvel essai dans 12 s"
        );
        assert_eq!(view(Some(&s), 112, Lang::En).status, "Offline, retrying…");
        let far = status(
            Conn::Offline {
                retry_at: 100 + 610,
            },
            Work::default(),
        );
        assert_eq!(
            view(Some(&far), 100, Lang::Fr).status,
            "Hors ligne, nouvel essai dans 11 min"
        );
    }

    #[test]
    fn the_host_is_cut_out_of_the_server_url() {
        assert_eq!(host_of("https://app.deveye.fr"), "app.deveye.fr");
        assert_eq!(host_of("http://localhost:3000/x"), "localhost:3000");
        assert_eq!(host_of("app.deveye.fr"), "app.deveye.fr");
    }
}
