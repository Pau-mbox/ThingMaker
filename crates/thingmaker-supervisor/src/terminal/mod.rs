//! Native PTY service (TERM-01..03).
//!
//! xterm.js is only a renderer; this service owns the pseudo-terminal, the
//! shell process and its process tree. Output is broadcast to subscribers and
//! kept in a bounded scrollback so a reconnecting view can rehydrate. ACP
//! never goes through a PTY. Terminals are created only for trusted
//! workspaces (enforced by the command layer) and closed explicitly.

use std::{
    collections::{HashMap, VecDeque},
    io::{Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard, atomic::{AtomicBool, Ordering}},
    thread,
};

use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::error::DesktopError;

pub const SCROLLBACK_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_WRITE_BYTES: usize = 64 * 1024;
pub const MAX_TERMINALS: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum TerminalEvent {
    /// Raw bytes from the PTY, base64 so the envelope stays valid JSON.
    Output { data_base64: String },
    Exit { code: Option<u32> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub id: String,
    pub cwd: String,
    pub program: String,
    pub cols: u16,
    pub rows: u16,
    pub exited: bool,
    pub exit_code: Option<u32>,
    pub pid: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct TerminalSpawn {
    pub cwd: PathBuf,
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
}

pub struct Terminal {
    pub id: String,
    cwd: PathBuf,
    program: String,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    pid: Option<u32>,
    size: Mutex<(u16, u16)>,
    scrollback: Mutex<VecDeque<u8>>,
    events: broadcast::Sender<Arc<TerminalEvent>>,
    exited: AtomicBool,
    exit_code: Mutex<Option<u32>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

impl Terminal {
    pub fn info(&self) -> TerminalInfo {
        let (cols, rows) = *lock(&self.size);
        TerminalInfo {
            id: self.id.clone(),
            cwd: self.cwd.to_string_lossy().into_owned(),
            program: self.program.clone(),
            cols,
            rows,
            exited: self.exited.load(Ordering::SeqCst),
            exit_code: *lock(&self.exit_code),
            pid: self.pid,
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Arc<TerminalEvent>> {
        self.events.subscribe()
    }

    /// Bounded scrollback for rehydration, oldest bytes first.
    pub fn scrollback(&self) -> Vec<u8> {
        lock(&self.scrollback).iter().copied().collect()
    }

    pub fn write(&self, bytes: &[u8]) -> Result<(), DesktopError> {
        if bytes.len() > MAX_WRITE_BYTES {
            return Err(DesktopError::limit_exceeded("terminal input exceeds 64 KiB"));
        }
        if self.exited.load(Ordering::SeqCst) {
            return Err(DesktopError::not_ready("terminal process has exited"));
        }
        let mut writer = lock(&self.writer);
        writer.write_all(bytes).and_then(|_| writer.flush()).map_err(|e| DesktopError::io(e.to_string()))
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), DesktopError> {
        let cols = cols.clamp(2, 1000);
        let rows = rows.clamp(1, 500);
        lock(&self.master)
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| DesktopError::io(e.to_string()))?;
        *lock(&self.size) = (cols, rows);
        Ok(())
    }

    /// Terminates the shell and its process group (best effort, like an agent's own
    /// process-tree cleanup). Remote effects already caused are not undone.
    pub fn kill(&self) {
        #[cfg(unix)]
        if let Some(pid) = self.pid {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGHUP);
                libc::kill(-(pid as i32), libc::SIGTERM);
            }
        }
        let _ = lock(&self.child).kill();
    }

    pub fn is_exited(&self) -> bool {
        self.exited.load(Ordering::SeqCst)
    }
}

#[derive(Default)]
pub struct TerminalManager {
    terminals: Mutex<HashMap<String, Arc<Terminal>>>,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn open(&self, spawn: TerminalSpawn) -> Result<Arc<Terminal>, DesktopError> {
        if lock(&self.terminals).values().filter(|t| !t.is_exited()).count() >= MAX_TERMINALS {
            return Err(DesktopError::limit_exceeded(format!("at most {MAX_TERMINALS} terminals may be open")));
        }
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize { rows: spawn.rows.max(1), cols: spawn.cols.max(2), pixel_width: 0, pixel_height: 0 })
            .map_err(|e| DesktopError::io(format!("could not open a pty: {e}")))?;
        let mut command = CommandBuilder::new(&spawn.program);
        command.args(&spawn.args);
        command.cwd(&spawn.cwd);
        command.env_clear();
        for (key, value) in &spawn.env {
            command.env(key, value);
        }
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|e| DesktopError::io(format!("could not start {}: {e}", spawn.program.display())))?;
        drop(pair.slave);
        let pid = child.process_id();
        let mut reader = pair.master.try_clone_reader().map_err(|e| DesktopError::io(e.to_string()))?;
        let writer = pair.master.take_writer().map_err(|e| DesktopError::io(e.to_string()))?;
        let (events, _) = broadcast::channel(1024);
        let terminal = Arc::new(Terminal {
            id: uuid::Uuid::new_v4().simple().to_string(),
            cwd: spawn.cwd.clone(),
            program: spawn.program.to_string_lossy().into_owned(),
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            pid,
            size: Mutex::new((spawn.cols, spawn.rows)),
            scrollback: Mutex::new(VecDeque::with_capacity(64 * 1024)),
            events,
            exited: AtomicBool::new(false),
            exit_code: Mutex::new(None),
        });
        // Reader thread: PTY -> scrollback + subscribers.
        let reader_terminal = Arc::clone(&terminal);
        thread::Builder::new()
            .name(format!("pty-read-{}", terminal.id))
            .spawn(move || {
                let mut buffer = vec![0u8; 16 * 1024];
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(read) => {
                            let bytes = &buffer[..read];
                            {
                                let mut scrollback = lock(&reader_terminal.scrollback);
                                scrollback.extend(bytes.iter().copied());
                                while scrollback.len() > SCROLLBACK_BYTES {
                                    scrollback.pop_front();
                                }
                            }
                            let _ = reader_terminal.events.send(Arc::new(TerminalEvent::Output { data_base64: base64(bytes) }));
                        }
                    }
                }
                // EOF: the process (or its last descendant holding the pty) ended.
                let code = lock(&reader_terminal.child).wait().ok().map(|status| status.exit_code());
                *lock(&reader_terminal.exit_code) = code;
                reader_terminal.exited.store(true, Ordering::SeqCst);
                let _ = reader_terminal.events.send(Arc::new(TerminalEvent::Exit { code }));
            })
            .map_err(|e| DesktopError::io(e.to_string()))?;
        lock(&self.terminals).insert(terminal.id.clone(), Arc::clone(&terminal));
        Ok(terminal)
    }

    pub fn get(&self, id: &str) -> Option<Arc<Terminal>> {
        lock(&self.terminals).get(id).cloned()
    }

    pub fn list(&self) -> Vec<TerminalInfo> {
        lock(&self.terminals).values().map(|t| t.info()).collect()
    }

    /// Kills (if still running) and forgets the terminal. Output stays with
    /// subscribers that already received it.
    pub fn close(&self, id: &str) -> Result<(), DesktopError> {
        let terminal = lock(&self.terminals).remove(id).ok_or_else(|| DesktopError::not_ready("terminal not found"))?;
        if !terminal.is_exited() {
            terminal.kill();
        }
        Ok(())
    }

    pub fn close_all(&self) {
        let ids: Vec<String> = lock(&self.terminals).keys().cloned().collect();
        for id in ids {
            let _ = self.close(&id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn spawn(program: &str, args: &[&str]) -> TerminalSpawn {
        TerminalSpawn {
            cwd: std::env::temp_dir(),
            program: PathBuf::from(program),
            args: args.iter().map(|a| a.to_string()).collect(),
            env: vec![("PATH".into(), "/usr/bin:/bin".into())],
            cols: 80,
            rows: 24,
        }
    }

    async fn collect(terminal: &Terminal, until_exit: bool) -> (String, Option<u32>) {
        let mut rx = terminal.subscribe();
        let mut text = String::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let event = match tokio::time::timeout_at(deadline, rx.recv()).await {
                Ok(Ok(event)) => event,
                Ok(Err(broadcast::error::RecvError::Lagged(_))) => continue,
                _ => break,
            };
            match &*event {
                TerminalEvent::Output { .. } => text = String::from_utf8_lossy(&terminal.scrollback()).into_owned(),
                TerminalEvent::Exit { code } => return (text, *code),
            }
            if !until_exit && text.contains("abc") {
                return (text, None);
            }
        }
        (text, *lock(&terminal.exit_code))
    }

    #[test]
    fn terminal_events_serialize_with_camel_case_fields() {
        let output = serde_json::to_value(TerminalEvent::Output { data_base64: "aGk=".into() }).unwrap();
        assert_eq!(output, serde_json::json!({"type": "output", "dataBase64": "aGk="}));
        let exit = serde_json::to_value(TerminalEvent::Exit { code: Some(3) }).unwrap();
        assert_eq!(exit, serde_json::json!({"type": "exit", "code": 3}));
    }

    #[tokio::test]
    async fn runs_a_command_captures_output_and_exit_code() {
        let manager = TerminalManager::new();
        let terminal = manager.open(spawn("/bin/sh", &["-c", "echo hello-pty; exit 3"])).unwrap();
        let (text, code) = collect(&terminal, true).await;
        assert!(text.contains("hello-pty"), "{text:?}");
        assert_eq!(code, Some(3));
        assert!(terminal.is_exited());
        assert!(terminal.write(b"x").is_err());
        assert_eq!(manager.list().len(), 1);
        manager.close(&terminal.id).unwrap();
        assert!(manager.get(&terminal.id).is_none());
    }

    #[tokio::test]
    async fn writes_reach_the_process_and_close_kills_it() {
        let manager = TerminalManager::new();
        let terminal = manager.open(spawn("/bin/cat", &[])).unwrap();
        terminal.write(b"abc\n").unwrap();
        let (text, _) = collect(&terminal, false).await;
        assert!(text.contains("abc"), "{text:?}");
        terminal.resize(120, 40).unwrap();
        assert_eq!((terminal.info().cols, terminal.info().rows), (120, 40));
        assert!(terminal.write(&vec![b'x'; MAX_WRITE_BYTES + 1]).is_err());
        let mut rx = terminal.subscribe();
        manager.close(&terminal.id).unwrap();
        let exited = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                match rx.recv().await {
                    Ok(event) if matches!(*event, TerminalEvent::Exit { .. }) => return true,
                    Ok(_) => continue,
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => return terminal.is_exited(),
                }
            }
        })
        .await
        .unwrap_or(false);
        assert!(exited, "cat should exit after kill");
    }
}
