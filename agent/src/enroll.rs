//! Device enrollment over HTTP: exchange a link code for a token.

use std::fmt;
use std::time::Duration;

use anyhow::Context;

use crate::config::Config;
use crate::protocol::{ApiResult, EnrollData, EnrollRequest};

/// Why an enrollment failed, sorted by what a later attempt could change.
#[derive(Debug)]
pub enum EnrollError {
    /// Unknown, expired, spent or revoked code: no retry will pass.
    Invalid(String),
    /// The workspace already knows this machine and the code serves several
    /// machines: a clone of an enrolled one, most likely.
    Conflict(String),
    /// The plan has no room for one more device. The code stays valid.
    Quota(String),
    /// Too many attempts from this address; the delay the server gave, if any.
    RateLimited(Option<Duration>),
    /// Network, server error, unexpected answer: worth another try later.
    Transient(anyhow::Error),
}

impl fmt::Display for EnrollError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EnrollError::Invalid(msg) => write!(f, "enrollment refused ({msg})"),
            // The server writes these two for the person at the keyboard.
            EnrollError::Conflict(msg) | EnrollError::Quota(msg) => {
                write!(f, "enrollment refused: {msg}")
            }
            EnrollError::RateLimited(Some(delay)) => write!(
                f,
                "enrollment refused: too many attempts, retry in {} s",
                delay.as_secs().max(1)
            ),
            EnrollError::RateLimited(None) => {
                write!(f, "enrollment refused: too many attempts, retry later")
            }
            EnrollError::Transient(e) => write!(f, "enrollment failed: {e:#}"),
        }
    }
}

impl std::error::Error for EnrollError {}

/// Enroll this machine with the server using a link code.
///
/// On success, updates and persists `config` with the returned device id, token
/// and order-signing key, and returns the device's status: `active` for a
/// machine new to the workspace, `pending` when the workspace already knew it
/// (it then waits for approval). A success spends one use of the code; a
/// refusal spends none.
pub async fn enroll(config: &mut Config, code: &str) -> Result<String, EnrollError> {
    let url = format!("{}/api/agent/enroll", config.server.trim_end_matches('/'));
    let body = EnrollRequest {
        code: code.trim().to_uppercase(),
        name: config.name.clone(),
        fingerprint: config.fingerprint.clone(),
        platform: crate::identity::current_platform().to_string(),
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .context("building HTTP client")
        .map_err(EnrollError::Transient)?;

    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .with_context(|| format!("POST {url}"))
        .map_err(EnrollError::Transient)?;

    let status = resp.status();
    if status.as_u16() == 429 {
        let delay = resp
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<u64>().ok())
            .map(Duration::from_secs);
        return Err(EnrollError::RateLimited(delay));
    }

    // Read the body as text first so a non-enveloped error (e.g. a server 500 that
    // isn't the {ok,error} shape, or a proxy page) yields a clear message with the
    // HTTP status, instead of an opaque JSON-decoding error.
    let text = resp
        .text()
        .await
        .context("reading enrollment response")
        .map_err(EnrollError::Transient)?;
    let result: ApiResult<EnrollData> = serde_json::from_str(&text).map_err(|e| {
        let snippet: String = text.chars().take(200).collect();
        EnrollError::Transient(anyhow::anyhow!(
            "server returned HTTP {} ({e}): {snippet}",
            status.as_u16()
        ))
    })?;

    if !result.ok {
        let (code, message) = result
            .error
            .map(|e| (e.code, e.message))
            .unwrap_or_else(|| ("unknown".into(), "unknown error".into()));
        return Err(match code.as_str() {
            "quota_exceeded" => EnrollError::Quota(message),
            "conflict" => EnrollError::Conflict(message),
            _ if status.is_server_error() => {
                EnrollError::Transient(anyhow::anyhow!("{code}: {message}"))
            }
            _ => EnrollError::Invalid(format!("{code}: {message}")),
        });
    }

    let data = result
        .data
        .context("enrollment response missing data")
        .map_err(EnrollError::Transient)?;
    let device_status = data
        .device
        .as_ref()
        .map(|d| d.status.clone())
        .unwrap_or_default();
    config.device_id = Some(data.device_id);
    config.device_token = Some(data.device_token);
    config.order_key = Some(data.order_signing_key);
    config
        .save()
        .context("saving enrolled config")
        .map_err(EnrollError::Transient)?;
    Ok(device_status)
}
