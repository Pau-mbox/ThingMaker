//! Installing an Android app on a paired phone without a cable.
//!
//! The Mac offers an `.apk`: the phone hears an `install` frame, downloads the
//! file from `/v1/apk/{id}` with its own token, checks its SHA-256, and hands
//! it to Android's installer — which asks the person holding the phone to
//! confirm, as it does for any app not from a store. The phone reports back
//! how it went. An offer lasts half an hour.
//!
//! On the Mac's own Wi-Fi the phone fetches it nearby instead (see `lan`),
//! with a key that opens this one offer and nothing else.

use std::path::{Path, PathBuf};

use axum::body::Body;
use axum::extract::{Path as UrlPath, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use thingmaker_supervisor::DesktopError;

use super::{RemoteState, now_ms};

/// How long a phone has to fetch an offered APK.
pub const OFFER_MS: i64 = 30 * 60_000;
/// Larger than any app a phone would take.
const MAX_BYTES: u64 = 4 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApkOffer {
    pub id: String,
    pub name: String,
    #[serde(skip)]
    pub path: PathBuf,
    pub size: u64,
    pub sha256: String,
    /// The phone it is for; `None` for every connected phone.
    pub device: Option<String>,
    pub offered_at: i64,
    pub expires_at: i64,
    /// What the phone last said: sent, downloading, confirm, installed, failed.
    pub state: String,
    pub message: Option<String>,
    /// Opens this offer, and only it, on the local network.
    #[serde(skip)]
    pub nearby_key: String,
    /// Where the phone can fetch it on the Mac's network, and the
    /// certificate it is served with; empty when there is no such road.
    #[serde(skip)]
    pub nearby: Option<(String, String)>,
}

fn sha256_of(path: &Path) -> std::io::Result<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Checks the file and measures it, off the async runtime.
pub async fn prepare(path: &str, device: Option<String>) -> Result<ApkOffer, DesktopError> {
    let path = PathBuf::from(path);
    if path.extension().and_then(|ext| ext.to_str()).map(|ext| ext.eq_ignore_ascii_case("apk")) != Some(true) {
        return Err(DesktopError::unsupported("Only an Android app (.apk) can be sent to the phone."));
    }
    let metadata = std::fs::metadata(&path).map_err(|error| DesktopError::io(format!("{}: {error}", path.display())))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_BYTES {
        return Err(DesktopError::unsupported(format!("{} is not an app the phone can install.", path.display())));
    }
    let hashed = path.clone();
    let sha256 = tauri::async_runtime::spawn_blocking(move || sha256_of(&hashed))
        .await
        .map_err(|error| DesktopError::io(error.to_string()))?
        .map_err(|error| DesktopError::io(format!("could not read {}: {error}", path.display())))?;
    let now = now_ms();
    Ok(ApkOffer {
        id: uuid::Uuid::new_v4().simple().to_string()[..16].to_string(),
        name: path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_else(|| "app.apk".into()),
        size: metadata.len(),
        path,
        sha256,
        device,
        offered_at: now,
        expires_at: now + OFFER_MS,
        state: "sent".into(),
        message: None,
        nearby_key: format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple()),
        nearby: None,
    })
}

/// What a phone is told about an offer.
pub fn frame(offer: &ApkOffer, from: &str) -> String {
    let mut frame = json!({ "t": "install", "id": offer.id, "name": offer.name, "size": offer.size, "sha256": offer.sha256, "from": from });
    if let Some((url, cert)) = &offer.nearby {
        frame["nearby"] = json!({ "url": url, "key": offer.nearby_key, "cert": cert });
    }
    frame.to_string()
}

fn bearer(headers: &HeaderMap) -> &str {
    headers.get(header::AUTHORIZATION).and_then(|value| value.to_str().ok()).and_then(|value| value.strip_prefix("Bearer ")).unwrap_or_default()
}

