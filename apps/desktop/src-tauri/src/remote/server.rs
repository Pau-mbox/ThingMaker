//! The bridge's HTTP side: a reachability check, pairing, and one WebSocket
//! per connected phone.
//!
//! The socket speaks the renderer's own protocol: `call` a command and get
//! its `result`; a `Channel` argument becomes a stream of `channel` frames;
//! the host's `thingmaker://job` and `thingmaker://bigthing` events arrive as
//! `event` frames. The first frame must be `hello` with the phone's token.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};
use thingmaker_supervisor::SessionHandle;
use tokio::sync::mpsc;

use super::{RemoteState, dispatch, now_ms};
use crate::state::AppState;

pub fn router(app: AppHandle) -> Router {
    Router::new()
        .route("/v1/hello", get(hello))
        .route("/v1/pair", post(pair))
        .route("/v1/ws", get(socket))
        .route("/app", get(page_root))
        .route("/app/", get(page_root))
        .route("/app/{*path}", get(page))
        .with_state(app)
}

/// Where the phone's screens are: bundled with the app, or the checkout's
/// own build when running from source.
fn ui_dir(app: &AppHandle) -> std::path::PathBuf {
    let checkout = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist-remote");
    // A development build serves what was just built, not the copy Tauri
    // took when the binary was compiled.
    if cfg!(debug_assertions) && checkout.join("index.html").is_file() {
        return checkout;
    }
    let bundled = app.state::<AppState>().resource_dir.as_ref().map(|dir| dir.join("remote-ui"));
    match bundled {
        Some(dir) if dir.join("index.html").is_file() => dir,
        _ => checkout,
    }
}

fn content_type(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()).unwrap_or_default() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "json" => "application/json",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        _ => "application/octet-stream",
    }
}

async fn page_root(State(app): State<AppHandle>) -> Response {
    serve_file(&app, "index.html")
}

async fn page(State(app): State<AppHandle>, axum::extract::Path(path): axum::extract::Path<String>) -> Response {
    serve_file(&app, &path)
}

/// One file of the phone's screens; anything else is the page itself, so a
/// reload on a deep link still lands.
fn serve_file(app: &AppHandle, path: &str) -> Response {
    let dir = ui_dir(app);
    let clean: std::path::PathBuf = std::path::Path::new(path).components().filter(|part| matches!(part, std::path::Component::Normal(_))).collect();
    let file = dir.join(&clean);
    let file = if file.is_file() { file } else { dir.join("index.html") };
    match std::fs::read(&file) {
        Ok(bytes) => {
            // Hashed assets never change; the page is checked every time.
            let cache = if file.ends_with("index.html") { "no-cache" } else { "public, max-age=31536000, immutable" };
            ([(axum::http::header::CONTENT_TYPE, content_type(&file)), (axum::http::header::CACHE_CONTROL, cache)], bytes).into_response()
        }
        Err(_) => (StatusCode::SERVICE_UNAVAILABLE, "The phone screens are not built on this Mac. Run `pnpm app` (or `pnpm --filter @thingmaker/desktop build:remote`).").into_response(),
    }
}

