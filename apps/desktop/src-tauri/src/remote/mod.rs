//! Remote control from a paired phone, over Tailscale.
//!
//! Off until the user turns it on in Settings. When on, the bridge listens
//! on this Mac's Tailscale addresses only (and on loopback, for an emulator
//! through `adb reverse`), never on the LAN or the internet: Tailscale's
//! WireGuard tunnel is the transport, and a per-phone token, issued by
//! scanning a QR code on this Mac, is the key. What a phone may do is the
//! list in [`dispatch::ALLOWED`].

pub mod devices;
pub mod dispatch;
mod server;

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Listener, Manager, State};
use thingmaker_supervisor::DesktopError;
use tokio::sync::broadcast;

use crate::commands::CommandResult;
use devices::{Device, RemoteConfig};

pub const REMOTE_EVENT: &str = "thingmaker://remote";
/// How long a pairing QR stays good.
const PAIRING_MS: i64 = 10 * 60_000;
/// Wrong codes before a pairing is called off.
const PAIRING_ATTEMPTS: u32 = 5;
/// How often the bridge looks for a changed Tailscale address.
const ADDRESS_CHECK: Duration = Duration::from_secs(30);
/// The events a phone's screens listen to, as the desktop's do.
const FORWARDED: [&str; 2] = [crate::commands::delegation::JOB_EVENT, crate::commands::bigthing::BIGTHING_EVENT];

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or_default()
}

struct Pairing {
    code: String,
    expires_at: i64,
    attempts: u32,
}

struct Listening {
    addresses: Vec<SocketAddr>,
    tasks: Vec<tauri::async_runtime::JoinHandle<()>>,
}

pub struct RemoteState {
    data_dir: PathBuf,
    pub host_name: String,
    config: Mutex<RemoteConfig>,
    pairing: Mutex<Option<Pairing>>,
    listening: Mutex<Option<Listening>>,
    connections: Mutex<HashMap<String, usize>>,
    /// Event frames for every connected phone.
    pub events: broadcast::Sender<Arc<str>>,
    /// A revoked phone's id ("*" for all): its sockets close.
    pub revoked: broadcast::Sender<String>,
}

/// Is this a Tailscale address (100.64.0.0/10)?
pub fn is_tailscale(ip: &Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    a == 100 && (64..=127).contains(&b)
}

fn tailscale_addresses() -> Vec<Ipv4Addr> {
    let mut found: Vec<Ipv4Addr> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|interface| match interface.ip() {
            IpAddr::V4(ip) if is_tailscale(&ip) => Some(ip),
            _ => None,
        })
        .collect();
    found.sort();
    found.dedup();
    found
}

