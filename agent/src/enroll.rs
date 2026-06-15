//! Device enrollment over HTTP: exchange a one-time link code for a token.

use anyhow::{bail, Context, Result};

use crate::config::Config;
use crate::protocol::{ApiResult, EnrollData, EnrollRequest};

/// Enroll this machine with the server using a short-lived link code.
///
/// On success, updates and persists `config` with the returned device id and
/// token. The code is consumed server-side and cannot be reused.
pub async fn enroll(config: &mut Config, code: &str) -> Result<()> {
    let url = format!("{}/api/agent/enroll", config.server.trim_end_matches('/'));
    let body = EnrollRequest {
        code: code.trim().to_uppercase(),
        name: config.name.clone(),
        fingerprint: config.fingerprint.clone(),
        platform: "linux".to_string(),
        public_key: config.public_key.clone(),
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

    let result: ApiResult<EnrollData> = resp.json().await.context("decoding enrollment response")?;

    if !result.ok {
        let msg = result
            .error
            .map(|e| format!("{}: {}", e.code, e.message))
            .unwrap_or_else(|| "unknown error".to_string());
        bail!("enrollment refused ({msg})");
    }

    let data = result.data.context("enrollment response missing data")?;
    config.device_id = Some(data.device_id);
    config.device_token = Some(data.device_token);
    config.save().context("saving enrolled config")?;
    Ok(())
}
