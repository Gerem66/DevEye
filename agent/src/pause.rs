//! The pause of the agent: a marker next to its config, which `deveye-agent
//! pause`, the tray icon and a server order all write, and which the running
//! loop reads every second. Paused, the agent keeps a control session with the
//! server (`runner::paused_session`) but monitors nothing and obeys nothing.
//! The marker outlives the process: a pause survives a restart of the agent and
//! of the machine, until `resume` or its deadline.

use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::config::{self, Config};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pause {
    /// Unix second the pause was asked.
    pub since: u64,
    /// Unix second it ends on its own; `None` until `resume`.
    pub until: Option<u64>,
}

impl Pause {
    pub fn active(&self, now: u64) -> bool {
        match self.until {
            Some(until) => until > now,
            None => true,
        }
    }

    /// Time left before the agent resumes on its own, `None` without a deadline.
    pub fn remaining(&self, now: u64) -> Option<Duration> {
        self.until
            .map(|until| Duration::from_secs(until.saturating_sub(now)))
    }
}

/// The marker as written, whether its deadline has passed or not.
pub fn read() -> Option<Pause> {
    let raw = std::fs::read_to_string(Config::pause_path()).ok()?;
    serde_json::from_str(&raw).ok()
}

/// The pause in force now, if any. A marker past its deadline is swept here, so
/// `status`, the icon and the loop agree.
pub fn current() -> Option<Pause> {
    let pause = read()?;
    if pause.active(crate::live_status::now_secs()) {
        Some(pause)
    } else {
        clear();
        None
    }
}

/// Pause from now, for `duration` or until `resume`.
pub fn set(duration: Option<Duration>) -> Result<Pause> {
    let now = crate::live_status::now_secs();
    let pause = Pause {
        since: now,
        until: duration.map(|d| now + d.as_secs()),
    };
    let path = Config::pause_path();
    let json = serde_json::to_string(&pause)?;
    config::write_private(&path, json.as_bytes())
        .with_context(|| format!("writing {}", path.display()))?;
    Ok(pause)
}

/// Remove the marker; `true` when there was one.
pub fn clear() -> bool {
    std::fs::remove_file(Config::pause_path()).is_ok()
}

/// `30m`, `1h`, `4h`, `24h`, `2d`, or seconds (`90s`).
pub fn parse_duration(text: &str) -> Result<Duration> {
    let text = text.trim();
    let split = text
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(text.len());
    let (number, unit) = text.split_at(split);
    let count: u64 = number
        .parse()
        .with_context(|| format!("invalid duration `{text}`: use 30m, 1h, 4h, 24h or 2d"))?;
    let secs = match unit.trim() {
        "s" => count,
        "m" | "min" => count * 60,
        "h" => count * 3600,
        "d" => count * 86_400,
        _ => bail!("invalid duration `{text}`: use 30m, 1h, 4h, 24h or 2d"),
    };
    if secs == 0 {
        bail!("a pause lasts at least one second");
    }
    Ok(Duration::from_secs(secs))
}

/// `2 d 3 h`, `4 h`, `30 min`, `45 s`.
pub fn describe(duration: Duration) -> String {
    let secs = duration.as_secs();
    if secs < 60 {
        return format!("{secs} s");
    }
    // Rounded up: a pause of three minutes reads "3 min" until its last minute.
    let mins = secs.div_ceil(60);
    let (days, hours, mins) = (mins / 1440, mins % 1440 / 60, mins % 60);
    match (days, hours, mins) {
        (0, 0, m) => format!("{m} min"),
        (0, h, 0) => format!("{h} h"),
        (0, h, m) => format!("{h} h {m} min"),
        (d, 0, _) => format!("{d} d"),
        (d, h, _) => format!("{d} d {h} h"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations_are_read_in_the_units_the_menu_offers() {
        assert_eq!(parse_duration("30m").unwrap(), Duration::from_secs(1800));
        assert_eq!(parse_duration("1h").unwrap(), Duration::from_secs(3600));
        assert_eq!(
            parse_duration(" 24h ").unwrap(),
            Duration::from_secs(86_400)
        );
        assert_eq!(parse_duration("2d").unwrap(), Duration::from_secs(172_800));
        assert_eq!(parse_duration("90s").unwrap(), Duration::from_secs(90));
        for bad in ["", "h", "1x", "0m", "-1h", "1.5h"] {
            assert!(parse_duration(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_pause_ends_at_its_deadline_or_never() {
        let timed = Pause {
            since: 100,
            until: Some(160),
        };
        assert!(timed.active(159));
        assert!(!timed.active(160));
        assert_eq!(timed.remaining(100), Some(Duration::from_secs(60)));
        assert_eq!(timed.remaining(200), Some(Duration::ZERO));
        let open = Pause {
            since: 100,
            until: None,
        };
        assert!(open.active(u64::MAX));
        assert_eq!(open.remaining(100), None);
    }

    #[test]
    fn the_marker_round_trips_through_json() {
        let pause = Pause {
            since: 1_000,
            until: None,
        };
        let json = serde_json::to_string(&pause).unwrap();
        assert_eq!(json, r#"{"since":1000,"until":null}"#);
        assert_eq!(serde_json::from_str::<Pause>(&json).unwrap(), pause);
    }

    #[test]
    fn remaining_time_is_spelled_in_the_largest_units() {
        assert_eq!(describe(Duration::from_secs(45)), "45 s");
        assert_eq!(describe(Duration::from_secs(176)), "3 min");
        assert_eq!(describe(Duration::from_secs(1800)), "30 min");
        assert_eq!(describe(Duration::from_secs(4 * 3600)), "4 h");
        assert_eq!(describe(Duration::from_secs(3600 + 120)), "1 h 2 min");
        assert_eq!(
            describe(Duration::from_secs(86_400 * 2 + 3 * 3600)),
            "2 d 3 h"
        );
    }
}