fn computer_name() -> String {
    std::process::Command::new("scutil")
        .args(["--get", "ComputerName"])
        .output()
        .ok()
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Mac".into())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
    id: String,
    name: String,
    paired_at: i64,
    last_seen: Option<i64>,
    connected: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingView {
    code: String,
    expires_at: i64,
    /// What the QR encodes, for a phone that types it in instead.
    payload: String,
    qr_svg: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    enabled: bool,
    port: u16,
    name: String,
    /// This Mac's Tailscale addresses; empty when Tailscale is not up.
    tailscale: Vec<String>,
    listening: Vec<String>,
    devices: Vec<DeviceView>,
    pairing: Option<PairingView>,
}

impl RemoteState {
    fn new(data_dir: PathBuf) -> Self {
        let (events, _) = broadcast::channel(256);
        let (revoked, _) = broadcast::channel(16);
        Self {
            config: Mutex::new(devices::load(&data_dir)),
            data_dir,
            host_name: computer_name(),
            pairing: Mutex::new(None),
            listening: Mutex::new(None),
            connections: Mutex::new(HashMap::new()),
            events,
            revoked,
        }
    }

    fn config(&self) -> RemoteConfig {
        self.config.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
    }

    fn update(&self, change: impl FnOnce(&mut RemoteConfig)) -> Result<RemoteConfig, DesktopError> {
        let mut config = self.config.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        change(&mut config);
        devices::save(&self.data_dir, &config).map_err(|error| DesktopError::io(format!("could not save the phone settings: {error}")))?;
        Ok(config.clone())
    }

    /// The device a `hello` token belongs to; notes when it was last seen.
    pub fn authenticate(&self, token: &str) -> Option<Device> {
        // Development builds only: a token from the environment, so an
        // emulator or a browser can be tried without pairing. Compiled out
        // of the app you install.
        #[cfg(debug_assertions)]
        if let Ok(dev) = std::env::var("THINGMAKER_REMOTE_DEV_TOKEN")
            && dev.len() >= 32
            && devices::same(token, &dev)
        {
            return Some(Device { id: "dev".into(), name: "Development".into(), token_hash: String::new(), paired_at: 0, last_seen: None });
        }
        let device = self.config().device_for(token).cloned()?;
        let id = device.id.clone();
        let _ = self.update(|config| {
            if let Some(entry) = config.devices.iter_mut().find(|entry| entry.id == id) {
                entry.last_seen = Some(now_ms());
            }
        });
        Some(device)
    }

    /// A pairing code for a token, once, while the QR is fresh.
    pub fn redeem(&self, code: &str, device_name: &str) -> Result<(Device, String), String> {
        {
            let mut pairing = self.pairing.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let Some(current) = pairing.as_mut() else { return Err("No pairing is open on the Mac. Open Settings → Phone and press Pair a phone.".into()) };
            if now_ms() > current.expires_at {
                *pairing = None;
                return Err("That code has expired. Show a new one on the Mac.".into());
            }
            if !devices::same(&current.code, &code.trim().to_ascii_uppercase()) {
                current.attempts += 1;
                if current.attempts >= PAIRING_ATTEMPTS {
                    *pairing = None;
                }
                return Err("That code is not the one on the Mac.".into());
            }
            *pairing = None;
        }
        let token = devices::new_secret();
        let name = device_name.trim().chars().take(60).collect::<String>();
        let device = Device {
            id: uuid::Uuid::new_v4().simple().to_string()[..12].to_string(),
            name: if name.is_empty() { "Phone".into() } else { name },
            token_hash: devices::hash(&token),
            paired_at: now_ms(),
            last_seen: None,
        };
        let added = device.clone();
        self.update(|config| config.devices.push(added)).map_err(|error| error.message)?;
        Ok((device, token))
    }

    pub fn connected(&self, app: &AppHandle, device: &str, on: bool) {
        {
            let mut connections = self.connections.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let count = connections.entry(device.to_string()).or_default();
            if on {
                *count += 1;
            } else {
                *count = count.saturating_sub(1);
            }
        }
        self.changed(app);
    }

    pub fn changed(&self, app: &AppHandle) {
        let _ = app.emit(REMOTE_EVENT, ());
    }

    fn status(&self) -> RemoteStatus {
        let config = self.config();
        let connections = self.connections.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
        let listening = self.listening.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).as_ref().map(|listening| listening.addresses.iter().map(ToString::to_string).collect()).unwrap_or_default();
        let pairing = self.pairing.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).as_ref().filter(|pairing| pairing.expires_at > now_ms()).map(|pairing| self.pairing_view(&config, pairing));
        RemoteStatus {
            enabled: config.enabled,
            port: config.port,
            name: self.host_name.clone(),
            tailscale: tailscale_addresses().iter().map(ToString::to_string).collect(),
            listening,
            devices: config
                .devices
                .iter()
                .map(|device| DeviceView { id: device.id.clone(), name: device.name.clone(), paired_at: device.paired_at, last_seen: device.last_seen, connected: connections.get(&device.id).copied().unwrap_or(0) > 0 })
                .collect(),
            pairing,
        }
    }

    fn pairing_view(&self, config: &RemoteConfig, pairing: &Pairing) -> PairingView {
        let hosts: Vec<String> = tailscale_addresses().iter().map(ToString::to_string).collect();
        let payload = serde_json::json!({ "v": 1, "name": self.host_name, "hosts": hosts, "port": config.port, "code": pairing.code }).to_string();
        let qr_svg = qrcode::QrCode::new(format!("thingmaker-pair:{payload}").as_bytes())
            .map(|code| code.render::<qrcode::render::svg::Color>().min_dimensions(220, 220).quiet_zone(true).build())
            .unwrap_or_default();
        PairingView { code: pairing.code.clone(), expires_at: pairing.expires_at, payload, qr_svg }
    }

    /// The addresses the bridge should be on right now.
    fn wanted(&self) -> Vec<SocketAddr> {
        let config = self.config();
        if !config.enabled {
            return Vec::new();
        }
        let mut addresses: Vec<SocketAddr> = tailscale_addresses().into_iter().map(|ip| SocketAddr::new(IpAddr::V4(ip), config.port)).collect();
        addresses.push(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), config.port));
        addresses
    }

    /// Listens where it should, closing listeners that no longer should be.
    fn apply(&self, app: &AppHandle) {
        let wanted = self.wanted();
        let mut listening = self.listening.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if listening.as_ref().map(|current| &current.addresses) == Some(&wanted) {
            return;
        }
        if let Some(previous) = listening.take() {
            for task in previous.tasks {
                task.abort();
            }
        }
        if wanted.is_empty() {
            drop(listening);
            self.changed(app);
            return;
        }
        let mut tasks = Vec::new();
        for address in &wanted {
            let app = app.clone();
            let address = *address;
            tasks.push(tauri::async_runtime::spawn(async move {
                match tokio::net::TcpListener::bind(address).await {
                    Ok(listener) => {
                        tracing::info!(%address, "phone bridge listening");
                        if let Err(error) = axum::serve(listener, server::router(app)).await {
                            tracing::warn!(%address, %error, "phone bridge stopped");
                        }
                    }
                    Err(error) => tracing::warn!(%address, %error, "phone bridge could not listen"),
                }
            }));
        }
        *listening = Some(Listening { addresses: wanted, tasks });
        drop(listening);
        self.changed(app);
    }
}

