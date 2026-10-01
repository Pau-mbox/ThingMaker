//! Child-process stdio transport with exactly-once request resolution.
//!
//! Ownership model (spec F02, F11, section 8.3 and 8.6):
//!
//! - one writer task serializes frames in submission order and acknowledges
//!   each write, so callers can distinguish "written" from "accepted";
//! - the stdout reader correlates responses by id and forwards requests and
//!   notifications in arrival order over a bounded channel;
//! - the stderr reader forwards raw lines; classification happens in the
//!   adapter so the transport stays protocol-neutral;
//! - the exit task waits for the child, drains the readers (with a timeout for
//!   inherited pipes), fails every pending request once and reports the exit.
//!
//! Requests never hang: they resolve on response, timeout, write failure or
//! process exit. A shutdown closes stdin, then escalates to the process group.

use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    process::Stdio,
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicBool, AtomicI64, Ordering},
    },
    time::Duration,
};

use serde::Serialize;
use serde_json::Value;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, ChildStderr, ChildStdin, ChildStdout, Command},
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
    time::{self, Instant},
};

use super::{
    framing::{Frame, LineFramer},
    jsonrpc::{self, Message, ProtocolError, RequestId, RpcError},
    limits,
};

/// Fully resolved launch: absolute program, argument vector, working
/// directory and the complete environment (the parent environment is never
/// inherited implicitly; see `security::EnvironmentProfile`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitInfo {
    pub status: Option<i32>,
    pub signal: Option<i32>,
    /// True when the desktop had to terminate or kill the process.
    pub forced: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcessPhase {
    Running,
    Closing,
    Exited,
}

/// Inbound traffic other than responses to our own requests.
#[derive(Debug)]
pub enum Incoming {
    Request {
        id: RequestId,
        method: String,
        params: Option<Value>,
    },
    Notification {
        method: String,
        params: Option<Value>,
    },
    StderrLine(Vec<u8>),
    StderrOverflow {
        bytes: usize,
        limit: usize,
    },
    StdoutOverflow {
        bytes: usize,
        limit: usize,
    },
    Protocol(ProtocolError),
    /// A response arrived for a request we no longer track (timed out).
    LateResponse {
        id: RequestId,
    },
    Exited(ExitInfo),
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum TransportError {
    #[error("runtime process is not running")]
    NotRunning,
    #[error("{method} timed out after {timeout_ms} ms")]
    Timeout { method: String, timeout_ms: u64 },
    #[error("runtime returned error {}: {}", .0.code, .0.message)]
    Remote(RpcError),
    #[error("transport I/O failure: {0}")]
    Io(String),
    #[error("too many pending requests ({0})")]
    TooManyPending(usize),
    #[error("runtime exited before responding")]
    Exited(ExitInfo),
}

struct Pending {
    method: String,
    reply: oneshot::Sender<Result<Value, TransportError>>,
}

enum WriterMessage {
    Frame(Vec<u8>, oneshot::Sender<Result<(), String>>),
    Close,
}

struct Shared {
    writer: mpsc::Sender<WriterMessage>,
    pending: Mutex<HashMap<RequestId, Pending>>,
    next_id: AtomicI64,
    generation: u64,
    pid: Option<u32>,
    phase: watch::Sender<ProcessPhase>,
    exit: Mutex<Option<ExitInfo>>,
    forced: AtomicBool,
    /// Plain NDJSON events rather than JSON-RPC: every stdout line is
    /// delivered as an [`Incoming::Notification`] named [`EVENT_LINE`].
    events: bool,
}

/// The method name an NDJSON event line arrives under, in events mode.
pub const EVENT_LINE: &str = "event-line";

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Clone)]
pub struct Transport {
    shared: Arc<Shared>,
}

impl std::fmt::Debug for Transport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Transport")
            .field("pid", &self.shared.pid)
            .field("generation", &self.shared.generation)
            .field("phase", &self.phase())
            .finish()
    }
}

