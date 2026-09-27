//! Device enrollment over HTTP: exchange a one-time link code for a token.

use anyhow::{bail, Context, Result};

use crate::config::Config;
use crate::protocol::{ApiResult, EnrollData, EnrollRequest};

/// Enroll this machine with the server using a short-lived link code.
///
/// On success, updates and persists `config` with the returned device id, token
/// and order-signing key, and returns the device's status: `active` on a first
/// link, `pending` when the workspace already knew this machine (it then waits
/// for approval). The code is consumed server-side and cannot be reused; a
/// refusal by the plan leaves it valid.
pub async fn enroll(config: &mut Config, code: &str) -> Result<String> {
    let url = format!("{}/api/agent/enroll", config.server.trim_end_matches('/'));
    let body = EnrollRequest {
        code: code.trim().to_uppercase(),
        name: config.name.clone(),
        fingerprint: config.fingerprint.clone(),
        platform: crate::identity::current_platform().to_string(),
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .context("building HTTP client")?;

    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .with_context(|| format!("POST {url}"))?;

    // Read the body as text first so a non-enveloped error (e.g. a server 500 that
    // isn't the {ok,error} shape, or a proxy page) yields a clear message with the
    // HTTP status, instead of an opaque JSON-decoding error.
    let status = resp.status();
    let text = resp.text().await.context("reading enrollment response")?;
    let result: ApiResult<EnrollData> = serde_json::from_str(&text).map_err(|e| {
        let snippet: String = text.chars().take(200).collect();
        anyhow::anyhow!("server returned HTTP {} ({e}): {snippet}", status.as_u16())
    })?;

    if !result.ok {
        // The plan's refusal is written for the person at the keyboard.
        if let Some(e) = result.error.as_ref().filter(|e| e.code == "quota_exceeded") {
            bail!("enrollment refused: {}", e.message);
        }
        let msg = result
            .error
            .map(|e| format!("{}: {}", e.code, e.message))
            .unwrap_or_else(|| "unknown error".to_string());
        bail!("enrollment refused ({msg})");
    }

    let data = result.data.context("enrollment response missing data")?;
    let status = data
        .device
        .as_ref()
        .map(|d| d.status.clone())
        .unwrap_or_default();
    config.device_id = Some(data.device_id);
    config.device_token = Some(data.device_token);
    config.order_key = Some(data.order_signing_key);
    config.save().context("saving enrolled config")?;
    Ok(status)
}
