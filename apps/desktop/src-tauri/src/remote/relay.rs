//! The Mac's side of the Cloudflare relay (`apps/relay`).
//!
//! While phone access is on, the Mac keeps one WebSocket open to
//! `wss://<relay>/mac`, presenting its own key and the Cloudflare Access
//! service token, and answers what phones send the relay:
//!
//! - `req`: a plain request, answered by the bridge's own router in-process
//!   and returned as `res`, binary body chunks and `end`. Chunks wait for the
//!   relay's `ack`, so a large download never runs more than a small window
//!   ahead of the phone.
//! - `ws_open` / `ws_msg` / `ws_close`: a phone's WebSocket, carried as a
//!   stream of frames into the same conversation a local socket gets.
//!
//! Nothing here opens a port: the Mac only connects out.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Body;
use axum::http::Request;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};
use tokio::sync::{Semaphore, mpsc};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tower::ServiceExt;

use super::{RemoteState, server};

/// Keeps the relay's connection from idling out.
const PING: Duration = Duration::from_secs(25);
/// The relay answers every ping; this long without a word from it, the line
/// is dead even if the socket has not noticed (a Wi-Fi change, a sleep), and
/// the phones are already being told the Mac is gone.
const SILENT: Duration = Duration::from_secs(60);
/// A body chunk, and how many may be unacknowledged at once.
const CHUNK: usize = 256 * 1024;
const WINDOW: usize = 32;
const LONGEST_WAIT: Duration = Duration::from_secs(60);

type Acks = Arc<Mutex<HashMap<String, Arc<Semaphore>>>>;

/// Runs for the life of the app: connected while phone access is on and a
/// relay is set, waiting otherwise.
pub async fn run(app: AppHandle) {
    // Two TLS backends are linked into the app; the relay's connection
    // names one rather than leave rustls to refuse to choose.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut backoff = Duration::from_secs(1);
    loop {
        let remote = app.state::<RemoteState>();
        let config = remote.config();
        let relaying = config.enabled && config.mode == super::devices::ConnectionMode::Relay;
        let Some(url) = config.relay_url.clone().filter(|_| relaying) else {
            remote.set_relay(&app, "off", None);
            tokio::select! {
                () = remote.relay_changed.notified() => {}
                () = tokio::time::sleep(Duration::from_secs(30)) => {}
            }
            continue;
        };
        remote.set_relay(&app, "connecting", None);
        match connect(&app, &url).await {
            Ok(()) => {
                backoff = Duration::from_secs(1);
                remote.set_relay(&app, "connecting", Some("The relay connection closed; reconnecting.".into()));
            }
            Err(message) => {
                tracing::warn!(%message, "phone relay");
                remote.set_relay(&app, "error", Some(message));
            }
        }
        tokio::select! {
            () = remote.relay_changed.notified() => backoff = Duration::from_secs(1),
            () = tokio::time::sleep(backoff) => backoff = (backoff * 2).min(LONGEST_WAIT),
        }
    }
}

/// The handshake, with the Mac's key and the Access service token.
fn handshake(app: &AppHandle, url: &str) -> Result<tokio_tungstenite::tungstenite::handshake::client::Request, String> {
    let remote = app.state::<RemoteState>();
    let config = remote.config();
    // https in use; http only for a relay running on this Mac (wrangler dev).
    let socket_url = match url.strip_prefix("http://") {
        Some(local) => format!("ws://{}/mac", local.trim_end_matches('/')),
        None => format!("wss://{}/mac", url.trim_start_matches("https://").trim_end_matches('/')),
    };
    let mut request = socket_url.into_client_request().map_err(|error| format!("bad relay address: {error}"))?;
    let key = remote.mac_key().map_err(|error| error.message)?;
    let headers = request.headers_mut();
    let mut set = |name: &'static str, value: &str| -> Result<(), String> {
        headers.insert(name, value.parse().map_err(|_| format!("{name} has characters a header cannot carry"))?);
        Ok(())
    };
    set("x-thingmaker-mac", &key)?;
    if let (Some(id), Some(secret)) = (config.access_client_id.as_deref(), config.access_client_secret.as_deref()) {
        set("CF-Access-Client-Id", id)?;
        set("CF-Access-Client-Secret", secret)?;
    }
    Ok(request)
}

/// What the relay said, in words the Settings page can show.
fn describe(error: &tokio_tungstenite::tungstenite::Error) -> String {
    use tokio_tungstenite::tungstenite::Error;
    match error {
        Error::Http(response) => {
            let body = response.body().as_ref().map(|bytes| String::from_utf8_lossy(bytes).chars().take(200).collect::<String>()).unwrap_or_default();
            match response.status().as_u16() {
                302 | 401 | 403 if body.is_empty() || body.contains("<html") => {
                    "Cloudflare Access turned the Mac away: check the service token, and that the Access policy allows it (Service Auth).".into()
                }
                status => format!("The relay answered {status}{}", if body.is_empty() { String::new() } else { format!(": {body}") }),
            }
        }
        other => format!("Could not reach the relay: {other}"),
    }
}