impl Transport {
    /// Starts the child and the reader/writer/exit tasks.
    pub async fn spawn(
        spec: LaunchSpec,
        generation: u64,
    ) -> Result<(Transport, mpsc::Receiver<Incoming>), TransportError> {
        Self::spawn_mode(spec, generation, false).await
    }

    /// A program that writes one JSON event per line and reads one per line
    /// (Antigravity's `stream-json`), with no requests or responses. Lines go
    /// out with [`Transport::write_line`] and come in as [`EVENT_LINE`]
    /// notifications.
    pub async fn spawn_events(spec: LaunchSpec, generation: u64) -> Result<(Transport, mpsc::Receiver<Incoming>), TransportError> {
        Self::spawn_mode(spec, generation, true).await
    }

    async fn spawn_mode(spec: LaunchSpec, generation: u64, events: bool) -> Result<(Transport, mpsc::Receiver<Incoming>), TransportError> {
        let mut command = Command::new(&spec.program);
        command
            .args(&spec.args)
            .current_dir(&spec.cwd)
            .env_clear()
            .envs(&spec.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(false);
        #[cfg(unix)]
        {
            // Own process group so shutdown can signal the helper and its
            // direct descendants together (best effort, spec section 8.6).
            command.process_group(0);
        }
        let mut child = command.spawn().map_err(|error| {
            TransportError::Io(format!("could not start {}: {error}", spec.program.display()))
        })?;
        let stdin = child.stdin.take().ok_or_else(|| TransportError::Io("stdin unavailable".into()))?;
        let stdout = child.stdout.take().ok_or_else(|| TransportError::Io("stdout unavailable".into()))?;
        let stderr = child.stderr.take().ok_or_else(|| TransportError::Io("stderr unavailable".into()))?;
        let pid = child.id();

        let (writer_tx, writer_rx) = mpsc::channel::<WriterMessage>(256);
        let (incoming_tx, incoming_rx) = mpsc::channel::<Incoming>(1024);
        let (phase_tx, _phase_rx) = watch::channel(ProcessPhase::Running);
        let shared = Arc::new(Shared {
            writer: writer_tx,
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicI64::new(1),
            generation,
            pid,
            phase: phase_tx,
            exit: Mutex::new(None),
            forced: AtomicBool::new(false),
            events,
        });

        tokio::spawn(writer_loop(stdin, writer_rx));
        let stdout_task = tokio::spawn(stdout_loop(stdout, Arc::clone(&shared), incoming_tx.clone()));
        let stderr_task = tokio::spawn(stderr_loop(stderr, incoming_tx.clone()));
        tokio::spawn(exit_loop(child, Arc::clone(&shared), incoming_tx, stdout_task, stderr_task));

        Ok((Transport { shared }, incoming_rx))
    }

    pub fn pid(&self) -> Option<u32> {
        self.shared.pid
    }

    pub fn generation(&self) -> u64 {
        self.shared.generation
    }

    pub fn phase(&self) -> ProcessPhase {
        *self.shared.phase.borrow()
    }

    pub fn is_running(&self) -> bool {
        self.phase() != ProcessPhase::Exited
    }

    pub fn exit_info(&self) -> Option<ExitInfo> {
        lock(&self.shared.exit).clone()
    }

    pub fn pending_count(&self) -> usize {
        lock(&self.shared.pending).len()
    }

    /// Sends a request and resolves exactly once.
    pub async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, TransportError> {
        self.request_observed(method, params, timeout, None).await
    }

    /// Like [`Transport::request`], additionally signalling `written` once the
    /// frame has been flushed to the child. Callers use it to record a durable
    /// `writing` state before acceptance is known.
    pub async fn request_observed(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
        written: Option<oneshot::Sender<()>>,
    ) -> Result<Value, TransportError> {
        if !self.is_running() {
            return Err(self.exit_error());
        }
        let id = RequestId::Number(self.shared.next_id.fetch_add(1, Ordering::Relaxed));
        let (reply_tx, reply_rx) = oneshot::channel();
        {
            let mut pending = lock(&self.shared.pending);
            if pending.len() >= limits::MAX_PENDING_REQUESTS {
                return Err(TransportError::TooManyPending(pending.len()));
            }
            pending.insert(
                id.clone(),
                Pending {
                    method: method.to_string(),
                    reply: reply_tx,
                },
            );
        }
        let frame = jsonrpc::encode(&jsonrpc::request(&id, method, params));
        if let Err(error) = self.write_frame(frame).await {
            lock(&self.shared.pending).remove(&id);
            return Err(error);
        }
        if let Some(written) = written {
            let _ = written.send(());
        }
        match time::timeout(timeout, reply_rx).await {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(_dropped)) => Err(self.exit_error()),
            Err(_elapsed) => {
                lock(&self.shared.pending).remove(&id);
                Err(TransportError::Timeout {
                    method: method.to_string(),
                    timeout_ms: timeout.as_millis() as u64,
                })
            }
        }
    }