/// `GET /v1/apk/{id}`: the offered file, to the phone it was offered to.
pub async fn download(State(app): State<AppHandle>, UrlPath(id): UrlPath<String>, headers: HeaderMap) -> Response {
    let remote = app.state::<RemoteState>();
    let Some(device) = remote.authenticate(bearer(&headers)) else {
        return (StatusCode::UNAUTHORIZED, "This phone is not paired.").into_response();
    };
    match remote.offer(&id) {
        Some(offer) if offer.device.as_deref().is_none_or(|target| target == device.id) => serve(&app, offer).await,
        _ => gone(),
    }
}

/// `GET /v1/apk/{id}` on the local network: the offered file, to whoever
/// holds the offer's own key.
pub async fn download_nearby(State(app): State<AppHandle>, UrlPath(id): UrlPath<String>, headers: HeaderMap) -> Response {
    let remote = app.state::<RemoteState>();
    match remote.offer(&id) {
        Some(offer) if opens(&offer, bearer(&headers)) => serve(&app, offer).await,
        _ => gone(),
    }
}

/// Whether a key opens an offer: compared as digests, so the time taken
/// says nothing about how much of it was right.
fn opens(offer: &ApkOffer, key: &str) -> bool {
    !key.is_empty() && Sha256::digest(key.as_bytes()) == Sha256::digest(offer.nearby_key.as_bytes())
}

fn gone() -> Response {
    (StatusCode::NOT_FOUND, "That app is no longer offered. Send it again from the Mac.").into_response()
}

async fn serve(app: &AppHandle, offer: ApkOffer) -> Response {
    if offer.expires_at < now_ms() {
        return gone();
    }
    let remote = app.state::<RemoteState>();
    let id = offer.id.clone();
    let file = match tokio::fs::File::open(&offer.path).await {
        Ok(file) => file,
        Err(error) => return (StatusCode::GONE, format!("The file is gone from the Mac: {error}")).into_response(),
    };
    remote.set_offer_state(app, &id, "downloading", None);
    let body = Body::from_stream(tokio_util::io::ReaderStream::with_capacity(file, 256 * 1024));
    (
        [
            (header::CONTENT_TYPE, "application/vnd.android.package-archive".to_string()),
            (header::CONTENT_LENGTH, offer.size.to_string()),
            (header::CONTENT_DISPOSITION, format!("attachment; filename=\"{}\"", offer.name.replace('"', ""))),
        ],
        body,
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn only_an_apk_is_offered_and_its_checksum_is_the_files() {
        let dir = tempfile::tempdir().unwrap();
        let apk = dir.path().join("game.apk");
        std::fs::write(&apk, b"PK\x03\x04 not really an app").unwrap();
        let offer = prepare(apk.to_str().unwrap(), Some("d1".into())).await.unwrap();
        assert_eq!(offer.name, "game.apk");
        assert_eq!(offer.size, 22);
        assert_eq!(offer.sha256.len(), 64);
        let frame: serde_json::Value = serde_json::from_str(&frame(&offer, "Mac")).unwrap();
        assert_eq!(frame["t"], "install");
        assert_eq!(frame["sha256"], offer.sha256);
        assert!(frame.get("nearby").is_none());

        let mut nearby = offer.clone();
        nearby.nearby = Some(("https://192.168.1.20:5000/v1/apk/x".into(), "ab".repeat(32)));
        let sent: serde_json::Value = serde_json::from_str(&super::frame(&nearby, "Mac")).unwrap();
        assert_eq!(sent["nearby"]["key"], nearby.nearby_key);
        assert!(opens(&nearby, &nearby.nearby_key));
        assert!(!opens(&nearby, ""));
        assert!(!opens(&nearby, &nearby.nearby_key[1..]));
        // The key never reaches the Mac's own screens.
        assert!(serde_json::to_value(&nearby).unwrap().get("nearbyKey").is_none());

        let text = dir.path().join("notes.txt");
        std::fs::write(&text, b"hello").unwrap();
        assert!(prepare(text.to_str().unwrap(), None).await.is_err());
        let empty = dir.path().join("empty.apk");
        std::fs::write(&empty, b"").unwrap();
        assert!(prepare(empty.to_str().unwrap(), None).await.is_err());
    }

    #[test]
    fn the_checksum_is_sha256() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.apk");
        std::fs::write(&file, b"abc").unwrap();
        assert_eq!(sha256_of(&file).unwrap(), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }
}
