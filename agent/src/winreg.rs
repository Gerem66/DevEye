//! Minimal string values in the Windows registry: the agent's published status
//! and the tray's `Run` entries. `HKLM\Software` is writable by administrators
//! only and readable by every user, the exact trust boundary a SYSTEM agent
//! needs to talk to a user-session tray.

use std::io;
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteKeyValueW, RegGetValueW, RegSetValueExW, HKEY,
    HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_SET_VALUE, REG_OPTION_NON_VOLATILE, REG_SZ,
    RRF_RT_REG_SZ,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hive {
    LocalMachine,
    CurrentUser,
}

impl Hive {
    fn key(self) -> HKEY {
        match self {
            Hive::LocalMachine => HKEY_LOCAL_MACHINE,
            Hive::CurrentUser => HKEY_CURRENT_USER,
        }
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn check(code: u32) -> io::Result<()> {
    if code == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(code as i32))
    }
}

/// Create `subkey` if needed and set its `name` value to `value` (`REG_SZ`).
pub fn set_string(hive: Hive, subkey: &str, name: &str, value: &str) -> io::Result<()> {
    let subkey = wide(subkey);
    let name = wide(name);
    let data = wide(value);
    let mut key: HKEY = null_mut();
    // SAFETY: every pointer is a live NUL-terminated buffer or null where allowed,
    // and the opened key is closed below on every path.
    unsafe {
        check(RegCreateKeyExW(
            hive.key(),
            subkey.as_ptr(),
            0,
            null(),
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            null(),
            &mut key,
            null_mut(),
        ))?;
        let result = check(RegSetValueExW(
            key,
            name.as_ptr(),
            0,
            REG_SZ,
            data.as_ptr().cast(),
            (data.len() * 2) as u32,
        ));
        RegCloseKey(key);
        result
    }
}

/// The `name` string value of `subkey`, or `None` when absent or unreadable.
pub fn get_string(hive: Hive, subkey: &str, name: &str) -> Option<String> {
    let subkey = wide(subkey);
    let name = wide(name);
    let mut len: u32 = 0;
    // SAFETY: a first call with a null buffer only reports the size in bytes; the
    // second writes at most `len` bytes into a buffer of that many bytes.
    unsafe {
        check(RegGetValueW(
            hive.key(),
            subkey.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_SZ,
            null_mut(),
            null_mut(),
            &mut len,
        ))
        .ok()?;
        let mut buf = vec![0u16; (len as usize).div_ceil(2)];
        check(RegGetValueW(
            hive.key(),
            subkey.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_SZ,
            null_mut(),
            buf.as_mut_ptr().cast(),
            &mut len,
        ))
        .ok()?;
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..end]))
    }
}

/// Remove the `name` value of `subkey`. Already absent is success.
pub fn delete_value(hive: Hive, subkey: &str, name: &str) -> io::Result<()> {
    let subkey = wide(subkey);
    let name = wide(name);
    // SAFETY: both arguments are live NUL-terminated buffers.
    let code = unsafe { RegDeleteKeyValueW(hive.key(), subkey.as_ptr(), name.as_ptr()) };
    if code == ERROR_FILE_NOT_FOUND {
        return Ok(());
    }
    check(code)
}
