//! Verification of the orders the server must sign.
//!
//! The agent executes what arrives on its socket. For the orders that run code,
//! write or delete files, or change the agent's privileges or its life
//! ([`SIGNED_COMMANDS`]), arriving is not enough: the frame must carry an Ed25519
//! signature by the key pinned at enrollment, over the command, a nonce, a
//! timestamp and the exact payload bytes. That defeats whoever holds the socket
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
use crate::protocol::{Envelope, SIGNED_COMMANDS};

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
    seen: HashSet<String>,
    /// Nonces by arrival, to forget them once their order could no longer pass.
    order: VecDeque<(i64, String)>,
}

impl OrderGuard {
    /// `order_key_b64` is the pinned key from the config; absent or unreadable,
    /// every signed order is refused (fail closed).
    pub fn new(order_key_b64: Option<&str>) -> Self {
        let key = order_key_b64.and_then(|b64| {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(b64.trim())
                .ok()?;
            let arr: [u8; 32] = bytes.as_slice().try_into().ok()?;
            VerifyingKey::from_bytes(&arr).ok()
        });
        Self {
            key,
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

        let mut message =
            format!("{}\n{}\n{}\n", env.command, sig.nonce, sig.issued_at).into_bytes();
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

/// Whether a server frame may be interpreted at all.
pub enum Admission {
    Allowed,
    /// Refused before execution. `payload` is kept so the reply can name the
    /// session or the operation the server is waiting on.
    Refused {
        command: String,
        payload: serde_json::Value,
        reason: String,
    },
}

/// The single gate every server frame passes before it is dispatched: the
/// signature for the orders that need one, then what this machine's operator
/// refuses whatever the server says, then the agent's own directory, which the
/// file explorer never writes to (its config is what holds the policy).
pub fn admit(text: &str, guard: &mut OrderGuard, policy: &Policy, now_ms: i64) -> Admission {
    // Not an envelope: the regular parser reports it as it always did.
    let Ok(env) = serde_json::from_str::<Envelope<'_>>(text) else {
        return Admission::Allowed;
    };
    let refuse = |reason: String| Admission::Refused {
        command: env.command.clone(),
        payload: serde_json::from_str(env.payload.get()).unwrap_or(serde_json::Value::Null),
        reason,
    };
    if let Err(why) = guard.check(&env, now_ms) {
        return refuse(why.to_string());
    }
    let payload: serde_json::Value =
        serde_json::from_str(env.payload.get()).unwrap_or(serde_json::Value::Null);
    let field = |name: &str| payload.get(name).and_then(|v| v.as_str());
    if let Some(reason) = policy.refusal(&env.command, field("action")) {
        return refuse(reason);
    }
    if matches!(env.command.as_str(), "files.mutate" | "files.upload") {
        let own = ["path", "dest"]
            .iter()
            .filter_map(|name| field(name))
            .any(|p| Config::is_own_path(Path::new(p)));
        if own {
            return refuse("refused: the agent's own directory is not writable remotely".into());
        }
    }
    Admission::Allowed
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    const NOW: i64 = 1_700_000_000_000;

    fn key() -> SigningKey {
        SigningKey::from_bytes(&[7u8; 32])
    }

    fn pinned() -> String {
        base64::engine::general_purpose::STANDARD.encode(key().verifying_key().to_bytes())
    }

    /// A frame as the server builds it: signature over the payload bytes as written.
    fn frame(command: &str, payload: &str, nonce: &str, issued_at: i64) -> String {
        let mut message = format!("{command}\n{nonce}\n{issued_at}\n").into_bytes();
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
        let mut guard = OrderGuard::new(Some(&pinned()));
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
    }

    #[test]
    fn replay_and_window() {
        let mut guard = OrderGuard::new(Some(&pinned()));
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
            let mut guard = OrderGuard::new(key);
            assert!(!guard.has_key());
            let order = frame("term.open", r#"{"sessionId":"s"}"#, "n1", NOW);
            assert_eq!(check(&mut guard, &order, NOW), Err(Refusal::NoPinnedKey));
        }
    }

    #[test]
    fn an_unsigned_high_impact_order_is_refused() {
        let mut guard = OrderGuard::new(Some(&pinned()));
        let bare = r#"{"command":"files.mutate","payload":{"opId":"o","op":"delete","path":"/x"}}"#;
        assert_eq!(check(&mut guard, bare, NOW), Err(Refusal::MissingSignature));
    }

    #[test]
    fn admission_applies_the_local_policy_after_the_signature() {
        let mut guard = OrderGuard::new(Some(&pinned()));
        let closed = Policy {
            allow_terminal: false,
            ..Policy::default()
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
            Admission::Allowed => panic!("a closed policy must refuse term.open"),
        }
        let again = frame(
            "term.open",
            r#"{"sessionId":"s9","cols":80,"rows":24}"#,
            "n2",
            NOW,
        );
        assert!(matches!(
            admit(&again, &mut guard, &Policy::default(), NOW),
            Admission::Allowed
        ));

        // Elevation is one action of `agent.service`; the others stay allowed.
        let no_elevate = Policy {
            allow_service_elevate: false,
            ..Policy::default()
        };
        let elevate = frame("agent.service", r#"{"action":"elevate"}"#, "n3", NOW);
        assert!(matches!(
            admit(&elevate, &mut guard, &no_elevate, NOW),
            Admission::Refused { .. }
        ));
        let install = frame("agent.service", r#"{"action":"install-user"}"#, "n4", NOW);
        assert!(matches!(
            admit(&install, &mut guard, &no_elevate, NOW),
            Admission::Allowed
        ));
    }

    #[test]
    fn ordinary_commands_need_no_signature_and_ignore_a_bogus_one() {
        let mut guard = OrderGuard::new(None);
        let bare = r#"{"command":"agent.collect","payload":{}}"#;
        assert_eq!(check(&mut guard, bare, NOW), Ok(()));
        let noisy = r#"{"command":"agent.collect","payload":{},"sig":{"nonce":"x","issuedAt":1,"signature":"zz"}}"#;
        assert_eq!(check(&mut guard, noisy, NOW), Ok(()));
    }
}
