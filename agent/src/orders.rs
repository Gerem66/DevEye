//! Verification of the orders the server must sign.
//!
//! The agent executes what arrives on its socket. For the orders that run code,
//! write or delete files, or change the agent's privileges or its life
//! ([`SIGNED_COMMANDS`]), arriving is not enough: the frame must carry an Ed25519
//! signature by the key pinned at enrollment, over the command, this device's
//! id, a nonce, a timestamp and the exact payload bytes. That defeats whoever holds the socket
//! without holding the key (a TLS-terminating proxy, a stolen device token
//! replayed against a fake server). It does not defeat a server compromised with
//! its key: what this machine refuses whatever the server says is `[policy]`.

use std::collections::{HashSet, VecDeque};
use std::fmt;
use std::time::Duration;

use std::path::Path;

use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};

use crate::config::{Config, Policy};
use crate::protocol::{Envelope, ServerMessage, SIGNED_COMMANDS};

/// How far an order's `issuedAt` may be from this machine's clock, either way.
const ORDER_WINDOW: Duration = Duration::from_secs(5 * 60);
/// Nonces remembered at once. A large upload signs every chunk, so the window
/// can hold many; past this, orders are refused rather than the oldest nonce
/// forgotten (a forgotten nonce could be replayed).
const MAX_NONCES: usize = 200_000;

#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    NoPinnedKey,
    MissingSignature,
    BadSignature,
    Expired,
    Replayed,
    Flooded,
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Refusal::NoPinnedKey => {
                "order refused: no order-signing key pinned on this machine (re-link the agent)"
            }
            Refusal::MissingSignature => "order refused: it carries no signature",
            Refusal::BadSignature => "order refused: signature verification failed",
            Refusal::Expired => {
                "order refused: issuedAt is outside the 5-minute window (check this machine's clock)"
            }
            Refusal::Replayed => "order refused: this order was already received",
            Refusal::Flooded => "order refused: too many signed orders in the window",
        })
    }
}

/// Verifies signed orders and remembers their nonces. Lives across reconnects:
/// an order captured on one connection must not pass on the next.
pub struct OrderGuard {
    key: Option<VerifyingKey>,
    /// One key signs for every machine of a server: the order must name this one.
    device_id: String,
    seen: HashSet<String>,
    /// Nonces by arrival, to forget them once their order could no longer pass.
    order: VecDeque<(i64, String)>,
}

impl OrderGuard {
    /// `order_key_b64` is the pinned key from the config; absent or unreadable,
    /// every signed order is refused (fail closed).
    pub fn new(order_key_b64: Option<&str>, device_id: &str) -> Self {
        let key = order_key_b64.and_then(|b64| {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(b64.trim())
                .ok()?;
            let arr: [u8; 32] = bytes.as_slice().try_into().ok()?;
            VerifyingKey::from_bytes(&arr).ok()
        });
        Self {
            key,
            device_id: device_id.to_string(),
            seen: HashSet::new(),
            order: VecDeque::new(),
        }
    }

    pub fn has_key(&self) -> bool {
        self.key.is_some()
    }

    /// `Ok` when the frame may be executed: either its command needs no
    /// signature, or it carries a valid, fresh, never-seen one.
    pub fn check(&mut self, env: &Envelope<'_>, now_ms: i64) -> Result<(), Refusal> {
        if !SIGNED_COMMANDS.contains(&env.command.as_str()) {
            return Ok(());
        }
        let key = self.key.as_ref().ok_or(Refusal::NoPinnedKey)?;
        let sig = env.sig.as_ref().ok_or(Refusal::MissingSignature)?;

        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&sig.signature)
            .map_err(|_| Refusal::BadSignature)?;
        let arr: [u8; 64] = bytes
            .as_slice()
            .try_into()
            .map_err(|_| Refusal::BadSignature)?;
        let signature = Signature::from_bytes(&arr);

        let mut message = format!(
            "{}\n{}\n{}\n{}\n",
            env.command, self.device_id, sig.nonce, sig.issued_at
        )
        .into_bytes();
        message.extend_from_slice(env.payload.get().as_bytes());
        key.verify_strict(&message, &signature)
            .map_err(|_| Refusal::BadSignature)?;

