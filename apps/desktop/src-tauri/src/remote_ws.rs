//! Authenticated duplex transport for the shared desktop renderer.
use axum::{extract::{State, WebSocketUpgrade, ws::{WebSocket, Message}}, http::{HeaderMap, StatusCode}, response::{Response, IntoResponse}};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tauri::{Manager, Listener, Emitter};
use tokio::sync::mpsc;
use crate::{state::AppState, remote_legacy as remote, remote_dispatch, commands};
use thingmaker_supervisor::DesktopError;

pub async fn upgrade(State(app): State<tauri::AppHandle>, headers: HeaderMap, ws: WebSocketUpgrade) -> Response {
    let expected = std::fs::read_to_string(remote::key_path()).unwrap_or_default();
    if !remote::authorized(&headers, &expected) { return StatusCode::UNAUTHORIZED.into_response(); }
    ws.max_message_size(16 * 1024 * 1024).max_frame_size(16 * 1024 * 1024)
        .on_upgrade(move |socket| serve(socket, app, headers)).into_response()
}
struct Resources {
    app: tauri::AppHandle,
    listeners: Vec<tauri::EventId>,
    streams: std::collections::HashMap<String, tokio::task::JoinHandle<()>>,
}
impl Drop for Resources {
    fn drop(&mut self) {
        for id in &self.listeners { self.app.unlisten(*id); }
        for stream in self.streams.values() { stream.abort(); }
    }
}
fn push(tx: &mpsc::Sender<Value>, overflow: &std::sync::atomic::AtomicBool, value: Value) {
    if tx.try_send(value).is_err() { overflow.store(true, std::sync::atomic::Ordering::Relaxed); }
}
async fn serve(socket: WebSocket, app: tauri::AppHandle, headers: HeaderMap) {
    let (mut sink, mut source) = socket.split();
    let (tx, mut rx) = mpsc::channel::<Value>(512);
    let overflow = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mut resources = Resources { app: app.clone(), listeners: vec![], streams: Default::default() };
    for name in ["thingmaker://job", "thingmaker://bigthing", "thingmaker://remote-state-changed", crate::titles::SESSION_TITLE_EVENT] {
        let sender = tx.clone(); let full = overflow.clone();
        resources.listeners.push(app.listen_any(name, move |event| {
            if let Ok(payload) = serde_json::from_str::<Value>(event.payload()) {
                push(&sender, &full, json!({"event":name,"payload":payload}));
            }
        }));
    }
    let permits = std::sync::Arc::new(tokio::sync::Semaphore::new(16));
    let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(5));
    let mut fingerprint = String::new();
    push(&tx, &overflow, json!({"ready":true,"apiVersion":2}));
    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                let expected = std::fs::read_to_string(remote::key_path()).unwrap_or_default();
                if !remote::authorized(&headers, &expected) {
                    let _ = sink.send(Message::Close(Some(axum::extract::ws::CloseFrame { code: 1008, reason: "API key revoked".into() }))).await;
                    break;
                }
                if overflow.load(std::sync::atomic::Ordering::Relaxed) { break; }
                // Metadata mutations made on either screen invalidate both views.
                let state = app.state::<AppState>();
                let metadata = json!({"workspaces":commands::workspace::workspace_list(state.clone()).ok(),"sessions":commands::session::session_list_open(state)});
                let next = metadata.to_string();
                if next != fingerprint { fingerprint = next; let _ = app.emit("thingmaker://remote-state-changed", ()); }
            }
            Some(value) = rx.recv() => {
                if sink.send(Message::Text(value.to_string().into())).await.is_err() { break; }
            }
            incoming = source.next() => {
                let Some(Ok(message)) = incoming else { break; };
                let Message::Text(raw) = message else {
                    if matches!(message, Message::Close(_)) { break; }
                    continue;
                };
                let expected = std::fs::read_to_string(remote::key_path()).unwrap_or_default();
                if !remote::authorized(&headers, &expected) { break; }
                let Ok(frame) = serde_json::from_str::<Value>(&raw) else { break; };
                let Some(id) = frame["id"].as_str().filter(|v| v.len() <= 128) else { break; };
                let Some(command) = frame["command"].as_str() else { break; };
                let args = frame["args"].clone();
                if command == "session_subscribe" || command == "terminal_subscribe" {
                    let result = subscribe(&app, command, args, &tx, &overflow, &mut resources);
                    push(&tx, &overflow, match result { Ok(()) => json!({"id":id,"result":null}), Err(error) => json!({"id":id,"error":error}) });
                    continue;
                }
                let Ok(permit) = permits.clone().try_acquire_owned() else {
                    push(&tx, &overflow, json!({"id":id,"error":DesktopError::io("Too many simultaneous requests")})); continue;
                };
                let sender = tx.clone(); let full = overflow.clone(); let handle = app.clone();
                let id = id.to_owned(); let command = command.to_owned();
                // Accepted operations finish even if the phone loses connectivity.
                tauri::async_runtime::spawn(async move {
                    let _permit = permit;
                    let response = remote_dispatch::dispatch(&handle, &command, args).await;
                    let value = match response { Ok(result) => json!({"id":id,"result":result}), Err(error) => json!({"id":id,"error":error}) };
                    push(&sender, &full, value);
                    if matches!(command.as_str(), "workspace_inspect" | "workspace_remove" | "session_open" | "session_stop" | "session_archive" | "session_pin" | "session_rename") {
                        let _ = handle.emit("thingmaker://remote-state-changed", ());
                    }
                });
            }
        }
    }
}
fn subscribe(app: &tauri::AppHandle, command: &str, args: Value, tx: &mpsc::Sender<Value>, overflow: &std::sync::Arc<std::sync::atomic::AtomicBool>, resources: &mut Resources) -> Result<(), DesktopError> {
    let channel = args["onEvent"]["__remoteChannel"].as_str().filter(|s| s.len() <= 128).ok_or_else(|| DesktopError::io("Invalid channel"))?.to_owned();
    if let Some(previous) = resources.streams.remove(&channel) { previous.abort(); }
    let sender = tx.clone(); let full = overflow.clone(); let name = channel.clone();
    let state = app.state::<AppState>();
    let task = if command == "session_subscribe" {
        let handle: thingmaker_supervisor::SessionHandle = serde_json::from_value(args["handle"].clone()).map_err(|_| DesktopError::io("Invalid handle"))?;
        let actor = state.actor(&handle.id).ok_or_else(|| DesktopError::not_ready("Session is not attached"))?;
        if actor.handle().attachment_generation != handle.attachment_generation { return Err(DesktopError::conflict("Stale session handle")); }
        let mut subscription = actor.subscribe();
        tokio::spawn(async move {
            while let Some(event) = subscription.recv().await { push(&sender, &full, json!({"channel":name,"payload":event})); if full.load(std::sync::atomic::Ordering::Relaxed) { break; } }
        })
    } else {
        let id = args["id"].as_str().ok_or_else(|| DesktopError::io("Invalid terminal"))?;
        let terminal = state.terminals.get(id).ok_or_else(|| DesktopError::not_ready("Terminal not found"))?;
        let mut receiver = terminal.subscribe();
        let scrollback = terminal.scrollback();
        if !scrollback.is_empty() { push(tx, overflow, json!({"channel":channel,"payload":{"type":"output","dataBase64":commands::terminal::encode_base64(&scrollback)}})); }
        tokio::spawn(async move {
            if terminal.is_exited() { push(&sender, &full, json!({"channel":name,"payload":{"type":"exit","code":terminal.info().exit_code}})); return; }
            loop { match receiver.recv().await {
                Ok(event) => push(&sender, &full, json!({"channel":name,"payload":event})),
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => { full.store(true, std::sync::atomic::Ordering::Relaxed); break; },
                Err(_) => break,
            } }
        })
    };
    resources.streams.insert(channel, task);
    Ok(())
}
