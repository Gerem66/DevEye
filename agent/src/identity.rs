//! Stable machine identity: the fingerprint, the platform and the hostname.

/// The platform string sent to the server at enrollment. Must match one of the
/// values in `@deveye/types` `devicePlatformSchema`.
pub fn current_platform() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "macos"
    }
    #[cfg(target_os = "windows")]
    {
        "windows"
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        "linux"
    }
}

/// Derive a stable fingerprint for this machine.
///
/// - Linux: the systemd/D-Bus machine-id (stable across reboots, unique).
/// - macOS: the IOPlatformUUID from `ioreg`.
/// - Windows: the `MachineGuid` from the registry.
///
/// Falls back to the hostname when no stable id is available.
pub fn machine_fingerprint() -> String {
    #[cfg(target_os = "macos")]
    {
        if let Some(id) = macos_platform_uuid() {
            return id;
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(id) = windows_machine_guid() {
            return id;
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        for path in ["/etc/machine-id", "/var/lib/dbus/machine-id"] {
            if let Ok(id) = std::fs::read_to_string(path) {
                let id = id.trim();
                if !id.is_empty() {
                    return id.to_string();
                }
            }
        }
    }
    hostname()
}

/// Read the hardware IOPlatformUUID on macOS via `ioreg`.
#[cfg(target_os = "macos")]
fn macos_platform_uuid() -> Option<String> {
    let out = std::process::Command::new("ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    // Line looks like: `"IOPlatformUUID" = "XXXXXXXX-...."`
    for line in text.lines() {
        if let Some(idx) = line.find("IOPlatformUUID") {
            let rest = &line[idx..];
            if let Some(eq) = rest.find('=') {
                let val = rest[eq + 1..].trim().trim_matches('"').trim();
                if !val.is_empty() {
                    return Some(val.to_string());
                }
            }
        }
    }
    None
}

/// Read the stable `MachineGuid` on Windows via `reg query` (no extra crate).
#[cfg(target_os = "windows")]
fn windows_machine_guid() -> Option<String> {
    let out = std::process::Command::new("reg")
        .args([
            "query",
            r"HKLM\SOFTWARE\Microsoft\Cryptography",
            "/v",
            "MachineGuid",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    // Line looks like: `    MachineGuid    REG_SZ    XXXXXXXX-....`
    for line in text.lines() {
        if let Some(idx) = line.find("REG_SZ") {
            let val = line[idx + "REG_SZ".len()..].trim();
            if !val.is_empty() {
                return Some(val.to_string());
            }
        }
    }
    None
}

pub fn hostname() -> String {
    sysinfo::System::host_name().unwrap_or_else(|| "deveye-host".to_string())
}
