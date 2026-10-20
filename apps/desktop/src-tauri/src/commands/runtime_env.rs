//! Explicit runtime environment variables (SEC-11, F13).
//!
//! The launch profile drops ambient credentials on purpose. Some skills need
//! one anyway (the imagegen skill's CLI fallback reads `OPENAI_API_KEY`), so
//! the user can add named variables here. Values live in the OS keychain under
//! the app's own service name, are read only when a Kit helper or terminal is
//! launched, are never persisted in the metadata database, never logged, and
//! never sent back to the renderer. Only the names are listed.

use serde::Serialize;
use tauri::State;
use thingmaker_supervisor::DesktopError;

use super::{CommandResult, storage_error};
use crate::state::AppState;

const SERVICE: &str = "dev.thingmaker.desktop.runtime-env";
/// Where the values lived before the app was called ThingMaker; read once
/// and copied to `SERVICE`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const LEGACY_SERVICE: &str = "dev.claudex.desktop.runtime-env";
const NAMES_KEY: &str = "runtime_env_names";
const NAMES_SCOPE: &str = "runtime";
/// Credential Manager blobs are capped at 2560 bytes on Windows.
pub const MAX_VALUE_BYTES: usize = if cfg!(windows) { 2560 } else { 8 * 1024 };

fn valid_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    (1..=128).contains(&bytes.len())
        && bytes.first().is_some_and(|b| b.is_ascii_alphabetic() || *b == b'_')
        && bytes.iter().all(|b| b.is_ascii_alphanumeric() || *b == b'_')
}

fn names(state: &AppState) -> CommandResult<Vec<String>> {
    Ok(state
        .with_storage(|s| s.setting_get::<Vec<String>>(NAMES_KEY, NAMES_SCOPE))
        .map_err(storage_error)?
        .unwrap_or_default())
}

fn save_names(state: &AppState, list: &[String]) -> CommandResult<()> {
    state.with_storage(|s| s.setting_set(NAMES_KEY, NAMES_SCOPE, &list.to_vec())).map_err(storage_error)
}

#[cfg(target_os = "macos")]
mod store {
    use super::{LEGACY_SERVICE, SERVICE};
    use security_framework::passwords::{delete_generic_password, get_generic_password, set_generic_password};
    use thingmaker_supervisor::DesktopError;

    pub fn set(name: &str, value: &[u8]) -> Result<(), DesktopError> {
        set_generic_password(SERVICE, name, value).map_err(|e| DesktopError::io(format!("keychain refused the write: {e}")))
    }

    pub fn get(name: &str) -> Result<Option<Vec<u8>>, DesktopError> {
        match get_generic_password(SERVICE, name) {
            Ok(bytes) => Ok(Some(bytes)),
            // errSecItemNotFound: perhaps saved under the old name.
            Err(error) if error.code() == -25300 => match get_generic_password(LEGACY_SERVICE, name) {
                Ok(bytes) => {
                    let _ = set_generic_password(SERVICE, name, &bytes);
                    Ok(Some(bytes))
                }
                Err(_) => Ok(None),
            },
            Err(error) => Err(DesktopError::io(format!("keychain read failed: {e}", e = error))),
        }
    }

    pub fn delete(name: &str) -> Result<(), DesktopError> {
        match delete_generic_password(SERVICE, name) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == -25300 => Ok(()),
            Err(error) => Err(DesktopError::io(format!("keychain delete failed: {error}"))),
        }
    }

    pub const AVAILABLE: bool = true;
}

#[cfg(windows)]
mod store {
    use super::SERVICE;
    use thingmaker_supervisor::DesktopError;
    use windows_sys::Win32::{Foundation::ERROR_NOT_FOUND, Security::Credentials::*};

    fn target(name: &str) -> Vec<u16> {
        format!("{SERVICE}/{name}\0").encode_utf16().collect()
    }

    pub fn set(name: &str, value: &[u8]) -> Result<(), DesktopError> {
        let mut target = target(name);
        let mut user: Vec<u16> = "ThingMaker\0".encode_utf16().collect();
        // SAFETY: all buffers live for the call; Credential Manager copies
        // the blob. No secret is written to the app database or logs.
        unsafe {
            let mut credential: CREDENTIALW = std::mem::zeroed();
            credential.Type = CRED_TYPE_GENERIC;
            credential.TargetName = target.as_mut_ptr();
            credential.UserName = user.as_mut_ptr();
            credential.CredentialBlobSize = value.len() as u32;
            credential.CredentialBlob = value.as_ptr() as *mut u8;
            credential.Persist = CRED_PERSIST_LOCAL_MACHINE;
            if CredWriteW(&credential, 0) == 0 {
                return Err(DesktopError::io(format!("Credential Manager write failed: {}", std::io::Error::last_os_error())));
            }
        }
        Ok(())
    }