        let window = ORDER_WINDOW.as_millis() as i64;
        if (now_ms - sig.issued_at).abs() > window {
            return Err(Refusal::Expired);
        }
        self.forget_before(now_ms - 2 * window);
        if self.seen.contains(&sig.nonce) {
            return Err(Refusal::Replayed);
        }
        if self.seen.len() >= MAX_NONCES {
            return Err(Refusal::Flooded);
        }
        self.seen.insert(sig.nonce.clone());
        self.order.push_back((sig.issued_at, sig.nonce.clone()));
        Ok(())
    }

    /// A nonce whose order is older than twice the window can no longer pass the
    /// freshness check, whatever this machine's clock does within the window.
    fn forget_before(&mut self, cutoff_ms: i64) {
        while let Some((issued_at, _)) = self.order.front() {
            if *issued_at >= cutoff_ms {
                break;
            }
            if let Some((_, nonce)) = self.order.pop_front() {
                self.seen.remove(&nonce);
            }
        }
    }
}

/// What becomes of a server frame at the single gate.
pub enum Admission {
    /// Admitted, parsed once: dispatch this message.
    Dispatch(ServerMessage),
    /// Not a frame this agent acts on (malformed, or an unknown command). The
    /// frame is read ONLY here, so a signed order can never slip past the gate
    /// by being rejected as an envelope yet accepted by a second, laxer parser.
    Ignore,
    /// Refused before execution. `payload` is kept so the reply can name the
    /// session or the operation the server is waiting on.
    Refused {
        command: String,
        payload: serde_json::Value,
        reason: String,
    },
}

/// The single gate every server frame passes, and the only place it is parsed:
/// the signature for the orders that need one, then what this machine's
/// operator refuses whatever the server says, then the agent's own directory,
/// which the file explorer neither reads nor writes (its config is what holds
/// the policy and the device token). A frame that is not a well-formed envelope is ignored, never run.
pub fn admit(text: &str, guard: &mut OrderGuard, policy: &Policy, now_ms: i64) -> Admission {
    admit_with(
        text,
        guard,
        policy,
        now_ms,
        crate::terminal::opens_root_shell,
    )
}