    pub async fn notify(&self, method: &str, params: Value) -> Result<(), TransportError> {
        if !self.is_running() {
            return Err(self.exit_error());
        }
        self.write_frame(jsonrpc::encode(&jsonrpc::notification(method, params)))
            .await
    }

    pub async fn respond(&self, id: &RequestId, result: Value) -> Result<(), TransportError> {
        self.write_frame(jsonrpc::encode(&jsonrpc::response(id, result)))
            .await
    }

    pub async fn respond_error(
        &self,
        id: &RequestId,
        code: i64,
        message: &str,
    ) -> Result<(), TransportError> {
        self.write_frame(jsonrpc::encode(&jsonrpc::error_response(id, code, message)))
            .await
    }

    /// One JSON value as a line, for an events-mode program.
    pub async fn write_line(&self, value: &Value) -> Result<(), TransportError> {
        if !self.is_running() {
            return Err(self.exit_error());
        }
        self.write_frame(jsonrpc::encode(value)).await
    }

    async fn write_frame(&self, mut bytes: Vec<u8>) -> Result<(), TransportError> {
        bytes.push(b'\n');
        let (ack_tx, ack_rx) = oneshot::channel();
        self.shared
            .writer
            .send(WriterMessage::Frame(bytes, ack_tx))
            .await
            .map_err(|_| TransportError::NotRunning)?;
        match ack_rx.await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => Err(TransportError::Io(error)),
            Err(_) => Err(TransportError::NotRunning),
        }
    }

    fn exit_error(&self) -> TransportError {
        match self.exit_info() {
            Some(info) => TransportError::Exited(info),
            None => TransportError::NotRunning,
        }
    }

    /// Closes stdin, waits, then escalates to SIGTERM and SIGKILL on the
    /// process group within `budget`. Returns what is known about the exit.
    pub async fn shutdown(&self, budget: Duration) -> ExitInfo {
        let start = Instant::now();
        let deadline = start + budget;
        self.shared.phase.send_if_modified(|phase| {
            if *phase == ProcessPhase::Exited {
                false
            } else {
                *phase = ProcessPhase::Closing;
                true
            }
        });
        let _ = self.shared.writer.send(WriterMessage::Close).await;
        let stdin_grace = start + budget.mul_f32(0.5);
        if let Some(info) = self.wait_exit_until(stdin_grace).await {
            return info;
        }
        self.shared.forced.store(true, Ordering::SeqCst);
        self.signal(Signal::Terminate);
        let term_grace = start + budget.mul_f32(0.9);
        if let Some(info) = self.wait_exit_until(term_grace).await {
            return info;
        }
        self.signal(Signal::Kill);
        if let Some(info) = self
            .wait_exit_until(deadline + Duration::from_secs(1))
            .await
        {
            return info;
        }
        ExitInfo {
            status: None,
            signal: None,
            forced: true,
        }
    }

    async fn wait_exit_until(&self, deadline: Instant) -> Option<ExitInfo> {
        let mut phase = self.shared.phase.subscribe();
        loop {
            if let Some(info) = self.exit_info() {
                return Some(info);
            }
            if *phase.borrow_and_update() == ProcessPhase::Exited {
                return self.exit_info();
            }
            if time::timeout_at(deadline, phase.changed()).await.is_err() {
                return self.exit_info();
            }
        }
    }

    fn signal(&self, signal: Signal) {
        let Some(pid) = self.shared.pid else {
            return;
        };
        send_signal(pid, signal);
    }
}

