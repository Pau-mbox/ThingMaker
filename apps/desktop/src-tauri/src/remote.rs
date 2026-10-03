//! Authenticated mobile commands over the SAME desktop actors. Loopback only.
use crate::{
    commands::{providers, session, workspace},
    state::AppState,
};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use serde::Serialize;
use serde_json::{Value, json};
use subtle::ConstantTimeEq;
use tauri::Manager;

pub(crate) fn key_path() -> std::path::PathBuf {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .expect("user home");
    std::path::PathBuf::from(home)
        .join(".thingmaker")
        .join("remote-api-key.txt")
}
fn rotate() -> Result<String, String> {
    let path = key_path();
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    // Two independently random v4 UUIDs: 244 random bits, no embedded identity.
    let key = format!(
        "tm_{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    #[cfg(windows)]
    {
        let identity = format!("{}\\{}:(OI)(CI)F", std::env::var("USERDOMAIN").map_err(|e|e.to_string())?, std::env::var("USERNAME").map_err(|e|e.to_string())?);
        let system = std::path::PathBuf::from(std::env::var_os("WINDIR").ok_or("Windows directory unavailable")?).join("System32").join("icacls.exe");
        let output = thingmaker_supervisor::platform::command(system)
            .arg(path.parent().unwrap()).args(["/inheritance:r", "/grant:r", &identity])
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err("Could not protect the key directory".into());
        }
    }
    std::fs::write(&path, &key).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    Ok(key)
}
#[tauri::command]
pub fn remote_key_get() -> Result<String, String> {
    match std::fs::read_to_string(key_path()) {
        Ok(key) => Ok(key),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => rotate(),
        Err(error) => Err(error.to_string()),
    }
}
#[tauri::command]
pub fn remote_key_rotate() -> Result<String, String> {
    rotate()
}

pub(crate) fn authorized(headers: &HeaderMap, expected: &str) -> bool {
    let Some(token) = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
    else {
        return false;
    };
    let received = blake3::hash(token.as_bytes());
    let wanted = blake3::hash(expected.trim().as_bytes());
    !expected.trim().is_empty() && bool::from(received.as_bytes().ct_eq(wanted.as_bytes()))
}
type ApiResult = Result<Json<Value>, (StatusCode, Json<Value>)>;
fn bad(message: &str) -> (StatusCode, Json<Value>) {
    (StatusCode::BAD_REQUEST, Json(json!({"message":message})))
}
fn parse<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, (StatusCode, Json<Value>)> {
    serde_json::from_value(value).map_err(|_| bad("Invalid request"))
}
fn result<T: Serialize>(value: crate::commands::CommandResult<T>) -> ApiResult {
    value
        .map(|v| Json(serde_json::to_value(v).unwrap()))
        .map_err(|e| (StatusCode::CONFLICT, Json(serde_json::to_value(e).unwrap())))
}
async fn rpc(
    State(app): State<tauri::AppHandle>,
    Path(operation): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ApiResult {
    let expected = std::fs::read_to_string(key_path()).unwrap_or_default();
    if !authorized(&headers, &expected) {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({"message":"API key incorrecta o revocada"})),
        ));
    }
    let state = app.state::<AppState>();
    match operation.as_str() {
        "workspaces" => result(workspace::workspace_list(state)),
        "providers" => result(providers::providers_status(state).await),
        "models" => {
            result(providers::provider_models(parse(body["provider"].clone())?, state).await)
        }
        "sessions" => result(session::session_records(
            parse(body["workspaceId"].clone())?,
            state,
        )),
        "live" => Ok(Json(
            serde_json::to_value(session::session_list_open(state)).unwrap(),
        )),
        "open" => result(session::session_open(parse(body)?, state).await),
        "snapshot" => {
            result(session::session_snapshot(parse(body["handle"].clone())?, state).await)
        }
        "history" => {
            let mut request: session::HistoryRequest = parse(body)?;
            request.limit = request.limit.clamp(1, 2000);
            result(session::session_history(request, state).await)
        }
        "submit" => {
            let request: session::SubmitRequest = parse(body)?;
            if uuid::Uuid::parse_str(&request.request_id).is_err()
                || request.text.len() > 64000
                || !request.attachment_ids.is_empty()
                || !request.mentions.is_empty()
            {
                return Err(bad("Invalid message"));
            }
            result(session::session_submit(request, state).await)
        }
        "cancel" => result(session::session_cancel(parse(body["handle"].clone())?, state).await),
        _ => Err((
            StatusCode::NOT_FOUND,
            Json(json!({"message":"Unknown operation"})),
        )),
    }
}
pub fn start(app: &tauri::AppHandle) {
    if let Err(error) = remote_key_get() {
        tracing::error!(%error, "remote key unavailable");
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::bind("127.0.0.1:18420").await {
            Ok(l) => l,
            Err(error) => {
                tracing::error!(%error,"remote listener unavailable");
                return;
            }
        };
        let router = Router::new()
            .route(
                "/health",
                get(|| async { Json(json!({"ok":true,"service":"thingmaker","apiVersion":2})) }),
            )
            .route("/v1/{operation}", post(rpc))
            .route("/v2/ws", get(crate::remote_ws::upgrade))
            .layer(DefaultBodyLimit::max(128_000))
            .with_state(app);
        if let Err(error) = axum::serve(listener, router).await {
            tracing::error!(%error,"remote server stopped");
        }
    });
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn authentication_requires_exact_bearer_and_rejects_revocation() {
        let mut h = HeaderMap::new();
        assert!(!authorized(&h, "secret"));
        h.insert("authorization", "Bearer secret".parse().unwrap());
        assert!(authorized(&h, "secret"));
        assert!(!authorized(&h, "new-secret"));
        assert!(!authorized(&h, ""));
        h.insert("authorization", "Basic secret".parse().unwrap());
        assert!(!authorized(&h, "secret"));
    }
}