async fn hello(State(app): State<AppHandle>) -> Json<Value> {
    let remote = app.state::<RemoteState>();
    Json(json!({ "app": "ThingMaker", "version": env!("CARGO_PKG_VERSION"), "name": remote.host_name.clone() }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairRequest {
    code: String,
    device_name: String,
}

async fn pair(State(app): State<AppHandle>, Json(request): Json<PairRequest>) -> Response {
    let remote = app.state::<RemoteState>();
    match remote.redeem(&request.code, &request.device_name) {
        Ok((device, token)) => {
            remote.changed(&app);
            Json(json!({ "deviceId": device.id, "token": token, "name": remote.host_name.clone() })).into_response()
        }
        Err(message) => (StatusCode::FORBIDDEN, Json(json!({ "error": message }))).into_response(),
    }
}

async fn socket(State(app): State<AppHandle>, upgrade: WebSocketUpgrade) -> Response {
    upgrade.max_message_size(8 * 1024 * 1024).on_upgrade(move |socket| serve(app, socket))
}

/// The connection's own state: who it is and what it streams.
struct Connection {
    app: AppHandle,
    out: mpsc::UnboundedSender<String>,
    channels: HashMap<u64, tokio::task::JoinHandle<()>>,
}

impl Connection {
    fn send(&self, frame: Value) {
        let _ = self.out.send(frame.to_string());
    }

    fn handle(&mut self, frame: Value) {
        match frame.get("t").and_then(Value::as_str) {
            Some("call") => {
                let id = frame.get("id").cloned().unwrap_or(Value::Null);
                let command = frame.get("cmd").and_then(Value::as_str).unwrap_or_default().to_string();
                let args = frame.get("args").cloned().unwrap_or(Value::Null);
                if command == "session_subscribe" {
                    let result = self.subscribe(&args);
                    self.send(match result {
                        Ok(()) => json!({ "t": "result", "id": id, "ok": true, "value": null }),
                        Err(error) => json!({ "t": "result", "id": id, "ok": false, "error": error }),
                    });
                    return;
                }
                let app = self.app.clone();
                let out = self.out.clone();
                tokio::spawn(async move {
                    let reply = dispatch::dispatch(&app, &command, args).await;
                    let frame = match reply {
                        Ok(value) => json!({ "t": "result", "id": id, "ok": true, "value": value }),
                        Err(error) => json!({ "t": "result", "id": id, "ok": false, "error": error }),
                    };
                    let _ = out.send(frame.to_string());
                });
            }
            Some("unchannel") => {
                if let Some(task) = frame.get("cid").and_then(Value::as_u64).and_then(|cid| self.channels.remove(&cid)) {
                    task.abort();
                }
            }
            Some("ping") => self.send(json!({ "t": "pong", "at": now_ms() })),
            _ => {}
        }
    }

    /// `session_subscribe`'s channel, as `channel` frames on this socket.
    fn subscribe(&mut self, args: &Value) -> Result<(), Value> {
        let handle: SessionHandle = serde_json::from_value(args.get("handle").cloned().unwrap_or(Value::Null)).map_err(|error| json!({ "code": "UNSUPPORTED", "message": format!("handle: {error}"), "retry": "never" }))?;
        let cid = args.get("onEvent").and_then(|channel| channel.get("__channel")).and_then(Value::as_u64).ok_or_else(|| json!({ "code": "UNSUPPORTED", "message": "onEvent must be a channel", "retry": "never" }))?;
        let state = self.app.state::<AppState>();
        let actor = crate::commands::session::actor_for(&state, &handle).map_err(|error| serde_json::to_value(error).unwrap_or(Value::Null))?;
        let mut subscription = actor.subscribe();
        let out = self.out.clone();
        let task = tokio::spawn(async move {
            while let Some(event) = subscription.recv().await {
                let frame = json!({ "t": "channel", "cid": cid, "data": &*event });
                if out.send(frame.to_string()).is_err() {
                    break;
                }
            }
        });
        if let Some(previous) = self.channels.insert(cid, task) {
            previous.abort();
        }
        Ok(())
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        for (_, task) in self.channels.drain() {
            task.abort();
        }
    }
}

async fn serve(app: AppHandle, mut socket: WebSocket) {
    // The first frame names the phone; nothing else is read before it.
    let device = match tokio::time::timeout(Duration::from_secs(10), socket.recv()).await {
        Ok(Some(Ok(Message::Text(text)))) => {
            let frame: Value = serde_json::from_str(text.as_str()).unwrap_or(Value::Null);
            let token = frame.get("token").and_then(Value::as_str).unwrap_or_default();
            if frame.get("t").and_then(Value::as_str) == Some("hello") { app.state::<RemoteState>().authenticate(token) } else { None }
        }
        _ => None,
    };
    let Some(device) = device else {
        let _ = socket.send(Message::Text(json!({ "t": "denied", "message": "This phone is not paired with this Mac, or its pairing was revoked." }).to_string().into())).await;
        return;
    };
    let remote = app.state::<RemoteState>();
    remote.connected(&app, &device.id, true);
    let _ = socket
        .send(Message::Text(json!({ "t": "welcome", "device": device.id, "name": remote.host_name.clone(), "version": env!("CARGO_PKG_VERSION") }).to_string().into()))
        .await;

    let (out, mut outgoing) = mpsc::unbounded_channel::<String>();
    let mut events = remote.events.subscribe();
    let mut revoked = remote.revoked.subscribe();
    let mut connection = Connection { app: app.clone(), out, channels: HashMap::new() };
    loop {
        tokio::select! {
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    if let Ok(frame) = serde_json::from_str::<Value>(text.as_str()) {
                        connection.handle(frame);
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            },
            Some(frame) = outgoing.recv() => {
                if socket.send(Message::Text(frame.into())).await.is_err() {
                    break;
                }
            }
            event = events.recv() => match event {
                Ok(frame) => {
                    if socket.send(Message::Text(frame.to_string().into())).await.is_err() {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(_) => break,
            },
            gone = revoked.recv() => {
                if matches!(gone.as_deref(), Ok(id) if id == device.id || id == "*") {
                    let _ = socket.send(Message::Text(json!({ "t": "denied", "message": "This phone's pairing was revoked on the Mac." }).to_string().into())).await;
                    break;
                }
            }
        }
    }
    drop(connection);
    remote.connected(&app, &device.id, false);
}

/// A shared event frame, serialized once for every phone.
pub fn event_frame(name: &str, payload: &str) -> Arc<str> {
    let payload = if payload.trim().is_empty() { "null" } else { payload };
    Arc::from(format!(r#"{{"t":"event","name":{},"payload":{}}}"#, Value::from(name), payload))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_event_frame_carries_the_payload_as_json() {
        let frame: Value = serde_json::from_str(&event_frame("thingmaker://job", r#"{"id":"j1"}"#)).unwrap();
        assert_eq!(frame, json!({ "t": "event", "name": "thingmaker://job", "payload": { "id": "j1" } }));
        let empty: Value = serde_json::from_str(&event_frame("x", "")).unwrap();
        assert_eq!(empty["payload"], Value::Null);
    }
}