async fn connect(app: &AppHandle, url: &str) -> Result<(), String> {
    let request = handshake(app, url)?;
    let (socket, _) = tokio_tungstenite::connect_async(request).await.map_err(|error| describe(&error))?;
    let remote = app.state::<RemoteState>();
    remote.set_relay(app, "connected", None);
    tracing::info!(relay = url, "phone relay connected");

    let (mut sink, mut stream) = socket.split();
    let (out, mut outgoing) = mpsc::unbounded_channel::<Message>();
    let writer = tokio::spawn(async move {
        while let Some(message) = outgoing.recv().await {
            if sink.send(message).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });
    let acks: Acks = Arc::new(Mutex::new(HashMap::new()));
    // A phone's WebSocket stream: frames from the phone, into its conversation.
    let mut streams: HashMap<String, mpsc::UnboundedSender<String>> = HashMap::new();
    let mut ping = tokio::time::interval(PING);
    ping.tick().await;
    let mut heard = tokio::time::Instant::now();

    let ended = loop {
        tokio::select! {
            message = stream.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    heard = tokio::time::Instant::now();
                    let Ok(frame) = serde_json::from_str::<Value>(text.as_str()) else { continue };
                    let id = frame.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
                    match frame.get("t").and_then(Value::as_str) {
                        Some("req") => {
                            tokio::spawn(answer(app.clone(), out.clone(), acks.clone(), id, frame));
                        }
                        Some("ws_open") => {
                            let (to_conversation, from_phone) = mpsc::unbounded_channel::<String>();
                            let (to_phone, mut from_conversation) = server::outbox();
                            streams.insert(id.clone(), to_conversation);
                            tokio::spawn(server::converse(app.clone(), from_phone, to_phone));
                            let out = out.clone();
                            tokio::spawn(async move {
                                while let Some(data) = from_conversation.recv().await {
                                    if out.send(Message::Text(json!({ "t": "ws_msg", "id": id, "data": data }).to_string().into())).is_err() {
                                        return;
                                    }
                                }
                                let _ = out.send(Message::Text(json!({ "t": "ws_close", "id": id }).to_string().into()));
                            });
                        }
                        Some("ws_msg") => {
                            if let Some(stream) = streams.get(&id) {
                                let _ = stream.send(frame.get("data").and_then(Value::as_str).unwrap_or_default().to_string());
                            }
                        }
                        Some("ws_close") => {
                            streams.remove(&id);
                        }
                        Some("ack") => {
                            if let Some(window) = acks.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(&id) {
                                window.add_permits(1);
                            }
                        }
                        Some("cancel") => {
                            if let Some(window) = acks.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&id) {
                                window.close();
                            }
                        }
                        _ => {}
                    }
                }
                Some(Ok(Message::Close(frame))) => break format!("the relay closed the line ({})", frame.map(|frame| format!("{} {}", frame.code, frame.reason)).unwrap_or_default()),
                None => break "the relay's line ended".to_string(),
                Some(Err(error)) => break format!("the relay's line failed: {error}"),
                Some(Ok(_)) => heard = tokio::time::Instant::now(),
            },
            _ = ping.tick() => {
                if heard.elapsed() > SILENT {
                    break format!("nothing from the relay for {}s", heard.elapsed().as_secs());
                }
                if out.send(Message::Text(json!({ "t": "ping" }).to_string().into())).is_err() {
                    break "the line to the relay closed".to_string();
                }
            }
        }
    };
    tracing::info!(reason = %ended, "phone relay disconnected");
    // Every phone stream ends with the connection; their conversations close.
    streams.clear();
    for (_, window) in acks.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).drain() {
        window.close();
    }
    drop(out);
    let _ = writer.await;
    Ok(())
}

/// One relayed request, answered by the bridge's router as if it had come
/// over the network.
async fn answer(app: AppHandle, out: mpsc::UnboundedSender<Message>, acks: Acks, id: String, frame: Value) {
    let method = frame.get("method").and_then(Value::as_str).unwrap_or("GET");
    let path = frame.get("path").and_then(Value::as_str).unwrap_or("/");
    let body = frame.get("body").and_then(Value::as_str).and_then(|text| base64::engine::general_purpose::STANDARD.decode(text).ok()).unwrap_or_default();
    let mut builder = Request::builder().method(method).uri(path);
    if let Some(headers) = frame.get("headers").and_then(Value::as_object) {
        for (name, value) in headers {
            if let Some(value) = value.as_str() {
                builder = builder.header(name.as_str(), value);
            }
        }
    }
    let send = |value: Value| out.send(Message::Text(value.to_string().into())).is_ok();
    let Ok(request) = builder.body(Body::from(body)) else {
        send(json!({ "t": "res", "id": id, "status": 400, "headers": {} }));
        send(json!({ "t": "end", "id": id }));
        return;
    };
    let Ok(response) = server::router(app).oneshot(request).await;
    let headers: serde_json::Map<String, Value> =
        response.headers().iter().filter_map(|(name, value)| value.to_str().ok().map(|value| (name.to_string(), Value::from(value)))).collect();
    if !send(json!({ "t": "res", "id": id, "status": response.status().as_u16(), "headers": headers })) {
        return;
    }
    let window = Arc::new(Semaphore::new(WINDOW));
    acks.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(id.clone(), window.clone());
    let mut body = response.into_body().into_data_stream();
    'body: while let Some(Ok(bytes)) = body.next().await {
        for piece in bytes.chunks(CHUNK) {
            // Closed: the phone went away or the relay connection dropped.
            let Ok(permit) = window.acquire().await else { break 'body };
            permit.forget();
            let mut frame = Vec::with_capacity(1 + id.len() + piece.len());
            frame.push(id.len() as u8);
            frame.extend_from_slice(id.as_bytes());
            frame.extend_from_slice(piece);
            if out.send(Message::Binary(frame.into())).is_err() {
                break 'body;
            }
        }
    }
    acks.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&id);
    send(json!({ "t": "end", "id": id }));
}
