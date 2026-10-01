//! How an agent's MCP child reaches the supervisor.
//!
//! The agent CLI starts the ThingMaker MCP server itself, as a stdio child, so
//! that child is not ours to hand a channel to. It connects back over a Unix
//! socket in the app's data directory instead: mode 0600, and the first line
//! it sends is the per-session token from its environment. That is the whole
//! amendment to ADR-004: still no TCP port, and a process that cannot read
//! the token cannot talk to the socket.
//!
//! The child ([`relay`]) is a pipe: stdin lines to the socket, socket lines
//! to stdout. MCP itself is answered here, by [`super::mcp::handle`].

use std::{
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
};

use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader as AsyncBufReader},
    net::{UnixListener, UnixStream},
    sync::mpsc,
};

use super::{jobs::Delegation, mcp};

/// Environment the MCP child finds the socket and its token in.
pub const SOCKET_ENV: &str = "THINGMAKER_MCP_SOCKET";
pub const TOKEN_ENV: &str = "THINGMAKER_MCP_TOKEN";
/// The argument that turns the desktop executable into the MCP child.
pub const RELAY_ARG: &str = "--thingmaker-mcp";

/// Longest line either side accepts: a task or a report, not a transcript.
const MAX_LINE: usize = 1024 * 1024;

/// Where the socket goes. macOS limits a socket path to 104 bytes, and an
/// app data directory under a long home can be close; the temporary
/// directory, which is per-user on macOS, is the fallback.
pub fn socket_path(data_dir: &Path) -> PathBuf {
    let preferred = data_dir.join("mcp.sock");
    if preferred.as_os_str().len() < 100 {
        return preferred;
    }
    std::env::temp_dir().join(format!("thingmaker-{}.sock", std::process::id()))
}

/// The listening side, owned by the host for the app's lifetime.
pub struct DelegationSocket {
    path: PathBuf,
}

impl DelegationSocket {
    /// Binds `path` (replacing a stale socket from an earlier run) and serves
    /// connections on the current Tokio runtime.
    pub fn bind(delegation: Delegation, path: PathBuf) -> std::io::Result<Self> {
        if path.exists() {
            std::fs::remove_file(&path)?;
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let listener = UnixListener::bind(&path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        }
        tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((stream, _)) => {
                        let delegation = delegation.clone();
                        tokio::spawn(async move {
                            if let Err(error) = serve(delegation, stream).await {
                                tracing::debug!(%error, "ThingMaker MCP connection ended");
                            }
                        });
                    }
                    Err(error) => {
                        tracing::warn!(%error, "ThingMaker MCP socket stopped accepting");
                        break;
                    }
                }
            }
        });
        Ok(Self { path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for DelegationSocket {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

async fn serve(delegation: Delegation, stream: UnixStream) -> std::io::Result<()> {
    let (read, mut write) = stream.into_split();
    let mut lines = AsyncBufReader::new(read).lines();
    let Some(hello) = lines.next_line().await? else { return Ok(()) };
    let token = serde_json::from_str::<Value>(&hello).ok().and_then(|value| value.get("token").and_then(Value::as_str).map(str::to_string));
    let Some(caller) = token.and_then(|token| delegation.caller_for_token(&token)) else {
        write.write_all(b"{\"error\":\"unknown token\"}\n").await?;
        return Ok(());
    };
    let (tx, mut rx) = mpsc::channel::<Value>(64);
    let writer = tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            let mut line = serde_json::to_vec(&message).unwrap_or_default();
            line.push(b'\n');
            if write.write_all(&line).await.is_err() || write.flush().await.is_err() {
                break;
            }
        }
    });
    while let Some(line) = lines.next_line().await? {
        if line.len() > MAX_LINE {
            let _ = tx.send(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32600, "message": "message too large" } })).await;
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            let _ = tx.send(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "parse error" } })).await;
            continue;
        };
        // Each request on its own task: `await_jobs` blocks for minutes, and
        // a ping or a cancel behind it must not.
        let messages = match message {
            Value::Array(batch) => batch,
            single => vec![single],
        };
        for message in messages {
            let delegation = delegation.clone();
            let caller = caller.clone();
            let tx = tx.clone();
            tokio::spawn(async move {
                if let Some(reply) = mcp::handle(&delegation, &caller, &message).await {
                    let _ = tx.send(reply).await;
                }
            });
        }
    }
    drop(tx);
    let _ = writer.await;
    Ok(())
}

/// The MCP child: relays stdio to the socket named in the environment.
/// Returns when either side closes.
pub fn relay() -> std::io::Result<()> {
    let path = std::env::var_os(SOCKET_ENV).ok_or_else(|| std::io::Error::other(format!("{SOCKET_ENV} is not set")))?;
    let token = std::env::var(TOKEN_ENV).map_err(|_| std::io::Error::other(format!("{TOKEN_ENV} is not set")))?;
    relay_to(Path::new(&path), &token, BufReader::new(std::io::stdin()), std::io::stdout())
}

pub fn relay_to(path: &Path, token: &str, input: impl BufRead + Send + 'static, mut output: impl Write) -> std::io::Result<()> {
    let stream = std::os::unix::net::UnixStream::connect(path)?;
    let mut upstream = stream.try_clone()?;
    writeln!(upstream, "{}", json!({ "token": token }))?;
    let shutdown = stream.try_clone()?;
    std::thread::spawn(move || {
        for line in input.lines() {
            let Ok(line) = line else { break };
            if writeln!(upstream, "{line}").and_then(|()| upstream.flush()).is_err() {
                break;
            }
        }
        // The client closed its end: close ours so the reader below ends.
        let _ = shutdown.shutdown(std::net::Shutdown::Both);
    });
    for line in BufReader::new(stream).lines() {
        let line = line?;
        writeln!(output, "{line}")?;
        output.flush()?;
    }
    Ok(())
}

/// The ACP `mcpServers` entry that starts the relay for one session.
pub fn server_entry(program: &Path, args: &[String], socket: &Path, token: &str) -> Value {
    json!({
        "name": mcp::SERVER_NAME,
        "command": program.to_string_lossy(),
        "args": args,
        "env": [
            { "name": SOCKET_ENV, "value": socket.to_string_lossy() },
            { "name": TOKEN_ENV, "value": token }
        ]
    })
}