#[derive(Clone, Copy)]
enum Signal {
    Terminate,
    Kill,
}

#[cfg(unix)]
fn send_signal(pid: u32, signal: Signal) {
    let number = match signal {
        Signal::Terminate => libc::SIGTERM,
        Signal::Kill => libc::SIGKILL,
    };
    let pid = pid as i32;
    // The child was started as its own process group leader, so the negative
    // pid addresses the whole group. Signal the leader too in case the group
    // changed underneath us.
    unsafe {
        libc::kill(-pid, number);
        libc::kill(pid, number);
    }
}

#[cfg(windows)]
fn send_signal(pid: u32, signal: Signal) {
    // Windows has no process groups in the POSIX sense; Job Objects are the
    // R0 follow-up (spec section 8.6). Best effort tree kill.
    let _ = signal;
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}

#[cfg(not(any(unix, windows)))]
fn send_signal(_pid: u32, _signal: Signal) {}

async fn writer_loop(mut stdin: ChildStdin, mut rx: mpsc::Receiver<WriterMessage>) {
    while let Some(message) = rx.recv().await {
        match message {
            WriterMessage::Frame(bytes, ack) => {
                let result = async {
                    stdin.write_all(&bytes).await?;
                    stdin.flush().await
                }
                .await
                .map_err(|error| error.to_string());
                let failed = result.is_err();
                let _ = ack.send(result);
                if failed {
                    break;
                }
            }
            WriterMessage::Close => break,
        }
    }
    drop(stdin);
    rx.close();
    while let Ok(message) = rx.try_recv() {
        if let WriterMessage::Frame(_, ack) = message {
            let _ = ack.send(Err("stdin is closed".into()));
        }
    }
}

async fn stdout_loop(mut stdout: ChildStdout, shared: Arc<Shared>, tx: mpsc::Sender<Incoming>) {
    let mut framer = LineFramer::new(limits::MAX_STDOUT_FRAME_BYTES);
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = match stdout.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        for frame in framer.feed(&buffer[..read]) {
            if handle_stdout_frame(frame, &shared, &tx).await.is_err() {
                return;
            }
        }
    }
    if let Some(frame) = framer.finish() {
        let _ = handle_stdout_frame(frame, &shared, &tx).await;
    }
}

