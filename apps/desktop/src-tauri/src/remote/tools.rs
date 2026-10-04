//! The phone, as tools the agents have: whether a phone is there, and
//! putting an Android build on it — the same as Settings → Phone → Send an
//! app…, so a session asked to "install it on my phone" can, without a
//! cable or adb.
//!
//! Android always asks the person holding the phone to confirm an install;
//! `phone_install` waits for that and says how it went, so the agent can tell
//! the user to tap Install, or report the failure.

use std::path::PathBuf;
use std::time::Duration;

use serde_json::{Value, json};
use tauri::{AppHandle, Manager};
use thingmaker_supervisor::delegation::jobs::{BoxFuture, Caller, TeamExtension};
use thingmaker_supervisor::delegation::mcp::{error_result, text_result};

use super::{RemoteState, now_ms};

/// How long `phone_install` waits for the phone by default, and at most.
const DEFAULT_WAIT: u64 = 180;
const MAX_WAIT: u64 = 600;

pub struct PhoneTools {
    pub app: AppHandle,
}

fn schemas() -> Vec<Value> {
    vec![
        json!({
            "name": "phone_status",
            "title": "Is the phone there",
            "description": "Whether the user's Android phone is paired with ThingMaker and connected right now, so an app can be installed on it with phone_install. No cable or adb is involved: the phone reaches this Mac over Tailscale.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
            "annotations": { "readOnlyHint": true, "openWorldHint": false }
        }),
        json!({
            "name": "phone_install",
            "title": "Install an app on the phone",
            "description": "Installs an Android build (.apk) on the user's paired phone, as if they sent it themselves from ThingMaker: the phone downloads it over Tailscale, checks it, and Android asks the user to confirm on the phone. Use it whenever the user asks to put a build on their phone; no cable or adb is needed. Waits for the outcome and returns `installed`, `confirm` (Android is still asking: tell the user to tap Install), `cancelled`, `failed` with Android's reason, or `sent` (the phone has not fetched it yet).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "The .apk file, absolute or relative to the project." },
                    "phone": { "type": "string", "description": "Which phone, by name, when more than one is connected; otherwise every connected phone." },
                    "wait_seconds": { "type": "integer", "minimum": 0, "maximum": MAX_WAIT, "description": "How long to wait for the install to finish. Default 180." }
                },
                "required": ["path"],
                "additionalProperties": false
            },
            "annotations": { "readOnlyHint": false, "destructiveHint": false, "openWorldHint": true }
        }),
    ]
}

impl TeamExtension for PhoneTools {
    fn tools(&self, _caller: &Caller) -> Vec<Value> {
        schemas()
    }

    fn instructions(&self, _caller: &Caller) -> Option<String> {
        let remote = self.app.state::<RemoteState>();
        let config = remote.config();
        if !config.enabled || config.devices.is_empty() {
            return None;
        }
        let names: Vec<String> = config.devices.iter().map(|device| device.name.clone()).collect();
        Some(format!(
            "The user's Android phone ({}) is paired with ThingMaker: to put an Android build on it, call `phone_install` with the .apk's path — no cable or adb. Android asks the user to confirm on the phone.",
            names.join(", ")
        ))
    }

    fn call(&self, caller: &Caller, name: &str, arguments: &Value) -> Option<BoxFuture<Value>> {
        let app = self.app.clone();
        match name {
            "phone_status" => Some(Box::pin(async move { text_result(&status(&app), false) })),
            "phone_install" => {
                let root = caller.root().to_path_buf();
                let arguments = arguments.clone();
                Some(Box::pin(async move {
                    match install(&app, &root, &arguments).await {
                        Ok(value) => text_result(&value, false),
                        Err(message) => error_result(&message),
                    }
                }))
            }
            _ => None,
        }
    }
}

fn status(app: &AppHandle) -> Value {
    let remote = app.state::<RemoteState>();
    let config = remote.config();
    let connected = remote.connected_devices();
    let phones: Vec<Value> = config.devices.iter().map(|device| json!({ "name": device.name, "connected": connected.contains(&device.id) })).collect();
    let note = if !config.enabled {
        "Phone access is off. The user turns it on in ThingMaker → Settings → Phone."
    } else if config.devices.is_empty() {
        "No phone is paired. The user pairs one in ThingMaker → Settings → Phone."
    } else if connected.is_empty() {
        "A phone is paired but not connected: ask the user to open ThingMaker on the phone, with Tailscale on."
    } else {
        "Ready: phone_install puts an .apk on it."
    };
    json!({ "enabled": config.enabled, "phones": phones, "note": note })
}

async fn install(app: &AppHandle, root: &std::path::Path, arguments: &Value) -> Result<Value, String> {
    let remote = app.state::<RemoteState>();
    let path = arguments.get("path").and_then(Value::as_str).map(str::trim).filter(|path| !path.is_empty()).ok_or("phone_install needs the .apk's path")?;
    let path = if path.starts_with('/') { PathBuf::from(path) } else { root.join(path) };
    let config = remote.config();
    if !config.enabled {
        return Err("Phone access is off. Ask the user to turn it on in ThingMaker → Settings → Phone.".into());
    }
    let device = match arguments.get("phone").and_then(Value::as_str).map(str::trim).filter(|name| !name.is_empty()) {
        Some(wanted) => {
            let found = config.devices.iter().find(|device| device.name.eq_ignore_ascii_case(wanted) || device.id == wanted).ok_or_else(|| {
                format!("No paired phone is called {wanted:?}; paired: {}.", config.devices.iter().map(|device| device.name.as_str()).collect::<Vec<_>>().join(", "))
            })?;
            Some(found.id.clone())
        }
        None => None,
    };
    let offer = remote.send_apk(app, &path.to_string_lossy(), device).await.map_err(|error| error.message)?;

    let wait = arguments.get("wait_seconds").and_then(Value::as_u64).unwrap_or(DEFAULT_WAIT).min(MAX_WAIT);
    let deadline = now_ms() + (wait as i64) * 1000;
    let mut current = offer.clone();
    while now_ms() < deadline {
        tokio::time::sleep(Duration::from_millis(1000)).await;
        if let Some(latest) = remote.offer(&offer.id) {
            current = latest;
        }
        if matches!(current.state.as_str(), "installed" | "failed" | "cancelled") {
            break;
        }
    }
    let note = match current.state.as_str() {
        "installed" => "Installed on the phone.".to_string(),
        "failed" => format!("Android did not install it: {}", current.message.clone().unwrap_or_default()),
        "cancelled" => "The user cancelled the install on the phone.".to_string(),
        "confirm" => "Android is asking the user to confirm on the phone: tell them to tap Install (if Google Play Protect asks to scan, More details → Install without scanning). The first install also asks once to allow ThingMaker to install apps.".to_string(),
        "downloading" => "The phone is still downloading it.".to_string(),
        _ => "Sent, but the phone has not fetched it yet. It shows as a notification on the phone; ask the user to tap it.".to_string(),
    };
    Ok(json!({ "app": current.name, "size": current.size, "state": current.state, "note": note }))
}