    pub fn get(name: &str) -> Result<Option<Vec<u8>>, DesktopError> {
        let target = target(name);
        let mut credential = std::ptr::null_mut();
        // SAFETY: CredRead allocates a valid CREDENTIALW on success; the blob
        // is copied before freeing the allocation with CredFree.
        unsafe {
            if CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) == 0 {
                let error = std::io::Error::last_os_error();
                return if error.raw_os_error() == Some(ERROR_NOT_FOUND as i32) { Ok(None) } else { Err(DesktopError::io(format!("Credential Manager read failed: {error}"))) };
            }
            let bytes = if (*credential).CredentialBlobSize == 0 {
                Vec::new()
            } else {
                std::slice::from_raw_parts((*credential).CredentialBlob, (*credential).CredentialBlobSize as usize).to_vec()
            };
            CredFree(credential as *const _);
            Ok(Some(bytes))
        }
    }

    pub fn delete(name: &str) -> Result<(), DesktopError> {
        let target = target(name);
        // SAFETY: target is a NUL-terminated UTF-16 buffer valid for the call.
        if unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) } == 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_NOT_FOUND as i32) {
                return Err(DesktopError::io(format!("Credential Manager delete failed: {error}")));
            }
        }
        Ok(())
    }

    pub const AVAILABLE: bool = true;
}

#[cfg(not(any(target_os = "macos", windows)))]
mod store {
    use thingmaker_supervisor::DesktopError;

    pub fn set(_name: &str, _value: &[u8]) -> Result<(), DesktopError> {
        Err(DesktopError::unsupported("secure runtime variables are only implemented on macOS in this release"))
    }
    pub fn get(_name: &str) -> Result<Option<Vec<u8>>, DesktopError> {
        Ok(None)
    }
    pub fn delete(_name: &str) -> Result<(), DesktopError> {
        Ok(())
    }
    pub const AVAILABLE: bool = false;
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEnvInfo {
    pub names: Vec<String>,
    pub available: bool,
    pub backend: &'static str,
}

#[tauri::command]
pub fn runtime_env_list(state: State<'_, AppState>) -> CommandResult<RuntimeEnvInfo> {
    Ok(RuntimeEnvInfo {
        names: names(&state)?,
        available: store::AVAILABLE,
        backend: if cfg!(windows) {
            "Windows Credential Manager"
        } else if store::AVAILABLE {
            "macOS Keychain"
        } else {
            "unavailable"
        },
    })
}

/// Validates and stores one variable in the keychain and the names list.
pub(crate) fn store_variable(state: &AppState, name: &str, value: &str) -> Result<(), DesktopError> {
    if !valid_name(name) {
        return Err(DesktopError::io("variable names use letters, digits and underscores and start with a letter or underscore"));
    }
    if value.is_empty() || value.len() > MAX_VALUE_BYTES {
        return Err(DesktopError::io(format!("value must be between 1 and {MAX_VALUE_BYTES} bytes")));
    }
    // Windows variable names are case-insensitive.
    let baseline = thingmaker_supervisor::security::env_profile::BASELINE_INHERITED.iter().any(|baseline| if cfg!(windows) { baseline.eq_ignore_ascii_case(name) } else { *baseline == name });
    if baseline || name.starts_with("KIT_") {
        return Err(DesktopError::io("this variable is already inherited by the launch profile"));
    }
    store::set(name, value.as_bytes())?;
    let mut list = names(state)?;
    if !list.iter().any(|n| n == name) {
        list.push(name.to_string());
        list.sort();
    }
    save_names(state, &list)
}

/// Stores a value in the keychain. The renderer sends it once; nothing echoes it back.
#[tauri::command]
pub fn runtime_env_set(name: String, value: String, state: State<'_, AppState>) -> CommandResult<Vec<String>> {
    store_variable(&state, &name, &value)?;
    names(&state)
}

#[tauri::command]
pub fn runtime_env_remove(name: String, state: State<'_, AppState>) -> CommandResult<Vec<String>> {
    if !valid_name(&name) {
        return Err(DesktopError::io("invalid variable name"));
    }
    store::delete(&name)?;
    let list: Vec<String> = names(&state)?.into_iter().filter(|n| *n != name).collect();
    save_names(&state, &list)?;
    Ok(list)
}

/// Resolves the stored variables for a launch. Missing keychain items are
/// skipped (and reported by name) rather than failing the launch.
pub fn resolve_for_launch(state: &AppState) -> (Vec<(String, String)>, Vec<String>) {
    let mut resolved = Vec::new();
    let mut missing = Vec::new();
    for name in names(state).unwrap_or_default() {
        match store::get(&name) {
            Ok(Some(bytes)) => match String::from_utf8(bytes) {
                Ok(value) => resolved.push((name, value)),
                Err(_) => missing.push(name),
            },
            _ => missing.push(name),
        }
    }
    (resolved, missing)
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;

    #[test]
    fn credential_manager_round_trip_and_delete() {
        let name = format!("THINGMAKER_TEST_{}", uuid::Uuid::new_v4().simple());
        let value = "temporary test value with accents: áñ".as_bytes();
        assert_eq!(store::get(&name).unwrap(), None);
        store::set(&name, value).unwrap();
        let result = store::get(&name).unwrap();
        store::delete(&name).unwrap();
        assert_eq!(result.as_deref(), Some(value));
        assert_eq!(store::get(&name).unwrap(), None);
        store::delete(&name).unwrap();
    }
}