async fn handle_stdout_frame(
    frame: Frame,
    shared: &Arc<Shared>,
    tx: &mpsc::Sender<Incoming>,
) -> Result<(), ()> {
    let bytes = match frame {
        Frame::Line(bytes) | Frame::Tail(bytes) => bytes,
        Frame::Overflow { bytes, limit } => {
            return tx
                .send(Incoming::StdoutOverflow { bytes, limit })
                .await
                .map_err(|_| ());
        }
    };
    if shared.events {
        return match serde_json::from_slice::<Value>(&bytes) {
            Ok(value) => tx.send(Incoming::Notification { method: EVENT_LINE.into(), params: Some(value) }).await.map_err(|_| ()),
            // A line that is not JSON is the program talking, not an event.
            Err(_) => tx.send(Incoming::StderrLine(bytes)).await.map_err(|_| ()),
        };
    }
    match jsonrpc::parse_messages(&bytes) {
        Ok(messages) => {
            for message in messages {
                match message {
                    Message::Response { id, result, error } => {
                        let pending = lock(&shared.pending).remove(&id);
                        match pending {
                            Some(pending) => {
                                let outcome = match error {
                                    Some(error) => Err(TransportError::Remote(error)),
                                    None => Ok(result.unwrap_or(Value::Null)),
                                };
                                tracing::trace!(method = %pending.method, "response correlated");
                                let _ = pending.reply.send(outcome);
                            }
                            None => tx
                                .send(Incoming::LateResponse { id })
                                .await
                                .map_err(|_| ())?,
                        }
                    }
                    Message::Request { id, method, params } => tx
                        .send(Incoming::Request { id, method, params })
                        .await
                        .map_err(|_| ())?,
                    Message::Notification { method, params } => tx
                        .send(Incoming::Notification { method, params })
                        .await
                        .map_err(|_| ())?,
                }
            }
        }
        Err(error) => tx.send(Incoming::Protocol(error)).await.map_err(|_| ())?,
    }
    Ok(())
}

async fn stderr_loop(mut stderr: ChildStderr, tx: mpsc::Sender<Incoming>) {
    let mut framer = LineFramer::new(limits::MAX_STDERR_LINE_BYTES);
    let mut buffer = vec![0u8; 16 * 1024];
    loop {
        let read = match stderr.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        for frame in framer.feed(&buffer[..read]) {
            if forward_stderr_frame(frame, &tx).await.is_err() {
                return;
            }
        }
    }
    if let Some(frame) = framer.finish() {
        let _ = forward_stderr_frame(frame, &tx).await;
    }
}

async fn forward_stderr_frame(frame: Frame, tx: &mpsc::Sender<Incoming>) -> Result<(), ()> {
    let incoming = match frame {
        Frame::Line(bytes) | Frame::Tail(bytes) => Incoming::StderrLine(bytes),
        Frame::Overflow { bytes, limit } => Incoming::StderrOverflow { bytes, limit },
    };
    tx.send(incoming).await.map_err(|_| ())
}

async fn exit_loop(
    mut child: Child,
    shared: Arc<Shared>,
    tx: mpsc::Sender<Incoming>,
    mut stdout_task: JoinHandle<()>,
    mut stderr_task: JoinHandle<()>,
) {
    let status = child.wait().await;
    let info = match status {
        Ok(status) => ExitInfo {
            status: status.code(),
            signal: exit_signal(&status),
            forced: shared.forced.load(Ordering::SeqCst),
        },
        Err(_) => ExitInfo {
            status: None,
            signal: None,
            forced: shared.forced.load(Ordering::SeqCst),
        },
    };
    // Frames written before exit must be delivered before the exit itself.
    // Grandchildren may keep the pipes open, so bound the wait.
    let drained = time::timeout(limits::INHERITED_PIPE_DRAIN_TIMEOUT, async {
        let _ = (&mut stdout_task).await;
        let _ = (&mut stderr_task).await;
    })
    .await;
    if drained.is_err() {
        stdout_task.abort();
        stderr_task.abort();
    }
    *lock(&shared.exit) = Some(info.clone());
    // `send_replace` stores the value even when no receiver is subscribed;
    // `send` would silently drop it and leave the phase stale.
    shared.phase.send_replace(ProcessPhase::Exited);
    let pending: Vec<Pending> = lock(&shared.pending).drain().map(|(_, pending)| pending).collect();
    for pending in pending {
        let _ = pending.reply.send(Err(TransportError::Exited(info.clone())));
    }
    let _ = tx.send(Incoming::Exited(info)).await;
}

#[cfg(unix)]
fn exit_signal(status: &std::process::ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    status.signal()
}

#[cfg(not(unix))]
fn exit_signal(_status: &std::process::ExitStatus) -> Option<i32> {
    None
}
