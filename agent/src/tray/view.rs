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
    /// One line per running agent, each naming its server when several run.
    pub lines: Vec<String>,
    pub activity: Option<String>,
    pub mood: Mood,
    /// The "Open" entries: a label and the server it opens.
    pub opens: Vec<(String, String)>,
    /// An agent runs that is not paused: the "Pause" submenu applies.
    pub pausable: bool,
    /// An agent is paused: the "Resume" entry applies.
    pub resumable: bool,
}

impl TrayView {
    #[cfg(any(windows, target_os = "macos"))]
    pub fn tooltip(&self) -> String {
        let lines = self.lines.join("\n");
        match &self.activity {
            Some(activity) => format!("DevEye\n{lines}\n{activity}"),
            None => format!("DevEye\n{lines}"),
        }
    }
}

/// The fixed menu entries.
pub struct Labels {
    pub open: &'static str,
    pub pause: &'static str,
    /// The "Pause" submenu: a label and the pause length in seconds, `None`
    /// for a pause that waits for "Resume".
    pub durations: [(&'static str, Option<u64>); 4],
    pub resume: &'static str,
    pub hide: &'static str,
    pub quit: &'static str,
}

const HOUR: u64 = 3600;

pub fn labels(lang: Lang) -> Labels {
    match lang {
        Lang::Fr => Labels {
            open: "Ouvrir DevEye",
            pause: "Mettre en pause",
            durations: [
                ("1 heure", Some(HOUR)),
                ("4 heures", Some(4 * HOUR)),
                ("24 heures", Some(24 * HOUR)),
                ("Jusqu'à la reprise", None),
            ],
            resume: "Reprendre",
            hide: "Masquer l'icône",
            quit: "Quitter DevEye",
        },
        Lang::En => Labels {
            open: "Open DevEye",
            pause: "Pause",
            durations: [
                ("1 hour", Some(HOUR)),
                ("4 hours", Some(4 * HOUR)),
                ("24 hours", Some(24 * HOUR)),
                ("Until resumed", None),
            ],
            resume: "Resume",
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

/// `statuses` are the live ones, one per running agent (an instance each);
/// `last_server` is what "Open" opens once none runs. The eye shows the worst
/// of them: grey as soon as one is cut off, turning while one works.
pub fn view(statuses: &[LiveStatus], last_server: &str, now: u64, lang: Lang) -> TrayView {
    let fr = lang == Lang::Fr;
    let open = labels(lang).open;
    if statuses.is_empty() {
        return TrayView {
            lines: vec![pick(fr, "Agent arrêté", "Agent stopped")],
            activity: None,
            mood: Mood::Off,
            opens: vec![(open.to_string(), last_server.to_string())],
            pausable: false,
            resumable: false,
        };
    }
    let several = statuses.len() > 1;
    let mut lines = Vec::new();
    let mut moods = Vec::new();
    let mut opens = Vec::new();
    let mut work = Work::default();
    for status in statuses {
        let (text, mood) = state(status, now, fr);
        let host = host_of(&status.server);
        lines.push(match status.conn {
            Conn::Connected => text,
            _ if several => format!("{text} ({host})"),
            _ => text,
        });
        moods.push(mood);
        let label = match (several, fr) {
            (false, _) => open.to_string(),
            (true, true) => format!("Ouvrir {host}"),
            (true, false) => format!("Open {host}"),
        };
        opens.push((label, status.server.clone()));
        work.add(&status.work);
    }
    let mood = if moods.contains(&Mood::Off) {
        Mood::Off
    } else if moods.contains(&Mood::Busy) {
        Mood::Busy
    } else {
        Mood::Idle
    };
    let is_paused = |s: &LiveStatus| matches!(s.conn, Conn::Paused { .. });
    TrayView {
        lines,
        activity: activity(&work, fr),
        mood,
        opens,
        pausable: !statuses.iter().all(is_paused),
        resumable: statuses.iter().any(is_paused),
    }
}

/// One agent's line and mood.
fn state(status: &LiveStatus, now: u64, fr: bool) -> (String, Mood) {
    match status.conn {
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
        Conn::Paused { until } => {
            let text = match until.map(|u| u.saturating_sub(now)) {
                Some(secs) if fr => format!("En pause, reprise dans {}", delay(secs)),
                Some(secs) => format!("Paused, resuming in {}", delay(secs)),
                None => pick(fr, "En pause", "Paused"),
            };
            (text, Mood::Off)
        }
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

    const LAST: &str = "https://last.example";

    fn status(conn: Conn, work: Work) -> LiveStatus {
        LiveStatus {
            instance: None,
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
        let v = view(&[], LAST, 100, Lang::Fr);
        assert_eq!(v.lines, ["Agent arrêté"]);
        assert_eq!(v.mood, Mood::Off);
        assert_eq!(v.opens, [("Ouvrir DevEye".to_string(), LAST.to_string())]);
    }

    #[test]
    fn connected_names_the_host_and_rests() {
        let s = status(Conn::Connected, Work::default());
        let v = view(std::slice::from_ref(&s), LAST, 100, Lang::Fr);
        assert_eq!(v.lines, ["Connecté à app.deveye.fr"]);
        assert_eq!(v.activity, None);
        assert_eq!(v.mood, Mood::Idle);
        assert_eq!(v.opens[0].1, s.server);
        assert_eq!(
            view(&[s], LAST, 100, Lang::En).lines,
            ["Connected to app.deveye.fr"]
        );
    }

    #[test]
    fn work_animates_and_is_spelled_out() {
        let work = Work {
            sync_transfers: 3,
            deploy: 1,
            ..Work::default()
        };
        let v = view(&[status(Conn::Connected, work)], LAST, 100, Lang::Fr);
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
        let v = view(&[status(Conn::Connected, one)], LAST, 100, Lang::En);
        assert_eq!(
            v.activity.as_deref(),
            Some("CloudSync: 1 transfer in progress")
        );
    }

    #[test]
    fn connecting_animates_and_the_rest_is_grey() {
        let v = view(
            &[status(Conn::Connecting, Work::default())],
            LAST,
            100,
            Lang::Fr,
        );
        assert_eq!(
            (v.lines[0].as_str(), v.mood),
            ("Connexion en cours…", Mood::Busy)
        );
        for conn in [
            Conn::PendingApproval,
            Conn::Rejected,
            Conn::Offline { retry_at: 0 },
        ] {
            let v = view(&[status(conn, Work::default())], LAST, 100, Lang::Fr);
            assert_eq!(v.mood, Mood::Off, "{conn:?}");
        }
    }

    #[test]
    fn offline_counts_down_to_the_next_attempt() {
        let s = [status(Conn::Offline { retry_at: 112 }, Work::default())];
        assert_eq!(
            view(&s, LAST, 100, Lang::Fr).lines,
            ["Hors ligne, nouvel essai dans 12 s"]
        );
        assert_eq!(view(&s, LAST, 112, Lang::En).lines, ["Offline, retrying…"]);
        let far = status(
            Conn::Offline {
                retry_at: 100 + 610,
            },
            Work::default(),
        );
        assert_eq!(
            view(&[far], LAST, 100, Lang::Fr).lines,
            ["Hors ligne, nouvel essai dans 11 min"]
        );
    }

    #[test]
    fn several_agents_each_name_their_server_and_the_worst_shows() {
        let prod = status(
            Conn::Connected,
            Work {
                sync_transfers: 1,
                ..Work::default()
            },
        );
        let nas = LiveStatus {
            instance: Some("nas".into()),
            server: "https://nas.lan".into(),
            work: Work {
                sync_transfers: 2,
                ..Work::default()
            },
            ..status(Conn::Offline { retry_at: 0 }, Work::default())
        };
        let v = view(&[prod.clone(), nas.clone()], LAST, 100, Lang::Fr);
        assert_eq!(
            v.lines,
            [
                "Connecté à app.deveye.fr",
                "Hors ligne, nouvel essai… (nas.lan)"
            ]
        );
        assert_eq!(v.mood, Mood::Off, "one cut off greys the eye");
        assert_eq!(
            v.activity.as_deref(),
            Some("CloudSync : 3 transferts en cours")
        );
        assert_eq!(
            v.opens,
            [
                ("Ouvrir app.deveye.fr".to_string(), prod.server.clone()),
                ("Ouvrir nas.lan".to_string(), nas.server.clone()),
            ]
        );
        let both_up = LiveStatus {
            conn: Conn::Connected,
            ..nas
        };
        assert_eq!(view(&[prod, both_up], LAST, 100, Lang::En).mood, Mood::Busy);
    }

    #[test]
    fn a_paused_agent_counts_down_and_offers_resume() {
        let open = status(Conn::Paused { until: None }, Work::default());
        let v = view(std::slice::from_ref(&open), LAST, 100, Lang::Fr);
        assert_eq!(v.lines, ["En pause"]);
        assert_eq!(v.mood, Mood::Off);
        assert!(v.resumable && !v.pausable, "paused alone: resume only");
        let timed = status(
            Conn::Paused {
                until: Some(100 + 3600),
            },
            Work::default(),
        );
        assert_eq!(
            view(std::slice::from_ref(&timed), LAST, 100, Lang::En).lines,
            ["Paused, resuming in 60 min"]
        );
        let working = status(Conn::Connected, Work::default());
        let v = view(&[working.clone(), open], LAST, 100, Lang::Fr);
        assert!(v.pausable && v.resumable, "mixed: both entries");
        let v = view(&[working], LAST, 100, Lang::Fr);
        assert!(v.pausable && !v.resumable, "in service: pause only");
    }

    #[test]
    fn the_host_is_cut_out_of_the_server_url() {
        assert_eq!(host_of("https://app.deveye.fr"), "app.deveye.fr");
        assert_eq!(host_of("http://localhost:3000/x"), "localhost:3000");
        assert_eq!(host_of("app.deveye.fr"), "app.deveye.fr");
    }
}
