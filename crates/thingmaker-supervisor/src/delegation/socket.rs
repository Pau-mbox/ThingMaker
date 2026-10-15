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
    sync::mpsc,
};
#[cfg(unix)]
use tokio::net::UnixListener;

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
    #[cfg(windows)]
    {
        let _ = data_dir;
        PathBuf::from(format!(r"\\.\pipe\thingmaker-{}", uuid::Uuid::new_v4()))
    }
    #[cfg(unix)]
    {
    let preferred = data_dir.join("mcp.sock");
    if preferred.as_os_str().len() < 100 {
        return preferred;
    }
    std::env::temp_dir().join(format!("thingmaker-{}.sock", std::process::id()))
    }
}

/// The listening side, owned by the host for the app's lifetime.
pub struct DelegationSocket {
    path: PathBuf,
    task: tokio::task::JoinHandle<()>,
}

impl DelegationSocket {
    /// Binds `path` (replacing a stale socket from an earlier run) and serves
    /// connections on the current Tokio runtime.
    pub fn bind(delegation: Delegation, path: PathBuf) -> std::io::Result<Self> {
        #[cfg(unix)]
        {
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
        let task = tokio::spawn(async move {
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
        Ok(Self { path, task })
        }
        #[cfg(windows)]
        {
            let mut listener = windows_pipe(&path, true)?;
            let endpoint = path.clone();
            let task = tokio::spawn(async move {
                loop {
                    if let Err(error) = listener.connect().await {
                        tracing::warn!(%error, "ThingMaker MCP pipe stopped accepting");
                        break;
                    }
                    let next = match windows_pipe(&endpoint, false) {
                        Ok(next) => next,
                        Err(error) => {
                            tracing::warn!(%error, "ThingMaker MCP pipe could not create an instance");
                            break;
                        }
                    };
                    let stream = std::mem::replace(&mut listener, next);
                    let delegation = delegation.clone();
                    tokio::spawn(async move {
                        if let Err(error) = serve(delegation, stream).await {
                            tracing::debug!(%error, "ThingMaker MCP connection ended");
                        }
                    });
                }
            });
            Ok(Self { path, task })
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for DelegationSocket {
    fn drop(&mut self) {
        self.task.abort();
        #[cfg(unix)]
        let _ = std::fs::remove_file(&self.path);
    }
}

async fn serve<S>(delegation: Delegation, stream: S) -> std::io::Result<()>
where S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static {
    let (read, mut write) = tokio::io::split(stream);
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

#[cfg(unix)]
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

/// Windows uses an owner-only local named pipe, with the same per-session
/// authentication as Unix. There is no TCP listener or shared socket file.
#[cfg(windows)]
fn windows_pipe(path: &Path, first: bool) -> std::io::Result<tokio::net::windows::named_pipe::NamedPipeServer> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::{Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW, SECURITY_ATTRIBUTES},
    };
    let sddl: Vec<u16> = "D:P(A;;GA;;;OW)\0".encode_utf16().collect();
    let mut descriptor = std::ptr::null_mut();
    // SAFETY: Windows allocates the descriptor; it remains alive until
    // CreateNamedPipe has copied it, and is then released with LocalFree.
    unsafe {
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), 1, &mut descriptor, std::ptr::null_mut()) == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let result = tokio::net::windows::named_pipe::ServerOptions::new()
            .first_pipe_instance(first)
            .reject_remote_clients(true)
            .create_with_security_attributes_raw(path, &attributes as *const _ as *mut _);
        LocalFree(descriptor);
        result
    }
}

#[cfg(windows)]
pub fn relay_to(path: &Path, token: &str, input: impl BufRead + Send + 'static, mut output: impl Write) -> std::io::Result<()> {
    use tokio::net::windows::named_pipe::ClientOptions;
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
    runtime.block_on(async move {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        let stream = loop {
            match ClientOptions::new().open(path) {
                Ok(stream) => break stream,
                Err(error) if error.raw_os_error() == Some(231) && tokio::time::Instant::now() < deadline => {
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
                Err(error) => return Err(error),
            }
        };
        let (read, mut write) = tokio::io::split(stream);
        write.write_all(format!("{}\n", json!({"token": token})).as_bytes()).await?;
        let (tx, mut rx) = mpsc::channel::<String>(64);
        std::thread::spawn(move || {
            for line in input.lines() {
                let Ok(line) = line else { break };
                if tx.blocking_send(line).is_err() { break; }
            }
        });
        let mut lines = AsyncBufReader::new(read).lines();
        loop {
            tokio::select! {
                line = rx.recv() => match line {
                    Some(line) => { write.write_all(line.as_bytes()).await?; write.write_all(b"\n").await?; }
                    None => return Ok(()),
                },
                line = lines.next_line() => match line? {
                    Some(line) => { writeln!(output, "{line}")?; output.flush()?; }
                    None => return Ok(()),
                }
            }
        }
    })
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