/// Sets the bridge up; called once from `setup`.
pub fn start(app: &AppHandle, data_dir: PathBuf) {
    let state = RemoteState::new(data_dir);
    app.manage(state);
    for name in FORWARDED {
        let handle = app.clone();
        app.listen_any(name, move |event| {
            let remote = handle.state::<RemoteState>();
            if remote.events.receiver_count() > 0 {
                let _ = remote.events.send(server::event_frame(name, event.payload()));
            }
        });
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            app.state::<RemoteState>().apply(&app);
            tokio::time::sleep(ADDRESS_CHECK).await;
        }
    });
}

#[tauri::command]
pub fn remote_status(remote: State<'_, RemoteState>) -> RemoteStatus {
    remote.status()
}

#[tauri::command]
pub fn remote_set_enabled(enabled: bool, app: AppHandle, remote: State<'_, RemoteState>) -> CommandResult<RemoteStatus> {
    remote.update(|config| config.enabled = enabled)?;
    if !enabled {
        *remote.pairing.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        let _ = remote.revoked.send("*".into());
    }
    remote.apply(&app);
    Ok(remote.status())
}

#[tauri::command]
pub fn remote_pair_start(app: AppHandle, remote: State<'_, RemoteState>) -> CommandResult<PairingView> {
    if !remote.config().enabled {
        return Err(DesktopError::not_ready("Turn on phone access first."));
    }
    let pairing = Pairing { code: devices::new_pairing_code(), expires_at: now_ms() + PAIRING_MS, attempts: 0 };
    let view = remote.pairing_view(&remote.config(), &pairing);
    *remote.pairing.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(pairing);
    remote.changed(&app);
    Ok(view)
}

#[tauri::command]
pub fn remote_pair_cancel(app: AppHandle, remote: State<'_, RemoteState>) {
    *remote.pairing.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    remote.changed(&app);
}

#[tauri::command]
pub fn remote_device_revoke(id: String, app: AppHandle, remote: State<'_, RemoteState>) -> CommandResult<RemoteStatus> {
    remote.update(|config| config.devices.retain(|device| device.id != id))?;
    let _ = remote.revoked.send(id);
    remote.changed(&app);
    Ok(remote.status())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_tailscale_range_counts() {
        assert!(is_tailscale(&Ipv4Addr::new(100, 101, 2, 3)));
        assert!(is_tailscale(&Ipv4Addr::new(100, 64, 0, 1)));
        assert!(!is_tailscale(&Ipv4Addr::new(100, 128, 0, 1)));
        assert!(!is_tailscale(&Ipv4Addr::new(192, 168, 1, 10)));
    }

    #[test]
    fn a_pairing_code_works_once_while_fresh_and_not_after_five_misses() {
        let dir = tempfile::tempdir().unwrap();
        let remote = RemoteState::new(dir.path().to_path_buf());
        assert!(remote.redeem("ANY", "Pixel").is_err(), "nothing to redeem");
        *remote.pairing.lock().unwrap() = Some(Pairing { code: "ABCDEFGHJK".into(), expires_at: now_ms() + 60_000, attempts: 0 });
        let (device, token) = remote.redeem("abcdefghjk", "Pixel 9").unwrap();
        assert_eq!(device.name, "Pixel 9");
        assert_eq!(remote.authenticate(&token).map(|found| found.id), Some(device.id));
        assert!(remote.redeem("ABCDEFGHJK", "Again").is_err(), "a code is good once");

        *remote.pairing.lock().unwrap() = Some(Pairing { code: "ABCDEFGHJK".into(), expires_at: now_ms() + 60_000, attempts: 0 });
        for _ in 0..PAIRING_ATTEMPTS {
            assert!(remote.redeem("WRONGWRONG", "Guess").is_err());
        }
        assert!(remote.redeem("ABCDEFGHJK", "Late").is_err(), "five misses call it off");

        *remote.pairing.lock().unwrap() = Some(Pairing { code: "ABCDEFGHJK".into(), expires_at: now_ms() - 1, attempts: 0 });
        assert!(remote.redeem("ABCDEFGHJK", "Stale").is_err(), "an expired code is refused");
    }
}