/// [`admit`], with the answer to "would this session's shell be root's?"
/// handed in: it depends on the account the agent itself runs as.
fn admit_with(
    text: &str,
    guard: &mut OrderGuard,
    policy: &Policy,
    now_ms: i64,
    opens_root_shell: impl Fn(Option<&str>) -> bool,
) -> Admission {
    let Ok(env) = serde_json::from_str::<Envelope<'_>>(text) else {
        return Admission::Ignore;
    };
    let payload: serde_json::Value =
        serde_json::from_str(env.payload.get()).unwrap_or(serde_json::Value::Null);
    let refuse = |reason: String| Admission::Refused {
        command: env.command.clone(),
        payload: payload.clone(),
        reason,
    };
    if let Err(why) = guard.check(&env, now_ms) {
        return refuse(why.to_string());
    }
    let field = |name: &str| payload.get(name).and_then(|v| v.as_str());
    if let Some(reason) = policy.refusal(&env.command, field("action")) {
        return refuse(reason);
    }
    // The policy first: resolving the account asks the system.
    if env.command == "term.open" {
        let refusal = policy
            .root_terminal_refusal()
            .filter(|_| opens_root_shell(field("user")));
        if let Some(reason) = refusal {
            return refuse(reason);
        }
    }
    if matches!(
        env.command.as_str(),
        "files.mutate" | "files.upload" | "files.download" | "files.archive"
    ) {
        let own = ["path", "dest"]
            .iter()
            .filter_map(|name| field(name))
            .any(|p| Config::is_own_path(Path::new(p)));
        if own {
            return refuse("refused: the agent's own directory is not reachable remotely".into());
        }
    }
    // Reading the folder would show the token the config holds: a content
    // search returns the line that matches. Its parents stay browsable, the
    // walks skip the folder (`files::search`, `files::analyze`).
    if matches!(
        env.command.as_str(),
        "files.list" | "files.analyze" | "files.search"
    ) && field("path").is_some_and(|p| Config::is_inside_own_dir(Path::new(p)))
    {
        return refuse("refused: the agent's own directory is not reachable remotely".into());
    }
    // Built from the command and payload already admitted, so the gate and the
    // dispatch can never see two different things.
    match serde_json::from_value::<ServerMessage>(
        serde_json::json!({ "command": env.command, "payload": payload }),
    ) {
        Ok(message) => Admission::Dispatch(message),
        Err(_) => Admission::Ignore,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::PolicyKey;
    use ed25519_dalek::{Signer, SigningKey};

    /// A machine whose operator allowed every kind of order.
    fn open() -> Policy {
        let mut policy = Policy::default();
        policy.allow(&[PolicyKey::All]);
        policy
    }

    const NOW: i64 = 1_700_000_000_000;
    const DEVICE: &str = "11111111-1111-4111-8111-111111111111";

    fn key() -> SigningKey {
        SigningKey::from_bytes(&[7u8; 32])
    }

    fn pinned() -> String {
        base64::engine::general_purpose::STANDARD.encode(key().verifying_key().to_bytes())
    }

    /// A frame as the server builds it: signature over the payload bytes as written.
    fn frame(command: &str, payload: &str, nonce: &str, issued_at: i64) -> String {
        frame_for(DEVICE, command, payload, nonce, issued_at)
    }

    fn frame_for(
        device: &str,
        command: &str,
        payload: &str,
        nonce: &str,
        issued_at: i64,
    ) -> String {
        let mut message = format!("{command}\n{device}\n{nonce}\n{issued_at}\n").into_bytes();
        message.extend_from_slice(payload.as_bytes());
        let signature =
            base64::engine::general_purpose::STANDARD.encode(key().sign(&message).to_bytes());
        format!(
            r#"{{"command":"{command}","payload":{payload},"sig":{{"nonce":"{nonce}","issuedAt":{issued_at},"signature":"{signature}"}}}}"#
        )
    }

    fn check(guard: &mut OrderGuard, text: &str, now: i64) -> Result<(), Refusal> {
        let env: Envelope<'_> = serde_json::from_str(text).unwrap();
        guard.check(&env, now)
    }

    #[test]
    fn a_signed_order_verifies_and_a_tampered_one_does_not() {
        let mut guard = OrderGuard::new(Some(&pinned()), DEVICE);
        let payload = r#"{"sessionId":"s1","cols":80,"rows":24}"#;
        let good = frame("term.open", payload, "n1", NOW);
        assert_eq!(check(&mut guard, &good, NOW), Ok(()));

        let tampered = frame("term.open", payload, "n2", NOW).replace("\"cols\":80", "\"cols\":81");
        assert_eq!(
            check(&mut guard, &tampered, NOW),
            Err(Refusal::BadSignature)
        );

        // Signed for one order, presented as another.
        let moved = frame("agent.power", r#"{"action":"lock"}"#, "n3", NOW).replace(
            "\"command\":\"agent.power\"",
            "\"command\":\"agent.destroy\"",
        );
        assert_eq!(check(&mut guard, &moved, NOW), Err(Refusal::BadSignature));

        // Signed for another machine of the same server: not for this one.
        let elsewhere = frame_for(
            "22222222-2222-4222-8222-222222222222",
            "term.open",
            payload,
            "n4",
            NOW,
        );
        assert_eq!(
            check(&mut guard, &elsewhere, NOW),
            Err(Refusal::BadSignature)
        );
    }

    #[test]
    fn replay_and_window() {
        let mut guard = OrderGuard::new(Some(&pinned()), DEVICE);
        let order = frame("agent.power", r#"{"action":"reboot"}"#, "n1", NOW);
        assert_eq!(check(&mut guard, &order, NOW), Ok(()));
        assert_eq!(
            check(&mut guard, &order, NOW + 1000),
            Err(Refusal::Replayed)
        );

        let stale = frame(
            "agent.power",
            r#"{"action":"reboot"}"#,
            "n2",
            NOW - 6 * 60_000,
        );
        assert_eq!(check(&mut guard, &stale, NOW), Err(Refusal::Expired));
        let future = frame(
            "agent.power",
            r#"{"action":"reboot"}"#,
            "n3",
            NOW + 6 * 60_000,
        );
        assert_eq!(check(&mut guard, &future, NOW), Err(Refusal::Expired));
    }

    #[test]
    fn without_a_pinned_key_signed_orders_fail_closed() {
        for key in [None, Some("not base64"), Some("AAAA")] {
            let mut guard = OrderGuard::new(key, DEVICE);
            assert!(!guard.has_key());
            let order = frame("term.open", r#"{"sessionId":"s"}"#, "n1", NOW);
            assert_eq!(check(&mut guard, &order, NOW), Err(Refusal::NoPinnedKey));
        }
    }

    #[test]
    fn an_unsigned_high_impact_order_is_refused() {
        let mut guard = OrderGuard::new(Some(&pinned()), DEVICE);
        let bare = r#"{"command":"files.mutate","payload":{"opId":"o","op":"delete","path":"/x"}}"#;
        assert_eq!(check(&mut guard, bare, NOW), Err(Refusal::MissingSignature));
    }

    #[test]
    fn admission_applies_the_local_policy_after_the_signature() {
        let mut guard = OrderGuard::new(Some(&pinned()), DEVICE);
        let closed = Policy {
            allow_terminal: false,
            ..open()
        };
        let order = frame(
            "term.open",
            r#"{"sessionId":"s9","cols":80,"rows":24}"#,
            "n1",
            NOW,
        );
        match admit(&order, &mut guard, &closed, NOW) {
            Admission::Refused {
                command,
                payload,
                reason,
            } => {
                assert_eq!(command, "term.open");
                assert_eq!(payload["sessionId"], "s9");
                assert!(reason.contains("allow_terminal"), "{reason}");
            }
            _ => panic!("a closed policy must refuse term.open"),
        }
        let again = frame(
            "term.open",
            r#"{"sessionId":"s9","cols":80,"rows":24}"#,
            "n2",
            NOW,
        );
        assert!(matches!(
            admit(&again, &mut guard, &open(), NOW),
            Admission::Dispatch(_)
        ));

        // Elevation is one action of `agent.service`; the others stay allowed.
        let no_elevate = Policy {
            allow_service_elevate: false,
            ..open()
        };
        let elevate = frame("agent.service", r#"{"action":"elevate"}"#, "n3", NOW);
        assert!(matches!(
            admit(&elevate, &mut guard, &no_elevate, NOW),
            Admission::Refused { .. }
        ));
        let install = frame("agent.service", r#"{"action":"autostart-on"}"#, "n4", NOW);
        assert!(matches!(
            admit(&install, &mut guard, &no_elevate, NOW),
            Admission::Dispatch(_)
        ));
    }

    #[test]
    fn a_machine_left_at_its_defaults_takes_no_order() {
        let mut guard = OrderGuard::new(Some(&pinned()), DEVICE);
        for (n, (command, payload)) in [
            ("term.open", r#"{"sessionId":"s","cols":80,"rows":24}"#),
            ("files.list", r#"{"opId":"o","path":"/srv"}"#),
            (
                "files.mutate",
                r#"{"opId":"o","op":"delete","path":"/srv/x"}"#,
            ),
            ("agent.power", r#"{"action":"reboot"}"#),
            ("agent.destroy", "{}"),
        ]
        .into_iter()
        .enumerate()
        {
            let order = frame(command, payload, &format!("n{n}"), NOW);
            assert!(
                matches!(
                    admit(&order, &mut guard, &Policy::default(), NOW),
                    Admission::Refused { .. }
                ),
                "{command} must be refused until the operator allows it"
            );
        }
        // Monitoring goes on: what the policy does not name is not an order.
        let collect = r#"{"command":"agent.collect","payload":{}}"#;
        assert!(matches!(
            admit(collect, &mut guard, &Policy::default(), NOW),
            Admission::Dispatch(_)
        ));
    }

    #[test]
    fn a_root_shell_is_refused_until_its_own_switch_allows_it() {
        let mut guard = OrderGuard::new(Some(&pinned()), DEVICE);
        // A privileged agent: only a named account that is not root avoids root.
        let root_unless_alice = |user: Option<&str>| user != Some("alice");
        let no_root = Policy {
            allow_terminal_root: false,
            ..open()
        };
        let unnamed = r#"{"sessionId":"s1","cols":80,"rows":24}"#;
        let as_root = r#"{"sessionId":"s2","cols":80,"rows":24,"user":"root"}"#;
        let as_alice = r#"{"sessionId":"s3","cols":80,"rows":24,"user":"alice"}"#;

        for (nonce, payload) in [("n1", unnamed), ("n2", as_root)] {
            let order = frame("term.open", payload, nonce, NOW);
            match admit_with(&order, &mut guard, &no_root, NOW, root_unless_alice) {
                Admission::Refused { reason, .. } => {
                    assert!(reason.contains("allow_terminal_root"), "{reason}")
                }
                _ => panic!("a root shell must be refused: {payload}"),
            }
        }
        let order = frame("term.open", as_alice, "n3", NOW);
        assert!(matches!(
            admit_with(&order, &mut guard, &no_root, NOW, root_unless_alice),
            Admission::Dispatch(_)
        ));
        let order = frame("term.open", unnamed, "n4", NOW);
        assert!(matches!(
            admit_with(&order, &mut guard, &open(), NOW, root_unless_alice),
            Admission::Dispatch(_)
        ));

        // The switch alone gives nothing: the terminal itself stays refused.
        let root_only = Policy {
            allow_terminal_root: true,
            ..Policy::default()
        };
        let order = frame("term.open", as_alice, "n5", NOW);
        match admit_with(&order, &mut guard, &root_only, NOW, root_unless_alice) {
            Admission::Refused { reason, .. } => {
                assert!(reason.contains("allow_terminal = false"), "{reason}")
            }
            _ => panic!("the terminal switch comes first"),
        }
    }

    #[test]
    fn a_docker_action_needs_the_signature_and_a_deploy_the_policy() {
        let mut guard = OrderGuard::new(Some(&pinned()), DEVICE);
        let payload =
            r#"{"opId":"o1","engine":"docker","action":"composeDeploy","target":"site/web"}"#;
        let unsigned = format!(r#"{{"command":"docker.action","payload":{payload}}}"#);
        assert_eq!(
            check(&mut guard, &unsigned, NOW),
            Err(Refusal::MissingSignature)
        );

        let no_deploy = Policy {
            allow_docker_deploy: false,
            ..open()
        };
        let deploy = frame("docker.action", payload, "n1", NOW);
        assert!(matches!(
            admit(&deploy, &mut guard, &no_deploy, NOW),
            Admission::Refused { .. }
        ));
        let restart = frame(
            "docker.action",
            r#"{"opId":"o2","engine":"docker","action":"restart","target":"abc"}"#,
            "n2",
            NOW,
        );
        assert!(matches!(
            admit(&restart, &mut guard, &no_deploy, NOW),
            Admission::Dispatch(_)
        ));
    }

    /// The gate parses a frame once and dispatches what it parsed: a signed
    /// order can no longer slip past it by being malformed as an envelope yet
    /// readable by a laxer parser.
    #[test]
    fn a_frame_the_gate_cannot_read_is_never_run() {
        let mut guard = OrderGuard::new(Some(&pinned()), DEVICE);
        let payload = r#"{"sessionId":"x","cols":80,"rows":24,"user":"root"}"#;
        for sig in [
            "0",
            "{}",
            r#"{"nonce":"n","issuedAt":1.5,"signature":"s"}"#,
            r#""x""#,
        ] {
            let frame = format!(r#"{{"command":"term.open","payload":{payload},"sig":{sig}}}"#);
            assert!(
                matches!(admit(&frame, &mut guard, &open(), NOW), Admission::Ignore),
                "sig {sig} must not be run"
            );
        }
        let extra = format!(r#"{{"command":"term.open","payload":{payload},"extra":1}}"#);
        assert!(matches!(
            admit(&extra, &mut guard, &open(), NOW),
            Admission::Ignore
        ));

        // The same order, properly signed, is the one that runs.
        let good = frame("term.open", payload, "n1", NOW);
        match admit(&good, &mut guard, &open(), NOW) {
            Admission::Dispatch(ServerMessage::TermOpen { session_id, .. }) => {
                assert_eq!(session_id, "x")
            }
            _ => panic!("a signed order dispatches as what it is"),
        }
    }

    #[test]
    fn reading_the_agent_directory_is_refused_like_writing_it() {
        let mut guard = OrderGuard::new(Some(&pinned()), DEVICE);
        let dir = Config::path()
            .parent()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let parent = Path::new(&dir)
            .parent()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        for (command, payload) in [
            (
                "files.download",
                format!(r#"{{"opId":"o","path":"{dir}/agent.toml"}}"#),
            ),
            (
                "files.archive",
                format!(
                    r#"{{"opId":"o","path":"{parent}","exclusions":[],"oneFileSystem":true,"window":4}}"#
                ),
            ),
            (
                "files.mutate",
                format!(r#"{{"opId":"o","op":"rename","path":"{parent}","dest":"/tmp/x"}}"#),
            ),
            ("files.list", format!(r#"{{"opId":"o","path":"{dir}"}}"#)),
            ("files.analyze", format!(r#"{{"opId":"o","path":"{dir}"}}"#)),
            (
                "files.search",
                format!(
                    r#"{{"opId":"o","path":"{dir}","filter":{{"field":"content","query":"token"}}}}"#
                ),
            ),
        ] {
            let order = frame(command, &payload, &format!("n-{command}"), NOW);
            assert!(
                matches!(
                    admit(&order, &mut guard, &open(), NOW),
                    Admission::Refused { .. }
                ),
                "{command} on the agent directory must be refused"
            );
        }
    }

    #[test]
    fn ordinary_commands_need_no_signature_and_ignore_a_bogus_one() {
        let mut guard = OrderGuard::new(None, DEVICE);
        let bare = r#"{"command":"agent.collect","payload":{}}"#;
        assert_eq!(check(&mut guard, bare, NOW), Ok(()));
        let noisy = r#"{"command":"agent.collect","payload":{},"sig":{"nonce":"x","issuedAt":1,"signature":"zz"}}"#;
        assert_eq!(check(&mut guard, noisy, NOW), Ok(()));
    }
}
