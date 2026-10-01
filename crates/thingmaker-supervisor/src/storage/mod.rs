//! Desktop metadata storage (spec section 15).
//!
//! Each agent's own transcript is the canonical record; this database holds UI
//! metadata, drafts, the submission outbox and projection bookkeeping. It is
//! never replayed back into an agent as history (ADR-06). WAL, foreign keys and
//! short transactions are enforced; migrations back up first and refuse to
//! open a newer schema for writing (F05).

pub mod artifacts;
pub mod attachments;
pub mod drafts;
pub mod migrations;
pub mod odyssey;
pub mod outbox;
pub mod review;
pub mod settings;
pub mod workspaces;
pub mod worktrees;

use std::path::{Path, PathBuf};

use rusqlite::Connection;

pub use migrations::{SCHEMA_VERSION, StorageError};

/// One open metadata database. Not `Sync`; own it from a single storage
/// worker task and serialize access there.
pub struct Storage {
    conn: Connection,
    path: Option<PathBuf>,
}

impl std::fmt::Debug for Storage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Storage").field("path", &self.path).finish()
    }
}

impl Storage {
    /// Opens (creating if needed) and migrates the database at `path`.
    pub fn open(path: &Path) -> Result<Self, StorageError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| StorageError::Io(error.to_string()))?;
        }
        let conn = Connection::open(path).map_err(StorageError::from)?;
        let mut storage = Self {
            conn,
            path: Some(path.to_path_buf()),
        };
        storage.configure()?;
        migrations::migrate(&mut storage)?;
        Ok(storage)
    }

    /// Opens an existing database without migrating it, for read-only report
    /// tools that must not touch a live file — a version newer than this
    /// build still refuses, older ones read whatever tables they have.
    pub fn open_read_only(path: &Path) -> Result<Self, StorageError> {
        let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX)
            .map_err(StorageError::from)?;
        let storage = Self { conn, path: Some(path.to_path_buf()) };
        let found = storage.schema_version()?;
        if found > migrations::SCHEMA_VERSION {
            return Err(StorageError::NewerSchema { found, supported: migrations::SCHEMA_VERSION });
        }
        Ok(storage)
    }

    /// In-memory database for tests.
    pub fn open_in_memory() -> Result<Self, StorageError> {
        let conn = Connection::open_in_memory().map_err(StorageError::from)?;
        let mut storage = Self { conn, path: None };
        storage.configure()?;
        migrations::migrate(&mut storage)?;
        Ok(storage)
    }

    fn configure(&mut self) -> Result<(), StorageError> {
        if self.path.is_some() {
            self.conn.pragma_update(None, "journal_mode", "WAL")?;
        }
        self.conn.pragma_update(None, "foreign_keys", "ON")?;
        self.conn.pragma_update(None, "busy_timeout", 5000)?;
        self.conn.pragma_update(None, "synchronous", "NORMAL")?;
        Ok(())
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    pub(crate) fn conn(&self) -> &Connection {
        &self.conn
    }

    pub(crate) fn conn_mut(&mut self) -> &mut Connection {
        &mut self.conn
    }

    pub fn schema_version(&self) -> Result<i64, StorageError> {
        Ok(self
            .conn
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))?)
    }

    /// `PRAGMA integrity_check` result; `ok` when healthy.
    pub fn integrity_check(&self) -> Result<String, StorageError> {
        Ok(self
            .conn
            .pragma_query_value(None, "integrity_check", |row| row.get::<_, String>(0))?)
    }

    /// Consistent online backup via SQLite's backup API (never a file copy).
    pub fn backup_to(&self, destination: &Path) -> Result<(), StorageError> {
        let mut target = Connection::open(destination)?;
        let backup = rusqlite::backup::Backup::new(&self.conn, &mut target)?;
        backup.run_to_completion(64, std::time::Duration::from_millis(5), None)?;
        Ok(())
    }
}

/// Current time as milliseconds since the Unix epoch (UTC).
pub fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// BLAKE3 hex of arbitrary content, used for payload and content hashes.
pub fn content_hash(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}
